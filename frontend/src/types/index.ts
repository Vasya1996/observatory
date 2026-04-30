// TS mirrors of pydantic shapes in backend/app/models.py.

export type FileKind =
  | "claude_md"
  | "rule"
  | "memory"
  | "memory_index"
  | "skill"
  | "plugin_manifest"
  | "plugin_registry"
  | "mcp"
  | "settings"
  | "automemory"
  | "script";

export type EdgeKind = "import" | "mention" | "hook";

export type ViewKey = "map" | "sim" | "ed" | "ext";

export type MapMode = "graph" | "tree";

export type SimulatorMode = "per-cwd" | "all-cwds";

export interface Issue {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  line?: number | null;
}

export interface FileEntry {
  id: string;
  path: string;
  display: string;
  kind: FileKind;
  scope?: string | null;
  frontmatter?: Record<string, unknown> | null;
  paths_globs?: string[] | null;
  paths_status: "ok" | "missing" | "n_a";
  readonly: boolean;
  mtime: number;
  size_bytes: number;
  line_count: number;
  validation: Issue[];
  // Plugin name from `.claude-plugin/plugin.json` for plugin_manifest files;
  // null for everything else. UI uses this in place of basename(path).
  display_name?: string | null;
  // Snapshot count for collapsed plugin manifests; 1 for everything else.
  cached_versions?: number;
  // Phase 2 write gate. True for kinds Vasya can edit through Observatory
  // (claude_md / rule / memory / memory_index / settings / mcp / skill);
  // False for read-only kinds (automemory / plugin_registry / plugin_manifest /
  // script). Defaults true so payloads from older backends still parse.
  writable?: boolean;
}

export interface Edge {
  id: string; // `${source}:${target}:${kind}` — one edge per relation, not per ref
  source: string;
  target: string;
  kind: EdgeKind;
  // Source-lines where the relation appears. `lines.length` = number of
  // distinct mention/import call-sites in `source` pointing at `target`.
  lines: number[];
  // Lifecycle event names for kind="hook" only (e.g. ["PreToolUse"]).
  events?: string[];
}

export interface IndexResponse {
  files: FileEntry[];
  edges: Edge[];
}

export interface CwdEntry {
  path: string;   // absolute
  display: string; // ~-collapsed
}

// Mirrors backend `TimelineStatus` (simulator emits these per file). Tree mode
// extends with two derived states the simulator never returns directly:
//   * `orphan`  — file exists on disk but not reachable for the active cwd
//                 (i.e. absent from steps[]).
//   * `unknown` — no cwd is selected yet, so simulator hasn't been queried.
export type TimelineStatus = "loaded" | "conditional" | "skipped";
export type LoadStatus = TimelineStatus | "orphan" | "unknown";

export interface TimelineStep {
  idx: number;
  file_id: string | null;
  file_path: string;
  status: TimelineStatus;
  matched_on?: string | null;
  reason?: string | null;
}

export interface SimulatorStats {
  files_loaded: number;
  est_tokens: number;
  conditional_matches: number;
  on_demand_reachable: number;
}

export interface SimulatorResponse {
  cwd: string;
  steps: TimelineStep[];
  stats: SimulatorStats;
}

export interface UiState {
  pins: Record<string, { x: number; y: number }>;
  last_cwd: string | null;
  last_view: ViewKey | null;
  show_internal?: boolean;
  map_mode?: MapMode;
  inspector_open?: boolean;
  simulator_mode?: SimulatorMode;
  editor_open?: boolean;
}

// --- Non-canonical endpoint -----------------------------------------------

export type NonCanonicalReason =
  | "loaded_via_at_import"
  | "outside_canonical_dir"
  | "wrong_filename_at_canonical_path";

export interface NonCanonicalEntry {
  file_path: string;
  slot: string;
  canonical_path: string;
  reason: NonCanonicalReason;
  importer_path?: string | null;
  importer_line?: number | null;
}

export interface NonCanonicalResponse {
  non_canonical: NonCanonicalEntry[];
}

export interface NonCanonicalWithSuppressResponse {
  non_canonical: NonCanonicalEntry[];
  suppressed: boolean;
  orphan_configs?: OrphanConfigEntry[];
}

// Files that exist on disk but are never loaded by Claude in any cwd.
// Backend emits these as part of /api/non-canonical (same for every cwd query).
export type OrphanConfigReason = "buried_in_config_folder" | "outside_load_chain";

export interface OrphanConfigEntry {
  file_path: string;
  kind: string;
  suggested_canonical_paths: string[];
  reason: OrphanConfigReason;
}

// --- Extensions view (mirrors backend ExtensionsResponse shape) -----------

export interface SkillCard {
  plugin_id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  manifest_path: string;
}

export interface PluginCard {
  plugin_key: string;
  plugin_id: string | null;
  marketplace: string | null;
  enabled: boolean;
  installed: boolean;
}

export interface McpCard {
  name: string;
  config: Record<string, unknown>;
}

export interface ExtensionsResponse {
  skills: SkillCard[];
  plugins: PluginCard[];
  mcp: McpCard[];
}

// --- /api/file ------------------------------------------------------------

export interface FileReadResponse {
  path: string;
  display: string;
  content: string;
  frontmatter: Record<string, unknown> | null;
  validation: Issue[];
}

// --- Paths-rewrite proposals ----------------------------------------------

export type PathProposalConfidence = "high" | "medium" | "low";

export interface PathProposal {
  rule_path: string;
  rule_id: string;
  current_globs: string[];
  broken_globs: string[];
  proposed_globs: string[];
  match_basis: string;
  confidence: PathProposalConfidence;
}

export interface PathProposalsResponse {
  proposals: PathProposal[];
}
