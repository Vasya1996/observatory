import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type cytoscape from "cytoscape";
import { ExplorerPane } from "../components/ExplorerPane";
import { GraphCanvas } from "../components/GraphCanvas";
import { IconOverlay } from "../components/IconOverlay";
import { Inspector } from "../components/Inspector";
import { PinOverlay } from "../components/PinOverlay";
import { EdgeInfo } from "../components/EdgeInfo";
import { EditorPanel } from "../components/EditorPanel";
import { ContextMenu } from "../components/ContextMenu";
import { MigrationVerifiedCard } from "../components/MigrationVerifiedCard";
import { LegendOverlay } from "../components/LegendOverlay";
import { ErrorBoundary, EditorBoundary } from "../components/ErrorBoundary";
import type { ContextMenuTarget } from "../components/ContextMenu";
import { fetchCwds, fetchNonCanonical, fetchSimulate, fetchTier2Status } from "../api/client";
import type { Tier2Status } from "../api/client";
import { useStore, EXPLORER_WIDTH_MIN, EXPLORER_WIDTH_MAX } from "../state/store";
import { useWritePipeline } from "../hooks/useWritePipeline";
import { applyInternalFilter } from "../state/visibility";
import type { Edge, FileEntry, LoadStatus, OrphanConfigEntry, TimelineStep } from "../types";

export function MapView() {
  const files = useStore((s) => s.files);
  const edges = useStore((s) => s.edges);
  const showInternal = useStore((s) => s.showInternal);
  const lastCwd = useStore((s) => s.lastCwd);
  const setLastCwd = useStore((s) => s.setLastCwd);
  const dataVersion = useStore((s) => s.dataVersion);
  const explorerWidth = useStore((s) => s.explorerWidth);
  const setExplorerWidth = useStore((s) => s.setExplorerWidth);
  const [cy, setCy] = useState<cytoscape.Core | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<Edge | null>(null);
  const [statusMap, setStatusMap] = useState<Map<string, LoadStatus> | null>(null);
  const [priorityMap, setPriorityMap] = useState<Map<string, number>>(new Map());
  const [simulateSteps, setSimulateSteps] = useState<TimelineStep[]>([]);
  // True while a dataVersion-triggered refetch is in flight.
  const [simulateRefetching, setSimulateRefetching] = useState(false);
  const [orphanConfigs, setOrphanConfigs] = useState<OrphanConfigEntry[]>([]);

  // Tier 2 banner — migrated from removed SimulatorView.
  const [tier2Status, setTier2Status] = useState<Tier2Status | null>(null);
  const [tier2BannerDismissed, setTier2BannerDismissed] = useState(
    () => localStorage.getItem("observatory_tier2_banner_dismissed") === "1",
  );
  const dismissTier2Banner = () => {
    localStorage.setItem("observatory_tier2_banner_dismissed", "1");
    setTier2BannerDismissed(true);
  };
  const { confirmStagedPreview } = useWritePipeline();

  // Migration verified card — remount to re-read localStorage after navigating back to Map.
  const [migrationCardKey] = useState(0);

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

  // Tier 2 status — fetched once on mount.
  useEffect(() => {
    fetchTier2Status().then(setTier2Status).catch(() => {});
  }, []);

  const enableTier2 = useCallback(async () => {
    const settingsEntry = files.find(
      (f) => f.kind === "settings" && f.display.endsWith("settings.json") && !f.display.endsWith("settings.local.json"),
    );
    if (!settingsEntry) return;
    try {
      const previewRes = await fetch("/api/tier2-install-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!previewRes.ok) return;
      const preview = await previewRes.json() as { confirm_token: string; diff: string; base_hash: string; is_creation: boolean };
      const result = await confirmStagedPreview(settingsEntry.path, preview);
      if (result.ok) fetchTier2Status().then(setTier2Status).catch(() => {});
    } catch { /* Errors surface via Toast from confirmStagedPreview */ }
  }, [files, confirmStagedPreview]);

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

  // Pull a per-cwd load status whenever the cwd selector changes OR after a
  // successful write (dataVersion bump) so priority badges update live.
  useEffect(() => {
    if (!lastCwd) {
      setStatusMap(null);
      setSimulateSteps([]);
      return;
    }
    let cancelled = false;
    if (dataVersion > 0) setSimulateRefetching(true);
    fetchSimulate(lastCwd)
      .then((res) => {
        if (cancelled) return;
        const map = new Map<string, LoadStatus>();
        const pmap = new Map<string, number>();
        for (const step of res.steps) {
          if (step.file_id) {
            map.set(step.file_id, step.status);
            if (step.priority !== undefined) pmap.set(step.file_id, step.priority);
          }
        }
        for (const f of files) {
          if (!map.has(f.id)) map.set(f.id, "orphan");
        }
        setStatusMap(map);
        setPriorityMap(pmap);
        setSimulateSteps(res.steps);
      })
      .catch((e) => {
        console.warn("[observatory] /api/simulate failed", e);
        if (!cancelled) setStatusMap(null);
      })
      .finally(() => {
        if (!cancelled) setSimulateRefetching(false);
      });
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastCwd, dataVersion]);

  // Fetch orphan_configs for the explorer pane orphan indicator.
  // Refetches on cwd change AND on dataVersion bump (write may have moved a file).
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastCwd, dataVersion]);

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
  // pluginManaged: true when the file is under ~/.claude/plugins/cache/ —
  // those files are managed by Claude Code and must not be deleted via Observatory.
  const handleExplorerContextMenu = useCallback((e: React.MouseEvent, file: FileEntry, pluginManaged?: boolean) => {
    e.preventDefault();
    const displayName = file.display_name ?? file.path.split("/").pop() ?? file.path;
    setCtxTarget({
      path: file.path,
      displayName,
      writable: pluginManaged ? false : (file.writable ?? true),
      x: e.clientX,
      y: e.clientY,
      activeCwd: lastCwd ?? undefined,
    });
  }, [lastCwd]);

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
          priorityMap={priorityMap}
          steps={simulateSteps}
          statusMap={statusMap}
          onRowHover={handleRowHover}
          onRowContextMenu={handleExplorerContextMenu}
          refetching={simulateRefetching}
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
        {/* Tier 2 live-verify banner — migrated from SimulatorView. */}
        {tier2Status !== null && (
          tier2Status.available ? (
            <div className="map-tier2-banner map-tier2-banner--active">
              <span>Live verification active — {tier2Status.events_captured} load events captured.</span>
            </div>
          ) : !tier2BannerDismissed && (
            <div className="map-tier2-banner">
              <span className="map-tier2-banner-text">
                {tier2Status.preflight.ok
                  ? "Live verification off. Enable to see which files Claude actually loads each session."
                  : `Live verification blocked: ${tier2Status.reason}`}
              </span>
              {tier2Status.preflight.ok && (
                <button
                  type="button"
                  className="map-tier2-enable"
                  onClick={enableTier2}
                >
                  Enable
                </button>
              )}
              <button
                type="button"
                className="map-tier2-dismiss"
                onClick={dismissTier2Banner}
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
          )
        )}

        {/* Migration-verified card — shown after a successful file move. */}
        <MigrationVerifiedCard key={migrationCardKey} activeCwd={lastCwd} />

        {/* Map legend — top-right corner, collapsible (locked rule #60). */}
        <ErrorBoundary label="Legend">
          <LegendOverlay />
        </ErrorBoundary>

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

