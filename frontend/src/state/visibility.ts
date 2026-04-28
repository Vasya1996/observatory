// Single source of truth for "what's visible on the Map vs hidden as
// Claude-Code-internal duplication". Used by both MapView (to filter the
// graph) and App.tsx (to update the count pill so what the user reads
// matches what's drawn).

import type { Edge, FileEntry, FileKind } from "../types";

const INTERNAL_KINDS: ReadonlySet<FileKind> = new Set<FileKind>([
  "plugin_registry",
]);

export function applyInternalFilter(
  files: FileEntry[],
  edges: Edge[],
  showInternal: boolean,
): { files: FileEntry[]; edges: Edge[] } {
  if (showInternal) return { files, edges };
  const hiddenIds = new Set<string>();
  const keptFiles: FileEntry[] = [];
  for (const f of files) {
    if (INTERNAL_KINDS.has(f.kind)) hiddenIds.add(f.id);
    else keptFiles.push(f);
  }
  const keptEdges = edges.filter(
    (e) => !hiddenIds.has(e.source) && !hiddenIds.has(e.target),
  );
  return { files: keptFiles, edges: keptEdges };
}
