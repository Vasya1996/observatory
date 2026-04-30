import { useEffect, useMemo, useState } from "react";
import { CwdSelector } from "../components/CwdSelector";
import { Inspector } from "../components/Inspector";
import { fetchCwds, fetchSimulate } from "../api/client";
import { useStore } from "../state/store";
import {
  buildSlotMap,
  SLOT_ORDER,
  SLOT_LABELS,
  type SlotKey,
  type SlottedFile,
} from "../simulator/slotAssign";
import { computeAmbiguousBasenames, displayLabel } from "../components/labels";
import type { LoadStatus, SimulatorStats, TimelineStep } from "../types";

// Rough token estimate: 12 tokens per line (matches simulator.py constant).
const TOKENS_PER_LINE = 12;

export function SimulatorView() {
  const files = useStore((s) => s.files);
  const edges = useStore((s) => s.edges);
  const lastCwd = useStore((s) => s.lastCwd);
  const setLastCwd = useStore((s) => s.setLastCwd);
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);

  const [steps, setSteps] = useState<TimelineStep[]>([]);
  const [stats, setStats] = useState<SimulatorStats | null>(null);
  const [statusMap, setStatusMap] = useState<Map<string, LoadStatus> | null>(null);
  const [loading, setLoading] = useState(false);

  // Auto-pick first cwd if none selected (mirrors MapView behaviour).
  useEffect(() => {
    if (lastCwd) return;
    let cancelled = false;
    fetchCwds()
      .then((list) => {
        if (cancelled) return;
        if (!useStore.getState().lastCwd && list.length > 0) {
          setLastCwd(list[0].path);
        }
      })
      .catch((e) => console.warn("[observatory] /api/cwds failed", e));
    return () => {
      cancelled = true;
    };
  }, [lastCwd, setLastCwd]);

  // Fetch simulate results whenever cwd changes.
  useEffect(() => {
    if (!lastCwd) {
      setSteps([]);
      setStats(null);
      setStatusMap(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchSimulate(lastCwd)
      .then((res) => {
        if (cancelled) return;
        setSteps(res.steps);
        setStats(res.stats);
        const map = new Map<string, LoadStatus>();
        for (const s of res.steps) {
          if (s.file_id) map.set(s.file_id, s.status);
        }
        for (const f of files) {
          if (!map.has(f.id)) map.set(f.id, "orphan");
        }
        setStatusMap(map);
      })
      .catch((e) => console.warn("[observatory] /api/simulate failed", e))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [lastCwd, files]);

  const ambiguous = useMemo(() => computeAmbiguousBasenames(files), [files]);

  const slotMap = useMemo(
    () => buildSlotMap(steps, files, edges, lastCwd ?? null),
    [steps, files, edges, lastCwd],
  );

  const totalFiles = useMemo(
    () => SLOT_ORDER.reduce((acc, k) => acc + slotMap[k].length, 0),
    [slotMap],
  );

  // Non-canonical count — always 0 until backend ships is_canonical flag.
  // Step 3 will wire this from the slotMap when the field is present.
  const nonCanonicalCount = 0;

  return (
    <div className={`sim-shell${inspectorOpen ? " has-inspector" : ""}`}>
      {/* Header strip: cwd selector + stats + badge */}
      <div className="sim-header">
        <CwdSelector />
        {lastCwd && (
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
        {/* Non-canonical badge: inert in this commit, wired in step 3. */}
        {nonCanonicalCount > 0 && (
          <span className="sim-noncanon-badge">
            {nonCanonicalCount} non-canonical
          </span>
        )}
        {loading && (
          <span
            className="sim-stat-chip"
            style={{ color: "var(--paper-faint)", fontStyle: "italic" }}
          >
            loading…
          </span>
        )}
      </div>

      {/* 6-column slot grid */}
      <div className="sim-columns">
        {SLOT_ORDER.map((slot) => (
          <SlotColumn
            key={slot}
            slotKey={slot}
            entries={slotMap[slot]}
            ambiguous={ambiguous}
            selectedId={selectedId}
            onSelect={select}
          />
        ))}
      </div>

      {/* Inspector — already-mounted per Phase 1 contract, takes statusMap */}
      <Inspector cy={null} statusMap={statusMap} />
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
}

function SlotColumn({
  slotKey,
  entries,
  ambiguous,
  selectedId,
  onSelect,
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
        entries.map((entry) => (
          <SlotCard
            key={entry.file.id}
            entry={entry}
            ambiguous={ambiguous}
            selected={selectedId === entry.file.id}
            onSelect={onSelect}
          />
        ))
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
}

function SlotCard({ entry, ambiguous, selected, onSelect }: SlotCardProps) {
  const { file, step } = entry;
  const label = displayLabel(file, ambiguous);
  const status: LoadStatus = step?.status ?? "orphan";
  const estTokens = file.line_count * TOKENS_PER_LINE;

  const handleClick = () => {
    onSelect(file.id);
  };

  return (
    <div
      className={`sim-card${selected ? " selected" : ""}`}
      onClick={handleClick}
      onDoubleClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleClick();
        }
      }}
      aria-label={`${label} — ${status}`}
      aria-pressed={selected}
    >
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
    status === "loaded"
      ? "loaded"
      : status === "conditional"
        ? "conditional"
        : status === "skipped"
          ? "skipped"
          : "orphan";
  return <span className={cls}>{label}</span>;
}

// --- helpers ----------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
