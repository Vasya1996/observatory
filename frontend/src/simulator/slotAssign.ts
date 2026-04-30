// Slot assignment for the Simulator view.
//
// The Simulator shows 6 vertical columns in canonical Claude Code load order.
// This module bins each file from the simulate response into the right column
// using path heuristics. When the backend adds is_canonical, that field can
// gate the non-canonical overlay; for now all files are treated as canonical.
//
// Heuristic priority (first match wins):
//   1. Managed   — OS-level policy file.
//   2. User      — ~/.claude/CLAUDE.md or always-loaded ~/.claude/rules files.
//   3. Ancestor  — CLAUDE.md / CLAUDE.local.md on ancestor walk chain.
//   4. Project   — <cwd>/.claude/CLAUDE.md or <cwd>/.claude/rules files.
//   5. Auto-mem  — files under the projects auto-memory directory.
//   6. On-demand — everything else, including mention-reachable BFS results.

import type { FileEntry, Edge, TimelineStep } from "../types";

export type SlotKey =
  | "managed"
  | "user"
  | "ancestor"
  | "project"
  | "automemory"
  | "ondemand";

export const SLOT_ORDER: SlotKey[] = [
  "managed",
  "user",
  "ancestor",
  "project",
  "automemory",
  "ondemand",
];

export const SLOT_LABELS: Record<SlotKey, string> = {
  managed: "Managed",
  user: "User-global",
  ancestor: "Ancestor-walk",
  project: "Project",
  automemory: "Auto-memory",
  ondemand: "On-demand",
};

// Short descriptions shown under each slot header — written for beginners.
export const SLOT_DESCRIPTIONS: Record<SlotKey, string> = {
  managed: "Organisation-wide rules set by IT/DevOps. Cannot be overridden.",
  user:    "Your personal rules that apply to every project on this machine.",
  ancestor: "CLAUDE.md and CLAUDE.local.md files found in parent folders, loaded top-down.",
  project:  "Rules checked into the current project and shared with your team.",
  automemory: "Notes Claude writes itself based on your corrections (per folder, first 200 lines).",
  ondemand:   "Files Claude can read when it opens matching files — not loaded at the start of every session.",
};

// OS-managed policy paths. Compare against path strings only — no platform
// detection. Linux / macOS / Windows covered.
const MANAGED_PATHS = new Set([
  "/etc/claude-code/CLAUDE.md",
  "/Library/Application Support/ClaudeCode/CLAUDE.md",
  "C:\\Program Files\\ClaudeCode\\CLAUDE.md",
]);

export interface SlottedFile {
  file: FileEntry;
  step: TimelineStep | undefined;
  slot: SlotKey;
}

export type SlotMap = Record<SlotKey, SlottedFile[]>;

// Derive the home directory from the files array by finding any file whose
// display starts with "~/" and extracting the real prefix from its path.
// Falls back to "/home" if no such file is found (graceful degrade only —
// in practice the user-global CLAUDE.md is always present).
function deriveHome(files: FileEntry[]): string {
  for (const f of files) {
    if (f.display.startsWith("~/") && f.path.length > 2) {
      // path = "/home/alice/.claude/CLAUDE.md", display = "~/.claude/CLAUDE.md"
      // home = path.slice(0, path.length - display.length + 1)
      const suffix = f.display.slice(1); // "/.claude/CLAUDE.md"
      if (f.path.endsWith(suffix)) {
        return f.path.slice(0, f.path.length - suffix.length);
      }
    }
  }
  // Fallback: scan for any file under a plausible home dir pattern.
  for (const f of files) {
    const m = /^(\/home\/[^/]+)\/.+/.exec(f.path);
    if (m) return m[1];
  }
  return "/home";
}

function assignSlot(file: FileEntry, cwd: string | null, home: string): SlotKey {
  const p = file.path;

  // 1. Managed
  if (MANAGED_PATHS.has(p)) return "managed";

  const dotClaude = home + "/.claude";

  // 2. User-global
  if (
    p === dotClaude + "/CLAUDE.md" ||
    p === dotClaude + "/" + "CLAUDE.md" ||
    p.startsWith(dotClaude + "/rules/")
  ) {
    // Paths-scoped rules that have paths_globs are conditional (not always
    // user-global), but they still load from the user zone — keep them here.
    return "user";
  }

  // 5. Auto-memory (check before ancestor/project to catch ~/.claude/projects/…)
  if (p.startsWith(dotClaude + "/projects/") && p.includes("/memory/")) {
    return "automemory";
  }

  // 4. Project — needs cwd
  if (cwd) {
    const cwdDotClaude = cwd + "/.claude";
    if (
      p === cwdDotClaude + "/CLAUDE.md" ||
      p.startsWith(cwdDotClaude + "/rules/")
    ) {
      return "project";
    }
  }

  // 3. Ancestor — any CLAUDE.md / CLAUDE.local.md NOT at the user dotclaude
  //    level AND NOT in a dotclaude subdir (those belong to project or user).
  //    Heuristic: path ends with /CLAUDE.md or /CLAUDE.local.md and lives
  //    under home but outside ~/.claude/.
  const filename = p.split("/").pop() ?? "";
  if (
    (filename === "CLAUDE.md" || filename === "CLAUDE.local.md") &&
    p.startsWith(home + "/") &&
    !p.startsWith(dotClaude + "/")
  ) {
    return "ancestor";
  }

  // 6. On-demand — fallthrough
  return "ondemand";
}

/**
 * Build the slot map from a simulate response plus the full file index.
 * Also accepts on-demand reachable file ids computed via mention-BFS.
 */
export function buildSlotMap(
  steps: TimelineStep[],
  allFiles: FileEntry[],
  edges: Edge[],
  cwd: string | null,
): SlotMap {
  const home = deriveHome(allFiles);

  // Index files by id for fast lookup.
  const fileById = new Map<string, FileEntry>();
  for (const f of allFiles) {
    fileById.set(f.id, f);
  }

  // Step lookup by file_id.
  const stepByFileId = new Map<string, TimelineStep>();
  for (const s of steps) {
    if (s.file_id) stepByFileId.set(s.file_id, s);
  }

  // Collect ids that appear in the simulate response (loaded / conditional /
  // skipped — these are the files Claude actually considered).
  const simulatedIds = new Set<string>(
    steps.filter((s) => s.file_id).map((s) => s.file_id as string),
  );

  // On-demand reachable: BFS from loaded files via `kind === "mention"` edges.
  // This augments the "ondemand" slot with files reachable at read-time even
  // though they are not in the simulator's steps list (which only covers the
  // load-order chain, not mention-graph reachability).
  const onDemandIds = collectOnDemandIds(steps, edges, simulatedIds);

  // Build slot map.
  const result: SlotMap = {
    managed: [],
    user: [],
    ancestor: [],
    project: [],
    automemory: [],
    ondemand: [],
  };

  // First pass: assign files from the simulate timeline (slots 1-5 priority).
  // Track which ids land in a named slot so BFS-only entries don't duplicate.
  const assignedInNamedSlot = new Set<string>();

  for (const id of simulatedIds) {
    const file = fileById.get(id);
    if (!file) continue;
    const step = stepByFileId.get(id);
    const slot = assignSlot(file, cwd, home);
    result[slot].push({ file, step, slot });
    if (slot !== "ondemand") assignedInNamedSlot.add(id);
  }

  // Second pass: on-demand BFS results only if not already in a named slot.
  for (const id of onDemandIds) {
    if (assignedInNamedSlot.has(id)) continue;
    const file = fileById.get(id);
    if (!file) continue;
    result.ondemand.push({ file, step: undefined, slot: "ondemand" });
  }

  // Sort each slot: steps first (in idx order), then mention-only (no step).
  for (const key of SLOT_ORDER) {
    result[key].sort((a, b) => {
      const ai = a.step?.idx ?? Infinity;
      const bi = b.step?.idx ?? Infinity;
      return ai - bi;
    });
  }

  return result;
}

/**
 * BFS over mention edges from loaded files to find on-demand-reachable ids.
 * Returns ids that are reachable but not already in `simulatedIds`.
 */
function collectOnDemandIds(
  steps: TimelineStep[],
  edges: Edge[],
  simulatedIds: Set<string>,
): Set<string> {
  // Adjacency list: source file_id → target file_ids reachable via mention.
  const mentionTargets = new Map<string, string[]>();
  for (const e of edges) {
    if (e.kind !== "mention") continue;
    if (!mentionTargets.has(e.source)) mentionTargets.set(e.source, []);
    mentionTargets.get(e.source)!.push(e.target);
  }

  const loadedIds = new Set<string>(
    steps
      .filter((s) => s.status === "loaded" && s.file_id)
      .map((s) => s.file_id as string),
  );

  const visited = new Set<string>(simulatedIds);
  const queue = Array.from(loadedIds);
  const result = new Set<string>();

  while (queue.length > 0) {
    const cur = queue.shift()!;
    const targets = mentionTargets.get(cur) ?? [];
    for (const t of targets) {
      if (visited.has(t)) continue;
      visited.add(t);
      result.add(t);
      queue.push(t);
    }
  }

  return result;
}
