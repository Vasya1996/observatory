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
}

export interface Edge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  line?: number | null;
}

export interface IndexResponse {
  files: FileEntry[];
  edges: Edge[];
}
