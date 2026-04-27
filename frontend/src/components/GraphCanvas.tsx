import { useEffect, useRef } from "react";
import cytoscape from "cytoscape";
// @ts-expect-error — fcose has no bundled types
import fcose from "cytoscape-fcose";
import type { Edge, FileEntry } from "../types";

cytoscape.use(fcose);

interface Props {
  files: FileEntry[];
  edges: Edge[];
}

export function GraphCanvas({ files, edges }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const cy = cytoscape({
      container: containerRef.current,
      elements: [
        ...files.map((f) => ({
          data: {
            id: f.id,
            label: basename(f.path),
            kind: f.kind,
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
      ],
      style: [
        {
          selector: "node",
          style: {
            label: "data(label)",
            "font-size": "9px",
            "text-valign": "bottom",
            "text-margin-y": 4,
            "background-color": "#888",
            width: 14,
            height: 14,
          },
        },
        {
          selector: 'edge[kind = "import"]',
          style: {
            "line-color": "#f0a83a",
            width: 1.4,
            "target-arrow-color": "#f0a83a",
            "target-arrow-shape": "triangle",
            "curve-style": "bezier",
          },
        },
        {
          selector: 'edge[kind = "mention"]',
          style: {
            "line-color": "#3aa0a0",
            "line-style": "dashed",
            width: 0.8,
            "curve-style": "bezier",
          },
        },
      ],
      layout: {
        name: "fcose",
        animate: false,
        randomize: true,
        nodeRepulsion: 6000,
        idealEdgeLength: 80,
      } as cytoscape.LayoutOptions,
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
      style={{ width: "100vw", height: "100vh", background: "#0d0d0e" }}
    />
  );
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}
