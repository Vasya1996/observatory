import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CwdSelector } from "../components/CwdSelector";
import { Inspector } from "../components/Inspector";
import { fetchCwds, fetchNonCanonical, fetchSimulate } from "../api/client";
import { useStore } from "../state/store";
import {
  buildSlotMap,
  SLOT_ORDER,
  SLOT_LABELS,
  type SlotKey,
  type SlottedFile,
} from "../simulator/slotAssign";
import { computeAmbiguousBasenames, displayLabel } from "../components/labels";
import type {
  CwdEntry,
  LoadStatus,
  NonCanonicalEntry,
  SimulatorStats,
  SimulatorResponse,
  TimelineStep,
} from "../types";

const TOKENS_PER_LINE = 12;

// Humanise a reason code for the tooltip.
function humaniseReason(reason: string): string {
  if (reason === "loaded_via_at_import") return "loaded via @-import";
  if (reason === "outside_canonical_dir") return "outside canonical directory";
  if (reason === "wrong_filename_at_canonical_path") return "wrong filename at canonical path";
  return reason.replace(/_/g, " ");
}

// Collapse home prefix for display.
function collapseHome(p: string): string {
  if (p.startsWith("/home/voxdecaelo/")) return "~/" + p.slice("/home/voxdecaelo/".length);
  return p;
}

export function SimulatorView() {
  const files = useStore((s) => s.files);
  const edges = useStore((s) => s.edges);
  const lastCwd = useStore((s) => s.lastCwd);
  const setLastCwd = useStore((s) => s.setLastCwd);
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const simulatorMode = useStore((s) => s.simulatorMode);
  const setSimulatorMode = useStore((s) => s.setSimulatorMode);

  const [steps, setSteps] = useState<TimelineStep[]>([]);
  const [stats, setStats] = useState<SimulatorStats | null>(null);
  const [statusMap, setStatusMap] = useState<Map<string, LoadStatus> | null>(null);
  const [loading, setLoading] = useState(false);

  // Non-canonical map: file_path (absolute) → entry.
  const [nonCanonMap, setNonCanonMap] = useState<Map<string, NonCanonicalEntry>>(new Map());

  // Badge panel.
  const [panelOpen, setPanelOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // All-cwds table cache: cwd path → { sim, nonCanon }
  const [cwdList, setCwdList] = useState<CwdEntry[]>([]);
  const [allCwdSim, setAllCwdSim] = useState<Map<string, SimulatorResponse>>(new Map());
  const [allCwdNonCanon, setAllCwdNonCanon] = useState<Map<string, NonCanonicalEntry[]>>(new Map());
  const [allCwdLoading, setAllCwdLoading] = useState(false);

  // Auto-pick first cwd if none selected.
  useEffect(() => {
    if (lastCwd) return;
    let cancelled = false;
    fetchCwds()
      .then((list) => {
        if (cancelled) return;
        setCwdList(list);
        if (!useStore.getState().lastCwd && list.length > 0) {
          setLastCwd(list[0].path);
        }
      })
      .catch((e) => console.warn("[observatory] /api/cwds failed", e));
    return () => { cancelled = true; };
  }, [lastCwd, setLastCwd]);

  // Fetch cwdList once for the all-cwds tab.
  useEffect(() => {
    if (cwdList.length > 0) return;
    fetchCwds()
      .then(setCwdList)
      .catch((e) => console.warn("[observatory] /api/cwds failed", e));
  }, [cwdList.length]);

  // Fetch simulate + non-canonical in parallel when lastCwd changes.
  useEffect(() => {
    if (!lastCwd) {
      setSteps([]);
      setStats(null);
      setStatusMap(null);
      setNonCanonMap(new Map());
      return;
    }
    let cancelled = false;
    setLoading(true);
    Promise.all([
      fetchSimulate(lastCwd),
      fetchNonCanonical(lastCwd),
    ])
      .then(([simRes, ncRes]) => {
        if (cancelled) return;
        setSteps(simRes.steps);
        setStats(simRes.stats);
        const map = new Map<string, LoadStatus>();
        for (const s of simRes.steps) {
          if (s.file_id) map.set(s.file_id, s.status);
        }
        for (const f of files) {
          if (!map.has(f.id)) map.set(f.id, "orphan");
        }
        setStatusMap(map);
        const ncMap = new Map<string, NonCanonicalEntry>();
        for (const e of ncRes.non_canonical) {
          ncMap.set(e.file_path, e);
        }
        setNonCanonMap(ncMap);
      })
      .catch((e) => console.warn("[observatory] sim/non-canonical failed", e))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [lastCwd, files]);

  // Prefetch all cwds when switching to all-cwds tab.
  useEffect(() => {
    if (simulatorMode !== "all-cwds") return;
    if (cwdList.length === 0) return;
    if (allCwdSim.size > 0) return; // already fetched
    setAllCwdLoading(true);
    const simPromises = cwdList.map((c) =>
      fetchSimulate(c.path).then((r) => ({ cwd: c.path, r })).catch(() => null),
    );
    const ncPromises = cwdList.map((c) =>
      fetchNonCanonical(c.path).then((r) => ({ cwd: c.path, entries: r.non_canonical })).catch(() => null),
    );
    Promise.all([Promise.all(simPromises), Promise.all(ncPromises)])
      .then(([sims, ncs]) => {
        const simMap = new Map<string, SimulatorResponse>();
        for (const x of sims) {
          if (x) simMap.set(x.cwd, x.r);
        }
        setAllCwdSim(simMap);
        const ncMap = new Map<string, NonCanonicalEntry[]>();
        for (const x of ncs) {
          if (x) ncMap.set(x.cwd, x.entries);
        }
        setAllCwdNonCanon(ncMap);
      })
      .catch((e) => console.warn("[observatory] all-cwds prefetch failed", e))
      .finally(() => setAllCwdLoading(false));
  }, [simulatorMode, cwdList, allCwdSim.size]);

  // SSE reindex: clear all-cwds cache so it re-fetches.
  useEffect(() => {
    let es: EventSource | null = null;
    try {
      es = new EventSource("/api/events");
      es.addEventListener("reindex", () => {
        setAllCwdSim(new Map());
        setAllCwdNonCanon(new Map());
      });
    } catch {
      // ignore
    }
    return () => { es?.close(); };
  }, []);

  // Close non-canon panel on outside click.
  useEffect(() => {
    if (!panelOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!panelRef.current) return;
      if (panelRef.current.contains(e.target as Node)) return;
      setPanelOpen(false);
    };
    window.addEventListener("mousedown", onDoc);
    return () => window.removeEventListener("mousedown", onDoc);
  }, [panelOpen]);

  const ambiguous = useMemo(() => computeAmbiguousBasenames(files), [files]);

  const slotMap = useMemo(
    () => buildSlotMap(steps, files, edges, lastCwd ?? null),
    [steps, files, edges, lastCwd],
  );

  const totalFiles = useMemo(
    () => SLOT_ORDER.reduce((acc, k) => acc + slotMap[k].length, 0),
    [slotMap],
  );

  const nonCanonCount = nonCanonMap.size;

  const handleOpenFile = useCallback((filePath: string) => {
    const f = files.find((x) => x.path === filePath);
    if (f) {
      select(f.id);
      setPanelOpen(false);
    }
  }, [files, select]);

  const handleCellClick = useCallback((cwd: string) => {
    setLastCwd(cwd);
    setSimulatorMode("per-cwd");
  }, [setLastCwd, setSimulatorMode]);

  return (
    <div className={`sim-shell${inspectorOpen ? " has-inspector" : ""}`}>
      {/* Header strip */}
      <div className="sim-header">
        <CwdSelector />
        {simulatorMode === "per-cwd" && lastCwd && (
          <>
            <span className="sim-stat-chip">
              <b>{stats?.files_loaded ?? "—"}</b>&thinsp;loaded
            </span>
            <span className="sim-stat-chip">
              <b>~{stats ? Math.round(stats.est_tokens / 1000) : "—"}k</b>&thinsp;tokens
            </span>
            {(stats?.conditional_matches ?? 0) > 0 && (
              <span className="sim-stat-chip">
                <b>{stats!.conditional_matches}</b>&thinsp;conditional
              </span>
            )}
            <span className="sim-stat-chip">
              <b>{totalFiles}</b>&thinsp;files in view
            </span>
          </>
        )}
        {loading && (
          <span className="sim-stat-chip" style={{ color: "var(--paper-faint)", fontStyle: "italic" }}>
            loading…
          </span>
        )}
        {/* Non-canonical badge */}
        {simulatorMode === "per-cwd" && nonCanonCount > 0 && (
          <div className="sim-noncanon-badge-wrap" ref={panelRef} style={{ marginLeft: "auto" }}>
            <button
              type="button"
              className={`sim-noncanon-badge sim-noncanon-badge-btn${panelOpen ? " open" : ""}`}
              onClick={() => setPanelOpen((v) => !v)}
              title="Files at non-canonical paths"
            >
              <AlertTriangleIcon size={11} />
              {nonCanonCount}&thinsp;at non-canonical paths
            </button>
            {panelOpen && (
              <NonCanonPanel
                entries={Array.from(nonCanonMap.values())}
                files={files}
                onOpen={handleOpenFile}
              />
            )}
          </div>
        )}
      </div>

      {/* Body */}
      {simulatorMode === "per-cwd" ? (
        <div className="sim-columns">
          {SLOT_ORDER.map((slot) => (
            <SlotColumn
              key={slot}
              slotKey={slot}
              entries={slotMap[slot]}
              ambiguous={ambiguous}
              selectedId={selectedId}
              onSelect={select}
              nonCanonMap={nonCanonMap}
              files={files}
            />
          ))}
        </div>
      ) : (
        <AllCwdsTable
          cwdList={cwdList}
          allCwdSim={allCwdSim}
          allCwdNonCanon={allCwdNonCanon}
          loading={allCwdLoading}
          onCellClick={handleCellClick}
        />
      )}

      <Inspector cy={null} statusMap={statusMap} />
    </div>
  );
}

// --- NonCanonPanel (badge click → floating panel) ---------------------------

interface NonCanonPanelProps {
  entries: NonCanonicalEntry[];
  files: import("../types").FileEntry[];
  onOpen: (filePath: string) => void;
}

function NonCanonPanel({ entries, files, onOpen }: NonCanonPanelProps) {
  return (
    <div className="sim-noncanon-panel" role="dialog" aria-label="Non-canonical files">
      <div className="sim-noncanon-panel-head">
        <span>non-canonical paths</span>
        <span style={{ color: "var(--amber)" }}>{entries.length}</span>
      </div>
      <ul className="sim-noncanon-panel-list">
        {entries.map((e) => {
          const basename = e.file_path.split("/").pop() ?? e.file_path;
          const fileInIndex = files.some((f) => f.path === e.file_path);
          return (
            <li key={e.file_path} className="sim-noncanon-panel-row">
              <div className="sim-noncanon-panel-name">{collapseHome(e.file_path)}</div>
              <div className="sim-noncanon-panel-meta">
                <span className="sim-noncanon-slot">{e.slot}</span>
                <span className="sim-noncanon-reason">{humaniseReason(e.reason)}</span>
              </div>
              {fileInIndex && (
                <div className="sim-noncanon-panel-actions">
                  <button
                    type="button"
                    className="sim-noncanon-open-btn"
                    onClick={() => onOpen(e.file_path)}
                  >
                    Open
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// --- SlotColumn -------------------------------------------------------------

interface SlotColumnProps {
  slotKey: SlotKey;
  entries: SlottedFile[];
  ambiguous: Set<string>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  nonCanonMap: Map<string, NonCanonicalEntry>;
  files: import("../types").FileEntry[];
}

function SlotColumn({
  slotKey,
  entries,
  ambiguous,
  selectedId,
  onSelect,
  nonCanonMap,
  files,
}: SlotColumnProps) {
  return (
    <div className="sim-column">
      <div className="sim-col-header">
        <span className="sim-col-name">{SLOT_LABELS[slotKey]}</span>
        <span className="sim-col-count">{entries.length}</span>
      </div>

      {entries.length === 0 ? (
        <div className="sim-col-empty">no files in this scope</div>
      ) : (
        entries.map((entry) => {
          const ncEntry = nonCanonMap.get(entry.file.path);
          return (
            <SlotCard
              key={entry.file.id}
              entry={entry}
              ambiguous={ambiguous}
              selected={selectedId === entry.file.id}
              onSelect={onSelect}
              nonCanonEntry={ncEntry}
            />
          );
        })
      )}
    </div>
  );
}

// --- SlotCard ---------------------------------------------------------------

interface SlotCardProps {
  entry: SlottedFile;
  ambiguous: Set<string>;
  selected: boolean;
  onSelect: (id: string) => void;
  nonCanonEntry?: NonCanonicalEntry;
}

function SlotCard({ entry, ambiguous, selected, onSelect, nonCanonEntry }: SlotCardProps) {
  const { file, step } = entry;
  const label = displayLabel(file, ambiguous);
  const status: LoadStatus = step?.status ?? "orphan";
  const estTokens = file.line_count * TOKENS_PER_LINE;

  const isNonCanon = !!nonCanonEntry;

  // Tooltip anchor state.
  const [tooltipVisible, setTooltipVisible] = useState(false);
  const glyphRef = useRef<HTMLSpanElement | null>(null);

  const handleClick = () => { onSelect(file.id); };

  return (
    <div
      className={`sim-card${selected ? " selected" : ""}${isNonCanon ? " non-canonical" : ""}`}
      onClick={handleClick}
      onDoubleClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleClick(); }
      }}
      aria-label={`${label} — ${status}${isNonCanon ? " (non-canonical)" : ""}`}
      aria-pressed={selected}
    >
      {isNonCanon && (
        <span
          ref={glyphRef}
          className="sim-card-noncanon-glyph"
          onMouseEnter={() => setTooltipVisible(true)}
          onMouseLeave={() => setTooltipVisible(false)}
          aria-label="Non-canonical path"
        >
          <AlertTriangleIcon size={12} />
          {tooltipVisible && nonCanonEntry && (
            <div className="sim-card-noncanon-tooltip">
              <div><b>Reason:</b> {humaniseReason(nonCanonEntry.reason)}</div>
              {nonCanonEntry.importer_path && (
                <div><b>From:</b> {collapseHome(nonCanonEntry.importer_path)}{nonCanonEntry.importer_line ? `:${nonCanonEntry.importer_line}` : ""}</div>
              )}
              <div><b>Canonical place:</b> {collapseHome(nonCanonEntry.canonical_path)}</div>
            </div>
          )}
        </span>
      )}

      <div className="sim-card-name">{label}</div>

      <div className="sim-card-chips">
        <StatusChip status={status} />
        <span className="sim-card-tokens">~{Math.round(estTokens / 1000 * 10) / 10}k tok</span>
      </div>

      {step?.matched_on && (
        <div className="sim-card-reason">{step.matched_on}</div>
      )}

      <div className="sim-card-footer">
        <span>{formatBytes(file.size_bytes)}</span>
        <span>{file.line_count} ln</span>
      </div>
    </div>
  );
}

// --- StatusChip -------------------------------------------------------------

function StatusChip({ status }: { status: LoadStatus }) {
  const cls = `sim-status-chip sim-status-${status}`;
  const label =
    status === "loaded" ? "loaded"
    : status === "conditional" ? "conditional"
    : status === "skipped" ? "skipped"
    : "orphan";
  return <span className={cls}>{label}</span>;
}

// --- AllCwdsTable -----------------------------------------------------------

interface AllCwdsTableProps {
  cwdList: CwdEntry[];
  allCwdSim: Map<string, SimulatorResponse>;
  allCwdNonCanon: Map<string, NonCanonicalEntry[]>;
  loading: boolean;
  onCellClick: (cwd: string) => void;
}

function AllCwdsTable({
  cwdList,
  allCwdSim,
  allCwdNonCanon,
  loading,
  onCellClick,
}: AllCwdsTableProps) {
  if (loading || (cwdList.length > 0 && allCwdSim.size === 0)) {
    return (
      <div className="sim-allcwds-loading">
        <span>Loading all cwds…</span>
      </div>
    );
  }

  return (
    <div className="sim-allcwds-wrap">
      <table className="sim-allcwds-table">
        <thead>
          <tr>
            <th className="sim-allcwds-cwd-col">Working directory</th>
            {SLOT_ORDER.map((slot) => (
              <th key={slot} className="sim-allcwds-slot-col">{SLOT_LABELS[slot]}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cwdList.map((entry) => {
            const sim = allCwdSim.get(entry.path);
            const nc = allCwdNonCanon.get(entry.path) ?? [];
            const ncPaths = new Set(nc.map((e) => e.file_path));
            return (
              <AllCwdsRow
                key={entry.path}
                entry={entry}
                sim={sim}
                ncPaths={ncPaths}
                onCellClick={onCellClick}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// --- AllCwdsRow -------------------------------------------------------------

interface AllCwdsRowProps {
  entry: CwdEntry;
  sim: SimulatorResponse | undefined;
  ncPaths: Set<string>;
  onCellClick: (cwd: string) => void;
}

function AllCwdsRow({ entry, sim, ncPaths, onCellClick }: AllCwdsRowProps) {
  // Count files per slot from the sim steps.
  const slotCounts: Record<SlotKey, number> = {
    managed: 0, user: 0, ancestor: 0, project: 0, automemory: 0, ondemand: 0,
  };
  // Count non-canonical per slot.
  const slotNc: Record<SlotKey, number> = {
    managed: 0, user: 0, ancestor: 0, project: 0, automemory: 0, ondemand: 0,
  };

  if (sim) {
    for (const step of sim.steps) {
      if (!step.file_path) continue;
      const slot = simPathToSlot(step.file_path, entry.path);
      slotCounts[slot]++;
      if (ncPaths.has(resolveAbsolute(step.file_path))) {
        slotNc[slot]++;
      }
    }
  }

  return (
    <tr className="sim-allcwds-row">
      <td className="sim-allcwds-cwd-cell">
        <span className="sim-allcwds-cwd-label">{entry.display}</span>
      </td>
      {SLOT_ORDER.map((slot) => {
        const count = slotCounts[slot];
        const hasNc = slotNc[slot] > 0;
        const isEmpty = count === 0;
        const cellClass = isEmpty
          ? "sim-allcwds-cell sim-allcwds-cell-empty"
          : hasNc
            ? "sim-allcwds-cell sim-allcwds-cell-amber"
            : "sim-allcwds-cell sim-allcwds-cell-green";
        return (
          <td
            key={slot}
            className={cellClass}
            onClick={() => !isEmpty && onCellClick(entry.path)}
            title={isEmpty ? "" : `${count} file${count !== 1 ? "s" : ""}${hasNc ? ` (${slotNc[slot]} non-canonical)` : ""} — click to drill in`}
          >
            {!isEmpty && (
              <span className="sim-allcwds-cell-count">{count}</span>
            )}
          </td>
        );
      })}
    </tr>
  );
}

// Determine slot key from a file path string + cwd. Mirrors slotAssign logic
// without importing that module (avoid circular dep and keep this pure).
function simPathToSlot(filePath: string, cwd: string): SlotKey {
  const home = "/home/voxdecaelo";
  const dotClaude = home + "/.claude";

  let p = filePath;
  if (p.startsWith("~/")) p = home + "/" + p.slice(2);

  if (p === dotClaude + "/CLAUDE.md" || p.startsWith(dotClaude + "/rules/")) return "user";
  if (p.startsWith(dotClaude + "/projects/") && p.includes("/memory/")) return "automemory";
  if (cwd) {
    const cwdDot = cwd + "/.claude";
    if (p === cwdDot + "/CLAUDE.md" || p.startsWith(cwdDot + "/rules/")) return "project";
  }
  const fname = p.split("/").pop() ?? "";
  if ((fname === "CLAUDE.md" || fname === "CLAUDE.local.md") && p.startsWith(home + "/") && !p.startsWith(dotClaude + "/")) {
    return "ancestor";
  }
  return "ondemand";
}

function resolveAbsolute(p: string): string {
  const home = "/home/voxdecaelo";
  if (p.startsWith("~/")) return home + "/" + p.slice(2);
  return p;
}

// --- AlertTriangleIcon (inline lucide path, no lucide-react dep) ------------

function AlertTriangleIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

// --- helpers ----------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
