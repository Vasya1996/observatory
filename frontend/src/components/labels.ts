/**
 * Node-label disambiguation.
 *
 * Multiple files can share a basename — the most common case being CLAUDE.md
 * (one at `~/`, one at `~/.claude/`, one per project, one per nested
 * subdirectory). On the graph, six identical "CLAUDE.md" labels make it
 * impossible to tell which is which. Settings.json / settings.local.json
 * have the same problem.
 *
 * Strategy: when a basename is unique across the file set, render just the
 * basename (`MEMORY.md`, `tma_codebase.md`). When it collides, prepend the
 * parent directory name so the label becomes `<parent>/<basename>` (e.g.
 * `.claude/CLAUDE.md`, `storm-sdk/CLAUDE.md`). Home directory renders as `~`
 * via the existing `display` field which is already home-collapsed.
 *
 * Plugin-style display_name overrides (set by the scanner from
 * `.claude-plugin/plugin.json`) win over both — those names are already
 * unique by design.
 */

import type { FileEntry } from "../types";

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

/**
 * Returns the set of basenames that appear on more than one file in the
 * scanned set — those need disambiguation in their graph label.
 */
export function computeAmbiguousBasenames(files: FileEntry[]): Set<string> {
  const counts: Record<string, number> = {};
  for (const f of files) {
    if (f.display_name) continue; // plugin-style names sidestep ambiguity
    const b = basename(f.path);
    counts[b] = (counts[b] ?? 0) + 1;
  }
  const ambiguous = new Set<string>();
  for (const [b, n] of Object.entries(counts)) {
    if (n > 1) ambiguous.add(b);
  }
  return ambiguous;
}

/**
 * Compute the display label for a file. Logic:
 *   1. plugin display_name (e.g. "anthropic-skills") if set
 *   2. otherwise basename, prefixed with parent dir if basename is ambiguous
 */
export function displayLabel(
  f: FileEntry,
  ambiguous: Set<string>,
): string {
  if (f.display_name && f.display_name.length > 0) {
    return f.display_name;
  }
  const base = basename(f.path);
  if (!ambiguous.has(base)) {
    return base;
  }
  // Use the home-collapsed display field so the home directory renders as `~`.
  // For `~/CLAUDE.md` the parent is `~`; for `~/.claude/CLAUDE.md` it's
  // `.claude`; for `~/Claude/global/CLAUDE.md` it's `global` (deepest parent).
  const parts = f.display.split("/");
  if (parts.length < 2) return base;
  const parent = parts[parts.length - 2];
  return `${parent}/${base}`;
}
