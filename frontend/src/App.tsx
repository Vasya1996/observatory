import { useEffect, useMemo, useState } from "react";
import { fetchIndex, fetchState } from "./api/client";
import { DiffModal } from "./components/DiffModal";
import { HeaderChrome } from "./components/HeaderChrome";
import { PreviewChip } from "./components/PreviewChip";
import { Toast } from "./components/Toast";
import { useStore } from "./state/store";
import { applyInternalFilter } from "./state/visibility";
import { MapView } from "./views/MapView";
import { EditorView } from "./views/EditorView";
import { ExtensionsView } from "./views/ExtensionsView";

export default function App() {
  const setIndex = useStore((s) => s.setIndex);
  const hydrate = useStore((s) => s.hydrate);
  const dataVersion = useStore((s) => s.dataVersion);
  const view = useStore((s) => s.view);
  const files = useStore((s) => s.files);
  const edges = useStore((s) => s.edges);
  const showInternal = useStore((s) => s.showInternal);

  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Initial load: fetch both index and persisted UI state together.
  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchIndex(), fetchState()])
      .then(([idx, st]) => {
        if (cancelled) return;
        setIndex(idx.files, idx.edges);
        hydrate(st);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
        setLoading(false);
      });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fetch index after any successful write (dataVersion bump) so file paths,
  // writable flags, and display names reflect the new on-disk state.
  useEffect(() => {
    if (dataVersion === 0) return;
    let cancelled = false;
    fetchIndex()
      .then((idx) => {
        if (cancelled) return;
        setIndex(idx.files, idx.edges);
      })
      .catch((e) => console.warn("[observatory] /api/index refetch failed", e));
    return () => { cancelled = true; };
  }, [dataVersion, setIndex]);

  // Counts in HeaderChrome track what's actually rendered, so the toggle
  // changes both the graph AND the pill in lockstep.
  const visible = useMemo(
    () => applyInternalFilter(files, edges, showInternal),
    [files, edges, showInternal],
  );

  if (loading) return <div className="center-overlay">Loading…</div>;
  if (error) return <div className="center-overlay">Error: {error}</div>;
  if (files.length === 0)
    return <div className="center-overlay">No files indexed (check backend logs).</div>;

  return (
    <>
      <HeaderChrome
        fileCount={visible.files.length}
        edgeCount={visible.edges.length}
        watcherLive
      />
      {view === "map" && <MapView />}
      {view === "ed" && <EditorView />}
      {view === "ext" && <ExtensionsView />}
      {/* Phase 2 write-pipeline UI primitives. Mounted globally so any view
          can call `useWritePipeline()` without owning the modal/chip/toast
          machinery. Inert until a `writeIntent` or `toasts[]` entry is staged. */}
      <DiffModal />
      <PreviewChip />
      <Toast />
    </>
  );
}
