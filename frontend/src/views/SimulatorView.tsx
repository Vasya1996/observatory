import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CwdSelector } from "../components/CwdSelector";
import { Inspector } from "../components/Inspector";
import { EditorPanel } from "../components/EditorPanel";
import { ContextMenu } from "../components/ContextMenu";
import type { ContextMenuTarget } from "../components/ContextMenu";
import { NormalizeWizardModal, type NormalizeMode } from "../components/NormalizeWizardModal";
import { MigrationVerifiedCard, persistMigrationCard } from "../components/MigrationVerifiedCard";
import type { MigrationCommitData } from "../components/NormalizeWizardModal";
import { fetchCwds, fetchNonCanonical, fetchSimulate, fetchTier2Status, postSuppress } from "../api/client";
import type { Tier2Status } from "../api/client";
import { useWritePipeline } from "../hooks/useWritePipeline";
import { useStore } from "../state/store";
import {
  buildSlotMap,
  SLOT_ORDER,
  SLOT_LABELS,
  SLOT_DESCRIPTIONS,
  type SlotKey,
  type SlottedFile,
} from "../simulator/slotAssign";
import { computeAmbiguousBasenames, displayLabel } from "../components/labels";
import type {
  CwdEntry,
  FileEntry,
  LoadStatus,
  NonCanonicalEntry,
  OrphanConfigEntry,
  SimulatorStats,
  SimulatorResponse,
  TimelineStep,
} from "../types";

const TOKENS_PER_LINE = 12;

const TIER2_BANNER_KEY = "observatory_tier2_banner_dismissed";
const ORPHAN_SECTION_KEY = "observatory_orphan_section_collapsed";

function humaniseOrphanReason(reason: string): string {
  if (reason === "buried_in_config_folder") return "Buried in config folder";
  if (reason === "outside_load_chain") return "Outside load chain";
  return reason.replace(/_/g, " ");
}

function humaniseOrphanReasonLong(reason: string): string {
  if (reason === "buried_in_config_folder") {
    return "It lives inside a subfolder Claude only reads when it opens files there — not at session start or from another project.";
  }
  if (reason === "outside_load_chain") {
    return "It's outside any folder Claude scans for rules or CLAUDE.md files.";
  }
  return reason.replace(/_/g, " ");
}

function humaniseReason(reason: string): string {
  if (reason === "loaded_via_at_import") return "Loaded by reference (@-import)";
  if (reason === "outside_canonical_dir") return "File is outside the expected folder";
  if (reason === "wrong_filename_at_canonical_path") return "Filename not recognised at this location";
  return reason.replace(/_/g, " ");
}

function humaniseMatchedOn(matchedOn: string): string {
  if (matchedOn === "user-global") return "Always loaded for you";
  if (matchedOn === "no-paths") return "Always loaded (no path filter)";
  if (matchedOn === "project-team") return "Team-shared project file";
  if (matchedOn === "ancestor-walk") return "Found in a parent folder";
  if (matchedOn === "add-dir") return "Loaded from an extra directory";
  if (matchedOn === "managed") return "Organisation policy";
  if (matchedOn === "automemory") return "Auto-memory notes";
  // paths glob — show as "matches <glob>"
  if (matchedOn.includes("*") || matchedOn.includes("/")) return `Matched path pattern: ${matchedOn}`;
  return matchedOn.replace(/-/g, " ");
}

function collapseHome(p: string, home?: string): string {
  const h = home ?? "";
  if (h && p.startsWith(h + "/")) return "~/" + p.slice(h.length + 1);
  if (h && p === h) return "~";
  // Fallback: collapse any /home/<user>/ prefix.
  const m = /^\/home\/[^/]+\/(.+)$/.exec(p);
  if (m) return "~/" + m[1];
  return p;
}

// Determine which DnD migration mode to use given source → destination slots.
function dndModeForSlots(srcSlot: SlotKey, dstSlot: SlotKey): NormalizeMode | null {
  if (dstSlot === "ondemand") return null; // requires glob prompt — handled separately
  if (srcSlot === "ondemand" && (dstSlot === "user" || dstSlot === "project" || dstSlot === "ancestor")) return "remove-paths";
  if ((srcSlot === "user" || srcSlot === "ancestor") && dstSlot === "project") return "move-to-project";
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
  const { confirmStagedPreview } = useWritePipeline();

  const [steps, setSteps] = useState<TimelineStep[]>([]);
  const [stats, setStats] = useState<SimulatorStats | null>(null);
  const [statusMap, setStatusMap] = useState<Map<string, LoadStatus> | null>(null);
  const [loading, setLoading] = useState(false);

  const [nonCanonMap, setNonCanonMap] = useState<Map<string, NonCanonicalEntry>>(new Map());
  // Whether the current cwd has the suppress flag on.
  const [suppressed, setSuppressed] = useState(false);

  // Orphan configs — files that exist on disk but Claude never loads anywhere.
  // Backend returns these with any cwd query; value is cwd-independent.
  const [orphanConfigs, setOrphanConfigs] = useState<OrphanConfigEntry[]>([]);
  const [orphanSectionCollapsed, setOrphanSectionCollapsed] = useState(
    () => localStorage.getItem(ORPHAN_SECTION_KEY) === "1",
  );
  const toggleOrphanSection = () => {
    setOrphanSectionCollapsed((v) => {
      const next = !v;
      localStorage.setItem(ORPHAN_SECTION_KEY, next ? "1" : "0");
      return next;
    });
  };

  const [panelOpen, setPanelOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const [cwdList, setCwdList] = useState<CwdEntry[]>([]);
  const [allCwdSim, setAllCwdSim] = useState<Map<string, SimulatorResponse>>(new Map());
  const [allCwdNonCanon, setAllCwdNonCanon] = useState<Map<string, NonCanonicalEntry[]>>(new Map());
  const [allCwdLoading, setAllCwdLoading] = useState(false);

  // Tier 2 status (fetched from backend; null while loading).
  const [tier2Status, setTier2Status] = useState<Tier2Status | null>(null);
  // Tier 2 banner dismissal (localStorage-persisted — only hides the
  // "not installed" informational note, not the enable button).
  const [tier2BannerDismissed, setTier2BannerDismissed] = useState(
    () => localStorage.getItem(TIER2_BANNER_KEY) === "1",
  );
  const dismissTier2Banner = () => {
    localStorage.setItem(TIER2_BANNER_KEY, "1");
    setTier2BannerDismissed(true);
  };

  useEffect(() => {
    fetchTier2Status().then(setTier2Status).catch(() => {});
  }, []);

  // Enable Tier 2 — calls the specialised backend preview endpoint (which
  // generates the new settings.json content with the hook entry), then shows
  // the DiffModal via confirmStagedPreview. Locked rule #36: DiffModal before
  // any write.
  const enableTier2 = useCallback(async () => {
    const settingsEntry = files.find(
      (f) => f.kind === "settings" && f.display.endsWith("settings.json") && !f.display.endsWith("settings.local.json"),
    );
    if (!settingsEntry) return;
    try {
      const previewRes = await fetch("/api/tier2-install-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!previewRes.ok) return;
      const preview = await previewRes.json() as { confirm_token: string; diff: string; base_hash: string; is_creation: boolean };
      const result = await confirmStagedPreview(settingsEntry.path, preview);
      if (result.ok) fetchTier2Status().then(setTier2Status).catch(() => {});
    } catch {
      // Errors surface via Toast from confirmStagedPreview
    }
  }, [files, confirmStagedPreview]);

  // Normalize wizard state.
  const [normalizeEntry, setNormalizeEntry] = useState<NonCanonicalEntry | null>(null);
  const [normalizePrefilledMode, setNormalizePrefilledMode] = useState<NormalizeMode | null>(null);
  const [normalizeForcedMode, setNormalizeForcedMode] = useState<NormalizeMode | null>(null);
  const [normalizePathsGlobs, setNormalizePathsGlobs] = useState<string[] | null>(null);
  const [normalizeTargetCwd, setNormalizeTargetCwd] = useState<string | null>(null);
  // Bump to force MigrationVerifiedCard to re-read localStorage after a commit.
  const [cardKey, setCardKey] = useState(0);

  // Glob prompt for DnD into On-demand.
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
      setOrphanConfigs([]);
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
        setOrphanConfigs(ncRes.orphan_configs ?? []);
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

  // Derive the user's home directory from the file index rather than hard-coding.
  const derivedHome = useMemo(() => {
    for (const f of files) {
      if (f.display.startsWith("~/") && f.path.length > 2) {
        const suffix = f.display.slice(1);
        if (f.path.endsWith(suffix)) return f.path.slice(0, f.path.length - suffix.length);
      }
    }
    for (const f of files) {
      const m = /^(\/home\/[^/]+)\/.+/.exec(f.path);
      if (m) return m[1];
    }
    return "/home";
  }, [files]);

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
  // Badge total: non-canonical + orphan configs.
  const badgeTotal = nonCanonCount + orphanConfigs.length;

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

  // Opens the normalize wizard for an orphan config — synthesises a NonCanonicalEntry
  // so the existing wizard can handle it without a new code path.
  const handleOrphanMove = useCallback((orphan: OrphanConfigEntry) => {
    const syntheticEntry: NonCanonicalEntry = {
      file_path: orphan.file_path,
      slot: "ondemand",
      canonical_path: orphan.suggested_canonical_paths[0] ?? orphan.file_path,
      reason: "outside_canonical_dir",
    };
    setNormalizeEntry(syntheticEntry);
    setNormalizePrefilledMode("rule");
    setPanelOpen(false);
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

  const handleMigrationCommitted = useCallback((data: MigrationCommitData) => {
    persistMigrationCard(data);
    setCardKey((k) => k + 1);
    setNormalizeEntry(null);
    setNormalizePrefilledMode(null);
    setNormalizeForcedMode(null);
    setNormalizePathsGlobs(null);
    setNormalizeTargetCwd(null);
  }, []);

  // DnD handlers at slot-column level.
  const handleDndDrop = useCallback((srcEntry: SlottedFile, dstSlot: SlotKey) => {
    const ncEntry = nonCanonMap.get(srcEntry.file.path);
    const entry: NonCanonicalEntry = ncEntry ?? {
      file_path: srcEntry.file.path,
      slot: srcEntry.slot,
      canonical_path: srcEntry.file.path,
      reason: "outside_canonical_dir",
    };

    if (dstSlot === "ondemand") {
      setGlobPromptEntry(entry);
      return;
    }

    const mode = dndModeForSlots(srcEntry.slot, dstSlot);
    if (mode === "move-to-project") {
      setNormalizeEntry(entry);
      setNormalizePrefilledMode(null);
      setNormalizeForcedMode("move-to-project");
      setNormalizePathsGlobs(null);
      setNormalizeTargetCwd(lastCwd ?? null);
      return;
    }
    if (mode === "remove-paths") {
      setNormalizeEntry(entry);
      setNormalizePrefilledMode(null);
      setNormalizeForcedMode("remove-paths");
      setNormalizePathsGlobs(null);
      setNormalizeTargetCwd(null);
      return;
    }
    handleNormalize(entry, mode ?? "rule");
  }, [nonCanonMap, handleNormalize, lastCwd]);

  return (
    <div className={`sim-shell${inspectorOpen ? " has-inspector" : ""}`}>
      {/* Tier 2 banner — shows install prompt when not installed, or event count when active */}
      {simulatorMode === "per-cwd" && tier2Status !== null && (
        tier2Status.available ? (
          <div className="sim-tier2-banner sim-tier2-banner--active">
            <span className="sim-tier2-banner-icon" aria-hidden="true">✓</span>
            <span className="sim-tier2-banner-text">
              Live verification active — {tier2Status.events_captured} load events captured.
              Claude is recording which files it actually loads each session.
            </span>
          </div>
        ) : !tier2BannerDismissed && (
          <div className="sim-tier2-banner">
            <span className="sim-tier2-banner-icon" aria-hidden="true">
              <InfoIcon size={14} />
            </span>
            <span className="sim-tier2-banner-text">
              {tier2Status.preflight.ok
                ? "Live verification is off. Enable it to see which files Claude actually loads each session — compared against the simulator's prediction."
                : `Live verification blocked: ${tier2Status.reason}`}
            </span>
            {tier2Status.preflight.ok && (
              <button
                type="button"
                className="sim-tier2-banner-enable"
                onClick={() => enableTier2()}
              >
                Enable
              </button>
            )}
            <button
              type="button"
              className="sim-tier2-banner-dismiss"
              onClick={dismissTier2Banner}
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        )
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
              <span className="sim-stat-chip" title="Rules that may load depending on which files Claude opens">
                <b>{stats!.conditional_matches}</b>&thinsp;may load
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
        {/* Non-canonical + orphan badge */}
        {simulatorMode === "per-cwd" && badgeTotal > 0 && (
          <div className="sim-noncanon-badge-wrap" ref={panelRef} style={{ marginLeft: "auto" }}>
            <button
              type="button"
              className={`sim-noncanon-badge sim-noncanon-badge-btn${panelOpen ? " open" : ""}`}
              onClick={() => setPanelOpen((v) => !v)}
              title="Some files are in unusual locations or are never loaded by Claude"
            >
              <AlertTriangleIcon size={11} />
              {badgeTotal}&thinsp;file{badgeTotal !== 1 ? "s" : ""} in unusual locations
            </button>
            {panelOpen && (
              <NonCanonPanel
                entries={Array.from(nonCanonMap.values())}
                orphanConfigs={orphanConfigs}
                files={files}
                suppressed={suppressed}
                onOpen={handleOpenFile}
                onNormalize={handleNormalize}
                onOrphanMove={handleOrphanMove}
                onSuppress={handleSuppress}
              />
            )}
          </div>
        )}
        {/* Suppressed pill — shown when non-canonical suggestions are paused for this folder (item 36) */}
        {simulatorMode === "per-cwd" && suppressed && nonCanonCount === 0 && (
          <button
            type="button"
            className="sim-noncanon-badge sim-suppressed-pill"
            onClick={() => handleSuppress(false)}
            title="Suggestions are paused for this folder. Click to re-enable."
            style={{ marginLeft: "auto" }}
          >
            Suggestions paused — click to re-enable
          </button>
        )}
      </div>

      {/* Migration-verified card — shown when a migration was committed recently */}
      {simulatorMode === "per-cwd" && (
        <div className="sim-verified-wrap">
          <MigrationVerifiedCard key={cardKey} activeCwd={lastCwd} />
        </div>
      )}

      {/* Orphan configs section — files Claude never loads in any cwd */}
      {simulatorMode === "per-cwd" && orphanConfigs.length > 0 && (
        <OrphanConfigsSection
          orphanConfigs={orphanConfigs}
          collapsed={orphanSectionCollapsed}
          onToggle={toggleOrphanSection}
          onMove={handleOrphanMove}
        />
      )}

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
          home={derivedHome}
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
          forcedMode={normalizeForcedMode ?? undefined}
          pathsGlobs={normalizePathsGlobs ?? undefined}
          targetCwd={normalizeTargetCwd ?? undefined}
          onClose={() => {
            setNormalizeEntry(null);
            setNormalizePrefilledMode(null);
            setNormalizeForcedMode(null);
            setNormalizePathsGlobs(null);
            setNormalizeTargetCwd(null);
          }}
          onCommitted={handleMigrationCommitted}
          activeCwd={lastCwd ?? undefined}
        />
      )}

      {/* Glob prompt for DnD into On-demand — collects path patterns then opens wizard */}
      {globPromptEntry && (
        <GlobPromptModal
          entry={globPromptEntry}
          onClose={() => setGlobPromptEntry(null)}
          onConfirm={(globs) => {
            const entry = globPromptEntry;
            setGlobPromptEntry(null);
            setNormalizeEntry(entry);
            setNormalizePrefilledMode(null);
            setNormalizeForcedMode("add-paths");
            setNormalizePathsGlobs(globs);
            setNormalizeTargetCwd(null);
          }}
        />
      )}
    </div>
  );
}

// --- NonCanonPanel ----------------------------------------------------------

interface NonCanonPanelProps {
  entries: NonCanonicalEntry[];
  orphanConfigs: OrphanConfigEntry[];
  files: FileEntry[];
  suppressed: boolean;
  onOpen: (filePath: string) => void;
  onNormalize: (entry: NonCanonicalEntry) => void;
  onOrphanMove: (orphan: OrphanConfigEntry) => void;
  onSuppress: (value: boolean) => void;
}

function NonCanonPanel({ entries, orphanConfigs, files, suppressed, onOpen, onNormalize, onOrphanMove, onSuppress }: NonCanonPanelProps) {
  return (
    <div className="sim-noncanon-panel" role="dialog" aria-label="Files in unusual locations">
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

      {entries.length > 0 && (
        <>
          <div className="sim-noncanon-panel-head">
            <span>files in unusual locations</span>
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
        </>
      )}

      {orphanConfigs.length > 0 && (
        <>
          <div className="sim-noncanon-panel-head sim-noncanon-panel-head--orphan">
            <span>files Claude never loads (any folder)</span>
            <span style={{ color: "var(--paper-faint)" }}>{orphanConfigs.length}</span>
          </div>
          <ul className="sim-noncanon-panel-list">
            {orphanConfigs.map((o) => (
              <li key={o.file_path} className="sim-noncanon-panel-row">
                <div className="sim-noncanon-panel-name">{collapseHome(o.file_path)}</div>
                <div className="sim-noncanon-panel-meta">
                  <span className="sim-noncanon-slot sim-noncanon-slot--orphan">{humaniseOrphanReason(o.reason)}</span>
                </div>
                <div className="sim-noncanon-panel-actions">
                  <button
                    type="button"
                    className="sim-noncanon-open-btn"
                    onClick={() => onOrphanMove(o)}
                  >
                    Move file…
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

// --- OrphanConfigsSection ---------------------------------------------------

interface OrphanConfigsSectionProps {
  orphanConfigs: OrphanConfigEntry[];
  collapsed: boolean;
  onToggle: () => void;
  onMove: (orphan: OrphanConfigEntry) => void;
}

function OrphanConfigsSection({ orphanConfigs, collapsed, onToggle, onMove }: OrphanConfigsSectionProps) {
  return (
    <div className="sim-orphan-section">
      <button
        type="button"
        className="sim-orphan-section-header"
        onClick={onToggle}
        aria-expanded={!collapsed}
      >
        <span className="sim-orphan-section-title">
          Files Claude doesn&apos;t load anywhere
          <span className="sim-orphan-section-count">{orphanConfigs.length}</span>
        </span>
        <span className="sim-orphan-section-chevron" aria-hidden="true"
          style={{ transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)" }}>
          <ChevronDownIcon size={14} />
        </span>
      </button>
      {!collapsed && (
        <>
          <p className="sim-orphan-section-desc">
            These rules and CLAUDE.md files exist in your folders but never get loaded by Claude.
            Move them to a canonical location to make Claude actually read them.
          </p>
          <div className="sim-orphan-cards">
            {orphanConfigs.map((o) => (
              <OrphanCard key={o.file_path} orphan={o} onMove={onMove} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// --- OrphanCard -------------------------------------------------------------

interface OrphanCardProps {
  orphan: OrphanConfigEntry;
  onMove: (orphan: OrphanConfigEntry) => void;
}

function OrphanCard({ orphan, onMove }: OrphanCardProps) {
  const [tooltipVisible, setTooltipVisible] = useState(false);
  const basename = orphan.file_path.split("/").pop() ?? orphan.file_path;
  const reason = orphan.reason;

  return (
    <div
      className="sim-orphan-card"
      onMouseEnter={() => setTooltipVisible(true)}
      onMouseLeave={() => setTooltipVisible(false)}
    >
      <div className="sim-orphan-card-name">{basename}</div>
      <div className="sim-orphan-card-path">{collapseHome(orphan.file_path)}</div>
      <div className="sim-orphan-card-chips">
        <span className={`sim-orphan-reason-chip sim-orphan-reason-chip--${reason}`}>
          {humaniseOrphanReason(reason)}
        </span>
      </div>
      {tooltipVisible && (
        <div className="sim-orphan-tooltip" role="tooltip">
          <div className="sim-orphan-tooltip-row">
            <b>What&apos;s wrong:</b> Claude never reads this file in any of your folders.
          </div>
          <div className="sim-orphan-tooltip-row">
            <b>Why it happened:</b> {humaniseOrphanReasonLong(reason)}
          </div>
          {orphan.suggested_canonical_paths.length > 0 && (
            <div className="sim-orphan-tooltip-row">
              <b>Suggested fix{orphan.suggested_canonical_paths.length > 1 ? "es" : ""}:</b>{" "}
              {orphan.suggested_canonical_paths.map((p) => collapseHome(p)).join(" or ")}
            </div>
          )}
        </div>
      )}
      <button
        type="button"
        className="sim-orphan-move-btn"
        onClick={() => onMove(orphan)}
      >
        Move file…
      </button>
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
      if (srcEntry.slot === slotKey) return;
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
        <div className="sim-col-header-top">
          <span className="sim-col-name">{SLOT_LABELS[slotKey]}</span>
          <span className="sim-col-count">{entries.length}</span>
        </div>
        <p className="sim-col-desc">{SLOT_DESCRIPTIONS[slotKey]}</p>
      </div>

      {entries.length === 0 ? (
        <div className="sim-col-empty">none for this folder</div>
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
  const isLocalMd = file.kind === "claude_md" && basename === "CLAUDE.local.md";

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
      aria-label={`${label} — ${status}${isNonCanon ? " (in unusual location)" : ""}`}
      aria-pressed={selected}
    >
      {isNonCanon && (
        <span
          ref={glyphRef}
          className="sim-card-noncanon-glyph"
          onMouseEnter={() => setTooltipVisible(true)}
          onMouseLeave={() => setTooltipVisible(false)}
          aria-label="File is in an unusual location"
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
              <div><b>Expected location:</b> {collapseHome(nonCanonEntry.canonical_path)}</div>
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
        <div className="sim-card-reason">{humaniseMatchedOn(step.matched_on)}</div>
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
          title="Move this file to the right location"
        >
          Move file…
        </button>
      )}

      {isAgentsMd && (
        <div className="sim-card-agents-note">
          Claude Code reads CLAUDE.md, not AGENTS.md. To use this file, add <code>@AGENTS.md</code> inside your CLAUDE.md.
        </div>
      )}
      {isLocalMd && (
        <div className="sim-card-agents-note">
          Personal overrides for this project only — add to .gitignore so it isn't shared with teammates.
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
    : status === "conditional" ? "may load"
    : status === "skipped" ? "available on demand"
    : "not in load chain";
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
  home: string;
  onCellClick: (cwd: string) => void;
}

function AllCwdsTable({
  cwdList,
  allCwdSim,
  allCwdNonCanon,
  loading,
  home,
  onCellClick,
}: AllCwdsTableProps) {
  const dataReady = !loading && allCwdSim.size > 0;

  return (
    <div className="sim-allcwds-wrap">
      {loading && <div className="sim-allcwds-loading-banner">Loading all folders…</div>}
      <table className="sim-allcwds-table">
        <thead>
          <tr>
            <th className="sim-allcwds-cwd-col">Folder</th>
            {SLOT_ORDER.map((slot) => (
              <th key={slot} className="sim-allcwds-slot-col" title={SLOT_DESCRIPTIONS[slot]}>{SLOT_LABELS[slot]}</th>
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
                home={home}
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
  home: string;
  onCellClick: (cwd: string) => void;
}

function AllCwdsRow({ entry, sim, ncPaths, placeholder, home, onCellClick }: AllCwdsRowProps) {
  const slotCounts: Record<SlotKey, number> = {
    managed: 0, user: 0, ancestor: 0, project: 0, automemory: 0, ondemand: 0,
  };
  const slotNc: Record<SlotKey, number> = {
    managed: 0, user: 0, ancestor: 0, project: 0, automemory: 0, ondemand: 0,
  };

  if (sim) {
    for (const step of sim.steps) {
      if (!step.file_path) continue;
      const slot = simPathToSlot(step.file_path, entry.path, home);
      slotCounts[slot]++;
      if (ncPaths.has(resolveAbsolute(step.file_path, home))) {
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

function simPathToSlot(filePath: string, cwd: string, home: string): SlotKey {
  const dotClaude = home + "/.claude";
  let p = filePath;
  if (p.startsWith("~/")) p = home + p.slice(1);
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

function resolveAbsolute(p: string, home: string): string {
  if (p.startsWith("~/")) return home + p.slice(1);
  return p;
}

// --- Icons ------------------------------------------------------------------

function ChevronDownIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

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
