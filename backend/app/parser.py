"""Parse a single file: frontmatter, @-imports, literal *.md mentions.

Markdown files are the only ones we look inside. JSON files are surfaced as
nodes by the scanner but contain no graph references.

Mention matching (decided 2026-04-27): match any literal `<basename>.md`
appearance in the body, EXCEPT inside fenced code blocks (``` … ```). This
catches both `[label](file.md)` markdown links and bare prose mentions like
"see user.md" without false positives from code samples.
"""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import yaml

from .models import FileKind, Issue


def file_id(path: Path) -> str:
    return hashlib.sha1(str(path).encode("utf-8")).hexdigest()


@dataclass
class ParsedRef:
    kind: str  # "import" | "mention"
    raw_target: str  # path text (for import) or basename (for mention)
    line: int


@dataclass
class ParsedFile:
    raw_path: Path
    kind: FileKind
    readonly: bool
    frontmatter: Optional[dict[str, Any]]
    paths_globs: Optional[list[str]]  # raw, unnormalized
    body: str
    line_count: int
    refs: list[ParsedRef]
    issues: list[Issue] = field(default_factory=list)
    raw_description_token: Optional[str] = None  # for SKILL.md folded-scalar check
    # Human-readable label sourced from the file's own metadata, NOT its
    # filesystem basename. For plugin manifests under
    # `~/.claude/remote/plugins/<hash>/manifest.json`, the basename is the
    # opaque string "manifest.json" — Claude itself identifies these by the
    # plugin name from `.claude-plugin/plugin.json` (e.g. "anthropic-skills",
    # "design"). When set, the graph and inspector show this instead of the
    # basename. None = fall back to basename.
    display_name: Optional[str] = None
    # Snapshot count for collapsed plugin manifests; 1 for everything else.
    cached_versions: int = 1


_FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*\n?", re.DOTALL)
_IMPORT_RE = re.compile(r"(?<![A-Za-z0-9_])@(/[^\s)`]+|~/[^\s)`]+|\.{1,2}/[^\s)`]+)")
_FENCE_RE = re.compile(r"^\s*```")
# Path-shaped mentions: `~/foo/bar.md` or `/abs/path/bar.md`. Lookbehind
# blocks alphanumerics/`/`/`.` before the token so we don't catch URLs
# (`https://x.com/foo.md`) or relative-path references (`./foo.md`,
# `../bar.md`). Non-greedy `+?` stops at the first `.md` so multiple
# mentions on one line each match independently.
_PATH_MENTION_RE = re.compile(
    r"(?<![A-Za-z0-9_/.])(~/[^\s)`'\"<>]+?\.md|/[^\s)`'\"<>]+?\.md)"
)


def _split_frontmatter(text: str) -> tuple[Optional[str], str, int]:
    """Return (frontmatter_text, body, body_start_line_1based)."""
    m = _FRONTMATTER_RE.match(text)
    if not m:
        return None, text, 1
    fm_text = m.group(1)
    body = text[m.end():]
    body_start_line = text[: m.end()].count("\n") + 1
    return fm_text, body, body_start_line


def _detect_folded_description(fm_text: str) -> bool:
    """Detect SKILL.md `description: >` or `description: |` (folded scalar).

    Paperclip's parser breaks on folded-scalar `description` — see
    paperclip_skill_frontmatter_bug.md. Quoted single-line strings only.
    """
    for line in fm_text.splitlines():
        stripped = line.lstrip()
        if stripped.startswith("description:"):
            value = stripped.split(":", 1)[1].strip()
            if value.startswith(">") or value.startswith("|"):
                return True
    return False


def _normalize_paths_field(value: Any) -> list[str]:
    """Accept any reasonable shape and return a list of glob strings.

    Designed to work for new users who don't know YAML — accept:
      paths: trust_api
      paths: trust_api, Traction-Eye
      paths: ["trust_api/**", "Traction-Eye/**"]
      paths:
        - trust_api
        - Traction-Eye

    Bare folder names without `/` or `*` are auto-extended to `<name>/**` so the
    intuitive "rule for this repo" convention works without globbing knowledge.
    """
    if value is None:
        return []
    items: list[str]
    if isinstance(value, list):
        items = [str(x).strip() for x in value if str(x).strip()]
    elif isinstance(value, str):
        if "," in value:
            items = [s.strip() for s in value.split(",") if s.strip()]
        else:
            items = [s.strip() for s in value.split() if s.strip()] or [value.strip()]
    else:
        items = [str(value).strip()]

    normalized: list[str] = []
    for item in items:
        if "/" not in item and "*" not in item:
            normalized.append(f"{item}/**")
        else:
            normalized.append(item)
    return normalized


def _parse_imports_and_mentions(
    body: str,
    body_start_line: int,
    in_scope_basenames: set[str],
    in_scope_paths: set[str],
    self_basename: str,
    self_path: str,
    skip_mentions: bool,
) -> tuple[list[ParsedRef], list[Issue]]:
    refs: list[ParsedRef] = []
    issues: list[Issue] = []
    seen_unresolved: set[tuple[int, str]] = set()
    in_fence = False
    home = Path.home()
    for offset, line in enumerate(body.splitlines()):
        line_num = body_start_line + offset
        if _FENCE_RE.match(line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        # @-imports
        for m in _IMPORT_RE.finditer(line):
            refs.append(ParsedRef(kind="import", raw_target=m.group(1), line=line_num))
        if skip_mentions:
            continue
        # mention: any in-scope basename appearing in the line, with word
        # boundaries on both sides. Skip self-references.
        for basename in in_scope_basenames:
            if basename == self_basename:
                continue
            # word-boundary match — ensure no alphanumeric prefix; the .md
            # suffix already creates a natural right boundary.
            for m in re.finditer(
                r"(?<![A-Za-z0-9_./-])" + re.escape(basename) + r"(?![A-Za-z0-9_])",
                line,
            ):
                refs.append(
                    ParsedRef(kind="mention", raw_target=basename, line=line_num)
                )
        # Path-shaped mention: `~/foo/bar.md` or `/abs/path/bar.md`. Resolves
        # to a canonical absolute path; only emitted when that path is in the
        # scanned set. Path tokens are unique (no basename ambiguity), so the
        # resolver can look up directly via the path map.
        #
        # Unresolved path-mentions (token doesn't resolve to any scanned file)
        # surface as `mention_unresolved` info-issues — Mission section says
        # silent omissions are the enemy. We classify by whether the file
        # exists on disk (outside scan scope) or is missing entirely so the
        # inspector can show a useful hint.
        for m in _PATH_MENTION_RE.finditer(line):
            raw = m.group(1)
            try:
                if raw.startswith("~/"):
                    canonical = str((home / raw[2:]).resolve())
                else:
                    canonical = str(Path(raw).resolve())
            except OSError:
                continue
            if canonical == self_path:
                continue
            if canonical in in_scope_paths:
                refs.append(
                    ParsedRef(kind="mention", raw_target=canonical, line=line_num)
                )
                continue
            key = (line_num, raw)
            if key in seen_unresolved:
                continue
            seen_unresolved.add(key)
            try:
                exists_on_disk = Path(canonical).is_file()
            except OSError:
                exists_on_disk = False
            if exists_on_disk:
                issues.append(
                    Issue(
                        severity="info",
                        code="mention_path_outside_scope",
                        message=(
                            f"Mention `{raw}` points to a real file, but it's "
                            f"outside the Observatory scan scope, so no graph "
                            f"edge is drawn."
                        ),
                        line=line_num,
                    )
                )
            else:
                issues.append(
                    Issue(
                        severity="info",
                        code="mention_path_missing",
                        message=(
                            f"Mention `{raw}` does not resolve — no such file "
                            f"on disk. Likely a stale or renamed reference."
                        ),
                        line=line_num,
                    )
                )
    return refs, issues


def parse_markdown(
    path: Path,
    kind: FileKind,
    readonly: bool,
    in_scope_basenames: set[str],
    in_scope_paths: set[str],
) -> ParsedFile:
    text = path.read_text(encoding="utf-8", errors="replace")
    line_count = text.count("\n") + (0 if text.endswith("\n") else 1) if text else 0

    fm_text, body, body_start_line = _split_frontmatter(text)
    frontmatter: Optional[dict[str, Any]] = None
    issues: list[Issue] = []
    paths_globs: Optional[list[str]] = None

    if fm_text is not None:
        try:
            loaded = yaml.safe_load(fm_text)
            if isinstance(loaded, dict):
                frontmatter = loaded
            elif loaded is not None:
                issues.append(
                    Issue(
                        severity="warning",
                        code="frontmatter_not_mapping",
                        message="Frontmatter is not a YAML mapping.",
                        line=1,
                    )
                )
        except yaml.YAMLError as e:
            issues.append(
                Issue(
                    severity="error",
                    code="frontmatter_yaml_error",
                    message=f"YAML parse error: {e}",
                    line=1,
                )
            )

        if kind == "skill" and _detect_folded_description(fm_text):
            issues.append(
                Issue(
                    severity="warning",
                    code="skill_description_folded",
                    message="SKILL.md `description` must be a quoted single-line "
                    "string, not a folded scalar (>/|). Paperclip parser breaks.",
                )
            )

        if frontmatter and "paths" in frontmatter:
            paths_globs = _normalize_paths_field(frontmatter.get("paths"))
            raw = frontmatter.get("paths")
            if isinstance(raw, str) and "," in raw:
                issues.append(
                    Issue(
                        severity="info",
                        code="paths_csv_format",
                        message="`paths:` uses comma-separated string. "
                        "Recommended: YAML list `paths: [\"a/**\", \"b/**\"]`.",
                    )
                )

    # Memory-file frontmatter validation (only for memory files, not the index).
    if kind == "memory":
        for required in ("name", "description", "type"):
            if not frontmatter or required not in frontmatter:
                issues.append(
                    Issue(
                        severity="warning",
                        code=f"memory_missing_{required}",
                        message=f"Memory file missing required frontmatter field: {required}.",
                    )
                )

    refs, ref_issues = _parse_imports_and_mentions(
        body=body,
        body_start_line=body_start_line,
        in_scope_basenames=in_scope_basenames,
        in_scope_paths=in_scope_paths,
        self_basename=path.name,
        self_path=str(path),
        # Auto-memory zone: render but don't extract outbound refs from it.
        skip_mentions=readonly or kind == "automemory",
    )
    issues.extend(ref_issues)
    if readonly or kind == "automemory":
        # Strip imports too — auto-memory is a leaf.
        refs = []

    return ParsedFile(
        raw_path=path,
        kind=kind,
        readonly=readonly,
        frontmatter=frontmatter,
        paths_globs=paths_globs,
        body=body,
        line_count=line_count,
        refs=refs,
        issues=issues,
    )


def _plugin_display_name(manifest_path: Path) -> Optional[str]:
    """Resolve the human-readable plugin name. Two file shapes both classified
    as `plugin_manifest`:

    * `~/.claude/remote/plugins/<hash>/manifest.json` — opaque basename, real
      identity in sibling `.claude-plugin/plugin.json`.
    * `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/.claude-plugin/plugin.json`
      — the file IS the identity; read it directly.

    Returns None if no readable identity file exists.
    """
    if manifest_path.name == "plugin.json":
        target = manifest_path
    else:
        target = manifest_path.parent / ".claude-plugin" / "plugin.json"
    if not target.is_file():
        return None
    try:
        import json
        with target.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    name = data.get("name") if isinstance(data, dict) else None
    return name if isinstance(name, str) and name else None


def parse_json_only_metadata(path: Path, kind: FileKind, readonly: bool) -> ParsedFile:
    """JSON files: no parsing of contents into refs, just metadata."""
    text = ""
    line_count = 0
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
        line_count = text.count("\n") + (0 if text.endswith("\n") else 1) if text else 0
    except OSError:
        pass
    display_name = _plugin_display_name(path) if kind == "plugin_manifest" else None
    return ParsedFile(
        raw_path=path,
        kind=kind,
        readonly=readonly,
        frontmatter=None,
        paths_globs=None,
        body="",
        line_count=line_count,
        refs=[],
        issues=[],
        display_name=display_name,
    )
