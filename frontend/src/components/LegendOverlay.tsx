import { useEffect, useRef } from "react";
import { useStore } from "../state/store";
import { ICON_PATH_BY_KIND } from "./nodeIcons";

// Map legend overlay — bottom-right of .map-canvas-area (locked rule #60).
// Collapsed = small "MAP LEGEND ▴" pill. Expanded = 320px panel growing upward.
// State persisted via UiState.legend_open.

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
        bottom: 16,
        right: 16,
        zIndex: 35,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
      }}
    >
      {/* Body — only rendered when open; grows upward because panel is bottom-anchored */}
      {legendOpen && (
        <div
          className="legend-panel"
          role="dialog"
          aria-label="Map legend"
          style={{ marginBottom: 4 }}
        >
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
              text="Auto-loaded — CLAUDE.md / rule / MEMORY.md pulled into the active cwd's session context (matches the 'Also loaded for this folder' list 1:1)"
            />
            <LegendRow
              swatch={<NodeSwatch color="var(--paper-warm, #e8e4d8)" border="none" />}
              text="Memory file (~/.claude/knowledge/*.md) — referenced from MEMORY.md, read on demand, NOT auto-loaded"
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
              swatch={<IconNodeSwatch glyph={ICON_PATH_BY_KIND.skill!} />}
              text="Skill (SKILL.md) — body loaded only when the skill is invoked"
            />
            <LegendRow
              swatch={<IconNodeSwatch glyph={ICON_PATH_BY_KIND.plugin_manifest!} />}
              text="Plugin or plugin manifest"
            />
            <LegendRow
              swatch={<IconNodeSwatch glyph={ICON_PATH_BY_KIND.settings!} />}
              text="settings.json or .mcp.json"
            />
            <LegendRow
              swatch={<IconNodeSwatch glyph={ICON_PATH_BY_KIND.script!} />}
              text="Hook script (sh/py/js)"
            />
            <LegendRow
              swatch={<IconNodeSwatch glyph={ICON_PATH_BY_KIND.automemory!} />}
              text="Auto-memory written by Claude Code (~/.claude/projects/<project>/memory/)"
            />
            <LegendRow
              swatch={<IconNodeSwatch glyph={ICON_PATH_BY_KIND.folder!} />}
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
              text="Incoming @-import (hovered, direction reversed)"
            />
            <LegendRow
              swatch={<EdgeSwatch color="var(--teal)" dashed={true} />}
              text="Incoming mention (hovered, direction reversed)"
            />
            <LegendRow
              swatch={<EdgeSwatch color="var(--rose)" dashed={true} />}
              text="Incoming hook (hovered, direction reversed)"
            />
            <LegendRow
              swatch={<CountBadgeSwatch />}
              text="Mention count >1 on edge — signals duplicate references worth reviewing"
            />
          </div>
        </div>
      )}

      {/* Persistent pill header — always visible; caret flips on open/close */}
      <button
        className="legend-collapsed-head"
        onClick={() => setLegendOpen(!legendOpen)}
        aria-label={legendOpen ? "Collapse legend" : "Expand legend"}
        aria-expanded={legendOpen}
      >
        <span>MAP LEGEND</span>
        <span className="legend-caret">{legendOpen ? "▾" : "▴"}</span>
      </button>
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
