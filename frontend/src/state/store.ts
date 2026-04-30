import { create } from "zustand";
import { postState } from "../api/client";
import type { Edge, FileEntry, UiState, ViewKey } from "../types";

// --- Phase 2 write pipeline shapes ----------------------------------------

// One patch in a multi-file write. `title` is the operation-level title shown
// in the diff modal header (only the first patch's title wins; siblings hold
// their own filename in the per-file `.diff-head`).
export interface WritePatch {
  path: string;
  newContent: string;
  title?: string;
}

// Live write intent that drives the global DiffModal / PreviewChip. Set via
// useWritePipeline.requestWrite, cleared on resolve/cancel. The hook holds
// the resolver so the component can call back when the user confirms or
// cancels.
export interface WriteIntent {
  patches: WritePatch[];
  softConfirm: boolean;
  // Called when the user confirms (Apply) or auto-applies (chip timer).
  onConfirm: () => void;
  // Called when the user cancels (Esc / Cancel button / veil click).
  onCancel: () => void;
}

export type ToastKind = "success" | "error" | "info";

export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
  // Optional undo action for delete toasts.
  undoSnapshotId?: string;
  undoPath?: string;
  undoLabel?: string;
  // Auto-dismiss delay in ms. Defaults to 2500ms; delete toasts use 10000ms.
  ttl?: number;
}

export const EXPLORER_WIDTH_DEFAULT = 320;
export const EXPLORER_WIDTH_MIN = 240;
export const EXPLORER_WIDTH_MAX = 480;

interface Store {
  files: FileEntry[];
  edges: Edge[];
  setIndex: (files: FileEntry[], edges: Edge[]) => void;

  // Bumped after every successful write so MapView and App re-fetch
  // /api/simulate + /api/index and priority badges update live.
  dataVersion: number;
  bumpDataVersion: () => void;

  // Phase 4 — file explorer tree expanded state.
  // Set of folder/group node ids that are expanded. Persisted via /api/state
  // (tree_expanded: string[]). Initialised from hydrated UiState on boot;
  // falls back to DEFAULT_OPEN_GROUPS (user-config + projects) when empty.
  treeExpanded: Set<string>;
  setTreeExpanded: (ids: Set<string>) => void;

  // Phase 4 — explorer column width in px (resize divider). Persisted via
  // /api/state (tree_width). Backend agent adds the field; absent payloads
  // fall back to EXPLORER_WIDTH_DEFAULT. Clamped to [240, 480].
  explorerWidth: number;
  setExplorerWidth: (w: number) => void;

  // Currently-inspected file id. Decoupled from `inspectorOpen`: clicking ×
  // hides the pane but keeps the last selection so re-opening restores
  // context. Updated by GraphCanvas tap and by inspector reference rows.
  selectedId: string | null;
  select: (id: string | null) => void;

  // Slide-in Inspector pane visibility. Auto-opens on first selection;
  // explicit toggle via the × button or `setInspectorOpen(false)`.
  inspectorOpen: boolean;
  setInspectorOpen: (open: boolean) => void;

  // Editor side panel (left slide-in). Path of the file currently open in
  // the editor; null when no file is open. `editorOpen` controls visibility.
  editorPath: string | null;
  editorOpen: boolean;
  setEditorOpen: (path: string | null, open: boolean) => void;

  view: ViewKey;
  setView: (v: ViewKey) => void;

  pins: Record<string, { x: number; y: number }>;
  setPin: (id: string, pos: { x: number; y: number }) => void;
  clearPin: (id: string) => void;

  lastCwd: string | null;
  setLastCwd: (cwd: string | null) => void;

  showInternal: boolean;
  setShowInternal: (v: boolean) => void;

  legendOpen: boolean;
  setLegendOpen: (open: boolean) => void;

  hydrate: (s: UiState) => void;

  // --- Phase 2 write pipeline (NOT persisted to /api/state) ----------------
  writeIntent: WriteIntent | null;
  setWriteIntent: (i: WriteIntent | null) => void;

  toasts: Toast[];
  pushToast: (t: Omit<Toast, "id">) => void;
  dismissToast: (id: string) => void;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function snapshot(s: Store): UiState {
  return {
    pins: s.pins,
    last_cwd: s.lastCwd,
    last_view: s.view,
    show_internal: s.showInternal,
    inspector_open: s.inspectorOpen,
    editor_open: s.editorOpen,
    tree_expanded: [...s.treeExpanded],
    tree_width: s.explorerWidth,
    legend_open: s.legendOpen,
  };
}

const DEFAULT_TREE_EXPANDED = new Set(["user-config", "projects"]);

function schedulePersist(getState: () => Store) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    postState(snapshot(getState())).catch((e) => {
      console.warn("[observatory] state persist failed", e);
    });
  }, 300);
}

export const useStore = create<Store>((set, get) => ({
  files: [],
  edges: [],
  setIndex: (files, edges) => set({ files, edges }),

  dataVersion: 0,
  bumpDataVersion: () => set((s) => ({ dataVersion: s.dataVersion + 1 })),

  treeExpanded: DEFAULT_TREE_EXPANDED,
  setTreeExpanded: (ids) => {
    set({ treeExpanded: ids });
    schedulePersist(get);
  },

  explorerWidth: EXPLORER_WIDTH_DEFAULT,
  setExplorerWidth: (w) => {
    const clamped = Math.max(EXPLORER_WIDTH_MIN, Math.min(EXPLORER_WIDTH_MAX, w));
    set({ explorerWidth: clamped });
    schedulePersist(get);
  },

  selectedId: null,
  // Selecting a node auto-opens the Inspector if it's currently closed —
  // first click in a session should reveal the pane; subsequent clicks
  // (with the pane already open) just swap content. Clearing selection
  // (id == null) leaves the pane state alone — the close button is the
  // only thing that hides it (locked rule #24: selection sync stays
  // independent of pane visibility).
  select: (id) => {
    const wasOpen = get().inspectorOpen;
    set({ selectedId: id });
    if (id && !wasOpen) {
      set({ inspectorOpen: true });
      schedulePersist(get);
    }
  },

  inspectorOpen: false,
  setInspectorOpen: (open) => {
    set({ inspectorOpen: open });
    schedulePersist(get);
  },

  editorPath: null,
  editorOpen: false,
  setEditorOpen: (path, open) => {
    set({ editorPath: path, editorOpen: open });
    schedulePersist(get);
  },

  view: "map",
  setView: (v) => {
    set({ view: v });
    schedulePersist(get);
  },

  pins: {},
  setPin: (id, pos) => {
    set((s) => ({ pins: { ...s.pins, [id]: pos } }));
    schedulePersist(get);
  },
  clearPin: (id) => {
    set((s) => {
      const next = { ...s.pins };
      delete next[id];
      return { pins: next };
    });
    schedulePersist(get);
  },

  lastCwd: null,
  setLastCwd: (cwd) => {
    set({ lastCwd: cwd });
    schedulePersist(get);
  },

  showInternal: false,
  setShowInternal: (v) => {
    set({ showInternal: v });
    schedulePersist(get);
  },

  legendOpen: false,
  setLegendOpen: (open) => {
    set({ legendOpen: open });
    schedulePersist(get);
  },

  hydrate: (s) => {
    const expanded = s.tree_expanded && s.tree_expanded.length > 0
      ? new Set<string>(s.tree_expanded)
      : DEFAULT_TREE_EXPANDED;
    const rawWidth = s.tree_width ?? EXPLORER_WIDTH_DEFAULT;
    const explorerWidth = Math.max(EXPLORER_WIDTH_MIN, Math.min(EXPLORER_WIDTH_MAX, rawWidth));
    // Gracefully handle old .state.json with last_view: "sim" — fall back to map.
    const rawView = s.last_view ?? "map";
    const view: ViewKey = (rawView === "map" || rawView === "ed" || rawView === "ext") ? rawView : "map";
    set({
      pins: s.pins ?? {},
      lastCwd: s.last_cwd ?? null,
      view,
      showInternal: s.show_internal ?? false,
      inspectorOpen: s.inspector_open ?? false,
      editorOpen: s.editor_open ?? false,
      treeExpanded: expanded,
      explorerWidth,
      legendOpen: s.legend_open ?? false,
    });
  },

  writeIntent: null,
  setWriteIntent: (i) => set({ writeIntent: i }),

  toasts: [],
  pushToast: (t) =>
    set((s) => ({
      toasts: [
        ...s.toasts,
        { ...t, id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}` },
      ],
    })),
  dismissToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));
