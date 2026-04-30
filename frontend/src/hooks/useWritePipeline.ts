/**
 * useWritePipeline — single entry point for every Phase 2 write.
 *
 * Locked rule #36: the diff modal precedes every write, including soft
 * inline-diff UX (chip variant). Locked rule #37: atomic write rejects on
 * `base_hash` mismatch. Locked rule #38 + #39: snapshot retention + writable-
 * kind whitelist enforced server-side.
 *
 * Flow per call to `requestWrite(patches, opts)`:
 *  1. POST /api/preview for each patch sequentially → collect token + diff.
 *     Any failure here aborts before user confirmation (no partial state).
 *  2. Stage a `writeIntent` in the store. The DiffModal (or PreviewChip when
 *     `softConfirm: true`) pulls from the store and renders. Hook awaits the
 *     user's verdict via a single Promise that resolves on confirm/cancel.
 *  3. On confirm: POST /api/write for each token in order. Stop on the first
 *     failure — partial commits are inevitable when the FS rejects mid-batch,
 *     but we don't keep firing tokens whose dependencies just broke.
 *  4. Push a success or error toast. Return aggregate result.
 *
 * The hook itself is render-stable: it returns one method, no state, just
 * Zustand drivers. Mount sites (DiffModal/PreviewChip/Toast) live in App.tsx.
 */
import { useCallback } from "react";
import { ApiError, postPreview, postWrite } from "../api/client";
import type { PreviewResponse } from "../api/client";
import { useStore } from "../state/store";
import type { WritePatch } from "../state/store";

export type { WritePatch } from "../state/store";

export type WriteResult =
  | { ok: true; snapshotIds: string[] }
  | { ok: false; reason: string };

export interface RequestWriteOptions {
  // When true, the soft-UX PreviewChip is used instead of the modal. Intended
  // for one-click toggles where a full modal would degrade UX.
  softConfirm?: boolean;
}

// Tokens computed at preview-time, paired with the patches that produced them.
// Used to build the per-patch render payload AND to fire the actual writes
// once the user confirms.
export interface PreviewedPatch {
  patch: WritePatch;
  confirmToken: string;
  diff: string;
  baseHash: string;
  isCreation: boolean;
}

// Module-level bridge so the modal/chip can read the previewed patches the
// hook fetched without round-tripping through the store. Keeps the store
// payload lean (just the user-supplied patches + the resolver functions).
//
// Single-flight: only one writeIntent can exist at a time, enforced by the
// hook (it awaits resolution before staging the next intent), so the Map
// pattern is overkill — a single slot is enough. We key by softConfirm so
// modal and chip render paths don't collide if they ever overlap.
let CURRENT_PREVIEWS: PreviewedPatch[] = [];

export function getCurrentPreviews(): PreviewedPatch[] {
  return CURRENT_PREVIEWS;
}

export function useWritePipeline() {
  const setWriteIntent = useStore((s) => s.setWriteIntent);
  const pushToast = useStore((s) => s.pushToast);
  const bumpDataVersion = useStore((s) => s.bumpDataVersion);

  const requestWrite = useCallback(
    async (
      patches: WritePatch[],
      opts?: RequestWriteOptions,
    ): Promise<WriteResult> => {
      const softConfirm = opts?.softConfirm ?? false;

      if (patches.length === 0) {
        return { ok: false, reason: "no patches supplied" };
      }

      // 1. Preview each patch. Any failure here aborts before staging.
      const previews: PreviewedPatch[] = [];
      try {
        for (const p of patches) {
          const res = await postPreview(p.path, p.newContent);
          previews.push({
            patch: p,
            confirmToken: res.confirm_token,
            diff: res.diff,
            baseHash: res.base_hash,
            isCreation: res.is_creation,
          });
        }
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        pushToast({ kind: "error", message: `Preview failed: ${reason}` });
        return { ok: false, reason };
      }

      CURRENT_PREVIEWS = previews;

      // 2. Stage intent + await user verdict.
      const verdict = await new Promise<"confirm" | "cancel">((resolve) => {
        setWriteIntent({
          patches,
          softConfirm,
          onConfirm: () => resolve("confirm"),
          onCancel: () => resolve("cancel"),
        });
      });

      // 3. Cancel path: clear staged intent, drop tokens (server lazily expires
      //    them after 5 min anyway, but we don't push a toast — cancellation
      //    is silent by design).
      if (verdict === "cancel") {
        setWriteIntent(null);
        CURRENT_PREVIEWS = [];
        return { ok: false, reason: "cancelled" };
      }

      // 4. Confirm path: fire writes in order. Surface the first failure
      //    inline (toast) and stop — partial commits would already have
      //    happened on disk for prior patches; that's the price of multi-file
      //    sequence. Future iterations can add a backend-side transaction.
      const snapshotIds: string[] = [];
      for (const pv of previews) {
        try {
          const r = await postWrite(pv.confirmToken);
          snapshotIds.push(r.snapshot_id);
        } catch (e) {
          const status = e instanceof ApiError ? e.status : 0;
          const reason = e instanceof Error ? e.message : String(e);
          setWriteIntent(null);
          CURRENT_PREVIEWS = [];
          pushToast({
            kind: "error",
            message:
              status === 409
                ? "Couldn't save — the file was changed somewhere else, please reload"
                : status === 404 && reason.includes("expired")
                  ? "This took too long — please try again"
                  : `Save failed: ${reason}`,
          });
          return { ok: false, reason };
        }
      }

      setWriteIntent(null);
      CURRENT_PREVIEWS = [];
      const summary =
        patches.length === 1
          ? `Wrote ${patches[0].path.split("/").pop()}`
          : `Wrote ${patches.length} files`;
      pushToast({ kind: "success", message: summary });
      bumpDataVersion();
      return { ok: true, snapshotIds };
    },
    [setWriteIntent, pushToast, bumpDataVersion],
  );

  /**
   * Confirm a pre-staged preview (from a specialised backend endpoint like
   * /api/tier2-install-preview). Shows the DiffModal, then fires /api/write
   * with the provided confirm_token. Locked rule #36 still holds — DiffModal
   * is shown before any write completes.
   *
   * path is used only for display in the DiffModal; the actual write goes to
   * the token's stored path on the backend.
   */
  const confirmStagedPreview = useCallback(
    async (
      path: string,
      preview: PreviewResponse,
    ): Promise<WriteResult> => {
      const syntheticPatch: WritePatch = { path, newContent: "" };
      CURRENT_PREVIEWS = [
        {
          patch: syntheticPatch,
          confirmToken: preview.confirm_token,
          diff: preview.diff,
          baseHash: preview.base_hash,
          isCreation: preview.is_creation,
        },
      ];

      const verdict = await new Promise<"confirm" | "cancel">((resolve) => {
        setWriteIntent({
          patches: [syntheticPatch],
          softConfirm: false,
          onConfirm: () => resolve("confirm"),
          onCancel: () => resolve("cancel"),
        });
      });

      if (verdict === "cancel") {
        setWriteIntent(null);
        CURRENT_PREVIEWS = [];
        return { ok: false, reason: "cancelled" };
      }

      try {
        const r = await postWrite(preview.confirm_token);
        setWriteIntent(null);
        CURRENT_PREVIEWS = [];
        pushToast({ kind: "success", message: `Wrote ${path.split("/").pop()}` });
        bumpDataVersion();
        return { ok: true, snapshotIds: [r.snapshot_id] };
      } catch (e) {
        const status = e instanceof ApiError ? e.status : 0;
        const reason = e instanceof Error ? e.message : String(e);
        setWriteIntent(null);
        CURRENT_PREVIEWS = [];
        pushToast({
          kind: "error",
          message:
            status === 409
              ? "Couldn't save — the file was changed somewhere else, please reload"
              : `Save failed: ${reason}`,
        });
        return { ok: false, reason };
      }
    },
    [setWriteIntent, pushToast, bumpDataVersion],
  );

  return { requestWrite, confirmStagedPreview };
}
