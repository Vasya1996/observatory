/**
 * explorerTree.ts — Build a priority-ordered tree from a flat FileEntry list.
 *
 * Phase 4 final wave: zones (USER CONFIG / PROJECT / SETTINGS) are gone.
 * The tree shows a single root of files INSIDE the active cwd, grouped by
 * the 6 load-order priority tiers, with folder nesting preserved within
 * each tier.
 *
 *   Tier 1: Managed      — OS-wide policy CLAUDE.md
 *   Tier 2: User-global  — ~/.claude/CLAUDE.md + rules without paths:
 *   Tier 3: Ancestor-walk — CLAUDE.md / CLAUDE.local.md up the directory tree
 *   Tier 4: Project      — CLAUDE.md and rules inside this project
 *   Tier 5: Auto-memory  — MEMORY.md + topic files from auto-memory dir
 *   Tier 6: On-demand    — paths-scoped rules, nested CLAUDE.md, etc.
 *
 * Files OUTSIDE the active cwd are handled by CrossCwdPanel (above the tree).
 * This tree only shows files whose physical path is under activeCwd.
 *
 * "Off-chain" files (priority absent / 7+, or not in the priorityMap) appear
 * below all tiers in an "All files" catch-all group — always collapsed.
 *
 * Grouping is purely frontend (locked rule #30 — no backend restructuring).
 */

import type { FileEntry } from "../types";

// ---- Data shapes -----------------------------------------------------------

export interface TreeNode {
  id: string;
  path: string;
  display: string;
  kind: FileEntry["kind"];
  isOrphan: boolean;
  file: FileEntry;
  children: TreeNode[];
}

export interface TreeFolder {
  id: string;
  label: string;
  fullPath: string;
  children: (TreeFolder | TreeNode)[];
  defaultOpen: boolean;
}

export interface TreeGroup {
  id: string;
  label: string;
  defaultOpen: boolean;
  children: (TreeFolder | TreeNode)[];
  count: number;
}

// ---- Tier metadata ---------------------------------------------------------

const TIER_LABELS: Record<number, string> = {
  1: "Managed",
  2: "User-global",
  3: "Ancestor-walk",
  4: "Project",
  5: "Auto-memory",
  6: "On-demand",
};

// ---- Helpers ---------------------------------------------------------------

export function deriveHomeFromFiles(files: FileEntry[]): string {
  for (const f of files) {
    const m = f.path.match(/^(\/home\/[^/]+)\//);
    if (m) return m[1];
    const m2 = f.path.match(/^(\/Users\/[^/]+)\//);
    if (m2) return m2[1];
  }
  return "";
}

function basename(p: string): string {
  return p.split("/").pop() ?? p;
}

export function collapseToHome(p: string, home: string): string {
  if (home && p === home) return "~";
  if (home && p.startsWith(home + "/")) return "~" + p.slice(home.length);
  return p;
}

function countItems(items: (TreeFolder | TreeNode)[]): number {
  let n = 0;
  for (const item of items) {
    if ("file" in item) {
      n++;
    } else {
      n += countItems(item.children);
    }
  }
  return n;
}

function fileToNode(f: FileEntry, orphanIds: Set<string>): TreeNode {
  return {
    id: f.id,
    path: f.path,
    display: f.display_name ?? basename(f.path),
    kind: f.kind,
    isOrphan: orphanIds.has(f.id),
    file: f,
    children: [],
  };
}

/**
 * Build a nested folder tree from a flat list of files rooted at basePath.
 * Every distinct directory segment gets its own TreeFolder node.
 * Default-open: folders with ≤3 children auto-expand.
 */
function buildFolderTree(
  files: FileEntry[],
  basePath: string,
  orphanIds: Set<string>,
): (TreeFolder | TreeNode)[] {
  const byFirstSegment = new Map<string, FileEntry[]>();

  for (const f of files) {
    let rel: string;
    if (f.path.startsWith(basePath + "/")) {
      rel = f.path.slice(basePath.length + 1);
    } else if (f.path === basePath) {
      rel = "";
    } else {
      rel = f.path;
    }

    const slashIdx = rel.indexOf("/");
    const key = slashIdx !== -1 ? rel.slice(0, slashIdx) : "";
    if (!byFirstSegment.has(key)) byFirstSegment.set(key, []);
    byFirstSegment.get(key)!.push(f);
  }

  const result: (TreeFolder | TreeNode)[] = [];

  for (const [segment, group] of byFirstSegment) {
    if (segment === "") {
      for (const f of group) {
        result.push(fileToNode(f, orphanIds));
      }
    } else {
      const folderPath = basePath + "/" + segment;
      const subItems = buildFolderTree(group, folderPath, orphanIds);
      result.push({
        id: "folder:" + folderPath,
        label: segment,
        fullPath: folderPath,
        defaultOpen: subItems.length <= 3,
        children: subItems,
      });
    }
  }

  return result;
}

// ---- Public API ------------------------------------------------------------

/**
 * Build a priority-ordered tree.
 *
 * @param files     Full flat file list from /api/index.
 * @param orphanIds Set of file ids flagged as orphan configs.
 * @param activeCwd Currently selected cwd path (null = no cwd selected).
 * @param priorityMap Map from file_id → priority tier (1–6) from /api/simulate.
 */
export function buildExplorerTree(
  files: FileEntry[],
  orphanIds: Set<string>,
  activeCwd: string | null,
  priorityMap: Map<string, number> = new Map(),
): TreeGroup[] {
  // Partition files into those inside the active cwd vs outside.
  // Only inside-cwd files go into the priority-ordered tree.
  // Outside-cwd files are handled by CrossCwdPanel — but for the "All files"
  // catch-all we include everything not mapped to a tier (off-chain).
  const insideCwd = (f: FileEntry) => {
    if (!activeCwd) return true; // no cwd = show everything
    return f.path === activeCwd || f.path.startsWith(activeCwd + "/");
  };

  // Group files by their priority tier.
  const tierBuckets = new Map<number, FileEntry[]>();
  const offChain: FileEntry[] = [];

  for (const f of files) {
    const pri = priorityMap.get(f.id);
    if (pri !== undefined && pri >= 1 && pri <= 6) {
      // For the tier tree, only include files inside the cwd (cross-cwd files
      // appear in CrossCwdPanel above the tree, not here).
      if (insideCwd(f)) {
        if (!tierBuckets.has(pri)) tierBuckets.set(pri, []);
        tierBuckets.get(pri)!.push(f);
      }
    } else {
      // Off-chain: file not in any priority tier (not loaded for this cwd,
      // or no cwd selected yet). Show all files regardless of cwd location.
      offChain.push(f);
    }
  }

  const groups: TreeGroup[] = [];
  const cwdRoot = activeCwd ?? "/";

  // Emit one group per tier that has files.
  for (let tier = 1; tier <= 6; tier++) {
    const bucket = tierBuckets.get(tier);
    if (!bucket || bucket.length === 0) continue;

    const children = buildFolderTree(bucket, cwdRoot, orphanIds);
    groups.push({
      id: `tier-${tier}`,
      label: TIER_LABELS[tier] ?? `Tier ${tier}`,
      defaultOpen: tier <= 4, // top 4 tiers open by default
      children,
      count: countItems(children),
    });
  }

  // Off-chain catch-all — collapsed by default.
  if (offChain.length > 0) {
    const children = buildFolderTree(offChain, cwdRoot, orphanIds);
    groups.push({
      id: "offchain",
      label: "All files",
      defaultOpen: false,
      children,
      count: countItems(children),
    });
  }

  return groups;
}

/** Flatten all node ids in order (group headers + folder ids + file ids). */
export function flattenIds(groups: TreeGroup[]): string[] {
  const ids: string[] = [];
  function walk(items: (TreeFolder | TreeNode)[]) {
    for (const item of items) {
      if ("file" in item) {
        ids.push(item.id);
      } else {
        ids.push(item.id);
        walk(item.children);
      }
    }
  }
  for (const g of groups) {
    ids.push(g.id);
    walk(g.children);
  }
  return ids;
}

/** Return ids of all ancestor folders/groups for a given file id. */
export function ancestorIds(groups: TreeGroup[], targetId: string): string[] {
  const ancestors: string[] = [];

  function walkItems(
    items: (TreeFolder | TreeNode)[],
    path: string[],
  ): boolean {
    for (const item of items) {
      if ("file" in item) {
        if (item.id === targetId) {
          ancestors.push(...path);
          return true;
        }
      } else {
        if (walkItems(item.children, [...path, item.id])) return true;
      }
    }
    return false;
  }

  for (const g of groups) {
    if (walkItems(g.children, [g.id])) break;
  }
  return ancestors;
}

/** Check if a file is inside ~/.claude/plugins/cache/ (plugin-managed). */
export function isPluginCacheFile(path: string, home: string): boolean {
  const pluginCacheDir = (home ? home + "/.claude" : "/.claude") + "/plugins/cache";
  return path.startsWith(pluginCacheDir + "/") || path === pluginCacheDir;
}
