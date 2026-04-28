import type { Edge, FileEntry } from "../types";

interface Props {
  edge: Edge | null;
  files: FileEntry[];
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

function fileLabel(f: FileEntry): string {
  return f.display_name && f.display_name.length > 0
    ? f.display_name
    : basename(f.display);
}

// Floating info card for a hovered edge. Sits bottom-left of the map canvas
// so it doesn't follow the cursor (would need mousemove tracking) but stays
// readable at a glance. Shows direction, kind, count, and the source lines
// the resolver collapsed into the single curve.
export function EdgeInfo({ edge, files }: Props) {
  if (!edge) return null;
  const src = files.find((f) => f.id === edge.source);
  const tgt = files.find((f) => f.id === edge.target);
  if (!src || !tgt) return null;

  const count = edge.lines.length;
  const linesText = edge.lines.length
    ? edge.lines.length <= 6
      ? `line${count > 1 ? "s" : ""} ${edge.lines.join(", ")}`
      : `lines ${edge.lines.slice(0, 5).join(", ")}, +${edge.lines.length - 5} more`
    : null;

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
        <span>{fileLabel(src)}</span>
        <span style={{ margin: "0 6px", color: edge.kind === "import" ? "#f0a83a" : "#5da39a" }}>
          {edge.kind === "import" ? "→ @import →" : "→ mention →"}
        </span>
        <span>{fileLabel(tgt)}</span>
      </div>
      <div style={{ color: "#6e6a5e", marginTop: 2 }}>
        {count} {edge.kind === "import" ? "import" : "mention"}
        {count === 1 ? "" : "s"}
        {linesText ? ` · ${linesText}` : ""}
      </div>
    </div>
  );
}
