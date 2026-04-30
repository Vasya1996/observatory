/**
 * EditorPanel — left slide-in panel, 480px wide. Opens when the user
 * double-clicks a graph node (MapView) or a slot card (SimulatorView).
 *
 * Body: CodeMirror 6 editor — markdown for .md files, JSON for .json,
 * plain text otherwise. File content fetched via GET /api/file?path=.
 *
 * Read-only files (writable === false): editor in read-only mode, no Save
 * button. Footer reads "Read-only — managed by Claude Code".
 *
 * Edits trigger a "Save" button. Saving goes through useWritePipeline
 * (full DiffModal — multi-line write). After a successful write the panel
 * stays open with the new content as the new baseline.
 *
 * Selection sync: opening the editor selects the corresponding file in
 * the store so the graph / slot highlights it (locked rule #24).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { json } from "@codemirror/lang-json";
import { useStore } from "../state/store";
import { fetchFile } from "../api/client";
import { useWritePipeline } from "../hooks/useWritePipeline";
import type { FileEntry } from "../types";

interface Props {
  files: FileEntry[];
}

const KIND_LABEL: Record<string, string> = {
  claude_md: "claude.md",
  rule: "rule",
  memory: "memory",
  memory_index: "memory index",
  skill: "skill",
  plugin_manifest: "plugin",
  plugin_registry: "plugin registry",
  mcp: "mcp",
  settings: "settings",
  automemory: "auto-memory",
  script: "script",
};

function collapseHome(p: string): string {
  // Server returns absolute paths; collapse /home/<user>/ → ~/
  return p.replace(/^\/home\/[^/]+\//, "~/");
}

function detectLang(path: string): "markdown" | "json" | "text" {
  const lower = path.toLowerCase();
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".json")) return "json";
  return "text";
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function formatMtime(ts: number): string {
  const d = new Date(ts * 1000);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} · ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Observatory dark theme for CodeMirror, anchored to the design tokens.
const obsTheme = EditorView.theme({
  "&": {
    color: "#e8e4d8",
    backgroundColor: "#111114",
    height: "100%",
    fontSize: "12px",
    fontFamily: '"JetBrains Mono", monospace',
  },
  ".cm-content": {
    caretColor: "#f0a83a",
    padding: "8px 0",
  },
  ".cm-cursor": { borderLeftColor: "#f0a83a" },
  ".cm-activeLine": { backgroundColor: "rgba(240,168,58,0.05)" },
  ".cm-activeLineGutter": { backgroundColor: "rgba(240,168,58,0.05)", color: "#6e6a5e" },
  ".cm-gutters": {
    backgroundColor: "#111114",
    borderRight: "1px solid #23232a",
    color: "#6e6a5e",
  },
  ".cm-lineNumbers .cm-gutterElement": { minWidth: "36px", paddingRight: "8px" },
  ".cm-selectionBackground": { backgroundColor: "rgba(240,168,58,0.18)" },
  "&.cm-focused .cm-selectionBackground": { backgroundColor: "rgba(240,168,58,0.22)" },
  ".cm-matchingBracket": { backgroundColor: "rgba(240,168,58,0.15)" },
  // Markdown syntax colors.
  ".tok-heading": { color: "#f0a83a", fontWeight: "700" },
  ".tok-emphasis": { fontStyle: "italic", color: "#b9b4a6" },
  ".tok-strong": { fontWeight: "700", color: "#e8e4d8" },
  ".tok-link": { color: "#5ec4b6" },
  ".tok-url": { color: "#5ec4b6" },
  ".tok-string": { color: "#a8d8b0" },
  ".tok-comment": { color: "#6e6a5e", fontStyle: "italic" },
  ".tok-keyword": { color: "#f0a83a" },
  ".tok-property": { color: "#b9b4a6" },
  ".tok-number": { color: "#a8d8b0" },
  ".tok-bool": { color: "#a8d8b0" },
  ".tok-null": { color: "#6e6a5e" },
}, { dark: true });

export function EditorPanel({ files }: Props) {
  const editorPath = useStore((s) => s.editorPath);
  const editorOpen = useStore((s) => s.editorOpen);
  const setEditorOpen = useStore((s) => s.setEditorOpen);
  const select = useStore((s) => s.select);

  const [content, setContent] = useState<string>("");
  const [baseline, setBaseline] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // File metadata for the footer.
  const [fileMeta, setFileMeta] = useState<{ size: number; lines: number; mtime: number } | null>(null);

  // The FileEntry from the index (for writable check + kind label).
  const fileEntry = editorPath ? files.find((f) => f.path === editorPath) ?? null : null;
  const isReadOnly = fileEntry ? fileEntry.writable === false : false;

  const cmRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langCompartment = useRef(new Compartment());
  const editableCompartment = useRef(new Compartment());

  // Track dirty state (editor content !== baseline).
  const [dirty, setDirty] = useState(false);

  const writePipeline = useWritePipeline();

  // Selection sync (locked rule #24): opening the editor selects the file
  // in the graph so the node lights up.
  useEffect(() => {
    if (editorOpen && editorPath) {
      const f = files.find((x) => x.path === editorPath);
      if (f) select(f.id);
    }
  }, [editorOpen, editorPath, files, select]);

  // Fetch file content when path changes.
  useEffect(() => {
    if (!editorPath || !editorOpen) return;
    let cancelled = false;
    setLoading(true);
    setFetchError(null);
    setDirty(false);
    fetchFile(editorPath)
      .then((res) => {
        if (cancelled) return;
        setContent(res.content);
        setBaseline(res.content);
        setFileMeta(null); // will be populated from FileEntry in index
      })
      .catch((e) => {
        if (cancelled) return;
        setFetchError((e as Error).message ?? "Could not load file.");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [editorPath, editorOpen]);

  // Pick up size/lines/mtime from the files index once content is loaded.
  useEffect(() => {
    if (!fileEntry) return;
    setFileMeta({ size: fileEntry.size_bytes, lines: fileEntry.line_count, mtime: fileEntry.mtime });
  }, [fileEntry]);

  // Build or rebuild the CodeMirror view when content loads or the panel opens.
  useEffect(() => {
    if (!cmRef.current) return;
    // Destroy existing view if any.
    if (viewRef.current) {
      viewRef.current.destroy();
      viewRef.current = null;
    }
    if (!editorOpen || loading || fetchError) return;

    const lang = detectLang(editorPath ?? "");
    const langExt = lang === "markdown" ? markdown() : lang === "json" ? json() : [];

    const startState = EditorState.create({
      doc: content,
      extensions: [
        obsTheme,
        lineNumbers(),
        highlightActiveLineGutter(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        langCompartment.current.of(langExt),
        editableCompartment.current.of(EditorView.editable.of(!isReadOnly)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const newContent = update.state.doc.toString();
            setDirty(newContent !== baseline);
          }
        }),
      ],
    });

    const view = new EditorView({ state: startState, parent: cmRef.current });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  // Rebuild when content or open state changes; baseline is stable after load.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorOpen, content, loading, fetchError, isReadOnly]);

  const handleSave = useCallback(async () => {
    if (!editorPath || !viewRef.current) return;
    const newContent = viewRef.current.state.doc.toString();
    if (newContent === baseline) return;

    writePipeline.requestWrite(
      [{ path: editorPath, newContent, title: `Edit ${editorPath.split("/").pop()}` }],
      // No softConfirm — full DiffModal for multi-line writes per locked rule #36.
    ).then((wrote) => {
      if (wrote) {
        setBaseline(newContent);
        setDirty(false);
      }
    }).catch(() => {
      // errors surfaced by useWritePipeline via toasts
    });
  }, [editorPath, baseline, writePipeline]);

  const handleClose = () => setEditorOpen(null, false);

  const basename = editorPath ? editorPath.split("/").pop() ?? editorPath : "";
  const displayPath = editorPath ? collapseHome(editorPath) : "";

  const kindLabel = fileEntry ? (KIND_LABEL[fileEntry.kind] ?? fileEntry.kind) : null;

  return (
    <aside className={`editor-pane${editorOpen ? " open" : ""}`} aria-label="File editor">
      {/* Header */}
      <div className="editor-pane-head">
        <div className="editor-pane-title">
          <span className="editor-pane-filename">{basename || "—"}</span>
          <span className="editor-pane-path">{displayPath}</span>
        </div>
        <button
          type="button"
          className="editor-pane-close"
          onClick={handleClose}
          aria-label="Close editor"
        >
          ×
        </button>
      </div>

      {/* Body */}
      <div className="editor-pane-body">
        {loading && (
          <div className="editor-pane-state">Loading…</div>
        )}
        {fetchError && (
          <div className="editor-pane-state editor-pane-error">
            Could not load file — {fetchError}
          </div>
        )}
        {!loading && !fetchError && (
          <div ref={cmRef} className="editor-cm-wrap" />
        )}
      </div>

      {/* Footer */}
      {!loading && !fetchError && (
        <div className="editor-pane-footer">
          <div className="editor-pane-meta">
            {fileMeta && (
              <>
                <span>{formatBytes(fileMeta.size)}</span>
                <span>{fileMeta.lines} ln</span>
                <span>{formatMtime(fileMeta.mtime)}</span>
              </>
            )}
          </div>
          {isReadOnly ? (
            <div className="editor-pane-readonly">
              Read-only{kindLabel ? ` — ${kindLabel}` : ""}
            </div>
          ) : (
            <button
              type="button"
              className="editor-pane-save"
              disabled={!dirty}
              onClick={handleSave}
            >
              Save
            </button>
          )}
        </div>
      )}
    </aside>
  );
}
