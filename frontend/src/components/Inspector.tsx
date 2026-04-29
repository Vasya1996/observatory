/**
 * Inspector — slide-in pane on the right side of the Map and Simulator views.
 *
 * Shows a per-kind breakdown of the currently-selected FileEntry. Sections are
 * picked based on `f.kind`; every kind also gets the common claude_md base
 * (frontmatter, outbound + inbound references, file metadata, hook fan-in).
 *
 * Design language anchored to the locked mockup
 * (`/home/voxdecaelo/claude-dashboard-design/index.html`, lines 265-303 and
 * 978-1008): 360px wide, --ink-2 background, --line border, IBM Plex Sans
 * 16px header, JetBrains Mono uppercase section labels, dashed --line-soft
 * between reference rows.
 *
 * Selection wiring (locked rule #24): the store's selectedId is the single
 * source of truth. Tapping a node in GraphCanvas writes to it; clicking a
 * reference row in the inspector also writes to it (and centers the graph
 * via cy.center). When the inspector closes (× button), selectedId is kept
 * so the next open restores last context.
 */
import { useEffect, useMemo, useState } from "react";
import type cytoscape from "cytoscape";
import { useStore } from "../state/store";
import { computeAmbiguousBasenames, displayLabel } from "./labels";
import type { Edge, FileEntry, FileKind, Issue, LoadStatus } from "../types";

interface Props {
  // Live cytoscape core. When provided AND a selection exists, clicking a
  // reference row in the Inspector centers the new node in the canvas. Null
  // in tree mode is OK — the graph still re-selects, we just skip the
  // viewport tween.
  cy: cytoscape.Core | null;
  // Per-cwd load status keyed by file_id. Used to render the status chip in
  // the header.
  statusMap: Map<string, LoadStatus> | null;
}

const KIND_LABEL: Record<FileKind, string> = {
  claude_md: "claude.md",
  rule: "rule",
  memory: "memory",
  memory_index: "memory index",
  skill: "skill",
  plugin_manifest: "plugin",
  plugin_registry: "plugin registry",
  mcp: "mcp",
  settings: "settings",
  automemory: "auto-memory",
  script: "script",
};

// Per-kind chip color. Anchored to existing tokens — amber/teal/rose/paper
// match the graph node palette so the chip carries the same colour code as
// the node itself.
const KIND_CHIP_COLOR: Record<FileKind, string> = {
  claude_md: "var(--amber)",
  rule: "var(--amber)",
  memory: "var(--paper)",
  memory_index: "var(--paper)",
  skill: "var(--paper-dim)",
  plugin_manifest: "var(--paper-dim)",
  plugin_registry: "var(--paper-dim)",
  mcp: "var(--paper-dim)",
  settings: "var(--paper-dim)",
  automemory: "var(--paper-faint)",
  script: "var(--rose)",
};

const SEVERITY_COLOR: Record<Issue["severity"], string> = {
  error: "var(--rust)",
  warning: "var(--amber)",
  info: "var(--teal)",
};

const STATUS_LABEL: Record<LoadStatus, string> = {
  loaded: "loaded",
  conditional: "conditional",
  skipped: "on-demand",
  orphan: "orphan",
  unknown: "no cwd",
};

const STATUS_COLOR: Record<LoadStatus, string> = {
  loaded: "var(--lime)",
  conditional: "var(--amber)",
  skipped: "var(--paper-dim)",
  orphan: "var(--paper-faint)",
  unknown: "var(--paper-faint)",
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatMtime(mtime: number): string {
  // mtime is unix seconds (float). Render as YYYY-MM-DD HH:mm to match the
  // mockup's "2026-04-19 · 11:02" tone.
  const d = new Date(mtime * 1000);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} · ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// --- small leaf components -------------------------------------------------

function Chip({
  label,
  color,
  border,
  title,
  onClick,
}: {
  label: string;
  color?: string;
  border?: string;
  title?: string;
  onClick?: () => void;
}) {
  return (
    <span
      className="insp-chip"
      title={title}
      onClick={onClick}
      style={{
        color: color ?? "var(--paper-dim)",
        borderColor: border ?? "var(--line)",
        cursor: onClick ? "pointer" : "default",
      }}
    >
      {label}
    </span>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return <h5 className="insp-section-h">{children}</h5>;
}

// Reference list row — clickable, jumps to target via setSelection +
// optionally centers the graph.
function RefRow({
  arrow,
  label,
  meta,
  onClick,
}: {
  arrow: "out" | "in";
  label: string;
  meta?: string;
  onClick: () => void;
}) {
  return (
    <li className="insp-ref-row" onClick={onClick}>
      <span className={`insp-ref-arr ${arrow}`}>→</span>
      <span className="insp-ref-label">{label}</span>
      {meta && <span className="insp-ref-meta">{meta}</span>}
    </li>
  );
}

// Frontmatter <dl> — flat key/value rows. Stringifies non-trivial values.
function FrontmatterDL({ fm }: { fm: Record<string, unknown> | null }) {
  if (!fm) return null;
  const entries = Object.entries(fm);
  if (entries.length === 0) return null;
  return (
    <dl className="insp-fm">
      {entries.map(([k, v]) => (
        <div className="insp-fm-row" key={k}>
          <dt className="insp-fm-k">{k}</dt>
          <dd className="insp-fm-v">{stringifyFmValue(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

function stringifyFmValue(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

// --- main component --------------------------------------------------------

export function Inspector({ cy, statusMap }: Props) {
  const files = useStore((s) => s.files);
  const edges = useStore((s) => s.edges);
  const selectedId = useStore((s) => s.selectedId);
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  const setInspectorOpen = useStore((s) => s.setInspectorOpen);
  const select = useStore((s) => s.select);

  const file = useMemo(
    () => files.find((f) => f.id === selectedId) ?? null,
    [files, selectedId],
  );

  const ambiguous = useMemo(() => computeAmbiguousBasenames(files), [files]);

  // Outbound + inbound edges for the selected file. Pre-grouped by kind so
  // sections render in a fixed order (import → mention → hook).
  const { outbound, inbound } = useMemo(() => {
    if (!selectedId) return { outbound: [], inbound: [] };
    const out: Edge[] = [];
    const inc: Edge[] = [];
    for (const e of edges) {
      if (e.source === selectedId) out.push(e);
      if (e.target === selectedId) inc.push(e);
    }
    return { outbound: out, inbound: inc };
  }, [edges, selectedId]);

  // File-id → FileEntry lookup for resolving edge endpoints to display labels.
  const fileById = useMemo(() => {
    const m = new Map<string, FileEntry>();
    for (const f of files) m.set(f.id, f);
    return m;
  }, [files]);

  // Per-kind extra: MCP needs the raw file content to surface server names.
  // Fetched on-demand when a .mcp.json file lands in the inspector — the
  // /api/index payload doesn't carry the parsed servers.
  const [mcpServers, setMcpServers] = useState<string[] | null>(null);
  useEffect(() => {
    setMcpServers(null);
    if (!file || file.kind !== "mcp") return;
    let cancelled = false;
    fetch(`/api/file?path=${encodeURIComponent(file.path)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`/api/file ${r.status}`))))
      .then((res) => {
        if (cancelled) return;
        try {
          const parsed = JSON.parse(res.content ?? "{}");
          const servers = parsed?.mcpServers ?? {};
          setMcpServers(Object.keys(servers));
        } catch {
          setMcpServers([]);
        }
      })
      .catch(() => {
        if (!cancelled) setMcpServers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [file]);

  // Click on a reference row: re-select the target, then (graph mode only)
  // center the new node in the viewport so the user can see the connection.
  const jumpTo = (id: string) => {
    select(id);
    if (cy) {
      const target = cy.getElementById(id);
      if (target.nonempty()) {
        // Centering rather than fit/zoom — keeps user's zoom level intact.
        cy.center(target);
      }
    }
  };

  // Hook edges pointing AT this file (settings/plugin → script). Surfaces
  // lifecycle events so the user can see "this script fires on Stop +
  // PreToolUse" without leaving the inspector. Mission alignment: the
  // "no black boxes" principle — if a hook runs because of this file, the
  // user gets to see WHY here.
  const hooksFiringHere = useMemo(
    () => inbound.filter((e) => e.kind === "hook"),
    [inbound],
  );

  // Status of the selected file under the active cwd. May be null when no
  // cwd is selected; falls back to `unknown` chip.
  const fileStatus: LoadStatus | null = file && statusMap
    ? (statusMap.get(file.id) ?? null)
    : null;

  return (
    <aside
      className={`inspector-pane${inspectorOpen ? " open" : ""}`}
      aria-hidden={!inspectorOpen}
    >
      {file ? (
        <InspectorBody
          file={file}
          ambiguous={ambiguous}
          outbound={outbound}
          inbound={inbound}
          fileById={fileById}
          mcpServers={mcpServers}
          hooksFiringHere={hooksFiringHere}
          fileStatus={fileStatus}
          onClose={() => setInspectorOpen(false)}
          onJump={jumpTo}
        />
      ) : selectedId ? (
        // Edge case: a selection exists but the file isn't in the index — most
        // likely a watcher reindex removed it. Show an empty state instead of
        // silently rendering nothing.
        <EmptyState
          title="File no longer in index"
          subtitle="The selected file was removed by the watcher. Pick another node."
          onClose={() => setInspectorOpen(false)}
        />
      ) : (
        <EmptyState
          title="Nothing selected"
          subtitle="Click a node to inspect its frontmatter, references, and load status."
          onClose={() => setInspectorOpen(false)}
        />
      )}
    </aside>
  );
}

// --- body ------------------------------------------------------------------

interface BodyProps {
  file: FileEntry;
  ambiguous: Set<string>;
  outbound: Edge[];
  inbound: Edge[];
  fileById: Map<string, FileEntry>;
  mcpServers: string[] | null;
  hooksFiringHere: Edge[];
  fileStatus: LoadStatus | null;
  onClose: () => void;
  onJump: (id: string) => void;
}

function InspectorBody({
  file,
  ambiguous,
  outbound,
  inbound,
  fileById,
  mcpServers,
  hooksFiringHere,
  fileStatus,
  onClose,
  onJump,
}: BodyProps) {
  const label = displayLabel(file, ambiguous);
  const writableLabel = file.writable ? "editable" : "readonly";
  const writableColor = file.writable ? "var(--lime)" : "var(--paper-faint)";

  return (
    <div className="insp-body">
      {/* HEADER ---------------------------------------------------------- */}
      <header className="insp-head">
        <div className="insp-head-top">
          <h3 className="insp-name">{label}</h3>
          <button
            type="button"
            className="insp-close"
            onClick={onClose}
            aria-label="Close inspector"
            title="Close inspector"
          >
            ×
          </button>
        </div>
        <div className="insp-path">{file.display}</div>
        <div className="insp-chips">
          <Chip
            label={KIND_LABEL[file.kind]}
            color={KIND_CHIP_COLOR[file.kind]}
            border="var(--line)"
          />
          <Chip label={writableLabel} color={writableColor} />
          {fileStatus && (
            <Chip
              label={STATUS_LABEL[fileStatus]}
              color={STATUS_COLOR[fileStatus]}
            />
          )}
          {file.cached_versions && file.cached_versions > 1 && (
            <Chip
              label={`${file.cached_versions} cached versions`}
              title="Number of plugin snapshots collapsed under this representative"
            />
          )}
        </div>
      </header>

      {/* VALIDATION CHIPS ---------------------------------------------- */}
      {file.validation.length > 0 && (
        <div className="insp-validation">
          {file.validation.map((v, i) => (
            <Chip
              key={i}
              label={v.code}
              color={SEVERITY_COLOR[v.severity]}
              title={
                v.line != null
                  ? `${v.code} · L${v.line}\n${v.message}`
                  : `${v.code}\n${v.message}`
              }
            />
          ))}
        </div>
      )}

      {/* PER-KIND LEAD BLOCK (rule/memory/skill/mcp/plugin) ----------- */}
      <KindLead file={file} mcpServers={mcpServers} />

      {/* FRONTMATTER -------------------------------------------------- */}
      {file.frontmatter && Object.keys(file.frontmatter).length > 0 && (
        <section className="insp-section">
          <SectionHeader>Frontmatter</SectionHeader>
          <FrontmatterDL fm={file.frontmatter} />
        </section>
      )}

      {/* OUTBOUND REFERENCES ----------------------------------------- */}
      <RefSection
        title={`Outbound references · ${outbound.length}`}
        arrow="out"
        edges={outbound}
        fileById={fileById}
        endpointKey="target"
        onJump={onJump}
        emptyHint={outbound.length === 0 ? "No outbound references." : undefined}
      />

      {/* INBOUND REFERENCES ------------------------------------------ */}
      <RefSection
        title={`Referenced by · ${inbound.length}`}
        arrow="in"
        edges={inbound}
        fileById={fileById}
        endpointKey="source"
        onJump={onJump}
        emptyHint={inbound.length === 0 ? "Not referenced by any scanned file." : undefined}
      />

      {/* HOOKS FIRING HERE ------------------------------------------- */}
      {hooksFiringHere.length > 0 && (
        <section className="insp-section">
          <SectionHeader>Hook events firing here</SectionHeader>
          <ul className="insp-hooks">
            {hooksFiringHere.map((e) => {
              const src = fileById.get(e.source);
              const events = (e.events ?? []).join(", ");
              return (
                <li key={e.id} className="insp-hook-row">
                  <span className="insp-hook-events">
                    {events || "(no events)"}
                  </span>
                  <span className="insp-hook-src">
                    from {src ? displayLabelOrPath(src) : e.source}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* PER-KIND TRAILING HINTS ------------------------------------- */}
      <KindHints kind={file.kind} />

      {/* FILE METADATA ----------------------------------------------- */}
      <section className="insp-section insp-meta-section">
        <SectionHeader>File</SectionHeader>
        <div className="insp-meta-row">
          <span className="k">size</span>
          <span className="v">{formatBytes(file.size_bytes)} · {file.line_count} lines</span>
        </div>
        <div className="insp-meta-row">
          <span className="k">last edited</span>
          <span className="v">{formatMtime(file.mtime)}</span>
        </div>
      </section>
    </div>
  );
}

function displayLabelOrPath(f: FileEntry): string {
  return f.display_name ?? f.display;
}

// --- per-kind lead blocks --------------------------------------------------

function KindLead({
  file,
  mcpServers,
}: {
  file: FileEntry;
  mcpServers: string[] | null;
}) {
  // RULE: paths_globs chips coloured by paths_status.
  if (file.kind === "rule" && file.paths_globs && file.paths_globs.length > 0) {
    const color =
      file.paths_status === "ok"
        ? "var(--lime)"
        : file.paths_status === "missing"
          ? "var(--rust)"
          : "var(--paper-faint)";
    return (
      <section className="insp-section">
        <SectionHeader>paths</SectionHeader>
        <div className="insp-chips">
          {file.paths_globs.map((g) => (
            <Chip key={g} label={g} color={color} title={`paths_status: ${file.paths_status}`} />
          ))}
        </div>
        {file.paths_status === "missing" && (
          <div className="insp-hint rust">← out of scope (paths_status=missing)</div>
        )}
      </section>
    );
  }

  // MEMORY: required-fields summary at the top so missing pieces surface
  // before you hit the full frontmatter dump.
  if (file.kind === "memory") {
    const fm = file.frontmatter ?? {};
    const required = ["name", "description", "type"] as const;
    return (
      <section className="insp-section">
        <SectionHeader>Memory frontmatter</SectionHeader>
        <div className="insp-chips">
          {required.map((k) => {
            const value = fm[k];
            const present = typeof value === "string" && value.length > 0;
            return (
              <Chip
                key={k}
                label={present ? `${k}: ${truncate(String(value), 24)}` : `${k}: missing`}
                color={present ? "var(--paper-dim)" : "var(--rust)"}
                title={present ? String(value) : `Required field "${k}" not set`}
              />
            );
          })}
          {file.scope && (
            <Chip
              label={`scope: ${file.scope}`}
              color="var(--paper-dim)"
              title="Filename-prefix scope (memory architecture)"
            />
          )}
        </div>
      </section>
    );
  }

  // SKILL: description value + folded-scalar warning if present.
  if (file.kind === "skill") {
    const fm = file.frontmatter ?? {};
    const desc = typeof fm.description === "string" ? fm.description : null;
    const foldedIssue = file.validation.find(
      (v) => v.code.startsWith("skill_frontmatter") || v.code.includes("folded"),
    );
    return (
      <section className="insp-section">
        <SectionHeader>Skill</SectionHeader>
        <div className="insp-skill-desc">
          {desc ?? <span className="faint">(no description)</span>}
        </div>
        {foldedIssue && (
          <div className="insp-warn-banner">
            folded scalar — Paperclip parser breaks. Auto-fix available in Phase 2.
          </div>
        )}
      </section>
    );
  }

  // PLUGIN_MANIFEST: nothing extra unless cached_versions > 1 (already in
  // header chip). Plugin display name is the header label, so this lead is
  // intentionally minimal.
  if (file.kind === "plugin_manifest") {
    return null;
  }

  // MCP: list server names. Secrets rendered as-is per locked rule #27 — but
  // here we only show names; the full config is inspected via the file viewer.
  if (file.kind === "mcp") {
    return (
      <section className="insp-section">
        <SectionHeader>MCP servers</SectionHeader>
        {mcpServers === null ? (
          <div className="insp-hint">loading…</div>
        ) : mcpServers.length === 0 ? (
          <div className="insp-hint">No servers defined.</div>
        ) : (
          <ul className="insp-mcp-list">
            {mcpServers.map((name) => (
              <li key={name} className="insp-mcp-row">
                <span className="insp-mcp-dot" />
                {name}
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }

  return null;
}

function KindHints({ kind }: { kind: FileKind }) {
  if (kind === "automemory") {
    return (
      <div className="insp-hint">
        Read-only — managed by Claude Code.
      </div>
    );
  }
  if (kind === "script") {
    return (
      <div className="insp-hint">
        Hook target — edit Claude Code settings to change.
      </div>
    );
  }
  return null;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// --- reference section -----------------------------------------------------

interface RefSectionProps {
  title: string;
  arrow: "out" | "in";
  edges: Edge[];
  fileById: Map<string, FileEntry>;
  endpointKey: "source" | "target";
  onJump: (id: string) => void;
  emptyHint?: string;
}

function RefSection({
  title,
  arrow,
  edges,
  fileById,
  endpointKey,
  onJump,
  emptyHint,
}: RefSectionProps) {
  // Group edges by kind so import / mention / hook each get their own
  // sub-list — readers scan by relation type first, by target second.
  const grouped = useMemo(() => {
    const map: Record<string, Edge[]> = {};
    for (const e of edges) {
      (map[e.kind] ??= []).push(e);
    }
    return map;
  }, [edges]);

  const ORDER: Edge["kind"][] = ["import", "mention", "hook"];

  return (
    <section className="insp-section">
      <SectionHeader>{title}</SectionHeader>
      {edges.length === 0 ? (
        emptyHint && <div className="insp-hint">{emptyHint}</div>
      ) : (
        ORDER.map((kind) => {
          const list = grouped[kind];
          if (!list || list.length === 0) return null;
          return (
            <div className="insp-ref-group" key={kind}>
              <div className="insp-ref-group-h">{kind}</div>
              <ul className="insp-ref-list">
                {list.map((e) => {
                  const otherId = endpointKey === "target" ? e.target : e.source;
                  const other = fileById.get(otherId);
                  // Edge may dangle if the index reindexed mid-render — fall
                  // back to the raw id rather than crashing.
                  const label = other ? displayLabelOrPath(other) : otherId;
                  const meta = formatEdgeMeta(e);
                  return (
                    <RefRow
                      key={e.id}
                      arrow={arrow}
                      label={label}
                      meta={meta}
                      onClick={() => onJump(otherId)}
                    />
                  );
                })}
              </ul>
            </div>
          );
        })
      )}
    </section>
  );
}

// Render the meta column for a reference row. Imports + mentions show line
// numbers (first 6); hooks show the lifecycle events instead — matches
// EdgeInfo's existing language so the inspector stays consistent.
function formatEdgeMeta(e: Edge): string {
  if (e.kind === "hook") {
    const events = e.events ?? [];
    if (events.length === 0) return "hook";
    return events.join(" · ");
  }
  const lines = e.lines ?? [];
  if (lines.length === 0) return e.kind;
  const shown = lines.slice(0, 6);
  const tail = lines.length > 6 ? ` +${lines.length - 6}` : "";
  return `L${shown.join(", L")}${tail}`;
}

// --- empty state -----------------------------------------------------------

function EmptyState({
  title,
  subtitle,
  onClose,
}: {
  title: string;
  subtitle: string;
  onClose: () => void;
}) {
  return (
    <div className="insp-body">
      <header className="insp-head">
        <div className="insp-head-top">
          <h3 className="insp-name dim">{title}</h3>
          <button
            type="button"
            className="insp-close"
            onClick={onClose}
            aria-label="Close inspector"
          >
            ×
          </button>
        </div>
        <div className="insp-path">{subtitle}</div>
      </header>
    </div>
  );
}
