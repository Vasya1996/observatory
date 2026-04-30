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
import YAML from "yaml";
import { useStore } from "../state/store";
import { fetchCwds, fetchFile } from "../api/client";
import { useWritePipeline } from "../hooks/useWritePipeline";
import { computeAmbiguousBasenames, displayLabel } from "./labels";
import { RuleWizardModal } from "./RuleWizardModal";
import type {
  CwdEntry,
  Edge,
  FileEntry,
  FileKind,
  Issue,
  LoadStatus,
} from "../types";

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
  conditional: "may load",
  skipped: "available on demand",
  orphan: "not loaded",
  unknown: "no project selected",
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
          subtitle="Click any file to see who loads it, what it links to, and whether Claude reads it."
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

      {/* MEMORY FRONTMATTER WRITER (memory kind only) ----------------- */}
      {file.kind === "memory" && <MemoryWriter file={file} />}

      {/* FRONTMATTER -------------------------------------------------- */}
      {file.frontmatter && Object.keys(file.frontmatter).length > 0 && (
        <section className="insp-section">
          <SectionHeader>File settings</SectionHeader>
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

      {/* + NEW RULE button (claude_md and rule kinds only) ----------- */}
      {(file.kind === "claude_md" || file.kind === "rule") && (
        <NewRuleLauncher origin={file} />
      )}
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
          <div className="insp-hint rust">← no matching files found for these patterns</div>
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
        <SectionHeader>Memory fields</SectionHeader>
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

  // SKILL: description value + folded-scalar warning if present, with Fix
  // button when the validator emitted a folded-scalar issue (locked rule #36 +
  // #37 — full DiffModal pipeline so multi-line YAML rewrites land
  // confirmable).
  if (file.kind === "skill") {
    const fm = file.frontmatter ?? {};
    const desc = typeof fm.description === "string" ? fm.description : null;
    const foldedIssue = file.validation.find(
      (v) =>
        v.code === "skill_description_folded" ||
        v.code.startsWith("skill_frontmatter") ||
        v.code.includes("folded"),
    );
    return (
      <section className="insp-section">
        <SectionHeader>Skill</SectionHeader>
        <div className="insp-skill-desc">
          {desc ?? <span className="faint">(no description)</span>}
        </div>
        {foldedIssue && <SkillFoldedFixRow file={file} />}
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
        Read-only — Claude Code manages this file automatically.
      </div>
    );
  }
  if (kind === "script") {
    return (
      <div className="insp-hint">
        This script runs when a hook fires. Edit Claude Code settings to change it.
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

// --- skill folded-scalar fix ------------------------------------------------

// Inline "Fix" button next to the folded-scalar warning. Clicks read the
// SKILL.md content via /api/file, re-serialize the frontmatter forcing the
// `description` field to a single-line quoted scalar, and route the rewrite
// through `useWritePipeline` (full DiffModal — multi-line content change).
function SkillFoldedFixRow({ file }: { file: FileEntry }) {
  const { requestWrite } = useWritePipeline();
  const pushToast = useStore((s) => s.pushToast);
  const [busy, setBusy] = useState(false);

  const onFix = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const fileRes = await fetchFile(file.path);
      const flattened = flattenSkillDescription(fileRes.content);
      if (flattened === null) {
        pushToast({
          kind: "info",
          message: "No folded scalar found — file may already be fixed.",
        });
        return;
      }
      if (flattened === fileRes.content) {
        pushToast({
          kind: "info",
          message: "No folded scalar found — file may already be fixed.",
        });
        return;
      }
      await requestWrite([
        {
          path: file.path,
          newContent: flattened,
          title: "Fix folded-scalar description",
        },
      ]);
    } catch (e) {
      pushToast({
        kind: "error",
        message: `Fix failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="insp-warn-banner insp-fix-row">
      <span>folded scalar — Paperclip parser breaks.</span>
      <button
        type="button"
        className="insp-fix-btn"
        onClick={onFix}
        disabled={busy}
        aria-label="Auto-fix folded-scalar description"
      >
        {busy ? "Reading…" : "Fix"}
      </button>
    </div>
  );
}

// Pure helper: take a SKILL.md file's full text, parse the frontmatter, and
// rewrite it so `description` is a quoted single-line string. Returns null
// when no frontmatter is present, returns the input unchanged when no folded
// scalar was used.
export function flattenSkillDescription(text: string): string | null {
  const match = /^(---\s*\n)([\s\S]*?)(\n---\s*\n?)([\s\S]*)$/.exec(text);
  if (!match) return null;
  const [, openFence, fmBlock, closeFence, body] = match;
  let parsed: unknown;
  try {
    parsed = YAML.parse(fmBlock);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const fm = parsed as Record<string, unknown>;
  if (typeof fm.description !== "string") {
    return null;
  }
  // Detect folded vs already-flat by scanning the raw frontmatter block. If
  // the description value's first non-space char isn't `>` or `|`, the file
  // already uses a flat string — return the original text untouched so the
  // caller can show the "already fixed" toast.
  const raw = /^[ \t]*description:\s*(.*)$/m.exec(fmBlock);
  const firstChar = raw ? raw[1].trimStart()[0] ?? "" : "";
  const wasFolded = firstChar === ">" || firstChar === "|";
  if (!wasFolded) {
    return text;
  }
  const flat = fm.description.replace(/\s+/g, " ").trim();
  // Re-serialise. We replace the original `description: > … <blank>` block
  // with `description: "<flat>"`. Use a regex with the m flag and a custom
  // matcher because YAML's full re-stringification re-orders fields and
  // re-flows whitespace — minimising the diff matters here.
  const before = fmBlock;
  // Match `description:` plus the rest of its block. A folded/literal scalar
  // ends at the first line that isn't more indented than the key. We match
  // greedily up to the next field at the same (or shallower) indent.
  const replaced = replaceDescriptionBlock(before, flat);
  if (replaced === before) return text; // already flat
  return openFence + replaced + closeFence + body;
}

// Replace the `description:` block in a frontmatter string with a quoted
// single-line form. Walks line-by-line so we can detect the end of an indented
// scalar block by hitting the next top-level (or shallower-indented) field.
function replaceDescriptionBlock(fmBlock: string, flat: string): string {
  const lines = fmBlock.split("\n");
  let startIdx = -1;
  let baseIndent = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^([ \t]*)description:/.exec(lines[i]);
    if (m) {
      startIdx = i;
      baseIndent = m[1].length;
      break;
    }
  }
  if (startIdx < 0) return fmBlock;
  let endIdx = lines.length;
  // Look for the first line AFTER startIdx whose indent is <= baseIndent and
  // which contains a `key:` at that indent.
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const indentMatch = /^([ \t]*)/.exec(line);
    const indent = indentMatch ? indentMatch[1].length : 0;
    if (indent <= baseIndent && /^[ \t]*[A-Za-z0-9_-]+:/.test(line)) {
      endIdx = i;
      break;
    }
  }
  const before = lines.slice(0, startIdx);
  const after = lines.slice(endIdx);
  const indentSpaces = " ".repeat(baseIndent);
  // Quote with double quotes; escape embedded `"` and `\\`.
  const escaped = flat.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const replacement = `${indentSpaces}description: "${escaped}"`;
  return [...before, replacement, ...after].join("\n");
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

// --- memory frontmatter writer ---------------------------------------------

const MEMORY_TYPES = ["feedback", "project", "reference", "user"] as const;
type MemoryType = (typeof MEMORY_TYPES)[number];

// MEMORY.md path derived at runtime from the file index — no hardcoded username.
// Falls back to a reasonable default so the write still works when the index
// hasn't loaded yet (the user won't reach MemoryWriter until the index is ready).
function resolveMemoryIndexPath(files: FileEntry[]): string {
  const found = files.find(
    (f) => f.kind === "memory_index" && f.path.endsWith("/MEMORY.md"),
  );
  if (found) return found.path;
  // Fallback: derive home from any file whose display starts with ~/
  for (const f of files) {
    if (f.display.startsWith("~/") && f.path.length > 2) {
      const suffix = f.display.slice(1);
      if (f.path.endsWith(suffix)) {
        const home = f.path.slice(0, f.path.length - suffix.length);
        return `${home}/.claude/knowledge/MEMORY.md`;
      }
    }
  }
  return "~/.claude/knowledge/MEMORY.md";
}

// Inline form rendered in the Inspector when a memory file is selected.
// Persists changes through the Phase 2 write pipeline as a multi-file patch
// (memory file frontmatter + MEMORY.md index line). Per Vasya's locked
// answer in jolly-sparking-spring.md Phase 2 #6: name (text) +
// description (text, 150-char hint) + type (enum dropdown).
function MemoryWriter({ file }: { file: FileEntry }) {
  const fm = (file.frontmatter ?? {}) as Record<string, unknown>;
  const initialName = typeof fm.name === "string" ? fm.name : "";
  const initialDescription =
    typeof fm.description === "string" ? fm.description : "";
  const initialType: MemoryType =
    typeof fm.type === "string" && (MEMORY_TYPES as readonly string[]).includes(fm.type)
      ? (fm.type as MemoryType)
      : "reference";

  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [type, setType] = useState<MemoryType>(initialType);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { requestWrite } = useWritePipeline();
  const pushToast = useStore((s) => s.pushToast);
  const allFiles = useStore((s) => s.files);
  const memoryIndexPath = resolveMemoryIndexPath(allFiles);

  // Reset form when the selected file changes — otherwise typing in one
  // file's form leaks into the next one.
  useEffect(() => {
    setName(initialName);
    setDescription(initialDescription);
    setType(initialType);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id]);

  const dirty =
    name !== initialName ||
    description !== initialDescription ||
    type !== initialType;

  const descLen = description.length;
  const descOver = descLen > 150;

  const canSave =
    dirty &&
    !busy &&
    name.length > 0 &&
    description.length > 0 &&
    (MEMORY_TYPES as readonly string[]).includes(type);

  const onSave = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      // 1. Read current memory file content + parse frontmatter.
      const fileRes = await fetchFile(file.path);
      const memoryUpdate = rewriteMemoryFrontmatter(fileRes.content, {
        name,
        description,
        type,
      });
      if (memoryUpdate.kind === "error") {
        setError(memoryUpdate.message);
        return;
      }

      // 2. Read MEMORY.md content + compute the index-line update.
      const indexRes = await fetchFile(memoryIndexPath);
      const basename = baseName(file.path);
      const newIndexLine = `- [${name}](${basename}) — ${description}`;
      const indexUpdate = updateMemoryIndex(
        indexRes.content,
        basename,
        newIndexLine,
        file.scope ?? null,
      );

      // 3. Build patches and pump through the write pipeline.
      await requestWrite([
        {
          path: file.path,
          newContent: memoryUpdate.content,
          title: "update memory frontmatter",
        },
        {
          path: memoryIndexPath,
          newContent: indexUpdate,
          title: "update MEMORY.md index",
        },
      ]);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      setError(reason);
      pushToast({ kind: "error", message: `Save failed: ${reason}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="insp-section insp-mem-writer">
      <SectionHeader>Edit memory fields</SectionHeader>
      <div className="insp-mem-row">
        <label className="insp-mem-k">name</label>
        <input
          type="text"
          className="insp-mem-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Short title, human-readable"
        />
      </div>
      <div className="insp-mem-row">
        <label className="insp-mem-k">description</label>
        <input
          type="text"
          className="insp-mem-input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="One-line hook — info-dense, file paths not generic topics"
        />
      </div>
      <div className={`insp-mem-counter${descOver ? " over" : ""}`}>
        {descLen}/150 — keep it info-dense (file paths, not generic topics)
      </div>
      <div className="insp-mem-row">
        <label className="insp-mem-k">type</label>
        <select
          className="insp-mem-select"
          value={type}
          onChange={(e) => setType(e.target.value as MemoryType)}
        >
          {MEMORY_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>
      {error && <div className="insp-mem-error">{error}</div>}
      <div className="insp-mem-actions">
        <button
          type="button"
          className="insp-mem-save"
          onClick={onSave}
          disabled={!canSave}
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </section>
  );
}

// Pure helper: take a memory file's raw text and rewrite its frontmatter to
// hold the new name/description/type. Returns either the new content or an
// error message (e.g. malformed YAML — locked Vasya answer 18: refuse to
// write rather than overwrite). Exported for unit testing.
export function rewriteMemoryFrontmatter(
  text: string,
  next: { name: string; description: string; type: string },
):
  | { kind: "ok"; content: string }
  | { kind: "error"; message: string } {
  const match = /^(---\s*\n)([\s\S]*?)(\n---\s*\n?)([\s\S]*)$/.exec(text);
  if (!match) {
    // No frontmatter block — prepend a fresh one. Per memory-architecture.md,
    // every memory file MUST have name/description/type frontmatter.
    const fm = `---\nname: ${escapeYamlString(next.name)}\ndescription: ${escapeYamlString(next.description)}\ntype: ${next.type}\n---\n\n`;
    return { kind: "ok", content: fm + text };
  }
  const [, openFence, fmBlock, closeFence, body] = match;
  let parsed: unknown;
  try {
    parsed = YAML.parse(fmBlock);
  } catch (e) {
    return {
      kind: "error",
      message: `Frontmatter YAML is malformed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (parsed && typeof parsed !== "object") {
    return { kind: "error", message: "Frontmatter is not a mapping." };
  }

  // Update the three fields in-place by line so we minimise the diff —
  // YAML.stringify() re-orders keys and strips comments.
  const lines = fmBlock.split("\n");
  const updated = mergeKeyLines(lines, {
    name: next.name,
    description: next.description,
    type: next.type,
  });
  return { kind: "ok", content: openFence + updated.join("\n") + closeFence + body };
}

// Walk YAML lines and overwrite (or append) the three target keys at the
// top-level. Handles missing keys by appending them just before the closing
// fence (i.e. at the end of the lines list). Folded scalars and lists for
// the three keys aren't expected (YAML scalar strings only); if encountered,
// they're treated as a flat-string replacement target — the next-key
// detection skips over their indented continuation.
function mergeKeyLines(
  lines: string[],
  next: { name: string; description: string; type: string },
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = /^([ \t]*)([A-Za-z0-9_-]+):/.exec(line);
    if (m && m[1].length === 0) {
      const key = m[2];
      const target = (next as Record<string, string>)[key];
      if (target !== undefined) {
        out.push(`${key}: ${escapeYamlString(target)}`);
        seen.add(key);
        // Skip continuation lines that are more indented than this key.
        i += 1;
        while (i < lines.length) {
          const cont = lines[i];
          if (cont.trim() === "") {
            // blank line — only skip if next non-blank is indented (still
            // part of the scalar). Cheap heuristic: just skip blanks
            // surrounded by indents; keep them otherwise.
            const peek = lines[i + 1];
            if (peek && /^[ \t]+\S/.test(peek)) {
              i += 1;
              continue;
            }
            break;
          }
          if (/^[ \t]+\S/.test(cont)) {
            i += 1;
            continue;
          }
          break;
        }
        continue;
      }
    }
    out.push(line);
    i += 1;
  }
  // Append any missing keys.
  for (const k of ["name", "description", "type"] as const) {
    if (!seen.has(k)) {
      out.push(`${k}: ${escapeYamlString(next[k])}`);
    }
  }
  return out;
}

// Quote a YAML string when it contains chars that would otherwise alter
// parsing (colons, leading punctuation, hash, quotes). Otherwise emit it
// raw to keep the diff readable.
function escapeYamlString(s: string): string {
  if (s === "") return '""';
  // Scalars that need quoting per YAML 1.2.
  const needsQuotes =
    /[:#\n"'\\{}\[\],&*?|>%@`]/.test(s) ||
    /^[\s\-?]/.test(s) ||
    /\s$/.test(s);
  if (!needsQuotes) return s;
  const escaped = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

// Pure helper: produce a new MEMORY.md content with the given index line
// updated (or appended under the right scope heading). Exported for tests.
export function updateMemoryIndex(
  indexText: string,
  basename: string,
  newLine: string,
  scope: string | null,
): string {
  const lines = indexText.split("\n");
  // Try to find an existing line that matches `[*](basename)` — the link
  // target is the only stable anchor (title may change between renames).
  const linkPattern = new RegExp(
    `\\[[^\\]]*\\]\\(${escapeRegex(basename)}\\)`,
  );
  for (let i = 0; i < lines.length; i += 1) {
    if (linkPattern.test(lines[i])) {
      lines[i] = newLine;
      return lines.join("\n");
    }
  }
  // Not found — append under a scope heading. Scope-heading mapping mirrors
  // MEMORY.md current layout: prefix → heading.
  const heading = scopeHeading(scope);
  const headingIdx = lines.findIndex((l) => l.startsWith(`## ${heading}`));
  if (headingIdx >= 0) {
    // Insert the new line just before the next heading (or end of file).
    let insertAt = lines.length;
    for (let i = headingIdx + 1; i < lines.length; i += 1) {
      if (lines[i].startsWith("## ")) {
        insertAt = i;
        break;
      }
    }
    // Trim trailing blanks at the end of the section so the new line doesn't
    // get an awkward extra blank line between it and the next heading.
    while (insertAt > headingIdx + 1 && lines[insertAt - 1].trim() === "") {
      insertAt -= 1;
    }
    lines.splice(insertAt, 0, newLine);
    return lines.join("\n");
  }
  // No matching heading — append a new "## Other" section at the end.
  if (lines.length > 0 && lines[lines.length - 1] !== "") {
    lines.push("");
  }
  lines.push("## Other", newLine);
  return lines.join("\n");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scopeHeading(scope: string | null): string {
  if (!scope) return "Other";
  const headings: Record<string, string> = {
    user: "User",
    global: "Global (apply to all projects)",
    tma: "TMA (Telegram Mini App — trust_api, Traction-Eye, trust_indexer, trust-api-docs)",
    agentkit: "Agent Kit (AI spot trader)",
    paperclip: "Paperclip (agent team control plane for Agent Kit)",
    futures: "Futures (AI futures trader — not implemented)",
    observatory: "Observatory (local Claude config dashboard — Steps 1+2+2.5+2.6 shipped 2026-04-27..28, Step 3 next)",
    archive: "Archive (paused / informational)",
  };
  return headings[scope] ?? "Other";
}

function baseName(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx >= 0 ? p.slice(idx + 1) : p;
}

// --- new-rule launcher -----------------------------------------------------

function NewRuleLauncher({ origin }: { origin: FileEntry }) {
  const [open, setOpen] = useState(false);
  const [cwds, setCwds] = useState<CwdEntry[] | null>(null);

  // Lazy-fetch cwds the first time the wizard opens. Keeps the inspector
  // mount lean for users who never click the button.
  useEffect(() => {
    if (!open || cwds) return;
    let cancelled = false;
    fetchCwds()
      .then((res) => {
        if (!cancelled) setCwds(res);
      })
      .catch(() => {
        if (!cancelled) setCwds([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, cwds]);

  return (
    <>
      <section className="insp-section insp-new-rule-section">
        <button
          type="button"
          className="insp-new-rule-btn"
          onClick={() => setOpen(true)}
        >
          + New rule from this {origin.kind === "claude_md" ? "CLAUDE.md" : "rule"}
        </button>
      </section>
      {open && cwds !== null && (
        <RuleWizardModal
          originFile={origin}
          cwds={cwds}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
