"""Session-load simulator.

Given a cwd, return the ordered list of files that would be loaded into a
Claude Code session at start, plus on-demand-reachable files. The model
mirrors Claude Code's actual behaviour, matching what `/memory` reports:

  1. `~/.claude/CLAUDE.md` always.
  2. `~/.claude/rules/*.md` without `paths:` always.
  3. `~/.claude/rules/*.md` with `paths:` — ALWAYS on-demand, never session-
     loaded (per Claude Code docs: "Path-scoped rules trigger when Claude
     reads files matching the pattern, not on every tool use"). They show
     up in the timeline as `conditional` regardless of whether the cwd
     matches the glob — a matched glob just means the rule will load on
     the first matching file read, not at session start.
  4. For the session cwd specifically: also load `<cwd>/.claude/CLAUDE.md`
     (team-shared project instructions, per official Claude Code docs).
  5. Walk UP from cwd to `~`: at each level, load `<dir>/CLAUDE.md` AND
     `<dir>/CLAUDE.local.md` if either exists, plus `<dir>/.claude/rules/*.md`
     (same `paths:` rule — paths-scoped → on-demand).
  5b. Auto-memory `~/.claude/projects/<key>/memory/MEMORY.md` for the active
     cwd (first 200 lines / 25KB loaded at session start, per Claude Code docs).
  6. Transitively chase `@-import` from anything loaded.
  7. `mention`-reachable files → on-demand-reachable (skipped, but counted).

Step 5 is what makes the simulator work for any user: we don't hardcode
`~/CLAUDE.md`, we discover it as the ancestor walk ascends.

claudeMdExcludes (drift fix #4): before classification, any file whose absolute
path matches a glob in the merged claudeMdExcludes array from any of the four
settings scopes (managed > local > project > user) is dropped from the load
chain.  Managed CLAUDE.md is always exempt from exclusion.

@-import tier inheritance (drift fix #5): imported files inherit their parent's
priority when the parent is a session-start file (tiers 1-5).  Only on-demand
parents produce on-demand imports.
"""
from __future__ import annotations

import json
import os
from collections import deque
from pathlib import Path
from typing import Optional

import pathspec

from . import config
from .canonical import (
    SLOT_ANCESTOR_WALK,
    SLOT_AUTO_MEMORY,
    SLOT_MANAGED,
    SLOT_ON_DEMAND,
    SLOT_PROJECT,
    SLOT_USER_GLOBAL,
    classify_step,
)
from .models import Edge, FileEntry, SimulatorResponse, SimulatorStats, TimelineStep

# Priority numbers corresponding to Claude's official 6-slot load order.
# These must stay in sync with the slot constants in canonical.py and with
# the locked rule #56 semantics in the blueprint.
_SLOT_PRIORITY: dict[str, int] = {
    SLOT_MANAGED: 1,
    SLOT_USER_GLOBAL: 2,
    SLOT_ANCESTOR_WALK: 3,
    SLOT_PROJECT: 4,
    SLOT_AUTO_MEMORY: 5,
    SLOT_ON_DEMAND: 6,
}


def _read_json_settings(path: Path) -> dict:
    """Read a JSON settings file, returning {} on any error."""
    try:
        return json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except (OSError, json.JSONDecodeError, ValueError):
        return {}


def _read_claude_md_excludes(cwd: Path) -> list[str]:
    """Return the merged claudeMdExcludes glob list from all four settings scopes.

    Precedence per the researcher's reference (settings.md): managed > local
    > project > user.  Arrays merge across layers (all exclusions apply).
    Managed CLAUDE.md is never excludable regardless of what any layer says —
    callers must enforce that carve-out separately.

    Settings files read (in merge order — all contribute, no override):
      1. Managed: OS-level managed settings (not a standard JSON file — skipped
         if absent; the managed CLAUDE.md itself is exempt, not the settings).
      2. User: ~/.claude/settings.json
      3. User-local: ~/.claude/settings.local.json
      4. Project: <cwd>/.claude/settings.json
    """
    excludes: list[str] = []
    claude_dir = config.CLAUDE_DIR
    settings_files = [
        claude_dir / "settings.json",
        claude_dir / "settings.local.json",
        cwd / ".claude" / "settings.json",
    ]
    for sf in settings_files:
        if not sf.is_file():
            continue
        data = _read_json_settings(sf)
        raw = data.get("claudeMdExcludes", [])
        if isinstance(raw, list):
            excludes.extend(str(g) for g in raw if g)
        elif isinstance(raw, str) and raw:
            excludes.append(raw)
    return excludes


def _path_matches_glob_list(path: Path, globs: list[str]) -> bool:
    """Return True if the absolute path matches any glob in the list.

    Patterns match against absolute paths per the claudeMdExcludes spec.
    Uses pathspec gitwildmatch for ** support.
    """
    if not globs:
        return False
    path_str = str(path)
    for glob in globs:
        try:
            spec = pathspec.PathSpec.from_lines("gitwildmatch", [glob])
            if spec.match_file(path_str):
                return True
        except Exception:
            continue
    return False

# Tokens-per-line placeholder. Real Claude Code tokens-per-line is ~10-15
# depending on content; 12 is a workable midpoint. This is a rough estimate
# for a UI gauge, not an accounting figure.
TOKENS_PER_LINE = 12


def _ancestors_to_home(cwd: Path) -> list[Path]:
    """Return cwd, its parent, … up to (and including) `~`. If cwd is not
    under `~`, return just [cwd]."""
    home = config.HOME
    out: list[Path] = []
    cur = cwd
    out.append(cur)
    try:
        cur.relative_to(home)
    except ValueError:
        return out
    while cur != home:
        cur = cur.parent
        out.append(cur)
    return out


def _matches_paths(globs: list[str], cwd: Path) -> Optional[str]:
    """Return the first glob that matches cwd, or None.

    Globs in `paths:` come in three flavours: bare names (`trust_api`, after
    auto-extension `trust_api/**`), home-relative (`~/foo/**`), and absolute
    (`/home/x/repo/**`). pathspec's gitwildmatch is anchored, so for each
    glob we generate variants matching the subject's coordinate system, then
    test all (subject × variant) pairs.
    """
    home = config.HOME
    subjects: list[str] = []
    try:
        rel = cwd.relative_to(home)
        subjects.append(str(rel))
        subjects.append(str(rel) + "/")
    except ValueError:
        pass
    subjects.append(str(cwd))

    home_prefix = str(home) + "/"
    for glob in globs:
        variants: list[str] = []
        if glob.startswith("~/"):
            tail = glob[2:]
            variants.extend([tail, home_prefix + tail])
        elif glob.startswith("/"):
            variants.append(glob)
            if glob.startswith(home_prefix):
                variants.append(glob[len(home_prefix):])
        else:
            variants.append(glob)
        for v in variants:
            spec = pathspec.PathSpec.from_lines("gitwildmatch", [v])
            if any(spec.match_file(s) for s in subjects):
                return glob
    return None


def _add_dir_paths() -> list[Path]:
    """Return paths from CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD env var.

    Claude Code respects --add-dir paths ONLY when
    CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1 is set (item 8 in the
    37-item plan). If the env var is absent or not "1", --add-dir paths must
    NOT contribute CLAUDE.md to the load chain.

    The paths themselves come from CLAUDE_CODE_ADD_DIR_PATHS (a hypothetical
    env var) or more likely from Claude Code's internal session config — we
    can only observe their effect, not inject them. This function is a no-op
    placeholder that returns [] unless the feature is explicitly enabled and
    paths are provided.
    """
    if os.environ.get("CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD") != "1":
        return []
    raw = os.environ.get("CLAUDE_CODE_ADD_DIR_PATHS", "")
    if not raw:
        return []
    return [Path(p.strip()).expanduser() for p in raw.split(":") if p.strip()]


def _setting_sources_excludes_local() -> bool:
    """Return True if CLAUDE_CODE_SETTING_SOURCES excludes 'local'.

    When --setting-sources excludes 'local', CLAUDE.local.md from --add-dir
    paths should be skipped (item 9 in the 37-item plan).
    """
    sources = os.environ.get("CLAUDE_CODE_SETTING_SOURCES", "")
    if not sources:
        return False
    parts = {s.strip() for s in sources.split(",")}
    return "local" not in parts


def simulate(
    cwd: Path,
    files: list[FileEntry],
    edges: list[Edge],
) -> SimulatorResponse:
    by_id: dict[str, FileEntry] = {f.id: f for f in files}
    by_path: dict[str, FileEntry] = {f.path: f for f in files}

    # Drift fix #4: read claudeMdExcludes from all four settings scopes.
    # Managed CLAUDE.md is exempt — never excluded regardless of globs.
    managed_path = config.os_managed_claude_md_path()
    exclude_globs = _read_claude_md_excludes(cwd)

    def _is_excluded(file: FileEntry) -> bool:
        """True if the file's absolute path matches any claudeMdExcludes glob.
        Managed CLAUDE.md is always exempt from exclusion.
        """
        if not exclude_globs:
            return False
        fp = Path(file.path)
        try:
            if fp.resolve() == managed_path.resolve():
                return False
        except OSError:
            pass
        return _path_matches_glob_list(fp, exclude_globs)

    loaded_ids: set[str] = set()
    # Drift fix #5: track the priority inherited from each importer so @-imported
    # files inherit their parent's tier (not unconditionally assigned on-demand).
    # Maps file_id -> parent priority (only set when reached via @-import BFS).
    _import_parent_priority: dict[str, int] = {}
    steps: list[TimelineStep] = []
    conditional_count = 0

    def _push(
        file: FileEntry,
        status: str,
        matched_on: str | None,
        reason: str | None,
        parent_priority: int | None = None,
    ) -> None:
        nonlocal conditional_count
        slot, is_canonical, _, _ = classify_step(
            file.path, matched_on, status, cwd, kind=file.kind
        )
        # conditional = paths: globs present but didn't match this cwd → on-demand.
        # skipped = mention-reachable only → always on-demand.
        if status in ("conditional", "skipped"):
            priority = _SLOT_PRIORITY[SLOT_ON_DEMAND]
        elif matched_on == "@import" and parent_priority is not None:
            # Drift fix #5: @-imported files inherit the parent's tier when the
            # parent is session-start (tiers 1-5).  Only on-demand parents
            # (priority 6) produce on-demand imports.
            slot_priority = _SLOT_PRIORITY.get(slot, 6)
            priority = parent_priority if parent_priority < 6 else slot_priority
        else:
            priority = _SLOT_PRIORITY.get(slot, 6)
        steps.append(
            TimelineStep(
                idx=len(steps),
                file_id=file.id,
                file_path=file.display,
                status=status,  # type: ignore[arg-type]
                matched_on=matched_on,
                reason=reason,
                is_canonical=is_canonical,
                priority=priority,
            )
        )
        if status == "loaded":
            loaded_ids.add(file.id)
            _import_parent_priority[file.id] = priority
        elif status == "conditional":
            conditional_count += 1

    # 1. ~/.claude/CLAUDE.md
    user_global = by_path.get(str(config.CLAUDE_DIR / "CLAUDE.md"))
    if user_global and not _is_excluded(user_global):
        _push(user_global, "loaded", "user-global", "Always loaded at session start")

    # 2 + 3. Global rules at ~/.claude/rules/
    # Per Claude Code docs (memory.md, "Path-specific rules"):
    # > Path-scoped rules trigger when Claude reads files matching the pattern,
    # > not on every tool use.
    # Path-scoped rules NEVER load at session start, even when their paths:
    # globs match the active cwd. They are always on-demand and `/memory`
    # never lists them. Mark them as `conditional` so they show up in the
    # On-demand tier but stay out of the "Also loaded for this folder" panel.
    for f in files:
        if f.kind != "rule":
            continue
        if not str(f.path).startswith(str(config.CLAUDE_DIR / "rules")):
            continue
        if _is_excluded(f):
            continue
        if not f.paths_globs:
            _push(f, "loaded", "no-paths", "Always loaded (no paths: filter)")
        else:
            matched = _matches_paths(f.paths_globs, cwd)
            if matched:
                _push(
                    f, "conditional", matched,
                    "paths: glob matches cwd; loaded on-demand "
                    "when Claude reads a file matching the pattern",
                )
            else:
                _push(
                    f, "conditional", None,
                    f"paths: {f.paths_globs} did not match cwd",
                )

    # 4. Project-team-shared file: <cwd>/.claude/CLAUDE.md. Per the official
    # Claude Code docs this lives alongside <cwd>/CLAUDE.md as a project-level
    # instruction file (it's NOT walked up the ancestor chain — only the
    # session cwd has one).
    project_team = by_path.get(str(cwd / ".claude" / "CLAUDE.md"))
    if project_team and project_team.id not in loaded_ids and not _is_excluded(project_team):
        _push(project_team, "loaded", "project-team",
              f"Team-shared CLAUDE.md at {config.collapse_home(cwd / '.claude')}")

    # 5. Walk up from cwd to ~ (exclusive of duplicates already covered above).
    # --add-dir paths contribute additional CLAUDE.md entries ONLY when
    # CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1 (item 8).
    extra_dirs = _add_dir_paths()
    skip_local_from_extra = _setting_sources_excludes_local()
    ancestors = _ancestors_to_home(cwd)
    seen_dirs: set[Path] = set()
    for d in ancestors:
        if d in seen_dirs:
            continue
        seen_dirs.add(d)
        # CLAUDE.md at this level
        cm = by_path.get(str(d / "CLAUDE.md"))
        if cm and cm.id not in loaded_ids and not _is_excluded(cm):
            _push(cm, "loaded", "ancestor-walk",
                  f"CLAUDE.md found at ancestor {config.collapse_home(d)}")
        # CLAUDE.local.md at this level (per docs: "локальные инструкции,
        # специфичные для проекта" — historically common on the spine).
        local_cm = by_path.get(str(d / "CLAUDE.local.md"))
        if local_cm and local_cm.id not in loaded_ids and not _is_excluded(local_cm):
            _push(local_cm, "loaded", "ancestor-walk",
                  f"CLAUDE.local.md at {config.collapse_home(d)}")
        # .claude/rules/*.md at this level
        for f in files:
            if f.kind != "rule":
                continue
            rp = Path(f.path)
            try:
                rp.relative_to(d / ".claude" / "rules")
            except ValueError:
                continue
            # Skip the global rules dir — already handled above.
            if d == config.HOME and rp.parent == (config.CLAUDE_DIR / "rules"):
                continue
            if _is_excluded(f):
                continue
            if not f.paths_globs:
                if f.id not in loaded_ids:
                    _push(f, "loaded", "no-paths",
                          f"Per-repo rule, no paths: filter (under {config.collapse_home(d)})")
            else:
                # Path-scoped rules are always on-demand — never session-loaded
                # — regardless of whether the cwd matches. (See the global
                # rules block above for the docs citation.)
                matched = _matches_paths(f.paths_globs, cwd)
                if matched:
                    if f.id not in loaded_ids:
                        _push(
                            f, "conditional", matched,
                            "paths: glob matches cwd; loaded on-demand "
                            "when Claude reads a file matching the pattern",
                        )
                elif f.id not in loaded_ids:
                    _push(f, "conditional", None,
                          f"paths: {f.paths_globs} did not match cwd")

    # 5a. --add-dir paths (only when CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1).
    # Per Claude Code docs, --add-dir adds directories whose CLAUDE.md files
    # are loaded in addition to the ancestor-walk chain. CLAUDE.local.md from
    # these paths is skipped when --setting-sources excludes "local".
    for extra in extra_dirs:
        cm = by_path.get(str(extra / "CLAUDE.md"))
        if cm and cm.id not in loaded_ids and not _is_excluded(cm):
            _push(cm, "loaded", "add-dir",
                  f"CLAUDE.md from --add-dir path {config.collapse_home(extra)}")
        if not skip_local_from_extra:
            local_cm = by_path.get(str(extra / "CLAUDE.local.md"))
            if local_cm and local_cm.id not in loaded_ids and not _is_excluded(local_cm):
                _push(local_cm, "loaded", "add-dir",
                      f"CLAUDE.local.md from --add-dir path {config.collapse_home(extra)}")

    # 5b. Auto-memory MEMORY.md for the active cwd.
    # Per Claude Code docs (memory.md, "Auto memory"):
    # > The first 200 lines of MEMORY.md, or the first 25KB, whichever comes
    # > first, are loaded at the start of every conversation.
    # Each project gets `~/.claude/projects/<project>/memory/MEMORY.md`,
    # where <project> is the cwd path with `/` replaced by `-` (Claude Code
    # convention; for git worktrees Claude Code resolves the repo root, but
    # Observatory has no git knowledge — using the cwd verbatim is correct
    # for the common case where cwd == git root and is a no-op miss otherwise).
    auto_memory_key = str(cwd).replace("/", "-")
    auto_memory_path = (
        config.CLAUDE_DIR / "projects" / auto_memory_key / "memory" / "MEMORY.md"
    )
    auto_memory_file = by_path.get(str(auto_memory_path))
    if (
        auto_memory_file
        and auto_memory_file.id not in loaded_ids
        and not _is_excluded(auto_memory_file)
    ):
        _push(
            auto_memory_file,
            "loaded",
            "automemory",
            f"Auto-memory MEMORY.md for {config.collapse_home(cwd)} "
            "(first 200 lines / 25KB loaded at session start)",
        )

    # 6. Transitive @-imports.
    # Drift fix #5: pass the parent's priority so imported files inherit tier.
    queue: deque[str] = deque(loaded_ids)
    while queue:
        src = queue.popleft()
        src_priority = _import_parent_priority.get(src, 6)
        for e in edges:
            if e.kind != "import" or e.source != src:
                continue
            if e.target in loaded_ids:
                continue
            tgt = by_id.get(e.target)
            if not tgt:
                continue
            if _is_excluded(tgt):
                continue
            line_hint = f":{e.lines[0]}" if e.lines else ""
            _push(
                tgt, "loaded", "@import",
                f"Imported via @ from {by_id[src].display}{line_hint}",
                parent_priority=src_priority,
            )
            queue.append(tgt.id)

    # 6. Mentions reachable from anything loaded → on-demand.
    on_demand: set[str] = set()
    for e in edges:
        if e.kind != "mention":
            continue
        if e.source in loaded_ids and e.target not in loaded_ids:
            on_demand.add(e.target)
    for tid in sorted(on_demand):
        tgt = by_id.get(tid)
        if not tgt:
            continue
        _push(tgt, "skipped", None, "Reachable on-demand (mention edge)")

    files_loaded = sum(1 for s in steps if s.status == "loaded")
    est_tokens = sum(
        (by_id[s.file_id].line_count if s.file_id and s.file_id in by_id else 0)
        * TOKENS_PER_LINE
        for s in steps
        if s.status == "loaded"
    )
    on_demand_reachable = sum(1 for s in steps if s.status == "skipped")

    _enrich_toggle_metadata(steps, cwd, files, exclude_globs)

    return SimulatorResponse(
        cwd=str(cwd),
        steps=steps,
        stats=SimulatorStats(
            files_loaded=files_loaded,
            est_tokens=est_tokens,
            conditional_matches=conditional_count,
            on_demand_reachable=on_demand_reachable,
        ),
    )


def _enrich_toggle_metadata(
    steps: list[TimelineStep],
    cwd: Path,
    files: list[FileEntry],
    cwd_exclude_globs: list[str],
) -> None:
    """Inject category / disabled / disable_scope / containing_file into each
    cross-cwd loaded step so the frontend CrossCwdPanel can render toggles
    without a second API call.

    Only "loaded" steps whose file_path resolves outside the active cwd get
    enriched — all others keep category=None (saves bandwidth and avoids
    confusing the in-tree file rows).
    """
    # Read disabled-imports state file (global bucket).
    state_file = config.HOME / ".claude" / "observatory-disabled-imports.json"
    disabled_imports: set[str] = set()
    if state_file.is_file():
        try:
            data = json.loads(state_file.read_text(encoding="utf-8"))
            disabled_imports = set(data.get("imports", {}).keys())
        except (OSError, json.JSONDecodeError):
            pass

    files_by_path = {Path(f.path).resolve(): f for f in files}

    for step in steps:
        if step.status != "loaded":
            continue
        raw = step.file_path
        if raw.startswith("~/"):
            abs_path = config.HOME / raw[2:]
        else:
            abs_path = Path(raw)
        abs_path = abs_path.resolve()

        # Skip files inside the cwd — they are not cross-cwd.
        try:
            abs_path.relative_to(cwd)
            continue
        except ValueError:
            pass

        path_str = str(abs_path)

        # Determine category.
        if "/.claude/projects/" in path_str and "/memory/" in path_str:
            cat: str = "auto_memory"
        elif abs_path.name == "CLAUDE.md":
            cat = "claude_md"
        elif "/.claude/rules/" in path_str:
            cat = "rules"
        else:
            cat = "import"

        step.category = cat  # type: ignore[assignment]

        if cat == "auto_memory":
            step.disabled = False
            step.disable_scope = None
            step.containing_file = None
            continue

        if cat in ("claude_md", "rules"):
            step.disable_scope = "cwd"
            # Check claudeMdExcludes in the cwd settings.json.
            disabled_here = _path_matches_glob_list(abs_path, cwd_exclude_globs)
            step.disabled = disabled_here
            step.containing_file = None
        else:
            # import category
            step.disable_scope = "global"
            step.disabled = path_str in disabled_imports
            # Locate the containing CLAUDE.md for the confirmation modal.
            containing = _find_import_containing_file(abs_path, files)
            step.containing_file = str(containing) if containing else None


def _find_import_containing_file(target: Path, files: list[FileEntry]) -> Path | None:
    """Find the CLAUDE.md that @-imports target. Returns None if not found."""
    target_abs = str(target)
    target_display = config.collapse_home(target)
    import_patterns = [f"@{target_display}", f"@{target_abs}"]

    for f in files:
        if f.kind not in ("claude_md", "rule"):
            continue
        try:
            text = Path(f.path).read_text(encoding="utf-8")
        except OSError:
            continue
        parent_dir = Path(f.path).parent
        for line in text.splitlines():
            stripped = line.strip()
            # Also handle disabled lines (comment prefix).
            if "<!-- [disabled by Observatory] -->" in stripped:
                stripped = stripped.split("-->", 1)[-1].strip()
            for pat in import_patterns:
                if stripped == pat or stripped.startswith(pat + " "):
                    return Path(f.path)
            # Relative @-paths.
            if stripped.startswith("@") and not stripped.startswith("@~/") and not stripped.startswith("@/"):
                raw = stripped[1:].split()[0] if stripped[1:] else ""
                if raw:
                    try:
                        resolved = (parent_dir / raw).resolve()
                        if str(resolved) == target_abs:
                            return Path(f.path)
                    except OSError:
                        pass
    return None
