import { useEffect, useRef } from "react";
import { useStore } from "../state/store";

// Map legend overlay — top-right of .map-canvas-area (locked rule #60).
// Collapsed = 28×28 circular "?" button. Expanded = 320px panel listing every
// visual element with a swatch + description. State persisted via UiState.legend_open.

export function LegendOverlay() {
  const legendOpen = useStore((s) => s.legendOpen);
  const setLegendOpen = useStore((s) => s.setLegendOpen);
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on Esc key.
  useEffect(() => {
    if (!legendOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setLegendOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [legendOpen, setLegendOpen]);

  // Close on outside click.
  useEffect(() => {
    if (!legendOpen) return;
    function onMouseDown(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setLegendOpen(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [legendOpen, setLegendOpen]);

  return (
    <div
      ref={panelRef}
      style={{
        position: "absolute",
        top: 12,
        right: 12,
        zIndex: 35,
      }}
    >
      {!legendOpen ? (
        <button
          className="legend-toggle-btn"
          onClick={() => setLegendOpen(true)}
          title="Show map legend"
          aria-label="Show map legend"
          aria-expanded={false}
        >
          ?
        </button>
      ) : (
        <div className="legend-panel" role="dialog" aria-label="Map legend">
          <div className="legend-head">
            <span className="legend-head-label">Map Legend</span>
            <button
              className="legend-close"
              onClick={() => setLegendOpen(false)}
              aria-label="Close legend"
            >
              ×
            </button>
          </div>
          <div className="legend-body">
            <div className="legend-section-label">Nodes</div>
            <LegendRow
              swatch={<NodeSwatch color="var(--amber)" border="1.5px solid var(--paper)" />}
              text="File loaded into the active cwd's session context (CLAUDE.md / rule / memory via @-import / auto-memory)"
            />
            <LegendRow
              swatch={<NodeSwatch color="var(--paper-warm, #e8e4d8)" border="1.5px solid var(--paper)" />}
              text="Same as above, but for memory files and MEMORY.md (paper fill by convention)"
            />
            <LegendRow
              swatch={<NodeSwatch color="#3a3a40" border="1.5px dashed var(--paper-faint)" />}
              text="Conditional: paths:-scoped rule not triggered for this cwd — may activate for another"
            />
            <LegendRow
              swatch={<NodeSwatch color="#3a3a40" border="none" />}
              text="Reachable via @-import / mention but not auto-loaded"
            />
            <LegendRow
              swatch={<NodeSwatch color="#1f1f24" border="none" />}
              text="Orphan: outside every load chain, loaded only when opened manually"
            />
            <LegendRow
              swatch={<IconNodeSwatch glyph={scrollPath} />}
              text="Skill (SKILL.md) — body loaded only when the skill is invoked"
            />
            <LegendRow
              swatch={<IconNodeSwatch glyph={plugPath} />}
              text="Plugin or plugin manifest"
            />
            <LegendRow
              swatch={<IconNodeSwatch glyph={gearPath} />}
              text="settings.json or .mcp.json"
            />
            <LegendRow
              swatch={<IconNodeSwatch glyph={codePath} />}
              text="Hook script (sh/py/js)"
            />
            <LegendRow
              swatch={<IconNodeSwatch glyph={lockPath} />}
              text="Auto-memory written by Claude Code (~/.claude/projects/<project>/memory/)"
            />
            <LegendRow
              swatch={<NodeSwatch color="#23232c" border="1px dashed var(--paper-faint)" label="▸" />}
              text="Folder node — collapsed group of same-kind files; hover to expand"
            />
            <div className="legend-section-label" style={{ marginTop: 10 }}>Edges</div>
            <LegendRow
              swatch={<EdgeSwatch color="var(--amber)" dashed={false} />}
              text="@-import (one file explicitly loads another)"
            />
            <LegendRow
              swatch={<EdgeSwatch color="var(--teal)" dashed={false} />}
              text="Mention (basename.md referenced in text)"
            />
            <LegendRow
              swatch={<EdgeSwatch color="var(--rose)" dashed={false} />}
              text="Hook (lifecycle callback registered in settings)"
            />
            <LegendRow
              swatch={<EdgeSwatch color="var(--amber)" dashed={true} />}
              text="Incoming @-import / mention / hook (direction highlighted on hover)"
            />
            <LegendRow
              swatch={<CountBadgeSwatch />}
              text="Mention count >1 on edge — signals duplicate references worth reviewing"
            />
          </div>
        </div>
      )}
    </div>
  );
}

function LegendRow({ swatch, text }: { swatch: React.ReactNode; text: string }) {
  return (
    <div className="legend-row">
      <div className="legend-swatch">{swatch}</div>
      <div className="legend-text">{text}</div>
    </div>
  );
}

function NodeSwatch({
  color,
  border,
  label,
}: {
  color: string;
  border: string;
  label?: string;
}) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <circle
        cx="9"
        cy="9"
        r="7"
        fill={color}
        stroke={border === "none" ? "none" : undefined}
        style={border !== "none" ? { stroke: "none" } : undefined}
      />
      {border !== "none" && (
        <circle
          cx="9"
          cy="9"
          r="7"
          fill="none"
          style={{
            stroke: border.includes("dashed") ? "var(--paper-faint)" : "var(--paper)",
            strokeWidth: 1.5,
            strokeDasharray: border.includes("dashed") ? "3 2" : undefined,
          }}
        />
      )}
      {label && (
        <text
          x="9"
          y="12"
          textAnchor="middle"
          fontSize="8"
          fill="var(--paper)"
          fontFamily="JetBrains Mono, monospace"
        >
          {label}
        </text>
      )}
    </svg>
  );
}

function IconNodeSwatch({ glyph }: { glyph: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <circle cx="9" cy="9" r="7" fill="#23232c" />
      <g
        transform="translate(4.5, 4.5) scale(0.375)"
        dangerouslySetInnerHTML={{
          __html: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--paper-faint)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${glyph}</svg>`,
        }}
      />
    </svg>
  );
}

function EdgeSwatch({ color, dashed }: { color: string; dashed: boolean }) {
  return (
    <svg width="28" height="18" viewBox="0 0 28 18" aria-hidden>
      <line
        x1="2"
        y1="9"
        x2="26"
        y2="9"
        stroke={color}
        strokeWidth="1.6"
        strokeDasharray={dashed ? "4 3" : undefined}
        opacity={dashed ? 0.7 : 0.85}
      />
      {!dashed && (
        <polygon
          points="26,9 21,6 21,12"
          fill={color}
          opacity={0.85}
        />
      )}
    </svg>
  );
}

function CountBadgeSwatch() {
  return (
    <svg width="28" height="18" viewBox="0 0 28 18" aria-hidden>
      <line x1="2" y1="9" x2="26" y2="9" stroke="var(--teal)" strokeWidth="1.6" opacity={0.55} />
      <rect x="9" y="4" width="10" height="10" rx="2" fill="#23232c" stroke="var(--paper-faint)" strokeWidth="0.5" />
      <text x="14" y="12" textAnchor="middle" fontSize="7" fill="var(--paper)" fontFamily="JetBrains Mono, monospace">3</text>
    </svg>
  );
}

// SVG path data for icon glyphs (same as ICON_PATH_BY_KIND sources).
const scrollPath =
  '<path d="M8 21h12a2 2 0 0 0 2-2v-2H10v2a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v3h4"/><path d="M19 3H4.5C3.12 3 2 4.12 2 5.5"/><path d="M19 3a2 2 0 1 1 0 4H10"/><path d="M10 7v14"/>';

const plugPath =
  '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8H6a2 2 0 0 0-2 2v3a6 6 0 0 0 12 0V10a2 2 0 0 0-2-2Z"/>';

const gearPath =
  '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>';

const codePath =
  '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>';

const lockPath =
  '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>';
