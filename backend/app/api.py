"""HTTP routers — read-only on most endpoints; Phase 2 adds preview + write."""
from __future__ import annotations

import asyncio
import difflib
import json
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request
from sse_starlette.sse import EventSourceResponse

from . import config, scanner, writer
from .models import (
    CwdEntry,
    ExtensionsResponse,
    FileReadResponse,
    IndexResponse,
    McpCard,
    PendingWrite,
    PluginCard,
    PreviewRequest,
    PreviewResponse,
    SimulatorResponse,
    SkillCard,
    UiState,
    WriteRequest,
    WriteResponse,
)
from .resolver import parsed_for_path
from .simulator import simulate
from .state import load as state_load
from .state import save as state_save
from .watcher import IndexCache

# In-memory pending-write store. TTL = 5 min, lazy-expired on read. Lives at
# module scope deliberately — uvicorn workers run in a single process; we
# don't need anything more durable for a personal tool, and it dies on every
# backend restart (which is the desired behaviour: stale tokens get purged).
PENDING_WRITES: dict[str, PendingWrite] = {}
PENDING_WRITE_TTL = timedelta(minutes=5)

# Allowed creation zones — we let the user create new files only in these
# subtrees. Everywhere else, /api/preview rejects creation requests with 403.
# Resolved at module import; lookups normalise the proposed path through
# `expanduser().resolve()` first.
_CREATION_ALLOWED_ROOTS = (
    config.CLAUDE_DIR / "rules",
    config.CLAUDE_DIR / "knowledge",
)


def _is_under_allowed_creation_zone(target: Path) -> bool:
    """True if `target` lives under any allowed creation root, including
    project-zone `<cwd>/.claude/rules/`. Both the static user-level roots
    above and per-cwd rules dirs are allowed."""
    try:
        resolved = target.resolve()
    except OSError:
        return False
    for root in _CREATION_ALLOWED_ROOTS:
        try:
            resolved.relative_to(root)
            return True
        except ValueError:
            continue
    # Per-cwd rules directories. Re-derive on every call so a cwd added
    # mid-session also qualifies.
    for cwd in scanner.discover_cwds():
        per_repo_rules = (cwd / ".claude" / "rules").resolve()
        try:
            resolved.relative_to(per_repo_rules)
            return True
        except ValueError:
            continue
    return False


def _purge_expired_pending() -> None:
    """Lazy expiry — drops every PENDING_WRITES entry older than TTL."""
    now = datetime.now(timezone.utc)
    expired = [
        token for token, pw in PENDING_WRITES.items()
        if now - pw.created_at > PENDING_WRITE_TTL
    ]
    for token in expired:
        PENDING_WRITES.pop(token, None)

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


@router.post("/preview", response_model=PreviewResponse)
def post_preview(req: Request, body: PreviewRequest) -> PreviewResponse:
    """Dry-run a write. Validates target, computes a unified diff against the
    current on-disk content (or empty string for creation), stores a 5-min
    pending-write token, and returns the diff for the frontend to confirm.

    Phase 2 invariant: every write must be preceded by a preview. The token
    is bound to the new content + base hash so a hash mismatch on the actual
    write rejects with 409.
    """
    _purge_expired_pending()
    target = Path(body.path).expanduser().resolve()
    files, _, _ = _cache(req).snapshot()
    in_scope = {Path(f.path): f for f in files}

    is_creation = not target.is_file()

    if is_creation:
        if not _is_under_allowed_creation_zone(target):
            raise HTTPException(
                status_code=403,
                detail=(
                    "creation only allowed under ~/.claude/rules/, "
                    "~/.claude/knowledge/, or <cwd>/.claude/rules/"
                ),
            )
        current = ""
        base_hash = writer.compute_content_hash("")
    else:
        entry = in_scope.get(target)
        if entry is None:
            raise HTTPException(
                status_code=400,
                detail=f"path not in scanned set: {body.path}",
            )
        if not entry.writable:
            raise HTTPException(
                status_code=403,
                detail=f"file kind '{entry.kind}' is not writable",
            )
        try:
            current = target.read_text(encoding="utf-8")
        except OSError as e:
            raise HTTPException(status_code=500, detail=f"read error: {e}")
        base_hash = writer.compute_content_hash(current)

    diff_lines = difflib.unified_diff(
        current.splitlines(keepends=True),
        body.new_content.splitlines(keepends=True),
        fromfile=f"a/{config.collapse_home(target)}",
        tofile=f"b/{config.collapse_home(target)}",
        n=3,
    )
    diff = "".join(diff_lines)

    confirm_token = uuid.uuid4().hex
    PENDING_WRITES[confirm_token] = PendingWrite(
        path=str(target),
        new_content=body.new_content,
        base_hash=base_hash,
        is_creation=is_creation,
        created_at=datetime.now(timezone.utc),
    )
    return PreviewResponse(
        confirm_token=confirm_token,
        diff=diff,
        base_hash=base_hash,
        is_creation=is_creation,
    )


@router.post("/write", response_model=WriteResponse)
def post_write(req: Request, body: WriteRequest) -> WriteResponse:
    """Commit a previewed write. Re-checks current hash against the token's
    `base_hash` (409 on mismatch), takes a snapshot, then atomically replaces
    the file. Snapshot-before-write is non-negotiable — if the snapshot fails
    we abort.
    """
    _purge_expired_pending()
    pending = PENDING_WRITES.get(body.confirm_token)
    if pending is None:
        raise HTTPException(status_code=404, detail="confirm_token unknown or expired")

    target = Path(pending.path)
    if not pending.is_creation:
        # Re-read current content. If file vanished between preview and write
        # we treat it as a hard conflict — refuse to recreate silently.
        if not target.is_file():
            raise HTTPException(
                status_code=409,
                detail="file was deleted after preview; aborting to be safe",
            )
        current_hash = writer.read_current_hash(target)
        if current_hash != pending.base_hash:
            raise HTTPException(
                status_code=409,
                detail="file changed on disk after preview; re-preview required",
            )
    else:
        # Creation case: if the file appeared on disk between preview and
        # write we also refuse — somebody else created it first.
        if target.is_file():
            raise HTTPException(
                status_code=409,
                detail="file appeared on disk after preview; re-preview required",
            )

    try:
        snapshot_id = writer.take_snapshot(target)
    except OSError as e:
        raise HTTPException(
            status_code=500,
            detail=f"snapshot failed, write aborted: {e}",
        )

    try:
        writer.atomic_write(target, pending.new_content)
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"write failed: {e}")

    # Trigger an immediate reindex so the file's new content / new node shows
    # up without waiting for the watcher's debounce to fire.
    try:
        _cache(req).rebuild_sync()
    except Exception:
        # A rebuild failure shouldn't undo a successful write — log and move on.
        pass

    PENDING_WRITES.pop(body.confirm_token, None)
    return WriteResponse(written=True, snapshot_id=snapshot_id)


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
