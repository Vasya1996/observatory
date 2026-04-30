import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CwdSelector } from "../components/CwdSelector";
import { Inspector } from "../components/Inspector";
import { EditorPanel } from "../components/EditorPanel";
import { ContextMenu } from "../components/ContextMenu";
import type { ContextMenuTarget } from "../components/ContextMenu";
import { NormalizeWizardModal, type NormalizeMode } from "../components/NormalizeWizardModal";
import { fetchCwds, fetchNonCanonical, fetchSimulate, postSuppress } from "../api/client";
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
  FileEntry,
  LoadStatus,
  NonCanonicalEntry,
  SimulatorStats,
  SimulatorResponse,
  TimelineStep,
} from "../types";

const TOKENS_PER_LINE = 12;

const TIER2_BANNER_KEY = "observatory_tier2_banner_dismissed";

function humaniseReason(reason: string): string {
  if (reason === "loaded_via_at_import") return "loaded via @-import";
  if (reason === "outside_canonical_dir") return "outside canonical directory";
  if (reason === "wrong_filename_at_canonical_path") return "wrong filename at canonical path";
  return reason.replace(/_/g, " ");
}

function collapseHome(p: string): string {
  if (p.startsWith("/home/voxdecaelo/")) return "~/" + p.slice("/home/voxdecaelo/".length);
  return p;
}

// Determine which DnD migration mode to use given source and target slots.
function dndMode(srcSlot: SlotKey, dstSlot: SlotKey): NormalizeMode | null {
  if (dstSlot === "ondemand") return null; // requires glob prompt — handled separately
  if (dstSlot === "project") return "rule";
  if (dstSlot === "user") return "rule";
  return "rule";
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

  const [nonCanonMap, setNonCanonMap] = useState<Map<string, NonCanonicalEntry>>(new Map());
  // Whether the current cwd has the suppress flag on.
  const [suppressed, setSuppressed] = useState(false);

  const [panelOpen, setPanelOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const [cwdList, setCwdList] = useState<CwdEntry[]>([]);
  const [allCwdSim, setAllCwdSim] = useState<Map<string, SimulatorResponse>>(new Map());
  const [allCwdNonCanon, setAllCwdNonCanon] = useState<Map<string, NonCanonicalEntry[]>>(new Map());
  const [allCwdLoading, setAllCwdLoading] = useState(false);

  // Tier 2 banner dismissal (localStorage-persisted).
  const [tier2BannerDismissed, setTier2BannerDismissed] = useState(
    () => localStorage.getItem(TIER2_BANNER_KEY) === "1",
  );
  const dismissTier2Banner = () => {
    localStorage.setItem(TIER2_BANNER_KEY, "1");
    setTier2BannerDismissed(true);
  };

  // Normalize wizard state.
  const [normalizeEntry, setNormalizeEntry] = useState<NonCanonicalEntry | null>(null);
  const [normalizePrefilledMode, setNormalizePrefilledMode] = useState<NormalizeMode | null>(null);

  // Glob prompt for DnD into On-demand (not wired in this commit — shown as future).
  const [globPromptEntry, setGlobPromptEntry] = useState<NonCanonicalEntry | null>(null);

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

  useEffect(() => {
    if (cwdList.length > 0) return;
    fetchCwds()
      .then(setCwdList)
      .catch((e) => console.warn("[observatory] /api/cwds failed", e));
  }, [cwdList.length]);

  useEffect(() => {
    if (!lastCwd) {
      setSteps([]);
      setStats(null);
      setStatusMap(null);
      setNonCanonMap(new Map());
      setSuppressed(false);
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
        setSuppressed(ncRes.suppressed ?? false);
      })
      .catch((e) => console.warn("[observatory] sim/non-canonical failed", e))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [lastCwd, files]);

  useEffect(() => {
    if (simulatorMode !== "all-cwds") return;
    if (cwdList.length === 0) return;
    if (allCwdSim.size > 0) return;
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
        for (const x of sims) { if (x) simMap.set(x.cwd, x.r); }
        setAllCwdSim(simMap);
        const ncMap = new Map<string, NonCanonicalEntry[]>();
        for (const x of ncs) { if (x) ncMap.set(x.cwd, x.entries); }
        setAllCwdNonCanon(ncMap);
      })
      .catch((e) => console.warn("[observatory] all-cwds prefetch failed", e))
      .finally(() => setAllCwdLoading(false));
  }, [simulatorMode, cwdList, allCwdSim.size]);

  useEffect(() => {
    let es: EventSource | null = null;
    try {
      es = new EventSource("/api/events");
      es.addEventListener("reindex", () => {
        setAllCwdSim(new Map());
        setAllCwdNonCanon(new Map());
      });
    } catch { /* ignore */ }
    return () => { es?.close(); };
  }, []);

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

  // Effective non-canonical count: 0 when suppressed.
  const nonCanonCount = suppressed ? 0 : nonCanonMap.size;

  const setEditorOpen = useStore((s) => s.setEditorOpen);
  const [ctxTarget, setCtxTarget] = useState<ContextMenuTarget | null>(null);

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

  const handleDblClick = useCallback((path: string) => {
    setEditorOpen(path, true);
  }, [setEditorOpen]);

  const handleContextMenu = useCallback((
    e: React.MouseEvent,
    path: string,
    displayName: string,
    writable: boolean,
  ) => {
    e.preventDefault();
    setCtxTarget({ path, displayName, writable, x: e.clientX, y: e.clientY });
  }, []);

  const handleNormalize = useCallback((entry: NonCanonicalEntry, mode?: NormalizeMode) => {
    setNormalizeEntry(entry);
    setNormalizePrefilledMode(mode ?? null);
  }, []);

  const handleSuppress = useCallback(async (value: boolean) => {
    if (!lastCwd) return;
    try {
      await postSuppress(lastCwd, value);
      setSuppressed(value);
      if (value) setPanelOpen(false);
    } catch (e) {
      console.warn("[observatory] suppress failed", e);
    }
  }, [lastCwd]);

  // DnD handlers at slot-column level.
  const handleDndDrop = useCallback((srcEntry: SlottedFile, dstSlot: SlotKey) => {
    const ncEntry = nonCanonMap.get(srcEntry.file.path);
    // For a drop, synthesize a NonCanonicalEntry if the file isn't already non-canonical
    // — the wizard just needs the file_path, slot, canonical_path, reason.
    const entry: NonCanonicalEntry = ncEntry ?? {
      file_path: srcEntry.file.path,
      slot: srcEntry.slot,
      canonical_path: srcEntry.file.path,
      reason: "outside_canonical_dir",
    };

    if (dstSlot === "ondemand") {
      // Glob prompt required — show a dedicated modal (GlobPromptModal).
      setGlobPromptEntry(entry);
      return;
    }

    const mode = dndMode(srcEntry.slot, dstSlot);
    handleNormalize(entry, mode ?? "rule");
  }, [nonCanonMap, handleNormalize]);

  return (
    <div className={`sim-shell${inspectorOpen ? " has-inspector" : ""}`}>
      {/* Tier 2 unavailable banner — one-time dismissible */}
      {!tier2BannerDismissed && simulatorMode === "per-cwd" && (
        <div className="sim-tier2-banner">
          <span className="sim-tier2-banner-icon" aria-hidden="true">
            <InfoIcon size={14} />
          </span>
          <span className="sim-tier2-banner-text">
            Deep verification (Tier 2) is not available on this Claude version. Tier 1 checks are running — file moves are still safe.
          </span>
          <button
            type="button"
            className="sim-tier2-banner-dismiss"
            onClick={dismissTier2Banner}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

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
        {/* Non-canonical badge — hidden when suppressed */}
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
                suppressed={suppressed}
                onOpen={handleOpenFile}
                onNormalize={handleNormalize}
                onSuppress={handleSuppress}
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
              onDblClick={handleDblClick}
              onContextMenu={handleContextMenu}
              nonCanonMap={nonCanonMap}
              onNormalize={handleNormalize}
              onDrop={handleDndDrop}
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

      <EditorPanel files={files} />
      <Inspector cy={null} statusMap={statusMap} />
      <ContextMenu target={ctxTarget} onClose={() => setCtxTarget(null)} />

      {/* Normalize wizard */}
      {normalizeEntry && (
        <NormalizeWizardModal
          entry={normalizeEntry}
          prefilledMode={normalizePrefilledMode}
          onClose={() => { setNormalizeEntry(null); setNormalizePrefilledMode(null); }}
        />
      )}

      {/* Glob prompt for DnD into On-demand — simple modal */}
      {globPromptEntry && (
        <GlobPromptModal
          entry={globPromptEntry}
          onClose={() => setGlobPromptEntry(null)}
          onConfirm={(globs) => {
            setGlobPromptEntry(null);
            // Wire: open normalize wizard with on-demand semantics.
            // For now we open in rule mode; the paths: field would be added
            // in a follow-up once the wizard supports it.
            void globs; // suppress unused-var
            handleNormalize(globPromptEntry, "rule");
          }}
        />
      )}
    </div>
  );
}

// --- NonCanonPanel ----------------------------------------------------------

interface NonCanonPanelProps {
  entries: NonCanonicalEntry[];
  files: FileEntry[];
  suppressed: boolean;
  onOpen: (filePath: string) => void;
  onNormalize: (entry: NonCanonicalEntry) => void;
  onSuppress: (value: boolean) => void;
}

function NonCanonPanel({ entries, files, suppressed, onOpen, onNormalize, onSuppress }: NonCanonPanelProps) {
  return (
    <div className="sim-noncanon-panel" role="dialog" aria-label="Non-canonical files">
      {/* Suppressed banner */}
      {suppressed && (
        <div className="sim-noncanon-suppressed-banner">
          <span>Suggestions paused for this folder</span>
          <button
            type="button"
            className="sim-noncanon-reenable-btn"
            onClick={() => onSuppress(false)}
          >
            Re-enable suggestions
          </button>
        </div>
      )}

      <div className="sim-noncanon-panel-head">
        <span>files at non-canonical paths</span>
        <span style={{ color: "var(--amber)" }}>{entries.length}</span>
      </div>
      <ul className="sim-noncanon-panel-list">
        {entries.map((e) => {
          const fileInIndex = files.some((f) => f.path === e.file_path);
          return (
            <li key={e.file_path} className="sim-noncanon-panel-row">
              <div className="sim-noncanon-panel-name">{collapseHome(e.file_path)}</div>
              <div className="sim-noncanon-panel-meta">
                <span className="sim-noncanon-slot">{e.slot}</span>
                <span className="sim-noncanon-reason">{humaniseReason(e.reason)}</span>
              </div>
              <div className="sim-noncanon-panel-actions">
                {fileInIndex && (
                  <button
                    type="button"
                    className="sim-noncanon-open-btn"
                    onClick={() => onOpen(e.file_path)}
                  >
                    Open
                  </button>
                )}
                <button
                  type="button"
                  className="sim-noncanon-open-btn"
                  onClick={() => onNormalize(e)}
                >
                  Move…
                </button>
                <button
                  type="button"
                  className="sim-noncanon-suppress-btn"
                  onClick={() => onSuppress(true)}
                  title="Stop showing this badge for the current folder"
                >
                  Stop suggesting
                </button>
              </div>
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
  onDblClick: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, path: string, displayName: string, writable: boolean) => void;
  nonCanonMap: Map<string, NonCanonicalEntry>;
  onNormalize: (entry: NonCanonicalEntry) => void;
  onDrop: (srcEntry: SlottedFile, dstSlot: SlotKey) => void;
}

function SlotColumn({
  slotKey,
  entries,
  ambiguous,
  selectedId,
  onSelect,
  onDblClick,
  onContextMenu,
  nonCanonMap,
  onNormalize,
  onDrop,
}: SlotColumnProps) {
  const [dragOver, setDragOver] = useState(false);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };
  const handleDragLeave = () => setDragOver(false);
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const raw = e.dataTransfer.getData("application/x-slot-entry");
    if (!raw) return;
    try {
      const srcEntry: SlottedFile = JSON.parse(raw);
      // Don't drop onto the same slot.
      if (srcEntry.slot === slotKey) return;
      // Managed slot is read-only.
      if (srcEntry.slot === "managed") return;
      onDrop(srcEntry, slotKey);
    } catch { /* malformed drag data */ }
  };

  return (
    <div
      className={`sim-column${dragOver ? " dragover" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
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
              onDblClick={onDblClick}
              onContextMenu={onContextMenu}
              nonCanonEntry={ncEntry}
              onNormalize={ncEntry ? () => onNormalize(ncEntry) : undefined}
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
  onDblClick: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, path: string, displayName: string, writable: boolean) => void;
  nonCanonEntry?: NonCanonicalEntry;
  onNormalize?: () => void;
}

function SlotCard({ entry, ambiguous, selected, onSelect, onDblClick, onContextMenu, nonCanonEntry, onNormalize }: SlotCardProps) {
  const { file, step } = entry;
  const label = displayLabel(file, ambiguous);
  const status: LoadStatus = step?.status ?? "orphan";
  const estTokens = file.line_count * TOKENS_PER_LINE;
  const isNonCanon = !!nonCanonEntry;
  const basename = file.path.split("/").pop() ?? "";
  const isAgentsMd = file.kind === "claude_md" && basename === "AGENTS.md";

  // Managed slot cards are not draggable (read-only).
  const isDraggable = entry.slot !== "managed" && file.kind !== "automemory"
    && file.kind !== "plugin_manifest" && file.kind !== "plugin_registry"
    && file.kind !== "script";

  const [tooltipVisible, setTooltipVisible] = useState(false);
  const glyphRef = useRef<HTMLSpanElement | null>(null);

  const handleClick = () => { onSelect(file.id); };
  const handleDblClick = () => { onDblClick(file.path); };
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const displayName = file.display_name ?? basename;
    onContextMenu(e, file.path, displayName, file.writable ?? true);
  };

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("application/x-slot-entry", JSON.stringify(entry));
  };

  return (
    <div
      className={`sim-card${selected ? " selected" : ""}${isNonCanon ? " non-canonical" : ""}`}
      draggable={isDraggable}
      onDragStart={handleDragStart}
      onClick={handleClick}
      onDoubleClick={handleDblClick}
      onContextMenu={handleContextMenu}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleClick(); }
      }}
      aria-label={`${label} — ${status}${isNonCanon ? " (at non-canonical path)" : ""}`}
      aria-pressed={selected}
    >
      {isNonCanon && (
        <span
          ref={glyphRef}
          className="sim-card-noncanon-glyph"
          onMouseEnter={() => setTooltipVisible(true)}
          onMouseLeave={() => setTooltipVisible(false)}
          aria-label="At non-canonical path"
        >
          <AlertTriangleIcon size={12} />
          {tooltipVisible && nonCanonEntry && (
            <div className="sim-card-noncanon-tooltip">
              <div><b>Reason:</b> {humaniseReason(nonCanonEntry.reason)}</div>
              {nonCanonEntry.importer_path && (
                <div>
                  <b>From:</b> {collapseHome(nonCanonEntry.importer_path)}
                  {nonCanonEntry.importer_line ? `:${nonCanonEntry.importer_line}` : ""}
                </div>
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

      {isNonCanon && onNormalize && (
        <button
          type="button"
          className="sim-card-normalize-btn"
          onClick={(e) => { e.stopPropagation(); onNormalize(); }}
          title="Move this file to its canonical location"
        >
          Normalize…
        </button>
      )}

      {isAgentsMd && (
        <div className="sim-card-agents-note">
          Not auto-loaded — needs <code>@AGENTS.md</code> in CLAUDE.md
        </div>
      )}
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

// --- GlobPromptModal (DnD into On-demand) -----------------------------------

interface GlobPromptModalProps {
  entry: NonCanonicalEntry;
  onClose: () => void;
  onConfirm: (globs: string[]) => void;
}

function GlobPromptModal({ entry, onClose, onConfirm }: GlobPromptModalProps) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleApply = () => {
    const globs = value.split(",").map((s) => s.trim()).filter(Boolean);
    if (globs.length === 0) return;
    onConfirm(globs);
  };

  const basename = entry.file_path.split("/").pop() ?? "";

  return (
    <div
      className="modal-veil glob-prompt-veil show"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="presentation"
    >
      <div className="modal glob-prompt-modal" role="dialog" aria-modal="true" aria-label="Set file patterns">
        <header className="modal-head">
          <h3>Which paths should load <em>{basename}</em>?</h3>
          <span className="x" role="button" tabIndex={0} onClick={onClose}
            onKeyDown={(e) => { if (e.key === "Enter") onClose(); }}>
            close ✕
          </span>
        </header>
        <div className="modal-body glob-prompt-body">
          <p className="glob-prompt-desc">
            On-demand rules only load when Claude opens files matching a pattern. Enter at least one path pattern for <code>{basename}</code>.
          </p>
          <input
            ref={inputRef}
            type="text"
            className="glob-prompt-input"
            placeholder="e.g. src/api/**, docs/**"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleApply(); }}
          />
          <span className="glob-prompt-hint">Separate multiple patterns with commas. Use <code>**</code> to match any depth.</span>
        </div>
        <footer className="modal-foot">
          <span className="note" />
          <div className="actions">
            <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
            <button
              type="button"
              className="btn primary"
              disabled={value.trim().length === 0}
              onClick={handleApply}
            >
              Continue
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
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
  const dataReady = !loading && allCwdSim.size > 0;

  return (
    <div className="sim-allcwds-wrap">
      {loading && <div className="sim-allcwds-loading-banner">Loading…</div>}
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
            const sim = dataReady ? allCwdSim.get(entry.path) : undefined;
            const nc = dataReady ? (allCwdNonCanon.get(entry.path) ?? []) : [];
            const ncPaths = new Set(nc.map((e) => e.file_path));
            return (
              <AllCwdsRow
                key={entry.path}
                entry={entry}
                sim={sim}
                ncPaths={ncPaths}
                placeholder={!dataReady}
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
  placeholder: boolean;
  onCellClick: (cwd: string) => void;
}

function AllCwdsRow({ entry, sim, ncPaths, placeholder, onCellClick }: AllCwdsRowProps) {
  const slotCounts: Record<SlotKey, number> = {
    managed: 0, user: 0, ancestor: 0, project: 0, automemory: 0, ondemand: 0,
  };
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
        if (placeholder) {
          return <td key={slot} className="sim-allcwds-cell sim-allcwds-cell-placeholder" />;
        }
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
            {!isEmpty && <span className="sim-allcwds-cell-count">{count}</span>}
          </td>
        );
      })}
    </tr>
  );
}

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

// --- Icons ------------------------------------------------------------------

function AlertTriangleIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function InfoIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}

// --- helpers ----------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
