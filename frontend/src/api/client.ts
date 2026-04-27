import type { IndexResponse, UiState } from "../types";

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
