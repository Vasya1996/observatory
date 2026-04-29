import type { ZoneMap } from "../tree/buildTreePositions";

interface Props {
  // Per-node zone assignment from buildTreePositions. Drives both segment
  // sizing (count of files per zone) and the small uppercase labels above each
  // segment. Null when tree-mode hasn't computed a layout yet (e.g. files have
  // not loaded) — component renders an empty bar so the surface stays stable.
  zones: ZoneMap | null;
}

// Top-of-canvas budget strip surfaced in tree mode only. Three segments —
// user / project / settings — sized in proportion to the number of files
// claimed by each zone. The orphan zone is intentionally absent: it is the
// "left-overs catch-all" and not part of the loaded budget by definition.
//
// Why count, not est_tokens: SimulatorResponse.stats.est_tokens is a single
// roll-up — it does not break down by zone, and doing so frontend-side would
// require re-implementing the simulator's tokenization logic (locked rule
// #30: backend untouched). File count is honest and matches what the user
// counts on the canvas.
//
// Colours mirror the chain layers each zone owns: amber for user (autoload
// chain), teal for project (mention-edge teal — project layer), rose for
// settings (hook-edge rose). Same palette already used elsewhere in the map
// for the corresponding edge kinds.
//
// Sizing: 4px bar height + a small (9px) JetBrains-Mono uppercase label row
// above. Horizontal 16px padding so the strip aligns with the corner zone
// labels (top-left "USER LAYER", top-right "PROJECT LAYER"). 1px gap between
// segments — rendered as flex `gap` so the bar background (--ink) shows
// through; gap colour is therefore implicit (no extra DOM).
export function TokenBudgetBar({ zones }: Props) {
  let userCount = 0;
  let projectCount = 0;
  let settingsCount = 0;
  if (zones) {
    for (const z of zones.values()) {
      if (z === "user") userCount++;
      else if (z === "project") projectCount++;
      else if (z === "settings") settingsCount++;
    }
  }
  const total = userCount + projectCount + settingsCount;

  const segments: { name: string; count: number; color: string }[] = [
    { name: "user", count: userCount, color: "var(--amber)" },
    { name: "project", count: projectCount, color: "var(--teal)" },
    { name: "settings", count: settingsCount, color: "var(--rose)" },
  ];

  return (
    <div
      style={{
        position: "absolute",
        top: 56,
        left: 0,
        right: 0,
        padding: "0 16px",
        zIndex: 4,
        pointerEvents: "none",
      }}
      aria-hidden
    >
      <div
        style={{
          display: "flex",
          gap: 1,
          marginBottom: 4,
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 9,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
        }}
      >
        {segments.map((s) => (
          <div
            key={s.name}
            style={{
              flex: total > 0 ? s.count : 1,
              minWidth: 0,
              color: s.color,
              opacity: 0.7,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "clip",
            }}
          >
            {s.name} · {s.count}
          </div>
        ))}
      </div>
      <div
        style={{
          display: "flex",
          gap: 1,
          height: 4,
          background: "var(--ink)",
        }}
      >
        {segments.map((s) => (
          <div
            key={s.name}
            style={{
              flex: total > 0 ? s.count : 1,
              minWidth: 0,
              background: s.color,
              height: "100%",
            }}
          />
        ))}
      </div>
    </div>
  );
}
