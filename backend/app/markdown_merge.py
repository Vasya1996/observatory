"""Markdown-AST merge helper for the 'merge into ~/.claude/CLAUDE.md' option.

plan_merge(source, target) -> MergePlan
  merged_body        — resulting file text
  heading_collisions — headings from source that already existed in target
  unified_diff       — diff of target before vs after (for DiffModal display)

Parser: self-contained, no external markdown library (locked rule #1 keeps
deps minimal). Parses files into flat sections: (heading_text, level, body_block).
"""
from __future__ import annotations

import difflib
import re
from pathlib import Path

from .models import MergePlan

_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*?)\s*$")


def _parse_sections(text: str) -> tuple[str, list[tuple[str, int, str]]]:
    """Split text into (frontmatter_block, list_of_(heading, level, body)].

    frontmatter_block is everything before the first # heading, verbatim.
    Each section tuple: heading_text (without #), heading_level, body_text
    (everything between this heading and the next one, including a trailing
    newline when present).
    """
    lines = text.splitlines(keepends=True)
    # Find the first heading line; everything before it is frontmatter.
    first_heading_idx = None
    for i, line in enumerate(lines):
        if _HEADING_RE.match(line):
            first_heading_idx = i
            break

    if first_heading_idx is None:
        # No headings at all — treat entire file as frontmatter / bodyless.
        return text, []

    frontmatter = "".join(lines[:first_heading_idx])
    sections: list[tuple[str, int, str]] = []
    current_heading_text = ""
    current_level = 0
    current_body_lines: list[str] = []

    for line in lines[first_heading_idx:]:
        m = _HEADING_RE.match(line)
        if m:
            if current_heading_text:
                sections.append(
                    (current_heading_text, current_level,
                     "".join(current_body_lines))
                )
            current_level = len(m.group(1))
            current_heading_text = m.group(2)
            current_body_lines = []
        else:
            current_body_lines.append(line)

    if current_heading_text:
        sections.append(
            (current_heading_text, current_level, "".join(current_body_lines))
        )
    return frontmatter, sections


def _sections_to_text(frontmatter: str, sections: list[tuple[str, int, str]]) -> str:
    parts = [frontmatter]
    for heading_text, level, body in sections:
        parts.append(f"{'#' * level} {heading_text}\n")
        if body:
            parts.append(body)
    return "".join(parts)


def plan_merge(source_path: Path, target_path: Path) -> MergePlan:
    """Compute a MergePlan for merging source_path's content into target_path.

    Algorithm:
    - Parse target into (frontmatter, sections[]).
    - For each source section:
      - If heading_text matches a target section at the same level, append
        source body UNDER the existing target heading (no duplicate heading).
        Record collision.
      - Otherwise, append the entire source section (heading + body) at the end.
    - Preserve target frontmatter verbatim.
    - Compute unified diff of target before → after.
    """
    try:
        target_text = target_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        target_text = ""
    try:
        source_text = source_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        source_text = ""

    target_fm, target_sections = _parse_sections(target_text)
    _, source_sections = _parse_sections(source_text)

    # Index target sections by (heading_text_lower, level) for collision lookup.
    # Use the first occurrence only — if duplicates exist in target that's the
    # target author's problem.
    target_idx: dict[tuple[str, int], int] = {}
    for i, (ht, level, _body) in enumerate(target_sections):
        key = (ht.lower(), level)
        if key not in target_idx:
            target_idx[key] = i

    merged_sections = list(target_sections)
    heading_collisions: list[str] = []

    for (ht, level, body) in source_sections:
        key = (ht.lower(), level)
        if key in target_idx:
            # Collision — append source body under existing target heading.
            idx = target_idx[key]
            existing_ht, existing_level, existing_body = merged_sections[idx]
            separator = "\n" if existing_body and not existing_body.endswith("\n\n") else ""
            merged_sections[idx] = (
                existing_ht,
                existing_level,
                existing_body + separator + body,
            )
            heading_collisions.append(ht)
        else:
            merged_sections.append((ht, level, body))

    merged_body = _sections_to_text(target_fm, merged_sections)

    diff_lines = difflib.unified_diff(
        target_text.splitlines(keepends=True),
        merged_body.splitlines(keepends=True),
        fromfile=f"a/{target_path.name}",
        tofile=f"b/{target_path.name}",
        n=3,
    )
    unified_diff = "".join(diff_lines)

    return MergePlan(
        merged_body=merged_body,
        heading_collisions=heading_collisions,
        unified_diff=unified_diff,
    )
