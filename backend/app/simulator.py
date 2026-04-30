"""Session-load simulator.

Given a cwd, return the ordered list of files that would be loaded into a
Claude Code session at start, plus on-demand-reachable files. The model
mirrors Claude Code's actual behaviour:

  1. `~/.claude/CLAUDE.md` always.
  2. `~/.claude/rules/*.md` without `paths:` always.
  3. `~/.claude/rules/*.md` with `paths:` — loaded if cwd matches, else conditional.
  4. For the session cwd specifically: also load `<cwd>/.claude/CLAUDE.md`
     (team-shared project instructions, per official Claude Code docs).
  5. Walk UP from cwd to `~`: at each level, load `<dir>/CLAUDE.md` AND
     `<dir>/CLAUDE.local.md` if either exists, plus `<dir>/.claude/rules/*.md`
     (same `paths:` rule).
  6. Transitively chase `@-import` from anything loaded.
  7. `mention`-reachable files → on-demand-reachable (skipped, but counted).

Step 5 is what makes the simulator work for any user: we don't hardcode
`~/CLAUDE.md`, we discover it as the ancestor walk ascends.
"""
from __future__ import annotations

import os
from collections import deque
from pathlib import Path
from typing import Optional

import pathspec

from . import config
from .canonical import classify_step
from .models import Edge, FileEntry, SimulatorResponse, SimulatorStats, TimelineStep

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

    loaded_ids: set[str] = set()
    steps: list[TimelineStep] = []
    conditional_count = 0

    def _push(file: FileEntry, status: str, matched_on: str | None, reason: str | None):
        nonlocal conditional_count
        _slot, is_canonical, _canonical_path, _nc_reason = classify_step(
            file.path, matched_on, status, cwd
        )
        steps.append(
            TimelineStep(
                idx=len(steps),
                file_id=file.id,
                file_path=file.display,
                status=status,  # type: ignore[arg-type]
                matched_on=matched_on,
                reason=reason,
                is_canonical=is_canonical,
            )
        )
        if status == "loaded":
            loaded_ids.add(file.id)
        elif status == "conditional":
            conditional_count += 1

    # 1. ~/.claude/CLAUDE.md
    user_global = by_path.get(str(config.CLAUDE_DIR / "CLAUDE.md"))
    if user_global:
        _push(user_global, "loaded", "user-global", "Always loaded at session start")

    # 2 + 3. Global rules at ~/.claude/rules/
    for f in files:
        if f.kind != "rule":
            continue
        if not str(f.path).startswith(str(config.CLAUDE_DIR / "rules")):
            continue
        if not f.paths_globs:
            _push(f, "loaded", "no-paths", "Always loaded (no paths: filter)")
        else:
            matched = _matches_paths(f.paths_globs, cwd)
            if matched:
                _push(f, "loaded", matched, "paths: glob matched cwd")
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
    if project_team and project_team.id not in loaded_ids:
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
        if cm and cm.id not in loaded_ids:
            _push(cm, "loaded", "ancestor-walk",
                  f"CLAUDE.md found at ancestor {config.collapse_home(d)}")
        # CLAUDE.local.md at this level (per docs: "локальные инструкции,
        # специфичные для проекта" — historically common on the spine).
        local_cm = by_path.get(str(d / "CLAUDE.local.md"))
        if local_cm and local_cm.id not in loaded_ids:
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
            if not f.paths_globs:
                if f.id not in loaded_ids:
                    _push(f, "loaded", "no-paths",
                          f"Per-repo rule, no paths: filter (under {config.collapse_home(d)})")
            else:
                matched = _matches_paths(f.paths_globs, cwd)
                if matched:
                    if f.id not in loaded_ids:
                        _push(f, "loaded", matched, "paths: glob matched cwd")
                elif f.id not in loaded_ids:
                    _push(f, "conditional", None,
                          f"paths: {f.paths_globs} did not match cwd")

    # 5a. --add-dir paths (only when CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1).
    # Per Claude Code docs, --add-dir adds directories whose CLAUDE.md files
    # are loaded in addition to the ancestor-walk chain. CLAUDE.local.md from
    # these paths is skipped when --setting-sources excludes "local".
    for extra in extra_dirs:
        cm = by_path.get(str(extra / "CLAUDE.md"))
        if cm and cm.id not in loaded_ids:
            _push(cm, "loaded", "add-dir",
                  f"CLAUDE.md from --add-dir path {config.collapse_home(extra)}")
        if not skip_local_from_extra:
            local_cm = by_path.get(str(extra / "CLAUDE.local.md"))
            if local_cm and local_cm.id not in loaded_ids:
                _push(local_cm, "loaded", "add-dir",
                      f"CLAUDE.local.md from --add-dir path {config.collapse_home(extra)}")

    # 6. Transitive @-imports.
    queue: deque[str] = deque(loaded_ids)
    while queue:
        src = queue.popleft()
        for e in edges:
            if e.kind != "import" or e.source != src:
                continue
            if e.target in loaded_ids:
                continue
            tgt = by_id.get(e.target)
            if not tgt:
                continue
            line_hint = f":{e.lines[0]}" if e.lines else ""
            _push(
                tgt, "loaded", "@import",
                f"Imported via @ from {by_id[src].display}{line_hint}",
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
