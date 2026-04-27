"""File scanner — collect every file that influences a Claude Code session.

The scanner is the source of truth for "what exists". It returns a flat list of
`RawFile` records (path + kind + readonly flag); the parser/resolver build on
this set. `(path → kind)` is decided here so the rest of the pipeline never has
to re-classify by extension or location.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from . import config
from .models import FileKind


@dataclass(frozen=True)
class RawFile:
    path: Path
    kind: FileKind
    readonly: bool = False


def _exists_file(p: Path) -> bool:
    try:
        return p.is_file()
    except OSError:
        return False


def _glob(directory: Path, pattern: str) -> Iterable[Path]:
    if not directory.is_dir():
        return []
    return sorted(directory.glob(pattern))


def scan() -> list[RawFile]:
    """Walk the in-scope set defined in `config` and return raw file records."""
    out: list[RawFile] = []

    # Top-level CLAUDE.md files.
    for p, kind in [
        (config.HOME / "CLAUDE.md", "claude_md"),
        (config.CLAUDE_DIR / "CLAUDE.md", "claude_md"),
    ]:
        if _exists_file(p):
            out.append(RawFile(p, kind))

    # Global rules.
    for p in _glob(config.CLAUDE_DIR / "rules", "*.md"):
        if not config.is_blacklisted(p):
            out.append(RawFile(p, "rule"))

    # Knowledge: MEMORY.md and per-scope memory files.
    knowledge = config.CLAUDE_DIR / "knowledge"
    memory_index = knowledge / "MEMORY.md"
    if _exists_file(memory_index):
        out.append(RawFile(memory_index, "memory_index"))
    for p in _glob(knowledge, "*.md"):
        if p.name == "MEMORY.md":
            continue
        if not config.is_blacklisted(p):
            out.append(RawFile(p, "memory"))

    # Skills (opportunistic — directory may be absent).
    skills_root = config.CLAUDE_DIR / "skills"
    if skills_root.is_dir():
        for skill_dir in sorted(p for p in skills_root.iterdir() if p.is_dir()):
            skill_md = skill_dir / "SKILL.md"
            if _exists_file(skill_md):
                out.append(RawFile(skill_md, "skill"))

    # Plugin manifests.
    plugins_root = config.CLAUDE_DIR / "remote" / "plugins"
    if plugins_root.is_dir():
        for plug_dir in sorted(p for p in plugins_root.iterdir() if p.is_dir()):
            mf = plug_dir / "manifest.json"
            if _exists_file(mf):
                out.append(RawFile(mf, "plugin_manifest"))

    # Plugin registry.
    plugin_registry = config.CLAUDE_DIR / "plugins" / "installed_plugins.json"
    if _exists_file(plugin_registry):
        out.append(RawFile(plugin_registry, "plugin_registry"))

    # Settings.
    settings = config.CLAUDE_DIR / "settings.json"
    if _exists_file(settings):
        out.append(RawFile(settings, "settings"))

    # MCP.
    mcp = config.CLAUDE_DIR / ".mcp.json"
    if _exists_file(mcp):
        out.append(RawFile(mcp, "mcp"))

    # Per-repo rules.
    for rule_dir in config.PER_REPO_RULE_DIRS:
        for p in _glob(rule_dir, "*.md"):
            out.append(RawFile(p, "rule"))

    # Auto-memory zone (read-only).
    if config.AUTO_MEMORY_DIR.is_dir():
        for p in _glob(config.AUTO_MEMORY_DIR, "*.md"):
            out.append(RawFile(p, "automemory", readonly=True))

    return out


def scan_roots() -> list[Path]:
    """Directories the watcher needs to observe.

    Returned paths are guaranteed to exist; absent dirs are skipped so watchdog
    doesn't crash on missing roots.
    """
    candidates = [
        config.HOME,  # for ~/CLAUDE.md only — we filter events in the watcher
        config.CLAUDE_DIR,
        config.CLAUDE_DIR / "rules",
        config.CLAUDE_DIR / "knowledge",
        config.CLAUDE_DIR / "skills",
        config.CLAUDE_DIR / "remote" / "plugins",
        config.CLAUDE_DIR / "plugins",
        config.AUTO_MEMORY_DIR,
        *config.PER_REPO_RULE_DIRS,
    ]
    seen: set[Path] = set()
    out: list[Path] = []
    for c in candidates:
        try:
            if c.is_dir() and c not in seen:
                seen.add(c)
                out.append(c)
        except OSError:
            continue
    return out


def discover_cwds() -> list[Path]:
    """Walk from `~/` up to DISCOVERY_MAX_DEPTH levels, collect dirs that
    contain a CLAUDE.md or a .claude/ subdir.

    The walker is BFS-bounded by depth, skips noise dirs, and never descends
    into the auto-memory blacklist. The result is always sorted by collapsed
    path for stable UI.
    """
    home = config.HOME
    found: list[Path] = []
    stack: list[tuple[Path, int]] = [(home, 0)]
    while stack:
        d, depth = stack.pop(0)
        if config.is_blacklisted(d):
            continue
        try:
            entries = list(d.iterdir())
        except (PermissionError, OSError):
            continue
        names = {e.name for e in entries if e.is_dir() or e.is_file()}
        if "CLAUDE.md" in names or ".claude" in names:
            found.append(d)
        if depth >= config.DISCOVERY_MAX_DEPTH:
            continue
        for e in entries:
            if not e.is_dir():
                continue
            if e.name in config.DISCOVERY_SKIP_DIRS:
                continue
            if e.name.startswith(".") and e.name != ".claude":
                # Don't recurse into hidden dirs (except .claude itself, which
                # we surface only as a marker, not as a cwd).
                continue
            stack.append((e, depth + 1))
    # Deduplicate while preserving sort.
    return sorted(set(found), key=lambda p: str(p))
