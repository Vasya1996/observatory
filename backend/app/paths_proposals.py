"""Auto-rewrite proposals for broken `paths:` globs in rule files.

When a rule's `paths:` glob points to a directory that no longer exists (repo
moved, renamed, deleted), we look for a current discovered cwd with a matching
basename and propose it as a replacement. The endpoint only SURFACES the
proposal — the actual rewrite still flows through the diff modal pipeline
(locked rule #36).

Triggered automatically on each reindex per Vasya's locked answer 15: the
backend computes proposals on demand; the frontend polls this endpoint after
every SSE `reindex` event. No silent writes — the diff modal precedes every
edit.

Pure function over the current index. Caller is expected to memoise the
result for an indexed-state lifetime; the watcher invalidates by rebuilding
the IndexCache on every filesystem change.
"""
from __future__ import annotations

from pathlib import Path
from typing import Iterable, Optional

from . import config, scanner
from .models import FileEntry, PathProposal


def _literal_prefix_dir(glob: str) -> Optional[Path]:
    """Return the literal directory prefix of a glob, or None if depth-flexible.

    Mirrors resolver._check_paths_status's prefix logic. For `trust_api/**`
    returns `~/trust_api`; for `/abs/path/**` returns `/abs/path`; for
    `**/foo.md` returns None (no directory to verify).
    """
    home = config.HOME
    absolute = glob.startswith("/") or glob.startswith("~")
    if glob.startswith("~/"):
        head = glob[2:]
    elif glob.startswith("~"):
        head = glob[1:]
    elif glob.startswith("/"):
        head = glob.lstrip("/")
    else:
        head = glob
    parts: list[str] = []
    for part in head.split("/"):
        if "*" in part or "?" in part or "[" in part:
            break
        if part == "":
            continue
        parts.append(part)
    if not parts:
        return None
    if absolute and glob.startswith("/"):
        return Path("/" + "/".join(parts))
    return home / Path(*parts)


def _glob_first_segment(glob: str) -> Optional[str]:
    """Extract the segment of a glob we'll match against cwd basenames.

    Per the spec: for absolute-style globs (`~/...` or `/...`), use the LAST
    meaningful directory name (the part most likely to be the project folder).
    For relative-style globs, use the FIRST directory name. Returns None if
    the glob is purely wildcard (`*`, `**`, etc.) — nothing to match.
    """
    prefix = _literal_prefix_dir(glob)
    if prefix is None:
        return None
    name = prefix.name
    if not name:
        return None
    return name


def _find_candidates(
    segment: str,
    cwds: list[Path],
) -> list[tuple[Path, str]]:
    """Return [(cwd, level)] candidates for a broken glob segment.

    `level` is "exact" | "prefix" | "suffix". Substring matches require the
    segment to be at least 4 characters of overlap with the candidate basename
    to avoid noise (e.g. "lib" matching every dir).
    """
    out: list[tuple[Path, str]] = []
    seg_lower = segment.lower()
    for cwd in cwds:
        base = cwd.name
        base_lower = base.lower()
        if base_lower == seg_lower:
            out.append((cwd, "exact"))
            continue
        # Prefix / suffix substring match — require ≥4 chars of overlap so
        # short tokens like "lib" don't match every dir on disk.
        if len(seg_lower) < 4 or len(base_lower) < 4:
            continue
        if base_lower.startswith(seg_lower) or seg_lower.startswith(base_lower):
            out.append((cwd, "prefix"))
        elif base_lower.endswith(seg_lower) or seg_lower.endswith(base_lower):
            out.append((cwd, "suffix"))
    return out


def _has_claude_md(cwd: Path) -> bool:
    """Content identity heuristic — `CLAUDE.md` presence boosts confidence to
    high for an exact-basename match (it's a real Claude project, not just an
    empty dir that happens to share the name).
    """
    for candidate in (cwd / "CLAUDE.md", cwd / ".claude" / "CLAUDE.md"):
        try:
            if candidate.is_file():
                return True
        except OSError:
            continue
    return False


def _safe_mtime(p: Path) -> float:
    try:
        return p.stat().st_mtime
    except OSError:
        return 0.0


def _rank_candidates(
    candidates: list[tuple[Path, str]],
) -> list[tuple[Path, str, str]]:
    """Annotate each candidate with its confidence and sort best-first.

    Tie-breakers per spec: most recent `mtime` first, then alphabetical by
    absolute path.
    """
    annotated: list[tuple[Path, str, str]] = []
    for cwd, level in candidates:
        if level == "exact":
            confidence = "high" if _has_claude_md(cwd) else "medium"
        else:
            confidence = "low"
        annotated.append((cwd, level, confidence))

    confidence_rank = {"high": 0, "medium": 1, "low": 2}
    annotated.sort(
        key=lambda t: (
            confidence_rank[t[2]],
            -_safe_mtime(t[0]),
            str(t[0]).lower(),
        )
    )
    return annotated


def _propose_replacement(
    broken_glob: str,
    candidate: Path,
) -> str:
    """Build the replacement glob preserving the original glob's shape.

    `/home/x/old/**` → `/home/x/new/**` (absolute, double-star tail)
    `~/old/**`       → `~/new/**`        (home-relative)
    `old/**`         → `new/**`          (relative)
    `old`            → `new` (which the parser auto-extends to `new/**`)

    The tail (everything after the broken segment's directory) is preserved
    so a glob like `~/old/sub/**` → `~/<candidate>/sub/**` keeps the subpath.
    """
    home = config.HOME
    prefix = _literal_prefix_dir(broken_glob)
    if prefix is None:
        return str(candidate)
    # Compute the wildcard tail — the slice of the glob AFTER the literal
    # prefix dir. e.g. `/old/sub/**` after prefix `/old` → `sub/**`.
    if broken_glob.startswith("~/"):
        glob_no_prefix = "~/" + str(prefix.relative_to(home))
    elif broken_glob.startswith("~"):
        glob_no_prefix = "~" + str(prefix.relative_to(home))
    elif broken_glob.startswith("/"):
        glob_no_prefix = str(prefix)
    else:
        try:
            glob_no_prefix = str(prefix.relative_to(home))
        except ValueError:
            glob_no_prefix = str(prefix)
    if broken_glob.startswith(glob_no_prefix):
        tail = broken_glob[len(glob_no_prefix):]
    else:
        tail = ""

    if broken_glob.startswith("/"):
        return str(candidate) + tail
    if broken_glob.startswith("~/") or broken_glob.startswith("~"):
        try:
            rel = candidate.relative_to(home)
            return "~/" + str(rel) + tail
        except ValueError:
            return str(candidate) + tail
    # Relative: keep the basename (the parser auto-extends bare names to
    # `<name>/**`). If a tail exists, preserve it under the basename.
    if tail:
        return candidate.name + tail
    return candidate.name


def compute_proposals(files: Iterable[FileEntry]) -> list[PathProposal]:
    """Walk `paths_status="missing"` rules and emit proposals for each broken
    glob with a candidate match. Pure over the index — no SSE, no I/O beyond
    cwd discovery + a stat per candidate.
    """
    cwds = scanner.discover_cwds()
    proposals: list[PathProposal] = []

    for f in files:
        if f.kind != "rule":
            continue
        if f.paths_status != "missing":
            continue
        globs = f.paths_globs or []
        if not globs:
            continue

        broken: list[str] = []
        proposed: list[str] = []
        match_bases: list[str] = []
        confidences: list[str] = []

        for glob in globs:
            prefix = _literal_prefix_dir(glob)
            if prefix is None:
                continue  # depth-flexible glob; nothing to verify
            if prefix.exists():
                continue  # this glob isn't broken

            segment = _glob_first_segment(glob)
            if segment is None:
                continue

            candidates = _find_candidates(segment, cwds)
            if not candidates:
                broken.append(glob)
                # No replacement found — frontend can decide whether to flag.
                continue

            ranked = _rank_candidates(candidates)
            best_cwd, best_level, best_confidence = ranked[0]

            replacement = _propose_replacement(glob, best_cwd)
            broken.append(glob)
            proposed.append(replacement)
            basis = (
                f"basename {best_level} match: '{segment}' → "
                f"{config.collapse_home(best_cwd)}"
            )
            if best_confidence == "high":
                basis += " (CLAUDE.md present)"
            match_bases.append(basis)
            confidences.append(best_confidence)

        if not broken:
            continue

        if confidences:
            # Worst confidence wins — a proposal is only as strong as its
            # weakest individual replacement.
            confidence_rank = {"high": 0, "medium": 1, "low": 2}
            overall = max(confidences, key=lambda c: confidence_rank[c])
            basis_str = "; ".join(match_bases)
        else:
            # All broken globs had zero candidates — surface so the user
            # knows we noticed but couldn't help.
            overall = "low"
            basis_str = (
                f"no candidate cwd found for broken segment(s)"
            )

        proposals.append(
            PathProposal(
                rule_path=f.path,
                rule_id=f.id,
                current_globs=list(globs),
                broken_globs=broken,
                proposed_globs=proposed,
                match_basis=basis_str,
                confidence=overall,
            )
        )
    return proposals
