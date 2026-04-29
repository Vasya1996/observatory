import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchCwds } from "../api/client";
import { useStore } from "../state/store";
import type { CwdEntry } from "../types";

// Targeting reticle for picking the active working directory. Visually echoes
// the brand crosshair: closed pill carries a small SVG sight that turns from a
// dashed empty ring (no cwd, "scope is wandering") to a locked-on crosshair
// (cwd selected, "aimed"). The dropdown opens beneath as a connected panel —
// border seam between trigger and panel is intentionally hidden so the two
// read as one piece of instrument-panel chrome.
//
// Picking a cwd drives `/api/simulate` (which the Map view uses to color
// nodes by load status — loaded/conditional/skipped/orphan). "no target"
// disables the overlay and reverts to kind-only colors.

const NONE = "__none__";

interface OptionItem {
  path: string;     // either NONE or an absolute path
  display: string;  // ~-collapsed for human reading
}

export function CwdSelector() {
  const lastCwd = useStore((s) => s.lastCwd);
  const setLastCwd = useStore((s) => s.setLastCwd);
  const [cwds, setCwds] = useState<CwdEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetchCwds()
      .then((list) => {
        if (!cancelled) setCwds(list);
      })
      .catch((e) => console.warn("[observatory] /api/cwds failed", e));
    return () => {
      cancelled = true;
    };
  }, []);

  const options: OptionItem[] = useMemo(
    () => [{ path: NONE, display: "no target" }, ...cwds],
    [cwds],
  );

  const currentIdx = useMemo(
    () => options.findIndex((o) => o.path === (lastCwd ?? NONE)),
    [options, lastCwd],
  );

  // Click outside closes — only attached while open so we don't hold a doc
  // listener for the entire mount.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Scroll the highlighted option into view when nav-keys move past the visible
  // edge — necessary because the list panel has a max-height + overflow.
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.children[highlight] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [highlight, open]);

  const choose = useCallback(
    (path: string) => {
      setLastCwd(path === NONE ? null : path);
      setOpen(false);
      triggerRef.current?.focus();
    },
    [setLastCwd],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight(Math.max(0, currentIdx));
        setOpen(true);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(options.length - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === "Home") {
      e.preventDefault();
      setHighlight(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setHighlight(options.length - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const opt = options[highlight];
      if (opt) choose(opt.path);
    }
  };

  const aimed = Boolean(lastCwd);
  const currentDisplay = aimed
    ? cwds.find((c) => c.path === lastCwd)?.display ?? lastCwd
    : "select target";

  return (
    <div
      className="cwd-target"
      ref={rootRef}
      onKeyDown={onKeyDown}
      role="combobox"
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls="cwd-target-listbox"
    >
      <button
        ref={triggerRef}
        type="button"
        className={
          "cwd-target-trigger" +
          (open ? " open" : "") +
          (aimed ? " aimed" : " idle")
        }
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={
          aimed
            ? `Working directory: ${currentDisplay}. Click to change.`
            : "Pick a working directory to color the map by load status"
        }
        onClick={() => {
          setHighlight(Math.max(0, currentIdx));
          setOpen((o) => !o);
        }}
      >
        <Reticle aimed={aimed} />
        <span className="cwd-target-label">cwd</span>
        <span className="cwd-target-divider" aria-hidden>
          ·
        </span>
        <span className="cwd-target-path">{currentDisplay}</span>
        <span className="cwd-target-chevron" aria-hidden>
          <svg viewBox="0 0 12 12" width="10" height="10">
            <path
              d="M2.5 4.5 L6 8 L9.5 4.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>

      <div
        className={"cwd-target-panel" + (open ? " open" : "")}
        role="presentation"
      >
        <div className="cwd-target-panel-head">
          <span className="cwd-target-panel-head-label">discovered targets</span>
          <span className="cwd-target-panel-head-count">
            {cwds.length.toString().padStart(2, "0")}
          </span>
        </div>
        <ul
          id="cwd-target-listbox"
          className="cwd-target-list"
          role="listbox"
          ref={listRef}
          aria-label="Working directories"
        >
          {options.map((opt, i) => {
            const isActive = opt.path === (lastCwd ?? NONE);
            const isHighlight = i === highlight;
            const isNone = opt.path === NONE;
            return (
              <li
                key={opt.path}
                role="option"
                aria-selected={isActive}
                className={
                  "cwd-target-option" +
                  (isActive ? " active" : "") +
                  (isHighlight ? " highlight" : "") +
                  (isNone ? " none" : "")
                }
                onMouseEnter={() => setHighlight(i)}
                onClick={() => choose(opt.path)}
              >
                <span className="cwd-target-option-marker" aria-hidden>
                  {isActive ? "◉" : isHighlight ? "▸" : ""}
                </span>
                <span className="cwd-target-option-path">{opt.display}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

// Inline SVG reticle. Two modes: dashed empty ring (idle, "scope wandering")
// and locked crosshair with filled center dot (aimed, "scope on target").
// 14×14 viewBox keeps the icon optically aligned with the 11px mono around it.
function Reticle({ aimed }: { aimed: boolean }) {
  return (
    <span
      className={"cwd-target-reticle" + (aimed ? " aimed" : " idle")}
      aria-hidden
    >
      <svg viewBox="0 0 14 14" width="13" height="13">
        {aimed ? (
          <>
            <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1" />
            <circle cx="7" cy="7" r="1.6" fill="currentColor" />
            <line x1="0.5" y1="7" x2="2" y2="7" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
            <line x1="12" y1="7" x2="13.5" y2="7" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
            <line x1="7" y1="0.5" x2="7" y2="2" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
            <line x1="7" y1="12" x2="7" y2="13.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
          </>
        ) : (
          <circle
            cx="7"
            cy="7"
            r="5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
            strokeDasharray="2 2"
          />
        )}
      </svg>
    </span>
  );
}
