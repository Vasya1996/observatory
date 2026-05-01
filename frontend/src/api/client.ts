import type {
  CwdEntry,
  CwdTreeResponse,
  DisabledFilesResponse,
  ExtensionsResponse,
  FileReadResponse,
  IndexResponse,
  NonCanonicalWithSuppressResponse,
  PathProposalsResponse,
  SimulatorResponse,
  ToggleLoadedFileResponse,
  UiState,
} from "../types";

export async function fetchIndex(): Promise<IndexResponse> {
  const r = await fetch("/api/index");
  if (!r.ok) throw new Error(`/api/index ${r.status}`);
  return r.json();
}

export async function fetchState(): Promise<UiState> {
  const r = await fetch("/api/state");
  if (!r.ok) throw new Error(`/api/state ${r.status}`);
  return r.json();
}

export async function postState(state: UiState): Promise<UiState> {
  const r = await fetch("/api/state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state),
  });
  if (!r.ok) throw new Error(`/api/state POST ${r.status}`);
  return r.json();
}

export async function fetchCwds(): Promise<CwdEntry[]> {
  const r = await fetch("/api/cwds");
  if (!r.ok) throw new Error(`/api/cwds ${r.status}`);
  return r.json();
}

export async function fetchSimulate(cwd: string): Promise<SimulatorResponse> {
  const r = await fetch(`/api/simulate?cwd=${encodeURIComponent(cwd)}`);
  if (!r.ok) throw new Error(`/api/simulate ${r.status}`);
  return r.json();
}

// Lazy filesystem listing for the ExplorerPane "All files" section.
// Pass `path` to drill into a subdirectory; omit it to list the cwd root.
export async function fetchCwdTree(
  cwd: string,
  path?: string,
): Promise<CwdTreeResponse> {
  const qs = `cwd=${encodeURIComponent(cwd)}${
    path ? `&path=${encodeURIComponent(path)}` : ""
  }`;
  const r = await fetch(`/api/cwd-tree?${qs}`);
  if (!r.ok) throw new Error(`/api/cwd-tree ${r.status}`);
  return r.json();
}

export async function fetchExtensions(): Promise<ExtensionsResponse> {
  const r = await fetch("/api/extensions");
  if (!r.ok) throw new Error(`/api/extensions ${r.status}`);
  return r.json();
}

export async function fetchPathProposals(): Promise<PathProposalsResponse> {
  const r = await fetch("/api/paths-proposals");
  if (!r.ok) throw new Error(`/api/paths-proposals ${r.status}`);
  return r.json();
}

export async function fetchNonCanonical(cwd: string): Promise<NonCanonicalWithSuppressResponse> {
  const r = await fetch(`/api/non-canonical?cwd=${encodeURIComponent(cwd)}`);
  if (!r.ok) throw new Error(`/api/non-canonical ${r.status}`);
  return r.json();
}

export async function fetchFile(path: string): Promise<FileReadResponse> {
  const r = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
  if (!r.ok) throw new Error(`/api/file ${r.status}`);
  return r.json();
}

// --- Phase 2 write pipeline ------------------------------------------------

export interface PreviewResponse {
  confirm_token: string;
  diff: string;
  base_hash: string;
  is_creation: boolean;
}

export interface WriteResponse {
  written: boolean;
  snapshot_id: string;
}

// Thrown by postPreview/postWrite when the backend returns a non-2xx. The
// caller (useWritePipeline) inspects `status` to branch on 409/5xx.
export class ApiError extends Error {
  constructor(public status: number, public detail: string) {
    super(detail || `HTTP ${status}`);
  }
}

async function readError(r: Response): Promise<string> {
  try {
    const body = await r.json();
    if (body && typeof body === "object" && "detail" in body) {
      return String((body as { detail: unknown }).detail);
    }
  } catch {
    // fall through
  }
  return `HTTP ${r.status}`;
}

export async function postPreview(
  path: string,
  newContent: string,
): Promise<PreviewResponse> {
  const r = await fetch("/api/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, new_content: newContent }),
  });
  if (!r.ok) throw new ApiError(r.status, await readError(r));
  return r.json();
}

export async function postWrite(confirmToken: string): Promise<WriteResponse> {
  const r = await fetch("/api/write", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirm_token: confirmToken }),
  });
  if (!r.ok) throw new ApiError(r.status, await readError(r));
  return r.json();
}

// --- Delete pipeline -------------------------------------------------------

export interface DeletePreviewResponse {
  confirm_token: string;
  snapshot_id: string;
}

export interface DeleteConfirmResponse {
  deleted: boolean;
  snapshot_id: string;
}

export interface DeleteUndoResponse {
  restored: boolean;
}

export async function postDeletePreview(path: string): Promise<DeletePreviewResponse> {
  const r = await fetch("/api/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!r.ok) throw new ApiError(r.status, await readError(r));
  return r.json();
}

export async function postDeleteConfirm(confirmToken: string): Promise<DeleteConfirmResponse> {
  const r = await fetch("/api/delete-confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirm_token: confirmToken }),
  });
  if (!r.ok) throw new ApiError(r.status, await readError(r));
  return r.json();
}

export async function postDeleteUndo(snapshotId: string, path: string): Promise<DeleteUndoResponse> {
  const r = await fetch("/api/delete-undo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ snapshot_id: snapshotId, path }),
  });
  if (!r.ok) throw new ApiError(r.status, await readError(r));
  return r.json();
}

// --- Normalize / migrate pipeline ------------------------------------------

export interface MigrateFilePlan {
  path: string;
  action: "create" | "modify" | "delete";
  new_content: string | null;
  diff: string;
}

export interface SimDiffResult {
  added: string[];
  removed: string[];
  hash_changed: string[];
  unchanged_count: number;
}

export interface ImportRef {
  file_path: string;
  line_number: number;
  raw_line: string;
}

export interface MigratePlan {
  files_changed: MigrateFilePlan[];
  sim_diff: SimDiffResult | null;
  content_identity: "exact" | "substring" | "fail";
  orphan_importers: ImportRef[];
  heading_collisions: string[];
}

export interface MigratePreviewResponse {
  tokens: string[];
  migration_id: string;
  plan: MigratePlan;
}

export interface MigrateFinalizeResponse {
  finalized?: boolean;
  rolled_back?: number | null;
  partial_rollback?: Record<string, string[]> | null;
}

export async function postMigratePreview(body: {
  source_path: string;
  mode: "rule" | "merge" | "add-paths" | "remove-paths" | "move-to-project";
  target_dir_or_file?: string;
  new_filename?: string;
  delete_original?: boolean;
  paths_globs?: string[];
  target_cwd?: string;
}): Promise<MigratePreviewResponse> {
  const r = await fetch("/api/migrate-preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new ApiError(r.status, await readError(r));
  return r.json();
}

export async function postMigrateFinalize(
  migrationId: string,
  status: "commit" | "rollback",
): Promise<MigrateFinalizeResponse> {
  const r = await fetch("/api/migrate-finalize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ migration_id: migrationId, status }),
  });
  if (!r.ok) throw new ApiError(r.status, await readError(r));
  return r.json();
}

// --- Suppress flag ----------------------------------------------------------

export interface SuppressedResponse {
  suppressed_cwds: string[];
}

export async function postSuppress(cwd: string, suppressed: boolean): Promise<SuppressedResponse> {
  const r = await fetch("/api/suppress", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, suppressed }),
  });
  if (!r.ok) throw new ApiError(r.status, await readError(r));
  return r.json();
}

// --- Tier 2 deep-verify API -------------------------------------------------

export interface Tier2Preflight {
  ok: boolean;
  reason: string;
  disable_all_hooks: boolean;
  allow_managed_only: boolean;
  nfs: boolean;
}

export interface Tier2Status {
  available: boolean;
  installed: boolean;
  reason: string;
  preflight: Tier2Preflight;
  jsonl_path: string;
  hook_script: string;
  events_captured: number;
}

export async function fetchTier2Status(): Promise<Tier2Status> {
  const r = await fetch("/api/tier2-status");
  if (!r.ok) throw new ApiError(r.status, await readError(r));
  return r.json();
}

export async function postTier2InstallPreview(): Promise<PreviewResponse> {
  const r = await fetch("/api/tier2-install-preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!r.ok) throw new ApiError(r.status, await readError(r));
  return r.json();
}

// --- Phase 4: autoload toggle preview (POST /api/autoload-toggle-preview) ---

export interface AutoloadTogglePreviewResponse extends PreviewResponse {
  toggle_applicable: boolean;
  new_enabled: boolean;
  mechanism: string;
  reason?: string;
}

export async function postAutoloadTogglePreview(
  path: string,
  enabled: boolean,
  cwd?: string,
): Promise<AutoloadTogglePreviewResponse> {
  const r = await fetch("/api/autoload-toggle-preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, enabled, ...(cwd !== undefined ? { cwd } : {}) }),
  });
  if (!r.ok) throw new ApiError(r.status, await readError(r));
  return r.json();
}

export async function postTier2UninstallPreview(): Promise<PreviewResponse> {
  const r = await fetch("/api/tier2-uninstall-preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!r.ok) throw new ApiError(r.status, await readError(r));
  return r.json();
}

export interface Tier2CompareResult {
  cwd: string;
  session_id: string | null;
  hook_events_found: number;
  results: Array<{
    file_path: string;
    outcome: "green" | "neutral" | "red";
    memory_type: string | null;
    load_reason: string | null;
    in_simulator: boolean;
    in_hook: boolean;
  }>;
}

export async function fetchTier2Compare(cwd: string, sessionId?: string): Promise<Tier2CompareResult> {
  const url = sessionId
    ? `/api/tier2-compare?cwd=${encodeURIComponent(cwd)}&session_id=${encodeURIComponent(sessionId)}`
    : `/api/tier2-compare?cwd=${encodeURIComponent(cwd)}`;
  const r = await fetch(url);
  if (!r.ok) throw new ApiError(r.status, await readError(r));
  return r.json();
}

// --- Toggle loaded file (per-file ON/OFF in CrossCwdPanel) ------------------

export async function postToggleLoadedFile(
  path: string,
  action: "disable" | "enable",
  cwd: string,
): Promise<ToggleLoadedFileResponse> {
  const r = await fetch("/api/toggle-loaded-file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, action, cwd }),
  });
  if (!r.ok) throw new ApiError(r.status, await readError(r));
  return r.json();
}

export async function fetchDisabledFiles(cwd: string): Promise<DisabledFilesResponse> {
  const r = await fetch(`/api/disabled-files?cwd=${encodeURIComponent(cwd)}`);
  if (!r.ok) throw new ApiError(r.status, await readError(r));
  return r.json();
}

