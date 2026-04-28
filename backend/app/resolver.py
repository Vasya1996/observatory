"""Resolve parsed refs into Edges and assemble the FileEntry list.

Given the scanner's RawFile list, this module:
  1. Parses each markdown file (frontmatter + refs).
  2. Builds a basename → file_id index for mention resolution.
  3. Walks every ParsedRef, resolves it, emits an Edge or a validation issue.
  4. Returns FileEntry list (with validation merged) and Edge list.

The whole thing is pure: same inputs → same outputs. The watcher's job is just
to call `build_index()` again on filesystem changes.
"""
from __future__ import annotations

import hashlib
from collections import defaultdict
from pathlib import Path
from typing import Optional

import pathspec

from . import config, scanner
from .models import Edge, FileEntry, Issue, PathsStatus
from .parser import ParsedFile, file_id, parse_json_only_metadata, parse_markdown


def _filename_scope(name: str) -> Optional[str]:
    """Extract the scope prefix (chars before the first underscore) from a
    knowledge filename. `tma_codebase.md` → `"tma"`. Files without an
    underscore (e.g. `user.md`, `MEMORY.md`) → None.
    """
    stem = name.rsplit(".", 1)[0]
    if "_" not in stem:
        return None
    return stem.split("_", 1)[0]


def _collapse(p: Path) -> str:
    return config.collapse_home(p)


def _resolve_import_path(raw: str, source_dir: Path) -> Path:
    """Expand `~` and resolve relative-to-source for an @-import target."""
    p = Path(raw)
    if raw.startswith("~"):
        p = Path(raw).expanduser()
    elif raw.startswith("/"):
        p = Path(raw)
    else:
        p = (source_dir / raw).resolve()
    try:
        return p.expanduser().resolve()
    except OSError:
        return p


def _check_paths_status(globs: Optional[list[str]]) -> PathsStatus:
    """Verify each glob's "literal prefix" — the portion before any wildcard —
    points to an existing directory under `~`. Missing → "missing".

    For a glob like `trust_api/**`, the prefix is `trust_api`; for `a/b/*.py`
    it's `a/b`; for `**/foo.md` it's empty (treated as "ok" — depth-flexible).
    """
    if globs is None:
        return "n_a"
    if not globs:
        return "n_a"
    home = config.HOME
    for g in globs:
        absolute = g.startswith("/") or g.startswith("~")
        # Strip a leading "~/" so the remaining parts are relative.
        head = g[2:] if g.startswith("~/") else (g[1:] if g.startswith("~") else g)
        if absolute and g.startswith("/"):
            head = g.lstrip("/")
        prefix_parts: list[str] = []
        for part in head.split("/"):
            if "*" in part or "?" in part or "[" in part:
                break
            if part == "":
                continue
            prefix_parts.append(part)
        if not prefix_parts:
            continue  # depth-flexible glob, nothing to verify
        if absolute:
            if g.startswith("~"):
                target = home / Path(*prefix_parts)
            else:
                target = Path("/" + "/".join(prefix_parts))
        else:
            target = home / Path(*prefix_parts)
        if not target.exists():
            return "missing"
    return "ok"


def build_index() -> tuple[list[FileEntry], list[Edge]]:
    """Run a full scan + parse + resolve pass and return frozen results."""
    raw_files = scanner.scan()

    # First pass: collect basenames so the parser can perform mention matching.
    in_scope_basenames: set[str] = {rf.path.name for rf in raw_files}

    parsed: list[ParsedFile] = []
    for rf in raw_files:
        try:
            if rf.path.suffix == ".md":
                parsed.append(
                    parse_markdown(rf.path, rf.kind, rf.readonly, in_scope_basenames)
                )
            else:
                parsed.append(parse_json_only_metadata(rf.path, rf.kind, rf.readonly))
        except OSError as e:
            parsed.append(
                ParsedFile(
                    raw_path=rf.path,
                    kind=rf.kind,
                    readonly=rf.readonly,
                    frontmatter=None,
                    paths_globs=None,
                    body="",
                    line_count=0,
                    refs=[],
                    issues=[
                        Issue(
                            severity="error",
                            code="read_error",
                            message=f"Could not read file: {e}",
                        )
                    ],
                )
            )

    # Index basename → list of file_ids for mention resolution.
    by_basename: dict[str, list[Path]] = defaultdict(list)
    for p in parsed:
        by_basename[p.raw_path.name].append(p.raw_path)

    files: list[FileEntry] = []
    # Aggregate refs into one edge per (source, target, kind) tuple. The line
    # numbers of every contributing ref accumulate in `lines` (deduped + sorted),
    # so a markdown link like `[name](name)` — which the parser sees as two
    # mentions on the same line — stays one edge with one line number, and
    # multi-line repeats become one edge with N line numbers.
    edge_acc: dict[tuple[str, str, str], set[int]] = defaultdict(set)

    for p in parsed:
        fid = file_id(p.raw_path)
        try:
            stat = p.raw_path.stat()
            mtime = stat.st_mtime
            size = stat.st_size
        except OSError:
            mtime, size = 0.0, 0

        scope = _filename_scope(p.raw_path.name) if p.kind == "memory" else None

        # Resolve refs into edges.
        for ref in p.refs:
            if ref.kind == "import":
                target_path = _resolve_import_path(ref.raw_target, p.raw_path.parent)
                if target_path in {q.raw_path for q in parsed}:
                    target_id = hashlib.sha1(str(target_path).encode("utf-8")).hexdigest()
                    if ref.line is not None:
                        edge_acc[(fid, target_id, "import")].add(ref.line)
                    else:
                        edge_acc[(fid, target_id, "import")]  # ensure key exists
                else:
                    p.issues.append(
                        Issue(
                            severity="warning",
                            code="import_unresolved",
                            message=f"@-import target not in scanned set: {ref.raw_target}",
                            line=ref.line,
                        )
                    )
            else:  # mention
                candidates = by_basename.get(ref.raw_target, [])
                if not candidates:
                    continue
                if len(candidates) == 1:
                    target_path = candidates[0]
                else:
                    # Prefer same directory; otherwise flag ambiguous and skip.
                    same_dir = [c for c in candidates if c.parent == p.raw_path.parent]
                    if len(same_dir) == 1:
                        target_path = same_dir[0]
                    else:
                        p.issues.append(
                            Issue(
                                severity="info",
                                code="mention_ambiguous",
                                message=(
                                    f"Mention `{ref.raw_target}` matches multiple "
                                    f"files: {[_collapse(c) for c in candidates]}"
                                ),
                                line=ref.line,
                            )
                        )
                        continue
                target_id = hashlib.sha1(str(target_path).encode("utf-8")).hexdigest()
                if target_id == fid:
                    continue  # ignore self-mentions
                if ref.line is not None:
                    edge_acc[(fid, target_id, "mention")].add(ref.line)
                else:
                    edge_acc[(fid, target_id, "mention")]

        paths_status = _check_paths_status(p.paths_globs) if p.kind == "rule" else "n_a"
        if paths_status == "missing":
            p.issues.append(
                Issue(
                    severity="warning",
                    code="paths_target_missing",
                    message=f"`paths:` target directory not found: {p.paths_globs}",
                )
            )

        files.append(
            FileEntry(
                id=fid,
                path=str(p.raw_path),
                display=_collapse(p.raw_path),
                kind=p.kind,
                scope=scope,
                frontmatter=p.frontmatter,
                paths_globs=p.paths_globs,
                paths_status=paths_status,
                readonly=p.readonly,
                mtime=mtime,
                size_bytes=size,
                line_count=p.line_count,
                validation=p.issues,
                display_name=p.display_name,
            )
        )

    # Materialise aggregated refs into one Edge per (source, target, kind).
    # `lines` carries the full set of source-lines the inspector can show
    # ("references appear on lines 3, 47, 112"); the graph still draws a single
    # curve per direction.
    edges: list[Edge] = [
        Edge(
            id=f"{src}:{tgt}:{kind}",
            source=src,
            target=tgt,
            kind=kind,
            lines=sorted(line_set),
        )
        for (src, tgt, kind), line_set in edge_acc.items()
    ]
    edges.sort(key=lambda e: (e.source, e.target, e.kind))

    return files, edges


def parsed_for_path(path: Path) -> Optional[ParsedFile]:
    """Re-parse one file on demand (used by /api/file). Returns None if the
    path isn't in the scanned set.
    """
    raw_files = scanner.scan()
    if not any(rf.path == path for rf in raw_files):
        return None
    rf = next(rf for rf in raw_files if rf.path == path)
    in_scope = {r.path.name for r in raw_files}
    if rf.path.suffix == ".md":
        return parse_markdown(rf.path, rf.kind, rf.readonly, in_scope)
    return parse_json_only_metadata(rf.path, rf.kind, rf.readonly)
