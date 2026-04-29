import { useEffect, useState } from "react";
import { Inspector } from "../components/Inspector";
import { fetchSimulate } from "../api/client";
import { useStore } from "../state/store";
import type { LoadStatus } from "../types";

export function SimulatorView() {
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  const lastCwd = useStore((s) => s.lastCwd);
  const files = useStore((s) => s.files);
  const [statusMap, setStatusMap] = useState<Map<string, LoadStatus> | null>(null);

  // Mirror the MapView's status pull so the Inspector header chip on this
  // view also shows loaded/skipped/orphan when a cwd is selected.
  useEffect(() => {
    if (!lastCwd) {
      setStatusMap(null);
      return;
    }
    let cancelled = false;
    fetchSimulate(lastCwd)
      .then((res) => {
        if (cancelled) return;
        const map = new Map<string, LoadStatus>();
        for (const step of res.steps) {
          if (step.file_id) map.set(step.file_id, step.status);
        }
        for (const f of files) {
          if (!map.has(f.id)) map.set(f.id, "orphan");
        }
        setStatusMap(map);
      })
      .catch(() => {
        if (!cancelled) setStatusMap(null);
      });
    return () => {
      cancelled = true;
    };
  }, [lastCwd, files]);

  return (
    <div className={`view-shell${inspectorOpen ? " has-inspector" : ""}`}>
      <div className="placeholder">
        <h1>Simulator <em>—</em> 02</h1>
        <p className="lede">
          Pick a working directory and watch which CLAUDE.md files, rules and
          memory entries actually get loaded — with token estimates and the
          conditional matches that decided their fate.
        </p>
        <p className="stub-note">step 4 of build sequence · backend /api/simulate is ready</p>
      </div>
      <Inspector cy={null} statusMap={statusMap} />
    </div>
  );
}
