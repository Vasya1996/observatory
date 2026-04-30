import type {
  CwdEntry,
  ExtensionsResponse,
  FileReadResponse,
  IndexResponse,
  NonCanonicalResponse,
  PathProposalsResponse,
  SimulatorResponse,
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

export async function fetchNonCanonical(cwd: string): Promise<NonCanonicalResponse> {
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
