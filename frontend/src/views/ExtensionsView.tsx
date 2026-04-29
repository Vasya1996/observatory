/**
 * ExtensionsView — the "what's installed, what's enabled" surface for Skills,
 * Plugins, and MCP servers. Anchored to the locked mockup
 * (`/home/voxdecaelo/claude-dashboard-design/index.html`, lines 1230-1340):
 * three sub-tabs (Skills/Plugins/MCP), card-grid layout, `.card-toggle` pill
 * widget on the right of every card.
 *
 * Toggle wiring (locked rule #36 — diff modal precedes every write; soft chip
 * is the "diff modal" for one-line writes):
 *   - Skills    → write `Skill(<plugin_id>:<name>)` literals into
 *                 `permissions.deny[]` of `~/.claude/settings.json`. Toggle ON
 *                 = remove from deny. Toggle OFF = add. Per
 *                 `~/observatory/notes/skills-enabled-research.md`.
 *   - Plugins   → flip `enabledPlugins["<plugin>@<marketplace>"]` boolean in
 *                 `~/.claude/settings.json`. Add key if absent.
 *   - MCP       → move entry between `mcpServers` and `mcpServers_disabled`
 *                 in `~/.claude/.mcp.json` (Claude Code ignores the latter
 *                 key, so the entry is effectively disabled while remaining
 *                 trivially re-enabled through the same toggle).
 *
 * UX:
 *   - Optimistic flip: visual state changes the moment the user clicks. The
 *     write fires through the soft PreviewChip; cancel rolls the optimistic
 *     state back; failure shows an error toast and rolls back.
 *   - Each section shows a count.
 *   - Skills: when /api/extensions returns an empty skills[] array we show a
 *     friendly empty state — the toggle pipeline is still wired so the
 *     moment a SKILL.md (or a plugin manifest's skills[]) lands the section
 *     fills in without a code change.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchExtensions,
  fetchFile,
} from "../api/client";
import { useStore } from "../state/store";
import { useWritePipeline } from "../hooks/useWritePipeline";
import type {
  ExtensionsResponse,
  McpCard,
  PluginCard,
  SkillCard,
} from "../types";

const SETTINGS_PATH = "/home/voxdecaelo/.claude/settings.json";
const MCP_PATH = "/home/voxdecaelo/.claude/.mcp.json";

type SectionKey = "skills" | "plugins" | "mcp";

// Local optimistic overrides keyed by entity id. Set when the user clicks a
// toggle; cleared when /api/extensions next refreshes (post-write reindex
// reflects the new on-disk state).
type OverrideMap = Map<string, boolean>;

export function ExtensionsView() {
  const [data, setData] = useState<ExtensionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState<SectionKey>("skills");

  const [skillOverride, setSkillOverride] = useState<OverrideMap>(new Map());
  const [pluginOverride, setPluginOverride] = useState<OverrideMap>(new Map());
  const [mcpOverride, setMcpOverride] = useState<OverrideMap>(new Map());

  const { requestWrite } = useWritePipeline();
  const pushToast = useStore((s) => s.pushToast);

  const load = useCallback(async () => {
    try {
      const res = await fetchExtensions();
      setData(res);
      setError(null);
      // Drop optimistic overrides — fresh data wins.
      setSkillOverride(new Map());
      setPluginOverride(new Map());
      setMcpOverride(new Map());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // --- toggle handlers ----------------------------------------------------

  const onSkillToggle = useCallback(
    async (skill: SkillCard, currentEnabled: boolean) => {
      const next = !currentEnabled;
      const key = skillKey(skill);
      // Optimistic flip.
      setSkillOverride((m) => new Map(m).set(key, next));
      try {
        const file = await fetchFile(SETTINGS_PATH);
        const newContent = applySkillDeny(file.content, skill, next);
        const result = await requestWrite(
          [
            {
              path: SETTINGS_PATH,
              newContent,
              title: next
                ? `Enable skill ${skill.name}`
                : `Disable skill ${skill.name}`,
            },
          ],
          { softConfirm: true },
        );
        if (!result.ok) {
          // Rollback on cancel/failure.
          setSkillOverride((m) => {
            const n = new Map(m);
            n.delete(key);
            return n;
          });
        } else {
          await load();
        }
      } catch (e) {
        setSkillOverride((m) => {
          const n = new Map(m);
          n.delete(key);
          return n;
        });
        pushToast({
          kind: "error",
          message: `Skill toggle failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    },
    [requestWrite, pushToast, load],
  );

  const onPluginToggle = useCallback(
    async (plugin: PluginCard, currentEnabled: boolean) => {
      const next = !currentEnabled;
      setPluginOverride((m) => new Map(m).set(plugin.plugin_key, next));
      try {
        const file = await fetchFile(SETTINGS_PATH);
        const newContent = applyPluginToggle(file.content, plugin.plugin_key, next);
        const result = await requestWrite(
          [
            {
              path: SETTINGS_PATH,
              newContent,
              title: next
                ? `Enable plugin ${plugin.plugin_id ?? plugin.plugin_key}`
                : `Disable plugin ${plugin.plugin_id ?? plugin.plugin_key}`,
            },
          ],
          { softConfirm: true },
        );
        if (!result.ok) {
          setPluginOverride((m) => {
            const n = new Map(m);
            n.delete(plugin.plugin_key);
            return n;
          });
        } else {
          await load();
        }
      } catch (e) {
        setPluginOverride((m) => {
          const n = new Map(m);
          n.delete(plugin.plugin_key);
          return n;
        });
        pushToast({
          kind: "error",
          message: `Plugin toggle failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    },
    [requestWrite, pushToast, load],
  );

  const onMcpToggle = useCallback(
    async (server: McpCard, currentEnabled: boolean) => {
      const next = !currentEnabled;
      setMcpOverride((m) => new Map(m).set(server.name, next));
      try {
        const file = await fetchFile(MCP_PATH);
        const newContent = applyMcpToggle(file.content, server.name, next);
        const result = await requestWrite(
          [
            {
              path: MCP_PATH,
              newContent,
              title: next
                ? `Enable MCP server ${server.name}`
                : `Disable MCP server ${server.name}`,
            },
          ],
          { softConfirm: true },
        );
        if (!result.ok) {
          setMcpOverride((m) => {
            const n = new Map(m);
            n.delete(server.name);
            return n;
          });
        } else {
          await load();
        }
      } catch (e) {
        setMcpOverride((m) => {
          const n = new Map(m);
          n.delete(server.name);
          return n;
        });
        pushToast({
          kind: "error",
          message: `MCP toggle failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    },
    [requestWrite, pushToast, load],
  );

  // --- render -------------------------------------------------------------

  // We always render the three sub-tabs and the section the user picked. The
  // counts come from the live data when present, "—" otherwise.
  const skills = data?.skills ?? [];
  const plugins = data?.plugins ?? [];
  const mcp = data?.mcp ?? [];

  // Augment MCP list with disabled servers (from `mcpServers_disabled` if the
  // file has that key). The backend response only carries enabled servers
  // today; we fold disabled in here so the user sees them and can re-enable.
  const [disabledMcp, setDisabledMcp] = useState<McpCard[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetchFile(MCP_PATH)
      .then((f) => {
        if (cancelled) return;
        try {
          const parsed = JSON.parse(f.content);
          const map = parsed?.mcpServers_disabled ?? {};
          const list: McpCard[] = Object.entries(map).map(([name, cfg]) => ({
            name,
            config: cfg as Record<string, unknown>,
          }));
          setDisabledMcp(list);
        } catch {
          setDisabledMcp([]);
        }
      })
      .catch(() => {
        if (!cancelled) setDisabledMcp([]);
      });
    return () => {
      cancelled = true;
    };
  }, [data]);

  const allMcp = useMemo(() => {
    const merged = [...mcp.map((s) => ({ ...s, _enabled: true }))];
    for (const s of disabledMcp) merged.push({ ...s, _enabled: false });
    return merged;
  }, [mcp, disabledMcp]);

  const skillsCount = skills.length;
  const pluginsCount = plugins.length;
  const mcpCount = allMcp.length;

  return (
    <div className="view-shell ext-shell">
      <div className="ext">
        <h1>
          Skills, plugins, <em>protocols.</em>
        </h1>

        <div className="ext-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={section === "skills"}
            className={section === "skills" ? "on" : undefined}
            onClick={() => setSection("skills")}
          >
            Skills <span className="count">{skillsCount}</span>
          </button>
          <button
            role="tab"
            aria-selected={section === "plugins"}
            className={section === "plugins" ? "on" : undefined}
            onClick={() => setSection("plugins")}
          >
            Plugins <span className="count">{pluginsCount}</span>
          </button>
          <button
            role="tab"
            aria-selected={section === "mcp"}
            className={section === "mcp" ? "on" : undefined}
            onClick={() => setSection("mcp")}
          >
            MCP servers <span className="count">{mcpCount}</span>
          </button>
        </div>

        {error && <div className="ext-error">Failed to load: {error}</div>}

        {section === "skills" && (
          <SkillsGrid
            skills={skills}
            override={skillOverride}
            onToggle={onSkillToggle}
          />
        )}

        {section === "plugins" && (
          <PluginsGrid
            plugins={plugins}
            override={pluginOverride}
            onToggle={onPluginToggle}
          />
        )}

        {section === "mcp" && (
          <McpGrid
            servers={allMcp}
            override={mcpOverride}
            onToggle={onMcpToggle}
          />
        )}
      </div>
    </div>
  );
}

// --- sections --------------------------------------------------------------

function skillKey(s: SkillCard): string {
  return `${s.plugin_id}::${s.name}`;
}

function SkillsGrid({
  skills,
  override,
  onToggle,
}: {
  skills: SkillCard[];
  override: OverrideMap;
  onToggle: (s: SkillCard, currentEnabled: boolean) => void;
}) {
  if (skills.length === 0) {
    return (
      <div className="ext-empty">
        <p>
          No <code>SKILL.md</code> files detected on this machine — Skills will
          appear here when installed.
        </p>
      </div>
    );
  }
  return (
    <div className="grid">
      {skills.map((s) => {
        const key = skillKey(s);
        const liveEnabled = override.has(key) ? override.get(key)! : true;
        const glyph = s.name.slice(0, 1).toUpperCase();
        const desc =
          (s.description ?? "").trim().split(/\s+/).slice(0, 32).join(" ") ||
          "(no description)";
        return (
          <article
            key={key}
            className={`card${liveEnabled ? "" : " off"}`}
            data-kind="skill"
          >
            <div className="card-top">
              <div className="card-glyph">{glyph}</div>
              <button
                type="button"
                className={`card-toggle${liveEnabled ? " on" : ""}`}
                role="switch"
                aria-checked={liveEnabled}
                aria-label={`Toggle skill ${s.name}`}
                title={liveEnabled ? "Enabled" : "Disabled"}
                onClick={() => onToggle(s, liveEnabled)}
              />
            </div>
            <h3>{s.name}</h3>
            <span className="src">{s.plugin_id}</span>
            <p>{desc}</p>
            <div className="meta-row">
              <span>
                <b>kind</b> skill
              </span>
              <span>
                <b>plugin</b> {s.plugin_id}
              </span>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function PluginsGrid({
  plugins,
  override,
  onToggle,
}: {
  plugins: PluginCard[];
  override: OverrideMap;
  onToggle: (p: PluginCard, currentEnabled: boolean) => void;
}) {
  if (plugins.length === 0) {
    return (
      <div className="ext-empty">
        <p>No plugins registered in <code>~/.claude/settings.json#enabledPlugins</code>.</p>
      </div>
    );
  }
  return (
    <div className="grid">
      {plugins.map((p) => {
        const liveEnabled = override.has(p.plugin_key)
          ? override.get(p.plugin_key)!
          : p.enabled;
        const glyph = (p.plugin_id ?? p.plugin_key).slice(0, 1).toUpperCase();
        return (
          <article
            key={p.plugin_key}
            className={`card${liveEnabled ? "" : " off"}`}
            data-kind="plugin"
          >
            <div className="card-top">
              <div className="card-glyph">{glyph}</div>
              <button
                type="button"
                className={`card-toggle${liveEnabled ? " on" : ""}`}
                role="switch"
                aria-checked={liveEnabled}
                aria-label={`Toggle plugin ${p.plugin_id ?? p.plugin_key}`}
                onClick={() => onToggle(p, liveEnabled)}
              />
            </div>
            <h3>{p.plugin_id ?? p.plugin_key}</h3>
            <span className="src">{p.plugin_key}</span>
            <div className="meta-row">
              <span>
                <b>marketplace</b> {p.marketplace ?? "—"}
              </span>
              <span>
                <b>installed</b> {p.installed ? "yes" : "registry-only"}
              </span>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function McpGrid({
  servers,
  override,
  onToggle,
}: {
  servers: (McpCard & { _enabled: boolean })[];
  override: OverrideMap;
  onToggle: (s: McpCard, currentEnabled: boolean) => void;
}) {
  if (servers.length === 0) {
    return (
      <div className="ext-empty">
        <p>No MCP servers configured in <code>~/.claude/.mcp.json</code>.</p>
      </div>
    );
  }
  return (
    <div className="grid">
      {servers.map((s) => {
        const liveEnabled = override.has(s.name)
          ? override.get(s.name)!
          : s._enabled;
        const transport = inferTransport(s.config);
        const glyph = s.name.slice(0, 1).toUpperCase();
        return (
          <article
            key={s.name}
            className={`card${liveEnabled ? "" : " off"}`}
            data-kind="mcp"
          >
            <div className="card-top">
              <div className="card-glyph">{glyph}</div>
              <button
                type="button"
                className={`card-toggle${liveEnabled ? " on" : ""}`}
                role="switch"
                aria-checked={liveEnabled}
                aria-label={`Toggle MCP server ${s.name}`}
                onClick={() => onToggle(s, liveEnabled)}
              />
            </div>
            <h3>{s.name} <span className="dim mono"> · MCP</span></h3>
            <span className="src">.mcp.json · {transport} transport</span>
            <div className="meta-row">
              <span>
                <b>kind</b> mcp · {transport}
              </span>
              <span>
                <b>state</b> {liveEnabled ? "enabled" : "disabled"}
              </span>
            </div>
          </article>
        );
      })}
    </div>
  );
}

// --- helpers --------------------------------------------------------------

function inferTransport(cfg: Record<string, unknown>): string {
  if (typeof cfg.command === "string") return "stdio";
  if (typeof cfg.url === "string") return "http";
  if (cfg.transport && typeof cfg.transport === "string") return cfg.transport;
  return "stdio";
}

// Compose the deny-rule literal for a skill. Plugin-namespaced skills use
// `Skill(<plugin>:<name>)` per the official docs; the prefix-match form
// (with trailing space-asterisk) covers `/skill arg1 arg2` invocations.
function denyTokenForSkill(skill: SkillCard): string {
  const ns = skill.plugin_id ? `${skill.plugin_id}:${skill.name}` : skill.name;
  return `Skill(${ns} *)`;
}

// Replace `~/.claude/settings.json` content with `Skill(<...>)` added to or
// removed from `permissions.deny[]`. Pretty-prints with 2-space indent so the
// diff stays readable.
export function applySkillDeny(
  current: string,
  skill: SkillCard,
  enable: boolean,
): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(current || "{}") as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  const permissions = (parsed.permissions ?? {}) as Record<string, unknown>;
  const deny = Array.isArray(permissions.deny)
    ? [...(permissions.deny as unknown[])].filter((x) => typeof x === "string") as string[]
    : [];
  const token = denyTokenForSkill(skill);
  if (enable) {
    // Re-enable = drop any deny rule mentioning this skill (exact + prefix).
    const ns = skill.plugin_id ? `${skill.plugin_id}:${skill.name}` : skill.name;
    const filtered = deny.filter((d) => {
      const inner = d.match(/^Skill\(([^)]*)\)$/)?.[1]?.trim() ?? "";
      // Strip a trailing wildcard so both `Skill(name)` and `Skill(name *)` match.
      const stripped = inner.replace(/\s*\*\s*$/, "").trim();
      return stripped !== ns;
    });
    if (filtered.length === 0) {
      delete permissions.deny;
    } else {
      permissions.deny = filtered;
    }
  } else {
    if (!deny.includes(token)) deny.push(token);
    permissions.deny = deny;
  }
  parsed.permissions = permissions;
  return JSON.stringify(parsed, null, 2) + "\n";
}

// Flip enabledPlugins["<key>"] in settings.json. Adds the key if absent.
export function applyPluginToggle(
  current: string,
  pluginKey: string,
  enable: boolean,
): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(current || "{}") as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  const enabledPlugins = (parsed.enabledPlugins ?? {}) as Record<string, unknown>;
  enabledPlugins[pluginKey] = enable;
  parsed.enabledPlugins = enabledPlugins;
  return JSON.stringify(parsed, null, 2) + "\n";
}

// Move an MCP server entry between `mcpServers` and `mcpServers_disabled`.
// `enable=true` → take from disabled, put in enabled. `enable=false` → vice
// versa. Preserves the rest of the file shape.
export function applyMcpToggle(
  current: string,
  serverName: string,
  enable: boolean,
): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(current || "{}") as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  const enabled = (parsed.mcpServers ?? {}) as Record<string, unknown>;
  const disabled = (parsed.mcpServers_disabled ?? {}) as Record<string, unknown>;
  if (enable) {
    if (serverName in disabled) {
      enabled[serverName] = disabled[serverName];
      delete disabled[serverName];
    }
  } else {
    if (serverName in enabled) {
      disabled[serverName] = enabled[serverName];
      delete enabled[serverName];
    }
  }
  parsed.mcpServers = enabled;
  if (Object.keys(disabled).length > 0) {
    parsed.mcpServers_disabled = disabled;
  } else {
    delete parsed.mcpServers_disabled;
  }
  return JSON.stringify(parsed, null, 2) + "\n";
}
