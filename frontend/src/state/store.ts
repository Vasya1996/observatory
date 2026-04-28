import { create } from "zustand";
import { postState } from "../api/client";
import type { Edge, FileEntry, UiState, ViewKey } from "../types";

interface Store {
  files: FileEntry[];
  edges: Edge[];
  setIndex: (files: FileEntry[], edges: Edge[]) => void;

  selectedId: string | null;
  select: (id: string | null) => void;

  view: ViewKey;
  setView: (v: ViewKey) => void;

  pins: Record<string, { x: number; y: number }>;
  setPin: (id: string, pos: { x: number; y: number }) => void;
  clearPin: (id: string) => void;

  lastCwd: string | null;
  setLastCwd: (cwd: string | null) => void;

  showInternal: boolean;
  setShowInternal: (v: boolean) => void;

  hydrate: (s: UiState) => void;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function snapshot(s: Store): UiState {
  return {
    pins: s.pins,
    last_cwd: s.lastCwd,
    last_view: s.view,
    show_internal: s.showInternal,
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
  select: (id) => set({ selectedId: id }),

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

  hydrate: (s) =>
    set({
      pins: s.pins ?? {},
      lastCwd: s.last_cwd ?? null,
      view: (s.last_view ?? "map") as ViewKey,
      showInternal: s.show_internal ?? false,
    }),
}));
