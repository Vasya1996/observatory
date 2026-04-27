import { GraphCanvas } from "../components/GraphCanvas";
import { useStore } from "../state/store";

export function MapView() {
  const files = useStore((s) => s.files);
  const edges = useStore((s) => s.edges);
  return (
    <div className="view-shell">
      <GraphCanvas files={files} edges={edges} />
    </div>
  );
}
