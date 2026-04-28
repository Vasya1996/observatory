// Inline lucide icon paths (https://lucide.dev). Rendered as DOM SVG by
// IconOverlay, anchored to each icon-kind node's renderedPosition. The
// previous data-URL-on-cytoscape-background pipeline is gone — see
// IconOverlay.tsx for the rationale.

import type { FileKind } from "../types";

export const ICON_STROKE = "#e8e4d8"; // --paper
export const ICON_STROKE_WIDTH = 1.6;

const SCROLL = `<path d="M19 17V5a2 2 0 0 0-2-2H4"/><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"/>`;
const PLUG = `<path d="M12 22v-5"/><path d="M15 8V2"/><path d="M17 8a1 1 0 0 1 1 1v4a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1z"/><path d="M9 8V2"/>`;
const SETTINGS = `<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/>`;
// Lock's shackle is `M7 11V7 a5 5 0 0 1 10 0 v4` — the arc has chord (7,7)–(17,7)
// with rx=ry=5, so the centre is (12,7) and the top of the arc reaches y=2.
// Ink BBox is therefore y=2..22, centroid (12, 12) — same as the other three
// icons. The earlier "centroid (12, 14.5)" reading missed the arc and led to
// a viewBox shift `0 2.5 24 24` that itself moved the icon off-centre.
const LOCK = `<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>`;
// Lucide `code-xml` (rebrand of code2): the `</>` glyph for shell/python/etc
// scripts referenced from a hook command. Centroid (12, 12) by construction.
const CODE = `<path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/>`;

export const ICON_PATH_BY_KIND: Partial<Record<FileKind, string>> = {
  skill: SCROLL,
  plugin_manifest: PLUG,
  plugin_registry: PLUG,
  mcp: PLUG,
  settings: SETTINGS,
  automemory: LOCK,
  script: CODE,
};

export function isIconKind(k: FileKind): boolean {
  return k in ICON_PATH_BY_KIND;
}
