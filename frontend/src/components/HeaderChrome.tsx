import { useCallback, useEffect, useRef, useState } from "react";
import { fetchFile, fetchPathProposals } from "../api/client";
import { useStore } from "../state/store";
import { useWritePipeline } from "../hooks/useWritePipeline";
import type { PathProposal, ViewKey } from "../types";

interface Props {
  fileCount: number;
  edgeCount: number;
  watcherLive: boolean;
}

const TABS: { key: ViewKey; num: string; label: string }[] = [
  { key: "map", num: "01", label: "Map" },
  { key: "sim", num: "02", label: "Simulator" },
  { key: "ed",  num: "03", label: "Editor" },
  { key: "ext", num: "04", label: "Extensions" },
];

export function HeaderChrome({ fileCount, edgeCount, watcherLive }: Props) {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const showInternal = useStore((s) => s.showInternal);
  const setShowInternal = useStore((s) => s.setShowInternal);
  const simulatorMode = useStore((s) => s.simulatorMode);
  const setSimulatorMode = useStore((s) => s.setSimulatorMode);
  const pushToast = useStore((s) => s.pushToast);

  const { requestWrite } = useWritePipeline();

  // --- paths-proposals pill -----------------------------------------------
  const [proposals, setProposals] = useState<PathProposal[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [panelOpen, setPanelOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const refetch = useCallback(async () => {
    try {
      const res = await fetchPathProposals();
      setProposals(res.proposals);
    } catch {
      // Backend hiccup — silently keep last value. The pill simply won't
      // refresh until the next tick.
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  // SSE listener — refetch proposals after every reindex event the backend
  // pushes through /api/events. We mount it once at the chrome level so any
  // view benefits without each one wiring its own listener.
  useEffect(() => {
    let es: EventSource | null = null;
    try {
      es = new EventSource("/api/events");
      const onReindex = () => {
        void refetch();
      };
      es.addEventListener("reindex", onReindex);
      // Backend also fires generic `message` payloads — don't refetch on those.
    } catch {
      // EventSource unsupported or initial GET failed; pill just stays static.
    }
    return () => {
      es?.close();
    };
  }, [refetch]);

  // Close panel on outside click.
  useEffect(() => {
    if (!panelOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!panelRef.current) return;
      if (panelRef.current.contains(e.target as Node)) return;
      setPanelOpen(false);
    };
    window.addEventListener("mousedown", onDoc);
    return () => window.removeEventListener("mousedown", onDoc);
  }, [panelOpen]);

  const visibleProposals = proposals.filter(
    (p) => !dismissed.has(p.rule_id),
  );

  const onApply = async (p: PathProposal) => {
    try {
      const fileRes = await fetchFile(p.rule_path);
      const newContent = applyPathsRewrite(
        fileRes.content,
        p.broken_globs,
        p.proposed_globs,
      );
      if (newContent === fileRes.content) {
        pushToast({
          kind: "info",
          message: "No changes — globs already match.",
        });
        return;
      }
      await requestWrite([
        {
          path: p.rule_path,
          newContent,
          title: "Rewrite paths globs",
        },
      ]);
      // Optimistically dismiss; a successful reindex repopulates without the
      // applied proposal.
      setDismissed((s) => new Set(s).add(p.rule_id));
    } catch (e) {
      pushToast({
        kind: "error",
        message: `Apply failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  };

  const onDismiss = (p: PathProposal) => {
    setDismissed((s) => new Set(s).add(p.rule_id));
  };

  return (
    <header className="chrome">
      <div className="chrome-row">
        <div className="brand">
          <span className="crosshair" aria-hidden />
          <span className="mark">Observ<em>·</em>atory</span>
          <span className="meta mono">v0.1 · session-context inspector</span>
        </div>

        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={view === t.key ? "on" : undefined}
              onClick={() => setView(t.key)}
            >
              <span className="num">{t.num}</span>
              {t.label}
            </button>
          ))}
          {view === "sim" && (
            <span className="subtabs" role="tablist" aria-label="Simulator mode">
              <button
                type="button"
                role="tab"
                aria-selected={simulatorMode === "per-cwd"}
                className={`subtab${simulatorMode === "per-cwd" ? " on" : ""}`}
                onClick={() => setSimulatorMode("per-cwd")}
                title="Show which files Claude loads for the selected folder"
              >
                <span className="num">02a</span>This folder
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={simulatorMode === "all-cwds"}
                className={`subtab${simulatorMode === "all-cwds" ? " on" : ""}`}
                onClick={() => setSimulatorMode("all-cwds")}
                title="See a summary across all discovered folders at once"
              >
                <span className="num">02b</span>All folders
              </button>
            </span>
          )}
        </nav>

        <div className="status">
          {visibleProposals.length > 0 && (
            <div className="proposals-pill-wrap" ref={panelRef}>
              <button
                type="button"
                className={`pill mono toggle proposals-pill${panelOpen ? " on" : ""}`}
                onClick={() => setPanelOpen((v) => !v)}
                title="Review proposed paths fixes"
              >
                <span className="dot warn" />
                paths · {visibleProposals.length} proposed
              </button>
              {panelOpen && (
                <ProposalsPanel
                  proposals={visibleProposals}
                  onApply={onApply}
                  onDismiss={onDismiss}
                />
              )}
            </div>
          )}
          <span className="pill">
            <span className={`dot${watcherLive ? "" : " warn"}`} />
            watcher · {watcherLive ? "live" : "idle"}
          </span>
          <button
            type="button"
            className={`pill mono toggle${showInternal ? " on" : ""}`}
            onClick={() => setShowInternal(!showInternal)}
            title="Show Claude-Code-internal nodes that duplicate already-visible state"
          >
            internal · {showInternal ? "on" : "off"}
          </button>
          <span className="pill mono">{fileCount} files · {edgeCount} edges</span>
        </div>
      </div>
    </header>
  );
}

// --- proposals panel ------------------------------------------------------

function ProposalsPanel({
  proposals,
  onApply,
  onDismiss,
}: {
  proposals: PathProposal[];
  onApply: (p: PathProposal) => void;
  onDismiss: (p: PathProposal) => void;
}) {
  return (
    <div className="proposals-panel" role="dialog" aria-label="Path rewrite proposals">
      <div className="proposals-head">
        <span>paths fixes</span>
        <span className="dim">{proposals.length}</span>
      </div>
      <ul className="proposals-list">
        {proposals.map((p) => (
          <li key={p.rule_id} className="proposal-row">
            <div className="proposal-meta">
              <span className="proposal-path">{collapseHome(p.rule_path)}</span>
              <span className={`proposal-conf conf-${p.confidence}`}>
                {p.confidence}
              </span>
            </div>
            <div className="proposal-globs">
              {p.broken_globs.map((g, i) => {
                const proposed = p.proposed_globs[i];
                return (
                  <div className="proposal-glob-row" key={`${g}-${i}`}>
                    <span className="proposal-broken">{g}</span>
                    <span className="proposal-arrow">→</span>
                    <span className="proposal-proposed">
                      {proposed ?? "(no candidate)"}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="proposal-actions">
              <button
                type="button"
                className="proposal-apply"
                onClick={() => onApply(p)}
                disabled={p.proposed_globs.length === 0}
              >
                Apply
              </button>
              <button
                type="button"
                className="proposal-dismiss"
                onClick={() => onDismiss(p)}
              >
                Dismiss
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Replace each broken glob in the rule's `paths:` field with the proposed
// alternative. Preserves all other content and the original frontmatter
// structure (line ordering, indentation, whitespace).
//
// Strategy: find the exact `paths: ...` value in the frontmatter block and
// rewrite the value. Supports the YAML list, comma-separated, single string,
// and bare-identifier shapes the parser accepts (locked rule #6).
export function applyPathsRewrite(
  current: string,
  brokenGlobs: string[],
  proposedGlobs: string[],
): string {
  if (brokenGlobs.length === 0 || brokenGlobs.length !== proposedGlobs.length) {
    return current;
  }
  const map = new Map<string, string>();
  for (let i = 0; i < brokenGlobs.length; i += 1) {
    map.set(brokenGlobs[i], proposedGlobs[i]);
  }
  // Replace whole-token occurrences of each broken glob with its proposed
  // form. Word-boundary-ish: don't replace mid-token. We scope to the
  // frontmatter block to avoid touching prose.
  const fmMatch = /^(---\s*\n)([\s\S]*?)(\n---\s*\n?)/.exec(current);
  if (!fmMatch) return current;
  let fmBlock = fmMatch[2];
  for (const [broken, proposed] of map) {
    // Escape regex special chars in the broken glob for literal match.
    const re = new RegExp(escapeRegex(broken), "g");
    fmBlock = fmBlock.replace(re, proposed);
  }
  return fmMatch[1] + fmBlock + fmMatch[3] + current.slice(fmMatch[0].length);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collapseHome(p: string): string {
  const m = /^\/home\/[^/]+\/(.+)$/.exec(p);
  if (m) return "~/" + m[1];
  return p;
}
