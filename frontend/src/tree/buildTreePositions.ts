// Pure tree-layout builder for the Map's tree mode.
//
// Locked rule #33 keeps GraphCanvas's 560-line useEffect untouched; instead
// the parent (MapView) computes a per-node position map here and passes it as
// a prop. When the map is non-empty, GraphCanvas switches its layout option
// from cola to `preset` and reads positions from this map. Pure function so it
// is trivially testable in isolation and re-runs without side effects when
// inputs change (cwd swap, status overlay update, etc).
//
// Step 3.1 ships ONLY the user-side zone (root = `~/.claude/CLAUDE.md`,
// children = its `@-import` graph capped at depth 5, plus `~/.claude/rules/*.md`
// dangling as siblings of root). Project / settings / orphan zones land in
// Step 3.2 — for now they contribute no positions, which leaves their files
// at cytoscape's default (0,0) origin under preset layout. The caller is
// expected to fall back to graph mode if the map is empty (no user-side root
// found, e.g. fresh machine). Locked rule #34 was overridden by Vasya:
// classical top-down via d3.tree(), NOT radial.

import { hierarchy, tree, type HierarchyNode } from "d3-hierarchy";
import type { Edge, FileEntry, LoadStatus } from "../types";

export interface Viewport {
  width: number;
  height: number;
}

export type PositionMap = Map<string, { x: number; y: number }>;

// Frontend cap on the user-side import-chain depth. Matches Claude Code's
// official documented limit (5 hops). Backend simulator stays uncapped per
// locked rule #30.
const USER_TREE_MAX_DEPTH = 5;

// Tree layout sizing — d3.tree() positions are unit-less; we scale into the
// allocated zone via a final transform.
const TREE_NODE_X_GAP = 90;
const TREE_NODE_Y_GAP = 95;
// Top of the user-side zone, in canvas px from top. Leaves headroom for the
// "USER LAYER" corner label above the root.
const USER_ZONE_TOP_PADDING_PX = 80;

/**
 * Build per-node position assignments for tree mode.
 *
 * Step 3.1 fills only the user-side zone. Files that don't belong to it are
 * absent from the returned map; the caller (`MapView` → `GraphCanvas`) keeps
 * its own fallback behaviour.
 *
 * @param files       all FileEntry nodes from `/api/index`
 * @param edges       all edges; only `kind === "import"` is consumed today
 * @param cwd         active working directory; reserved for Step 3.2 zones
 * @param statusMap   per-file LoadStatus from simulator; reserved for 3.2
 * @param viewport    canvas size in px (used to scale + place each zone)
 */
export function buildTreePositions(
  files: FileEntry[],
  edges: Edge[],
  _cwd: string | null,
  _statusMap: Map<string, LoadStatus> | null,
  viewport: Viewport,
): PositionMap {
  const positions: PositionMap = new Map();

  // Locate the user-side root by canonical home-collapsed display. FileEntry
  // already exposes both `path` (absolute) and `display` (`~`-prefixed); we
  // match on `display` so the function is host-independent (tests can use
  // synthetic FileEntry without knowing the runtime $HOME).
  const root = files.find((f) => f.display === "~/.claude/CLAUDE.md");
  if (!root) return positions;

  // Index files and import-edges for fast lookup. Mention edges are layout-
  // irrelevant in tree mode (rendered as thin "lianas" by cytoscape but not
  // used to build the spine).
  const fileById = new Map(files.map((f) => [f.id, f]));
  const importsBySource = new Map<string, string[]>();
  for (const e of edges) {
    if (e.kind !== "import") continue;
    const list = importsBySource.get(e.source);
    if (list) list.push(e.target);
    else importsBySource.set(e.source, [e.target]);
  }

  // BFS-walk the import chain from root, capped at depth 5. `seen` prevents
  // cycles (a file importing something that re-imports it via a longer path).
  // We capture a parent pointer per visited file so we can build the d3
  // hierarchy structurally.
  type NodeRec = { id: string; parentId: string | null };
  const records: NodeRec[] = [{ id: root.id, parentId: null }];
  const depthById = new Map<string, number>([[root.id, 0]]);
  const seen = new Set<string>([root.id]);
  const queue: string[] = [root.id];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const curDepth = depthById.get(cur) ?? 0;
    if (curDepth >= USER_TREE_MAX_DEPTH) continue;
    const targets = importsBySource.get(cur);
    if (!targets) continue;
    for (const t of targets) {
      if (seen.has(t)) continue;
      if (!fileById.has(t)) continue;
      seen.add(t);
      records.push({ id: t, parentId: cur });
      depthById.set(t, curDepth + 1);
      queue.push(t);
    }
  }

  // `~/.claude/rules/*.md` rules are auto-loaded by Claude Code (when their
  // `paths:` matches, or unconditionally when no `paths:` is set) but reach
  // the session OUTSIDE the @-import graph — they hang directly off CLAUDE.md
  // semantically, not via a literal import. Surface them as siblings of root
  // under a synthetic super-root so the tree visually presents them as
  // user-layer-attached even though no edge connects them.
  const dangling: string[] = [];
  for (const f of files) {
    if (f.kind !== "rule") continue;
    if (!f.display.startsWith("~/.claude/rules/")) continue;
    if (seen.has(f.id)) continue;
    // Only "active or potentially active" rules dangle in user zone; rules
    // with paths_status === "missing" still get placed (they're noise but
    // visible — locked mission rule "completeness over minimalism").
    dangling.push(f.id);
    seen.add(f.id);
  }

  // Build a synthetic super-root above the real root so d3 has one tree to
  // lay out. Its children are: [actual root, ...dangling rules]. The super-
  // root is invisible (no FileEntry id matches) and will not be assigned a
  // position in the output map.
  const SUPER_ROOT = "__user_super_root__";
  type Datum = { id: string; parentId: string | null };
  const data: Datum[] = [{ id: SUPER_ROOT, parentId: null }];
  // Real root's parent flips from null to SUPER_ROOT.
  data.push({ id: root.id, parentId: SUPER_ROOT });
  for (const r of records) {
    if (r.id === root.id) continue;
    data.push({ id: r.id, parentId: r.parentId });
  }
  for (const dId of dangling) {
    data.push({ id: dId, parentId: SUPER_ROOT });
  }

  // d3.stratify from a flat parent-pointer table.
  const root0 = stratify(data);
  if (!root0) return positions;

  const layout = tree<Datum>().nodeSize([TREE_NODE_X_GAP, TREE_NODE_Y_GAP]);
  const laid = layout(root0);

  // Compute the laid-out bounding box so we can fit it inside the user-zone
  // sub-rect (LEFT THIRD of the canvas). d3.tree centres around x=0 by
  // construction with nodeSize, so we collect min/max ourselves.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  laid.each((n) => {
    if (n.x < minX) minX = n.x;
    if (n.x > maxX) maxX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.y > maxY) maxY = n.y;
  });

  // User zone occupies the LEFT THIRD horizontally. Vertically it starts at
  // USER_ZONE_TOP_PADDING_PX and runs to the bottom of the canvas.
  const zoneXStart = 0;
  const zoneXEnd = viewport.width / 3;
  const zoneCenterX = (zoneXStart + zoneXEnd) / 2;
  // The synthetic super-root sits at d3-space y=0 (one row above the real
  // root). We want the REAL root visually placed at the top of the zone, so
  // we shift everything by -minY (super-root y) and add a one-row offset to
  // make space for the invisible super-root row above the visible top.
  const yOffsetToTop = USER_ZONE_TOP_PADDING_PX - minY;

  // If laid-out tree is wider than the zone, scale horizontally to fit.
  const laidWidth = Math.max(1, maxX - minX);
  const zoneWidth = Math.max(1, zoneXEnd - zoneXStart - 24); // 12px side padding
  const xScale = laidWidth > zoneWidth ? zoneWidth / laidWidth : 1;

  laid.each((n) => {
    const id = n.data.id;
    if (id === SUPER_ROOT) return; // synthetic, no visual node
    const x = zoneCenterX + (n.x - (minX + maxX) / 2) * xScale;
    const y = n.y + yOffsetToTop;
    positions.set(id, { x, y });
  });

  return positions;
}

/**
 * Minimal stratify helper — builds a HierarchyNode from a flat
 * `{id, parentId}` table. We bypass d3.stratify (which throws on cycles and
 * orphaned parents) because we already control the data shape upstream and
 * only need the children accessor.
 */
function stratify<T extends { id: string; parentId: string | null }>(
  data: T[],
): HierarchyNode<T> | null {
  const childrenById = new Map<string, T[]>();
  let rootDatum: T | null = null;
  for (const d of data) {
    if (d.parentId === null) {
      rootDatum = d;
      continue;
    }
    const list = childrenById.get(d.parentId);
    if (list) list.push(d);
    else childrenById.set(d.parentId, [d]);
  }
  if (!rootDatum) return null;
  return hierarchy<T>(rootDatum, (d) => childrenById.get(d.id) ?? []);
}
