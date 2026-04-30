/**
 * explorerTree.ts — Build a hierarchical tree from a flat FileEntry list.
 *
 * Groups files by their filesystem location into four top-level zones that
 * match how Claude Code actually organises config:
 *   • User config — ~/.claude/ (CLAUDE.md, rules/, knowledge/)
 *   • Projects — per-discovered-project files
 *   • Settings — settings.json, .mcp.json, skills, plugins
 *   • Other — anything that doesn't fit the above
 *
 * The grouping is purely frontend (locked rule #30 — no backend restructuring).
 * Paths are derived from the FileEntry.path field; home prefix is inferred from
 * the file list (locked rule #47 — no hardcoded /home/voxdecaelo).
 */

import type { FileEntry } from "../types";

export interface TreeNode {
  id: string;           // file id (from FileEntry)
  path: string;
  display: string;      // basename
  kind: FileEntry["kind"];
  isOrphan: boolean;    // never loaded in any cwd (from orphan_configs)
  file: FileEntry;
  children: TreeNode[]; // sub-folders (synthetic, no file backing)
}

export interface TreeFolder {
  id: string;           // synthetic: "folder:" + path
  label: string;        // display label, e.g. "rules"
  fullPath: string;     // absolute path of the folder
  children: (TreeFolder | TreeNode)[];
  defaultOpen: boolean;
}

export interface TreeGroup {
  id: string;           // e.g. "user-config", "projects", "settings", "other"
  label: string;        // human-readable group header
  defaultOpen: boolean;
  children: (TreeFolder | TreeNode)[];
  count: number;        // total file count including nested
}

/** Derive the home directory prefix from observed absolute paths. */
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

function collapseToHome(p: string, home: string): string {
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

/**
 * Given a list of files (with paths sorted within their group), build a
 * nested folder tree. Files that share a parent directory are grouped under
 * a synthetic TreeFolder node. Only creates folder nodes when there is more
 * than one sibling under the same parent — single files sit flat.
 */
function buildFolderTree(
  files: FileEntry[],
  basePath: string,
  orphanIds: Set<string>,
): (TreeFolder | TreeNode)[] {
  type DirMap = Map<string, FileEntry[]>;
  const byDir: DirMap = new Map();

  for (const f of files) {
    let rel = f.path.startsWith(basePath + "/")
      ? f.path.slice(basePath.length + 1)
      : f.path;
    const slashIdx = rel.indexOf("/");
    const dir = slashIdx !== -1 ? rel.slice(0, slashIdx) : "";
    const key = dir;
    if (!byDir.has(key)) byDir.set(key, []);
    byDir.get(key)!.push(f);
  }

  const result: (TreeFolder | TreeNode)[] = [];

  for (const [dir, group] of byDir) {
    if (dir === "") {
      for (const f of group) {
        result.push(fileToNode(f, orphanIds));
      }
    } else {
      const folderPath = basePath + "/" + dir;
      const subItems = buildFolderTree(group, folderPath, orphanIds);
      if (subItems.length === 1 && "file" in subItems[0]) {
        result.push(subItems[0]);
      } else {
        result.push({
          id: "folder:" + folderPath,
          label: dir,
          fullPath: folderPath,
          defaultOpen: false,
          children: subItems,
        });
      }
    }
  }

  return result;
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

const USER_CONFIG_KINDS = new Set<FileEntry["kind"]>([
  "claude_md",
  "rule",
  "memory",
  "memory_index",
  "automemory",
]);

const SETTINGS_KINDS = new Set<FileEntry["kind"]>([
  "settings",
  "mcp",
  "skill",
  "plugin_manifest",
  "plugin_registry",
  "script",
]);

export function buildExplorerTree(
  files: FileEntry[],
  orphanIds: Set<string>,
): TreeGroup[] {
  const home = deriveHomeFromFiles(files);
  const claudeDir = home ? home + "/.claude" : "/.claude";

  const userFiles: FileEntry[] = [];
  const settingsFiles: FileEntry[] = [];
  const projectFiles: FileEntry[] = [];
  const otherFiles: FileEntry[] = [];

  for (const f of files) {
    if (f.path.startsWith(claudeDir + "/") || f.path === claudeDir + "/CLAUDE.md") {
      if (USER_CONFIG_KINDS.has(f.kind)) {
        userFiles.push(f);
      } else if (SETTINGS_KINDS.has(f.kind)) {
        settingsFiles.push(f);
      } else {
        otherFiles.push(f);
      }
    } else if (SETTINGS_KINDS.has(f.kind)) {
      settingsFiles.push(f);
    } else if (f.kind === "claude_md" || f.kind === "rule") {
      projectFiles.push(f);
    } else {
      otherFiles.push(f);
    }
  }

  const groups: TreeGroup[] = [];

  if (userFiles.length > 0) {
    const children = buildFolderTree(userFiles, claudeDir, orphanIds);
    groups.push({
      id: "user-config",
      label: "User config",
      defaultOpen: true,
      children,
      count: countItems(children),
    });
  }

  if (projectFiles.length > 0) {
    const projectsByRoot = new Map<string, FileEntry[]>();
    for (const f of projectFiles) {
      let rootDir: string;
      const clDir = f.path.match(/^(.+)\/.claude\//);
      const topDir = f.path.match(/^(\/[^/]+(?:\/[^/]+)?)\/CLAUDE/);
      if (clDir) {
        rootDir = clDir[1];
      } else if (topDir) {
        rootDir = topDir[1];
      } else {
        rootDir = f.path.split("/").slice(0, -1).join("/") || "/";
      }
      if (!projectsByRoot.has(rootDir)) projectsByRoot.set(rootDir, []);
      projectsByRoot.get(rootDir)!.push(f);
    }

    const children: (TreeFolder | TreeNode)[] = [];
    for (const [rootDir, grp] of projectsByRoot) {
      const label = collapseToHome(rootDir, home);
      const subItems = buildFolderTree(grp, rootDir, orphanIds);
      if (subItems.length === 1 && projectsByRoot.size === 1) {
        children.push(...subItems);
      } else {
        children.push({
          id: "folder:" + rootDir,
          label,
          fullPath: rootDir,
          defaultOpen: false,
          children: subItems,
        });
      }
    }
    groups.push({
      id: "projects",
      label: "Projects",
      defaultOpen: true,
      children,
      count: countItems(children),
    });
  }

  if (settingsFiles.length > 0) {
    const children = buildFolderTree(settingsFiles, claudeDir, orphanIds);
    groups.push({
      id: "settings",
      label: "Settings & plugins",
      defaultOpen: false,
      children,
      count: countItems(children),
    });
  }

  if (otherFiles.length > 0) {
    const children = buildFolderTree(otherFiles, home || "/", orphanIds);
    groups.push({
      id: "other",
      label: "Other",
      defaultOpen: false,
      children,
      count: countItems(children),
    });
  }

  return groups;
}

/** Flatten the tree into ordered (id → path) pairs for scroll-into-view. */
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

/** Given a file id, collect the ids of all its ancestor folders and groups. */
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
