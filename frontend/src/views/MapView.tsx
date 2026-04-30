import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type cytoscape from "cytoscape";
import { CwdSelector } from "../components/CwdSelector";
import { ExplorerPane } from "../components/ExplorerPane";
import { GraphCanvas } from "../components/GraphCanvas";
import { IconOverlay } from "../components/IconOverlay";
import { Inspector } from "../components/Inspector";
import { PinOverlay } from "../components/PinOverlay";
import { EdgeInfo } from "../components/EdgeInfo";
import { EditorPanel } from "../components/EditorPanel";
import { ContextMenu } from "../components/ContextMenu";
import { ErrorBoundary, EditorBoundary } from "../components/ErrorBoundary";
import type { ContextMenuTarget } from "../components/ContextMenu";
import { fetchCwds, fetchNonCanonical, fetchSimulate } from "../api/client";
import { useStore, EXPLORER_WIDTH_MIN, EXPLORER_WIDTH_MAX } from "../state/store";
import { applyInternalFilter } from "../state/visibility";
import type { Edge, FileEntry, LoadStatus, OrphanConfigEntry } from "../types";

export function MapView() {
  const files = useStore((s) => s.files);
  const edges = useStore((s) => s.edges);
  const showInternal = useStore((s) => s.showInternal);
  const lastCwd = useStore((s) => s.lastCwd);
  const setLastCwd = useStore((s) => s.setLastCwd);
  const explorerWidth = useStore((s) => s.explorerWidth);
  const setExplorerWidth = useStore((s) => s.setExplorerWidth);
  const [cy, setCy] = useState<cytoscape.Core | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<Edge | null>(null);
  const [statusMap, setStatusMap] = useState<Map<string, LoadStatus> | null>(null);
  const [orphanConfigs, setOrphanConfigs] = useState<OrphanConfigEntry[]>([]);

  // Ref to the ExplorerPane DOM — used to apply .graph-hovered to rows
  // when the graph emits obs:graph-hover-node events.
  const explorerRef = useRef<HTMLElement | null>(null);

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
  // its internal viewport. We trigger fit on every toggle so the cluster
  // re-centers in the now-narrower viewport. 220ms timeout matches the
  // 200ms slide animation + a small buffer so the final size is settled.
  useEffect(() => {
    if (!cy) return;
    const t = setTimeout(() => {
      cy.resize();
      cy.fit(undefined, 30);
    }, 220);
    return () => clearTimeout(t);
  }, [cy, inspectorOpen, editorOpen]);

  // When the explorer resize divider is dragged, the canvas column grows/shrinks.
  // Call cy.resize() so Cytoscape's internal viewport matches the new element
  // size. No cy.fit() — the user is mid-drag; re-centering would move pinned
  // nodes from where the eye is tracking. Pin model coordinates are unaffected.
  useEffect(() => {
    if (!cy) return;
    cy.resize();
  }, [cy, explorerWidth]);

  // Auto-pick the first available cwd when none is set so the status overlay
  // and explorer show real content on first load.
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
          row.scrollIntoView({ block: "center", behavior: "smooth" });
        }
      }
    }

    document.addEventListener("obs:graph-hover-node", onGraphHoverNode);
    return () => {
      document.removeEventListener("obs:graph-hover-node", onGraphHoverNode);
    };
  }, []);

  // Right-click on an explorer tree row.
  const handleExplorerContextMenu = useCallback((e: React.MouseEvent, file: FileEntry) => {
    e.preventDefault();
    const displayName = file.display_name ?? file.path.split("/").pop() ?? file.path;
    setCtxTarget({
      path: file.path,
      displayName,
      writable: file.writable ?? true,
      x: e.clientX,
      y: e.clientY,
    });
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
    <div
      className={`view-shell${inspectorOpen ? " has-inspector" : ""}${editorOpen ? " has-editor" : ""}`}
      style={{ "--explorer-w": `${explorerWidth}px` } as React.CSSProperties}
    >
      {/* Phase 4: Explorer pane — width driven by --explorer-w CSS var. */}
      <ErrorBoundary label="Explorer">
        <ExplorerPane
          files={visibleFiles}
          orphanConfigs={orphanConfigs}
          onRowHover={handleRowHover}
          onRowContextMenu={handleExplorerContextMenu}
          ref={(el: HTMLElement | null) => { explorerRef.current = el; }}
        />
      </ErrorBoundary>

      {/* Resize divider between Explorer and canvas.
          Positioned at the right edge of the explorer column via `left`. */}
      <ResizeDivider
        explorerWidth={explorerWidth}
        onResize={setExplorerWidth}
      />

      {/* Canvas area (grid-column 2). EditorPanel slides in from left within
          this column. Inspector overlays from the right. */}
      <div
        className="map-canvas-area"
        onContextMenu={handleContextMenu}
      >
        {/* EditorPanel slides in from the left edge of the canvas area. */}
        <EditorBoundary>
          <EditorPanel files={visibleFiles} />
        </EditorBoundary>
        <ErrorBoundary label="Graph">
          <GraphCanvas
            files={visibleFiles}
            edges={visibleEdges}
            onReady={setCy}
            onHoverEdge={setHoveredEdge}
            onDblClick={handleDblClick}
            statusMap={statusMap}
          />
          <IconOverlay cy={cy} />
          <PinOverlay cy={cy} />
          <CwdSelector />
          <EdgeInfo edge={hoveredEdge} files={visibleFiles} />
        </ErrorBoundary>
      </div>
      <ErrorBoundary label="Inspector">
        <Inspector cy={cy} statusMap={statusMap} />
      </ErrorBoundary>
      <ContextMenu target={ctxTarget} onClose={() => setCtxTarget(null)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// ResizeDivider
//
// Draggable vertical hairline between the Explorer pane and the canvas.
// Keyboard: ArrowLeft/ArrowRight move by 10px per press.
// ---------------------------------------------------------------------------

interface ResizeDividerProps {
  explorerWidth: number;
  onResize: (w: number) => void;
}

function ResizeDivider({ explorerWidth, onResize }: ResizeDividerProps) {
  const [dragging, setDragging] = useState(false);
  const startRef = useRef<{ mouseX: number; startWidth: number } | null>(null);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
    startRef.current = { mouseX: e.clientX, startWidth: explorerWidth };
  }, [explorerWidth]);

  useEffect(() => {
    if (!dragging) return;
    // Suppress text selection during drag so the cursor doesn't cause
    // content to get selected while the mouse is down.
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    function onMove(e: MouseEvent) {
      if (!startRef.current) return;
      const delta = e.clientX - startRef.current.mouseX;
      onResize(startRef.current.startWidth + delta);
    }
    function onUp() {
      setDragging(false);
      startRef.current = null;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [dragging, onResize]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowLeft") { e.preventDefault(); onResize(explorerWidth - 10); }
    if (e.key === "ArrowRight") { e.preventDefault(); onResize(explorerWidth + 10); }
  }

  return (
    <div
      className={`explorer-resize-divider${dragging ? " dragging" : ""}`}
      style={{ left: explorerWidth - 2 }}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize explorer column"
      aria-valuenow={explorerWidth}
      aria-valuemin={EXPLORER_WIDTH_MIN}
      aria-valuemax={EXPLORER_WIDTH_MAX}
      tabIndex={0}
      onMouseDown={handleMouseDown}
      onKeyDown={handleKeyDown}
    />
  );
}

