import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type cytoscape from "cytoscape";
import { CwdSelector } from "../components/CwdSelector";
import { ExplorerPane } from "../components/ExplorerPane";
import { GraphCanvas } from "../components/GraphCanvas";
import { IconOverlay } from "../components/IconOverlay";
import { Inspector } from "../components/Inspector";
import { PinOverlay } from "../components/PinOverlay";
import { EdgeInfo } from "../components/EdgeInfo";
import { TokenBudgetBar } from "../components/TokenBudgetBar";
import { EditorPanel } from "../components/EditorPanel";
import { ContextMenu } from "../components/ContextMenu";
import type { ContextMenuTarget } from "../components/ContextMenu";
import { fetchCwds, fetchNonCanonical, fetchSimulate } from "../api/client";
import { useStore } from "../state/store";
import { applyInternalFilter } from "../state/visibility";
import { buildTreePositions, type ZoneMap } from "../tree/buildTreePositions";
import type { Edge, LoadStatus, OrphanConfigEntry } from "../types";

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
  const [orphanConfigs, setOrphanConfigs] = useState<OrphanConfigEntry[]>([]);

  // Ref to the ExplorerPane DOM — used to apply .graph-hovered to rows
  // when the graph emits obs:graph-hover-node events.
  const explorerRef = useRef<HTMLElement | null>(null);

  const treeMode = mapMode === "tree";
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  const editorOpen = useStore((s) => s.editorOpen);
  const setEditorOpen = useStore((s) => s.setEditorOpen);

  // Context menu state.
  const [ctxTarget, setCtxTarget] = useState<ContextMenuTarget | null>(null);

  const { files: visibleFiles, edges: visibleEdges } = useMemo(
    () => applyInternalFilter(files, edges, showInternal),
    [files, edges, showInternal],
  );

  // When the Inspector or EditorPanel slides in/out, the canvas width changes.
  // Cytoscape's auto-resize observer picks up the size change and reflows
  // its internal viewport, but in tree mode the layout was applied as a
  // one-shot preset — without a follow-up `cy.fit()` the tree zones stay at
  // their pre-resize coordinates and run off-edge. We trigger fit on every
  // toggle, in both modes (graph mode benefits too: a re-fit re-centers the
  // cluster nicely in the now-narrower viewport). 220ms timeout matches the
  // 200ms slide animation + a small buffer so the final size is settled.
  useEffect(() => {
    if (!cy) return;
    const t = setTimeout(() => {
      cy.resize();
      cy.fit(undefined, 30);
    }, 220);
    return () => clearTimeout(t);
  }, [cy, inspectorOpen, editorOpen]);

  // Auto-pick the first available cwd when none is set. Tree mode otherwise
  // renders an empty user-zone placeholder until the user opens the picker;
  // pre-filling lets it show real content on first load.
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

  // Pull a per-cwd load status whenever the cwd selector changes.
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

  // Fetch orphan_configs for the explorer pane orphan indicator.
  // These don't depend on cwd (same for every cwd query), so we
  // fetch once with lastCwd and update on cwd change.
  useEffect(() => {
    if (!lastCwd) return;
    let cancelled = false;
    fetchNonCanonical(lastCwd)
      .then((res) => {
        if (cancelled) return;
        setOrphanConfigs(res.orphan_configs ?? []);
      })
      .catch(() => {
        /* non-canonical is best-effort for the explorer pane */
      });
    return () => { cancelled = true; };
  }, [lastCwd]);

  // Tree-mode positions.
  const layout = useMemo(() => {
    if (!treeMode) return null;
    return buildTreePositions(
      visibleFiles,
      visibleEdges,
      lastCwd,
      statusMap,
      FALLBACK_VIEWPORT,
    );
  }, [treeMode, visibleFiles, visibleEdges, lastCwd, statusMap]);
  const positions = layout?.positions ?? null;
  const zones: ZoneMap | null = layout?.zones ?? null;

  const handleDblClick = useCallback((path: string) => {
    setEditorOpen(path, true);
  }, [setEditorOpen]);

  // Explorer row hover → dim graph nodes except the hovered one and its neighbours.
  // Uses the same `.dim` class as GraphCanvas's internal hover (locked rule #32).
  const handleRowHover = useCallback((fileId: string | null) => {
    if (!cy) return;
    if (!fileId) {
      cy.elements().removeClass("dim");
      return;
    }
    const n = cy.getElementById(fileId);
    if (!n.length) return;
    const related = n.connectedEdges().connectedNodes().union(n);
    cy.elements().difference(related.union(n.connectedEdges())).addClass("dim");
    related.removeClass("dim");
    n.connectedEdges().removeClass("dim");
  }, [cy]);

  // Graph canvas emits a custom DOM event when its internal hover changes —
  // we listen and apply the `.graph-hovered` class to the matching explorer row.
  useEffect(() => {
    const pane = explorerRef.current;
    if (!pane) return;

    function onGraphHoverNode(e: Event) {
      const id = (e as CustomEvent<string | null>).detail;
      // Clear previous.
      pane!.querySelectorAll(".explorer-row.graph-hovered").forEach((el) => {
        el.classList.remove("graph-hovered");
      });
      if (id) {
        const row = pane!.querySelector(`[data-file-id="${id}"]`);
        if (row) {
          row.classList.add("graph-hovered");
          row.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
      }
    }

    document.addEventListener("obs:graph-hover-node", onGraphHoverNode);
    return () => {
      document.removeEventListener("obs:graph-hover-node", onGraphHoverNode);
    };
  }, []);

  // Right-click on graph canvas: find the node under the pointer and show context menu.
  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!cy) return;
    e.preventDefault();
    const container = cy.container();
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const renderedX = e.clientX - rect.left;
    const renderedY = e.clientY - rect.top;
    // Find the node whose rendered bounding-box contains the click point.
    // `renderedBoundingBox()` returns canvas-coordinate bounds so we compare
    // against rendered (not model) coordinates.
    let hitNode: cytoscape.NodeSingular | null = null;
    cy.nodes().forEach((n) => {
      if (n.data("kind") === "folder") return;
      const bb = n.renderedBoundingBox({});
      if (
        renderedX >= bb.x1 &&
        renderedX <= bb.x2 &&
        renderedY >= bb.y1 &&
        renderedY <= bb.y2
      ) {
        hitNode = n as cytoscape.NodeSingular;
      }
    });
    if (!hitNode) return;
    const nodeId = (hitNode as cytoscape.NodeSingular).id();
    const file = files.find((f) => f.id === nodeId);
    if (!file) return;
    const displayName = file.display_name ?? file.path.split("/").pop() ?? file.path;
    setCtxTarget({
      path: file.path,
      displayName,
      writable: file.writable ?? true,
      x: e.clientX,
      y: e.clientY,
    });
  }, [cy, files]);

  return (
    <div className={`view-shell${inspectorOpen ? " has-inspector" : ""}${editorOpen ? " has-editor" : ""}`}>
      {/* Phase 4: Explorer pane — 320px fixed left column, always visible. */}
      <ExplorerPane
        files={visibleFiles}
        orphanConfigs={orphanConfigs}
        onRowHover={handleRowHover}
        ref={(el: HTMLElement | null) => { explorerRef.current = el; }}
      />

      {/* Canvas area (grid-column 2). EditorPanel slides in from left within
          this column. Inspector overlays from the right. */}
      <div
        className="map-canvas-area"
        onContextMenu={handleContextMenu}
      >
        {/* EditorPanel slides in from the left edge of the canvas area. */}
        <EditorPanel files={visibleFiles} />
        <GraphCanvas
          files={visibleFiles}
          edges={visibleEdges}
          onReady={setCy}
          onHoverEdge={setHoveredEdge}
          onDblClick={handleDblClick}
          statusMap={statusMap}
          positions={positions}
          zones={zones}
          treeMode={treeMode}
        />
        <IconOverlay cy={cy} />
        {/* Locked rule #33: PinOverlay is graph-mode only. */}
        <PinOverlay cy={treeMode ? null : cy} />
        <CwdSelector />
        <EdgeInfo edge={hoveredEdge} files={visibleFiles} />
        {treeMode && <TokenBudgetBar zones={zones} />}
        {treeMode && <ZoneLabels />}
      </div>
      <Inspector cy={cy} statusMap={statusMap} />
      <ContextMenu target={ctxTarget} onClose={() => setCtxTarget(null)} />
    </div>
  );
}

// Corner labels marking the tree-mode sub-zones.
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
      <div style={{ ...base, top: 88, left: 16 }}>user layer</div>
      <div style={{ ...base, top: 88, right: 16 }}>project layer</div>
      <div style={{ ...base, bottom: 16, left: "50%", transform: "translateX(-50%)" }}>
        settings layer
      </div>
    </div>
  );
}
