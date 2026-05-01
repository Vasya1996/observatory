/**
 * CrossCwdPanel — files Claude also reads when working in the active cwd that
 * physically live OUTSIDE the cwd.
 *
 * Each file row (categories: claude_md, rules, import):
 *   [priority badge] [collapsed path] [? icon] [ON/OFF toggle]
 *
 * auto_memory category rows do NOT get a per-row toggle.
 *
 * Toggle ON->OFF shows LoadedFileDisableModal. Toggle OFF->ON is direct.
 *
 * "Disabled for this folder" collapsible subsection at the bottom loads
 * from /api/disabled-files.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import { fetchDisabledFiles, postToggleLoadedFile, ApiError } from "../api/client";
import type {
  DisabledFileEntry,
  DisabledFilesResponse,
  FileEntry,
  TimelineStep,
} from "../types";
import { collapseToHome } from "./explorerTree";
import { LoadedFileDisableModal } from "./LoadedFileDisableModal";
import type { LoadedFileCategory } from "./LoadedFileDisableModal";

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

function whyTooltip(step: TimelineStep): string {
  const mo = step.matched_on ?? "";
  if (mo === "managed") return "Loaded from the system-wide policy folder. This file applies to every user on this machine and cannot be excluded.";
  if (mo === "user-global") return "Loaded from your home ~/.claude/ directory as a personal preference for all projects.";
  if (mo === "no-paths") return "This rule has no paths: filter, so it loads at session start alongside your main CLAUDE.md.";
  if (mo === "ancestor-walk") return "Found by walking up the directory tree from the active project toward your home folder. Every parent directory is checked.";
  if (mo === "add-dir") return "Loaded from an extra directory specified with --add-dir or CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD.";
  if (mo === "automemory") return "Auto-memory notes Claude accumulated from past sessions in this project.";
  if (mo === "project-team") return "The project's shared .claude/CLAUDE.md — loaded for every developer working in this folder.";
  if (mo.includes("*") || mo.includes("/")) return `Loaded because its paths: pattern matched a file you opened (pattern: ${mo}).`;
  return "Loaded as part of Claude's session context for this folder.";
}

function priorityBadgeStyle(priority: number): React.CSSProperties {
  const step = Math.min(Math.max(priority - 1, 0), 5);
  const amberPct = 100 - step * 15;
  const color = `color-mix(in srgb, var(--amber) ${amberPct}%, var(--paper-faint) ${Math.max(100 - amberPct, 0)}%)`;
  const borderColor = `color-mix(in srgb, var(--amber) ${Math.max(amberPct - 30, 10)}%, var(--line) ${100 - Math.max(amberPct - 30, 10)}%)`;
  return { color, borderColor };
}

function expandHome(p: string, home: string): string {
  if (home && p === "~") return home;
  if (home && p.startsWith("~/")) return home + p.slice(1);
  return p;
}

function isToggleable(category: LoadedFileCategory | null | undefined): boolean {
  return category === "claude_md" || category === "rules" || category === "import";
}

// ---- Types -----------------------------------------------------------------

interface CrossCwdFile {
  step: TimelineStep;
  file: FileEntry | undefined;
  priority: number;
  displayPath: string;
  filePath: string;
}

interface Props {
  steps: TimelineStep[];
  files: FileEntry[];
  activeCwd: string;
  home: string;
  onSelect?: (fileId: string) => void;
}

// ---- Main component --------------------------------------------------------

export function CrossCwdPanel({ steps, files, activeCwd, home, onSelect }: Props) {
  const bumpDataVersion = useStore((s) => s.bumpDataVersion);
  const pushToast = useStore((s) => s.pushToast);

  const fileMap = new Map<string, FileEntry>();
  for (const f of files) fileMap.set(f.id, f);
  const filesByPath = new Map<string, FileEntry>();
  for (const f of files) filesByPath.set(f.path, f);

  const [pendingDisable, setPendingDisable] = useState<CrossCwdFile | null>(null);
  const [optimisticDisabled, setOptimisticDisabled] = useState<Set<string>>(new Set());
  const [disabledData, setDisabledData] = useState<DisabledFilesResponse | null>(null);
  const [disabledOpen, setDisabledOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const loadDisabled = useCallback(() => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    fetchDisabledFiles(activeCwd)
      .then((d) => { if (!ctrl.signal.aborted) setDisabledData(d); })
      .catch(() => { /* backend not yet live — degrade silently */ });
  }, [activeCwd]);

  useEffect(() => {
    setOptimisticDisabled(new Set());
    setDisabledData(null);
    loadDisabled();
    return () => abortRef.current?.abort();
  }, [loadDisabled]);

  const crossSteps = steps.filter((s) => {
    if (!s.file_path) return false;
    if (s.status !== "loaded") return false;
    const abs = expandHome(s.file_path, home);
    if (abs === activeCwd) return false;
    if (abs.startsWith(activeCwd + "/")) return false;
    return true;
  });

  const totalDisabled =
    (disabledData?.cwd_disabled.length ?? 0) + (disabledData?.globally_disabled.length ?? 0);
  const showDisabledSection = totalDisabled > 0;

  if (crossSteps.length === 0 && !showDisabledSection) return null;

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
      filePath: absPath,
    };
  });

  items.sort((a, b) =>
    a.priority !== b.priority
      ? a.priority - b.priority
      : a.displayPath.localeCompare(b.displayPath),
  );

  async function handleDisable(item: CrossCwdFile) {
    const path = item.filePath;
    setPendingDisable(null);
    setOptimisticDisabled((prev) => new Set(prev).add(path));
    try {
      const result = await postToggleLoadedFile(path, "disable", activeCwd);
      if (!result.success) {
        setOptimisticDisabled((prev) => { const next = new Set(prev); next.delete(path); return next; });
        pushToast({ kind: "error", message: result.error ?? "Could not disable file." });
        return;
      }
      loadDisabled();
      bumpDataVersion();
    } catch (err) {
      setOptimisticDisabled((prev) => { const next = new Set(prev); next.delete(path); return next; });
      const msg = err instanceof ApiError ? err.detail : "Could not disable file.";
      pushToast({ kind: "error", message: msg });
    }
  }

  async function handleEnable(path: string) {
    setOptimisticDisabled((prev) => { const next = new Set(prev); next.delete(path); return next; });
    try {
      const result = await postToggleLoadedFile(path, "enable", activeCwd);
      if (!result.success) {
        pushToast({ kind: "error", message: result.error ?? "Could not enable file." });
        return;
      }
      loadDisabled();
      bumpDataVersion();
      pushToast({ kind: "success", message: "File re-enabled." });
    } catch (err) {
      const msg = err instanceof ApiError ? err.detail : "Could not enable file.";
      pushToast({ kind: "error", message: msg });
    }
  }

  return (
    <>
      <div className="cross-cwd-panel">
        <div className="cross-cwd-header">
          <span className="cross-cwd-header-label">Also loaded for this folder</span>
          <span className="cross-cwd-header-count">{items.length}</span>
        </div>

        <ul className="cross-cwd-list" role="list">
          {items.map((item) => {
            const effectivelyDisabled =
              optimisticDisabled.has(item.filePath) || item.step.disabled === true;
            const category = (item.step.category ?? null) as LoadedFileCategory | null;
            return (
              <CrossCwdRow
                key={item.step.file_path}
                item={item}
                onSelect={onSelect}
                category={category}
                toggleable={isToggleable(category)}
                disabled={effectivelyDisabled}
                onToggleOff={() => setPendingDisable(item)}
                onToggleOn={() => handleEnable(item.filePath)}
              />
            );
          })}
        </ul>

        {showDisabledSection && (
          <DisabledSection
            disabledData={disabledData!}
            totalCount={totalDisabled}
            open={disabledOpen}
            onToggle={() => setDisabledOpen((v) => !v)}
            home={home}
            onEnable={handleEnable}
          />
        )}

        <div className="cross-cwd-divider" aria-hidden />
      </div>

      {pendingDisable && (
        <LoadedFileDisableModal
          category={(pendingDisable.step.category ?? "claude_md") as LoadedFileCategory}
          filePath={pendingDisable.filePath}
          containingFile={pendingDisable.step.containingFile ?? null}
          onConfirm={() => handleDisable(pendingDisable)}
          onCancel={() => setPendingDisable(null)}
        />
      )}
    </>
  );
}

// ---- CrossCwdRow -----------------------------------------------------------

function CrossCwdRow({
  item,
  onSelect,
  category,
  toggleable,
  disabled,
  onToggleOff,
  onToggleOn,
}: {
  item: CrossCwdFile;
  onSelect?: (fileId: string) => void;
  category: LoadedFileCategory | null;
  toggleable: boolean;
  disabled: boolean;
  onToggleOff: () => void;
  onToggleOn: () => void;
}) {
  const label = PRIORITY_LABELS[item.priority];
  const badgeTitle = PRIORITY_TOOLTIPS[item.priority] ?? "";
  const why = whyTooltip(item.step);
  const badgeStyle = priorityBadgeStyle(item.priority);
  const isOn = !disabled;
  // auto_memory never gets a per-row switch
  const showToggle = toggleable && category !== "auto_memory";

  function handleClick() {
    if (item.file && onSelect) onSelect(item.file.id);
  }

  function handleToggle(e: React.MouseEvent) {
    e.stopPropagation();
    if (isOn) onToggleOff(); else onToggleOn();
  }

  return (
    <li
      className={`cross-cwd-row${disabled ? " cross-cwd-row-disabled" : ""}`}
      onClick={handleClick}
      role={item.file ? "button" : undefined}
      tabIndex={item.file ? 0 : undefined}
      onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && item.file) handleClick(); }}
      title={item.file ? undefined : item.step.file_path}
    >
      {label && (
        <span className="cross-cwd-badge" style={badgeStyle} title={badgeTitle}>
          {label}
        </span>
      )}
      <span className="cross-cwd-path">{item.displayPath}</span>
      <span className="cross-cwd-why-icon" title={why} aria-label={why}>?</span>
      {showToggle ? (
        <button
          className={`cross-cwd-toggle${isOn ? " on" : ""}`}
          title={isOn ? "Loaded — click to disable" : "Disabled — click to enable"}
          aria-label={isOn ? "Disable this file" : "Enable this file"}
          aria-pressed={isOn}
          onClick={handleToggle}
          tabIndex={-1}
        />
      ) : (
        <span className="cross-cwd-toggle-placeholder" aria-hidden />
      )}
    </li>
  );
}

// ---- DisabledSection -------------------------------------------------------

function DisabledSection({
  disabledData,
  totalCount,
  open,
  onToggle,
  home,
  onEnable,
}: {
  disabledData: DisabledFilesResponse;
  totalCount: number;
  open: boolean;
  onToggle: () => void;
  home: string;
  onEnable: (path: string) => void;
}) {
  return (
    <div className="cross-cwd-disabled-section">
      <button
        className="cross-cwd-disabled-head"
        onClick={onToggle}
        aria-expanded={open}
      >
        <span className="cross-cwd-disabled-chev">{open ? "▾" : "▸"}</span>
        <span className="cross-cwd-disabled-label">Disabled for this folder</span>
        <span className="cross-cwd-disabled-count">({totalCount})</span>
      </button>
      {open && (
        <ul className="cross-cwd-list cross-cwd-disabled-list" role="list">
          {disabledData.cwd_disabled.map((entry) => (
            <DisabledRow key={entry.path} entry={entry} scope="cwd" home={home} onEnable={onEnable} />
          ))}
          {disabledData.globally_disabled.map((entry) => (
            <DisabledRow key={entry.path} entry={entry} scope="global" home={home} onEnable={onEnable} />
          ))}
        </ul>
      )}
    </div>
  );
}

// ---- DisabledRow -----------------------------------------------------------

function DisabledRow({
  entry,
  scope,
  home,
  onEnable,
}: {
  entry: DisabledFileEntry;
  scope: "cwd" | "global";
  home: string;
  onEnable: (path: string) => void;
}) {
  const displayPath = collapseToHome(entry.path, home);
  const globalTooltip =
    "Disabled for ALL cwds — this is an @-imported file. Re-enabling also takes effect globally.";
  return (
    <li className="cross-cwd-row cross-cwd-row-disabled">
      <span className="cross-cwd-badge cross-cwd-badge-off" aria-hidden>off</span>
      <span className="cross-cwd-path cross-cwd-path-disabled">{displayPath}</span>
      {scope === "global" ? (
        <span className="cross-cwd-global-badge" title={globalTooltip} aria-label={globalTooltip}>
          global
        </span>
      ) : (
        <span className="cross-cwd-toggle-placeholder" aria-hidden />
      )}
      <button
        className="cross-cwd-toggle"
        title="Disabled — click to enable"
        aria-label="Enable this file"
        aria-pressed={false}
        onClick={(e) => { e.stopPropagation(); onEnable(entry.path); }}
        tabIndex={-1}
      />
    </li>
  );
}
