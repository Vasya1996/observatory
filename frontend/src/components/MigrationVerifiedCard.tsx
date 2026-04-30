/**
 * MigrationVerifiedCard — compact post-move summary card.
 *
 * Shown above the simulator slot columns after a successful file move.
 * Persists across page reloads via localStorage (7-day TTL per migration_id).
 * Provides an Undo button that restores each written file from its snapshot
 * using the existing /api/delete-undo endpoint (restore_snapshot machinery).
 *
 * Backend note: after migrate-finalize "commit" the in-memory MIGRATION_SNAPSHOTS
 * map is cleared, but the snapshot files on disk survive (last-10 retention per
 * target, locked rule #38). /api/delete-undo calls restore_snapshot(path, snap_id)
 * directly from disk — it does not need the in-memory map. So Path A from the
 * task spec is available without any new backend endpoint.
 */
import { useEffect, useState } from "react";
import { postDeleteUndo } from "../api/client";
import { useStore } from "../state/store";
import type { MigrationCommitData } from "./NormalizeWizardModal";

const STORAGE_KEY = "observatory_migration_verified_cards";
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Serialised shape stored in localStorage — one entry per migration_id.
interface StoredCard extends MigrationCommitData {
  dismissed: boolean;
}

function loadCards(): StoredCard[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as StoredCard[];
    if (!Array.isArray(arr)) return [];
    const now = Date.now();
    return arr.filter((c) => !c.dismissed && now - c.timestamp < TTL_MS);
  } catch {
    return [];
  }
}

function saveCards(cards: StoredCard[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cards));
  } catch {
    // Storage full — best-effort.
  }
}

export function persistMigrationCard(data: MigrationCommitData): void {
  const cards = loadCards();
  const filtered = cards.filter((c) => c.migrationId !== data.migrationId);
  filtered.push({ ...data, dismissed: false });
  // Keep only the last 10 entries to bound storage size.
  saveCards(filtered.slice(-10));
}

interface Props {
  activeCwd: string | null;
}

export function MigrationVerifiedCard({ activeCwd }: Props) {
  const [cards, setCards] = useState<StoredCard[]>([]);
  const pushToast = useStore((s) => s.pushToast);

  // Load on mount and whenever activeCwd changes (card visibility is cwd-scoped).
  useEffect(() => {
    const fresh = loadCards();
    // Only show cards whose cwdPath matches the active cwd.
    const relevant = activeCwd
      ? fresh.filter((c) => c.cwdPath === activeCwd || c.cwdPath === "")
      : fresh;
    setCards(relevant);
  }, [activeCwd]);

  // Re-read from localStorage when this component is focused after a wizard commit.
  // The wizard calls persistMigrationCard then SimulatorView re-renders, which
  // re-instantiates this component fresh. So a simple mount-effect is sufficient.

  const dismiss = (migrationId: string) => {
    setCards((prev) => prev.filter((c) => c.migrationId !== migrationId));
    const all = loadCards();
    const updated = all.map((c) =>
      c.migrationId === migrationId ? { ...c, dismissed: true } : c,
    );
    saveCards(updated);
  };

  const handleUndo = async (card: StoredCard) => {
    if (card.snapshots.length === 0) {
      pushToast({ kind: "info", message: "No snapshot data — undo is not available for this move." });
      return;
    }
    try {
      // Restore each file from its snapshot in reverse order (last write first).
      for (const snap of [...card.snapshots].reverse()) {
        await postDeleteUndo(snap.snapshotId, snap.path);
      }
      pushToast({ kind: "success", message: "Move undone — files restored." });
      dismiss(card.migrationId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      pushToast({ kind: "error", message: `Undo failed — ${msg}` });
    }
  };

  if (cards.length === 0) return null;

  return (
    <>
      {cards.map((card) => (
        <CardBanner key={card.migrationId} card={card} onDismiss={dismiss} onUndo={handleUndo} />
      ))}
    </>
  );
}

interface CardBannerProps {
  card: StoredCard;
  onDismiss: (id: string) => void;
  onUndo: (card: StoredCard) => void;
}

function CardBanner({ card, onDismiss, onUndo }: CardBannerProps) {
  const sd = card.simDiff;
  // Count unique directories that had the file before vs after.
  const dirsBefore = new Set([...sd.removed, ...sd.hashChanged].map(dirOf));
  const dirsChecked = new Set([...sd.added, ...sd.removed, ...sd.hashChanged].map(dirOf)).size;
  const regressions = sd.removed.length;
  const dirsBeforeCount = dirsBefore.size || 1; // fallback to 1 if sim diff is sparse
  const dirsReachable = dirsBeforeCount - regressions;

  const ciLabel =
    card.contentIdentity === "exact"
      ? "Exact copy — content unchanged."
      : card.contentIdentity === "substring"
        ? "All sections found in target file."
        : "Could not verify content — review the file manually.";
  const ciOk = card.contentIdentity !== "fail";

  const canUndo = card.snapshots.length > 0;
  const daysLeft = Math.ceil((TTL_MS - (Date.now() - card.timestamp)) / (24 * 60 * 60 * 1000));

  return (
    <div className="mig-verified-card" role="region" aria-label="Move verified">
      <div className="mig-verified-body">
        <div className="mig-verified-title">
          <CheckIcon />
          Move verified
        </div>

        <div className="mig-verified-row">
          <span className="mig-row-icon ok">✓</span>
          <span>
            {dirsChecked > 0
              ? `Fast checks: ${dirsChecked} director${dirsChecked !== 1 ? "ies" : "y"} checked. ${regressions === 0 ? "No regressions." : `${regressions} regression${regressions !== 1 ? "s" : ""} found.`} File reachable in ${dirsReachable} of ${dirsBeforeCount} director${dirsBeforeCount !== 1 ? "ies" : "y"} that had it before.`
              : "Fast checks: complete."}
          </span>
        </div>

        <div className="mig-verified-row">
          <span className={`mig-row-icon${ciOk ? " ok" : " warn"}`}>{ciOk ? "✓" : "!"}</span>
          <span>Content: {ciLabel}</span>
        </div>

        <div className="mig-verified-row muted">
          <span className="mig-row-icon">—</span>
          <span>Deep checks (live probe): not available on this Claude version.</span>
        </div>

        <div className="mig-verified-footer">
          {canUndo ? (
            <button
              type="button"
              className="mig-undo-btn"
              onClick={() => onUndo(card)}
            >
              Undo move ({daysLeft}d left)
            </button>
          ) : (
            <span className="mig-undo-unavail">Undo will be available in a future update.</span>
          )}
        </div>
      </div>
      <button
        type="button"
        className="mig-verified-dismiss"
        onClick={() => onDismiss(card.migrationId)}
        aria-label="Dismiss verification card"
        title="Dismiss"
      >
        ×
      </button>
    </div>
  );
}

function dirOf(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx >= 0 ? p.slice(0, idx) : p;
}

function CheckIcon() {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" style={{ flexShrink: 0 }}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
