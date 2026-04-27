import { useEffect, useRef } from "react";
import cytoscape from "cytoscape";
// @ts-expect-error — cola has no bundled types
import cola from "cytoscape-cola";
import { useStore } from "../state/store";
import type { Edge, FileEntry } from "../types";

cytoscape.use(cola);

interface Props {
  files: FileEntry[];
  edges: Edge[];
}

// Tokens (kept here for cytoscape — JS can't read CSS variables on raw canvas styles).
const C = {
  paper: "#e8e4d8",
  paperDim: "#b9b4a6",
  paperFaint: "#6e6a5e",
  amber: "#f0a83a",
  teal: "#5da39a",
  plum: "#8a6ca0",
  lime: "#c7e36b",
  rust: "#cf6747",
  ink: "#0b0b0e",
  ink2: "#111116",
  ink3: "#16161d",
  line: "#23232c",
};

// ---- inline SVG icons (URI-encoded, painted via background-image) ----
const svg = (markup: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(markup)}`;

// Scroll — used for skills (à la Claude desktop scroll glyph).
const ICON_SCROLL = svg(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
   stroke="${C.amber}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M5 4 h12 a2 2 0 0 1 2 2 v12 a2 2 0 0 0 2 2 h-13 a2 2 0 0 1 -2 -2 V6 a2 2 0 0 1 1 -2 z"/>
    <path d="M3 6 a2 2 0 0 1 2 -2"/>
    <line x1="9" y1="9" x2="16" y2="9"/>
    <line x1="9" y1="13" x2="16" y2="13"/>
  </svg>`,
);

// Plug — used for plugins / mcp connectors. Teal so it doesn't compete
// with rules/entry points for the amber slot.
const ICON_PLUG = svg(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
   stroke="${C.teal}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M9 3 v5 M15 3 v5"/>
    <path d="M7 8 h10 v3 a5 5 0 0 1 -10 0 z"/>
    <path d="M12 16 v5"/>
  </svg>`,
);

// Gear — used for settings.
const ICON_GEAR = svg(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
   stroke="${C.amber}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="3"/>
    <path d="M12 2 v3 M12 19 v3 M2 12 h3 M19 12 h3
             M4.9 4.9 l2.1 2.1 M17 17 l2.1 2.1
             M4.9 19.1 l2.1 -2.1 M17 7 l2.1 -2.1"/>
  </svg>`,
);

// Lock — enamel-style badge for automemory nodes (bottom-right corner).
const ICON_LOCK = svg(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
    <rect x="4.5" y="11" width="15" height="10.5" rx="2.5"
          fill="${C.ink2}" stroke="${C.amber}" stroke-width="1.6" opacity="0.92"/>
    <path d="M8 11 V7 a4 4 0 0 1 8 0 V11"
          fill="none" stroke="${C.amber}" stroke-width="1.6" stroke-linecap="round"/>
    <circle cx="12" cy="16" r="1.2" fill="${C.amber}"/>
    <line x1="12" y1="16" x2="12" y2="18.5"
          stroke="${C.amber}" stroke-width="1.4" stroke-linecap="round"/>
  </svg>`,
);

// 3D pushpin — needle + ground-shadow + bevel arc give the depth illusion.
const ICON_PIN = svg(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
    <ellipse cx="12.5" cy="22" rx="3.5" ry="0.8" fill="${C.ink}" opacity="0.55"/>
    <line x1="12" y1="14" x2="12" y2="22"
          stroke="${C.ink}" stroke-width="1.4" stroke-linecap="round"/>
    <ellipse cx="12" cy="9" rx="6.5" ry="5"
             fill="${C.amber}" stroke="${C.ink}" stroke-width="1.3"/>
    <ellipse cx="10" cy="7.5" rx="2.2" ry="1.4" fill="#ffd07a" opacity="0.95"/>
    <path d="M 5.6 9 a 6.5 5 0 0 0 12.8 0"
          fill="none" stroke="#a4661a" stroke-width="1.1" opacity="0.7"/>
  </svg>`,
);

function primaryIcon(f: FileEntry): string | null {
  if (f.kind === "skill") return ICON_SCROLL;
  if (f.kind === "plugin_manifest" || f.kind === "plugin_registry") return ICON_PLUG;
  if (f.kind === "mcp") return ICON_PLUG;
  if (f.kind === "settings") return ICON_GEAR;
  return null;
}

function nodeColor(f: FileEntry): string {
  switch (f.kind) {
    case "claude_md":       return C.paper;
    case "memory_index":    return C.amber;
    case "rule":            return C.amber;
    case "memory":          return C.teal;
    case "automemory":      return C.teal;
    case "skill":
    case "settings":
      return C.amber;
    case "plugin_manifest":
    case "plugin_registry":
    case "mcp":
      return C.teal;
  }
}

const SIZE_ENTRY = 36;
const SIZE_ICON  = 32;
const SIZE_MIN   = 20;
const SIZE_MAX   = 32;

function isEntryPoint(f: FileEntry): boolean {
  return f.kind === "claude_md" || f.kind === "memory_index";
}
function isIconShaped(f: FileEntry): boolean {
  return (
    f.kind === "skill" ||
    f.kind === "plugin_manifest" ||
    f.kind === "plugin_registry" ||
    f.kind === "mcp" ||
    f.kind === "settings"
  );
}

function nodeSize(f: FileEntry, indeg: number, maxIndeg: number): number {
  if (isEntryPoint(f)) return SIZE_ENTRY;
  if (isIconShaped(f)) return SIZE_ICON;
  if (maxIndeg === 0) return SIZE_MIN;
  return SIZE_MIN + (SIZE_MAX - SIZE_MIN) * (indeg / maxIndeg);
}

interface BgState {
  bgImages: string[];
  bgPosX: string[];
  bgPosY: string[];
  bgW: string[];
  bgH: string[];
  bgFit: string[];
  bgClip: string[];
  bgOpacity: number; // body opacity — 0 hides the colored circle so the icon stands alone
}

function computeBg(f: FileEntry, pinned: boolean): BgState | null {
  const primary = primaryIcon(f);
  const hasLock = f.kind === "automemory";
  if (!primary && !hasLock && !pinned) return null;

  const images: string[] = [];
  const posX: string[] = [];
  const posY: string[] = [];
  const w: string[] = [];
  const h: string[] = [];
  const fit: string[] = [];
  const clip: string[] = [];

  if (primary) {
    images.push(primary);
    posX.push("50%"); posY.push("50%");
    w.push("100%");   h.push("100%");
    fit.push("contain"); clip.push("none");
  }
  if (hasLock) {
    images.push(ICON_LOCK);
    posX.push("100%"); posY.push("100%");
    w.push("48%");     h.push("48%");
    fit.push("contain"); clip.push("none");
  }
  if (pinned) {
    images.push(ICON_PIN);
    posX.push("100%"); posY.push("0%");
    w.push("60%");     h.push("60%");
    fit.push("contain"); clip.push("none");
  }

  return {
    bgImages: images,
    bgPosX: posX,
    bgPosY: posY,
    bgW: w,
    bgH: h,
    bgFit: fit,
    bgClip: clip,
    bgOpacity: primary ? 0 : 1,
  };
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

export function GraphCanvas({ files, edges }: Props) {
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

    // Indegree (= popularity) drives node size for non-entry-point files.
    const indegMap = new Map<string, number>();
    for (const e of edges) indegMap.set(e.target, (indegMap.get(e.target) ?? 0) + 1);
    const maxIndeg = Math.max(0, ...indegMap.values());

    const filesById = new Map(files.map((f) => [f.id, f]));

    const elements: cytoscape.ElementDefinition[] = [
      ...files.map((f) => {
        const indeg = indegMap.get(f.id) ?? 0;
        const pinned = !!initialPins[f.id];
        const bg = computeBg(f, pinned);
        return {
          data: {
            id: f.id,
            label: basename(f.path),
            kind: f.kind,
            color: nodeColor(f),
            size: nodeSize(f, indeg, maxIndeg),
            ...(bg ?? {}),
          },
          classes: pinned ? "pinned" : undefined,
        };
      }),
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

            // Label as a chip pinned to the bottom-right of the node:
            // text-margin-x (6) + text-background-padding (7) puts the chip's
            // left edge ~1px inside the circle, slightly overlapping it.
            "text-halign": "right",
            "text-valign": "center",
            "text-margin-x": 6,
            "text-margin-y": 5,

            "font-family": '"JetBrains Mono", monospace',
            "font-size": 11,
            "font-weight": 400,
            color: C.paper,

            "text-background-color": "#16161d",
            "text-background-opacity": 0.78,
            "text-background-padding": "7px",
            "text-background-shape": "roundrectangle",

            "text-border-color": C.line,
            "text-border-width": 1,
            "text-border-opacity": 0.55,

            "text-max-width": 200,
            "text-wrap": "ellipsis",
            "text-overflow-wrap": "anywhere",

            "border-width": 0,
          } as unknown as cytoscape.Css.Node,
        },
        // Multi-image background — applied only when computeBg() seeded the
        // bgImages data array (icon-shaped kinds, automemory lock, pinned pin).
        // Cast: cytoscape's TS types disallow data() refs for some bg props,
        // but the underlying renderer accepts them.
        {
          selector: "node[bgImages]",
          style: {
            "background-image": "data(bgImages)",
            "background-position-x": "data(bgPosX)",
            "background-position-y": "data(bgPosY)",
            "background-width": "data(bgW)",
            "background-height": "data(bgH)",
            "background-fit": "data(bgFit)",
            "background-clip": "data(bgClip)",
            "background-image-containment": "over",
            "background-opacity": "data(bgOpacity)",
            "bounds-expansion": 8,
          } as unknown as cytoscape.Css.Node,
        },
        {
          selector: 'node[kind = "automemory"]',
          style: {
            opacity: 0.55,
          },
        },
        // Hairline amber ring on entry points.
        {
          selector: 'node[kind = "claude_md"], node[kind = "memory_index"]',
          style: {
            "border-width": 1.5,
            "border-style": "solid",
            "border-color": C.amber,
            "border-opacity": 0.7,
          },
        },
        // Chip promotion on the hovered node itself.
        {
          selector: "node.hover-self",
          style: {
            "text-background-opacity": 0.95,
            "text-background-color": "#1a1a22",
            "text-border-opacity": 1,
            "text-border-color": C.amber,
            color: C.amber,
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
        // .pinned visualisation is now the pin badge baked into bgImages —
        // no border. `:selected` still shows a paper-coloured outline.
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

    // Snap initially-persisted pins to their saved positions.
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
      n.addClass("hover-self");
    });
    cy.on("mouseout", "node", () => {
      cy.elements().removeClass("dim hover-out hover-in hover-self");
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
      // Repaint the node with the pin badge layered on its background.
      const f = filesById.get(n.id());
      if (f) {
        const bg = computeBg(f, true);
        if (bg) for (const [k, v] of Object.entries(bg)) n.data(k, v);
      }
      useStore.getState().setPin(n.id(), { x: pos.x, y: pos.y });
    });

    cy.on("tap", "node", (e) => {
      useStore.getState().select((e.target as cytoscape.NodeSingular).id());
    });
    cy.on("tap", (e) => {
      if (e.target === cy) useStore.getState().select(null);
    });

    cyRef.current = cy;
    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [files, edges]);

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
