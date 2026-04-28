import { useEffect, useRef } from "react";
import cytoscape from "cytoscape";
// @ts-expect-error — cola has no bundled types
import cola from "cytoscape-cola";
import { useStore } from "../state/store";
import type { Edge, FileEntry, FileKind } from "../types";
import { ICON_BY_KIND, isIconKind } from "./nodeIcons";

cytoscape.use(cola);

interface Props {
  files: FileEntry[];
  edges: Edge[];
  onReady?: (cy: cytoscape.Core | null) => void;
}

// Tokens (kept here for cytoscape — JS can't read CSS variables on raw canvas styles).
const C = {
  paper: "#e8e4d8",
  paperDim: "#b9b4a6",
  paperFaint: "#6e6a5e",
  amber: "#f0a83a",
  teal: "#5da39a",
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
const ICON_SIZE = 36;

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

export function GraphCanvas({ files, edges, onReady }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);

  // Latest pins held in a ref so the cy event handlers always see fresh
  // values without forcing a re-render of the whole canvas.
  const pinsRef = useRef(useStore.getState().pins);
  useEffect(
    () => useStore.subscribe((s) => { pinsRef.current = s.pins; }),
    [],
  );

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
          label: basename(f.path),
          kind: f.kind,
          color: nodeColor(f.kind),
          size: nodeSize(f.kind, inDeg[f.id] ?? 0, maxInDeg),
          iconUrl: ICON_BY_KIND[f.kind] ?? "",
        },
      })),
      ...edges.map((e) => ({
        data: {
          id: e.id,
          source: e.source,
          target: e.target,
          kind: e.kind,
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
          // Icon kinds: lucide glyph centred inside the circle. The SVG
          // sources expand the viewBox to -5 -5 34 34 (see nodeIcons.ts)
          // so background-fit: contain places the icon fully inside the
          // inscribed circle without any rim overflow.
          selector:
            'node[kind = "skill"], node[kind = "plugin_manifest"], node[kind = "plugin_registry"], node[kind = "mcp"], node[kind = "settings"], node[kind = "automemory"]',
          style: {
            "background-image": "data(iconUrl)",
            "background-fit": "contain",
            "background-image-opacity": 1,
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
            width: 1.6,
            "curve-style": "bezier",
            opacity: 0.85,
          },
        },
        {
          selector: 'edge[kind = "mention"]',
          style: {
            "line-color": C.teal,
            "target-arrow-color": C.teal,
            width: 0.9,
            "curve-style": "bezier",
            opacity: 0.55,
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
