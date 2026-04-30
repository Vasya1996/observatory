/**
 * RuleWizardModal — wizard for creating a new behavioural rule from a
 * selected CLAUDE.md (or sibling rule). Triggered from the Inspector.
 *
 * Layout: full-screen veil + 880px centred dialog (slightly wider than
 * DiffModal — needs split view). Left column = form, right column = live
 * preview of the file content as it will be written. Save → builds the
 * `{path, newContent}` patch and pumps it through `useWritePipeline` so the
 * full DiffModal confirms the creation (locked rule #36).
 *
 * Vasya's locked answers (jolly-sparking-spring.md, Phase 2 #7):
 *   - Three location modes (radio): "everywhere" / "only in this project" /
 *     "by file pattern" — last sub-radios into user-global vs per-repo with
 *     a `paths:` chip-input.
 *   - Cwd is derived from the originating CLAUDE.md by walking ancestors and
 *     matching against `/api/cwds`. If no enclosing cwd exists (e.g. user
 *     selected `~/.claude/CLAUDE.md`), the "only in this project" radio is
 *     disabled with a hint.
 *   - Filename validation: alphanum + underscores/hyphens, no slashes, must
 *     not collide with an existing rule path.
 *   - Body field has a "Use minimal seed" button that drops in the
 *     memory-architecture seed — `# <Title>\n\nWhy:\n\nHow to apply:\n`.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../state/store";
import { useWritePipeline } from "../hooks/useWritePipeline";
import type { CwdEntry, FileEntry } from "../types";

interface Props {
  // The CLAUDE.md (or rule) the user clicked "+ New rule" on. Used for cwd
  // derivation when the user picks "only in this project".
  originFile: FileEntry;
  cwds: CwdEntry[];
  onClose: () => void;
}

type Location =
  | { mode: "everywhere" }
  | { mode: "project"; cwd: string }
  | { mode: "pattern"; scope: "user" | "project"; cwd: string | null; globs: string[] };

// Compute the closest enclosing cwd for a given file path. Walks up the
// path components and returns the deepest cwd whose `path` is an ancestor of
// `filePath`. Returns null if none match (common case: `~/.claude/CLAUDE.md`).
export function deriveEnclosingCwd(
  filePath: string,
  cwds: CwdEntry[],
): string | null {
  let best: CwdEntry | null = null;
  for (const c of cwds) {
    // Match by prefix; enforce trailing-slash boundary so `/foo` doesn't
    // accidentally claim `/foobar/...`.
    const root = c.path.endsWith("/") ? c.path : `${c.path}/`;
    if (filePath === c.path || filePath.startsWith(root)) {
      if (!best || c.path.length > best.path.length) {
        best = c;
      }
    }
  }
  return best?.path ?? null;
}

// Validate a filename: alphanumeric + underscores + hyphens; no slashes,
// no leading dot, length 1+. Caller appends `.md` automatically.
function validFilename(name: string): boolean {
  if (!name) return false;
  if (name.startsWith(".")) return false;
  return /^[A-Za-z0-9_-]+$/.test(name);
}

// Compose the destination path for a given Location + filename.
function composePath(loc: Location, filename: string, home: string): string {
  const fname = filename.endsWith(".md") ? filename : `${filename}.md`;
  if (loc.mode === "everywhere") {
    return `${home}/.claude/rules/${fname}`;
  }
  if (loc.mode === "project") {
    return `${loc.cwd}/.claude/rules/${fname}`;
  }
  // pattern
  if (loc.scope === "user") {
    return `${home}/.claude/rules/${fname}`;
  }
  return `${loc.cwd}/.claude/rules/${fname}`;
}

// ~-collapse the path so the preview "Saved at:" reads nicely.
function collapseHome(p: string, home?: string): string {
  if (home && p.startsWith(home + "/")) return "~/" + p.slice(home.length + 1);
  const m = /^\/home\/[^/]+\/(.+)$/.exec(p);
  if (m) return "~/" + m[1];
  return p;
}

// Build the full file content for the preview pane and the write call.
// Includes frontmatter (`---\nname: ...\ndescription: ...\npaths:\n  - ...\n---\n`)
// when the location requires it — name/description are populated only when
// the body has them; for now we keep the frontmatter minimal: paths only.
// (Memory-architecture conventions don't require name/description on rule
// files — only memory files have that constraint. The folder rule files
// already on disk follow this exact format.)
function buildContent(loc: Location, body: string): string {
  let frontmatter = "";
  if (loc.mode === "pattern" && loc.globs.length > 0) {
    const lines = ["---", "paths:"];
    for (const g of loc.globs) {
      lines.push(`  - "${g}"`);
    }
    lines.push("---", "");
    frontmatter = lines.join("\n");
  }
  if (frontmatter) {
    return frontmatter + "\n" + body;
  }
  return body;
}

// Minimal seed body, anchored to memory-architecture conventions. The title
// is interpolated at click time so the user sees it appear in the live
// preview.
function minimalSeed(title: string): string {
  const t = title.trim() || "New rule";
  return `# ${t}\n\nWhy:\n\nHow to apply:\n`;
}

export function RuleWizardModal({ originFile, cwds, onClose }: Props) {
  const files = useStore((s) => s.files);
  const { requestWrite } = useWritePipeline();
  const pushToast = useStore((s) => s.pushToast);

  // Derive home from file index rather than hard-coding.
  const home = useMemo(() => {
    for (const f of files) {
      if (f.display.startsWith("~/") && f.path.length > 2) {
        const suffix = f.display.slice(1);
        if (f.path.endsWith(suffix)) return f.path.slice(0, f.path.length - suffix.length);
      }
    }
    for (const f of files) {
      const m = /^(\/home\/[^/]+)\/.+/.exec(f.path);
      if (m) return m[1];
    }
    return "/home";
  }, [files]);

  const enclosingCwd = useMemo(
    () => deriveEnclosingCwd(originFile.path, cwds),
    [originFile.path, cwds],
  );

  // Form state. Default "everywhere" because it's always available; pattern
  // requires globs, project requires an enclosing cwd.
  const [mode, setMode] = useState<Location["mode"]>("everywhere");
  const [patternScope, setPatternScope] = useState<"user" | "project">(
    enclosingCwd ? "project" : "user",
  );
  const [globs, setGlobs] = useState<string[]>([]);
  const [globDraft, setGlobDraft] = useState("");
  const [filename, setFilename] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  // If the project mode loses its cwd (e.g. selection changes), revert.
  useEffect(() => {
    if (mode === "project" && !enclosingCwd) {
      setMode("everywhere");
    }
  }, [mode, enclosingCwd]);

  // Build the live `Location` from the current form. Memoised so the preview
  // and the validation react in lockstep without re-deriving manually.
  const location: Location = useMemo(() => {
    if (mode === "everywhere") return { mode: "everywhere" };
    if (mode === "project") {
      // enclosingCwd is guaranteed by the disabled-state guard, but TS doesn't
      // know that — fall back to "everywhere" path computation if absent.
      return enclosingCwd
        ? { mode: "project", cwd: enclosingCwd }
        : { mode: "everywhere" };
    }
    return {
      mode: "pattern",
      scope: patternScope,
      cwd: patternScope === "project" ? enclosingCwd : null,
      globs,
    };
  }, [mode, patternScope, globs, enclosingCwd]);

  // Compose live values: full destination path, full content, validation.
  const fullPath = useMemo(
    () => composePath(location, filename || "untitled", home),
    [location, filename, home],
  );
  const collapsedPath = useMemo(() => collapseHome(fullPath, home), [fullPath, home]);
  const content = useMemo(() => buildContent(location, body), [location, body]);

  const errors = useMemo<string[]>(() => {
    const errs: string[] = [];
    if (!filename) {
      errs.push("Filename required.");
    } else if (!validFilename(filename)) {
      errs.push(
        "Filename must be alphanumeric + underscores or hyphens (no slashes).",
      );
    }
    if (location.mode === "pattern" && location.globs.length === 0) {
      errs.push("At least one path glob required for file-pattern rules.");
    }
    if (
      location.mode === "pattern" &&
      location.scope === "project" &&
      !location.cwd
    ) {
      errs.push("Per-repo file-pattern rule needs an enclosing cwd.");
    }
    // Collision check — same target path already exists in the index.
    if (filename && validFilename(filename)) {
      const existing = files.find((f) => f.path === fullPath);
      if (existing) {
        errs.push(`A file already exists at ${collapsedPath}.`);
      }
    }
    return errs;
  }, [filename, location, files, fullPath, collapsedPath]);

  const canSave = errors.length === 0 && !busy;

  // Esc closes; Cmd/Ctrl+Enter submits.
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (busy) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (canSave) void onCreate();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, canSave]);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const onAddGlob = () => {
    const g = globDraft.trim();
    if (!g) return;
    if (globs.includes(g)) return;
    setGlobs([...globs, g]);
    setGlobDraft("");
  };
  const onRemoveGlob = (g: string) => {
    setGlobs(globs.filter((x) => x !== g));
  };

  const onSeed = () => {
    setBody(minimalSeed(title));
  };

  const onCreate = async () => {
    if (!canSave) return;
    setBusy(true);
    try {
      const result = await requestWrite([
        { path: fullPath, newContent: content, title: "create new rule" },
      ]);
      if (result.ok) {
        onClose();
      }
    } catch (e) {
      pushToast({
        kind: "error",
        message: `Create failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setBusy(false);
    }
  };

  const onVeilClick: React.MouseEventHandler<HTMLDivElement> = (e) => {
    if (e.target === e.currentTarget && !busy) onClose();
  };

  return (
    <div className="modal-veil show wizard-veil" role="presentation" onClick={onVeilClick}>
      <div
        className="modal wizard-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Create new rule"
        ref={dialogRef}
        tabIndex={-1}
      >
        <header className="modal-head">
          <h3>
            Create new <em>rule</em>
          </h3>
          <span
            className="x"
            role="button"
            tabIndex={0}
            onClick={() => !busy && onClose()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                if (!busy) onClose();
              }
            }}
            aria-label="Close wizard"
          >
            close ✕
          </span>
        </header>

        <div className="wizard-body">
          {/* LEFT — form */}
          <section className="wizard-form">
            <div className="wizard-section">
              <h5 className="wizard-section-h">Rule applies</h5>
              <label className="wizard-radio">
                <input
                  type="radio"
                  name="loc"
                  checked={mode === "everywhere"}
                  onChange={() => setMode("everywhere")}
                />
                <span>
                  <strong>Everywhere</strong>
                  <span className="wizard-radio-hint">
                    Always-loaded · saved under <code>~/.claude/rules/</code>
                  </span>
                </span>
              </label>

              <label
                className={`wizard-radio${enclosingCwd ? "" : " disabled"}`}
              >
                <input
                  type="radio"
                  name="loc"
                  checked={mode === "project"}
                  disabled={!enclosingCwd}
                  onChange={() => setMode("project")}
                />
                <span>
                  <strong>Only in this project</strong>
                  <span className="wizard-radio-hint">
                    {enclosingCwd
                      ? `Saved under ${collapseHome(enclosingCwd, home)}/.claude/rules/`
                      : "Disabled — no enclosing cwd for this CLAUDE.md."}
                  </span>
                </span>
              </label>

              <label className="wizard-radio">
                <input
                  type="radio"
                  name="loc"
                  checked={mode === "pattern"}
                  onChange={() => setMode("pattern")}
                />
                <span>
                  <strong>By file pattern</strong>
                  <span className="wizard-radio-hint">
                    Loads only when Claude opens a matching file.
                  </span>
                </span>
              </label>

              {mode === "pattern" && (
                <div className="wizard-pattern-sub">
                  <div className="wizard-subradio-row">
                    <label className="wizard-subradio">
                      <input
                        type="radio"
                        name="patternScope"
                        checked={patternScope === "user"}
                        onChange={() => setPatternScope("user")}
                      />
                      <span>user-global ({collapseHome(`${home}/.claude/rules/`, home)})</span>
                    </label>
                    <label
                      className={`wizard-subradio${enclosingCwd ? "" : " disabled"}`}
                    >
                      <input
                        type="radio"
                        name="patternScope"
                        checked={patternScope === "project"}
                        disabled={!enclosingCwd}
                        onChange={() => setPatternScope("project")}
                      />
                      <span>
                        per-repo
                        {enclosingCwd && ` (${collapseHome(enclosingCwd, home)}/.claude/rules/)`}
                      </span>
                    </label>
                  </div>

                  <div className="wizard-globs">
                    <div className="wizard-globs-label">paths globs</div>
                    <div className="wizard-glob-input-row">
                      <input
                        type="text"
                        className="wizard-input"
                        placeholder='e.g. "src/**/*.ts" or "/abs/path/**"'
                        value={globDraft}
                        onChange={(e) => setGlobDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            onAddGlob();
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="wizard-glob-add"
                        onClick={onAddGlob}
                        disabled={!globDraft.trim()}
                      >
                        Add
                      </button>
                    </div>
                    <div className="wizard-glob-chips">
                      {globs.length === 0 ? (
                        <span className="wizard-faint">No globs yet.</span>
                      ) : (
                        globs.map((g) => (
                          <span key={g} className="wizard-glob-chip">
                            {g}
                            <button
                              type="button"
                              className="wizard-glob-chip-x"
                              onClick={() => onRemoveGlob(g)}
                              aria-label={`Remove ${g}`}
                            >
                              ×
                            </button>
                          </span>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="wizard-section">
              <h5 className="wizard-section-h">Filename</h5>
              <input
                type="text"
                className="wizard-input"
                placeholder="e.g. observatory or tma_extra"
                value={filename}
                onChange={(e) => setFilename(e.target.value)}
              />
              <div className="wizard-faint wizard-fullpath">
                {collapsedPath}
              </div>
            </div>

            <div className="wizard-section">
              <h5 className="wizard-section-h">Title</h5>
              <input
                type="text"
                className="wizard-input"
                placeholder="Used by the seed button"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>

            <div className="wizard-section">
              <div className="wizard-section-head-row">
                <h5 className="wizard-section-h">Body</h5>
                <button
                  type="button"
                  className="wizard-seed-btn"
                  onClick={onSeed}
                  title="Insert minimal seed (Why / How to apply)"
                >
                  Use minimal seed
                </button>
              </div>
              <textarea
                className="wizard-textarea"
                placeholder="Markdown body of the rule…"
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </div>

            {errors.length > 0 && (
              <div className="wizard-errors">
                {errors.map((e, i) => (
                  <div className="wizard-error" key={i}>
                    {e}
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* RIGHT — preview */}
          <section className="wizard-preview">
            <div className="wizard-preview-head">
              <span>{collapsedPath}</span>
              <span className="wizard-faint">preview</span>
            </div>
            <pre className="wizard-preview-pre">{content || "(empty)"}</pre>
          </section>
        </div>

        <footer className="modal-foot">
          <span className="note">
            {busy ? "Creating…" : "DiffModal will confirm the file creation."}
          </span>
          <div className="actions">
            <button
              type="button"
              className="btn ghost"
              onClick={() => !busy && onClose()}
              disabled={busy}
            >
              Cancel <span className="kbd-hint">Esc</span>
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={onCreate}
              disabled={!canSave}
            >
              Create <span className="kbd-hint">⌘↵</span>
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
