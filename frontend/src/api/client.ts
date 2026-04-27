import type { IndexResponse } from "../types";

export async function fetchIndex(): Promise<IndexResponse> {
  const r = await fetch("/api/index");
  if (!r.ok) throw new Error(`/api/index ${r.status}`);
  return r.json();
}
