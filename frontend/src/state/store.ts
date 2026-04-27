import { create } from "zustand";
import type { Edge, FileEntry } from "../types";

interface Store {
  files: FileEntry[];
  edges: Edge[];
  setIndex: (files: FileEntry[], edges: Edge[]) => void;
  selectedId: string | null;
  select: (id: string | null) => void;
}

export const useStore = create<Store>((set) => ({
  files: [],
  edges: [],
  setIndex: (files, edges) => set({ files, edges }),
  selectedId: null,
  select: (id) => set({ selectedId: id }),
}));
