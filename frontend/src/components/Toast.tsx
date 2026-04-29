/**
 * Toast — bottom-right toast container. Subscribes to the Zustand `toasts`
 * slice and auto-dismisses each entry after 2.5s. Kinds:
 *   - success: --lime accent
 *   - error:   --rust accent
 *   - info:    --paper accent
 *
 * The dismissal timer is per-toast so fast-stacked toasts don't restart each
 * other; the container spawns a `ToastItem` per entry and each item owns its
 * own timer.
 */
import { useEffect } from "react";
import { useStore } from "../state/store";
import type { Toast as ToastShape } from "../state/store";

const DISMISS_MS = 2500;

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
  useEffect(() => {
    const t = setTimeout(onDismiss, DISMISS_MS);
    return () => clearTimeout(t);
  }, [onDismiss]);

  return (
    <div className={`toast toast-${toast.kind}`} role="status">
      <span className="toast-glyph" aria-hidden="true">
        {toast.kind === "success" ? "✓" : toast.kind === "error" ? "!" : "·"}
      </span>
      <span className="toast-msg">{toast.message}</span>
    </div>
  );
}
