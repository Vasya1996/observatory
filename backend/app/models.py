"""Pydantic data shapes — mirrors of the TS interfaces in the frontend."""
from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

FileKind = Literal[
    "claude_md",
    "rule",
    "memory",
    "memory_index",
    "skill",
    "plugin_manifest",
    "plugin_registry",
    "mcp",
    "settings",
    "automemory",
]

EdgeKind = Literal["import", "mention"]
PathsStatus = Literal["ok", "missing", "n_a"]
IssueSeverity = Literal["info", "warning", "error"]
TimelineStatus = Literal["loaded", "conditional", "skipped"]


class Issue(BaseModel):
    severity: IssueSeverity
    code: str
    message: str
    line: Optional[int] = None


class FileEntry(BaseModel):
    id: str  # sha1(absolute_path)
    path: str  # absolute, ~-collapsed for display via `display`
    display: str  # ~-collapsed
    kind: FileKind
    scope: Optional[str] = None
    frontmatter: Optional[dict[str, Any]] = None
    paths_globs: Optional[list[str]] = None
    paths_status: PathsStatus = "n_a"
    readonly: bool = False
    mtime: float
    size_bytes: int
    line_count: int
    validation: list[Issue] = Field(default_factory=list)
    # Plugin manifests get the plugin's real name (from `.claude-plugin/plugin.json`)
    # so the graph doesn't show 24+ identical "manifest.json" labels. None for
    # files whose basename is already informative.
    display_name: Optional[str] = None
    # Number of cached snapshots represented by this single graph node.
    # >1 only for `~/.claude/remote/plugins/<hash>/manifest.json` collapsed
    # by plugin name; 1 elsewhere. Inspector can surface as "26 cached versions".
    cached_versions: int = 1


class Edge(BaseModel):
    id: str  # f"{source}:{target}:{kind}" — one edge per (src, tgt, kind) tuple
    source: str  # file_id
    target: str  # file_id
    kind: EdgeKind
    # Each source-line where the reference appears. Multiple mentions of the
    # same target collapse into one edge with all line numbers preserved here,
    # so the inspector can list "MEMORY references user.md from lines 3, 47, 112"
    # while the graph stays one-line-per-relation.
    lines: list[int] = Field(default_factory=list)


class IndexResponse(BaseModel):
    files: list[FileEntry]
    edges: list[Edge]


class CwdEntry(BaseModel):
    path: str  # absolute
    display: str  # ~-collapsed


class TimelineStep(BaseModel):
    idx: int
    file_id: Optional[str]
    file_path: str
    status: TimelineStatus
    matched_on: Optional[str] = None
    reason: Optional[str] = None


class SimulatorStats(BaseModel):
    files_loaded: int
    est_tokens: int
    conditional_matches: int
    on_demand_reachable: int


class SimulatorResponse(BaseModel):
    cwd: str
    steps: list[TimelineStep]
    stats: SimulatorStats


class FileReadResponse(BaseModel):
    path: str
    display: str
    content: str
    frontmatter: Optional[dict[str, Any]] = None
    validation: list[Issue] = Field(default_factory=list)


class SkillCard(BaseModel):
    plugin_id: str
    name: str
    description: Optional[str] = None
    enabled: bool
    manifest_path: str


class PluginCard(BaseModel):
    plugin_key: str  # "id@marketplace"
    plugin_id: Optional[str] = None
    marketplace: Optional[str] = None
    enabled: bool
    installed: bool


class McpCard(BaseModel):
    name: str
    config: dict[str, Any]


class ExtensionsResponse(BaseModel):
    skills: list[SkillCard]
    plugins: list[PluginCard]
    mcp: list[McpCard]


class UiState(BaseModel):
    pins: dict[str, dict[str, float]] = Field(default_factory=dict)  # {file_id: {x, y}}
    last_cwd: Optional[str] = None
    last_view: Optional[str] = None
