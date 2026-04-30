"""Canonical-slot classification for the Phase 3 Simulator ribbon.

classify_canonical(file_path, step, cwd) -> (slot_name, is_canonical, reason)
find_orphan_configs(files, cwds) -> list[OrphanConfigEntry]

Used by:
  - /api/simulate  to enrich each TimelineStep with is_canonical: bool
  - /api/non-canonical  to list files at non-canonical paths with reasons + orphans
"""
from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Optional

from . import config

if TYPE_CHECKING:
    from .models import FileEntry, OrphanConfigEntry

# Canonical slot names (match Phase 3 plan section 1 order).
SLOT_MANAGED = "managed"
SLOT_USER_GLOBAL = "user-global"
SLOT_ANCESTOR_WALK = "ancestor-walk"
SLOT_PROJECT = "project"
SLOT_AUTO_MEMORY = "auto-memory"
SLOT_ON_DEMAND = "on-demand"
SLOT_UNKNOWN = "unknown"

# Kinds that are always canonical at their actual location — they don't
# have a single "correct" place in the load chain the way claude_md and
# rule files do. Flagging them as non-canonical would produce false
# positives (e.g. MEMORY.md loaded via @-import is still correct).
_ALWAYS_CANONICAL_KINDS = frozenset({
    "memory",
    "memory_index",
    "skill",
    "plugin_manifest",
    "plugin_registry",
    "automemory",
    "settings",
    "mcp",
    "script",
})


def _is_under(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _slot_for_always_canonical(fp: Path, cwd: Path) -> str:
    """Return the best-fit slot name for a file that is always canonical.

    Used so the slot column in the Phase 3 ribbon still shows a sensible
    category even though we never flag these kinds as non-canonical.
    """
    claude_dir = config.CLAUDE_DIR
    # AUTO_MEMORY_DIR now points to projects/ root; check for <project>/memory/ pattern.
    projects_dir = claude_dir / "projects"
    if _is_under(fp, projects_dir):
        # Any file under <project>/memory/ is auto-memory.
        parts = fp.parts
        proj_parts = projects_dir.parts
        rel = parts[len(proj_parts):]  # (project_dir_name, "memory", ...)
        if len(rel) >= 2 and rel[1] == "memory":
            return SLOT_AUTO_MEMORY
    if _is_under(fp, claude_dir / "knowledge") or _is_under(fp, claude_dir / "skills"):
        return SLOT_USER_GLOBAL
    if _is_under(fp, claude_dir / "remote" / "plugins"):
        return SLOT_USER_GLOBAL
    if _is_under(fp, claude_dir):
        return SLOT_USER_GLOBAL
    # Scripts or files under a cwd live in the project slot.
    try:
        fp.relative_to(cwd)
        return SLOT_PROJECT
    except ValueError:
        pass
    return SLOT_ON_DEMAND


def classify_step(
    file_path_str: str,
    matched_on: Optional[str],
    status: str,
    cwd: Path,
    kind: Optional[str] = None,
) -> tuple[str, bool, str, str]:
    """Return (slot, is_canonical, canonical_path, reason).

    slot           — one of the SLOT_* constants above.
    is_canonical   — True when the file's actual path matches the slot pattern.
    canonical_path — what the canonical path for the slot would be (for tooltip).
    reason         — non-canonical reason code if is_canonical is False, else "".

    Canonical patterns per slot:
      managed      : os_managed_claude_md_path()
      user-global  : ~/.claude/CLAUDE.md  OR  ~/.claude/rules/*.md (no paths:)
      ancestor-walk: <ancestor>/CLAUDE.md  OR  <ancestor>/CLAUDE.local.md
      project      : <cwd>/.claude/CLAUDE.md  OR  <cwd>/.claude/rules/*.md
      auto-memory  : ~/.claude/projects/<project>/memory/**
      on-demand    : paths-scoped rules, nested <sub>/CLAUDE.md, topical memory

    Only `claude_md` and `rule` kinds can return is_canonical=False; all other
    kinds are always treated as canonical at their actual location because they
    don't have a single "correct" load-chain slot (memory files, skills, plugins,
    settings, mcp, scripts are correct wherever they live).
    """
    home = config.HOME
    claude_dir = config.CLAUDE_DIR
    fp = Path(file_path_str)
    # Normalise display paths that start with ~
    if file_path_str.startswith("~/") or file_path_str == "~":
        fp = home / file_path_str[2:]
    try:
        fp = fp.resolve()
    except OSError:
        pass

    # Non-claude_md / non-rule kinds are always canonical at their actual path.
    if kind in _ALWAYS_CANONICAL_KINDS:
        slot = _slot_for_always_canonical(fp, cwd)
        return slot, True, str(fp), ""

    managed_path = config.os_managed_claude_md_path()

    # --- Managed slot ---
    if fp == managed_path.resolve() if managed_path.exists() else fp == managed_path:
        return SLOT_MANAGED, True, str(managed_path), ""

    # --- Auto-memory slot ---
    projects_root = claude_dir / "projects"
    if _is_under(fp, projects_root):
        # Only <project>/memory/ paths are canonical auto-memory.
        # Other paths under projects/ are blacklisted and shouldn't be here.
        parts = fp.parts
        proj_parts = projects_root.parts
        rel = parts[len(proj_parts):]  # (proj_name, subdir, ...)
        canonical_for_auto = str(projects_root)
        if len(rel) >= 2 and rel[1] == "memory":
            return SLOT_AUTO_MEMORY, True, canonical_for_auto, ""
        return SLOT_AUTO_MEMORY, False, canonical_for_auto, "outside_canonical_dir"

    # --- User-global slot ---
    is_user_global_claude_md = (fp == (claude_dir / "CLAUDE.md"))
    is_user_global_rule = (
        fp.suffix == ".md"
        and fp.parent == (claude_dir / "rules")
    )
    if is_user_global_claude_md or is_user_global_rule:
        if matched_on == "@import":
            # Loaded via @-import rather than by the normal user-global scan —
            # still user-global files, but note the non-standard load path.
            canonical = str(fp)
            return SLOT_USER_GLOBAL, False, canonical, "loaded_via_at_import"
        return SLOT_USER_GLOBAL, True, str(fp), ""

    # --- Project slot ---
    project_claude_md = cwd / ".claude" / "CLAUDE.md"
    project_rules_dir = cwd / ".claude" / "rules"
    is_project_team = (fp == project_claude_md)
    is_project_rule = (fp.suffix == ".md" and _is_under(fp, project_rules_dir))
    if is_project_team or is_project_rule:
        if matched_on == "@import":
            return SLOT_PROJECT, False, str(fp), "loaded_via_at_import"
        return SLOT_PROJECT, True, str(fp), ""

    # --- Ancestor-walk slot ---
    # Any <ancestor>/CLAUDE.md or <ancestor>/CLAUDE.local.md where ancestor
    # is on the cwd→~ spine.
    ancestors = _ancestors_to_home(cwd)
    ancestor_set = set(str(a) for a in ancestors)
    if fp.name in ("CLAUDE.md", "CLAUDE.local.md"):
        parent_str = str(fp.parent)
        if parent_str in ancestor_set:
            if matched_on == "@import":
                return SLOT_ANCESTOR_WALK, False, str(fp), "loaded_via_at_import"
            return SLOT_ANCESTOR_WALK, True, str(fp), ""
        # File has the right name but isn't on the ancestor spine.
        return SLOT_ANCESTOR_WALK, False, str(fp), "outside_canonical_dir"

    # Ancestor-walk also includes .claude/rules/*.md at each ancestor level.
    for anc in ancestors:
        anc_rules = anc / ".claude" / "rules"
        if fp.suffix == ".md" and _is_under(fp, anc_rules):
            if matched_on == "@import":
                return SLOT_ANCESTOR_WALK, False, str(fp), "loaded_via_at_import"
            return SLOT_ANCESTOR_WALK, True, str(fp), ""

    # --- On-demand slot (skipped or @imported from elsewhere) ---
    if status == "skipped":
        return SLOT_ON_DEMAND, True, str(fp), ""

    # File is loaded but doesn't match any canonical pattern.
    # If it got here via @import, classify it as on-demand-via-import
    # (non-canonical: was @-imported but lives outside every canonical dir).
    if matched_on == "@import":
        # Suggest the user-global rules dir as the canonical target.
        canonical = str(claude_dir / "rules" / fp.name)
        return SLOT_ON_DEMAND, False, canonical, "loaded_via_at_import"

    # Fallthrough: outside every canonical tree.
    canonical = str(claude_dir / "rules" / fp.name)
    return SLOT_UNKNOWN, False, canonical, "outside_canonical_dir"


def _ancestors_to_home(cwd: Path) -> list[Path]:
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


# Sub-directory names that, when they contain a CLAUDE.md but their *parent*
# cwd has no top-level CLAUDE.md / .claude/CLAUDE.md, strongly suggest the
# user intended that file as a global-scope config (i.e. the "buried config"
# trap). The set is conservative — only names whose semantic meaning clearly
# implies cross-project applicability.
_CONFIG_DUMP_SUBDIR_NAMES = frozenset({
    "global", "project", "common", "shared", "rules",
})


def find_orphan_configs(
    files: "list[FileEntry]",
    cwds: list[Path],
) -> "list[OrphanConfigEntry]":
    """Return every claude_md / rule file that is never loaded by Claude in any
    discovered cwd.

    A file is NOT orphaned when it matches at least one of:
      - ~/.claude/CLAUDE.md, ~/CLAUDE.md, ~/CLAUDE.local.md,
        ~/.claude/CLAUDE.local.md, ~/.claude/rules/<name>.md  (user-global)
      - OS-managed CLAUDE.md path  (managed)
      - <cwd>/CLAUDE.md, <cwd>/CLAUDE.local.md,
        <cwd>/.claude/CLAUDE.md, <cwd>/.claude/rules/<name>.md
        for ANY cwd  (project zone)
      - <ancestor>/CLAUDE.md or <ancestor>/CLAUDE.local.md for ANY ancestor
        spine of ANY cwd  (ancestor-walk)
      - <cwd>/<subdir>/CLAUDE.md for ANY cwd, EXCEPT when:
          * subdir name is in _CONFIG_DUMP_SUBDIR_NAMES AND
          * the parent cwd has no top-level CLAUDE.md and no .claude/CLAUDE.md
        (in that exception case → flagged as buried_in_config_folder)
    """
    from .models import OrphanConfigEntry  # local import avoids circular dep

    home = config.HOME
    claude_dir = config.CLAUDE_DIR

    # Build the full set of "safe" (non-orphan) absolute paths.
    safe: set[Path] = set()

    # User-global files that are always safe.
    for p in [
        home / "CLAUDE.md",
        home / "CLAUDE.local.md",
        claude_dir / "CLAUDE.md",
        claude_dir / "CLAUDE.local.md",
    ]:
        safe.add(p.resolve() if p.exists() else p)

    for p in (claude_dir / "rules").glob("*.md") if (claude_dir / "rules").is_dir() else []:
        safe.add(p.resolve())

    managed = config.os_managed_claude_md_path()
    safe.add(managed.resolve() if managed.exists() else managed)

    # Build ancestor spines once for all cwds (large overlap expected).
    all_ancestors: set[Path] = set()
    for cwd in cwds:
        for anc in _ancestors_to_home(cwd):
            all_ancestors.add(anc)

    # Project-zone files for every cwd + their ancestor spines.
    for cwd in cwds:
        # Top-level project files.
        for name in ("CLAUDE.md", "CLAUDE.local.md"):
            p = cwd / name
            safe.add(p.resolve() if p.exists() else p)
        dot_claude_md = cwd / ".claude" / "CLAUDE.md"
        safe.add(dot_claude_md.resolve() if dot_claude_md.exists() else dot_claude_md)
        if (cwd / ".claude" / "rules").is_dir():
            for p in (cwd / ".claude" / "rules").glob("*.md"):
                safe.add(p.resolve())

    # Ancestor-walk spine files (CLAUDE.md and CLAUDE.local.md at each level).
    for anc in all_ancestors:
        for name in ("CLAUDE.md", "CLAUDE.local.md"):
            p = anc / name
            safe.add(p.resolve() if p.exists() else p)

    # Collect which parent cwds have their own top-level CLAUDE.md — used to
    # distinguish real projects from config-dump folders.
    cwds_with_top_level_claude_md: set[Path] = set()
    for cwd in cwds:
        if (cwd / "CLAUDE.md").is_file() or (cwd / ".claude" / "CLAUDE.md").is_file():
            cwds_with_top_level_claude_md.add(cwd)

    # Collect nested CLAUDE.md files for every cwd: <cwd>/<subdir>/CLAUDE.md.
    # These are on-demand canonical unless they hit the buried-config heuristic.
    nested_safe: set[Path] = set()
    buried: set[Path] = set()
    for cwd in cwds:
        if not cwd.is_dir():
            continue
        try:
            subdirs = [s for s in cwd.iterdir() if s.is_dir() and not s.name.startswith(".")]
        except OSError:
            continue
        for sub in subdirs:
            nested = sub / "CLAUDE.md"
            if not nested.is_file():
                continue
            resolved = nested.resolve()
            if (
                sub.name in _CONFIG_DUMP_SUBDIR_NAMES
                and cwd not in cwds_with_top_level_claude_md
            ):
                # Parent cwd is a config-dump folder, not a real project.
                buried.add(resolved)
            else:
                nested_safe.add(resolved)

    results: list[OrphanConfigEntry] = []
    for f in files:
        if f.kind not in ("claude_md", "rule"):
            continue

        fp_str = f.path
        if fp_str.startswith("~/"):
            fp = home / fp_str[2:]
        else:
            fp = Path(fp_str)
        try:
            fp_resolved = fp.resolve()
        except OSError:
            fp_resolved = fp

        if fp_resolved in safe:
            continue
        if fp_resolved in nested_safe:
            continue

        # Build suggested canonical paths.
        basename = fp_resolved.name
        if f.kind == "claude_md":
            suggestions = [
                "~/.claude/CLAUDE.md (merge into)",
                f"~/.claude/rules/{basename} (move as separate rule)",
            ]
        else:
            suggestions = [
                f"~/.claude/rules/{basename}",
            ]
            # Add project-zone suggestion using first cwd.
            if cwds:
                suggestions.append(
                    config.collapse_home(cwds[0] / ".claude" / "rules" / basename)
                )

        if fp_resolved in buried:
            reason: str = "buried_in_config_folder"
        else:
            reason = "outside_load_chain"

        results.append(
            OrphanConfigEntry(
                file_path=str(fp_resolved),
                kind=f.kind,  # type: ignore[arg-type]
                suggested_canonical_paths=suggestions,
                reason=reason,  # type: ignore[arg-type]
            )
        )

    return results
