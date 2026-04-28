import { useEffect, useReducer } from "react";
import type cytoscape from "cytoscape";
import {
  ICON_PATH_BY_KIND,
  ICON_STROKE,
  ICON_STROKE_WIDTH,
  type NodeKind,
} from "./nodeIcons";

interface Props {
  cy: cytoscape.Core | null;
}

// Renders icon-kind glyphs as a sibling DOM layer above the cytoscape canvas,
// anchored to each node's renderedPosition. Replaces the old `background-image:
// data(iconUrl)` pipeline: cytoscape rasterises background SVGs onto its 2D
// canvas at the node's pixel size, producing subpixel rounding that read as
// off-centre. DOM SVG keeps the glyph as vector through the GPU compositor —
// pixel-honest at any zoom.
//
// Same render scheme as PinOverlay: requestAnimationFrame-coalesced
// re-renders on render/pan/zoom/drag, with `cy.destroyed()` guard in cleanup
// because GraphCanvas may tear cy down before our state-driven cleanup runs.
export function IconOverlay({ cy }: Props) {
  const [, force] = useReducer((v: number) => v + 1, 0);

  useEffect(() => {
    if (!cy) return;
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        force();
      });
    };
    cy.on("render pan zoom drag", schedule);
    cy.on("position", "node", schedule);
    return () => {
      if (!cy.destroyed()) {
        cy.off("render pan zoom drag", schedule);
        cy.off("position", "node", schedule);
      }
      if (frame) cancelAnimationFrame(frame);
    };
  }, [cy]);

  if (!cy) return null;

  const items: { id: string; x: number; y: number; w: number; inner: string }[] = [];
  cy.nodes().forEach((n) => {
    // Collapsed children are styled `display: none` — cy.nodes() still
    // returns them, so skip explicitly to avoid drawing icons at the folder's
    // position while the halo is collapsed.
    if (n.hasClass("folded")) return;
    const inner = ICON_PATH_BY_KIND[n.data("kind") as NodeKind];
    if (!inner) return;
    const p = n.renderedPosition();
    const w = n.renderedOuterWidth();
    items.push({ id: n.id(), x: p.x, y: p.y, w, inner });
  });

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        overflow: "hidden",
        zIndex: 5,
      }}
      aria-hidden
    >
      {items.map(({ id, x, y, w, inner }) => (
        <div
          key={id}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: w,
            height: w,
            // Inset SVG inside the node circle so the glyph doesn't press
            // against the rim. ~14% padding leaves a ~3-4px dark ring at
            // ICON_SIZE=28 — SVG ends up ~72% of the circle.
            padding: w * 0.14,
            boxSizing: "border-box",
            transform: `translate(${x - w / 2}px, ${y - w / 2}px)`,
            willChange: "transform",
          }}
          dangerouslySetInnerHTML={{
            __html:
              `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" ` +
              `viewBox="0 0 24 24" fill="none" stroke="${ICON_STROKE}" ` +
              `stroke-width="${ICON_STROKE_WIDTH}" stroke-linecap="round" ` +
              `stroke-linejoin="round">${inner}</svg>`,
          }}
        />
      ))}
    </div>
  );
}
