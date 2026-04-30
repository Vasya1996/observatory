/**
 * ExplorerPane — 320px fixed-width left column on 01 MAP.
 *
 * Always-on in MapView, left of the canvas. Shows every file from /api/index
 * in a hierarchical tree grouped by filesystem zone:
 *   - USER CONFIG  — ~/.claude/ (excluding plugins/cache)
 *   - PROJECT      — active cwd's files (refreshes on cwd change)
 *   - SETTINGS & PLUGINS — settings.json, .mcp.json, plugins/cache/
 *   - OTHER        — safety net, auto-collapsed
 *
 * Interactions:
 *   single click  → select node in graph + open Inspector (locked rule #24)
 *   double click  → open EditorPanel (locked rule #46)
 *   hover row     → highlight matching graph node + dim others (bidirectional)
 *   hover graph   → highlight matching tree row + faint amber tint
 *
 * Search: substring filter on basename + path. Auto-expands parent folders.
 *
 * Expand/collapse: persisted to /api/state via treeExpanded in Zustand.
 * Small folders (≤3 children) default-open per explorerTree.ts logic.
 *
 * Orphan indicator: small amber glyph next to filenames that appear in
 * orphan_configs from /api/non-canonical.
 *
 * Plugin-cache files (under ~/.claude/plugins/cache/): read-only, RMB
 * context-menu Delete is disabled with "Plugin file — managed by Claude Code".
 */

import {
  type Ref,
  forwardRef,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useStore } from "../state/store";
import { useWritePipeline } from "../hooks/useWritePipeline";
import { postAutoloadTogglePreview } from "../api/client";
import { ICON_PATH_BY_KIND } from "./nodeIcons";
import type { FileEntry, OrphanConfigEntry } from "../types";
import {
  buildExplorerTree,
  ancestorIds,
  deriveHomeFromFiles,
  isPluginCacheFile,
  type TreeFolder,
  type TreeGroup,
  type TreeNode,
} from "./explorerTree";


interface Props {
  files: FileEntry[];
  orphanConfigs: OrphanConfigEntry[];
  /** Row hover → tell parent to highlight graph node + dim others. */
  onRowHover: (fileId: string | null) => void;
  /** Right-click on a tree row → parent builds ContextMenuTarget. */
  onRowContextMenu?: (e: React.MouseEvent, file: FileEntry, pluginManaged?: boolean) => void;
}

export const ExplorerPane = forwardRef<HTMLElement, Props>(function ExplorerPane({
  files,
  orphanConfigs,
  onRowHover,
  onRowContextMenu,
}, ref) {
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const setEditorOpen = useStore((s) => s.setEditorOpen);
  const expanded = useStore((s) => s.treeExpanded);
  const setTreeExpanded = useStore((s) => s.setTreeExpanded);
  const lastCwd = useStore((s) => s.lastCwd);
  const [query, setQuery] = useState("");
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const home = useMemo(() => deriveHomeFromFiles(files), [files]);

  const orphanIds = useMemo(
    () => new Set(orphanConfigs.map((o) => files.find((f) => f.path === o.file_path)?.id ?? "")),
    [orphanConfigs, files],
  );

  const groups = useMemo(
    () => buildExplorerTree(files, orphanIds, lastCwd),
    [files, orphanIds, lastCwd],
  );

  // On first load, seed treeExpanded with the defaultOpen folders from the tree.
  // We only seed folders that are not already tracked (so user's manual toggles win).
  useEffect(() => {
    if (groups.length === 0) return;
    const next = new Set(expanded);
    let changed = false;

    function seedDefaults(items: (TreeFolder | TreeNode)[]) {
      for (const item of items) {
        if (!("file" in item)) {
          if (item.defaultOpen && !next.has(item.id)) {
            next.add(item.id);
            changed = true;
          }
          seedDefaults(item.children);
        }
      }
    }

    for (const g of groups) {
      if (g.defaultOpen && !next.has(g.id)) {
        next.add(g.id);
        changed = true;
      }
      seedDefaults(g.children);
    }

    if (changed) setTreeExpanded(next);
  // Only run on initial groups build; subsequent calls rely on user interaction.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups]);

  function toggleExpand(id: string) {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setTreeExpanded(next);
  }

  const lq = query.toLowerCase().trim();

  function matchesSearch(node: TreeNode): boolean {
    if (!lq) return true;
    const name = node.display.toLowerCase();
    return name.includes(lq) || node.path.toLowerCase().includes(lq);
  }

  function folderHasMatch(items: (TreeFolder | TreeNode)[]): boolean {
    for (const item of items) {
      if ("file" in item) {
        if (matchesSearch(item)) return true;
      } else {
        if (folderHasMatch(item.children)) return true;
      }
    }
    return false;
  }

  // When a graph node is selected from outside, auto-expand ancestors + scroll.
  useEffect(() => {
    if (!selectedId) return;
    const anc = ancestorIds(groups, selectedId);
    if (anc.length > 0) {
      const next = new Set(expanded);
      let changed = false;
      for (const id of anc) {
        if (!next.has(id)) { next.add(id); changed = true; }
      }
      if (changed) setTreeExpanded(next);
    }
    const t = setTimeout(() => {
      const el = rowRefs.current.get(selectedId);
      if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, 80);
    return () => clearTimeout(t);
  }, [selectedId, groups, expanded, setTreeExpanded]);

  function handleRowClick(file: FileEntry) {
    select(file.id);
  }

  function handleRowDblClick(file: FileEntry) {
    select(file.id);
    setEditorOpen(file.path, true);
  }

  function handleRowMouseEnter(fileId: string) {
    onRowHover(fileId);
  }

  function handleRowMouseLeave() {
    onRowHover(null);
  }

  function handleRowContextMenu(e: React.MouseEvent, file: FileEntry) {
    if (onRowContextMenu) {
      const pluginManaged = isPluginCacheFile(file.path, home);
      onRowContextMenu(e, file, pluginManaged);
    }
  }

  function registerRef(id: string) {
    return (el: HTMLDivElement | null) => {
      if (el) rowRefs.current.set(id, el);
      else rowRefs.current.delete(id);
    };
  }

  let hasAnyMatch = !lq;
  if (lq) {
    for (const g of groups) {
      if (folderHasMatch(g.children)) { hasAnyMatch = true; break; }
    }
  }

  return (
    <aside className="explorer-pane" ref={ref as Ref<HTMLElement>}>
      <div className="explorer-pane-header">
        <h2 className="explorer-pane-title">
          File <em>explorer</em>
        </h2>
        <div className="explorer-search" role="search">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="11" cy="11" r="8"/>
            <path d="m21 21-4.35-4.35"/>
          </svg>
          <input
            type="text"
            placeholder="Filter files…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filter files"
            spellCheck={false}
          />
          {lq && (
            <button
              className="explorer-search-clear"
              onClick={() => setQuery("")}
              aria-label="Clear filter"
            >
              ×
            </button>
          )}
          <span className="explorer-search-hint">⌘K</span>
        </div>
      </div>

      <div className="explorer-pane-body" role="tree">
        {!hasAnyMatch && (
          <div className="explorer-empty">No files match</div>
        )}
        {groups.map((g) => (
          <GroupRow
            key={g.id}
            group={g}
            expanded={expanded}
            toggle={toggleExpand}
            selectedId={selectedId}
            query={lq}
            matchesSearch={matchesSearch}
            folderHasMatch={folderHasMatch}
            onRowClick={handleRowClick}
            onRowDblClick={handleRowDblClick}
            onRowMouseEnter={handleRowMouseEnter}
            onRowMouseLeave={handleRowMouseLeave}
            onRowContextMenu={handleRowContextMenu}
            orphanIds={orphanIds}
            registerRef={registerRef}
          />
        ))}
      </div>
    </aside>
  );
});

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface GroupRowProps {
  group: TreeGroup;
  expanded: Set<string>;
  toggle: (id: string) => void;
  selectedId: string | null;
  query: string;
  matchesSearch: (n: TreeNode) => boolean;
  folderHasMatch: (items: (TreeFolder | TreeNode)[]) => boolean;
  onRowClick: (f: FileEntry) => void;
  onRowDblClick: (f: FileEntry) => void;
  onRowMouseEnter: (id: string) => void;
  onRowMouseLeave: () => void;
  onRowContextMenu: (e: React.MouseEvent, f: FileEntry) => void;
  orphanIds: Set<string>;
  registerRef: (id: string) => (el: HTMLDivElement | null) => void;
}

function GroupRow({
  group,
  expanded,
  toggle,
  selectedId,
  query,
  matchesSearch,
  folderHasMatch,
  onRowClick,
  onRowDblClick,
  onRowMouseEnter,
  onRowMouseLeave,
  onRowContextMenu,
  orphanIds,
  registerRef,
}: GroupRowProps) {
  if (query && group.children.length > 0 && !folderHasMatch(group.children)) return null;

  const isOpen = expanded.has(group.id);
  const isEmpty = group.children.length === 0;
  const isProjectZone = group.id === "project";

  return (
    <div className="explorer-group" role="treeitem" aria-expanded={isOpen}>
      <button
        className="explorer-group-head"
        onClick={() => toggle(group.id)}
        aria-label={`${isOpen ? "Collapse" : "Expand"} ${group.label}`}
      >
        <span className="explorer-group-chev">{isOpen ? "▾" : "▸"}</span>
        <span className="explorer-group-label upper">{group.label}</span>
        <span className="explorer-group-count">{group.count}</span>
      </button>
      {isOpen && (
        <div className="explorer-group-body">
          {isEmpty && isProjectZone ? (
            <div className="explorer-empty explorer-empty-zone">
              No files Observatory tracks for this folder yet.
            </div>
          ) : (
            <ItemList
              items={group.children}
              depth={0}
              expanded={expanded}
              toggle={toggle}
              selectedId={selectedId}
              query={query}
              matchesSearch={matchesSearch}
              folderHasMatch={folderHasMatch}
              onRowClick={onRowClick}
              onRowDblClick={onRowDblClick}
              onRowMouseEnter={onRowMouseEnter}
              onRowMouseLeave={onRowMouseLeave}
              onRowContextMenu={onRowContextMenu}
              orphanIds={orphanIds}
              registerRef={registerRef}
            />
          )}
        </div>
      )}
    </div>
  );
}

interface ItemListProps {
  items: (TreeFolder | TreeNode)[];
  depth: number;
  expanded: Set<string>;
  toggle: (id: string) => void;
  selectedId: string | null;
  query: string;
  matchesSearch: (n: TreeNode) => boolean;
  folderHasMatch: (items: (TreeFolder | TreeNode)[]) => boolean;
  onRowClick: (f: FileEntry) => void;
  onRowDblClick: (f: FileEntry) => void;
  onRowMouseEnter: (id: string) => void;
  onRowMouseLeave: () => void;
  onRowContextMenu: (e: React.MouseEvent, f: FileEntry) => void;
  orphanIds: Set<string>;
  registerRef: (id: string) => (el: HTMLDivElement | null) => void;
}

function ItemList(props: ItemListProps) {
  const {
    items,
    depth,
    expanded,
    toggle,
    selectedId,
    query,
    matchesSearch,
    folderHasMatch,
    onRowClick,
    onRowDblClick,
    onRowMouseEnter,
    onRowMouseLeave,
    onRowContextMenu,
    orphanIds,
    registerRef,
  } = props;

  return (
    <>
      {items.map((item) => {
        if ("file" in item) {
          if (query && !matchesSearch(item)) return null;
          return (
            <FileRow
              key={item.id}
              node={item}
              depth={depth}
              isSelected={item.id === selectedId}
              isOrphan={orphanIds.has(item.id)}
              onRowClick={onRowClick}
              onRowDblClick={onRowDblClick}
              onRowMouseEnter={onRowMouseEnter}
              onRowMouseLeave={onRowMouseLeave}
              onRowContextMenu={onRowContextMenu}
              registerRef={registerRef}
            />
          );
        } else {
          if (query && !folderHasMatch(item.children)) return null;
          // In search mode force-expand all folders; otherwise respect expanded set
          // but also honour the folder's defaultOpen on first render
          const autoExpand = query ? true : expanded.has(item.id);
          return (
            <FolderRow
              key={item.id}
              folder={item}
              depth={depth}
              isOpen={autoExpand}
              expanded={expanded}
              toggle={toggle}
              selectedId={selectedId}
              query={query}
              matchesSearch={matchesSearch}
              folderHasMatch={folderHasMatch}
              onRowClick={onRowClick}
              onRowDblClick={onRowDblClick}
              onRowMouseEnter={onRowMouseEnter}
              onRowMouseLeave={onRowMouseLeave}
              onRowContextMenu={onRowContextMenu}
              orphanIds={orphanIds}
              registerRef={registerRef}
            />
          );
        }
      })}
    </>
  );
}

interface FolderRowProps {
  folder: TreeFolder;
  depth: number;
  isOpen: boolean;
  expanded: Set<string>;
  toggle: (id: string) => void;
  selectedId: string | null;
  query: string;
  matchesSearch: (n: TreeNode) => boolean;
  folderHasMatch: (items: (TreeFolder | TreeNode)[]) => boolean;
  onRowClick: (f: FileEntry) => void;
  onRowDblClick: (f: FileEntry) => void;
  onRowMouseEnter: (id: string) => void;
  onRowMouseLeave: () => void;
  onRowContextMenu: (e: React.MouseEvent, f: FileEntry) => void;
  orphanIds: Set<string>;
  registerRef: (id: string) => (el: HTMLDivElement | null) => void;
}

function FolderRow({
  folder,
  depth,
  isOpen,
  expanded,
  toggle,
  selectedId,
  query,
  matchesSearch,
  folderHasMatch,
  onRowClick,
  onRowDblClick,
  onRowMouseEnter,
  onRowMouseLeave,
  onRowContextMenu,
  orphanIds,
  registerRef,
}: FolderRowProps) {
  const indent = 24 + depth * 14;
  const childCount = countChildFiles(folder.children);
  return (
    <div role="treeitem" aria-expanded={isOpen}>
      <button
        className="explorer-folder-row"
        style={{ paddingLeft: indent }}
        onClick={() => toggle(folder.id)}
        title={folder.fullPath}
      >
        <span className="explorer-row-chev">{isOpen ? "▾" : "▸"}</span>
        <span className="explorer-folder-icon">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="1.8"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>
          </svg>
        </span>
        <span className="explorer-folder-label">{folder.label}</span>
        <span className="explorer-folder-count">{childCount}</span>
      </button>
      {isOpen && (
        <ItemList
          items={folder.children}
          depth={depth + 1}
          expanded={expanded}
          toggle={toggle}
          selectedId={selectedId}
          query={query}
          matchesSearch={matchesSearch}
          folderHasMatch={folderHasMatch}
          onRowClick={onRowClick}
          onRowDblClick={onRowDblClick}
          onRowMouseEnter={onRowMouseEnter}
          onRowMouseLeave={onRowMouseLeave}
          onRowContextMenu={onRowContextMenu}
          orphanIds={orphanIds}
          registerRef={registerRef}
        />
      )}
    </div>
  );
}

function countChildFiles(items: (TreeFolder | TreeNode)[]): number {
  let n = 0;
  for (const item of items) {
    if ("file" in item) n++;
    else n += countChildFiles(item.children);
  }
  return n;
}

interface FileRowProps {
  node: TreeNode;
  depth: number;
  isSelected: boolean;
  isOrphan: boolean;
  onRowClick: (f: FileEntry) => void;
  onRowDblClick: (f: FileEntry) => void;
  onRowMouseEnter: (id: string) => void;
  onRowMouseLeave: () => void;
  onRowContextMenu: (e: React.MouseEvent, f: FileEntry) => void;
  registerRef: (id: string) => (el: HTMLDivElement | null) => void;
}

function FileRow({
  node,
  depth,
  isSelected,
  isOrphan,
  onRowClick,
  onRowDblClick,
  onRowMouseEnter,
  onRowMouseLeave,
  onRowContextMenu,
  registerRef,
}: FileRowProps) {
  const indent = 24 + depth * 14 + 14;
  const iconPath = ICON_PATH_BY_KIND[node.kind] ?? null;

  const autoloadState = node.file.autoload_state;
  const alwaysLoaded = autoloadState === "n/a";
  const autoloadApplicable = !alwaysLoaded &&
    node.kind !== "automemory" &&
    node.kind !== "plugin_registry" &&
    node.kind !== "plugin_manifest" &&
    node.kind !== "script";
  const autoloadOn = autoloadState !== undefined
    ? autoloadState === "on"
    : node.file.paths_status !== "missing";

  return (
    <div
      ref={registerRef(node.id)}
      role="treeitem"
      className={`explorer-row${isSelected ? " selected" : ""}`}
      data-file-id={node.id}
      style={{ paddingLeft: indent }}
      onClick={() => onRowClick(node.file)}
      onDoubleClick={() => onRowDblClick(node.file)}
      onMouseEnter={() => onRowMouseEnter(node.id)}
      onMouseLeave={onRowMouseLeave}
      onContextMenu={(e) => onRowContextMenu(e, node.file)}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter") onRowClick(node.file);
        if (e.key === " ") { e.preventDefault(); onRowDblClick(node.file); }
      }}
      title={node.path}
    >
      <span className="explorer-row-icon" aria-hidden>
        {iconPath ? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="1.8"
            strokeLinecap="round" strokeLinejoin="round"
            dangerouslySetInnerHTML={{ __html: iconPath }}
          />
        ) : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="1.8"
            strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
        )}
      </span>

      <span className="explorer-row-name">
        {node.display}
      </span>

      {isOrphan && (
        <span
          className="explorer-orphan-glyph"
          title="Claude never loads this file in any project"
          aria-label="Orphan file"
        >
          ◎
        </span>
      )}

      {alwaysLoaded ? (
        <span
          className="explorer-autoload always"
          title={typeof node.file.autoload_state === "string" ? "Always loaded — cannot be disabled through Observatory" : "Always loaded"}
          aria-label="Always loaded"
        />
      ) : (
        <AutoloadToggle
          path={node.path}
          applicable={autoloadApplicable}
          on={autoloadOn}
          writable={node.file.writable ?? true}
        />
      )}
    </div>
  );
}

interface AutoloadToggleProps {
  path: string;
  applicable: boolean;
  on: boolean;
  writable: boolean;
}

function AutoloadToggle({ path, applicable, on, writable }: AutoloadToggleProps) {
  const { confirmStagedPreview } = useWritePipeline();
  const [loading, setLoading] = useState(false);

  if (!applicable) {
    return <span className="explorer-autoload na" aria-hidden title="Not applicable" />;
  }

  async function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    if (loading || !writable) return;
    setLoading(true);
    try {
      const preview = await postAutoloadTogglePreview(path, !on);
      if (!preview.toggle_applicable) {
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
      title={!writable ? "Read-only — cannot toggle" : on ? "Autoload: on — click to disable" : "Autoload: off — click to enable"}
      aria-label={on ? "Autoload on" : "Autoload off"}
      aria-pressed={on}
      disabled={loading || !writable}
      onClick={handleClick}
      tabIndex={-1}
    />
  );
}
