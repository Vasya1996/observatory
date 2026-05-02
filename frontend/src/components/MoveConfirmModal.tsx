/**
 * MoveConfirmModal — shows a confirmation dialog before physically moving a
 * file on disk (DnD drop) or renaming it (context-menu Rename action).
 *
 * Flow:
 *   1. On open, call POST /api/migrate-preview with mode="move-to-path".
 *   2. Show source, destination, sim diff summary, orphan importers warning.
 *   3. User clicks "Move file" → POST /api/migrate-finalize (commit).
 *      User clicks "Cancel" → POST /api/migrate-finalize (rollback) + close.
 *
 * 409 from preview → show inline error ("file already exists").
 * 400 from preview → show inline error.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  postMigratePreview,
  postMigrateFinalize,
  type MigratePreviewResponse,
} from "../api/client";
import { useStore } from "../state/store";

function collapseHome(p: string): string {
  return p.replace(/^\/home\/[^/]+\//, "~/").replace(/^\/home\/[^/]+$/, "~");
}

function basename(p: string): string {
  return p.split("/").pop() ?? p;
}

export interface MoveConfirmModalProps {
  sourcePath: string;
  dstDir: string;
  activeCwd: string;
  newName?: string;
  onClose: () => void;
}

export function MoveConfirmModal({
  sourcePath,
  dstDir,
  activeCwd,
  newName,
  onClose,
}: MoveConfirmModalProps) {
  const [preview, setPreview] = useState<MigratePreviewResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bumpDataVersion = useStore((s) => s.bumpDataVersion);
  const pushToast = useStore((s) => s.pushToast);
  const backdropRef = useRef<HTMLDivElement>(null);

  const finalName = newName ?? basename(sourcePath);
  const destDisplay = collapseHome(dstDir + "/" + finalName);
  const srcDisplay = collapseHome(sourcePath);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    setPreview(null);
    postMigratePreview({
      source_path: sourcePath,
      mode: "move-to-path",
      dst_dir: dstDir,
      active_cwd: activeCwd,
      ...(newName ? { new_name: newName } : {}),
    })
      .then((r) => {
        if (!cancelled) setPreview(r);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 409) {
          setLoadError(
            "A file with that name already exists at the destination. Rename it via the context menu and try again.",
          );
        } else {
          setLoadError(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sourcePath, dstDir, activeCwd, newName]);

  const handleConfirm = useCallback(async () => {
    if (!preview || busy) return;
    setBusy(true);
    try {
      await postMigrateFinalize(preview.migration_id, "commit");
      bumpDataVersion();
      pushToast({ kind: "success", message: `Moved to ${destDisplay}` });
      onClose();
    } catch (e) {
      pushToast({
        kind: "error",
        message: e instanceof Error ? e.message : "Move failed.",
      });
      setBusy(false);
    }
  }, [preview, busy, bumpDataVersion, pushToast, destDisplay, onClose]);

  const handleCancel = useCallback(async () => {
    if (preview) {
      try {
        await postMigrateFinalize(preview.migration_id, "rollback");
      } catch {
        // Best-effort rollback; tokens are TTL-expired anyway.
      }
    }
    onClose();
  }, [preview, onClose]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleCancel();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleCancel]);

  const simDiff = preview?.plan.sim_diff;
  const orphans = preview?.plan.orphan_importers ?? [];

  return (
    <div
      className="modal-veil show"
      ref={backdropRef}
      onMouseDown={(e) => {
        if (e.target === backdropRef.current) handleCancel();
      }}
    >
      <div className="move-confirm-modal" role="dialog" aria-modal aria-label="Move file">
        <div className="move-confirm-header">
          <span className="move-confirm-title">Move file</span>
          <button className="move-confirm-close" onClick={handleCancel} aria-label="Cancel">×</button>
        </div>

        <div className="move-confirm-body">
          <div className="move-confirm-row">
            <span className="move-confirm-label">From</span>
            <code className="move-confirm-path">{srcDisplay}</code>
          </div>
          <div className="move-confirm-row">
            <span className="move-confirm-label">To</span>
            <code className="move-confirm-path">{destDisplay}</code>
          </div>

          {loadError && (
            <div className="move-confirm-error">{loadError}</div>
          )}

          {!loadError && !preview && (
            <div className="move-confirm-loading">Computing changes…</div>
          )}

          {preview && simDiff && (
            <div className="move-confirm-sim-diff">
              <div className="move-confirm-sim-title">Load-order changes</div>
              {simDiff.added.length === 0 && simDiff.removed.length === 0 && simDiff.hash_changed.length === 0 ? (
                <div className="move-confirm-sim-none">No change to what Claude loads.</div>
              ) : (
                <>
                  {simDiff.added.map((p) => (
                    <div key={p} className="move-confirm-sim-row added">
                      + {collapseHome(p)}
                    </div>
                  ))}
                  {simDiff.removed.map((p) => (
                    <div key={p} className="move-confirm-sim-row removed">
                      − {collapseHome(p)}
                    </div>
                  ))}
                  {simDiff.hash_changed.map((p) => (
                    <div key={p} className="move-confirm-sim-row changed">
                      ~ {collapseHome(p)}
                    </div>
                  ))}
                </>
              )}
            </div>
          )}

          {orphans.length > 0 && (
            <div className="move-confirm-orphans">
              <div className="move-confirm-orphans-title">
                Warning: {orphans.length} file{orphans.length > 1 ? "s" : ""} @-import this file and will break
              </div>
              {orphans.map((o) => (
                <div key={o.file_path + o.line_number} className="move-confirm-orphan-row">
                  <code>{collapseHome(o.file_path)}</code>
                  <span className="move-confirm-orphan-line">line {o.line_number}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="move-confirm-footer">
          <button
            type="button"
            className="move-confirm-cancel-btn"
            onClick={handleCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="move-confirm-ok-btn"
            onClick={handleConfirm}
            disabled={!preview || busy || !!loadError}
          >
            {busy ? "Moving…" : newName ? "Rename file" : "Move file"}
          </button>
        </div>
      </div>
    </div>
  );
}
