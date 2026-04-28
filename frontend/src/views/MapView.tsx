import { useState } from "react";
import type cytoscape from "cytoscape";
import { GraphCanvas } from "../components/GraphCanvas";
import { IconOverlay } from "../components/IconOverlay";
import { PinOverlay } from "../components/PinOverlay";
import { EdgeInfo } from "../components/EdgeInfo";
import { useStore } from "../state/store";
import type { Edge } from "../types";

export function MapView() {
  const files = useStore((s) => s.files);
  const edges = useStore((s) => s.edges);
  const [cy, setCy] = useState<cytoscape.Core | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<Edge | null>(null);
  return (
    <div className="view-shell">
      <GraphCanvas
        files={files}
        edges={edges}
        onReady={setCy}
        onHoverEdge={setHoveredEdge}
      />
      <IconOverlay cy={cy} />
      <PinOverlay cy={cy} />
      <EdgeInfo edge={hoveredEdge} files={files} />
    </div>
  );
}
