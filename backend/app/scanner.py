"""File scanner — collect every file that influences a Claude Code session.

The scanner is the source of truth for "what exists". It returns a flat list of
`RawFile` records (path + kind + readonly flag); the parser/resolver build on
this set. `(path → kind)` is decided here so the rest of the pipeline never has
to re-classify by extension or location.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional

from . import config
from .models import FileKind


@dataclass(frozen=True)
class RawFile:
    path: Path
    kind: FileKind
    readonly: bool = False
    # Optional display label that overrides whatever the parser would derive.
    # Used for LSP-style plugins that ship a README.md but no plugin.json —
    # we want them on the graph by their registry name, not "README.md".
    display_name_override: Optional[str] = None
    # Number of cached snapshots this RawFile represents. >1 only for collapsed
    # plugin manifests under ~/.claude/remote/plugins/<hash>/ — Claude Code
    # keeps every fetched manifest version, so a single logical plugin can
    # have N copies on disk. The graph shows one node per logical name; the
    # inspector can surface this count.
    cached_versions: int = 1


def _exists_file(p: Path) -> bool:
    try:
        return p.is_file()
    except OSError:
        return False


def _glob(directory: Path, pattern: str) -> Iterable[Path]:
    if not directory.is_dir():
        return []
    return sorted(directory.glob(pattern))


def _read_plugin_name(plugin_json: Path) -> Optional[str]:
    """Extract the canonical plugin `name` from a `.claude-plugin/plugin.json`.
    Returns None if the file is absent or unreadable.
    """
    if not _exists_file(plugin_json):
        return None
    try:
        import json
        with plugin_json.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    name = data.get("name") if isinstance(data, dict) else None
    return name if isinstance(name, str) and name else None


def _safe_mtime(p: Path) -> float:
    try:
        return p.stat().st_mtime
    except OSError:
        return 0.0


def scan() -> list[RawFile]:
    """Walk the in-scope set defined in `config` and return raw file records."""
    out: list[RawFile] = []

    # Top-level CLAUDE.md files.
    for p, kind in [
        (config.HOME / "CLAUDE.md", "claude_md"),
        (config.CLAUDE_DIR / "CLAUDE.md", "claude_md"),
    ]:
        if _exists_file(p):
            out.append(RawFile(p, kind))

    # Global rules.
    for p in _glob(config.CLAUDE_DIR / "rules", "*.md"):
        if not config.is_blacklisted(p):
            out.append(RawFile(p, "rule"))

    # Knowledge: MEMORY.md and per-scope memory files.
    knowledge = config.CLAUDE_DIR / "knowledge"
    memory_index = knowledge / "MEMORY.md"
    if _exists_file(memory_index):
        out.append(RawFile(memory_index, "memory_index"))
    for p in _glob(knowledge, "*.md"):
        if p.name == "MEMORY.md":
            continue
        if not config.is_blacklisted(p):
            out.append(RawFile(p, "memory"))

    # Skills (opportunistic — directory may be absent).
    skills_root = config.CLAUDE_DIR / "skills"
    if skills_root.is_dir():
        for skill_dir in sorted(p for p in skills_root.iterdir() if p.is_dir()):
            skill_md = skill_dir / "SKILL.md"
            if _exists_file(skill_md):
                out.append(RawFile(skill_md, "skill"))

    # Plugin manifests under ~/.claude/remote/plugins/<hash>/. Each plugin can
    # have many version snapshots; Claude Code never garbage-collects them.
    # Collapse by canonical name (from sibling .claude-plugin/plugin.json):
    # one RawFile per logical plugin, representative = most-recently-touched
    # snapshot. cached_versions carries the original count for the inspector.
    #
    # Two file shapes coexist under <hash>/:
    #   * `manifest.json` (anthropic-skills) — Claude-Code-managed, with
    #     skills[] enabled flags. Preferred representative when present.
    #   * No `manifest.json` (design plugin from desktop app) — only
    #     `.claude-plugin/plugin.json` + `.mcp.json`. Fall back to plugin.json.
    plugins_root = config.CLAUDE_DIR / "remote" / "plugins"
    if plugins_root.is_dir():
        grouped: dict[str, list[Path]] = {}
        unnamed: list[Path] = []
        for plug_dir in sorted(p for p in plugins_root.iterdir() if p.is_dir()):
            mf = plug_dir / "manifest.json"
            plugin_json = plug_dir / ".claude-plugin" / "plugin.json"
            representative = mf if _exists_file(mf) else (
                plugin_json if _exists_file(plugin_json) else None
            )
            if representative is None:
                continue
            name = _read_plugin_name(plugin_json)
            if name:
                grouped.setdefault(name, []).append(representative)
            else:
                unnamed.append(representative)
        for manifests in grouped.values():
            canonical = max(manifests, key=_safe_mtime)
            out.append(
                RawFile(
                    canonical,
                    "plugin_manifest",
                    cached_versions=len(manifests),
                )
            )
        for mf in unnamed:
            out.append(RawFile(mf, "plugin_manifest"))

    # Plugin registry.
    plugin_registry = config.CLAUDE_DIR / "plugins" / "installed_plugins.json"
    if _exists_file(plugin_registry):
        out.append(RawFile(plugin_registry, "plugin_registry"))

    # User-installed plugins. Their files live under `plugins/cache/...` which
    # is blacklisted (would drown the graph in LICENSE/README/screenshots) — but
    # we still want each plugin's identity on the graph. Hand-pick: only the
    # `plugin.json` (canonical name + version) per installed plugin, sourced
    # from the registry's installPath. Skills/commands inside each plugin are
    # ignored for now; surfacing them needs a separate UX decision.
    out.extend(_scan_user_plugins(plugin_registry))

    # Settings — global + machine-local. Both can carry hook/statusLine
    # definitions; the resolver merges hook refs from either source.
    for settings_file in [
        config.CLAUDE_DIR / "settings.json",
        config.CLAUDE_DIR / "settings.local.json",
    ]:
        if _exists_file(settings_file):
            out.append(RawFile(settings_file, "settings"))

    # MCP.
    mcp = config.CLAUDE_DIR / ".mcp.json"
    if _exists_file(mcp):
        out.append(RawFile(mcp, "mcp"))

    # Project-zone scan: for each discovered cwd, surface its top-level
    # Claude config files. Targeted reads — no directory walks.
    for cwd in discover_cwds():
        out.extend(_scan_project_zone(cwd))

    # Auto-memory zone (read-only).
    # Each project gets ~/.claude/projects/<project>/memory/ — scan all of them.
    # Limit to *.md files inside each memory/ subdir to avoid session logs.
    projects_dir = config.CLAUDE_DIR / "projects"
    if projects_dir.is_dir():
        try:
            project_dirs = sorted(
                d for d in projects_dir.iterdir() if d.is_dir()
            )
        except OSError:
            project_dirs = []
        for proj_dir in project_dirs:
            memory_dir = proj_dir / "memory"
            if memory_dir.is_dir():
                for p in _glob(memory_dir, "*.md"):
                    if not config.is_blacklisted(p):
                        out.append(RawFile(p, "automemory", readonly=True))

    return out


def _scan_project_zone(cwd: Path) -> list[RawFile]:
    """Surface project-level Claude config locations under `cwd`:

    * `<cwd>/CLAUDE.md` — project-level top
    * `<cwd>/CLAUDE.local.md` — local-override sibling (deprecated by Claude
      docs but still loaded)
    * `<cwd>/.claude/CLAUDE.md` — team-shared project instructions
    * `<cwd>/.claude/rules/*.md` — project-level rules (paths: support same
      as user-level rules; resolver/parser are kind-driven, not path-driven)
    * `<cwd>/<subdir>/CLAUDE.md` — nested per-subdirectory CLAUDE.md (per
      Claude Code docs these load on-demand when reading files in that
      subtree, NOT at session start). Surfaced as graph nodes so Vasya's
      `~/Claude/{project,global}/CLAUDE.md` and any monorepo-style nested
      CLAUDE.md become visible. Single level of `iterdir()` only — no deep
      walk; node_modules / .git / etc don't get descended into because we
      only probe direct subdirs for `CLAUDE.md` and stop.

    Targeted reads only. Blacklist (rule #5) still applies.
    """
    out: list[RawFile] = []
    for p in [
        cwd / "CLAUDE.md",
        cwd / "CLAUDE.local.md",
        cwd / ".claude" / "CLAUDE.md",
    ]:
        if _exists_file(p) and not config.is_blacklisted(p):
            out.append(RawFile(p, "claude_md"))
    # AGENTS.md is NOT auto-loaded by Claude Code — it only loads via an
    # explicit `@AGENTS.md` import in CLAUDE.md (item 10 in the 37-item plan).
    # Surfaced as a graph node so the user can see it; the simulator leaves it
    # as an orphan unless there is an @AGENTS.md import in a loaded file.
    agents_md = cwd / "AGENTS.md"
    if _exists_file(agents_md) and not config.is_blacklisted(agents_md):
        out.append(RawFile(agents_md, "claude_md", readonly=True))
    for p in _glob(cwd / ".claude" / "rules", "*.md"):
        if not config.is_blacklisted(p):
            out.append(RawFile(p, "rule"))
    # Nested CLAUDE.md one level deeper. Dotted dirs (.git, .venv, .claude
    # which is already covered above) are skipped — they're plumbing, never
    # session targets.
    try:
        subdirs = list(cwd.iterdir())
    except OSError:
        subdirs = []
    for sub in sorted(subdirs, key=lambda p: p.name):
        if not sub.is_dir():
            continue
        if sub.name.startswith("."):
            continue
        if config.is_blacklisted(sub):
            continue
        nested = sub / "CLAUDE.md"
        if _exists_file(nested):
            out.append(RawFile(nested, "claude_md"))
    return out


def _scan_user_plugins(registry: Path) -> list[RawFile]:
    """Resolve each installed plugin from `installed_plugins.json` to a single
    representative file on the graph.

    Preferred target: `<installPath>/.claude-plugin/plugin.json` — carries the
    canonical name + version. Fallback (LSP-style plugins that ship neither
    skills nor commands): `<installPath>/README.md`, with the plugin name
    pulled from the registry key (`<plugin>@<marketplace>`) so the graph node
    is still labelled correctly.

    Bypasses the blacklist deliberately — targets exact files, not a directory
    walk, so the "thousands of files" risk doesn't apply.
    """
    if not _exists_file(registry):
        return []
    try:
        import json
        with registry.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return []
    plugins = data.get("plugins") if isinstance(data, dict) else None
    if not isinstance(plugins, dict):
        return []
    out: list[RawFile] = []
    seen: set[Path] = set()
    for registry_key, entries in plugins.items():
        if not isinstance(entries, list):
            continue
        # registry_key shape: "<plugin>@<marketplace>"
        plugin_name = (
            registry_key.split("@", 1)[0]
            if isinstance(registry_key, str) and "@" in registry_key
            else (registry_key if isinstance(registry_key, str) else None)
        )
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            install_path = entry.get("installPath")
            if not isinstance(install_path, str) or not install_path:
                continue
            base = Path(install_path)
            plugin_json = base / ".claude-plugin" / "plugin.json"
            if _exists_file(plugin_json):
                if plugin_json in seen:
                    continue
                seen.add(plugin_json)
                # plugin.json carries its own name; no override needed.
                out.append(RawFile(plugin_json, "plugin_manifest"))
                continue
            readme = base / "README.md"
            if _exists_file(readme) and plugin_name:
                if readme in seen:
                    continue
                seen.add(readme)
                out.append(
                    RawFile(
                        readme,
                        "plugin_manifest",
                        readonly=True,
                        display_name_override=plugin_name,
                    )
                )
    return out


def scan_roots() -> list[tuple[Path, bool]]:
    """`(path, recursive)` tuples for the watcher to observe.

    Returned paths are guaranteed to exist; absent dirs are skipped so watchdog
    doesn't crash on missing roots.

    `recursive=False` is used for huge directories where we only care about
    a few specific files at the top level — `~` (we only want `~/CLAUDE.md`)
    and each project cwd (only `<cwd>/CLAUDE.md` + `<cwd>/CLAUDE.local.md`,
    not the entire repo subtree which can blow past inotify watch limits on
    large checkouts with `node_modules`/`.git`/etc).
    """
    # Collect all <project>/memory/ dirs to watch (non-recursive per dir —
    # memory dirs are small and managed by Claude Code, not by the user).
    auto_memory_watches: list[tuple[Path, bool]] = []
    projects_dir = config.CLAUDE_DIR / "projects"
    if projects_dir.is_dir():
        try:
            for proj_dir in sorted(d for d in projects_dir.iterdir() if d.is_dir()):
                mem_dir = proj_dir / "memory"
                if mem_dir.is_dir():
                    auto_memory_watches.append((mem_dir, False))
        except OSError:
            pass

    candidates: list[tuple[Path, bool]] = [
        (config.HOME, False),  # ~/CLAUDE.md only — we filter events in the watcher
        (config.CLAUDE_DIR, True),
        (config.CLAUDE_DIR / "rules", True),
        (config.CLAUDE_DIR / "knowledge", True),
        (config.CLAUDE_DIR / "skills", True),
        (config.CLAUDE_DIR / "remote" / "plugins", True),
        (config.CLAUDE_DIR / "plugins", True),
        *auto_memory_watches,
    ]
    # Project-zone roots: top-level non-recursive (catches CLAUDE.md and
    # CLAUDE.local.md edits without watching the entire repo); the rules dir
    # gets a separate recursive watch since it's small. Subdirectories that
    # already contain a nested CLAUDE.md also get a non-recursive watch so
    # edits to those files trigger reindex without watching the whole repo
    # tree (which would blow past inotify limits in repos with node_modules).
    for cwd in discover_cwds():
        candidates.append((cwd, False))
        candidates.append((cwd / ".claude" / "rules", True))
        try:
            subdirs = list(cwd.iterdir()) if cwd.is_dir() else []
        except OSError:
            subdirs = []
        for sub in subdirs:
            if not sub.is_dir() or sub.name.startswith("."):
                continue
            try:
                if config.is_blacklisted(sub):
                    continue
            except OSError:
                continue
            if (sub / "CLAUDE.md").is_file():
                candidates.append((sub, False))
    seen: set[Path] = set()
    out: list[tuple[Path, bool]] = []
    for c, recursive in candidates:
        try:
            if c.is_dir() and c not in seen:
                seen.add(c)
                out.append((c, recursive))
        except OSError:
            continue
    return out


def discover_cwds() -> list[Path]:
    """Every direct, non-hidden child of `~/` — the same set the Claude Code
    desktop file picker shows.

    Hidden dirs (dotfile stashes, `.claude` user-config, `.cache`, `.ssh`,
    etc.) are excluded — those are configuration / OS plumbing, never
    session targets. Everything else under `~/` is included regardless of
    whether it has Claude config: the user might run a session in a fresh
    bare folder and want Observatory to show them what's missing. A
    follow-up commit will tag each entry with a setup status
    (configured / git-only / bare) so the UI can sort and badge them.

    Alphabetical by name for stable UI.
    """
    home = config.HOME
    found: list[Path] = []
    try:
        entries = list(home.iterdir())
    except (PermissionError, OSError):
        return found
    for e in entries:
        if not e.is_dir():
            continue
        if e.name.startswith("."):
            continue
        if e.name in config.DISCOVERY_SKIP_DIRS:
            continue
        if config.is_blacklisted(e):
            continue
        found.append(e)
    return sorted(found, key=lambda p: p.name.lower())
