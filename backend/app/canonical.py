"""Canonical-slot classification for the Phase 3 Simulator ribbon.

classify_canonical(file_path, step, cwd) -> (slot_name, is_canonical, reason)

Used by:
  - /api/simulate  to enrich each TimelineStep with is_canonical: bool
  - /api/non-canonical  to list files at non-canonical paths with reasons
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Optional

from . import config

# Canonical slot names (match Phase 3 plan section 1 order).
SLOT_MANAGED = "managed"
SLOT_USER_GLOBAL = "user-global"
SLOT_ANCESTOR_WALK = "ancestor-walk"
SLOT_PROJECT = "project"
SLOT_AUTO_MEMORY = "auto-memory"
SLOT_ON_DEMAND = "on-demand"
SLOT_UNKNOWN = "unknown"


def _is_under(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def classify_step(
    file_path_str: str,
    matched_on: Optional[str],
    status: str,
    cwd: Path,
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

    A file is non-canonical when it appears in a slot but was pulled in via
    @-import from outside that slot's normal root (matched_on == "@import").
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

    managed_path = config.os_managed_claude_md_path()

    # --- Managed slot ---
    if fp == managed_path.resolve() if managed_path.exists() else fp == managed_path:
        return SLOT_MANAGED, True, str(managed_path), ""

    # --- Auto-memory slot ---
    auto_mem_base = claude_dir / "projects"
    if _is_under(fp, auto_mem_base):
        # Only the designated auto-memory zone is canonical; other projects/ paths
        # are blacklisted — they shouldn't be in the index at all.
        canonical_for_auto = str(config.AUTO_MEMORY_DIR)
        if _is_under(fp, config.AUTO_MEMORY_DIR):
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
