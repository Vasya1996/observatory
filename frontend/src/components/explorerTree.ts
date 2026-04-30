/**
 * explorerTree.ts — Build a hierarchical tree from a flat FileEntry list.
 *
 * Three always-visible zones (locked rule #50):
 *   • USER CONFIG  — ~/.claude/ but NOT ~/.claude/plugins/cache/
 *                    Always visible regardless of cwd.
 *   • PROJECT      — files under the actively-selected cwd (and not in
 *                    user-config or settings regions).
 *                    When cwd changes, this zone refreshes.
 *   • SETTINGS & PLUGINS — settings.json, .mcp.json, plugins/cache/...,
 *                    OS-managed CLAUDE.md. Always visible.
 *   • OTHER        — safety net for files that don't fit any zone.
 *                    Auto-collapsed.
 *
 * Grouping is purely frontend (locked rule #30 — no backend restructuring).
 * Paths are derived from FileEntry.path; home prefix inferred from the file
 * list (locked rule #47 — no hardcoded /home/voxdecaelo).
 */

import type { FileEntry } from "../types";

export interface TreeNode {
  id: string;           // file id (from FileEntry)
  path: string;
  display: string;      // basename or display_name
  kind: FileEntry["kind"];
  isOrphan: boolean;
  file: FileEntry;
  children: TreeNode[]; // unused (files are leaves); kept for type compat
}

export interface TreeFolder {
  id: string;           // "folder:" + absolute path
  label: string;        // directory name segment
  fullPath: string;     // absolute path of the folder
  children: (TreeFolder | TreeNode)[];
  defaultOpen: boolean;
}

export interface TreeGroup {
  id: string;           // "user-config" | "project" | "settings" | "other"
  label: string;        // human-readable group header
  defaultOpen: boolean;
  children: (TreeFolder | TreeNode)[];
  count: number;
}

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
 * Build a true nested folder tree from a flat list of files rooted at basePath.
 * Every distinct directory segment gets its own TreeFolder node.
 * Single-child folders are NOT flattened — we always show the full path.
 * Default-open: small folders (≤3 children) auto-expand for usability.
 */
function buildFolderTree(
  files: FileEntry[],
  basePath: string,
  orphanIds: Set<string>,
): (TreeFolder | TreeNode)[] {
  // Group files by their immediate child segment under basePath.
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
    const firstSegment = slashIdx !== -1 ? rel.slice(0, slashIdx) : "";
    const key = firstSegment;
    if (!byFirstSegment.has(key)) byFirstSegment.set(key, []);
    byFirstSegment.get(key)!.push(f);
  }

  const result: (TreeFolder | TreeNode)[] = [];

  for (const [segment, group] of byFirstSegment) {
    if (segment === "") {
      // Files sitting directly in basePath (no subdirectory)
      for (const f of group) {
        result.push(fileToNode(f, orphanIds));
      }
    } else {
      const folderPath = basePath + "/" + segment;
      const subItems = buildFolderTree(group, folderPath, orphanIds);
      // Auto-expand if ≤3 children (usability for small dirs)
      const small = subItems.length <= 3;
      result.push({
        id: "folder:" + folderPath,
        label: segment,
        fullPath: folderPath,
        defaultOpen: small,
        children: subItems,
      });
    }
  }

  return result;
}

/**
 * Returns true if the file belongs to the SETTINGS & PLUGINS zone regardless
 * of which cwd is active. This covers settings.json, .mcp.json, plugins/cache/,
 * managed CLAUDE.md at OS paths, and kinds like skill/plugin_manifest.
 */
function isSettingsZone(f: FileEntry, home: string): boolean {
  const claudeDir = home ? home + "/.claude" : "/.claude";
  const pluginCacheDir = claudeDir + "/plugins/cache";

  // Files inside plugins/cache/ always go to Settings & Plugins
  if (f.path.startsWith(pluginCacheDir + "/") || f.path === pluginCacheDir) {
    return true;
  }

  // settings.json and .mcp.json at the root ~/.claude/
  const p = f.path;
  if (p === claudeDir + "/settings.json") return true;
  if (p === claudeDir + "/settings.local.json") return true;
  if (p === claudeDir + "/.mcp.json") return true;

  // Kind-based: skills, plugin manifests, plugin registry, MCP, settings, scripts
  const settingsKinds: FileEntry["kind"][] = [
    "settings",
    "mcp",
    "skill",
    "plugin_manifest",
    "plugin_registry",
    "script",
  ];
  if (settingsKinds.includes(f.kind)) return true;

  // OS-managed CLAUDE.md (Linux: /etc/claude-code/CLAUDE.md, macOS: /Library/...)
  if (
    f.path === "/etc/claude-code/CLAUDE.md" ||
    f.path.startsWith("/Library/Application Support/ClaudeCode/") ||
    f.path.startsWith("C:\\Program Files\\ClaudeCode\\")
  ) {
    return true;
  }

  return false;
}

/**
 * Returns true if the file belongs to the USER CONFIG zone:
 * path under ~/.claude/ but NOT under plugins/cache/.
 */
function isUserConfigZone(f: FileEntry, home: string): boolean {
  const claudeDir = home ? home + "/.claude" : "/.claude";
  const pluginCacheDir = claudeDir + "/plugins/cache";

  if (!f.path.startsWith(claudeDir + "/") && f.path !== claudeDir + "/CLAUDE.md") {
    return false;
  }
  // Exclude the plugins/cache subtree — those go to Settings & Plugins
  if (f.path.startsWith(pluginCacheDir + "/") || f.path === pluginCacheDir) {
    return false;
  }
  // Settings kinds (settings.json, .mcp.json) inside ~/.claude/ go to Settings zone
  if (isSettingsZone(f, home)) return false;

  return true;
}

/**
 * Returns true if the file belongs to the PROJECT zone for the given cwd.
 * Files under the cwd that are not already claimed by User Config or Settings.
 */
function isProjectZone(f: FileEntry, activeCwd: string, home: string): boolean {
  if (!activeCwd) return false;
  if (isSettingsZone(f, home)) return false;
  if (isUserConfigZone(f, home)) return false;

  return f.path.startsWith(activeCwd + "/") || f.path === activeCwd;
}

export function buildExplorerTree(
  files: FileEntry[],
  orphanIds: Set<string>,
  activeCwd: string | null,
): TreeGroup[] {
  const home = deriveHomeFromFiles(files);
  const claudeDir = home ? home + "/.claude" : "/.claude";

  const userFiles: FileEntry[] = [];
  const projectFiles: FileEntry[] = [];
  const settingsFiles: FileEntry[] = [];
  const otherFiles: FileEntry[] = [];

  for (const f of files) {
    if (isSettingsZone(f, home)) {
      settingsFiles.push(f);
    } else if (isUserConfigZone(f, home)) {
      userFiles.push(f);
    } else if (activeCwd && isProjectZone(f, activeCwd, home)) {
      projectFiles.push(f);
    } else {
      otherFiles.push(f);
    }
  }

  const groups: TreeGroup[] = [];

  // --- USER CONFIG ---
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

  // --- PROJECT ---
  {
    const cwdLabel = activeCwd
      ? buildProjectLabel(activeCwd, home)
      : null;
    const label = cwdLabel ? `Project — ${cwdLabel}` : "Project";

    if (activeCwd && projectFiles.length > 0) {
      const children = buildFolderTree(projectFiles, activeCwd, orphanIds);
      groups.push({
        id: "project",
        label,
        defaultOpen: true,
        children,
        count: countItems(children),
      });
    } else {
      // Always show the zone, even when empty, so the user sees it
      groups.push({
        id: "project",
        label,
        defaultOpen: true,
        children: [],
        count: 0,
      });
    }
  }

  // --- SETTINGS & PLUGINS ---
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

  // --- OTHER (safety net) ---
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

function buildProjectLabel(cwd: string, home: string): string {
  const collapsed = collapseToHome(cwd, home);
  if (collapsed === "~") return "Home folder";
  return collapsed;
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

/** Check if a file is inside ~/.claude/plugins/cache/ (plugin-managed, read-only). */
export function isPluginCacheFile(path: string, home: string): boolean {
  const pluginCacheDir = (home ? home + "/.claude" : "/.claude") + "/plugins/cache";
  return path.startsWith(pluginCacheDir + "/") || path === pluginCacheDir;
}
