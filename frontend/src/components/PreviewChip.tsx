/**
 * PreviewChip — soft confirmation UX for one-line toggles (skills/plugins/MCP
 * single-flag flips). Replaces the full DiffModal when `softConfirm: true` is
 * passed to `useWritePipeline().requestWrite()`.
 *
 * Visual: floating top-centre, ~380px wide, 44px tall. One-line summary, a
 * 4-second linear progress bar at the bottom (depleting to zero), Cancel link
 * on the left, Apply button on the right. After 4s of inactivity the chip
 * auto-applies. Cancel discards the token (no write); Apply fires immediately.
 *
 * Multi-chip stacking: if the user toggles fast and a second writeIntent gets
 * staged before the first resolves, the hook awaits the prior intent first
 * (single-flight) — so in practice only one chip ever renders at a time. We
 * keep the stack scaffolding (children list + offset) so a future fast-batch
 * variant can plug in without a rewrite.
 *
 * Rule #36 still applies: this IS the diff confirmation surface for soft
 * writes. The full diff is computed by /api/preview just like the modal path,
 * we simply don't render the unified-diff text here — the chip surfaces a
 * one-line summary derived from the patch title.
 */
import { useEffect, useState } from "react";
import { useStore } from "../state/store";
import { getCurrentPreviews } from "../hooks/useWritePipeline";

const APPLY_DELAY_MS = 4000;

export function PreviewChip() {
  const intent = useStore((s) => s.writeIntent);
  const visible = !!intent && intent.softConfirm;

  // Derive the summary line from the patch title. Falls back to the first
  // patch's filename. Multi-patch soft-confirm writes (rare) collapse to
  // "<n> changes" so we don't try to fit two paths in 380px.
  const previews = visible ? getCurrentPreviews() : [];
  const summary = (() => {
    if (!intent || previews.length === 0) return "";
    const explicit = intent.patches.find((p) => p.title)?.title;
    if (explicit) return explicit;
    if (intent.patches.length === 1) {
      const p = intent.patches[0];
      const name = p.path.split("/").pop() ?? p.path;
      return `Update ${name}`;
    }
    return `${intent.patches.length} changes`;
  })();

  const [progress, setProgress] = useState(1);
  const [resolving, setResolving] = useState(false);
  const [done, setDone] = useState(false);

  // Reset transient state on every new intent.
  useEffect(() => {
    setProgress(1);
    setResolving(false);
    setDone(false);
  }, [intent]);

  // Drive the auto-apply timer. We don't run when busy or done — the timer
  // is purely the "user hasn't intervened yet" countdown.
  useEffect(() => {
    if (!visible || resolving || done) return;
    const start = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const elapsed = t - start;
      const remaining = Math.max(0, 1 - elapsed / APPLY_DELAY_MS);
      setProgress(remaining);
      if (remaining <= 0) {
        setResolving(true);
        intent?.onConfirm();
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [visible, resolving, done, intent]);

  // After hook resolves (intent goes null), flash the ✓ briefly before the
  // 400ms fade-out. We only fire the success flash for the confirm path —
  // cancellation just unmounts.
  useEffect(() => {
    if (resolving && !intent) {
      setDone(true);
      const t = setTimeout(() => setDone(false), 400);
      return () => clearTimeout(t);
    }
  }, [resolving, intent]);

  if (!visible || !intent) {
    // Render an inert host so layout doesn't jump on first mount.
    return <div className="preview-chip-host" aria-hidden="true" />;
  }

  const onCancel = () => {
    if (resolving) return;
    intent.onCancel();
  };
  const onApply = () => {
    if (resolving) return;
    setResolving(true);
    intent.onConfirm();
  };

  return (
    <div className="preview-chip-host" role="region" aria-label="Pending change">
      <div className={`preview-chip${done ? " done" : ""}`}>
        <span className="pc-summary">
          {done ? <span className="pc-tick">✓</span> : null}
          {summary}
        </span>
        <div className="pc-actions">
          <button
            type="button"
            className="pc-cancel"
            onClick={onCancel}
            disabled={resolving}
          >
            Cancel
          </button>
          <button
            type="button"
            className="pc-apply"
            onClick={onApply}
            disabled={resolving}
          >
            {resolving ? "Applying…" : "Apply"}
          </button>
        </div>
        <div className="pc-progress" aria-hidden="true">
          <div
            className="pc-progress-fill"
            style={{ transform: `scaleX(${progress})` }}
          />
        </div>
      </div>
    </div>
  );
}
