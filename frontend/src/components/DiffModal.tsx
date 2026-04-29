/**
 * DiffModal — full-screen veil + 720px centred dialog confirming a multi-line
 * write. Mounted globally in App.tsx; rendered when `writeIntent` is non-null
 * AND `writeIntent.softConfirm` is false.
 *
 * Spec anchor: /home/voxdecaelo/claude-dashboard-design/index.html lines
 * 521-574 (.modal-veil / .modal / .modal-head / .modal-body / .diff-head /
 * .diff-line). Visual tokens (rgba veil, backdrop-blur, JetBrains Mono 12px,
 * `--lime` 0.12 opacity for adds, `--rust` 0.12 for dels) come from there.
 *
 * Behaviour (locked rule #36):
 *   - Esc → cancel
 *   - Cmd/Ctrl+Enter → confirm
 *   - click veil → cancel
 *   - 409 / 5xx surfaces inline; for 409 we auto-re-preview after 1.5s,
 *     for 5xx we offer a manual retry. Conflict handling lives in the hook;
 *     this component only renders the staged previews and routes user action.
 *
 * Multi-file diffs stack vertically (Vasya's locked answer). Each file gets
 * its own `.diff` block with a `.diff-head` carrying path + total +/- count.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../state/store";
import { getCurrentPreviews } from "../hooks/useWritePipeline";
import type { PreviewedPatch } from "../hooks/useWritePipeline";

const META_ENV = (import.meta as { env?: { DEV?: boolean } }).env;

// Render the unified diff into structured rows. We re-parse the unified diff
// (rather than ask the backend for a richer payload) because the backend
// already returns a stable diff string per /api/preview, and the parser is
// trivial. Hunk headers (`@@ -a,b +c,d @@`) seed line numbers; +/-/space
// rows are pushed verbatim.
type DiffRow =
  | { kind: "header"; text: string }
  | { kind: "hunk"; oldStart: number; newStart: number; text: string }
  | { kind: "add" | "del" | "ctx"; oldLine: number | null; newLine: number | null; text: string };

function parseDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  const lines = diff.split("\n");
  let oldLine = 0;
  let newLine = 0;
  for (const raw of lines) {
    if (raw.startsWith("--- ") || raw.startsWith("+++ ")) {
      // Skip the file headers — `.diff-head` already shows the path.
      continue;
    }
    if (raw.startsWith("@@")) {
      // @@ -oldStart,oldCount +newStart,newCount @@ context
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (m) {
        oldLine = Number(m[1]);
        newLine = Number(m[2]);
        rows.push({
          kind: "hunk",
          oldStart: oldLine,
          newStart: newLine,
          text: raw,
        });
      } else {
        rows.push({ kind: "header", text: raw });
      }
      continue;
    }
    if (raw.startsWith("+")) {
      rows.push({
        kind: "add",
        oldLine: null,
        newLine,
        text: raw.slice(1),
      });
      newLine += 1;
      continue;
    }
    if (raw.startsWith("-")) {
      rows.push({
        kind: "del",
        oldLine,
        newLine: null,
        text: raw.slice(1),
      });
      oldLine += 1;
      continue;
    }
    if (raw.startsWith(" ")) {
      rows.push({
        kind: "ctx",
        oldLine,
        newLine,
        text: raw.slice(1),
      });
      oldLine += 1;
      newLine += 1;
      continue;
    }
    // Trailing empty line from `diff.split("\n")` — ignore.
    if (raw.length === 0) continue;
    rows.push({ kind: "header", text: raw });
  }
  return rows;
}

function diffStats(rows: DiffRow[]): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const r of rows) {
    if (r.kind === "add") adds += 1;
    else if (r.kind === "del") dels += 1;
  }
  return { adds, dels };
}

// Operation title — rendered as `Confirm <em>title</em>` in the modal head.
// Falls back to a generic "patch" word when no patch supplied a title (matches
// the mockup's "Confirm patch" tone).
function deriveTitle(previews: PreviewedPatch[]): string {
  const explicit = previews.find((p) => p.patch.title)?.patch.title;
  if (explicit) return explicit;
  if (previews.length === 1) return "patch";
  return `${previews.length} files`;
}

export function DiffModal() {
  const intent = useStore((s) => s.writeIntent);
  const previews = useMemo(
    () => (intent && !intent.softConfirm ? getCurrentPreviews() : []),
    [intent],
  );

  // We only render when an intent is staged AND it's the modal flavour.
  // Hooks below still need to run unconditionally — mount the host element
  // either way and gate the visible state via classes.
  const visible = !!intent && !intent.softConfirm;

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [busy, setBusy] = useState(false);

  // Reset busy whenever the intent changes — a new staging starts in the
  // idle state regardless of how the previous one ended.
  useEffect(() => {
    setBusy(false);
  }, [intent]);

  // Esc cancels, Cmd/Ctrl+Enter confirms. Listener attaches when modal is
  // visible AND not busy (busy = in-flight write; ignore key input until
  // the hook resolves so the user can't double-fire Apply).
  useEffect(() => {
    if (!visible || !intent) return;
    const onKey = (e: KeyboardEvent) => {
      if (busy) return;
      if (e.key === "Escape") {
        e.preventDefault();
        intent.onCancel();
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setBusy(true);
        intent.onConfirm();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, intent, busy]);

  // Focus the dialog on mount so screen readers announce it and the keyboard
  // shortcuts work without the user clicking first.
  useEffect(() => {
    if (visible) {
      dialogRef.current?.focus();
    }
  }, [visible]);

  const opTitle = useMemo(() => deriveTitle(previews), [previews]);

  if (!visible || !intent) {
    return <div className="modal-veil" aria-hidden="true" />;
  }

  const onCancel = () => {
    if (busy) return;
    intent.onCancel();
  };
  const onConfirm = () => {
    if (busy) return;
    setBusy(true);
    intent.onConfirm();
  };
  const onVeilClick: React.MouseEventHandler<HTMLDivElement> = (e) => {
    if (e.target === e.currentTarget) onCancel();
  };

  return (
    <div
      className="modal-veil show"
      onClick={onVeilClick}
      role="presentation"
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Confirm ${opTitle}`}
        ref={dialogRef}
        tabIndex={-1}
      >
        <header className="modal-head">
          <h3>
            Confirm <em>{opTitle}</em>
          </h3>
          <span
            className="x"
            role="button"
            tabIndex={0}
            onClick={onCancel}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onCancel();
              }
            }}
            aria-label="Close diff modal"
          >
            close ✕
          </span>
        </header>

        <div className="modal-body">
          {previews.map((p) => (
            <DiffBlock key={p.confirmToken} previewed={p} />
          ))}
          {previews.length === 0 && (
            <p>No patches to apply — this dialog will close.</p>
          )}
        </div>

        <footer className="modal-foot">
          <span className="note">
            {busy
              ? "Applying patches…"
              : "Backup snapshot saved to ~/.claude/.observatory/snapshots/"}
          </span>
          <div className="actions">
            <button
              type="button"
              className="btn ghost"
              onClick={onCancel}
              disabled={busy}
            >
              Cancel <span className="kbd-hint">Esc</span>
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={onConfirm}
              disabled={busy || previews.length === 0}
            >
              Apply patch <span className="kbd-hint">⌘↵</span>
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

// Single-file diff block — `.diff-head` (path + +/- summary) + `.diff` rows.
// Long files: scroll inside the modal-body; this block stays full-bleed within
// the body's content width.
function DiffBlock({ previewed }: { previewed: PreviewedPatch }) {
  const rows = useMemo(() => parseDiff(previewed.diff), [previewed.diff]);
  const stats = useMemo(() => diffStats(rows), [rows]);
  const collapsedPath = collapseHome(previewed.patch.path);
  return (
    <div className="diff-block">
      <div className="diff">
        <div className="diff-head">
          <span>{collapsedPath}</span>
          <span>
            {previewed.isCreation
              ? `new file · +${stats.adds}`
              : `+${stats.adds} −${stats.dels}`}
          </span>
        </div>
        <pre>
          {rows.length === 0 ? (
            <div className="diff-line">
              <span className="ln" />
              <span className="sg">&nbsp;</span>
              <span className="text">(no changes)</span>
            </div>
          ) : (
            rows.map((row, i) => <DiffRowView key={i} row={row} />)
          )}
        </pre>
      </div>
    </div>
  );
}

function DiffRowView({ row }: { row: DiffRow }) {
  if (row.kind === "hunk") {
    return (
      <div className="diff-line hunk">
        <span className="ln" />
        <span className="sg">&nbsp;</span>
        <span className="text">{row.text}</span>
      </div>
    );
  }
  if (row.kind === "header") {
    return (
      <div className="diff-line header">
        <span className="ln" />
        <span className="sg">&nbsp;</span>
        <span className="text">{row.text}</span>
      </div>
    );
  }
  const cls = row.kind === "add" ? "add" : row.kind === "del" ? "del" : "";
  const sign = row.kind === "add" ? "+" : row.kind === "del" ? "−" : " ";
  // Use the post-image line number for added/context rows, pre-image for
  // deleted. Mirrors what GitHub renders.
  const ln =
    row.kind === "add"
      ? row.newLine
      : row.kind === "del"
        ? row.oldLine
        : row.newLine;
  return (
    <div className={`diff-line ${cls}`}>
      <span className="ln">{ln ?? ""}</span>
      <span className="sg">{sign}</span>
      <span className="text">{row.text || " "}</span>
    </div>
  );
}

// `~`-collapse for paths under the user's home. Backend already returns
// collapsed paths in the diff header, but `patch.path` may be absolute when
// supplied by upstream call sites — collapse defensively so the .diff-head
// stays human-readable.
function collapseHome(p: string): string {
  // Best-effort using a runtime-detected home. We don't have process.env on
  // the frontend; the backend's collapsed paths are the authoritative source,
  // so we accept the absolute path verbatim when it doesn't start with /home.
  // Vasya's home on the prestage VPS is /home/voxdecaelo — known constant.
  // Production builds shouldn't hardcode this; we keep it dev-only.
  if (META_ENV?.DEV) {
    if (p.startsWith("/home/voxdecaelo/")) {
      return "~/" + p.slice("/home/voxdecaelo/".length);
    }
  }
  return p;
}
