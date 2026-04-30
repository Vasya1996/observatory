/**
 * ContextMenu — small floating panel at cursor position for right-click on
 * graph nodes and simulator slot cards. Currently has one entry: "Delete file".
 *
 * Non-writable or read-only files get a disabled entry with an explanation.
 * The confirm dialog is inlined here; the actual delete pipeline
 * (POST /api/delete → /api/delete-confirm) is called directly.
 *
 * After a successful delete, a long-lived toast (10s) carries an Undo button
 * that calls POST /api/delete-undo with the snapshot_id.
 */
import { useEffect, useRef, useState } from "react";
import { postDeletePreview, postDeleteConfirm, ApiError } from "../api/client";
import { useStore } from "../state/store";

export interface ContextMenuTarget {
  path: string;
  displayName: string;
  writable: boolean;
  x: number; // client X
  y: number; // client Y
}

interface Props {
  target: ContextMenuTarget | null;
  onClose: () => void;
}

export function ContextMenu({ target, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const setEditorOpen = useStore((s) => s.setEditorOpen);
  const editorPath = useStore((s) => s.editorPath);

  // Close on outside click.
  useEffect(() => {
    if (!target) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setConfirmOpen(false);
        onClose();
      }
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [target, onClose]);

  // Close on Escape.
  useEffect(() => {
    if (!target) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setConfirmOpen(false); onClose(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [target, onClose]);

  if (!target) return null;

  const handleDeleteClick = () => {
    if (!target.writable) return;
    setConfirmOpen(true);
  };

  const handleConfirm = async () => {
    setBusy(true);
    try {
      const preview = await postDeletePreview(target.path);
      const confirmed = await postDeleteConfirm(preview.confirm_token);
      if (confirmed.deleted) {
        const snapshotId = confirmed.snapshot_id;
        const deletedPath = target.path;
        const name = target.displayName;
        // Close editor if the deleted file was open.
        if (editorPath === deletedPath) {
          setEditorOpen(null, false);
        }
        onClose();
        // Long-lived toast with Undo button.
        useStore.getState().pushToast({
          kind: "success",
          message: `Deleted ${name}`,
          undoSnapshotId: snapshotId,
          undoPath: deletedPath,
          undoLabel: "Undo (7 days)",
          ttl: 10000,
        });
      }
    } catch (err) {
      onClose();
      const msg = err instanceof ApiError
        ? err.detail
        : "Could not delete — please try again.";
      useStore.getState().pushToast({ kind: "error", message: msg });
    } finally {
      setBusy(false);
      setConfirmOpen(false);
    }
  };

  // Position the menu so it stays within the viewport.
  const menuStyle: React.CSSProperties = {
    position: "fixed",
    zIndex: 200,
    left: target.x,
    top: target.y,
  };

  if (confirmOpen) {
    return (
      <div ref={menuRef} className="ctx-confirm" style={menuStyle} role="dialog" aria-modal aria-label="Confirm delete">
        <div className="ctx-confirm-title">
          Delete <b>{target.displayName}</b>?
        </div>
        <div className="ctx-confirm-body">
          This will move the file to a snapshot. You can undo for 7 days.
        </div>
        <div className="ctx-confirm-btns">
          <button
            type="button"
            className="ctx-confirm-cancel"
            onClick={() => { setConfirmOpen(false); onClose(); }}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="ctx-confirm-delete"
            onClick={handleConfirm}
            disabled={busy}
          >
            {busy ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div ref={menuRef} className="ctx-menu" style={menuStyle} role="menu">
      {target.writable ? (
        <button
          type="button"
          className="ctx-menu-item ctx-menu-item-danger"
          role="menuitem"
          onClick={handleDeleteClick}
        >
          Delete file…
        </button>
      ) : (
        <button
          type="button"
          className="ctx-menu-item ctx-menu-item-disabled"
          role="menuitem"
          disabled
          title="Managed by Claude Code — cannot delete"
        >
          Delete file…
          <span className="ctx-menu-item-hint">managed file</span>
        </button>
      )}
    </div>
  );
}

