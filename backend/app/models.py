"""Pydantic data shapes — mirrors of the TS interfaces in the frontend."""
from __future__ import annotations

from datetime import datetime
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
    # Shell/Python script invoked by a hook command (e.g. PreToolUse,
    # statusLine). Surfaced as a leaf node so the user can see what code
    # actually runs at session lifecycle events.
    "script",
]

EdgeKind = Literal["import", "mention", "hook"]
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
    # Phase 2 write-pipeline gate: True for kinds Vasya is allowed to edit
    # through Observatory (claude_md / rule / memory / memory_index / settings
    # / mcp / skill); False for Claude-Code-managed or risky kinds (automemory,
    # plugin_registry, plugin_manifest, script). The /api/preview endpoint
    # rejects writes to non-writable entries with 403. Default True so older
    # `.state.json` payloads (and any caller still on the previous schema) keep
    # parsing — `scanner` / `resolver` set the actual value per-kind.
    writable: bool = True


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
    # Hook lifecycle events that trigger this edge — only populated for
    # `kind == "hook"`. e.g. ["PreToolUse", "PostToolUse"], ["statusLine"],
    # ["Stop"]. Multi-event hooks pointing at the same target collapse into
    # one edge with all event names preserved.
    events: list[str] = Field(default_factory=list)


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
    # When false (default), the Map hides Claude-Code-internal nodes that
    # duplicate already-visible state — currently just `installed_plugins.json`,
    # which is a registry whose contents are already represented by the plugin
    # nodes themselves. Toggle in HeaderChrome restores them.
    show_internal: bool = False
    # Sub-mode of the Map view: "graph" = current cola force-layout, "tree" =
    # radial three-zone tree (user-side / project-side / settings-side) showing
    # Claude Code's real load hierarchy. Persisted so the toggle survives reloads.
    map_mode: Literal["graph", "tree"] = "graph"
    # Whether the slide-in Inspector pane is currently open. Mounted on Map +
    # Simulator views; clicking a node auto-opens it, the close button (×)
    # tucks it away. Persisted so the layout survives reloads and the canvas
    # boots in the same width the user left it.
    inspector_open: bool = False


# ---------------------------------------------------------------------------
# Phase 2 write pipeline — preview & write
# ---------------------------------------------------------------------------


class PreviewRequest(BaseModel):
    path: str
    new_content: str


class PreviewResponse(BaseModel):
    confirm_token: str
    diff: str
    base_hash: str
    # True when the path doesn't yet exist on disk (file creation case).
    is_creation: bool = False


class WriteRequest(BaseModel):
    confirm_token: str


class WriteResponse(BaseModel):
    written: bool
    snapshot_id: str


class PendingWrite(BaseModel):
    path: str
    new_content: str
    base_hash: str
    is_creation: bool
    created_at: datetime
