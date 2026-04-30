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
    # Phase 3 enrichment: True when the file lives at its canonical slot path.
    # Yellow border in SimulatorView when False. Non-breaking — old clients
    # that don't know this field ignore it.
    is_canonical: bool = True


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
    # Sub-mode of the Simulator view: "per-cwd" = 6-column ribbon for the
    # active cwd (default), "all-cwds" = 12×6 overview table. Persisted so
    # the chosen sub-tab survives reloads.
    simulator_mode: Literal["per-cwd", "all-cwds"] = "per-cwd"
    # Whether the Editor side panel is currently open. Mirrors inspector_open
    # semantics: persisted so the panel state survives reloads.
    editor_open: bool = False


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
    # Optional: when this write is part of a migration batch, the caller
    # passes the migration_id so the handler can track which snapshots belong
    # to this batch for best-effort rollback on later failures.
    migration_id: Optional[str] = None


class WriteResponse(BaseModel):
    written: bool
    snapshot_id: str


class PendingWrite(BaseModel):
    path: str
    new_content: str
    base_hash: str
    is_creation: bool
    created_at: datetime


# ---------------------------------------------------------------------------
# Phase 2 paths auto-rewrite proposals
# ---------------------------------------------------------------------------


PathProposalConfidence = Literal["high", "medium", "low"]


class PathProposal(BaseModel):
    """A proposed rewrite for a rule whose `paths:` glob(s) became broken
    (target dir no longer exists). Surfaced by `/api/paths-proposals` —
    the actual write still flows through the `/api/preview` → `/api/write`
    diff-modal pipeline (locked rule #36 — never silent).
    """
    rule_path: str
    rule_id: str
    current_globs: list[str]
    broken_globs: list[str]
    # Replacements aligned 1:1 with `broken_globs`. May be empty when no
    # candidate cwd matched any broken segment — the entry is still surfaced
    # so the user knows we noticed.
    proposed_globs: list[str]
    match_basis: str
    confidence: PathProposalConfidence


class PathProposalsResponse(BaseModel):
    proposals: list[PathProposal]


# ---------------------------------------------------------------------------
# Phase 3 Tier 1 verification primitives
# ---------------------------------------------------------------------------


class SimDiffResult(BaseModel):
    """Per-cwd result of comparing two simulator snapshots."""
    added: list[str] = Field(default_factory=list)        # paths new in after
    removed: list[str] = Field(default_factory=list)      # paths gone in after
    hash_changed: list[str] = Field(default_factory=list) # same path, different hash
    unchanged_count: int = 0


class ImportRef(BaseModel):
    """A single @-import reference found in a source file."""
    file_path: str
    line_number: int
    raw_line: str


class NonCanonicalEntry(BaseModel):
    """A file loaded by the simulator that doesn't live at its canonical slot path."""
    file_path: str
    slot: str   # e.g. "user-global", "ancestor-walk", "project", "on-demand"
    canonical_path: str    # what the canonical path for that slot would be
    reason: Literal[
        "loaded_via_at_import",
        "outside_canonical_dir",
        "wrong_filename_at_canonical_path",
    ]
    importer_path: Optional[str] = None  # set when reason == loaded_via_at_import
    importer_line: Optional[int] = None


class NonCanonicalResponse(BaseModel):
    non_canonical: list[NonCanonicalEntry]


class MergePlan(BaseModel):
    """Result of plan_merge() — a planned content merge into a target file."""
    merged_body: str
    heading_collisions: list[str] = Field(default_factory=list)
    unified_diff: str


class MigrateFilePlan(BaseModel):
    path: str
    action: Literal["create", "modify", "delete"]
    new_content: Optional[str] = None
    # unified diff of this single file; empty for pure deletions
    diff: str = ""


class MigratePreviewRequest(BaseModel):
    source_path: str
    mode: Literal["rule", "merge", "add-paths", "remove-paths", "move-to-project"]
    # For rule mode: directory to create the new rule in (default ~/.claude/rules/)
    target_dir_or_file: Optional[str] = None
    # Filename for the new rule file (rule mode only)
    new_filename: Optional[str] = None
    delete_original: bool = False
    # add-paths mode: glob patterns to add to (or merge with) existing paths: field
    paths_globs: Optional[list[str]] = None
    # move-to-project mode: project cwd to move the rule into
    target_cwd: Optional[str] = None


class MigratePreviewResponse(BaseModel):
    tokens: list[str]          # one confirm_token per affected file (same shape as /api/preview)
    migration_id: str          # batch id used for rollback tracking
    plan: "MigratePlan"


class MigratePlan(BaseModel):
    files_changed: list[MigrateFilePlan]
    sim_diff: Optional[SimDiffResult] = None
    content_identity: Literal["exact", "substring", "fail"]
    orphan_importers: list[ImportRef] = Field(default_factory=list)
    heading_collisions: list[str] = Field(default_factory=list)


# Needed for forward-reference resolution.
MigratePreviewResponse.model_rebuild()


# ---------------------------------------------------------------------------
# Phase 3 wave 2 — migration finalize + delete pipeline
# ---------------------------------------------------------------------------


class MigrateFinalizeRequest(BaseModel):
    migration_id: str
    status: Literal["commit", "rollback"]


class CommittedFile(BaseModel):
    """A single file committed during a migration, with its pre-write snapshot.

    Returned in MigrateFinalizeResponse.committed_files so the frontend can
    offer a post-commit undo button via POST /api/restore-from-snapshot.
    """
    path: str
    snapshot_id: str


class MigrateFinalizeResponse(BaseModel):
    finalized: bool = False
    rolled_back: Optional[int] = None
    # Set on partial rollback failure: which paths restored vs failed.
    partial_rollback: Optional[dict[str, list[str]]] = None
    # Populated on commit: the pre-write snapshots for each file in the batch.
    # The frontend stores these and exposes an "Undo (≤7 days)" button.
    # Empty list when status == "rollback".
    committed_files: list[CommittedFile] = Field(default_factory=list)


class RestoreFromSnapshotRequest(BaseModel):
    path: str
    snapshot_id: str


class RestoreFromSnapshotResponse(BaseModel):
    restored: bool
    # The snapshot taken of the current (pre-restore) state, so the user can
    # undo the undo if needed.
    new_snapshot_id: str


class DeletePreviewRequest(BaseModel):
    path: str


class DeletePreviewResponse(BaseModel):
    confirm_token: str
    snapshot_id: str


class DeleteConfirmRequest(BaseModel):
    confirm_token: str


class DeleteConfirmResponse(BaseModel):
    deleted: bool
    snapshot_id: str


class DeleteUndoRequest(BaseModel):
    snapshot_id: str
    # Original path needed to know where to restore the snapshot.
    path: str


class DeleteUndoResponse(BaseModel):
    restored: bool


# ---------------------------------------------------------------------------
# Phase 3 — suppress flag (user-marked "intentionally non-canonical" cwds)
# Deliverable #36 in the locked 37-item list.
# ---------------------------------------------------------------------------


class SuppressedResponse(BaseModel):
    suppressed_cwds: list[str]


class SuppressRequest(BaseModel):
    cwd: str
    suppressed: bool


class OrphanConfigEntry(BaseModel):
    """A claude_md or rule file that exists on disk but is never loaded by Claude
    in any discovered cwd — not on the ancestor-walk spine, not in a project zone,
    not in ~/.claude/.

    Surfaces the "buried config" trap: the user named a folder 'global' or
    'shared', placed a CLAUDE.md inside, and assumed it applied everywhere, but
    Claude Code never auto-loads it unless the session cwd happens to be inside
    that folder.
    """
    file_path: str
    kind: Literal["claude_md", "rule"]
    suggested_canonical_paths: list[str]
    reason: Literal["outside_load_chain", "buried_in_config_folder"]


class NonCanonicalWithSuppressResponse(BaseModel):
    non_canonical: list[NonCanonicalEntry]
    # Orphan configs are independent of the active cwd; same list in every
    # response. Computed once per request inside /api/non-canonical.
    orphan_configs: list[OrphanConfigEntry] = Field(default_factory=list)
    suppressed: bool
