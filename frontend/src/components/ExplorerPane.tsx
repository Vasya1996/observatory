/**
 * ExplorerPane — 320px fixed-width left column.
 *
 * Always-on in MapView, left of the canvas. Shows every file from /api/index
 * in a hierarchical tree grouped by filesystem location. Backed by
 * explorerTree.ts (pure, no side effects).
 *
 * Interactions:
 *   single click  → select node in graph + open Inspector (locked rule #24)
 *   double click  → open EditorPanel (locked rule #46, existing component)
 *   hover row     → highlight matching graph node + dim others (bidirectional)
 *   hover graph   → highlight matching tree row + faint amber tint
 *
 * Search: substring filter on basename + path. Filter mode hides non-matches
 * and auto-expands parent folders.
 *
 * Autoload toggle: rendered per-row (on / off / disabled). Backend contract
 * not yet landed — toggle renders visually but does not fire writes until
 * observatory_phase4_autoload_toggle.md is published by the backend agent.
 *
 * Expand/collapse: persisted to localStorage under key "obs_tree_expanded"
 * (string[]). When backend ships tree_expanded in UiState, migrate to
 * /api/state — the shape is identical.
 *
 * Orphan indicator: small static amber glyph "◎" next to filenames that
 * appear in orphan_configs from /api/non-canonical.
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
import type cytoscape from "cytoscape";
import { useStore } from "../state/store";
import { ICON_PATH_BY_KIND } from "./nodeIcons";
import type { FileEntry, OrphanConfigEntry } from "../types";
import {
  buildExplorerTree,
  ancestorIds,
  type TreeFolder,
  type TreeGroup,
  type TreeNode,
} from "./explorerTree";

const STORAGE_KEY = "obs_tree_expanded";
const DEFAULT_OPEN_GROUPS = new Set(["user-config", "projects"]);

function loadExpanded(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return new Set<string>(arr as string[]);
    }
  } catch {
    /* ignore */
  }
  return new Set<string>(DEFAULT_OPEN_GROUPS);
}

function saveExpanded(s: Set<string>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...s]));
  } catch {
    /* ignore */
  }
}

interface Props {
  files: FileEntry[];
  orphanConfigs: OrphanConfigEntry[];
  cy: cytoscape.Core | null;
  /** Row hover → tell parent to highlight the graph node. */
  onRowHover: (fileId: string | null) => void;
}

export const ExplorerPane = forwardRef<HTMLElement, Props>(function ExplorerPane({
  files,
  orphanConfigs,
  cy,
  onRowHover,
}, ref) {
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const setEditorOpen = useStore((s) => s.setEditorOpen);
  const [expanded, setExpanded] = useState<Set<string>>(loadExpanded);
  const [query, setQuery] = useState("");
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const orphanIds = useMemo(
    () => new Set(orphanConfigs.map((o) => files.find((f) => f.path === o.file_path)?.id ?? "")),
    [orphanConfigs, files],
  );

  const groups = useMemo(
    () => buildExplorerTree(files, orphanIds),
    [files, orphanIds],
  );

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveExpanded(next);
      return next;
    });
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

  // When a graph node is selected from outside (e.g. user clicks graph node),
  // auto-expand ancestors and scroll the row into view.
  useEffect(() => {
    if (!selectedId) return;
    const anc = ancestorIds(groups, selectedId);
    if (anc.length === 0) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const id of anc) {
        if (!next.has(id)) { next.add(id); changed = true; }
      }
      if (changed) { saveExpanded(next); return next; }
      return prev;
    });
    // Scroll into view after a brief delay to let expansion render.
    const t = setTimeout(() => {
      const el = rowRefs.current.get(selectedId);
      if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, 80);
    return () => clearTimeout(t);
  }, [selectedId, groups]);

  // Bidirectional: graph hover → highlight tree row.
  // GraphCanvas doesn't yet emit hovered-node events outside of cy.
  // We handle this via a custom event dispatched in GraphCanvas if needed.
  // For now the graph→tree direction is handled via CSS `.explorer-row.graph-hovered`.

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

  function registerRef(id: string) {
    return (el: HTMLDivElement | null) => {
      if (el) rowRefs.current.set(id, el);
      else rowRefs.current.delete(id);
    };
  }

  // Total match count for empty-state display.
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
  orphanIds,
  registerRef,
}: GroupRowProps) {
  if (query && !folderHasMatch(group.children)) return null;

  const isOpen = expanded.has(group.id);

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
            orphanIds={orphanIds}
            registerRef={registerRef}
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
    orphanIds,
    registerRef,
  } = props;

  return (
    <>
      {items.map((item) => {
        if ("file" in item) {
          // TreeNode
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
              registerRef={registerRef}
            />
          );
        } else {
          // TreeFolder
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
  orphanIds,
  registerRef,
}: FolderRowProps) {
  const indent = 24 + depth * 14;
  return (
    <div role="treeitem" aria-expanded={isOpen}>
      <button
        className="explorer-folder-row"
        style={{ paddingLeft: indent }}
        onClick={() => toggle(folder.id)}
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
          orphanIds={orphanIds}
          registerRef={registerRef}
        />
      )}
    </div>
  );
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
  registerRef,
}: FileRowProps) {
  const indent = 24 + depth * 14 + 14; // extra 14 for indent past folder chevron
  const iconPath = ICON_PATH_BY_KIND[node.kind] ?? null;

  // Autoload toggle visual state — no write wired yet (backend contract pending).
  // "applicable" kinds: claude_md, rule; others are not autoload-toggleable.
  const autoloadApplicable = node.kind === "claude_md" || node.kind === "rule";
  // Treat all files as on for now (read from file.paths_status when backend lands).
  const autoloadOn = autoloadApplicable && node.file.paths_status !== "missing";

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

      <AutoloadToggle
        applicable={autoloadApplicable}
        on={autoloadOn}
        disabled
      />
    </div>
  );
}

interface AutoloadToggleProps {
  applicable: boolean;
  on: boolean;
  disabled: boolean;
}

function AutoloadToggle({ applicable, on, disabled }: AutoloadToggleProps) {
  if (!applicable) {
    return <span className="explorer-autoload na" aria-hidden title="Not applicable" />;
  }
  return (
    <button
      className={`explorer-autoload${on ? " on" : ""}${disabled ? " pending" : ""}`}
      title={disabled ? "Autoload toggle — backend contract pending" : on ? "Autoload: on" : "Autoload: off"}
      aria-label={on ? "Autoload on" : "Autoload off"}
      aria-pressed={on}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        // Write not wired yet — pending backend contract.
      }}
      tabIndex={-1}
    />
  );
}
