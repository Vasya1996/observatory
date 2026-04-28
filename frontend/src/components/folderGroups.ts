// Frontend-only visual grouping: when N siblings of the same kind live under
// one umbrella directory, the Map collapses them into a single "folder" node
// with the children fanned out as a temporary halo on hover. The FileEntry
// list emitted by the backend is untouched — this is purely a rendering layer
// over the already-scanned graph.
//
// Two foldable kinds today:
//   * `plugin_manifest` — used for cache (CLI) plugins under
//     `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/...`. The
//     rule below ignores hash-named remote plugins
//     (`~/.claude/remote/plugins/<hash>/...`) by construction: it only treats
//     a plugin as foldable when one of its on-disk path components matches its
//     metadata `display_name`. Hashes never match, so remote plugins keep
//     their individual nodes; cache plugins, whose dir IS named after the
//     plugin, get grouped by their umbrella.
//   * `skill` — `~/.claude/skills/<skill-name>/SKILL.md`. None exist today
//     (subagent-confirmed 2026-04-28) but a future cluster groups by the
//     `skills/` umbrella.

import type { FileEntry } from "../types";

export interface FolderGroup {
  id: string;             // synthetic cy node id ("folder:<umbrellaPath>")
  label: string;          // umbrella basename, e.g. "claude-plugins-official"
  umbrellaPath: string;   // absolute umbrella directory
  childIds: string[];     // FileEntry ids hidden behind the folder
}

const MIN_GROUP_SIZE = 2;

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

// Resolve the umbrella directory for a foldable file. Returns null if the
// file isn't foldable under any rule (e.g. a hash-dir remote plugin, or a
// kind we don't fold).
function umbrellaDir(f: FileEntry): string | null {
  if (f.kind === "skill") {
    // /.../<skill-name>/SKILL.md → skill root = parent dir, umbrella = grandparent.
    const slash = f.path.lastIndexOf("/");
    if (slash <= 0) return null;
    const skillRoot = f.path.slice(0, slash);
    const u = skillRoot.lastIndexOf("/");
    return u <= 0 ? null : skillRoot.slice(0, u);
  }
  if (f.kind === "plugin_manifest") {
    const name = f.display_name;
    if (!name) return null;
    // Walk up looking for the deepest path component matching display_name.
    // That is the plugin's own directory; its parent is the umbrella.
    const parts = f.path.split("/");
    let idx = -1;
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i] === name) {
        idx = i;
        break;
      }
    }
    if (idx <= 0) return null;
    return parts.slice(0, idx).join("/");
  }
  return null;
}

export function computeFolderGroups(files: FileEntry[]): FolderGroup[] {
  const buckets = new Map<string, string[]>();
  for (const f of files) {
    const u = umbrellaDir(f);
    if (!u) continue;
    const arr = buckets.get(u);
    if (arr) arr.push(f.id);
    else buckets.set(u, [f.id]);
  }
  const groups: FolderGroup[] = [];
  for (const [umbrellaPath, childIds] of buckets) {
    if (childIds.length < MIN_GROUP_SIZE) continue;
    groups.push({
      id: `folder:${umbrellaPath}`,
      label: basename(umbrellaPath),
      umbrellaPath,
      childIds,
    });
  }
  return groups;
}

// Reverse index for O(1) "is this file folded? which folder?" lookups.
export function buildChildFolderIndex(
  groups: FolderGroup[],
): Map<string, string> {
  const m = new Map<string, string>();
  for (const g of groups) {
    for (const cid of g.childIds) m.set(cid, g.id);
  }
  return m;
}
