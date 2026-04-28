// Inline lucide icon paths (https://lucide.dev) used as Cytoscape node
// background-image data URLs. Avoids pulling lucide-react at runtime.
//
// Stroke colour and width are baked in — we want a slightly thinner stroke
// than lucide's default 2 so the icon stays crisp at ~15px effective size.

import type { FileKind } from "../types";

const STROKE = "#e8e4d8"; // --paper
const STROKE_WIDTH = 1.6;

// Standard Lucide viewBox 0 0 24 24. Optional per-icon `translate(0 dy)`
// shifts the glyph vertically inside the viewBox to compensate for asymmetric
// visual mass — Lucide's plug has two long prongs at top and a single short
// cable at bottom, so the geometric centre at y=12 sits visibly above the
// visual mass centre. Plug needs a +2 nudge down; lock (heavy body, light
// shackle) needs a -3 nudge up. Symmetric glyphs (gear, scroll) need none.
function dataUrl(inner: string, dy: number = 0): string {
  const content = dy === 0 ? inner : `<g transform="translate(0 ${dy})">${inner}</g>`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ` +
    `stroke="${STROKE}" stroke-width="${STROKE_WIDTH}" stroke-linecap="round" ` +
    `stroke-linejoin="round">${content}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const SCROLL = `<path d="M19 17V5a2 2 0 0 0-2-2H4"/><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"/>`;
const PLUG = `<path d="M12 22v-5"/><path d="M15 8V2"/><path d="M17 8a1 1 0 0 1 1 1v4a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1z"/><path d="M9 8V2"/>`;
const SETTINGS = `<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/>`;
const LOCK = `<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>`;

export const ICON_BY_KIND: Partial<Record<FileKind, string>> = {
  skill:           dataUrl(SCROLL),
  plugin_manifest: dataUrl(PLUG, 2),
  plugin_registry: dataUrl(PLUG, 2),
  mcp:             dataUrl(PLUG, 2),
  settings:        dataUrl(SETTINGS),
  automemory:      dataUrl(LOCK, -3),
};

export function isIconKind(k: FileKind): boolean {
  return k in ICON_BY_KIND;
}
