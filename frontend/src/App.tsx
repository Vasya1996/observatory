import { useEffect, useState } from "react";
import { fetchIndex, fetchState } from "./api/client";
import { HeaderChrome } from "./components/HeaderChrome";
import { useStore } from "./state/store";
import { MapView } from "./views/MapView";
import { SimulatorView } from "./views/SimulatorView";
import { EditorView } from "./views/EditorView";
import { ExtensionsView } from "./views/ExtensionsView";

export default function App() {
  const setIndex = useStore((s) => s.setIndex);
  const hydrate = useStore((s) => s.hydrate);
  const view = useStore((s) => s.view);
  const files = useStore((s) => s.files);
  const edges = useStore((s) => s.edges);

  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([fetchIndex(), fetchState()])
      .then(([idx, st]) => {
        setIndex(idx.files, idx.edges);
        hydrate(st);
        setLoading(false);
      })
      .catch((e) => {
        setError(String(e));
        setLoading(false);
      });
  }, [setIndex, hydrate]);

  if (loading) return <div className="center-overlay">Loading…</div>;
  if (error) return <div className="center-overlay">Error: {error}</div>;
  if (files.length === 0)
    return <div className="center-overlay">No files indexed (check backend logs).</div>;

  return (
    <>
      <HeaderChrome
        fileCount={files.length}
        edgeCount={edges.length}
        watcherLive
      />
      {view === "map" && <MapView />}
      {view === "sim" && <SimulatorView />}
      {view === "ed" && <EditorView />}
      {view === "ext" && <ExtensionsView />}
    </>
  );
}
