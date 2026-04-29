import type { Edge, FileEntry } from "../types";
import { computeAmbiguousBasenames, displayLabel } from "./labels";

interface Props {
  edge: Edge | null;
  files: FileEntry[];
}

const KIND_COLOR: Record<string, string> = {
  import: "#f0a83a",
  mention: "#5da39a",
  hook: "#e89bb0",
};

const KIND_ARROW: Record<string, string> = {
  import: "→ @import →",
  mention: "→ mention →",
  hook: "→ hook →",
};

// Floating info card for a hovered edge. Sits bottom-left of the map canvas
// so it doesn't follow the cursor (would need mousemove tracking) but stays
// readable at a glance. Shows direction, kind, count/events, and the source
// lines the resolver collapsed into the single curve.
export function EdgeInfo({ edge, files }: Props) {
  if (!edge) return null;
  const src = files.find((f) => f.id === edge.source);
  const tgt = files.find((f) => f.id === edge.target);
  if (!src || !tgt) return null;
  const ambiguous = computeAmbiguousBasenames(files);

  const count = edge.lines.length;
  const linesText = edge.lines.length
    ? edge.lines.length <= 6
      ? `line${count > 1 ? "s" : ""} ${edge.lines.join(", ")}`
      : `lines ${edge.lines.slice(0, 5).join(", ")}, +${edge.lines.length - 5} more`
    : null;

  // Hook edges replace count/lines with the lifecycle event names — those
  // ARE the relation. A statusLine command and a Stop hook to the same target
  // would be one edge with `events: ["Stop", "statusLine"]`.
  const detail =
    edge.kind === "hook"
      ? `${(edge.events ?? []).length || 0} event${(edge.events ?? []).length === 1 ? "" : "s"}` +
        ((edge.events ?? []).length ? ` · ${(edge.events ?? []).join(", ")}` : "")
      : `${count} ${edge.kind}${count === 1 ? "" : "s"}${linesText ? ` · ${linesText}` : ""}`;

  return (
    <div
      style={{
        position: "absolute",
        left: 16,
        bottom: 16,
        zIndex: 20,
        pointerEvents: "none",
        background: "rgba(11, 11, 14, 0.92)",
        border: "1px solid #23232c",
        borderRadius: 6,
        padding: "8px 12px",
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: 11,
        color: "#e8e4d8",
        maxWidth: 520,
        lineHeight: 1.5,
      }}
    >
      <div style={{ color: "#b9b4a6" }}>
        <span>{displayLabel(src, ambiguous)}</span>
        <span style={{ margin: "0 6px", color: KIND_COLOR[edge.kind] ?? "#b9b4a6" }}>
          {KIND_ARROW[edge.kind] ?? `→ ${edge.kind} →`}
        </span>
        <span>{displayLabel(tgt, ambiguous)}</span>
      </div>
      <div style={{ color: "#6e6a5e", marginTop: 2 }}>{detail}</div>
    </div>
  );
}
