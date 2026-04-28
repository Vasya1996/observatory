import { memo, useEffect, useReducer } from "react";
import type cytoscape from "cytoscape";
import { useStore } from "../state/store";

interface Props {
  cy: cytoscape.Core | null;
}

const PIN_W = 11;
const PIN_H = 13;
// Head circle bottom y in the rendered 11×13 box (svg cy=9, r=6, scaled 0.5).
const PIN_HEAD_BOTTOM = 7.5;

// Renders a small dark 3D pushpin SVG over the top-right corner of each
// pinned node. Cytoscape clips background-image to node shape, so the
// corner badge has to live in a sibling DOM layer above the canvas.
export function PinOverlay({ cy }: Props) {
  const pins = useStore((s) => s.pins);
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
      // GraphCanvas's cleanup may have already destroyed the instance by
      // the time React flushes our state-driven cleanup — cy.off on a dead
      // core is unreliable across cytoscape versions.
      if (!cy.destroyed()) {
        cy.off("render pan zoom drag", schedule);
        cy.off("position", "node", schedule);
      }
      if (frame) cancelAnimationFrame(frame);
    };
  }, [cy]);

  if (!cy) return null;

  const ids = Object.keys(pins);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        overflow: "hidden",
        zIndex: 10,
      }}
      aria-hidden
    >
      <PinDefs />
      {ids.map((id) => {
        const n = cy.getElementById(id);
        if (n.empty()) return null;
        // Don't draw the pushpin glyph for nodes that are collapsed inside a
        // folder-node halo — the underlying node still exists with its
        // restored pin position, but the icon is hidden until hover.
        if (n.hasClass("folded")) return null;
        const p = n.renderedPosition();
        const w = n.renderedOuterWidth();
        const h = n.renderedOuterHeight();
        // Anchor the pin head's visual centre on the NE rim of the node
        // circle (45° from centre). Stem hangs down-left into the node, so
        // the lower portion of the SVG overlaps the rim — the "sits on the
        // rim" intent — while the head remains visible outside.
        const rim = (Math.SQRT1_2 * w) / 2;
        const x = p.x + rim - PIN_W / 2;
        const y = p.y - rim - PIN_HEAD_BOTTOM;
        return (
          <div
            key={id}
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              transform: `translate(${x}px, ${y}px)`,
              willChange: "transform",
            }}
          >
            <Pushpin />
          </div>
        );
      })}
    </div>
  );
}

const PinDefs = memo(function PinDefs() {
  return (
    <svg
      style={{ position: "absolute", width: 0, height: 0 }}
      aria-hidden
    >
      <defs>
        {/* Light-on-dark gradient: highlight = paper-dim, shadow = line. */}
        <linearGradient id="obs-pinhead" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#b9b4a6" />
          <stop offset="100%" stopColor="#23232c" />
        </linearGradient>
      </defs>
    </svg>
  );
});

function Pushpin() {
  return (
    <svg
      width="11"
      height="13"
      viewBox="0 0 22 26"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M11 14.5 L8.5 24"
        stroke="#6e6a5e"
        strokeWidth="1.6"
        strokeLinecap="round"
        fill="none"
      />
      <circle cx="11" cy="9" r="6" fill="url(#obs-pinhead)" />
      <ellipse cx="8.5" cy="7" rx="2" ry="1.4" fill="#e8e4d8" opacity="0.55" />
    </svg>
  );
}
