import { useEffect, useMemo, useState } from "react";
import type cytoscape from "cytoscape";
import { GraphCanvas } from "../components/GraphCanvas";
import { IconOverlay } from "../components/IconOverlay";
import { PinOverlay } from "../components/PinOverlay";
import { EdgeInfo } from "../components/EdgeInfo";
import { fetchSimulate } from "../api/client";
import { useStore } from "../state/store";
import { applyInternalFilter } from "../state/visibility";
import type { Edge, LoadStatus } from "../types";

export function MapView() {
  const files = useStore((s) => s.files);
  const edges = useStore((s) => s.edges);
  const showInternal = useStore((s) => s.showInternal);
  const lastCwd = useStore((s) => s.lastCwd);
  const [cy, setCy] = useState<cytoscape.Core | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<Edge | null>(null);
  const [statusMap, setStatusMap] = useState<Map<string, LoadStatus> | null>(null);

  const { files: visibleFiles, edges: visibleEdges } = useMemo(
    () => applyInternalFilter(files, edges, showInternal),
    [files, edges, showInternal],
  );

  // Pull a per-cwd load status whenever the cwd selector changes. Status is
  // derived from `/api/simulate`: each step contributes its TimelineStatus by
  // file_id; files absent from steps[] are tagged "orphan" — they exist on
  // disk but Claude wouldn't reach them in the active cwd. When no cwd is
  // selected, the map is null and the graph renders kind-only colors as before.
  useEffect(() => {
    if (!lastCwd) {
      setStatusMap(null);
      return;
    }
    let cancelled = false;
    fetchSimulate(lastCwd)
      .then((res) => {
        if (cancelled) return;
        const map = new Map<string, LoadStatus>();
        for (const step of res.steps) {
          if (step.file_id) map.set(step.file_id, step.status);
        }
        for (const f of files) {
          if (!map.has(f.id)) map.set(f.id, "orphan");
        }
        setStatusMap(map);
      })
      .catch((e) => {
        console.warn("[observatory] /api/simulate failed", e);
        if (!cancelled) setStatusMap(null);
      });
    return () => {
      cancelled = true;
    };
  }, [lastCwd, files]);

  return (
    <div className="view-shell">
      <GraphCanvas
        files={visibleFiles}
        edges={visibleEdges}
        onReady={setCy}
        onHoverEdge={setHoveredEdge}
        statusMap={statusMap}
      />
      <IconOverlay cy={cy} />
      <PinOverlay cy={cy} />
      <EdgeInfo edge={hoveredEdge} files={visibleFiles} />
    </div>
  );
}
