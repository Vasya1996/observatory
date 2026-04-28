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
  | "automemory";

export type EdgeKind = "import" | "mention";

export type ViewKey = "map" | "sim" | "ed" | "ext";

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
}

export interface Edge {
  id: string; // `${source}:${target}:${kind}` — one edge per relation, not per ref
  source: string;
  target: string;
  kind: EdgeKind;
  // Source-lines where the relation appears. `lines.length` = number of
  // distinct mention/import call-sites in `source` pointing at `target`.
  lines: number[];
}

export interface IndexResponse {
  files: FileEntry[];
  edges: Edge[];
}

export interface UiState {
  pins: Record<string, { x: number; y: number }>;
  last_cwd: string | null;
  last_view: ViewKey | null;
  show_internal?: boolean;
}
