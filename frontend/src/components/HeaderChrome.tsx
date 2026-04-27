import { useStore } from "../state/store";
import type { ViewKey } from "../types";

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
        </nav>

        <div className="status">
          <span className="pill">
            <span className={`dot${watcherLive ? "" : " warn"}`} />
            watcher · {watcherLive ? "live" : "idle"}
          </span>
          <span className="pill mono">{fileCount} files · {edgeCount} edges</span>
          <span className="pill mono">~/.claude</span>
        </div>
      </div>
    </header>
  );
}
