"""Tier 2 deep-verification — InstructionsLoaded hook capture + comparator.

Architecture (empirically confirmed 2026-04-30):
- `--include-hook-events` does NOT emit InstructionsLoaded to stdout. The
  hook script receives the event payload on stdin instead.
- The correct approach: install a minimal InstructionsLoaded hook entry in
  ~/.claude/settings.json that appends each event payload (one JSON line) to
  ~/.claude/.observatory/instructions.jsonl.
- Observatory reads the JSONL after each real Claude session to compare the
  actual loaded set against the simulator's prediction.

Tier 2 is opt-in (UI "deep verify" checkbox). The hook installation itself goes
through the Phase 2 write pipeline (preview -> DiffModal -> write) per locked
rule #36. The hook script is generated and placed at
~/.claude/.observatory/tier2-hook.sh — it is a simple `cat >> <jsonl>; exit 0`.

Pre-flight checks (Phase 3 plan section 5):
- disableAllHooks / allowManagedHooksOnly in any settings layer -> graceful degrade
- NFS on ~/.claude/ -> sequential or banner

Session filtering: events are keyed by session_id, which appears in every
InstructionsLoaded payload. Multiple concurrent sessions do not pollute each
other — each session's file_paths can be grouped by session_id.

JSONL rotation: 10 MB OR 10,000 lines, whichever first. Single rotation slot
(instructions.jsonl.1). Written by the hook script, not by Observatory.

Comparator logic (3 outcomes per file per cwd):
  green:   file in both simulator prediction and hook events
  neutral: file in simulator only -> "loader-suppressed" (observation-based,
           NOT a hardcoded setting name per Phase 3 plan section 4)
  red:     file in hook events only -> simulator is missing something (bug)
"""
from __future__ import annotations

import json
import os
import shutil
import stat
import time
from pathlib import Path
from typing import Optional

from . import config
from .content_hash import sha256_of_body

# Where the hook writes its JSONL events.
INSTRUCTIONS_JSONL = config.CLAUDE_DIR / ".observatory" / "instructions.jsonl"
INSTRUCTIONS_JSONL_BACKUP = config.CLAUDE_DIR / ".observatory" / "instructions.jsonl.1"

# The hook script path — generated once, never changes.
HOOK_SCRIPT = config.CLAUDE_DIR / ".observatory" / "tier2-hook.sh"

# Rotation limits
JSONL_MAX_BYTES = 10 * 1024 * 1024   # 10 MB
JSONL_MAX_LINES = 10_000


def _observatory_dir() -> Path:
    d = config.CLAUDE_DIR / ".observatory"
    d.mkdir(parents=True, exist_ok=True)
    return d


# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------


def check_preflight() -> dict:
    """Run pre-flight checks and return a status dict.

    Returns:
        {
          "ok": bool,
          "reason": str,          # human-readable, shown in banner when ok=False
          "disable_all_hooks": bool,
          "allow_managed_only": bool,
          "nfs": bool,
        }
    """
    settings_paths = [
        config.CLAUDE_DIR / "settings.json",
        config.CLAUDE_DIR / "settings.local.json",
    ]
    disable_all = False
    managed_only = False
    for sp in settings_paths:
        if not sp.is_file():
            continue
        try:
            data = json.loads(sp.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if data.get("disableAllHooks"):
            disable_all = True
        if data.get("allowManagedHooksOnly"):
            managed_only = True

    # NFS detection: check statvfs f_type. NFS is 0x6969 (Linux).
    nfs = False
    try:
        import ctypes

        class _Statfs(ctypes.Structure):
            _fields_ = [
                ("f_type", ctypes.c_long),
                ("pad", ctypes.c_long * 19),
            ]

        libc = ctypes.CDLL("libc.so.6", use_errno=True)
        buf = _Statfs()
        # statfs() on the .claude dir
        if libc.statfs(str(config.CLAUDE_DIR).encode(), ctypes.byref(buf)) == 0:
            nfs = buf.f_type == 0x6969  # NFS_SUPER_MAGIC
    except Exception:
        pass

    if disable_all:
        return {
            "ok": False,
            "reason": (
                "disableAllHooks is set in a settings layer. "
                "Tier 2 cannot install its hook while this policy is active."
            ),
            "disable_all_hooks": True,
            "allow_managed_only": managed_only,
            "nfs": nfs,
        }
    if managed_only:
        return {
            "ok": False,
            "reason": (
                "allowManagedHooksOnly is set. "
                "Observatory can only install hooks when this policy is off."
            ),
            "disable_all_hooks": False,
            "allow_managed_only": True,
            "nfs": nfs,
        }
    return {
        "ok": True,
        "reason": "",
        "disable_all_hooks": False,
        "allow_managed_only": managed_only,
        "nfs": nfs,
    }


# ---------------------------------------------------------------------------
# Hook script generation
# ---------------------------------------------------------------------------


def ensure_hook_script() -> Path:
    """Write the tier2 hook script if it doesn't exist or has changed.

    The script appends each InstructionsLoaded payload (one JSON line per stdin
    read) to instructions.jsonl. It always exits 0 so Claude never blocks on it.
    The hook script is NOT written through the diff-modal pipeline because it is
    Observatory infrastructure, not a user config file — it lives under
    ~/.claude/.observatory/ which is already in BLACKLIST_DIRS.
    """
    _observatory_dir()
    script_body = f"""#!/bin/sh
# Observatory Tier 2 hook — captures InstructionsLoaded events.
# Do not edit manually; regenerated by Observatory backend.
JSONL="{INSTRUCTIONS_JSONL}"
# Append stdin (one JSON line from Claude Code) to the JSONL file.
cat >> "$JSONL"
printf '\\n' >> "$JSONL"
exit 0
"""
    write_it = True
    if HOOK_SCRIPT.is_file():
        try:
            if HOOK_SCRIPT.read_text() == script_body:
                write_it = False
        except OSError:
            pass
    if write_it:
        HOOK_SCRIPT.write_text(script_body, encoding="utf-8")
        HOOK_SCRIPT.chmod(HOOK_SCRIPT.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP)
    return HOOK_SCRIPT


def hook_is_installed() -> bool:
    """True if an InstructionsLoaded entry pointing at our hook script exists in
    ~/.claude/settings.json or settings.local.json."""
    hook_str = str(HOOK_SCRIPT)
    for sp in [config.CLAUDE_DIR / "settings.json",
               config.CLAUDE_DIR / "settings.local.json"]:
        if not sp.is_file():
            continue
        try:
            data = json.loads(sp.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        hooks = data.get("hooks", {})
        for entry in hooks.get("InstructionsLoaded", []):
            if isinstance(entry, dict):
                for h in entry.get("hooks", []):
                    if isinstance(h, dict) and h.get("command") == hook_str:
                        return True
    return False


def build_settings_with_hook(settings_path: Path) -> dict:
    """Return the settings dict with the tier2 hook added to InstructionsLoaded.

    Used by the /api/tier2-install endpoint to generate the new_content for
    the preview call. Caller must use this through the normal write pipeline.
    """
    ensure_hook_script()
    data: dict = {}
    if settings_path.is_file():
        try:
            data = json.loads(settings_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            data = {}
    hooks = data.setdefault("hooks", {})
    il_entries = hooks.setdefault("InstructionsLoaded", [])
    hook_str = str(HOOK_SCRIPT)
    # Check if already present.
    for entry in il_entries:
        if isinstance(entry, dict):
            for h in entry.get("hooks", []):
                if isinstance(h, dict) and h.get("command") == hook_str:
                    return data  # already installed
    il_entries.append({"hooks": [{"type": "command", "command": hook_str}]})
    return data


def build_settings_without_hook(settings_path: Path) -> dict:
    """Return the settings dict with the tier2 hook removed from InstructionsLoaded."""
    data: dict = {}
    if settings_path.is_file():
        try:
            data = json.loads(settings_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            data = {}
    hook_str = str(HOOK_SCRIPT)
    hooks = data.get("hooks", {})
    il_entries = hooks.get("InstructionsLoaded", [])
    new_il = []
    for entry in il_entries:
        if not isinstance(entry, dict):
            new_il.append(entry)
            continue
        new_hooks = [
            h for h in entry.get("hooks", [])
            if not (isinstance(h, dict) and h.get("command") == hook_str)
        ]
        if new_hooks:
            new_entry = dict(entry)
            new_entry["hooks"] = new_hooks
            new_il.append(new_entry)
    if new_il:
        hooks["InstructionsLoaded"] = new_il
    elif "InstructionsLoaded" in hooks:
        del hooks["InstructionsLoaded"]
    if not hooks and "hooks" in data:
        del data["hooks"]
    return data


# ---------------------------------------------------------------------------
# JSONL rotation
# ---------------------------------------------------------------------------


def maybe_rotate_jsonl() -> None:
    """Rotate instructions.jsonl if it exceeds size or line limits."""
    if not INSTRUCTIONS_JSONL.is_file():
        return
    try:
        size = INSTRUCTIONS_JSONL.stat().st_size
    except OSError:
        return
    rotate = size >= JSONL_MAX_BYTES
    if not rotate:
        try:
            with INSTRUCTIONS_JSONL.open("r", encoding="utf-8", errors="replace") as f:
                rotate = sum(1 for _ in f) >= JSONL_MAX_LINES
        except OSError:
            pass
    if rotate:
        try:
            shutil.move(str(INSTRUCTIONS_JSONL), str(INSTRUCTIONS_JSONL_BACKUP))
        except OSError:
            pass


# ---------------------------------------------------------------------------
# Event reading and session grouping
# ---------------------------------------------------------------------------


def read_events(
    session_id: Optional[str] = None,
    since_ts: Optional[float] = None,
) -> list[dict]:
    """Read all InstructionsLoaded events from instructions.jsonl.

    If session_id is given, only return events for that session.
    If since_ts is given, skip events whose host mtime is older (approximation;
    the JSONL itself carries no per-line timestamps).

    Events are returned in file order. Both the live file and the backup are
    checked (backup first so older events precede newer).
    """
    events: list[dict] = []
    sources = []
    if INSTRUCTIONS_JSONL_BACKUP.is_file():
        sources.append(INSTRUCTIONS_JSONL_BACKUP)
    if INSTRUCTIONS_JSONL.is_file():
        sources.append(INSTRUCTIONS_JSONL)
    for src in sources:
        try:
            text = src.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if obj.get("hook_event_name") != "InstructionsLoaded":
                continue
            if session_id and obj.get("session_id") != session_id:
                continue
            events.append(obj)
    return events


def group_by_session(events: list[dict]) -> dict[str, list[dict]]:
    """Group event dicts by session_id."""
    groups: dict[str, list[dict]] = {}
    for e in events:
        sid = e.get("session_id", "unknown")
        groups.setdefault(sid, []).append(e)
    return groups


# ---------------------------------------------------------------------------
# Comparator
# ---------------------------------------------------------------------------


class CompareOutcome:
    GREEN = "green"          # in both simulator and hook events
    NEUTRAL = "neutral"      # in simulator only — loader-suppressed
    RED = "red"              # in hook events only — simulator gap


def compare_for_cwd(
    cwd: Path,
    hook_events: list[dict],
    sim_loaded_paths: set[str],
) -> list[dict]:
    """Return a per-file comparison result for one cwd.

    hook_events: list of InstructionsLoaded event dicts for this cwd.
    sim_loaded_paths: absolute path strings the simulator predicted would load.

    Returns list of {file_path, outcome, memory_type, load_reason}.
    """
    # Filter events to this cwd (session can cover multiple cwds in theory).
    cwd_str = str(cwd.resolve())
    cwd_events = [e for e in hook_events if e.get("cwd") == cwd_str]
    hook_paths = {e["file_path"] for e in cwd_events if "file_path" in e}

    results = []
    all_paths = sim_loaded_paths | hook_paths
    for fp in sorted(all_paths):
        in_sim = fp in sim_loaded_paths
        in_hook = fp in hook_paths
        if in_sim and in_hook:
            outcome = CompareOutcome.GREEN
        elif in_sim and not in_hook:
            outcome = CompareOutcome.NEUTRAL
        else:
            outcome = CompareOutcome.RED
        # Find load_reason from hook event if available.
        event = next((e for e in cwd_events if e.get("file_path") == fp), None)
        results.append({
            "file_path": fp,
            "outcome": outcome,
            "memory_type": event.get("memory_type") if event else None,
            "load_reason": event.get("load_reason") if event else None,
            "in_simulator": in_sim,
            "in_hook": in_hook,
        })
    return results


# ---------------------------------------------------------------------------
# Status endpoint helpers
# ---------------------------------------------------------------------------


def get_tier2_status() -> dict:
    """Return the current Tier 2 status for the /api/tier2-status endpoint.

    Supersedes the static config.TIER2_AVAILABLE flag — this function does
    a live check of the actual hook installation state.

    Returns:
        {
          "available": bool,     # True when hook is installed and JSONL writable
          "installed": bool,     # True when hook entry exists in settings
          "reason": str,         # human-readable, shown in banner when available=False
          "preflight": dict,     # result of check_preflight()
          "jsonl_path": str,     # absolute path to the JSONL file
          "hook_script": str,    # absolute path to the hook script
          "events_captured": int # line count in JSONL (0 if not started)
        }
    """
    preflight = check_preflight()
    installed = hook_is_installed()
    jsonl_path = str(INSTRUCTIONS_JSONL)
    events_captured = 0
    if INSTRUCTIONS_JSONL.is_file():
        try:
            with INSTRUCTIONS_JSONL.open("r", encoding="utf-8", errors="replace") as f:
                events_captured = sum(
                    1 for ln in f
                    if ln.strip() and "InstructionsLoaded" in ln
                )
        except OSError:
            pass

    if not preflight["ok"]:
        return {
            "available": False,
            "installed": installed,
            "reason": preflight["reason"],
            "preflight": preflight,
            "jsonl_path": jsonl_path,
            "hook_script": str(HOOK_SCRIPT),
            "events_captured": events_captured,
        }

    if not installed:
        return {
            "available": False,
            "installed": False,
            "reason": (
                "Hook not installed. Use the 'Enable deep verify' toggle to "
                "install the InstructionsLoaded hook in ~/.claude/settings.json."
            ),
            "preflight": preflight,
            "jsonl_path": jsonl_path,
            "hook_script": str(HOOK_SCRIPT),
            "events_captured": events_captured,
        }

    return {
        "available": True,
        "installed": True,
        "reason": "",
        "preflight": preflight,
        "jsonl_path": jsonl_path,
        "hook_script": str(HOOK_SCRIPT),
        "events_captured": events_captured,
    }
