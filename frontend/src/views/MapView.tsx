import { useEffect, useMemo, useState } from "react";
import type cytoscape from "cytoscape";
import { CwdSelector } from "../components/CwdSelector";
import { GraphCanvas } from "../components/GraphCanvas";
import { IconOverlay } from "../components/IconOverlay";
import { PinOverlay } from "../components/PinOverlay";
import { EdgeInfo } from "../components/EdgeInfo";
import { fetchCwds, fetchSimulate } from "../api/client";
import { useStore } from "../state/store";
import { applyInternalFilter } from "../state/visibility";
import { buildTreePositions } from "../tree/buildTreePositions";
import type { Edge, LoadStatus } from "../types";

// Default canvas viewport size used by the tree builder when the actual
// container has not laid out yet. Roughly matches the chrome-deducted
// in-flight size; the preset layout's `fit: true` re-centers anyway, so
// approximate values are fine.
const FALLBACK_VIEWPORT = { width: 1600, height: 900 };

export function MapView() {
  const files = useStore((s) => s.files);
  const edges = useStore((s) => s.edges);
  const showInternal = useStore((s) => s.showInternal);
  const lastCwd = useStore((s) => s.lastCwd);
  const setLastCwd = useStore((s) => s.setLastCwd);
  const mapMode = useStore((s) => s.mapMode);
  const [cy, setCy] = useState<cytoscape.Core | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<Edge | null>(null);
  const [statusMap, setStatusMap] = useState<Map<string, LoadStatus> | null>(null);

  const treeMode = mapMode === "tree";

  const { files: visibleFiles, edges: visibleEdges } = useMemo(
    () => applyInternalFilter(files, edges, showInternal),
    [files, edges, showInternal],
  );

  // Auto-pick the first available cwd when none is set. Tree mode otherwise
  // renders an empty user-zone placeholder until the user opens the picker;
  // pre-filling lets it show real content on first load. We fetch the cwd
  // list locally too — CwdSelector also calls /api/cwds, but the cost is
  // negligible (cached, single request) and decoupling makes this effect
  // self-contained.
  useEffect(() => {
    if (lastCwd) return;
    let cancelled = false;
    fetchCwds()
      .then((list) => {
        if (cancelled) return;
        if (!useStore.getState().lastCwd && list.length > 0) {
          setLastCwd(list[0].path);
        }
      })
      .catch((e) => console.warn("[observatory] /api/cwds (auto-pick) failed", e));
    return () => {
      cancelled = true;
    };
  }, [lastCwd, setLastCwd]);

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

  // Tree-mode positions: only computed when we actually need them so graph
  // mode pays zero cost. The map keys are FileEntry.id so it composes with the
  // existing visibility filter without remapping.
  const positions = useMemo(() => {
    if (!treeMode) return null;
    return buildTreePositions(
      visibleFiles,
      visibleEdges,
      lastCwd,
      statusMap,
      FALLBACK_VIEWPORT,
    );
  }, [treeMode, visibleFiles, visibleEdges, lastCwd, statusMap]);

  return (
    <div className="view-shell">
      <GraphCanvas
        files={visibleFiles}
        edges={visibleEdges}
        onReady={setCy}
        onHoverEdge={setHoveredEdge}
        statusMap={statusMap}
        positions={positions}
      />
      <IconOverlay cy={cy} />
      {/* Locked rule #33: PinOverlay is graph-mode only. */}
      <PinOverlay cy={treeMode ? null : cy} />
      <CwdSelector />
      <EdgeInfo edge={hoveredEdge} files={visibleFiles} />
      {treeMode && <ZoneLabels />}
    </div>
  );
}

// Three corner labels marking the tree-mode sub-zones. Step 3.1 fills only
// the user zone (left third); the project/settings labels render as visual
// scaffolding so Step 3.2 can drop the real subtrees in without re-doing
// chrome. Uses JetBrains Mono uppercase 10px (matches the existing `.upper`
// token in tokens.css) so the language stays consistent with the cwd panel
// header. The cwd selector lives at top-left z=30 and overlaps the user-zone
// corner — labels nudge inward to clear it.
function ZoneLabels() {
  const base: React.CSSProperties = {
    position: "absolute",
    color: "var(--paper-faint)",
    letterSpacing: "0.18em",
    fontSize: "10px",
    fontFamily: '"JetBrains Mono", monospace',
    textTransform: "uppercase",
  };
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        zIndex: 6,
      }}
      aria-hidden
    >
      {/* USER zone: top-left third. Pushed below the cwd selector (top:16, h~36)
          so they don't collide while remaining clearly part of the same zone. */}
      <div style={{ ...base, top: 64, left: 16 }}>user layer</div>
      {/* PROJECT zone (Step 3.2 placeholder): top-right third. */}
      <div style={{ ...base, top: 16, right: 16 }}>project layer</div>
      {/* SETTINGS zone (Step 3.2 placeholder): bottom centre. */}
      <div style={{ ...base, bottom: 16, left: "50%", transform: "translateX(-50%)" }}>
        settings layer
      </div>
    </div>
  );
}
