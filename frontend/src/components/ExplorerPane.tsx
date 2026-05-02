/**
 * ExplorerPane — 320px fixed-width left column on 01 MAP (locked rule #50).
 *
 * Phase 4 final wave:
 *   - Three zones (USER CONFIG / PROJECT / SETTINGS) removed.
 *   - CrossCwdPanel above the tree: files Claude also reads that live OUTSIDE
 *     the active cwd (ancestor CLAUDE.md, user-global, managed).
 *   - Tree below: files INSIDE the active cwd, ordered by priority tier
 *     (Managed→User-global→Ancestor-walk→Project→Auto-memory→On-demand),
 *     with folder nesting preserved within each tier.
 *   - Every file is draggable — no not-allowed cursor, no disabled handles.
 *     Every drop opens NormalizeWizardModal showing the full consequence diff.
 *
 * Interactions:
 *   single click  → select node in graph + open Inspector (locked rule #24)
 *   double click  → open EditorPanel (locked rule #46)
 *   hover row     → highlight matching graph node + dim others (bidirectional)
 *   hover graph   → highlight matching tree row + faint amber tint
 *   drag any file → drop opens NormalizeWizardModal (locked rule #36)
 *
 * Priority badge: ordinal text (1st–6th) with amber→paper-faint brightness
 * gradient. Tooltip = slot name in plain language.
 * Hover "?" on cross-cwd rows → WHY explanation tooltip.
 */

import {
  type Ref,
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useStore } from "../state/store";
import { useWritePipeline } from "../hooks/useWritePipeline";
import { postAutoloadTogglePreview } from "../api/client";
import { ICON_PATH_BY_KIND } from "./nodeIcons";
import type { FileEntry, LoadStatus, OrphanConfigEntry, TimelineStep } from "../types";
import {
  buildExplorerTree,
  ancestorIds,
  deriveHomeFromFiles,
  isPluginCacheFile,
  type TreeFolder,
  type TreeGroup,
  type TreeNode,
} from "./explorerTree";
import { CrossCwdPanel } from "./CrossCwdPanel";
import { CwdSelector } from "./CwdSelector";
import { ProjectFilesGroup } from "./ProjectFilesGroup";

// ---------------------------------------------------------------------------
// Priority badge helpers
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
// Props
// ---------------------------------------------------------------------------

interface Props {
  files: FileEntry[];
  orphanConfigs: OrphanConfigEntry[];
  /** Map from file_id → priority (1–6) from the latest /api/simulate response. */
  priorityMap?: Map<string, number>;
  /** Latest simulate steps — used by CrossCwdPanel to identify cross-cwd files. */
  steps?: TimelineStep[];
  /** Per-cwd load status from /api/simulate. Used to drive interactive toggles in tier-1-6 groups. */
  statusMap?: Map<string, LoadStatus> | null;
  /** Row hover → tell parent to highlight graph node + dim others. */
  onRowHover: (fileId: string | null) => void;
  /** Right-click on a tree row → parent builds ContextMenuTarget. */
  onRowContextMenu?: (e: React.MouseEvent, file: FileEntry, pluginManaged?: boolean) => void;
  /** True while a post-write /api/simulate refetch is in flight. */
  refetching?: boolean;
}

export const ExplorerPane = forwardRef<HTMLElement, Props>(function ExplorerPane({
  files,
  orphanConfigs,
  priorityMap = new Map(),
  steps = [],
  statusMap,
  onRowHover,
  onRowContextMenu,
  refetching = false,
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

  // Build tree with priority ordering baked in (zones removed).
  const groups = useMemo(
    () => buildExplorerTree(files, orphanIds, lastCwd, priorityMap),
    [files, orphanIds, lastCwd, priorityMap],
  );

  // On first load, seed treeExpanded with the defaultOpen folders from the tree.
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

  // Build a path→FileEntry map for the unified tree.
  const filesByPath = useMemo(() => {
    const m = new Map<string, FileEntry>();
    for (const f of files) m.set(f.path, f);
    return m;
  }, [files]);

  return (
    <aside className="explorer-pane" ref={ref as Ref<HTMLElement>}>
      <div className="explorer-pane-header">
        <h2 className="explorer-pane-title">
          File <em>explorer</em>
          {refetching && <span className="explorer-refetch-dot" aria-label="Updating priorities…" title="Updating priorities…" />}
        </h2>
        <div className="explorer-cwd-slot">
          <CwdSelector />
        </div>
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
        {/* Cross-cwd panel — files Claude reads for this folder that live outside it */}
        {lastCwd && steps.length > 0 && (
          <CrossCwdPanel
            steps={steps}
            files={files}
            activeCwd={lastCwd}
            home={home}
            onSelect={(fileId) => select(fileId)}
            onRowContextMenu={onRowContextMenu}
          />
        )}

        {/* Unified filesystem tree — replaces the old priority-tier groups. */}
        {lastCwd && (
          <ProjectFilesGroup
            cwd={lastCwd}
            filesByPath={filesByPath}
            priorityMap={priorityMap}
            statusMap={statusMap}
            query={lq}
            selectedId={selectedId}
            onSelectFile={(file) => {
              select(file.id);
            }}
            onDblClickFile={(file) => {
              select(file.id);
              setEditorOpen(file.path, true);
            }}
            onHoverFile={(fileId) => onRowHover(fileId)}
            onContextMenuFile={(e, file) => {
              if (onRowContextMenu) {
                const pluginManaged = isPluginCacheFile(file.path, home);
                onRowContextMenu(e, file, pluginManaged);
              }
            }}
          />
        )}
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
  priorityMap: Map<string, number>;
  statusMap?: Map<string, LoadStatus> | null;
  onZoneDrop: (e: React.DragEvent) => void;
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
  priorityMap,
  statusMap,
  onZoneDrop,
}: GroupRowProps) {
  if (query && group.children.length > 0 && !folderHasMatch(group.children)) return null;

  const isOpen = expanded.has(group.id);
  const isEmpty = group.children.length === 0;

  const [isDragOver, setIsDragOver] = useState(false);

  return (
    <div
      className={`explorer-group${isDragOver ? " drag-over" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
      onDragLeave={(e) => {
        if (!(e.currentTarget as Node).contains(e.relatedTarget as Node)) {
          setIsDragOver(false);
        }
      }}
      onDrop={(e) => { setIsDragOver(false); onZoneDrop(e); }}
    >
      <button
        className="explorer-group-head"
        onClick={() => !isEmpty && toggle(group.id)}
        aria-expanded={isOpen}
        disabled={isEmpty}
      >
        <span className="explorer-group-chev">
          {!isEmpty && (isOpen ? "▾" : "▸")}
        </span>
        <span className="explorer-group-label">{group.label}</span>
        <span className="explorer-group-count">{group.count}</span>
      </button>
      {isOpen && !isEmpty && (
        <div className="explorer-group-body">
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
            priorityMap={priorityMap}
            statusMap={statusMap}
            groupId={group.id}
          />
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
  priorityMap: Map<string, number>;
  statusMap?: Map<string, LoadStatus> | null;
  groupId: string;
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
    priorityMap,
    statusMap,
    groupId,
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
              priority={priorityMap.get(item.id)}
              groupId={groupId}
              statusMap={statusMap}
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
              priorityMap={priorityMap}
              statusMap={statusMap}
              groupId={groupId}
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
  priorityMap: Map<string, number>;
  statusMap?: Map<string, LoadStatus> | null;
  groupId: string;
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
  priorityMap,
  statusMap,
  groupId,
}: FolderRowProps) {
  const indent = 24 + depth * 14;
  const childCount = countChildFiles(folder.children);
  const [isDragOver, setIsDragOver] = useState(false);

  return (
    <div role="treeitem" aria-expanded={isOpen}>
      <button
        className={`explorer-folder-row${isDragOver ? " drag-over" : ""}`}
        style={{ paddingLeft: indent }}
        onClick={() => toggle(folder.id)}
        title={folder.fullPath}
        onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setIsDragOver(false);
        }}
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
          priorityMap={priorityMap}
          statusMap={statusMap}
          groupId={groupId}
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
  priority?: number;
  groupId: string;
  statusMap?: Map<string, LoadStatus> | null;
  onRowClick: (f: FileEntry) => void;
  onRowDblClick: (f: FileEntry) => void;
  onRowMouseEnter: (id: string) => void;
  onRowMouseLeave: () => void;
  onRowContextMenu: (e: React.MouseEvent, f: FileEntry) => void;
  registerRef: (id: string) => (el: HTMLDivElement | null) => void;
}

// Tier groups are "tier-1" through "tier-6" — the offchain catch-all is "offchain".
function isTierGroup(groupId: string): boolean {
  return /^tier-[1-6]$/.test(groupId);
}

function FileRow({
  node,
  depth,
  isSelected,
  isOrphan,
  priority,
  groupId,
  statusMap,
  onRowClick,
  onRowDblClick,
  onRowMouseEnter,
  onRowMouseLeave,
  onRowContextMenu,
  registerRef,
}: FileRowProps) {
  const lastCwd = useStore((s) => s.lastCwd);
  const indent = 24 + depth * 14 + 14;
  const iconPath = ICON_PATH_BY_KIND[node.kind] ?? null;

  const autoloadState = node.file.autoload_state;
  const alwaysLoaded = autoloadState === "n/a";

  // In a tier-1-6 group: derive on/off from statusMap if available.
  // OFF-chain group ("offchain") keeps the "always loaded" pill.
  const inTier = isTierGroup(groupId);
  const statusLoaded = statusMap ? statusMap.get(node.id) === "loaded" : false;

  // For tier groups: every row gets an interactive toggle driven by statusMap.
  // The toggle ON state = statusMap says "loaded"; OFF = everything else.
  // For offchain group: keep the legacy alwaysLoaded pill logic.
  const showInteractiveToggle = inTier;

  const autoloadApplicable = !alwaysLoaded &&
    node.kind !== "automemory" &&
    node.kind !== "plugin_registry" &&
    node.kind !== "plugin_manifest" &&
    node.kind !== "script";
  const autoloadOn = autoloadState !== undefined
    ? autoloadState === "on"
    : node.file.paths_status !== "missing";

  // All files are draggable — the drop handler (NormalizeWizardModal) handles
  // consequences including read-only / plugin-managed implications.
  function handleDragStart(e: React.DragEvent) {
    e.dataTransfer.setData("application/x-observatory-file-id", node.id);
    e.dataTransfer.setData("application/x-observatory-group-id", groupId);
    e.dataTransfer.effectAllowed = "move";
  }

  const showBadge = priority !== undefined && priority >= 1 && priority <= 6;
  const badgeLabel = priority !== undefined ? (PRIORITY_LABELS[priority] ?? null) : null;
  const badgeTooltip = priority !== undefined ? (PRIORITY_TOOLTIPS[priority] ?? null) : null;

  return (
    <div
      ref={registerRef(node.id)}
      role="treeitem"
      className={`explorer-row${isSelected ? " selected" : ""}`}
      data-file-id={node.id}
      style={{ paddingLeft: indent }}
      draggable
      onDragStart={handleDragStart}
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

      {showInteractiveToggle ? (
        <AutoloadToggle
          path={node.path}
          applicable={autoloadApplicable}
          on={statusLoaded}
          writable={node.file.writable ?? true}
          cwd={lastCwd ?? undefined}
        />
      ) : alwaysLoaded ? (
        <span
          className="explorer-autoload always"
          title="Always loaded — cannot be disabled through Observatory"
          aria-label="Always loaded"
        >always loaded</span>
      ) : (
        <AutoloadToggle
          path={node.path}
          applicable={autoloadApplicable}
          on={autoloadOn}
          writable={node.file.writable ?? true}
          cwd={lastCwd ?? undefined}
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
  cwd?: string;
}

function AutoloadToggle({ path, applicable, on, writable, cwd }: AutoloadToggleProps) {
  const { confirmStagedPreview } = useWritePipeline();
  const [loading, setLoading] = useState(false);
  // When backend returns toggle_applicable: false, surface the reason as a
  // pill tooltip instead of a functional toggle.
  const [notApplicableReason, setNotApplicableReason] = useState<string | null>(null);

  if (!applicable) {
    return <span className="explorer-autoload na" aria-hidden title="Not applicable" />;
  }

  if (notApplicableReason !== null) {
    return (
      <span
        className="explorer-autoload always"
        title={notApplicableReason}
        aria-label="Always loaded"
      >always loaded</span>
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
      title={!writable ? "Read-only — cannot toggle" : on ? "Autoload: on — click to disable" : "Autoload: off — click to enable"}
      aria-label={on ? "Autoload on" : "Autoload off"}
      aria-pressed={on}
      disabled={loading || !writable}
      onClick={handleClick}
      tabIndex={-1}
    />
  );
}
