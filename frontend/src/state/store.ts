import { create } from "zustand";
import { postState } from "../api/client";
import type { Edge, FileEntry, MapMode, UiState, ViewKey } from "../types";

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
}

interface Store {
  files: FileEntry[];
  edges: Edge[];
  setIndex: (files: FileEntry[], edges: Edge[]) => void;

  // Currently-inspected file id. Decoupled from `inspectorOpen`: clicking ×
  // hides the pane but keeps the last selection so re-opening restores
  // context. Updated by GraphCanvas tap and by inspector reference rows.
  selectedId: string | null;
  select: (id: string | null) => void;

  // Slide-in Inspector pane visibility. Auto-opens on first selection;
  // explicit toggle via the × button or `setInspectorOpen(false)`.
  inspectorOpen: boolean;
  setInspectorOpen: (open: boolean) => void;

  view: ViewKey;
  setView: (v: ViewKey) => void;

  pins: Record<string, { x: number; y: number }>;
  setPin: (id: string, pos: { x: number; y: number }) => void;
  clearPin: (id: string) => void;

  lastCwd: string | null;
  setLastCwd: (cwd: string | null) => void;

  showInternal: boolean;
  setShowInternal: (v: boolean) => void;

  mapMode: MapMode;
  setMapMode: (v: MapMode) => void;

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
    map_mode: s.mapMode,
    inspector_open: s.inspectorOpen,
  };
}

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

  mapMode: "graph",
  setMapMode: (v) => {
    set({ mapMode: v });
    schedulePersist(get);
  },

  hydrate: (s) =>
    set({
      pins: s.pins ?? {},
      lastCwd: s.last_cwd ?? null,
      view: (s.last_view ?? "map") as ViewKey,
      showInternal: s.show_internal ?? false,
      mapMode: s.map_mode ?? "graph",
      inspectorOpen: s.inspector_open ?? false,
    }),

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
