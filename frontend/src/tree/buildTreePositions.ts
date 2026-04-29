// Pure tree-layout builder for the Map's tree mode.
//
// Locked rule #33 keeps GraphCanvas's 560-line useEffect untouched; instead
// the parent (MapView) computes a per-node position map here and passes it as
// a prop. When the map is non-empty, GraphCanvas switches its layout option
// from cola to `preset` and reads positions from this map. Pure function so it
// is trivially testable in isolation and re-runs without side effects when
// inputs change (cwd swap, status overlay update, etc).
//
// Step 3.1 shipped only the user-side zone. Step 3.2 fills the remaining three
// zones — project (right third), settings (bottom strip), orphan (bottom-left
// corner) — with strict de-dup priority project > user > settings; everything
// left over lands in orphan. Locked rule #34 was overridden by Vasya:
// classical top-down via d3.tree(), NOT radial.
//
// The function now returns BOTH a position map and a zone assignment map so
// GraphCanvas can apply zone-level styling (faded orphans, hook-edge gating
// inside the settings zone, etc) without re-deriving zone membership.

import { hierarchy, tree, type HierarchyNode } from "d3-hierarchy";
import type { Edge, FileEntry, LoadStatus } from "../types";

export interface Viewport {
  width: number;
  height: number;
}

export type PositionMap = Map<string, { x: number; y: number }>;
export type ZoneName = "user" | "project" | "settings" | "orphan";
export type ZoneMap = Map<string, ZoneName>;

export interface TreeLayout {
  positions: PositionMap;
  zones: ZoneMap;
}

// Frontend cap on the user-side import-chain depth. Matches Claude Code's
// official documented limit (5 hops). Backend simulator stays uncapped per
// locked rule #30.
const USER_TREE_MAX_DEPTH = 5;

// Tree layout sizing — d3.tree() positions are unit-less; we scale into the
// allocated zone via a final transform.
const TREE_NODE_X_GAP = 90;
const TREE_NODE_Y_GAP = 95;
// Top of the user-side / project-side zone, in canvas px from top. Leaves
// headroom for the corner labels above each root.
const ZONE_TOP_PADDING_PX = 80;
// Settings root sits in the upper-middle of the bottom strip; reserve a bit
// of margin so the corner label doesn't crowd it.
const SETTINGS_ZONE_TOP_PADDING_PX = 24;
// Side padding inside each zone so nodes don't kiss the edges.
const ZONE_SIDE_PAD_PX = 12;
// Orphan strip vertical band inside the bottom-left quadrant.
const ORPHAN_TOP_OFFSET_PX = 180;
const ORPHAN_BOTTOM_OFFSET_PX = 30;
const ORPHAN_GRID_GAP_X = 28;
const ORPHAN_GRID_GAP_Y = 28;

/**
 * Build per-node tree-mode layout assignment.
 *
 * Step 3.2 fills all four zones. Files are assigned to exactly one zone in
 * priority order project > user > settings; whatever's left lands in orphan.
 * Each zone is laid out independently, then placed in its allocated screen
 * sector.
 *
 * @param files       all FileEntry nodes from `/api/index`
 * @param edges       all edges; `import` builds the user/project spines, `hook`
 *                    builds the settings spine, `mention` is layout-irrelevant
 * @param cwd         active working directory; drives project & settings zones
 * @param statusMap   per-file LoadStatus from simulator; reserved for future
 *                    zone tweaks (e.g. surfacing conditional rules differently)
 * @param viewport    canvas size in px (used to scale + place each zone)
 */
export function buildTreePositions(
  files: FileEntry[],
  edges: Edge[],
  cwd: string | null,
  _statusMap: Map<string, LoadStatus> | null,
  viewport: Viewport,
): TreeLayout {
  const positions: PositionMap = new Map();
  const zones: ZoneMap = new Map();

  // Index helpers shared across zones.
  const fileById = new Map(files.map((f) => [f.id, f]));
  const fileByDisplay = new Map(files.map((f) => [f.display, f]));

  const importsBySource = new Map<string, string[]>();
  const hooksBySource = new Map<string, string[]>();
  for (const e of edges) {
    if (e.kind === "import") {
      const list = importsBySource.get(e.source);
      if (list) list.push(e.target);
      else importsBySource.set(e.source, [e.target]);
    } else if (e.kind === "hook") {
      const list = hooksBySource.get(e.source);
      if (list) list.push(e.target);
      else hooksBySource.set(e.source, [e.target]);
    }
  }

  // Files claimed across the run, in priority order. A file already claimed
  // by a higher-priority zone is skipped by lower-priority builders.
  const claimed = new Set<string>();

  // Resolve cwd into both an absolute and `~`-collapsed string so we can match
  // FileEntry.display reliably without needing the runtime $HOME. FileEntry's
  // `display` field already collapses home, so we work in that space.
  const cwdDisplay = absToDisplay(cwd);

  // ----- 1. PROJECT zone (right third) — highest priority. -----
  const projectIds = layoutProjectZone({
    files,
    fileById,
    fileByDisplay,
    importsBySource,
    cwdDisplay,
    viewport,
    positions,
    claimed,
  });
  for (const id of projectIds) zones.set(id, "project");

  // ----- 2. USER zone (left third). -----
  const userIds = layoutUserZone({
    files,
    fileById,
    fileByDisplay,
    importsBySource,
    viewport,
    positions,
    claimed,
  });
  for (const id of userIds) zones.set(id, "user");

  // ----- 3. SETTINGS zone (bottom strip). -----
  const settingsIds = layoutSettingsZone({
    files,
    fileById,
    fileByDisplay,
    hooksBySource,
    viewport,
    positions,
    claimed,
  });
  for (const id of settingsIds) zones.set(id, "settings");

  // ----- 4. ORPHAN zone (bottom-left strip). -----
  const orphanIds = layoutOrphanZone({
    files,
    viewport,
    positions,
    claimed,
  });
  for (const id of orphanIds) zones.set(id, "orphan");

  return { positions, zones };
}

/**
 * USER zone: root = `~/.claude/CLAUDE.md`. Children = its `@-imports` BFS-walk
 * up to depth 5; rules under `~/.claude/rules/` dangle as siblings of root.
 * If the root file is missing the zone is empty (no synthetic placeholder).
 */
function layoutUserZone(args: {
  files: FileEntry[];
  fileById: Map<string, FileEntry>;
  fileByDisplay: Map<string, FileEntry>;
  importsBySource: Map<string, string[]>;
  viewport: Viewport;
  positions: PositionMap;
  claimed: Set<string>;
}): string[] {
  const { files, fileById, fileByDisplay, importsBySource, viewport, positions, claimed } = args;
  const placed: string[] = [];

  const root = fileByDisplay.get("~/.claude/CLAUDE.md");
  if (!root || claimed.has(root.id)) return placed;

  // BFS-walk @-imports, capped at depth 5, skipping files already claimed.
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
      if (claimed.has(t)) continue;
      if (!fileById.has(t)) continue;
      seen.add(t);
      records.push({ id: t, parentId: cur });
      depthById.set(t, curDepth + 1);
      queue.push(t);
    }
  }

  // Rules under `~/.claude/rules/` dangle as siblings of root.
  const dangling: string[] = [];
  for (const f of files) {
    if (f.kind !== "rule") continue;
    if (!f.display.startsWith("~/.claude/rules/")) continue;
    if (seen.has(f.id)) continue;
    if (claimed.has(f.id)) continue;
    dangling.push(f.id);
    seen.add(f.id);
  }

  const SUPER_ROOT = "__user_super_root__";
  type Datum = { id: string; parentId: string | null };
  const data: Datum[] = [{ id: SUPER_ROOT, parentId: null }];
  data.push({ id: root.id, parentId: SUPER_ROOT });
  for (const r of records) {
    if (r.id === root.id) continue;
    data.push({ id: r.id, parentId: r.parentId });
  }
  for (const dId of dangling) {
    data.push({ id: dId, parentId: SUPER_ROOT });
  }

  const zoneXStart = 0;
  const zoneXEnd = viewport.width / 3;
  layoutAndPlace(data, SUPER_ROOT, zoneXStart, zoneXEnd, ZONE_TOP_PADDING_PX, positions);

  for (const d of data) {
    if (d.id === SUPER_ROOT) continue;
    placed.push(d.id);
    claimed.add(d.id);
  }
  return placed;
}

/**
 * PROJECT zone: ancestor CLAUDE.md spine starting from the closest one to the
 * cwd, climbing up. Plus `<cwd>/.claude/rules/*.md` siblings, plus
 * `<cwd>/CLAUDE.local.md` and `<cwd>/.claude/CLAUDE.md` if present. Plus the
 * @-import targets of the root, recursively (capped at depth 5).
 *
 * Returns [] if no ancestor CLAUDE.md exists at all (zone left empty).
 */
function layoutProjectZone(args: {
  files: FileEntry[];
  fileById: Map<string, FileEntry>;
  fileByDisplay: Map<string, FileEntry>;
  importsBySource: Map<string, string[]>;
  cwdDisplay: string | null;
  viewport: Viewport;
  positions: PositionMap;
  claimed: Set<string>;
}): string[] {
  const {
    files,
    fileById,
    fileByDisplay,
    importsBySource,
    cwdDisplay,
    viewport,
    positions,
    claimed,
  } = args;
  const placed: string[] = [];
  if (!cwdDisplay) return placed;

  // Walk up from cwd to ~ collecting ancestor CLAUDE.md spine. The deepest
  // (closest to the cwd) ancestor becomes the visual root; chain rises from
  // there to ~. The user-zone CLAUDE.md (`~/.claude/CLAUDE.md`) is NOT part
  // of this spine — it lives under `.claude/`, not on the directory ancestor
  // path.
  const spine: FileEntry[] = []; // ordered closest-to-cwd → home
  let dir = cwdDisplay;
  while (true) {
    const candidate = fileByDisplay.get(`${dir}/CLAUDE.md`);
    if (candidate && !claimed.has(candidate.id)) spine.push(candidate);
    if (dir === "~" || dir === "" || dir === "/") break;
    const parent = parentDir(dir);
    if (parent === null || parent === dir) break;
    dir = parent;
  }

  // No ancestor CLAUDE.md anywhere on the spine — leave zone empty (corner
  // label still rendered by MapView).
  if (spine.length === 0) return placed;

  // Spine becomes a vertical chain: spine[0] is the visual root at the top of
  // the zone, spine[1] is its child, etc. (closest-to-cwd renders first).
  type NodeRec = { id: string; parentId: string | null };
  const records: NodeRec[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < spine.length; i++) {
    const cur = spine[i];
    const parentId = i === 0 ? null : spine[i - 1].id;
    records.push({ id: cur.id, parentId });
    seen.add(cur.id);
  }
  const rootId = spine[0].id;

  // BFS the @-import graph FROM the spine root and any spine members so the
  // referenced memory/index/etc nodes ride into the project zone with their
  // first-seen parent. Capped at depth 5 to mirror Claude Code limit.
  const depthById = new Map<string, number>();
  for (const s of spine) depthById.set(s.id, 0);
  const queue: string[] = spine.map((s) => s.id);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const curDepth = depthById.get(cur) ?? 0;
    if (curDepth >= USER_TREE_MAX_DEPTH) continue;
    const targets = importsBySource.get(cur);
    if (!targets) continue;
    for (const t of targets) {
      if (seen.has(t)) continue;
      if (claimed.has(t)) continue;
      if (!fileById.has(t)) continue;
      seen.add(t);
      records.push({ id: t, parentId: cur });
      depthById.set(t, curDepth + 1);
      queue.push(t);
    }
  }

  // Project-zone dangling files: `<cwd>/CLAUDE.local.md`, `<cwd>/.claude/CLAUDE.md`,
  // and every `<cwd>/.claude/rules/*.md`. Hang them as siblings of the root.
  const danglingDisplays: string[] = [
    `${cwdDisplay}/CLAUDE.local.md`,
    `${cwdDisplay}/.claude/CLAUDE.md`,
  ];
  for (const f of files) {
    if (f.kind !== "rule") continue;
    if (!f.display.startsWith(`${cwdDisplay}/.claude/rules/`)) continue;
    danglingDisplays.push(f.display);
  }
  const dangling: string[] = [];
  for (const disp of danglingDisplays) {
    const f = fileByDisplay.get(disp);
    if (!f) continue;
    if (seen.has(f.id)) continue;
    if (claimed.has(f.id)) continue;
    dangling.push(f.id);
    seen.add(f.id);
  }

  // Wrap the spine + imports in a synthetic super-root so dangling siblings
  // can attach without changing the spine root's position.
  const SUPER_ROOT = "__project_super_root__";
  type Datum = { id: string; parentId: string | null };
  const data: Datum[] = [{ id: SUPER_ROOT, parentId: null }];
  data.push({ id: rootId, parentId: SUPER_ROOT });
  for (const r of records) {
    if (r.id === rootId) continue;
    data.push({ id: r.id, parentId: r.parentId });
  }
  for (const dId of dangling) {
    data.push({ id: dId, parentId: SUPER_ROOT });
  }

  const zoneXStart = (2 * viewport.width) / 3;
  const zoneXEnd = viewport.width;
  layoutAndPlace(data, SUPER_ROOT, zoneXStart, zoneXEnd, ZONE_TOP_PADDING_PX, positions);

  for (const d of data) {
    if (d.id === SUPER_ROOT) continue;
    placed.push(d.id);
    claimed.add(d.id);
  }
  return placed;
}

/**
 * SETTINGS zone: root = `~/.claude/settings.json`. Children = files reached
 * via hook edges + every settings-controlled kind not already claimed
 * (plugin_manifest, plugin_registry, mcp, script). `settings.local.json` and
 * `~/.claude/.mcp.json` ride in as parallel mini-roots when they exist.
 *
 * Layout: settings root in upper-middle of the zone, children fan downward.
 */
function layoutSettingsZone(args: {
  files: FileEntry[];
  fileById: Map<string, FileEntry>;
  fileByDisplay: Map<string, FileEntry>;
  hooksBySource: Map<string, string[]>;
  viewport: Viewport;
  positions: PositionMap;
  claimed: Set<string>;
}): string[] {
  const { files, fileById, fileByDisplay, hooksBySource, viewport, positions, claimed } = args;
  const placed: string[] = [];

  const settingsRoot = fileByDisplay.get("~/.claude/settings.json");
  const localSettings = fileByDisplay.get("~/.claude/settings.local.json");
  const mcp = fileByDisplay.get("~/.claude/.mcp.json");

  // Nothing to anchor the zone on — bail.
  if (!settingsRoot || claimed.has(settingsRoot.id)) {
    // settings.local.json alone wouldn't make a meaningful zone — it loses
    // its visual context without the main root. Drop it through to orphan
    // by returning empty (claimed stays untouched).
    return placed;
  }

  type Datum = { id: string; parentId: string | null };
  const SUPER_ROOT = "__settings_super_root__";
  const data: Datum[] = [{ id: SUPER_ROOT, parentId: null }];
  const seen = new Set<string>();

  // Mini-roots under the synthetic super-root.
  data.push({ id: settingsRoot.id, parentId: SUPER_ROOT });
  seen.add(settingsRoot.id);
  if (localSettings && !claimed.has(localSettings.id)) {
    data.push({ id: localSettings.id, parentId: SUPER_ROOT });
    seen.add(localSettings.id);
  }
  if (mcp && !claimed.has(mcp.id)) {
    data.push({ id: mcp.id, parentId: SUPER_ROOT });
    seen.add(mcp.id);
  }

  // Hook-edge targets — children of whichever settings root sourced them.
  for (const [src, targets] of hooksBySource.entries()) {
    if (!seen.has(src)) continue; // only follow hooks rooted in our mini-roots
    for (const t of targets) {
      if (seen.has(t)) continue;
      if (claimed.has(t)) continue;
      if (!fileById.has(t)) continue;
      data.push({ id: t, parentId: src });
      seen.add(t);
    }
  }

  // Sweep up settings-adjacent kinds the hook walk didn't reach. Plugins,
  // mcp servers (no edges yet), the registry node, and any leftover scripts
  // hang directly off the settings root so the bottom strip surfaces them.
  const ADJACENT_KINDS = new Set(["plugin_manifest", "plugin_registry", "script"]);
  for (const f of files) {
    if (!ADJACENT_KINDS.has(f.kind)) continue;
    if (seen.has(f.id)) continue;
    if (claimed.has(f.id)) continue;
    data.push({ id: f.id, parentId: settingsRoot.id });
    seen.add(f.id);
  }

  // Bottom strip: y = 2*height/3 .. height; full width 0 .. width. Use the
  // top of the strip for the root row, layout flows downward from there.
  const zoneYStart = (2 * viewport.height) / 3;
  const zoneYEnd = viewport.height;
  const zoneXStart = 0;
  const zoneXEnd = viewport.width;

  // Reuse the generic layout helper but with a custom top offset (relative to
  // canvas origin), and constrain the vertical range to the bottom strip.
  layoutAndPlace(
    data,
    SUPER_ROOT,
    zoneXStart,
    zoneXEnd,
    zoneYStart + SETTINGS_ZONE_TOP_PADDING_PX,
    positions,
    /* maxY */ zoneYEnd - 24,
  );

  for (const d of data) {
    if (d.id === SUPER_ROOT) continue;
    placed.push(d.id);
    claimed.add(d.id);
  }
  return placed;
}

/**
 * ORPHAN zone: bottom-left rectangle. Everything not yet claimed lands here
 * in a simple grid (rows of small circles). No d3 layout — the orphan zone is
 * a "left-overs catch-all", not a tree.
 */
function layoutOrphanZone(args: {
  files: FileEntry[];
  viewport: Viewport;
  positions: PositionMap;
  claimed: Set<string>;
}): string[] {
  const { files, viewport, positions, claimed } = args;
  const placed: string[] = [];

  const xStart = 0 + ZONE_SIDE_PAD_PX;
  const xEnd = viewport.width / 4 - ZONE_SIDE_PAD_PX;
  const yStart = viewport.height - ORPHAN_TOP_OFFSET_PX;
  const yEnd = viewport.height - ORPHAN_BOTTOM_OFFSET_PX;
  const cols = Math.max(1, Math.floor((xEnd - xStart) / ORPHAN_GRID_GAP_X) + 1);

  let i = 0;
  for (const f of files) {
    if (claimed.has(f.id)) continue;
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = xStart + col * ORPHAN_GRID_GAP_X;
    const y = yStart + row * ORPHAN_GRID_GAP_Y;
    // Cap inside the strip — once we run out of vertical space, files start
    // to stack on the last row (still visible, still clickable).
    const yClamped = Math.min(y, yEnd);
    positions.set(f.id, { x, y: yClamped });
    claimed.add(f.id);
    placed.push(f.id);
    i++;
  }
  return placed;
}

/**
 * Run d3.tree on a flat parent-pointer table, then transform the layout to fit
 * the given horizontal zone bounds with `topY` as the top of the FIRST visible
 * row. Skips the synthetic super-root; everything else lands in `positions`.
 *
 * @param maxY  optional vertical clamp for the deepest row; if omitted, the
 *              tree extends as far down as d3 lays it out.
 */
function layoutAndPlace<T extends { id: string; parentId: string | null }>(
  data: T[],
  superRootId: string,
  zoneXStart: number,
  zoneXEnd: number,
  topY: number,
  positions: PositionMap,
  maxY?: number,
): void {
  const root0 = stratify(data);
  if (!root0) return;
  const layout = tree<T>().nodeSize([TREE_NODE_X_GAP, TREE_NODE_Y_GAP]);
  const laid = layout(root0);

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY0 = -Infinity;
  laid.each((n) => {
    if (n.x < minX) minX = n.x;
    if (n.x > maxX) maxX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.y > maxY0) maxY0 = n.y;
  });

  const zoneCenterX = (zoneXStart + zoneXEnd) / 2;
  const laidWidth = Math.max(1, maxX - minX);
  const zoneWidth = Math.max(1, zoneXEnd - zoneXStart - 2 * ZONE_SIDE_PAD_PX);
  const xScale = laidWidth > zoneWidth ? zoneWidth / laidWidth : 1;

  // Vertical scaling: only kicks in if a hard ceiling was provided AND the
  // laid-out tree would overflow it. Settings zone needs this because the
  // bottom strip is ~1/3 of the canvas and a wide fan-out otherwise spills
  // into the orphan zone.
  const laidHeight = Math.max(1, maxY0 - minY);
  const availableHeight = maxY !== undefined ? Math.max(1, maxY - topY) : Infinity;
  const yScale = laidHeight > availableHeight ? availableHeight / laidHeight : 1;

  laid.each((n) => {
    const id = n.data.id;
    if (id === superRootId) return;
    const x = zoneCenterX + (n.x - (minX + maxX) / 2) * xScale;
    // Shallowest visible row lands at topY exactly; deepest at
    // topY + laidHeight * yScale.
    const y = topY + (n.y - minY) * yScale;
    positions.set(id, { x, y });
  });
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

/**
 * Convert an absolute path (or null) to its `~`-collapsed form. We can't read
 * $HOME from the browser; but FileEntry.display already collapses it to `~`.
 * The cwd selector hands us absolute paths from `/api/cwds`, so we mirror the
 * collapse here: the longest `~/...` display we can reuse is anchored at the
 * cwd's basename match against any FileEntry display.
 *
 * Strategy: home prefix is always `/home/<user>/` on linux. Detect a `/home/`
 * prefix and strip the second segment to build `~/...`. If the cwd is `~/...`
 * already (shouldn't happen, but safe) we pass it through.
 */
function absToDisplay(abs: string | null): string | null {
  if (abs === null) return null;
  if (abs.startsWith("~/")) return abs;
  if (abs === "~") return "~";
  // Collapse `/home/<user>` → `~`, and `/home/<user>/x/y` → `~/x/y`.
  const m = abs.match(/^\/home\/[^/]+(\/.*)?$/);
  if (m) {
    const tail = m[1] ?? "";
    return tail === "" ? "~" : `~${tail}`;
  }
  // Outside /home — return as-is; project zone matching will simply miss.
  return abs;
}

/**
 * Return the parent of a `~`-rooted display path. `~/observatory` → `~`,
 * `~` → null.
 */
function parentDir(display: string): string | null {
  if (display === "~") return null;
  const idx = display.lastIndexOf("/");
  if (idx < 0) return null;
  if (idx === 0) return "/";
  const head = display.slice(0, idx);
  return head === "" ? "/" : head;
}
