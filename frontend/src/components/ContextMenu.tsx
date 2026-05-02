/**
 * ContextMenu — small floating panel at cursor position for right-click on
 * graph nodes, tree rows and CrossCwdPanel rows. Entries:
 *   - "Edit file…" — opens EditorPanel via setEditorOpen(path, true).
 *     Hidden entirely for plugin-managed files (target.writable === false).
 *   - "Rename…" — inline rename modal using move-to-path mode.
 *   - "Delete file…" — disabled for plugin-managed files; otherwise opens an
 *     inline confirm and runs POST /api/delete → /api/delete-confirm.
 *
 * After a successful delete, a long-lived toast (10s) carries an Undo button
 * that calls POST /api/delete-undo with the snapshot_id.
 */
import { useEffect, useRef, useState } from "react";
import { postDeletePreview, postDeleteConfirm, ApiError } from "../api/client";
import { useStore } from "../state/store";
import { MoveConfirmModal } from "./MoveConfirmModal";

export interface ContextMenuTarget {
  path: string;
  displayName: string;
  writable: boolean;
  x: number; // client X
  y: number; // client Y
  activeCwd?: string;
}

interface Props {
  target: ContextMenuTarget | null;
  onClose: () => void;
}

export function ContextMenu({ target, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameMoveOpen, setRenameMoveOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const setEditorOpen = useStore((s) => s.setEditorOpen);
  const editorPath = useStore((s) => s.editorPath);
  const bumpDataVersion = useStore((s) => s.bumpDataVersion);

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

  const parentDir = target.path.includes("/")
    ? target.path.substring(0, target.path.lastIndexOf("/"))
    : target.path;

  const handleRenameClick = () => {
    setRenameDraft(target.path.split("/").pop() ?? "");
    setRenameOpen(true);
  };

  const handleRenameSubmit = () => {
    const newName = renameDraft.trim();
    if (!newName || newName === (target.path.split("/").pop() ?? "")) {
      setRenameOpen(false);
      onClose();
      return;
    }
    setRenameOpen(false);
    setRenameMoveOpen(true);
  };

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
        bumpDataVersion();
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

  if (renameMoveOpen && target.activeCwd) {
    return (
      <MoveConfirmModal
        sourcePath={target.path}
        dstDir={parentDir}
        activeCwd={target.activeCwd}
        newName={renameDraft.trim()}
        onClose={() => { setRenameMoveOpen(false); onClose(); }}
      />
    );
  }

  if (renameOpen) {
    return (
      <div ref={menuRef} className="ctx-confirm" style={menuStyle} role="dialog" aria-modal aria-label="Rename file">
        <div className="ctx-confirm-title">Rename <b>{target.displayName}</b></div>
        <div className="ctx-confirm-body">
          <input
            className="ctx-rename-input"
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleRenameSubmit();
              if (e.key === "Escape") { setRenameOpen(false); onClose(); }
            }}
            autoFocus
            spellCheck={false}
          />
        </div>
        <div className="ctx-confirm-btns">
          <button
            type="button"
            className="ctx-confirm-cancel"
            onClick={() => { setRenameOpen(false); onClose(); }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="ctx-confirm-delete"
            onClick={handleRenameSubmit}
            disabled={!renameDraft.trim()}
          >
            Rename
          </button>
        </div>
      </div>
    );
  }

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

  const handleEditClick = () => {
    setEditorOpen(target.path, true);
    onClose();
  };

  return (
    <div ref={menuRef} className="ctx-menu" style={menuStyle} role="menu">
      {/* Edit entry — hidden entirely for plugin-managed (read-only) files. */}
      {target.writable && (
        <button
          type="button"
          className="ctx-menu-item"
          role="menuitem"
          onClick={handleEditClick}
        >
          Edit file…
        </button>
      )}
      {target.writable && target.activeCwd && (
        <button
          type="button"
          className="ctx-menu-item"
          role="menuitem"
          onClick={handleRenameClick}
        >
          Rename…
        </button>
      )}
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

