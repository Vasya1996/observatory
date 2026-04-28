import { useEffect, useRef } from "react";
import cytoscape from "cytoscape";
// @ts-expect-error — cola has no bundled types
import cola from "cytoscape-cola";
import { useStore } from "../state/store";
import type { Edge, FileEntry, FileKind } from "../types";
import { isIconKind } from "./nodeIcons";

cytoscape.use(cola);

interface Props {
  files: FileEntry[];
  edges: Edge[];
  onReady?: (cy: cytoscape.Core | null) => void;
  onHoverEdge?: (edge: Edge | null) => void;
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
function nodeColor(kind: FileKind): string {
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

// sqrt-scaled size for colored-circle nodes; flat 23px for icon nodes.
function nodeSize(kind: FileKind, inDeg: number, maxInDeg: number): number {
  if (isIconKind(kind)) return ICON_SIZE;
  if (maxInDeg <= 0) return SIZE_MIN;
  const t = Math.sqrt(inDeg / maxInDeg);
  return SIZE_MIN + (SIZE_MAX - SIZE_MIN) * t;
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

// Graph label: prefer the metadata-derived display_name (plugin name from
// .claude-plugin/plugin.json) over the filesystem basename, since the basename
// for every plugin manifest is just "manifest.json" and that drowns the graph
// in identical labels. Falls back to basename for everything else.
function nodeLabel(f: FileEntry): string {
  return f.display_name && f.display_name.length > 0
    ? f.display_name
    : basename(f.path);
}

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

export function GraphCanvas({ files, edges, onReady, onHoverEdge }: Props) {
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

  useEffect(() => {
    if (!containerRef.current) return;

    const initialPins = pinsRef.current;

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
          label: nodeLabel(f),
          kind: f.kind,
          color: nodeColor(f.kind),
          size: nodeSize(f.kind, inDeg[f.id] ?? 0, maxInDeg),
        },
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
            width: "data(size)",
            height: "data(size)",
            label: "data(label)",
            "font-family": '"JetBrains Mono", monospace',
            "font-size": "9px",
            color: C.paperDim,
            "text-valign": "bottom",
            "text-margin-y": 5,
            "text-outline-color": "#0b0b0e",
            "text-outline-width": 2,
            "border-width": 0,
            "transition-property": "opacity, border-width, border-color",
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
        // Hover dimming (locked design #14).
        {
          selector: ".dim",
          style: { opacity: 0.15 },
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
      ],
      // Initial layout: a one-shot cola run to settle node positions.
      // Live simulation is only spun up while the user is dragging.
      layout: {
        name: "cola",
        animate: false,
        infinite: false,
        fit: false,
        nodeSpacing: 16,
        edgeLength: 110,
        randomize: Object.keys(initialPins).length === 0,
        maxSimulationTime: 1500,
      } as cytoscape.LayoutOptions,
    });

    // Snap initially-persisted pins to their saved positions. The .pinned
    // class is functional (drag-time neighbour filter), not visual — the
    // pushpin glyph lives in <PinOverlay>.
    for (const [id, pos] of Object.entries(initialPins)) {
      const n = cy.getElementById(id);
      if (n.nonempty()) n.position(pos).addClass("pinned");
    }

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
      const inc = n.connectedEdges();
      const out = inc.filter((ed) => ed.data("source") === n.id());
      const into = inc.filter((ed) => ed.data("target") === n.id());
      const related = inc.connectedNodes().union(n);
      cy.elements().difference(related.union(inc)).addClass("dim");
      out.addClass("hover-out");
      into.addClass("hover-in");
    });
    cy.on("mouseout", "node", () => {
      cy.elements().removeClass("dim hover-out hover-in");
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
      if (e.target === cy) useStore.getState().select(null);
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
      onReady?.(null);
      cy.destroy();
      cyRef.current = null;
    };
  }, [files, edges, onReady]);

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
