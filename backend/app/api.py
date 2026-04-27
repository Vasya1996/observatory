"""HTTP routers — read-only in MVP."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request
from sse_starlette.sse import EventSourceResponse

from . import config, scanner
from .models import (
    CwdEntry,
    ExtensionsResponse,
    FileReadResponse,
    IndexResponse,
    McpCard,
    PluginCard,
    SimulatorResponse,
    SkillCard,
    UiState,
)
from .resolver import parsed_for_path
from .simulator import simulate
from .state import load as state_load
from .state import save as state_save
from .watcher import IndexCache

router = APIRouter()


def _cache(req: Request) -> IndexCache:
    return req.app.state.index_cache  # type: ignore[no-any-return]


@router.get("/index", response_model=IndexResponse)
def get_index(req: Request) -> IndexResponse:
    files, edges, _ = _cache(req).snapshot()
    return IndexResponse(files=files, edges=edges)


@router.get("/cwds", response_model=list[CwdEntry])
def get_cwds() -> list[CwdEntry]:
    return [
        CwdEntry(path=str(p), display=config.collapse_home(p))
        for p in scanner.discover_cwds()
    ]


@router.get("/simulate", response_model=SimulatorResponse)
def get_simulate(req: Request, cwd: str = Query(...)) -> SimulatorResponse:
    p = Path(cwd).expanduser()
    if not p.is_dir():
        raise HTTPException(status_code=400, detail=f"cwd not a directory: {cwd}")
    files, edges, _ = _cache(req).snapshot()
    return simulate(p.resolve(), files, edges)


@router.get("/file", response_model=FileReadResponse)
def get_file(req: Request, path: str = Query(...)) -> FileReadResponse:
    p = Path(path).expanduser().resolve()
    files, _, _ = _cache(req).snapshot()
    in_scope = {Path(f.path) for f in files}
    if p not in in_scope:
        raise HTTPException(
            status_code=400, detail=f"path not in scanned set: {path}",
        )
    parsed = parsed_for_path(p)
    if parsed is None:
        raise HTTPException(status_code=404, detail="file not found in index")
    try:
        content = p.read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"read error: {e}")
    return FileReadResponse(
        path=str(p),
        display=config.collapse_home(p),
        content=content,
        frontmatter=parsed.frontmatter,
        validation=parsed.issues,
    )


@router.get("/extensions", response_model=ExtensionsResponse)
def get_extensions(req: Request) -> ExtensionsResponse:
    files, _, _ = _cache(req).snapshot()

    # Skills come from plugin manifests (skills[] with enabled flag).
    skills: list[SkillCard] = []
    for f in files:
        if f.kind != "plugin_manifest":
            continue
        try:
            data = json.loads(Path(f.path).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        plugin_id = data.get("name") or Path(f.path).parent.name
        for s in data.get("skills") or []:
            skills.append(
                SkillCard(
                    plugin_id=plugin_id,
                    name=s.get("name", "<unnamed>"),
                    description=s.get("description"),
                    enabled=bool(s.get("enabled", True)),
                    manifest_path=f.path,
                )
            )

    # Plugins: cross-reference settings.json#enabledPlugins with installed registry.
    settings_path = config.CLAUDE_DIR / "settings.json"
    enabled_map: dict[str, bool] = {}
    if settings_path.is_file():
        try:
            settings = json.loads(settings_path.read_text(encoding="utf-8"))
            enabled_map = settings.get("enabledPlugins") or {}
        except (OSError, json.JSONDecodeError):
            pass

    installed_path = config.CLAUDE_DIR / "plugins" / "installed_plugins.json"
    installed_keys: set[str] = set()
    if installed_path.is_file():
        try:
            inst = json.loads(installed_path.read_text(encoding="utf-8"))
            if isinstance(inst, dict):
                installed_keys = set(inst.keys())
        except (OSError, json.JSONDecodeError):
            pass

    plugins: list[PluginCard] = []
    for key in sorted(set(enabled_map.keys()) | installed_keys):
        plugin_id, _, marketplace = key.partition("@")
        plugins.append(
            PluginCard(
                plugin_key=key,
                plugin_id=plugin_id or None,
                marketplace=marketplace or None,
                enabled=bool(enabled_map.get(key, False)),
                installed=key in installed_keys,
            )
        )

    # MCP servers — keys in mcpServers map.
    mcp: list[McpCard] = []
    mcp_path = config.CLAUDE_DIR / ".mcp.json"
    if mcp_path.is_file():
        try:
            data = json.loads(mcp_path.read_text(encoding="utf-8"))
            servers = data.get("mcpServers") or {}
            for name, cfg in servers.items():
                mcp.append(McpCard(name=name, config=cfg))
        except (OSError, json.JSONDecodeError):
            pass

    return ExtensionsResponse(skills=skills, plugins=plugins, mcp=mcp)


@router.get("/state", response_model=UiState)
def get_state() -> UiState:
    return state_load()


@router.post("/state", response_model=UiState)
def post_state(state: UiState) -> UiState:
    state_save(state)
    return state


@router.get("/events")
async def get_events(req: Request) -> EventSourceResponse:
    cache = _cache(req)

    async def gen():
        q = cache.subscribe()
        try:
            # Send initial hello so the client knows it's connected.
            yield {"event": "hello", "data": json.dumps({"ok": True})}
            while True:
                if await req.is_disconnected():
                    break
                try:
                    payload = await asyncio.wait_for(q.get(), timeout=15.0)
                    yield {"event": payload.get("type", "message"),
                           "data": json.dumps(payload)}
                except asyncio.TimeoutError:
                    # Heartbeat — keeps the connection alive through proxies.
                    yield {"event": "ping", "data": "{}"}
        finally:
            cache.unsubscribe(q)

    return EventSourceResponse(gen())
