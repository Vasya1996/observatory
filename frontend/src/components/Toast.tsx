/**
 * Toast — bottom-right toast container. Subscribes to the Zustand `toasts`
 * slice and auto-dismisses each entry after its TTL (default 2.5s; delete
 * toasts use 10s). Kinds:
 *   - success: --lime accent
 *   - error:   --rust accent
 *   - info:    --paper accent
 *
 * Toasts with `undoSnapshotId` render an Undo button that calls
 * POST /api/delete-undo and then dismisses the toast.
 */
import { useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import type { Toast as ToastShape } from "../state/store";
import { postDeleteUndo, ApiError } from "../api/client";

const DEFAULT_DISMISS_MS = 2500;

export function Toast() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div className="toast-host" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  );
}

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: ToastShape;
  onDismiss: () => void;
}) {
  const ttl = toast.ttl ?? DEFAULT_DISMISS_MS;
  const [undoBusy, setUndoBusy] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);
  const pushToast = useStore((s) => s.pushToast);

  // Reset the timer ref so we can cancel it on undo.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    timerRef.current = setTimeout(onDismiss, ttl);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [onDismiss, ttl]);

  const handleUndo = async () => {
    if (!toast.undoSnapshotId || !toast.undoPath) return;
    setUndoBusy(true);
    // Cancel auto-dismiss so the toast stays while undoing.
    if (timerRef.current) clearTimeout(timerRef.current);
    try {
      const r = await postDeleteUndo(toast.undoSnapshotId, toast.undoPath);
      if (r.restored) {
        onDismiss();
        pushToast({ kind: "success", message: "File restored." });
      } else {
        setUndoError("Could not restore — snapshot may have expired.");
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.detail : "Could not restore.";
      setUndoError(msg);
    } finally {
      setUndoBusy(false);
    }
  };

  const hasUndo = !!toast.undoSnapshotId && !!toast.undoPath;

  return (
    <div className={`toast toast-${toast.kind}`} role="status">
      <span className="toast-glyph" aria-hidden="true">
        {toast.kind === "success" ? "✓" : toast.kind === "error" ? "!" : "·"}
      </span>
      <span className="toast-msg">
        {toast.message}
        {undoError && <span className="toast-undo-error"> — {undoError}</span>}
      </span>
      {hasUndo && !undoError && (
        <button
          type="button"
          className="toast-undo-btn"
          onClick={handleUndo}
          disabled={undoBusy}
        >
          {undoBusy ? "Restoring…" : (toast.undoLabel ?? "Undo")}
        </button>
      )}
    </div>
  );
}
