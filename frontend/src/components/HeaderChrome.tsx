import { useStore } from "../state/store";
import type { ViewKey } from "../types";
import { CwdSelector } from "./CwdSelector";

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
  const mapMode = useStore((s) => s.mapMode);
  const setMapMode = useStore((s) => s.setMapMode);

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
          {view === "map" && (
            <span className="subtabs" role="tablist" aria-label="Map mode">
              <button
                type="button"
                role="tab"
                aria-selected={mapMode === "graph"}
                className={`subtab${mapMode === "graph" ? " on" : ""}`}
                onClick={() => setMapMode("graph")}
              >
                <span className="num">01a</span>Graph
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mapMode === "tree"}
                className={`subtab${mapMode === "tree" ? " on" : ""}`}
                onClick={() => setMapMode("tree")}
              >
                <span className="num">01b</span>Tree
              </button>
            </span>
          )}
        </nav>

        <div className="status">
          <span className="pill">
            <span className={`dot${watcherLive ? "" : " warn"}`} />
            watcher · {watcherLive ? "live" : "idle"}
          </span>
          <CwdSelector />
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
