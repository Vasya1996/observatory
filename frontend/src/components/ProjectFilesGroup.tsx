/**
 * ProjectFilesGroup — the unified filesystem tree for the active cwd.
 *
 * Replaces the old dual-section layout (priority tiers + "All files"). Now
 * the single tree shows the real FS structure from /api/cwd-tree, enriched
 * with priority badges and autoload toggles for files that appear in the
 * FileEntry index.
 *
 * Files matched by absolute path against the FileEntry index get:
 *   - priority badge (1–6) from priorityMap
 *   - autoload toggle (AutoloadToggle from ExplorerPane)
 *   - context-menu on right-click
 *   - single click → select(file.id), double-click → open EditorPanel
 *   - draggable for DnD move (MoveConfirmModal)
 *
 * Files not in the index: icon + name only.
 * Folders: no badge, no toggle.
 *
 * Search/filter: passed in as `query` prop; matching folders auto-expand.
 * Folder expand state is persisted via useStore.treeExpanded under a
 * "cwd-tree:" prefix to avoid collisions with priority-tier folder ids.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchCwdTree } from "../api/client";
import { useStore } from "../state/store";
import type { CwdTreeChild, CwdTreeResponse, FileEntry, LoadStatus } from "../types";
import { MoveConfirmModal } from "./MoveConfirmModal";

// ---------------------------------------------------------------------------
// Priority badge helpers (mirrors ExplorerPane.tsx)
// ---------------------------------------------------------------------------

const PRIORITY_LABELS: Record<number, string> = {
  1: "1st",
  2: "2nd",
  3: "3rd",
  4: "4th",
  5: "5th",
  6: "6th",
};

const PRIORITY_TOOLTIPS: Record<number, string> = {
  1: "Managed slot — organisation-wide policy, loaded first every session.",
  2: "User-global slot — your personal config, loaded next.",
  3: "Ancestor-walk slot — CLAUDE.md from each parent folder up to home.",
  4: "Project slot — CLAUDE.md and rules inside this project.",
  5: "Auto-memory slot — notes Claude wrote based on past corrections.",
  6: "On-demand slot — files Claude reads only when relevant (paths-scoped rules, mentions).",
};

function priorityBadgeStyle(priority: number): React.CSSProperties {
  const step = Math.min(Math.max(priority - 1, 0), 5);
  const amberPct = 100 - step * 15;
  const faintPct = step * 15;
  const color = `color-mix(in srgb, var(--amber) ${amberPct}%, var(--paper-faint) ${faintPct}%)`;
  const borderColor = `color-mix(in srgb, var(--amber) ${Math.max(amberPct - 30, 10)}%, var(--line) ${100 - Math.max(amberPct - 30, 10)}%)`;
  return { color, borderColor };
}

// ---------------------------------------------------------------------------
// Internal tree node types
// ---------------------------------------------------------------------------

interface DirNode {
  name: string;
  path: string;
  type: "directory";
  hasChildren: boolean;
  loaded: boolean;
  expanded: boolean;
  fetching: boolean;
  error?: string;
  children: FsNode[];
}

interface FileNode {
  name: string;
  path: string;
  type: "file";
}

type FsNode = DirNode | FileNode;

function childToNode(c: CwdTreeChild): FsNode {
  if (c.type === "directory") {
    return {
      name: c.name,
      path: c.path,
      type: "directory",
      hasChildren: c.has_children,
      loaded: false,
      expanded: false,
      fetching: false,
      children: [],
    };
  }
  return { name: c.name, path: c.path, type: "file" };
}

function patchDir(nodes: FsNode[], path: string, patch: Partial<DirNode>): FsNode[] {
  return nodes.map((n) => {
    if (n.type === "directory") {
      if (n.path === path) return { ...n, ...patch };
      if (n.children.length > 0) return { ...n, children: patchDir(n.children, path, patch) };
    }
    return n;
  });
}

function findDir(nodes: FsNode[], path: string): DirNode | null {
  for (const n of nodes) {
    if (n.type === "directory") {
      if (n.path === path) return n;
      const sub = findDir(n.children, path);
      if (sub) return sub;
    }
  }
  return null;
}

// Does any file node in the subtree match the query?
function subtreeHasMatch(nodes: FsNode[], lq: string): boolean {
  for (const n of nodes) {
    if (n.type === "file") {
      if (n.name.toLowerCase().includes(lq) || n.path.toLowerCase().includes(lq)) return true;
    } else {
      if (n.name.toLowerCase().includes(lq) || subtreeHasMatch(n.children, lq)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// AutoloadToggle — re-declared locally to avoid circular import with ExplorerPane.
// Identical logic to the one in ExplorerPane.tsx.
// ---------------------------------------------------------------------------

import { postAutoloadTogglePreview } from "../api/client";
import { useWritePipeline } from "../hooks/useWritePipeline";

interface AutoloadToggleProps {
  path: string;
  applicable: boolean;
  on: boolean;
  writable: boolean;
  cwd?: string;
}

function AutoloadToggle({ path, applicable, on, writable, cwd }: AutoloadToggleProps) {
  const { confirmStagedPreview } = useWritePipeline();
  const [loading, setLoading] = useState(false);
  const [notApplicableReason, setNotApplicableReason] = useState<string | null>(null);

  if (!applicable) {
    return <span className="explorer-autoload na" aria-hidden title="Not applicable" />;
  }

  if (notApplicableReason !== null) {
    return (
      <span className="explorer-autoload always" title={notApplicableReason} aria-label="Always loaded">
        always loaded
      </span>
    );
  }

  async function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    if (loading || !writable) return;
    setLoading(true);
    try {
      const preview = await postAutoloadTogglePreview(path, !on, cwd);
      if (!preview.toggle_applicable) {
        setNotApplicableReason(preview.reason ?? "Not applicable for this file type");
        return;
      }
      await confirmStagedPreview(path, preview);
    } catch {
      // Toast is pushed by confirmStagedPreview on failure.
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      className={`explorer-autoload${on ? " on" : ""}${loading ? " pending" : ""}`}
      title={
        !writable
          ? "Read-only — cannot toggle"
          : on
            ? "Autoload: on — click to disable"
            : "Autoload: off — click to enable"
      }
      aria-label={on ? "Autoload on" : "Autoload off"}
      aria-pressed={on}
      disabled={loading || !writable}
      onClick={handleClick}
      tabIndex={-1}
    />
  );
}

// ---------------------------------------------------------------------------
// Component props
// ---------------------------------------------------------------------------

export interface ProjectFilesGroupProps {
  cwd: string;
  /** All FileEntry objects from /api/index, keyed by absolute path. */
  filesByPath: Map<string, FileEntry>;
  /** file_id → priority (1–6). */
  priorityMap: Map<string, number>;
  /** file_id → LoadStatus. */
  statusMap?: Map<string, LoadStatus> | null;
  /** Current filter query (from ExplorerPane search input). */
  query: string;
  /** Single-click → select on graph + Inspector. */
  onSelectFile?: (file: FileEntry) => void;
  /** Double-click → open EditorPanel. */
  onDblClickFile?: (file: FileEntry) => void;
  /** Hover → highlight graph node. */
  onHoverFile?: (fileId: string | null) => void;
  /** Right-click → build ContextMenuTarget. */
  onContextMenuFile?: (e: React.MouseEvent, file: FileEntry) => void;
  /** Which file_id is currently selected. */
  selectedId?: string | null;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ProjectFilesGroup({
  cwd,
  filesByPath,
  priorityMap,
  statusMap,
  query,
  onSelectFile,
  onDblClickFile,
  onHoverFile,
  onContextMenuFile,
  selectedId,
}: ProjectFilesGroupProps) {
  const [_root, setRoot] = useState<CwdTreeResponse | null>(null);
  const [nodes, setNodes] = useState<FsNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // DnD move modal state.
  const [moveModal, setMoveModal] = useState<{
    sourcePath: string;
    dstDir: string;
  } | null>(null);

  const expanded = useStore((s) => s.treeExpanded);
  const setTreeExpanded = useStore((s) => s.setTreeExpanded);

  // Expand state key for a dir: "cwd-tree:<path>"
  const expandKey = (path: string) => `cwd-tree:${path}`;

  function isExpanded(path: string): boolean {
    return expanded.has(expandKey(path));
  }

  function setExpanded(path: string, open: boolean) {
    const next = new Set(expanded);
    if (open) next.add(expandKey(path));
    else next.delete(expandKey(path));
    setTreeExpanded(next);
  }

  // Ref to the top-level group open state (separate from per-dir expand).
  const [groupOpen, setGroupOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setRoot(null);
    setNodes([]);
    fetchCwdTree(cwd)
      .then((resp) => {
        if (cancelled) return;
        setRoot(resp);
        setNodes(resp.children.map(childToNode));
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [cwd]);

  // Auto-open the group when there's a filter query and we have nodes.
  useEffect(() => {
    if (query && nodes.length > 0) setGroupOpen(true);
  }, [query, nodes.length]);

  const toggleDir = useCallback(
    (dirPath: string) => {
      setNodes((current) => {
        const target = findDir(current, dirPath);
        if (!target) return current;

        if (target.expanded) {
          setExpanded(dirPath, false);
          return patchDir(current, dirPath, { expanded: false });
        }

        if (target.loaded) {
          setExpanded(dirPath, true);
          return patchDir(current, dirPath, { expanded: true });
        }

        fetchCwdTree(cwd, dirPath)
          .then((resp) => {
            setNodes((latest) =>
              patchDir(latest, dirPath, {
                loaded: true,
                fetching: false,
                expanded: true,
                children: resp.children.map(childToNode),
                error: undefined,
              }),
            );
            setExpanded(dirPath, true);
          })
          .catch((e: unknown) => {
            setNodes((latest) =>
              patchDir(latest, dirPath, {
                loaded: true,
                fetching: false,
                expanded: true,
                error: e instanceof Error ? e.message : String(e),
              }),
            );
          });

        return patchDir(current, dirPath, { fetching: true });
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cwd],
  );

  // Restore persisted expand state when nodes reload.
  useEffect(() => {
    if (nodes.length === 0) return;
    function applyPersistedExpand(ns: FsNode[]): FsNode[] {
      return ns.map((n) => {
        if (n.type === "directory" && isExpanded(n.path)) {
          return { ...n, expanded: true };
        }
        return n;
      });
    }
    setNodes((cur) => applyPersistedExpand(cur));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  const handleDrop = useCallback(
    (e: React.DragEvent, dstDir: string) => {
      e.preventDefault();
      e.stopPropagation();
      const srcPath = e.dataTransfer.getData("application/x-observatory-fs-path");
      if (!srcPath) return;
      const srcBasename = srcPath.split("/").pop() ?? "";
      const wouldBeAt = dstDir + "/" + srcBasename;
      if (wouldBeAt === srcPath) return; // Same folder, ignore silently.
      setMoveModal({ sourcePath: srcPath, dstDir });
    },
    [],
  );

  const lq = query.toLowerCase().trim();
  const totalCount = nodes.length;

  const hasMatch = !lq || subtreeHasMatch(nodes, lq);

  return (
    <div className="explorer-group">
      <button
        className="explorer-group-head"
        onClick={() => setGroupOpen((v) => !v)}
        aria-expanded={groupOpen}
      >
        <span className="explorer-group-chev">
          {totalCount > 0 ? (groupOpen ? "▾" : "▸") : ""}
        </span>
        <span className="explorer-group-label">All files</span>
        <span className="explorer-group-count">{loading ? "…" : totalCount}</span>
      </button>
      {groupOpen && (
        <div className="explorer-group-body">
          {error && (
            <div className="explorer-empty" style={{ color: "var(--danger, #c66)" }}>
              Could not load files: {error}
            </div>
          )}
          {!error && !loading && totalCount === 0 && (
            <div className="explorer-empty">Empty directory</div>
          )}
          {lq && !hasMatch && (
            <div className="explorer-empty">No files match</div>
          )}
          {nodes.length > 0 && (
            <FsNodeList
              nodes={nodes}
              depth={0}
              cwd={cwd}
              filesByPath={filesByPath}
              priorityMap={priorityMap}
              statusMap={statusMap}
              query={lq}
              onToggleDir={toggleDir}
              onSelectFile={onSelectFile}
              onDblClickFile={onDblClickFile}
              onHoverFile={onHoverFile}
              onContextMenuFile={onContextMenuFile}
              onDrop={handleDrop}
              selectedId={selectedId}
            />
          )}
        </div>
      )}

      {moveModal && (
        <MoveConfirmModal
          sourcePath={moveModal.sourcePath}
          dstDir={moveModal.dstDir}
          activeCwd={cwd}
          onClose={() => setMoveModal(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FsNodeList
// ---------------------------------------------------------------------------

interface FsNodeListProps {
  nodes: FsNode[];
  depth: number;
  cwd: string;
  filesByPath: Map<string, FileEntry>;
  priorityMap: Map<string, number>;
  statusMap?: Map<string, LoadStatus> | null;
  query: string;
  onToggleDir: (path: string) => void;
  onSelectFile?: (file: FileEntry) => void;
  onDblClickFile?: (file: FileEntry) => void;
  onHoverFile?: (fileId: string | null) => void;
  onContextMenuFile?: (e: React.MouseEvent, file: FileEntry) => void;
  onDrop: (e: React.DragEvent, dstDir: string) => void;
  selectedId?: string | null;
}

function FsNodeList({
  nodes,
  depth,
  cwd,
  filesByPath,
  priorityMap,
  statusMap,
  query,
  onToggleDir,
  onSelectFile,
  onDblClickFile,
  onHoverFile,
  onContextMenuFile,
  onDrop,
  selectedId,
}: FsNodeListProps) {
  return (
    <>
      {nodes.map((n) =>
        n.type === "directory" ? (
          <FsDirRow
            key={n.path}
            node={n}
            depth={depth}
            cwd={cwd}
            filesByPath={filesByPath}
            priorityMap={priorityMap}
            statusMap={statusMap}
            query={query}
            onToggleDir={onToggleDir}
            onSelectFile={onSelectFile}
            onDblClickFile={onDblClickFile}
            onHoverFile={onHoverFile}
            onContextMenuFile={onContextMenuFile}
            onDrop={onDrop}
            selectedId={selectedId}
          />
        ) : (
          <FsFileRow
            key={n.path}
            node={n}
            depth={depth}
            cwd={cwd}
            filesByPath={filesByPath}
            priorityMap={priorityMap}
            statusMap={statusMap}
            onSelectFile={onSelectFile}
            onDblClickFile={onDblClickFile}
            onHoverFile={onHoverFile}
            onContextMenuFile={onContextMenuFile}
            onDrop={onDrop}
            selectedId={selectedId}
            query={query}
          />
        ),
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// FsDirRow
// ---------------------------------------------------------------------------

interface FsDirRowProps {
  node: DirNode;
  depth: number;
  cwd: string;
  filesByPath: Map<string, FileEntry>;
  priorityMap: Map<string, number>;
  statusMap?: Map<string, LoadStatus> | null;
  query: string;
  onToggleDir: (path: string) => void;
  onSelectFile?: (file: FileEntry) => void;
  onDblClickFile?: (file: FileEntry) => void;
  onHoverFile?: (fileId: string | null) => void;
  onContextMenuFile?: (e: React.MouseEvent, file: FileEntry) => void;
  onDrop: (e: React.DragEvent, dstDir: string) => void;
  selectedId?: string | null;
}

function FsDirRow({
  node,
  depth,
  cwd,
  filesByPath,
  priorityMap,
  statusMap,
  query,
  onToggleDir,
  onSelectFile,
  onDblClickFile,
  onHoverFile,
  onContextMenuFile,
  onDrop,
  selectedId,
}: FsDirRowProps) {
  const indent = 24 + depth * 14;
  const expandable = node.hasChildren || node.children.length > 0;
  const [isDragOver, setIsDragOver] = useState(false);

  // When query is active and this dir has matching children, auto-expand.
  const lq = query;
  const autoExpand = lq ? subtreeHasMatch(node.children, lq) : null;
  const isOpen = autoExpand !== null ? (node.expanded || autoExpand) : node.expanded;

  // Filter: skip dir if no children match.
  if (lq && !node.name.toLowerCase().includes(lq) && !subtreeHasMatch(node.children, lq)) {
    return null;
  }

  return (
    <div role="treeitem" aria-expanded={isOpen}>
      <button
        className={`explorer-folder-row${isDragOver ? " drag-over" : ""}`}
        style={{ paddingLeft: indent }}
        onClick={() => expandable && onToggleDir(node.path)}
        title={node.path}
        disabled={!expandable && !node.fetching}
        onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
        onDragLeave={(e) => {
          if (!(e.currentTarget as Node).contains(e.relatedTarget as Node)) setIsDragOver(false);
        }}
        onDrop={(e) => { setIsDragOver(false); onDrop(e, node.path); }}
      >
        <span className="explorer-row-chev">
          {expandable ? (node.fetching ? "…" : isOpen ? "▾" : "▸") : ""}
        </span>
        <span className="explorer-folder-icon">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="1.8"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
          </svg>
        </span>
        <span className="explorer-folder-label">{node.name}</span>
      </button>
      {isOpen && (
        <>
          {node.error && (
            <div className="explorer-empty" style={{ paddingLeft: indent + 18, color: "var(--danger, #c66)" }}>
              {node.error}
            </div>
          )}
          {!node.error && node.loaded && node.children.length === 0 && (
            <div className="explorer-empty" style={{ paddingLeft: indent + 18 }}>(empty)</div>
          )}
          {node.children.length > 0 && (
            <FsNodeList
              nodes={node.children}
              depth={depth + 1}
              cwd={cwd}
              filesByPath={filesByPath}
              priorityMap={priorityMap}
              statusMap={statusMap}
              query={query}
              onToggleDir={onToggleDir}
              onSelectFile={onSelectFile}
              onDblClickFile={onDblClickFile}
              onHoverFile={onHoverFile}
              onContextMenuFile={onContextMenuFile}
              onDrop={onDrop}
              selectedId={selectedId}
            />
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FsFileRow
// ---------------------------------------------------------------------------

interface FsFileRowProps {
  node: FileNode;
  depth: number;
  cwd: string;
  filesByPath: Map<string, FileEntry>;
  priorityMap: Map<string, number>;
  statusMap?: Map<string, LoadStatus> | null;
  query: string;
  onSelectFile?: (file: FileEntry) => void;
  onDblClickFile?: (file: FileEntry) => void;
  onHoverFile?: (fileId: string | null) => void;
  onContextMenuFile?: (e: React.MouseEvent, file: FileEntry) => void;
  onDrop: (e: React.DragEvent, dstDir: string) => void;
  selectedId?: string | null;
}

function FsFileRow({
  node,
  depth,
  cwd,
  filesByPath,
  priorityMap,
  statusMap,
  query,
  onSelectFile,
  onDblClickFile,
  onHoverFile,
  onContextMenuFile,
  onDrop,
  selectedId,
}: FsFileRowProps) {
  const indent = 24 + depth * 14 + 14;
  const lastCwd = useStore((s) => s.lastCwd);

  // Filter: skip if doesn't match query.
  const lq = query;
  if (lq && !node.name.toLowerCase().includes(lq) && !node.path.toLowerCase().includes(lq)) {
    return null;
  }

  const fileEntry = filesByPath.get(node.path) ?? null;
  const isSelected = fileEntry ? fileEntry.id === selectedId : false;

  const priority = fileEntry ? priorityMap.get(fileEntry.id) : undefined;
  const showBadge = priority !== undefined && priority >= 1 && priority <= 6;
  const badgeLabel = priority !== undefined ? (PRIORITY_LABELS[priority] ?? null) : null;
  const badgeTooltip = priority !== undefined ? (PRIORITY_TOOLTIPS[priority] ?? null) : null;

  const statusLoaded = fileEntry && statusMap ? statusMap.get(fileEntry.id) === "loaded" : false;
  const autoloadState = fileEntry?.autoload_state;
  const alwaysLoaded = autoloadState === "n/a";
  const autoloadApplicable =
    fileEntry !== null &&
    !alwaysLoaded &&
    fileEntry.kind !== "automemory" &&
    fileEntry.kind !== "plugin_registry" &&
    fileEntry.kind !== "plugin_manifest" &&
    fileEntry.kind !== "script";
  const autoloadOn = autoloadState !== undefined
    ? autoloadState === "on"
    : (fileEntry?.paths_status !== "missing");

  function handleDragStart(e: React.DragEvent) {
    e.dataTransfer.setData("application/x-observatory-fs-path", node.path);
    e.dataTransfer.effectAllowed = "move";
  }

  // When dropped onto another file, move to that file's parent dir.
  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    const parentDir = node.path.includes("/")
      ? node.path.substring(0, node.path.lastIndexOf("/"))
      : cwd;
    onDrop(e, parentDir);
  }

  return (
    <div
      role="treeitem"
      className={`explorer-row${isSelected ? " selected" : ""}`}
      style={{ paddingLeft: indent }}
      draggable
      onDragStart={handleDragStart}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
      onClick={() => fileEntry && onSelectFile && onSelectFile(fileEntry)}
      onDoubleClick={() => fileEntry && onDblClickFile && onDblClickFile(fileEntry)}
      onMouseEnter={() => fileEntry && onHoverFile && onHoverFile(fileEntry.id)}
      onMouseLeave={() => onHoverFile && onHoverFile(null)}
      onContextMenu={(e) => fileEntry && onContextMenuFile && onContextMenuFile(e, fileEntry)}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" && fileEntry) { onSelectFile && onSelectFile(fileEntry); }
        if (e.key === " " && fileEntry) { e.preventDefault(); onDblClickFile && onDblClickFile(fileEntry); }
      }}
      title={node.path}
    >
      <span className="explorer-row-icon" aria-hidden>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="1.8"
          strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      </span>

      {showBadge && badgeLabel ? (
        <span
          className="explorer-priority-badge"
          style={priorityBadgeStyle(priority!)}
          title={badgeTooltip ?? undefined}
          aria-label={`Load priority: ${badgeLabel}`}
        >
          {badgeLabel}
        </span>
      ) : (
        <span aria-hidden />
      )}

      <span className="explorer-row-name">{node.name}</span>

      {fileEntry ? (
        alwaysLoaded ? (
          <span
            className="explorer-autoload always"
            title="Always loaded — cannot be disabled through Observatory"
            aria-label="Always loaded"
          >
            always loaded
          </span>
        ) : statusMap ? (
          <AutoloadToggle
            path={fileEntry.path}
            applicable={autoloadApplicable}
            on={statusLoaded}
            writable={fileEntry.writable ?? true}
            cwd={lastCwd ?? undefined}
          />
        ) : (
          <AutoloadToggle
            path={fileEntry.path}
            applicable={autoloadApplicable}
            on={autoloadOn}
            writable={fileEntry.writable ?? true}
            cwd={lastCwd ?? undefined}
          />
        )
      ) : null}
    </div>
  );
}
