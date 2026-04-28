import { useState } from "react";
import type cytoscape from "cytoscape";
import { GraphCanvas } from "../components/GraphCanvas";
import { PinOverlay } from "../components/PinOverlay";
import { useStore } from "../state/store";

export function MapView() {
  const files = useStore((s) => s.files);
  const edges = useStore((s) => s.edges);
  const [cy, setCy] = useState<cytoscape.Core | null>(null);
  return (
    <div className="view-shell">
      <GraphCanvas files={files} edges={edges} onReady={setCy} />
      <PinOverlay cy={cy} />
    </div>
  );
}
