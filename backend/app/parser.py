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


_FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*\n?", re.DOTALL)
_IMPORT_RE = re.compile(r"(?<![A-Za-z0-9_])@(/[^\s)`]+|~/[^\s)`]+|\.{1,2}/[^\s)`]+)")
_FENCE_RE = re.compile(r"^\s*```")


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
    self_basename: str,
    skip_mentions: bool,
) -> list[ParsedRef]:
    refs: list[ParsedRef] = []
    in_fence = False
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
    return refs


def parse_markdown(
    path: Path,
    kind: FileKind,
    readonly: bool,
    in_scope_basenames: set[str],
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

    refs = _parse_imports_and_mentions(
        body=body,
        body_start_line=body_start_line,
        in_scope_basenames=in_scope_basenames,
        self_basename=path.name,
        # Auto-memory zone: render but don't extract outbound refs from it.
        skip_mentions=readonly or kind == "automemory",
    )
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


def parse_json_only_metadata(path: Path, kind: FileKind, readonly: bool) -> ParsedFile:
    """JSON files: no parsing of contents into refs, just metadata."""
    text = ""
    line_count = 0
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
        line_count = text.count("\n") + (0 if text.endswith("\n") else 1) if text else 0
    except OSError:
        pass
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
    )
