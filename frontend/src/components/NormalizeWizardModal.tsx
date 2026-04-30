/**
 * NormalizeWizardModal — two-step wizard to move a non-canonical file safely.
 *
 * Step 1: pick where the file should live (separate rule or merged into CLAUDE.md).
 * Step 2: review the diff + Tier 1 checks, then Apply or Cancel.
 *
 * Write pipeline: /api/migrate-preview → /api/write per token → /api/migrate-finalize.
 * On failure: rollback called, plain-language toast shown.
 *
 * Also used as the confirm step for DnD drops (prefilledMode skips step 1).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  postMigratePreview,
  postMigrateFinalize,
  postWrite,
  type MigratePlan,
  type MigratePreviewResponse,
} from "../api/client";
import { useStore } from "../state/store";
import type { NonCanonicalEntry } from "../types";

function collapseHome(p: string): string {
  return p.replace(/^\/home\/[^/]+\//, "~/").replace(/^\/home\/[^/]+$/, "~");
}

function basename(p: string): string {
  return p.split("/").pop() ?? p;
}

export type NormalizeMode = "rule" | "merge";

export interface NormalizeWizardProps {
  entry: NonCanonicalEntry;
  /** When set, skips step 1 and uses this mode. */
  prefilledMode?: NormalizeMode | null;
  onClose: () => void;
}

// Diff row shapes — same visual language as DiffModal.
type DiffRow =
  | { kind: "hunk"; text: string }
  | { kind: "add" | "del" | "ctx"; text: string };

function parseDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("--- ") || raw.startsWith("+++ ")) continue;
    if (raw.startsWith("@@")) { rows.push({ kind: "hunk", text: raw }); continue; }
    if (raw.startsWith("+")) { rows.push({ kind: "add", text: raw.slice(1) }); continue; }
    if (raw.startsWith("-")) { rows.push({ kind: "del", text: raw.slice(1) }); continue; }
    if (raw.length > 0) rows.push({ kind: "ctx", text: raw });
  }
  return rows;
}

function actionLabel(action: string): string {
  if (action === "create") return "New file";
  if (action === "modify") return "Changed";
  if (action === "delete") return "Deleted";
  return action;
}

function ciColor(ci: string): string {
  return ci === "fail" ? "var(--rust, #e05c5c)" : "var(--lime, #78c476)";
}

function ciText(ci: string): string {
  if (ci === "exact") return "Content match: exact copy";
  if (ci === "substring") return "Content match: all sections present in target";
  return "Content match: could not verify — review the diff carefully";
}

export function NormalizeWizardModal({ entry, prefilledMode, onClose }: NormalizeWizardProps) {
  const pushToast = useStore((s) => s.pushToast);

  const [step, setStep] = useState<1 | 2>(prefilledMode ? 2 : 1);
  const [mode, setMode] = useState<NormalizeMode>(prefilledMode ?? "rule");
  const [newFilename, setNewFilename] = useState(() => basename(entry.file_path));
  const [deleteOriginal, setDeleteOriginal] = useState(prefilledMode !== "merge");

  const [loading, setLoading] = useState(false);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<MigratePreviewResponse | null>(null);
  const [applying, setApplying] = useState(false);

  const veilRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const fetchPreview = useCallback(async () => {
    setLoading(true);
    setPreviewErr(null);
    setPreview(null);
    try {
      const res = await postMigratePreview({
        source_path: entry.file_path,
        mode,
        new_filename: mode === "rule" ? newFilename : undefined,
        delete_original: deleteOriginal,
      });
      setPreview(res);
    } catch (e) {
      setPreviewErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.file_path, mode, newFilename, deleteOriginal]);

  useEffect(() => {
    if (step === 2) void fetchPreview();
  }, [step, fetchPreview]);

  const handleApply = useCallback(async () => {
    if (!preview) return;
    setApplying(true);
    try {
      for (const token of preview.tokens) {
        await postWrite(token);
      }
      await postMigrateFinalize(preview.migration_id, "commit");
      pushToast({ kind: "success", message: "File moved successfully." });
      onClose();
    } catch (e) {
      try { await postMigrateFinalize(preview.migration_id, "rollback"); } catch { /* best-effort */ }
      const msg = e instanceof Error ? e.message : String(e);
      pushToast({
        kind: "error",
        message: `Couldn't finish moving the file — it has been restored to its original state. (${msg})`,
      });
    } finally {
      setApplying(false);
    }
  }, [preview, pushToast, onClose]);

  const handleVeilClick = (e: React.MouseEvent) => {
    if (e.target === veilRef.current) onClose();
  };

  const srcBase = basename(entry.file_path);
  const ruleTarget = `~/.claude/rules/${newFilename || srcBase}`;
  const mergeTarget = `~/.claude/CLAUDE.md`;

  return (
    <div
      ref={veilRef}
      className="modal-veil normalize-veil show"
      onClick={handleVeilClick}
      role="presentation"
    >
      <div className="modal normalize-modal" role="dialog" aria-modal="true" aria-label="Move file">
        <header className="modal-head">
          <h3>
            {step === 1 ? "Move file" : "Review changes"}
          </h3>
          <span
            className="x"
            role="button"
            tabIndex={0}
            onClick={onClose}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClose(); } }}
            aria-label="Cancel"
          >
            close ✕
          </span>
        </header>

        {/* Source path */}
        <div className="normalize-source-row">
          <span className="normalize-source-label">File:</span>
          <code className="normalize-source-path">{collapseHome(entry.file_path)}</code>
        </div>

        {step === 1 ? (
          <Step1
            mode={mode}
            setMode={setMode}
            newFilename={newFilename}
            setNewFilename={setNewFilename}
            ruleTarget={ruleTarget}
            mergeTarget={mergeTarget}
            onNext={() => setStep(2)}
            onCancel={onClose}
          />
        ) : (
          <Step2
            loading={loading}
            previewErr={previewErr}
            preview={preview}
            deleteOriginal={deleteOriginal}
            setDeleteOriginal={setDeleteOriginal}
            applying={applying}
            onBack={prefilledMode ? undefined : () => setStep(1)}
            onApply={handleApply}
            onCancel={onClose}
            mode={mode}
          />
        )}
      </div>
    </div>
  );
}

// --- Step 1: option picker --------------------------------------------------

interface Step1Props {
  mode: NormalizeMode;
  setMode: (m: NormalizeMode) => void;
  newFilename: string;
  setNewFilename: (v: string) => void;
  ruleTarget: string;
  mergeTarget: string;
  onNext: () => void;
  onCancel: () => void;
}

function Step1({ mode, setMode, newFilename, setNewFilename, ruleTarget, mergeTarget, onNext, onCancel }: Step1Props) {
  return (
    <>
      <div className="modal-body normalize-step1-body">
        <label
          className={`normalize-option-card${mode === "rule" ? " selected" : ""}`}
          onClick={() => setMode("rule")}
        >
          <div className="normalize-option-card-head">
            <input type="radio" name="nw-mode" value="rule" checked={mode === "rule"} onChange={() => setMode("rule")} />
            <span className="normalize-option-title">Make a separate rule</span>
          </div>
          <p className="normalize-option-desc">
            Move this file to <code>~/.claude/rules/</code> as a standalone rule. Any @-import that loaded it is removed automatically.
          </p>
          {mode === "rule" && (
            <div className="normalize-option-extra">
              <label className="normalize-filename-label" htmlFor="nw-filename">Filename</label>
              <input
                id="nw-filename"
                type="text"
                className="normalize-filename-input"
                value={newFilename}
                onChange={(e) => setNewFilename(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                placeholder="my-rule.md"
                autoFocus
              />
              <span className="normalize-option-preview">{ruleTarget}</span>
            </div>
          )}
        </label>

        <label
          className={`normalize-option-card${mode === "merge" ? " selected" : ""}`}
          onClick={() => setMode("merge")}
        >
          <div className="normalize-option-card-head">
            <input type="radio" name="nw-mode" value="merge" checked={mode === "merge"} onChange={() => setMode("merge")} />
            <span className="normalize-option-title">Merge into ~/.claude/CLAUDE.md</span>
          </div>
          <p className="normalize-option-desc">
            Append this file's content into your main CLAUDE.md. Headings that already exist there will receive the new content under them — no duplicates.
          </p>
          {mode === "merge" && (
            <div className="normalize-option-extra">
              <span className="normalize-option-preview">{mergeTarget}</span>
            </div>
          )}
        </label>
      </div>

      <footer className="modal-foot">
        <span className="note">Choose where this file belongs</span>
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn primary" onClick={onNext}>Continue</button>
        </div>
      </footer>
    </>
  );
}

// --- Step 2: diff review + confirm -----------------------------------------

interface Step2Props {
  mode: NormalizeMode;
  loading: boolean;
  previewErr: string | null;
  preview: MigratePreviewResponse | null;
  deleteOriginal: boolean;
  setDeleteOriginal: (v: boolean) => void;
  applying: boolean;
  onBack: (() => void) | undefined;
  onApply: () => void;
  onCancel: () => void;
}

function Step2({ mode, loading, previewErr, preview, deleteOriginal, setDeleteOriginal, applying, onBack, onApply, onCancel }: Step2Props) {
  return (
    <>
      <div className="modal-body normalize-step2-body">
        {loading && <div className="normalize-loading">Preparing preview…</div>}
        {!loading && previewErr && <div className="normalize-error">Could not prepare preview: {previewErr}</div>}
        {!loading && preview && (
          <>
            <div className="normalize-diffs">
              {preview.plan.files_changed.map((fc, i) => (
                <DiffBlock key={i} path={fc.path} action={fc.action} diff={fc.diff} />
              ))}
            </div>
            <Tier1Cards plan={preview.plan} />
            <label className="normalize-delete-row">
              <input
                type="checkbox"
                checked={deleteOriginal}
                onChange={(e) => setDeleteOriginal(e.target.checked)}
              />
              <span>Also delete the original file after moving</span>
            </label>
            <label
              className="normalize-tier2-row"
              title="Not available on this Claude version — Tier 2 deferred"
            >
              <span className="normalize-tier2-label">
                <input type="checkbox" disabled checked={false} readOnly />
                Deep verify after moving (not available on this Claude version)
              </span>
              <span className="normalize-tier2-note">Tier 1 checks are running — the move is still safe.</span>
            </label>
          </>
        )}
      </div>

      <footer className="modal-foot">
        <span className="note">
          {applying ? "Applying…" : "Snapshot saved before every write"}
        </span>
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onCancel} disabled={applying}>Cancel</button>
          {onBack && (
            <button type="button" className="btn ghost" onClick={onBack} disabled={applying}>Back</button>
          )}
          <button
            type="button"
            className="btn primary"
            disabled={!preview || loading || applying}
            onClick={onApply}
          >
            {applying ? "Applying…" : mode === "rule" ? "Apply — create rule" : "Apply — merge"}
          </button>
        </div>
      </footer>
    </>
  );
}

// --- DiffBlock --------------------------------------------------------------

function DiffBlock({ path, action, diff }: { path: string; action: string; diff: string }) {
  const rows = parseDiff(diff);
  return (
    <div className="diff">
      <div className="diff-head">
        <span>{collapseHome(path)}</span>
        <span className="normalize-diff-action">{actionLabel(action)}</span>
      </div>
      {diff ? (
        <div>
          {rows.map((row, i) => {
            let cls = "diff-line";
            if (row.kind === "add") cls += " add";
            else if (row.kind === "del") cls += " del";
            else if (row.kind === "hunk") cls += " hunk";
            const sg = row.kind === "add" ? "+" : row.kind === "del" ? "−" : "";
            return (
              <div key={i} className={cls}>
                <span className="ln" />
                <span className="sg">{sg}</span>
                <span className="text">{row.text}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="normalize-diff-no-content">
          {action === "delete" ? "This file will be deleted." : "No content changes."}
        </div>
      )}
    </div>
  );
}

// --- Tier 1 verification panel ---------------------------------------------

function Tier1Cards({ plan }: { plan: MigratePlan }) {
  const sd = plan.sim_diff;
  return (
    <div className="normalize-tier1">
      <div className="normalize-tier1-head">Checks before applying</div>

      {sd && (
        <div className="normalize-tier1-row">
          <span className="normalize-tier1-icon normalize-icon-ok">✓</span>
          <span>
            Files added: {sd.added.length} · removed: {sd.removed.length} · changed: {sd.hash_changed.length}
          </span>
        </div>
      )}

      <div className="normalize-tier1-row">
        <span className="normalize-tier1-icon" style={{ color: ciColor(plan.content_identity) }}>
          {plan.content_identity === "fail" ? "!" : "✓"}
        </span>
        <span style={{ color: ciColor(plan.content_identity) }}>{ciText(plan.content_identity)}</span>
      </div>

      <div className="normalize-tier1-row">
        <span
          className="normalize-tier1-icon"
          style={{ color: plan.orphan_importers.length > 0 ? "var(--amber)" : "var(--lime, #78c476)" }}
        >
          {plan.orphan_importers.length > 0 ? "!" : "✓"}
        </span>
        <span>
          {plan.orphan_importers.length === 0
            ? "No other files import this one"
            : `${plan.orphan_importers.length} other file${plan.orphan_importers.length !== 1 ? "s" : ""} still import this — review after moving`}
        </span>
      </div>
      {plan.orphan_importers.length > 0 && (
        <ul className="normalize-orphan-list">
          {plan.orphan_importers.map((imp, i) => (
            <li key={i}><code>{collapseHome(imp.file_path)}</code> line {imp.line_number}</li>
          ))}
        </ul>
      )}

      {plan.heading_collisions.length > 0 && (
        <>
          <div className="normalize-tier1-row">
            <span className="normalize-tier1-icon" style={{ color: "var(--amber)" }}>!</span>
            <span>
              {plan.heading_collisions.length} heading{plan.heading_collisions.length !== 1 ? "s" : ""} already exist in the target — content merged under them
            </span>
          </div>
          <ul className="normalize-orphan-list">
            {plan.heading_collisions.map((h, i) => (
              <li key={i}><code>{h}</code></li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
