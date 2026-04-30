/**
 * CrossCwdPanel — files Claude also reads when working in the active cwd that
 * physically live OUTSIDE the cwd.
 *
 * Includes: OS-managed CLAUDE.md, ~/.claude/CLAUDE.md, ancestor walk hits
 * (CLAUDE.md / CLAUDE.local.md from parent dirs up to home), and user-global
 * rules without paths: frontmatter.
 *
 * Rendered ABOVE the tree in the ExplorerPane, separated by a distinct
 * background + header label + bottom divider.
 *
 * Each file row:
 *   [priority badge] [collapsed path] [? icon with tooltip]
 *
 * Priority badge: ordinal text ("1st"/"2nd"...) with amber brightness
 * gradient matching the in-tree badges (same priorityBadgeStyle function).
 * Tooltip on badge: slot name plain text.
 * Tooltip on ?: plain-language explanation of WHY this file is loaded here.
 */

import type { FileEntry, TimelineStep } from "../types";
import { collapseToHome } from "./explorerTree";

// ---- Priority badge --------------------------------------------------------

const PRIORITY_LABELS: Record<number, string> = {
  1: "1st",
  2: "2nd",
  3: "3rd",
  4: "4th",
  5: "5th",
  6: "6th",
};

const PRIORITY_TOOLTIPS: Record<number, string> = {
  1: "Managed — organisation-wide policy enforced by IT/DevOps. Cannot be excluded.",
  2: "User-global — your personal preferences across all projects (~/.claude/CLAUDE.md and rules).",
  3: "Ancestor-walk — CLAUDE.md or CLAUDE.local.md found by walking up the directory tree to home.",
  4: "Project — CLAUDE.md and rules inside the active project folder.",
  5: "Auto-memory — notes Claude wrote from past corrections (MEMORY.md first 200 lines).",
  6: "On-demand — loaded only when a matching file path is opened (paths: frontmatter rules).",
};

// Plain-language WHY explanation per matched_on value.
function whyTooltip(step: TimelineStep): string {
  const mo = step.matched_on ?? "";
  if (mo === "managed") {
    return "Loaded from the system-wide policy folder. This file applies to every user on this machine and cannot be excluded.";
  }
  if (mo === "user-global") {
    return "Loaded from your home ~/.claude/ directory as a personal preference for all projects.";
  }
  if (mo === "no-paths") {
    return "This rule has no paths: filter, so it loads at session start alongside your main CLAUDE.md.";
  }
  if (mo === "ancestor-walk") {
    return "Found by walking up the directory tree from the active project toward your home folder. Every parent directory is checked.";
  }
  if (mo === "add-dir") {
    return "Loaded from an extra directory specified with --add-dir or CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD.";
  }
  if (mo === "automemory") {
    return "Auto-memory notes Claude accumulated from past sessions in this project.";
  }
  if (mo === "project-team") {
    return "The project's shared .claude/CLAUDE.md — loaded for every developer working in this folder.";
  }
  if (mo.includes("*") || mo.includes("/")) {
    return `Loaded because its paths: pattern matched a file you opened (pattern: ${mo}).`;
  }
  return "Loaded as part of Claude's session context for this folder.";
}

// CSS for the badge colour (same formula as ExplorerPane.tsx).
function priorityBadgeStyle(priority: number): React.CSSProperties {
  const step = Math.min(Math.max(priority - 1, 0), 5);
  const amberPct = 100 - step * 15;
  const color = `color-mix(in srgb, var(--amber) ${amberPct}%, var(--paper-faint) ${Math.max(100 - amberPct, 0)}%)`;
  const borderColor = `color-mix(in srgb, var(--amber) ${Math.max(amberPct - 30, 10)}%, var(--line) ${100 - Math.max(amberPct - 30, 10)}%)`;
  return { color, borderColor };
}

// ---- Component -------------------------------------------------------------

interface CrossCwdFile {
  step: TimelineStep;
  file: FileEntry | undefined;
  priority: number;
  displayPath: string;
}

interface Props {
  steps: TimelineStep[];
  files: FileEntry[];
  activeCwd: string;
  home: string;
  onSelect?: (fileId: string) => void;
}

// Expand "~/foo" → "/home/user/foo" using the derived home path.
function expandHome(p: string, home: string): string {
  if (home && p === "~") return home;
  if (home && p.startsWith("~/")) return home + p.slice(1);
  return p;
}

export function CrossCwdPanel({ steps, files, activeCwd, home, onSelect }: Props) {
  const fileMap = new Map<string, FileEntry>();
  for (const f of files) fileMap.set(f.id, f);
  const filesByPath = new Map<string, FileEntry>();
  for (const f of files) filesByPath.set(f.path, f);

  // Filter to steps whose file_path is NOT under activeCwd.
  // The API returns paths with "~/" prefix — expand before comparing.
  const crossSteps = steps.filter((s) => {
    if (!s.file_path) return false;
    const abs = expandHome(s.file_path, home);
    if (abs === activeCwd) return false;
    if (abs.startsWith(activeCwd + "/")) return false;
    // Only include loaded/conditional steps — skipped items are irrelevant here.
    if (s.status === "skipped") return false;
    return true;
  });

  if (crossSteps.length === 0) return null;

  const items: CrossCwdFile[] = crossSteps.map((step) => {
    const absPath = expandHome(step.file_path, home);
    const file = step.file_id
      ? fileMap.get(step.file_id)
      : (filesByPath.get(absPath) ?? filesByPath.get(step.file_path));
    return {
      step,
      file,
      priority: step.priority ?? 6,
      displayPath: collapseToHome(absPath, home),
    };
  });

  // Sort by priority ascending, then by path for stable order.
  items.sort((a, b) => a.priority !== b.priority ? a.priority - b.priority : a.displayPath.localeCompare(b.displayPath));

  return (
    <div className="cross-cwd-panel">
      <div className="cross-cwd-header">
        <span className="cross-cwd-header-label">Also loaded for this folder</span>
        <span className="cross-cwd-header-count">{items.length}</span>
      </div>
      <ul className="cross-cwd-list" role="list">
        {items.map((item) => (
          <CrossCwdRow
            key={item.step.file_path}
            item={item}
            onSelect={onSelect}
          />
        ))}
      </ul>
      <div className="cross-cwd-divider" aria-hidden />
    </div>
  );
}

// ---- Row -------------------------------------------------------------------

function CrossCwdRow({
  item,
  onSelect,
}: {
  item: CrossCwdFile;
  onSelect?: (fileId: string) => void;
}) {
  const label = PRIORITY_LABELS[item.priority];
  const badgeTitle = PRIORITY_TOOLTIPS[item.priority] ?? "";
  const why = whyTooltip(item.step);
  const badgeStyle = priorityBadgeStyle(item.priority);

  function handleClick() {
    if (item.file && onSelect) onSelect(item.file.id);
  }

  return (
    <li
      className="cross-cwd-row"
      onClick={handleClick}
      role={item.file ? "button" : undefined}
      tabIndex={item.file ? 0 : undefined}
      onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && item.file) handleClick(); }}
      title={item.file ? undefined : item.step.file_path}
    >
      {label && (
        <span
          className="cross-cwd-badge"
          style={badgeStyle}
          title={badgeTitle}
        >
          {label}
        </span>
      )}
      <span className="cross-cwd-path">{item.displayPath}</span>
      <span className="cross-cwd-why-icon" title={why} aria-label={why}>
        ?
      </span>
    </li>
  );
}
