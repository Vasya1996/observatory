import { useEffect, useState } from "react";
import { fetchCwds } from "../api/client";
import { useStore } from "../state/store";
import type { CwdEntry } from "../types";

// Header dropdown for picking the active cwd. Drives the simulator-status fetch
// (which colors nodes by load state in the Map view) and will eventually drive
// the project-side root of the radial tree. Auto-discovered cwds come from
// `/api/cwds` (any directory under ~/ that contains a CLAUDE.md or .claude/);
// the empty option means "no cwd picked — status off".
export function CwdSelector() {
  const lastCwd = useStore((s) => s.lastCwd);
  const setLastCwd = useStore((s) => s.setLastCwd);
  const [cwds, setCwds] = useState<CwdEntry[]>([]);

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

  return (
    <label className="cwd-selector pill mono">
      <span className="cwd-label">cwd</span>
      <select
        className="cwd-input"
        value={lastCwd ?? ""}
        onChange={(e) => setLastCwd(e.target.value || null)}
      >
        <option value="">— none —</option>
        {cwds.map((c) => (
          <option key={c.path} value={c.path}>
            {c.display}
          </option>
        ))}
      </select>
    </label>
  );
}
