import { useEffect, useRef } from "react";
import cytoscape from "cytoscape";
// @ts-expect-error — cola has no bundled types
import cola from "cytoscape-cola";
import { useStore } from "../state/store";
import type { Edge, FileEntry } from "../types";
import { isIconKind, type NodeKind } from "./nodeIcons";
import {
  buildChildFolderIndex,
  computeFolderGroups,
  type FolderGroup,
} from "./folderGroups";
import { computeAmbiguousBasenames, displayLabel } from "./labels";

cytoscape.use(cola);

interface Props {
  files: FileEntry[];
  edges: Edge[];
  onReady?: (cy: cytoscape.Core | null) => void;
  onHoverEdge?: (edge: Edge | null) => void;
  // Per-cwd load status from `/api/simulate`. Keys are FileEntry.id; values are
  // the simulator's TimelineStatus + frontend-derived "orphan" (file not in
  // steps[] for the active cwd) and "unknown" (no cwd selected — opacity
  // overlay disabled). Optional; when null the graph renders kind-only colors
  // as before.
  statusMap?: Map<string, string> | null;
  // Tree-mode position map. When provided AND non-empty, layout switches from
  // cola to `preset` (locked rule #33) and each node is placed at the given
  // {x,y}; nodes missing from the map fall back to (0,0). When null/undefined
  // OR empty, cola runs as today. Per-node tweens between Map states are
  // wired in a separate effect below.
  positions?: Map<string, { x: number; y: number }> | null;
}

// Tokens (kept here for cytoscape — JS can't read CSS variables on raw canvas styles).
const C = {
  paper: "#e8e4d8",
  paperDim: "#b9b4a6",
  paperFaint: "#6e6a5e",
  amber: "#f0a83a",
  teal: "#5da39a",
  // Hook edges: rose tint, third semantic separate from amber/teal so the
  // graph can carry three relation types at a glance.
  rose: "#e89bb0",
  // Icon-node fill — uses --line (not --ink-2) so the dark circle stays
  // visibly distinct from the page bg (--ink #0b0b0e).
  iconBg: "#23232c",
};

// Step 2.5: kind-as-category colour (no more memory-by-frontmatter-type).
function nodeColor(kind: NodeKind): string {
  switch (kind) {
    case "claude_md":
    case "rule":
      return C.amber;
    case "memory":
    case "memory_index":
      return C.paper;
    default:
      return C.iconBg;
  }
}

const SIZE_MIN = 15;
const SIZE_MAX = 31;
const ICON_SIZE = 28;
// Folder-node — slightly larger than a regular icon node so the umbrella
// reads as a container, not just another sibling.
const FOLDER_SIZE = 34;
// Halo radius (rendered px) for the fan-out around a hovered folder. Sized so
// 6 children at ICON_SIZE don't overlap the folder or each other.
const FOLDER_HALO_RADIUS = 80;
// Delay before re-collapsing after the cursor leaves the folder/halo. Gives
// the user time to slide the cursor between the folder and its children
// without the halo flickering closed.
const FOLDER_COLLAPSE_DELAY_MS = 160;

// sqrt-scaled size for colored-circle nodes; flat 23px for icon nodes.
function nodeSize(kind: NodeKind, inDeg: number, maxInDeg: number): number {
  if (kind === "folder") return FOLDER_SIZE;
  if (isIconKind(kind)) return ICON_SIZE;
  if (maxInDeg <= 0) return SIZE_MIN;
  const t = Math.sqrt(inDeg / maxInDeg);
  return SIZE_MIN + (SIZE_MAX - SIZE_MIN) * t;
}

// Node label logic centralised in labels.ts — handles plugin display_name
// override AND ambiguous-basename disambiguation (six identical "CLAUDE.md"
// labels become "~/CLAUDE.md", ".claude/CLAUDE.md", "storm-sdk/CLAUDE.md",
// etc).

// Map edge.lines.length → cytoscape edge width. Mentions get a wider line as
// the count grows so the graph hints at relation "weight" before the user
// hovers; imports stay at a single fixed width since duplicate @-imports are
// rare and the colour already separates them. Hooks: fixed width — multi-event
// hooks for the same target are one connection, not a "weight" signal.
function edgeWidth(kind: string, count: number): number {
  if (kind === "import") return 1.6;
  if (kind === "hook") return 1.6;
  // mention: base 0.9, +0.5 per extra ref, cap at 3.
  return Math.min(0.9 + 0.5 * Math.max(0, count - 1), 3);
}

export function GraphCanvas({ files, edges, onReady, onHoverEdge, statusMap, positions }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);

  // Latest pins held in a ref so the cy event handlers always see fresh
  // values without forcing a re-render of the whole canvas.
  const pinsRef = useRef(useStore.getState().pins);
  useEffect(
    () => useStore.subscribe((s) => { pinsRef.current = s.pins; }),
    [],
  );

  // Latest onHoverEdge in a ref — keeps the cy handler stable across parent
  // re-renders without forcing the whole graph to rebuild.
  const onHoverEdgeRef = useRef(onHoverEdge);
  onHoverEdgeRef.current = onHoverEdge;

  // Latest tree-mode positions in a ref so the construction effect can read
  // the initial map without listing `positions` as a dependency (locked rule
  // #33: NO restructuring of the construction effect; treat tree mode as a
  // layout-config branch, not a rebuild trigger). The transition between
  // graph and tree happens in a separate effect via `cy.animate`.
  const positionsRef = useRef(positions ?? null);
  positionsRef.current = positions ?? null;


  useEffect(() => {
    if (!containerRef.current) return;

    const initialPins = pinsRef.current;

    // Folder groups: collapse N siblings of the same kind under one umbrella
    // dir into a single folder-node. Computed before element building so the
    // children can be tagged with the `folded` class up front.
    const folderGroups: FolderGroup[] = computeFolderGroups(files);
    const groupById = new Map(folderGroups.map((g) => [g.id, g]));
    const childFolderIndex = buildChildFolderIndex(folderGroups);
    const isFoldedChild = (id: string) => childFolderIndex.has(id);

    // Set of basenames shared by 2+ files — these need parent-dir prefix in
    // their graph label so users can tell which CLAUDE.md / settings.json
    // they're looking at.
    const ambiguousBasenames = computeAmbiguousBasenames(files);

    // Inbound count is per-target across both edge kinds. Max is taken only
    // over colored-circle nodes so a heavily-referenced icon kind can't
    // shrink the colored cohort.
    const inDeg: Record<string, number> = {};
    for (const e of edges) {
      inDeg[e.target] = (inDeg[e.target] ?? 0) + 1;
    }
    let maxInDeg = 0;
    for (const f of files) {
      if (!isIconKind(f.kind)) {
        const d = inDeg[f.id] ?? 0;
        if (d > maxInDeg) maxInDeg = d;
      }
    }

    const elements: cytoscape.ElementDefinition[] = [
      ...files.map((f) => ({
        data: {
          id: f.id,
          label: displayLabel(f, ambiguousBasenames),
          kind: f.kind,
          color: nodeColor(f.kind),
          size: nodeSize(f.kind, inDeg[f.id] ?? 0, maxInDeg),
        },
        // Folded children get `display: none` until the user hovers their
        // folder; the underlying cy node still exists so its edges stay in
        // the graph and reappear instantly when the halo opens.
        classes: isFoldedChild(f.id) ? "folded" : undefined,
      })),
      ...folderGroups.map((g) => ({
        data: {
          id: g.id,
          label: `${g.label} · ${g.childIds.length}`,
          kind: "folder" as const,
          color: C.iconBg,
          size: FOLDER_SIZE,
        },
        classes: "folder-node",
      })),
      ...edges.map((e) => ({
        data: {
          id: e.id,
          source: e.source,
          target: e.target,
          kind: e.kind,
          count: e.lines.length,
          width: edgeWidth(e.kind, e.lines.length),
        },
      })),
    ];

    const cy = cytoscape({
      container: containerRef.current,
      elements,
      wheelSensitivity: 0.2,
      style: [
        {
          selector: "node",
          style: {
            "background-color": "data(color)",
            "background-opacity": 1,
            width: "data(size)",
            height: "data(size)",
            label: "data(label)",
            "font-family": '"JetBrains Mono", monospace',
            "font-size": "9px",
            color: C.paperDim,
            // Decoupled from `opacity` — labels stay readable even when the
            // node fades (hover-dim, future overlay states). Mission rule:
            // "no silent omissions" — an unreadable label IS a silent omission.
            "text-opacity": 1,
            "text-valign": "bottom",
            "text-margin-y": 5,
            "text-outline-color": "#0b0b0e",
            "text-outline-width": 2,
            "border-width": 0,
            "transition-property":
              "opacity, border-width, border-color, background-color",
            "transition-duration": 120,
          },
        },
        {
          // Base: colour encodes type, line-style is always solid, no arrow.
          // Direction (solid out / dashed in) and the arrow appear only on
          // hover via .hover-out / .hover-in classes.
          selector: 'edge[kind = "import"]',
          style: {
            "line-color": C.amber,
            "target-arrow-color": C.amber,
            width: "data(width)",
            "curve-style": "bezier",
            opacity: 0.85,
          },
        },
        {
          selector: 'edge[kind = "mention"]',
          style: {
            "line-color": C.teal,
            "target-arrow-color": C.teal,
            width: "data(width)",
            "curve-style": "bezier",
            opacity: 0.55,
          },
        },
        {
          selector: 'edge[kind = "hook"]',
          style: {
            "line-color": C.rose,
            "target-arrow-color": C.rose,
            width: "data(width)",
            "curve-style": "bezier",
            opacity: 0.85,
          },
        },
        // Badge: only on mention edges with >1 ref. Count signals duplicate
        // mentions in the source document — a candidate for cleanup. Native
        // cytoscape label with text-background draws a small chip at the
        // edge midpoint; horizontal (no autorotate) so the digit stays
        // legible regardless of edge angle.
        {
          selector: 'edge[kind = "mention"][count > 1]',
          style: {
            label: "data(count)",
            "font-family": '"JetBrains Mono", monospace',
            "font-size": 9,
            color: C.paper,
            "text-background-color": "#23232c",
            "text-background-opacity": 0.95,
            "text-background-padding": "2px",
            "text-background-shape": "roundrectangle",
            "text-border-color": C.paperFaint,
            "text-border-width": 0.5,
            "text-border-opacity": 1,
            "text-events": "no",
          },
        },
        // Status overlay (per-cwd, from /api/simulate). Class-based instead
        // of data-attribute selectors — empirically the latter don't pick up
        // live data() mutations consistently in this cytoscape build.
        //
        // Design (locked rule #32, redesign): colour answers the binary
        // question "alive in this session?" — only `loaded` keeps the
        // kind-color (amber for CLAUDE/rule, paper for memory). All three
        // not-loaded states share a solid dark-grey fill `#3a3a40` so the
        // live-load chain visually pops in colour, not just brightness.
        // Differentiation between conditional / skipped / orphan happens
        // through the BORDER, not opacity — opacity stays at 1 so labels
        // remain crisp:
        //   * loaded     → kind-color fill, thin solid paper border
        //   * conditional→ grey fill, thin solid paper-faint border
        //                  ("rule's there, condition didn't fire")
        //   * skipped    → grey fill, thin dashed paper-faint border
        //                  ("reachable on demand via mention link")
        //   * orphan     → grey fill, no border (flattest, but still a
        //                  silhouette against near-black bg)
        //
        // Listed BEFORE `.dim` so hover-dim wins on conflict — cytoscape
        // applies later rules with higher priority.
        {
          selector: "node.status-loaded",
          style: {
            "border-width": 1.5,
            "border-color": C.paper,
            "border-style": "solid",
            color: C.paper,
          },
        },
        {
          selector: "node.status-conditional",
          style: {
            "background-color": "#3a3a40",
            "border-width": 1.5,
            "border-color": C.paperFaint,
            "border-style": "dashed",
            color: C.paperDim,
          },
        },
        {
          selector: "node.status-skipped",
          style: {
            "background-color": "#3a3a40",
            "border-width": 0,
            color: C.paperDim,
          },
        },
        {
          selector: "node.status-orphan",
          style: {
            "background-color": "#1f1f24",
            "border-width": 0,
            color: C.paperDim,
          },
        },
        // Hover dimming. Decoupled from text-opacity — labels stay readable
        // even on dimmed nodes (mission rule: no silent omissions). Edges
        // dim further than nodes since they're noise-prone in dense graphs.
        {
          selector: "node.dim",
          style: { opacity: 0.4, "text-opacity": 1 },
        },
        {
          selector: "edge.dim",
          style: { opacity: 0.2 },
        },
        {
          selector: "edge.hover-out",
          style: {
            "line-style": "solid",
            "target-arrow-shape": "triangle",
            "arrow-scale": 0.9,
            opacity: 1,
            width: 2,
          },
        },
        {
          selector: "edge.hover-in",
          style: {
            "line-style": "dashed",
            "target-arrow-shape": "triangle",
            "arrow-scale": 0.9,
            opacity: 1,
            width: 1.6,
          },
        },
        {
          selector: "node:selected",
          style: {
            "border-width": 2,
            "border-color": C.paper,
          },
        },
        // Folder-node: a thin rim that distinguishes the umbrella from a
        // regular icon-kind node. Edges connecting to folded children
        // disappear automatically because cytoscape hides any edge whose
        // endpoint has `display: none`.
        {
          selector: ".folder-node",
          style: {
            "border-width": 1,
            "border-color": C.paperFaint,
            "border-style": "dashed",
            color: C.paper,
            "font-size": 10,
          },
        },
        // Folded children: hidden until the parent folder is hovered.
        {
          selector: ".folded",
          style: { display: "none" },
        },
      ],
      // Initial layout: cola for graph mode, `preset` for tree mode (when a
      // non-empty position map was provided). Locked rule #33: this is the
      // ONLY branch — the rest of the useEffect treats every node uniformly
      // regardless of layout mode.
      layout:
        positionsRef.current && positionsRef.current.size > 0
          ? ({
              name: "preset",
              fit: true,
              padding: 30,
              // cytoscape's preset layout calls this with the actual NodeSingular
              // at runtime — TS types claim `(nodeid: string)`, but the source
              // (`preset.mjs`: `options.positions(node)`) passes the node. Cast
              // to any to keep both worlds happy.
              positions: ((n: cytoscape.NodeSingular) =>
                positionsRef.current?.get(n.id()) ?? { x: 0, y: 0 }) as unknown as (
                id: string,
              ) => cytoscape.Position,
            } as cytoscape.LayoutOptions)
          : ({
              name: "cola",
              animate: false,
              infinite: false,
              fit: false,
              nodeSpacing: 16,
              edgeLength: 110,
              randomize: Object.keys(initialPins).length === 0,
              maxSimulationTime: 1500,
            } as cytoscape.LayoutOptions),
    });

    // Snap initially-persisted pins to their saved positions. The .pinned
    // class is functional (drag-time neighbour filter), not visual — the
    // pushpin glyph lives in <PinOverlay>. Skipped in tree mode: pins are a
    // graph-mode UX, and their saved positions would clobber the preset
    // layout we just applied.
    if (!(positionsRef.current && positionsRef.current.size > 0)) {
      for (const [id, pos] of Object.entries(initialPins)) {
        const n = cy.getElementById(id);
        if (n.nonempty()) n.position(pos).addClass("pinned");
      }
    }

    // Post-layout: for each folder group, place the folder at the centroid
    // of its children's settled positions, then snap the children to the
    // folder. The children stay laid-out by cola (so their edges to the rest
    // of the graph aren't ignored), but visually collapse onto the folder
    // until the user hovers. This keeps the folder anchored to where its
    // contents naturally cluster — important when many edges point at the
    // children — instead of floating in random whitespace.
    const settleFolders = () => {
      for (const g of folderGroups) {
        const folder = cy.getElementById(g.id);
        if (folder.empty()) continue;
        // If the folder itself is pinned, leave it where the user put it;
        // children still snap to that position.
        const pinned = folder.hasClass("pinned");
        if (!pinned) {
          let cx = 0;
          let cy_ = 0;
          let n = 0;
          for (const cid of g.childIds) {
            const child = cy.getElementById(cid);
            if (child.empty()) continue;
            const p = child.position();
            cx += p.x;
            cy_ += p.y;
            n += 1;
          }
          if (n > 0) folder.position({ x: cx / n, y: cy_ / n });
        }
        const fp = folder.position();
        for (const cid of g.childIds) {
          const child = cy.getElementById(cid);
          if (!child.empty()) child.position({ x: fp.x, y: fp.y });
        }
      }
    };
    cy.one("layoutstop", settleFolders);
    // Cola is one-shot with `animate: false`; in some setups layoutstop
    // fires synchronously during `.run()` (already invoked by cytoscape's
    // constructor with the layout option above). Run once unconditionally so
    // we settle even if the listener missed the event.
    settleFolders();

    // ----- folder hover / fan-out -----
    // Tracks the currently-expanded folder so the collapse timer knows which
    // group to retract, and so re-entering the same folder is a no-op.
    let openFolderId: string | null = null;
    let collapseTimer: ReturnType<typeof setTimeout> | null = null;

    const cancelCollapse = () => {
      if (collapseTimer) {
        clearTimeout(collapseTimer);
        collapseTimer = null;
      }
    };

    const collapseFolder = (immediate = false) => {
      const apply = () => {
        if (!openFolderId) return;
        const group = groupById.get(openFolderId);
        openFolderId = null;
        collapseTimer = null;
        if (!group) return;
        const folder = cy.getElementById(group.id);
        const center = folder.empty() ? { x: 0, y: 0 } : folder.position();
        for (const cid of group.childIds) {
          const child = cy.getElementById(cid);
          if (child.empty()) continue;
          child.position({ x: center.x, y: center.y });
          child.addClass("folded");
        }
      };
      if (immediate) {
        cancelCollapse();
        apply();
        return;
      }
      cancelCollapse();
      collapseTimer = setTimeout(apply, FOLDER_COLLAPSE_DELAY_MS);
    };

    const expandFolder = (folderId: string) => {
      const group = groupById.get(folderId);
      if (!group) return;
      cancelCollapse();
      if (openFolderId === folderId) return;
      if (openFolderId && openFolderId !== folderId) collapseFolder(true);
      openFolderId = folderId;
      const folder = cy.getElementById(folderId);
      if (folder.empty()) return;
      const center = folder.position();
      const N = group.childIds.length;
      // Convert the desired rendered radius into the model coordinate radius
      // cytoscape positions live in. zoom() == rendered/model ratio.
      const modelRadius = FOLDER_HALO_RADIUS / Math.max(0.01, cy.zoom());
      group.childIds.forEach((cid, i) => {
        const angle = (Math.PI * 2 * i) / Math.max(1, N) - Math.PI / 2;
        const x = center.x + modelRadius * Math.cos(angle);
        const y = center.y + modelRadius * Math.sin(angle);
        const child = cy.getElementById(cid);
        if (child.empty()) return;
        child.position({ x, y });
        child.removeClass("folded");
      });
    };

    // ----- drag-time neighbour pull -----
    // Cola's constraint solver runs slower than mouse-move events fire, so
    // a continuous live layout never visually catches up. Instead, we move
    // each unpinned direct neighbour by a fixed fraction of the dragged
    // node's delta on every drag event. Deterministic and snappy.
    const FOLLOW = 0.65; // how much of the drag the neighbours absorb
    let dragOrigin: { x: number; y: number } | null = null;
    let neighbourStarts: { node: cytoscape.NodeSingular; pos: { x: number; y: number } }[] = [];

    // ----- hover behavior -----
    cy.on("mouseover", "node", (e) => {
      const n = e.target as cytoscape.NodeSingular;
      const id = n.id();
      const kind = n.data("kind") as NodeKind | undefined;

      if (kind === "folder") {
        // Folder hover: open the halo. Skip the default dim — children + the
        // rest of the graph need to stay visible so the user can read the
        // children's existing edges to/from outside the folder.
        expandFolder(id);
        return;
      }

      // Hovering one of the currently-fanned-out children: keep the halo
      // open while the cursor is on the child. Fall through so the child
      // gets the normal direction-encoding hover treatment.
      if (childFolderIndex.get(id) === openFolderId && openFolderId) {
        cancelCollapse();
      } else if (openFolderId && childFolderIndex.get(id) !== openFolderId) {
        // Cursor moved to an unrelated node — close the halo immediately so
        // it doesn't linger over the next interaction.
        collapseFolder(true);
      }

      const inc = n.connectedEdges();
      const out = inc.filter((ed) => ed.data("source") === n.id());
      const into = inc.filter((ed) => ed.data("target") === n.id());
      const related = inc.connectedNodes().union(n);
      cy.elements().difference(related.union(inc)).addClass("dim");
      out.addClass("hover-out");
      into.addClass("hover-in");
    });
    cy.on("mouseout", "node", (e) => {
      cy.elements().removeClass("dim hover-out hover-in");
      const n = e.target as cytoscape.NodeSingular;
      const id = n.id();
      const kind = n.data("kind") as NodeKind | undefined;
      // Arm collapse when the cursor leaves either the folder itself or one
      // of its currently-displayed children. Re-entering the folder or any
      // child clears the timer.
      if (kind === "folder" && id === openFolderId) {
        collapseFolder(false);
      } else if (childFolderIndex.get(id) === openFolderId && openFolderId) {
        collapseFolder(false);
      }
    });

    // ----- drag to pin (locked design #15) -----
    cy.on("grab", "node", (e) => {
      const grabbed = e.target as cytoscape.NodeSingular;
      const start = grabbed.position();
      dragOrigin = { x: start.x, y: start.y };
      const out = grabbed.outgoers("node");
      const inc = grabbed.incomers("node");
      const reactive = out.union(inc).not(grabbed).not(".pinned");
      neighbourStarts = reactive.toArray().map((n) => {
        const node = n as cytoscape.NodeSingular;
        const p = node.position();
        return { node, pos: { x: p.x, y: p.y } };
      });
    });
    cy.on("drag", "node", (e) => {
      if (!dragOrigin) return;
      const grabbed = e.target as cytoscape.NodeSingular;
      const cur = grabbed.position();
      const dx = (cur.x - dragOrigin.x) * FOLLOW;
      const dy = (cur.y - dragOrigin.y) * FOLLOW;
      for (const { node, pos } of neighbourStarts) {
        node.position({ x: pos.x + dx, y: pos.y + dy });
      }
    });
    cy.on("dragfree", "node", (e) => {
      dragOrigin = null;
      neighbourStarts = [];
      const n = e.target as cytoscape.NodeSingular;
      const pos = n.position();
      n.addClass("pinned");
      useStore.getState().setPin(n.id(), { x: pos.x, y: pos.y });
    });

    cy.on("tap", "node", (e) => {
      useStore.getState().select((e.target as cytoscape.NodeSingular).id());
    });
    cy.on("tap", (e) => {
      if (e.target === cy) {
        useStore.getState().select(null);
        // Tap on background closes any expanded halo immediately so a
        // long-paused cursor doesn't keep the children stuck out.
        if (openFolderId) collapseFolder(true);
      }
    });

    // Edge hover: hand the original Edge back to the parent so MapView can
    // render the EdgeInfo card. We look up by id in the prop array because
    // cytoscape data() only carries the flat scalars needed for styling.
    const edgeIndex = new Map(edges.map((edge) => [edge.id, edge]));
    cy.on("mouseover", "edge", (e) => {
      const id = (e.target as cytoscape.EdgeSingular).id();
      const found = edgeIndex.get(id);
      if (found) onHoverEdgeRef.current?.(found);
    });
    cy.on("mouseout", "edge", () => {
      onHoverEdgeRef.current?.(null);
    });

    cyRef.current = cy;
    onReady?.(cy);
    return () => {
      cancelCollapse();
      onReady?.(null);
      cy.destroy();
      cyRef.current = null;
    };
  }, [files, edges, onReady]);

  // Apply load status to nodes whenever statusMap changes. Toggles a
  // `status-<state>` class on each non-folder node — class-based selectors
  // pick up live mutations cleanly, whereas the data-attribute approach
  // empirically failed to repaint when n.data('status', ...) was updated
  // post-construction. Separate from the construction effect so cwd-driven
  // status updates mutate cytoscape in place instead of tearing down and
  // re-laying out the graph.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.batch(() => {
      cy.nodes().forEach((n) => {
        if (n.data("kind") === "folder") return;
        n.removeClass(
          "status-loaded status-conditional status-skipped status-orphan",
        );
        const s = statusMap?.get(n.id());
        if (s) n.addClass(`status-${s}`);
      });
    });
  }, [statusMap]);

  // Animate node positions when the tree-mode position map changes after the
  // initial mount. Three transitions are handled:
  //   * graph → tree    (null → Map):   tween every node to its new tree pos.
  //   * tree → tree     (Map  → Map):   re-tween (e.g. cwd swap shifted nodes).
  //   * tree → graph    (Map  → null):  re-run cola so nodes fall back to a
  //                                     force-directed layout; cola animates
  //                                     itself when `animate: true`.
  // Skipped on the very first run because the construction effect already
  // applied the layout. Locked rule #33 keeps this isolated from the cy
  // construction so we don't tear down and rebuild on a tree/graph switch.
  const lastPositionsRef = useRef<Map<string, { x: number; y: number }> | null>(
    null,
  );
  const skipFirstAnimRef = useRef(true);
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    if (skipFirstAnimRef.current) {
      skipFirstAnimRef.current = false;
      lastPositionsRef.current = positions ?? null;
      return;
    }
    const prev = lastPositionsRef.current;
    const next = positions ?? null;
    lastPositionsRef.current = next;
    // No-op when both states represent "graph mode" (null/empty).
    const prevHas = !!prev && prev.size > 0;
    const nextHas = !!next && next.size > 0;
    if (!prevHas && !nextHas) return;

    if (nextHas) {
      // Tween each known node to its target tree position. Unknown nodes
      // (those without a tree assignment in this commit — project/settings/
      // orphan placeholders) stay put for now; Step 3.2 fills them in.
      cy.batch(() => {
        cy.nodes().forEach((n) => {
          if (n.data("kind") === "folder") return;
          const target = next!.get(n.id());
          if (!target) return;
          n.animate(
            { position: target },
            { duration: 400, easing: "ease-in-out" },
          );
        });
      });
    } else {
      // Tree → graph: stop any in-flight position tweens and re-run cola so
      // the graph re-settles into its force-directed shape. `randomize: false`
      // keeps the existing positions as a starting hint instead of throwing
      // everything to (0,0).
      cy.nodes().stop(true, true);
      const layout = cy.layout({
        name: "cola",
        animate: true,
        infinite: false,
        fit: false,
        nodeSpacing: 16,
        edgeLength: 110,
        randomize: false,
        maxSimulationTime: 1500,
      } as cytoscape.LayoutOptions);
      layout.run();
    }
  }, [positions]);

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height: "calc(100vh - 64px)",
        background:
          "radial-gradient(1200px 600px at 30% 0%, rgba(240,168,58,0.05), transparent 60%), #0b0b0e",
      }}
    />
  );
}
