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
  ink2: "#111116",
};

function nodeColor(f: FileEntry): string {
  if (f.kind === "memory") {
    const t = (f.frontmatter as { type?: string } | null)?.type;
    if (t === "feedback")  return C.rust;
    if (t === "project")   return C.plum;
    if (t === "user")      return C.lime;
    return C.teal; // reference + unknown
  }
  switch (f.kind) {
    case "claude_md":       return C.paper;
    case "rule":            return C.amber;
    case "memory_index":    return C.amber;
    case "skill":           return C.plum;
    case "plugin_manifest": return C.plum;
    case "plugin_registry": return C.paperFaint;
    case "mcp":             return C.lime;
    case "settings":        return C.paperFaint;
    case "automemory":      return C.paperFaint;
  }
}

function nodeSize(f: FileEntry): number {
  if (f.kind === "memory_index") return 22;
  if (f.kind === "claude_md")    return 18;
  return 12;
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

    const elements: cytoscape.ElementDefinition[] = [
      ...files.map((f) => ({
        data: {
          id: f.id,
          label: basename(f.path),
          kind: f.kind,
          color: nodeColor(f),
          size: nodeSize(f),
          locked: f.kind === "automemory" ? 1 : 0,
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
          selector: "node[locked = 1]",
          style: {
            "border-width": 1,
            "border-style": "dashed",
            "border-color": C.paperFaint,
            opacity: 0.55,
          },
        },
        {
          selector: 'edge[kind = "import"]',
          style: {
            "line-color": C.amber,
            width: 1.6,
            "target-arrow-color": C.amber,
            "target-arrow-shape": "triangle",
            "arrow-scale": 0.9,
            "curve-style": "bezier",
            opacity: 0.85,
            // TODO step 2+: animated dots along import edges (locked design #13).
            // Cytoscape has no native marker-along-path; needs an SVG overlay.
            // Solid line + arrowhead carries direction adequately for v0.
          },
        },
        {
          selector: 'edge[kind = "mention"]',
          style: {
            "line-color": C.teal,
            "line-style": "dashed",
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
          style: { "line-color": C.amber, "target-arrow-color": C.amber, opacity: 1, width: 2 },
        },
        {
          selector: "edge.hover-in",
          style: { "line-color": C.teal, opacity: 1, width: 1.6 },
        },
        {
          selector: "node.pinned",
          style: {
            "border-width": 2,
            "border-color": C.amber,
            "border-style": "solid",
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

    // Snap initially-persisted pins to their saved positions.
    for (const [id, pos] of Object.entries(initialPins)) {
      const n = cy.getElementById(id);
      if (n.nonempty()) n.position(pos).addClass("pinned");
    }

    // ----- live simulation, only while dragging -----
    // Running cola continuously caused two problems: every node drifted in
    // response to every other (global force field) and released nodes were
    // pulled back into the cluster. The fix is to only animate while the
    // user is actively holding a node — then freeze.
    let liveLayout: cytoscape.Layouts | null = null;
    const startLive = () => {
      if (liveLayout) liveLayout.stop();
      liveLayout = cy.layout({
        name: "cola",
        animate: true,
        infinite: true,
        fit: false,
        randomize: false,
        nodeSpacing: 16,
        edgeLength: 110,
      } as cytoscape.LayoutOptions);
      liveLayout.run();
    };
    const stopLive = () => {
      if (liveLayout) {
        liveLayout.stop();
        liveLayout = null;
      }
    };

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
    // Cola only treats node.locked() as fixed. To keep already-pinned nodes
    // anchored while a different node is dragged, we lock them at grab time
    // and unlock everyone again at dragfree — so any pin can still be
    // re-grabbed later.
    cy.on("grab", "node", (e) => {
      const grabbed = e.target as cytoscape.NodeSingular;
      // Free to move during this drag: the grabbed node plus its direct
      // neighbours that aren't already pinned. Everything else is locked
      // so cola can't tug it toward the global force equilibrium.
      const reactive = grabbed.neighborhood().nodes().not(".pinned");
      cy.nodes().not(grabbed).not(reactive).lock();
      startLive();
    });
    cy.on("dragfree", "node", (e) => {
      stopLive();
      cy.nodes().unlock();
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
    return () => {
      stopLive();
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
