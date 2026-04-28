import { useMemo, useState } from "react";
import type cytoscape from "cytoscape";
import { GraphCanvas } from "../components/GraphCanvas";
import { IconOverlay } from "../components/IconOverlay";
import { PinOverlay } from "../components/PinOverlay";
import { EdgeInfo } from "../components/EdgeInfo";
import { useStore } from "../state/store";
import { applyInternalFilter } from "../state/visibility";
import type { Edge } from "../types";

export function MapView() {
  const files = useStore((s) => s.files);
  const edges = useStore((s) => s.edges);
  const showInternal = useStore((s) => s.showInternal);
  const [cy, setCy] = useState<cytoscape.Core | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<Edge | null>(null);

  const { files: visibleFiles, edges: visibleEdges } = useMemo(
    () => applyInternalFilter(files, edges, showInternal),
    [files, edges, showInternal],
  );

  return (
    <div className="view-shell">
      <GraphCanvas
        files={visibleFiles}
        edges={visibleEdges}
        onReady={setCy}
        onHoverEdge={setHoveredEdge}
      />
      <IconOverlay cy={cy} />
      <PinOverlay cy={cy} />
      <EdgeInfo edge={hoveredEdge} files={visibleFiles} />
    </div>
  );
}
