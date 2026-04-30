"""Orphan-import scanner for Phase 3 verification primitives.

find_importers — given a target path, walk the cached index and return every
                 file that @-imports the target. Used before a migration to
                 detect external importers that aren't part of the planned rewrite.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from .watcher import IndexCache

# Mirror of parser._IMPORT_RE — matches @<path> tokens.
_IMPORT_RE = re.compile(
    r"(?<![A-Za-z0-9_])@(/[^\s)`]+|~/[^\s)`]+|\.{1,2}/[^\s)`]+)"
)


@dataclass
class ImportRef:
    file_path: str
    line_number: int
    raw_line: str


def find_importers(target_path: Path, cache: IndexCache) -> list[ImportRef]:
    """Return every file in the index that @-imports target_path.

    Walks cache.files — no additional filesystem scanning, no blacklist concerns.
    Resolves relative and ~/ paths against the importing file's directory to
    allow canonical comparison.

    The ancestor CLAUDE.md chain and project-zone files are already in the
    index via the project-zone scan (locked rule #14 + commit 1f1d7dc), so
    this covers the full reachable import graph.
    """
    target = target_path.resolve()
    target_basename = target.name
    home = Path.home()
    results: list[ImportRef] = []

    files, _, _ = cache.snapshot()
    for entry in files:
        # Only files that can contain @-imports.
        if entry.kind not in ("claude_md", "rule", "memory", "memory_index"):
            continue
        fp = Path(entry.path)
        if not fp.is_file():
            continue
        try:
            body = fp.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for lineno, line in enumerate(body.splitlines(), start=1):
            for m in _IMPORT_RE.finditer(line):
                raw_token = m.group(1)
                # Resolve the token to an absolute path.
                resolved = _resolve_import_token(raw_token, fp.parent, home)
                if resolved is not None and resolved == target:
                    results.append(
                        ImportRef(
                            file_path=str(fp),
                            line_number=lineno,
                            raw_line=line,
                        )
                    )
    return results


def _resolve_import_token(token: str, base_dir: Path, home: Path) -> Path | None:
    """Resolve an @-import token to an absolute Path, or None if ambiguous."""
    try:
        if token.startswith("~/"):
            return (home / token[2:]).resolve()
        if token.startswith("/"):
            return Path(token).resolve()
        # Relative (./foo or ../foo)
        return (base_dir / token).resolve()
    except (ValueError, OSError):
        return None
