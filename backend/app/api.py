"""HTTP routers — read-only on most endpoints; Phase 2 adds preview + write."""
from __future__ import annotations

import asyncio
import difflib
import json
import os
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request
from sse_starlette.sse import EventSourceResponse

from . import canonical, config, paths_proposals, scanner, tier2, writer
from .markdown_merge import plan_merge
from .models import (
    AutoloadMechanism,
    AutoloadTogglePreviewResponse,
    AutoloadToggleRequest,
    CommittedFile,
    CwdEntry,
    DeleteConfirmRequest,
    DeleteConfirmResponse,
    DeletePreviewRequest,
    DeletePreviewResponse,
    DeleteUndoRequest,
    DeleteUndoResponse,
    ExtensionsResponse,
    FileReadResponse,
    ImportRef,
    IndexResponse,
    McpCard,
    MigrateFilePlan,
    MigrateFinalizeRequest,
    MigrateFinalizeResponse,
    MigratePlan,
    MigratePreviewRequest,
    MigratePreviewResponse,
    NonCanonicalEntry,
    NonCanonicalWithSuppressResponse,
    PathProposalsResponse,
    PendingWrite,
    PluginCard,
    PreviewRequest,
    PreviewResponse,
    RestoreFromSnapshotRequest,
    RestoreFromSnapshotResponse,
    SimDiffResult,
    SimulatorResponse,
    SkillCard,
    SuppressedResponse,
    SuppressRequest,
    UiState,
    WriteRequest,
    WriteResponse,
)
from .orphan_imports import find_importers
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

# In-memory pending-delete store. Same TTL mechanics as PENDING_WRITES.
# {confirm_token: {"path": str, "snapshot_id": str, "created_at": datetime}}
PENDING_DELETES: dict[str, dict] = {}

# Maps migration_id -> list of confirm_tokens that belong to that batch.
# Used to verify whether a failing write is part of a migration batch.
MIGRATION_TOKENS: dict[str, list[str]] = {}

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

# ---------------------------------------------------------------------------
# Frontmatter rewriting helpers (used by add-paths / remove-paths modes).
# ---------------------------------------------------------------------------

import re as _re
import yaml as _yaml


def _split_frontmatter(text: str) -> tuple[dict, str]:
    """Split a file into (frontmatter_dict, body_text).

    Body includes everything after the closing `---`. Returns ({}, text) when
    there is no leading frontmatter block.
    """
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end == -1:
        return {}, text
    fm_block = text[3:end].strip()
    body = text[end + 4:]  # skip the trailing `---\n`
    try:
        fm = _yaml.safe_load(fm_block) or {}
    except _yaml.YAMLError:
        fm = {}
    return fm, body


def _emit_frontmatter(fm: dict, body: str) -> str:
    """Reassemble frontmatter + body into a full file string.

    Uses yaml.dump with default_flow_style=False and allow_unicode so the
    output is readable. Keys are written in the order they appear in `fm`
    (Python 3.7+ dict ordering). A trailing newline is added when body does
    not start with one.
    """
    dumped = _yaml.dump(fm, default_flow_style=False, allow_unicode=True).rstrip()
    return f"---\n{dumped}\n---{body}"


def _rewrite_paths_globs(source_body: str, new_globs: list[str] | None) -> str:
    """Return `source_body` with the `paths:` frontmatter key set to
    `new_globs`. Passing None removes the key entirely.

    Preserves all other frontmatter keys verbatim. Adds a frontmatter block
    if the file has none.
    """
    fm, body = _split_frontmatter(source_body)
    if new_globs is None:
        fm.pop("paths", None)
    else:
        fm["paths"] = new_globs
    if not fm:
        # All keys removed; strip frontmatter block entirely.
        return body.lstrip("\n")
    return _emit_frontmatter(fm, body)


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


@router.get("/paths-proposals", response_model=PathProposalsResponse)
def get_paths_proposals(req: Request) -> PathProposalsResponse:
    """Auto-rewrite proposals for rules whose `paths:` globs became broken.

    Computed lazily on each call — the frontend polls this after every SSE
    `reindex` event (locked answer 15: trigger on each reindex). The actual
    write still flows through `/api/preview` → `/api/write` (locked rule #36).
    """
    files, _, _ = _cache(req).snapshot()
    return PathProposalsResponse(
        proposals=paths_proposals.compute_proposals(files),
    )


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

    # Item 17: refuse to edit the managed-policy CLAUDE.md without elevated
    # privileges. The managed path is OS-specific (see config.py); it's
    # typically owned by root/admin and requires sudo to modify.
    managed_path = config.os_managed_claude_md_path()
    try:
        if target == managed_path.resolve():
            raise HTTPException(
                status_code=403,
                detail=(
                    "Managed-policy CLAUDE.md cannot be edited through Observatory. "
                    "It requires elevated privileges (sudo). "
                    f"Path: {managed_path}"
                ),
            )
    except OSError:
        pass

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

    When migration_id is provided the snapshot is tracked under that batch id.
    On write failure the handler restores all already-written files in the
    batch via best-effort rollback (reverse order).
    """
    _purge_expired_pending()
    pending = PENDING_WRITES.get(body.confirm_token)
    if pending is None:
        raise HTTPException(status_code=404, detail="confirm_token unknown or expired")

    migration_id = body.migration_id
    target = Path(pending.path)
    if not pending.is_creation:
        # Re-read current content. If file vanished between preview and write
        # we treat it as a hard conflict — refuse to recreate silently.
        if not target.is_file():
            if migration_id:
                writer.rollback_migration(migration_id)
                MIGRATION_TOKENS.pop(migration_id, None)
            raise HTTPException(
                status_code=409,
                detail="file was deleted after preview; aborting to be safe",
            )
        current_hash = writer.read_current_hash(target)
        if current_hash != pending.base_hash:
            if migration_id:
                writer.rollback_migration(migration_id)
                MIGRATION_TOKENS.pop(migration_id, None)
            raise HTTPException(
                status_code=409,
                detail="file changed on disk after preview; re-preview required",
            )
    else:
        # Creation case: if the file appeared on disk between preview and
        # write we also refuse — somebody else created it first.
        if target.is_file():
            if migration_id:
                writer.rollback_migration(migration_id)
                MIGRATION_TOKENS.pop(migration_id, None)
            raise HTTPException(
                status_code=409,
                detail="file appeared on disk after preview; re-preview required",
            )

    try:
        snapshot_id = writer.take_snapshot(target, migration_id=migration_id)
    except OSError as e:
        if migration_id:
            writer.rollback_migration(migration_id)
            MIGRATION_TOKENS.pop(migration_id, None)
        raise HTTPException(
            status_code=500,
            detail=f"snapshot failed, write aborted: {e}",
        )

    try:
        writer.atomic_write(target, pending.new_content)
    except OSError as e:
        if migration_id:
            writer.rollback_migration(migration_id)
            MIGRATION_TOKENS.pop(migration_id, None)
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


@router.get("/non-canonical", response_model=NonCanonicalWithSuppressResponse)
def get_non_canonical(req: Request, cwd: str = Query(...)) -> NonCanonicalWithSuppressResponse:
    """List loaded files that don't live at their canonical slot path for the given cwd.

    Uses simulate(cwd) to get the load chain, then classifies each loaded/conditional
    file against the canonical slot patterns from Phase 3 plan section 1.
    """
    p = Path(cwd).expanduser()
    if not p.is_dir():
        raise HTTPException(status_code=400, detail=f"cwd not a directory: {cwd}")
    files, edges, _ = _cache(req).snapshot()
    cwd_resolved = p.resolve()
    from .simulator import simulate as _simulate
    sim_resp = _simulate(cwd_resolved, files, edges)

    # Build lookups from display path and abs path → file entry.
    by_display: dict[str, str] = {f.display: f.path for f in files}
    by_path: dict[str, str] = {f.path: f.kind for f in files}  # abs_path → kind

    entries: list[NonCanonicalEntry] = []
    for step in sim_resp.steps:
        if step.status not in ("loaded", "conditional"):
            continue
        # Resolve display path to absolute for kind lookup.
        fp_raw = step.file_path
        if fp_raw.startswith("~/") or fp_raw == "~":
            fp_abs_str = str((Path.home() / fp_raw[2:]).resolve())
        else:
            fp_abs_str = str(Path(fp_raw).resolve())
        step_kind = by_path.get(fp_abs_str)
        slot, is_canon, canon_path, reason = canonical.classify_step(
            step.file_path, step.matched_on, step.status, cwd_resolved, kind=step_kind
        )
        if is_canon:
            continue
        # Resolve importer from matched_on hint for @import case.
        importer_path: str | None = None
        importer_line: int | None = None
        if reason == "loaded_via_at_import" and step.reason:
            # reason text: "Imported via @ from <display>:<line>"
            m = _re.search(r"from (.+?)(?::(\d+))?$", step.reason)
            if m:
                imp_display = m.group(1)
                importer_path = by_display.get(imp_display, imp_display)
                if m.group(2):
                    importer_line = int(m.group(2))
        entries.append(
            NonCanonicalEntry(
                file_path=fp_abs_str,
                slot=slot,
                canonical_path=canon_path,
                reason=reason,  # type: ignore[arg-type]
                importer_path=importer_path,
                importer_line=importer_line,
            )
        )
    suppressed_cwds = writer.load_suppressed()
    is_suppressed = str(cwd_resolved) in suppressed_cwds

    from .scanner import discover_cwds as _discover_cwds
    all_cwds = [Path(c).resolve() for c in _discover_cwds()]
    orphan_configs = canonical.find_orphan_configs(files, all_cwds)

    return NonCanonicalWithSuppressResponse(
        non_canonical=entries,
        orphan_configs=orphan_configs,
        suppressed=is_suppressed,
    )


@router.get("/suppressed", response_model=SuppressedResponse)
def get_suppressed() -> SuppressedResponse:
    """Return the list of cwds the user has marked as intentionally non-canonical.

    Frontend reads this to decide whether to show the yellow non-canonical badge.
    """
    return SuppressedResponse(suppressed_cwds=writer.load_suppressed())


@router.post("/suppress", response_model=SuppressedResponse)
def post_suppress(body: SuppressRequest) -> SuppressedResponse:
    """Add or remove a cwd from the suppress list.

    body.suppressed=true  → add cwd to the list (stop nagging).
    body.suppressed=false → remove cwd from the list (re-enable badge).

    No DiffModal needed — this is a UI-state flag, not a config write to the
    user's Claude setup. Returns the updated suppressed_cwds list.
    """
    cwd_abs = str(Path(body.cwd).expanduser().resolve())
    current = writer.load_suppressed()
    if body.suppressed:
        updated = sorted(set(current) | {cwd_abs})
    else:
        updated = [c for c in current if c != cwd_abs]
    try:
        writer.save_suppressed(updated)
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"failed to save suppress list: {e}")
    return SuppressedResponse(suppressed_cwds=updated)


@router.post("/migrate-preview", response_model=MigratePreviewResponse)
def post_migrate_preview(
    req: Request, body: MigratePreviewRequest
) -> MigratePreviewResponse:
    """Compute a multi-file migration plan and run Tier 1 verifications.

    rule mode:  create ~/.claude/rules/<new_filename> with source body,
                remove @-import line in original importer (if any),
                optionally delete source.
    merge mode: append source into target using plan_merge(),
                remove @-import line, optionally delete source.

    Returns one confirm_token per affected file (same shape as /api/preview),
    a migration_id for batch-rollback tracking, and the full Tier 1 result.
    """
    _purge_expired_pending()
    cache = _cache(req)
    _, _, _ = cache.snapshot()

    source = Path(body.source_path).expanduser().resolve()
    if not source.is_file():
        raise HTTPException(status_code=400, detail=f"source not found: {body.source_path}")

    try:
        source_body = source.read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"cannot read source: {e}")

    # -------------------------------------------------------------------------
    # Build the file plan.
    # -------------------------------------------------------------------------
    files_changed: list[MigrateFilePlan] = []
    heading_collisions: list[str] = []

    if body.mode == "rule":
        # Determine target directory.
        if body.target_dir_or_file:
            target_dir = Path(body.target_dir_or_file).expanduser().resolve()
        else:
            target_dir = config.CLAUDE_DIR / "rules"
        filename = body.new_filename or source.name
        target_file = target_dir / filename

        diff = "".join(
            difflib.unified_diff(
                [],
                source_body.splitlines(keepends=True),
                fromfile="/dev/null",
                tofile=f"b/{config.collapse_home(target_file)}",
                n=3,
            )
        )
        files_changed.append(MigrateFilePlan(
            path=str(target_file),
            action="create",
            new_content=source_body,
            diff=diff,
        ))
        content_identity: str = "exact"

    elif body.mode == "add-paths":
        if not body.paths_globs:
            raise HTTPException(
                status_code=422,
                detail="Please provide at least one path pattern.",
            )
        fm, _ = _split_frontmatter(source_body)
        existing = fm.get("paths") or []
        if isinstance(existing, str):
            existing = [existing]
        merged_globs = list(dict.fromkeys(list(existing) + list(body.paths_globs)))
        new_body = _rewrite_paths_globs(source_body, merged_globs)
        diff = "".join(
            difflib.unified_diff(
                source_body.splitlines(keepends=True),
                new_body.splitlines(keepends=True),
                fromfile=f"a/{config.collapse_home(source)}",
                tofile=f"b/{config.collapse_home(source)}",
                n=3,
            )
        )
        files_changed.append(MigrateFilePlan(
            path=str(source),
            action="modify",
            new_content=new_body,
            diff=diff,
        ))
        content_identity = "exact"  # body unchanged; only frontmatter mutated

    elif body.mode == "remove-paths":
        new_body = _rewrite_paths_globs(source_body, None)
        diff = "".join(
            difflib.unified_diff(
                source_body.splitlines(keepends=True),
                new_body.splitlines(keepends=True),
                fromfile=f"a/{config.collapse_home(source)}",
                tofile=f"b/{config.collapse_home(source)}",
                n=3,
            )
        )
        files_changed.append(MigrateFilePlan(
            path=str(source),
            action="modify",
            new_content=new_body,
            diff=diff,
        ))
        content_identity = "exact"  # body unchanged; only frontmatter mutated

    elif body.mode == "move-to-project":
        if not body.target_cwd:
            raise HTTPException(
                status_code=422,
                detail="Please pick which project folder to move this rule into.",
            )
        target_cwd = Path(body.target_cwd).expanduser().resolve()
        if not target_cwd.is_dir():
            raise HTTPException(
                status_code=422,
                detail="That project folder doesn't exist anymore. Pick a different one.",
            )
        # Destination: <target_cwd>/.claude/rules/<source_filename>
        # Create the rules directory if it doesn't exist yet — no error.
        dest_rules_dir = target_cwd / ".claude" / "rules"
        dest_rules_dir.mkdir(parents=True, exist_ok=True)
        dest_file = dest_rules_dir / source.name

        # Plan 1: create rule at new project location.
        diff_create = "".join(
            difflib.unified_diff(
                [],
                source_body.splitlines(keepends=True),
                fromfile="/dev/null",
                tofile=f"b/{config.collapse_home(dest_file)}",
                n=3,
            )
        )
        files_changed.append(MigrateFilePlan(
            path=str(dest_file),
            action="create",
            new_content=source_body,
            diff=diff_create,
        ))

        # Plan 2: delete original.
        files_changed.append(MigrateFilePlan(
            path=str(source),
            action="delete",
            new_content="",
            diff="",
        ))

        # Plan 3: update any @-import in ~/.claude/CLAUDE.md that references
        # the old path, rewriting it to the new project-relative path.
        user_claude_md = config.CLAUDE_DIR / "CLAUDE.md"
        if user_claude_md.is_file():
            try:
                claude_body = user_claude_md.read_text(encoding="utf-8", errors="replace")
            except OSError:
                claude_body = None
            if claude_body is not None:
                old_display = config.collapse_home(source)
                new_display = config.collapse_home(dest_file)
                new_claude_body = claude_body.replace(
                    f"@{old_display}", f"@{new_display}"
                ).replace(
                    f"@{str(source)}", f"@{new_display}"
                )
                if new_claude_body != claude_body:
                    imp_diff = "".join(
                        difflib.unified_diff(
                            claude_body.splitlines(keepends=True),
                            new_claude_body.splitlines(keepends=True),
                            fromfile=f"a/{config.collapse_home(user_claude_md)}",
                            tofile=f"b/{config.collapse_home(user_claude_md)}",
                            n=3,
                        )
                    )
                    files_changed.append(MigrateFilePlan(
                        path=str(user_claude_md),
                        action="modify",
                        new_content=new_claude_body,
                        diff=imp_diff,
                    ))

        content_identity = "exact"

    else:  # merge
        if body.target_dir_or_file:
            target_file = Path(body.target_dir_or_file).expanduser().resolve()
        else:
            target_file = config.CLAUDE_DIR / "CLAUDE.md"
        merge = plan_merge(source, target_file)
        heading_collisions = merge.heading_collisions
        files_changed.append(MigrateFilePlan(
            path=str(target_file),
            action="modify",
            new_content=merge.merged_body,
            diff=merge.unified_diff,
        ))
        # Content identity: substring check — source sections (body-only, no
        # frontmatter) must appear inside the merged target. Source frontmatter
        # is not meaningful in the target context — only the section content is.
        from .markdown_merge import _parse_sections as _ps
        _, src_sections = _ps(source_body)
        src_body_only = "".join(
            ("#" * lvl + " " + h + "\n" + b)
            for h, lvl, b in src_sections
        )
        if src_body_only.strip() in merge.merged_body.strip():
            content_identity = "substring"
        else:
            content_identity = "fail"

    # Find @-import line in any importer and plan its removal.
    # Skipped for add-paths / remove-paths (no move — the file stays in place)
    # and for move-to-project (importer rewrite already baked into files_changed).
    importers = find_importers(source, cache)
    if body.mode not in ("add-paths", "remove-paths", "move-to-project"):
        for imp in importers:
            imp_path = Path(imp.file_path)
            try:
                imp_body = imp_path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            imp_lines = imp_body.splitlines(keepends=True)
            new_lines = [
                ln for i, ln in enumerate(imp_lines, start=1)
                if i != imp.line_number
            ]
            new_imp_body = "".join(new_lines)
            imp_diff = "".join(
                difflib.unified_diff(
                    imp_lines,
                    new_lines,
                    fromfile=f"a/{config.collapse_home(imp_path)}",
                    tofile=f"b/{config.collapse_home(imp_path)}",
                    n=3,
                )
            )
            files_changed.append(MigrateFilePlan(
                path=str(imp_path),
                action="modify",
                new_content=new_imp_body,
                diff=imp_diff,
            ))

    if body.delete_original and body.mode not in ("add-paths", "remove-paths", "move-to-project"):
        files_changed.append(MigrateFilePlan(
            path=str(source),
            action="delete",
            new_content="",
            diff="",
        ))

    # -------------------------------------------------------------------------
    # Tier 1: orphan-import scan.
    # Importers NOT included in this plan are orphans.
    # -------------------------------------------------------------------------
    planned_importer_paths = {
        fc.path for fc in files_changed if fc.action == "modify"
    }
    orphan_importers = [
        ImportRef(
            file_path=imp.file_path,
            line_number=imp.line_number,
            raw_line=imp.raw_line,
        )
        for imp in importers
        if imp.file_path not in planned_importer_paths
    ]

    # -------------------------------------------------------------------------
    # Tier 1: pre/post simulator diff (in-memory simulation).
    # We simulate the proposed write in memory by temporarily patching
    # files_changed into the cache snapshot, then diffing.
    # -------------------------------------------------------------------------
    # Simulate the proposed writes in memory.
    # Full pre/post diff requires disk writes, which we don't do at preview time.
    # Instead, construct a minimal SimDiffResult from the plan. This is enough
    # for the UI to show what files will be added/removed/modified.
    # Files added by this plan → appear in post but not pre.
    added_paths = [
        fc.path for fc in files_changed if fc.action == "create"
    ]
    removed_paths = [
        fc.path for fc in files_changed if fc.action == "delete"
    ]
    sim_diff = SimDiffResult(
        added=added_paths,
        removed=removed_paths,
        hash_changed=[fc.path for fc in files_changed if fc.action == "modify"],
        unchanged_count=0,
    )

    # -------------------------------------------------------------------------
    # Build confirm tokens (one per affected file, same as /api/preview).
    # -------------------------------------------------------------------------
    migration_id = uuid.uuid4().hex
    tokens: list[str] = []
    for fc in files_changed:
        if fc.action == "delete":
            # Deletions are handled by writing empty content — the write
            # pipeline doesn't have a dedicated delete endpoint yet, so we
            # encode deletion as "write empty string and let the caller unlink".
            # For the token we still need a base_hash.
            tgt = Path(fc.path)
            if tgt.is_file():
                try:
                    current = tgt.read_text(encoding="utf-8", errors="replace")
                    base_hash = writer.compute_content_hash(current)
                except OSError:
                    base_hash = writer.compute_content_hash("")
            else:
                base_hash = writer.compute_content_hash("")
            is_creation = False
        else:
            tgt = Path(fc.path)
            is_creation = not tgt.is_file()
            if is_creation:
                current = ""
                base_hash = writer.compute_content_hash("")
            else:
                try:
                    current = tgt.read_text(encoding="utf-8", errors="replace")
                    base_hash = writer.compute_content_hash(current)
                except OSError:
                    base_hash = writer.compute_content_hash("")
        token = uuid.uuid4().hex
        PENDING_WRITES[token] = PendingWrite(
            path=fc.path,
            new_content=fc.new_content or "",
            base_hash=base_hash,
            is_creation=is_creation,
            created_at=datetime.now(timezone.utc),
        )
        tokens.append(token)
    MIGRATION_TOKENS[migration_id] = tokens

    return MigratePreviewResponse(
        tokens=tokens,
        migration_id=migration_id,
        plan=MigratePlan(
            files_changed=files_changed,
            sim_diff=sim_diff,
            content_identity=content_identity,  # type: ignore[arg-type]
            orphan_importers=orphan_importers,
            heading_collisions=heading_collisions,
        ),
    )


@router.post("/migrate-finalize", response_model=MigrateFinalizeResponse)
def post_migrate_finalize(body: MigrateFinalizeRequest) -> MigrateFinalizeResponse:
    """Commit or roll back a migration batch.

    commit:   drops the MIGRATION_SNAPSHOTS log for the batch; no file I/O.
              Returns {finalized: true}.
    rollback: iterates the batch snapshot log in reverse, restores each file
              from its snapshot bytes via atomic_write. Returns {rolled_back: N}.
              On partial failure: returns 500 with partial_rollback: {restored, failed}.

    Unknown migration_id → 404.
    """
    from .writer import MIGRATION_SNAPSHOTS, restore_snapshot

    if body.migration_id not in MIGRATION_SNAPSHOTS:
        raise HTTPException(status_code=404, detail="migration_id not found")

    if body.status == "commit":
        entries = list(MIGRATION_SNAPSHOTS.get(body.migration_id, []))
        MIGRATION_SNAPSHOTS.pop(body.migration_id, None)
        MIGRATION_TOKENS.pop(body.migration_id, None)
        committed = [
            CommittedFile(path=path_str, snapshot_id=snap_id)
            for path_str, snap_id in entries
        ]
        return MigrateFinalizeResponse(finalized=True, committed_files=committed)

    # Rollback: restore in reverse, collect results.
    entries = list(MIGRATION_SNAPSHOTS.get(body.migration_id, []))
    restored: list[str] = []
    failed: list[str] = []
    for path_str, snap_id in reversed(entries):
        try:
            restore_snapshot(Path(path_str), snap_id)
            restored.append(path_str)
        except Exception:
            failed.append(path_str)

    MIGRATION_SNAPSHOTS.pop(body.migration_id, None)
    MIGRATION_TOKENS.pop(body.migration_id, None)

    if failed:
        raise HTTPException(
            status_code=500,
            detail={
                "partial_rollback": {"restored": restored, "failed": failed},
            },
        )
    return MigrateFinalizeResponse(rolled_back=len(restored))


def _is_under_writable_creation_zone(target: Path) -> bool:
    """Same creation-zone check as _is_under_allowed_creation_zone, used for
    delete permission — only files under the same roots where Observatory is
    allowed to create/modify files can be deleted through the UI.
    """
    return _is_under_allowed_creation_zone(target)


@router.post("/delete", response_model=DeletePreviewResponse)
def post_delete(req: Request, body: DeletePreviewRequest) -> DeletePreviewResponse:
    """Preview a file deletion: take a snapshot and return a confirm_token.

    Does NOT delete on this call — the caller must follow up with
    /api/delete-confirm. Enforces the same writable-kind and creation-zone
    boundaries as /api/preview.

    Only files where FileEntry.writable is True AND the path is under a writable
    creation root are deletable — 403 otherwise.
    """
    _purge_expired_pending()
    target = Path(body.path).expanduser().resolve()
    if not target.is_file():
        raise HTTPException(status_code=404, detail=f"file not found: {body.path}")

    files, _, _ = _cache(req).snapshot()
    in_scope = {Path(f.path): f for f in files}
    entry = in_scope.get(target)
    if entry is None:
        raise HTTPException(status_code=400, detail=f"path not in scanned set: {body.path}")
    if not entry.writable:
        raise HTTPException(
            status_code=403,
            detail=f"file kind '{entry.kind}' is not writable",
        )
    if not _is_under_writable_creation_zone(target):
        raise HTTPException(
            status_code=403,
            detail=(
                "delete only allowed under ~/.claude/rules/, "
                "~/.claude/knowledge/, or <cwd>/.claude/rules/"
            ),
        )

    try:
        snapshot_id = writer.take_snapshot(target)
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"snapshot failed: {e}")

    confirm_token = uuid.uuid4().hex
    PENDING_DELETES[confirm_token] = {
        "path": str(target),
        "snapshot_id": snapshot_id,
        "created_at": datetime.now(timezone.utc),
    }
    return DeletePreviewResponse(confirm_token=confirm_token, snapshot_id=snapshot_id)


@router.post("/delete-confirm", response_model=DeleteConfirmResponse)
def post_delete_confirm(req: Request, body: DeleteConfirmRequest) -> DeleteConfirmResponse:
    """Execute a previewed deletion after the user confirms.

    Validates the confirm_token (5-min TTL), then os.unlink()s the file.
    Triggers IndexCache.rebuild_sync() after success.
    """
    pending = PENDING_DELETES.get(body.confirm_token)
    if pending is None:
        raise HTTPException(status_code=404, detail="confirm_token unknown or expired")
    now = datetime.now(timezone.utc)
    if now - pending["created_at"] > PENDING_WRITE_TTL:
        PENDING_DELETES.pop(body.confirm_token, None)
        raise HTTPException(status_code=404, detail="confirm_token expired")

    target = Path(pending["path"])
    snapshot_id = pending["snapshot_id"]

    if not target.is_file():
        PENDING_DELETES.pop(body.confirm_token, None)
        raise HTTPException(status_code=409, detail="file no longer exists")

    try:
        os.unlink(target)
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"delete failed: {e}")

    PENDING_DELETES.pop(body.confirm_token, None)

    try:
        _cache(req).rebuild_sync()
    except Exception:
        pass

    return DeleteConfirmResponse(deleted=True, snapshot_id=snapshot_id)


@router.post("/delete-undo", response_model=DeleteUndoResponse)
def post_delete_undo(req: Request, body: DeleteUndoRequest) -> DeleteUndoResponse:
    """Restore a deleted file from its snapshot (undo a delete-confirm).

    Reads the snapshot bytes and atomic_writes them back to the original path.
    Triggers IndexCache.rebuild_sync() after success.
    """
    target = Path(body.path).expanduser().resolve()
    try:
        writer.restore_snapshot(target, body.snapshot_id)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"restore failed: {e}")

    try:
        _cache(req).rebuild_sync()
    except Exception:
        pass

    return DeleteUndoResponse(restored=True)


@router.post("/restore-from-snapshot", response_model=RestoreFromSnapshotResponse)
def post_restore_from_snapshot(
    req: Request, body: RestoreFromSnapshotRequest
) -> RestoreFromSnapshotResponse:
    """Restore a file to a previous snapshot, enabling post-commit undo.

    Validates the snapshot exists, takes a fresh snapshot of the current state
    (so the user can undo the undo), then atomically restores the file. Triggers
    a reindex so the UI reflects the restored content immediately.

    Returns {restored: true, new_snapshot_id: <id>} on success.
    404 when the snapshot is missing (rotated out of the last-10 retention):
        "Couldn't undo — backup files have rotated out. Try restoring from a more recent edit."
    403 when the target path is not writable per the WRITABLE_KINDS whitelist.
    """
    target = Path(body.path).expanduser().resolve()

    # Permission check: only writable kinds can be restored through Observatory.
    files, _, _ = _cache(req).snapshot()
    in_scope = {Path(f.path): f for f in files}
    entry = in_scope.get(target)
    if entry is not None and not entry.writable:
        raise HTTPException(
            status_code=403,
            detail=f"File kind '{entry.kind}' cannot be modified through Observatory.",
        )

    # Validate snapshot exists: <snapshots_root>/<sha1-of-path>/<snapshot_id>.snap
    snap_dir = writer._target_dir(target)
    snap_path = snap_dir / f"{body.snapshot_id}.snap"
    if not snap_path.is_file():
        raise HTTPException(
            status_code=404,
            detail=(
                "Couldn't undo — backup files have rotated out. "
                "Try restoring from a more recent edit."
            ),
        )

    # Take a fresh snapshot of the current state before overwriting.
    try:
        new_snap_id = writer.take_snapshot(target)
    except OSError as e:
        raise HTTPException(
            status_code=500,
            detail=f"Couldn't take a safety backup before restoring: {e}",
        )

    # Restore the snapshot bytes atomically.
    try:
        writer.restore_snapshot(target, body.snapshot_id)
    except FileNotFoundError:
        raise HTTPException(
            status_code=404,
            detail=(
                "Couldn't undo — backup files have rotated out. "
                "Try restoring from a more recent edit."
            ),
        )
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Restore failed: {e}")

    try:
        _cache(req).rebuild_sync()
    except Exception:
        pass

    return RestoreFromSnapshotResponse(restored=True, new_snapshot_id=new_snap_id)


@router.get("/tier2-status")
def get_tier2_status() -> dict:
    """Return Tier 2 deep-verify status including pre-flight checks.

    Tier 2 works via an InstructionsLoaded hook that appends each event payload
    to ~/.claude/.observatory/instructions.jsonl. The hook is installed through
    the normal preview/write pipeline so it goes through DiffModal.

    Returns a rich status dict — available, installed, preflight details,
    event count captured so far.
    """
    return tier2.get_tier2_status()


@router.get("/tier2-preflight")
def get_tier2_preflight() -> dict:
    """Run Tier 2 pre-flight checks: disableAllHooks, allowManagedHooksOnly, NFS.

    Returns {ok, reason, disable_all_hooks, allow_managed_only, nfs}.
    """
    return tier2.check_preflight()


@router.post("/tier2-install-preview")
def post_tier2_install_preview() -> PreviewResponse:
    """Preview installing the Tier 2 InstructionsLoaded hook in settings.json.

    Generates the new settings.json content with the hook entry added and
    returns a confirm_token via the normal preview pipeline. The caller
    must confirm via /api/write.

    Returns 412 if pre-flight checks fail (managed policy blocks hooks).
    """
    preflight = tier2.check_preflight()
    if not preflight["ok"]:
        raise HTTPException(
            status_code=412,
            detail=preflight["reason"],
        )
    _purge_expired_pending()
    settings_path = config.CLAUDE_DIR / "settings.json"
    new_data = tier2.build_settings_with_hook(settings_path)
    new_content = json.dumps(new_data, indent=2, ensure_ascii=False) + "\n"

    if settings_path.is_file():
        try:
            current = settings_path.read_text(encoding="utf-8")
        except OSError as e:
            raise HTTPException(status_code=500, detail=f"read error: {e}")
    else:
        current = ""

    base_hash = writer.compute_content_hash(current)
    diff_lines = difflib.unified_diff(
        current.splitlines(keepends=True),
        new_content.splitlines(keepends=True),
        fromfile=f"a/{config.collapse_home(settings_path)}",
        tofile=f"b/{config.collapse_home(settings_path)}",
        n=3,
    )
    diff = "".join(diff_lines)
    confirm_token = uuid.uuid4().hex
    PENDING_WRITES[confirm_token] = PendingWrite(
        path=str(settings_path),
        new_content=new_content,
        base_hash=base_hash,
        is_creation=not settings_path.is_file(),
        created_at=datetime.now(timezone.utc),
    )
    return PreviewResponse(
        confirm_token=confirm_token,
        diff=diff,
        base_hash=base_hash,
        is_creation=not settings_path.is_file(),
    )


@router.post("/tier2-uninstall-preview")
def post_tier2_uninstall_preview() -> PreviewResponse:
    """Preview removing the Tier 2 hook from settings.json.

    Returns 404 if the hook is not currently installed.
    """
    if not tier2.hook_is_installed():
        raise HTTPException(status_code=404, detail="Tier 2 hook is not currently installed.")
    _purge_expired_pending()
    settings_path = config.CLAUDE_DIR / "settings.json"
    new_data = tier2.build_settings_without_hook(settings_path)
    new_content = json.dumps(new_data, indent=2, ensure_ascii=False) + "\n"
    try:
        current = settings_path.read_text(encoding="utf-8")
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"read error: {e}")
    base_hash = writer.compute_content_hash(current)
    diff_lines = difflib.unified_diff(
        current.splitlines(keepends=True),
        new_content.splitlines(keepends=True),
        fromfile=f"a/{config.collapse_home(settings_path)}",
        tofile=f"b/{config.collapse_home(settings_path)}",
        n=3,
    )
    diff = "".join(diff_lines)
    confirm_token = uuid.uuid4().hex
    PENDING_WRITES[confirm_token] = PendingWrite(
        path=str(settings_path),
        new_content=new_content,
        base_hash=base_hash,
        is_creation=False,
        created_at=datetime.now(timezone.utc),
    )
    return PreviewResponse(
        confirm_token=confirm_token,
        diff=diff,
        base_hash=base_hash,
        is_creation=False,
    )


@router.get("/tier2-events")
def get_tier2_events(session_id: str = Query(None)) -> dict:
    """Return captured InstructionsLoaded events from the JSONL file.

    If session_id is provided, only events for that session are returned.
    Otherwise all events are returned, grouped by session_id.

    Returns {total: int, by_session: {session_id: [event, ...]}}
    """
    tier2.maybe_rotate_jsonl()
    events = tier2.read_events(session_id=session_id)
    by_session = tier2.group_by_session(events)
    return {"total": len(events), "by_session": by_session}


@router.get("/tier2-compare")
def get_tier2_compare(req: Request, cwd: str = Query(...), session_id: Optional[str] = Query(None)) -> dict:
    """Compare Tier 2 hook events against simulator prediction for a cwd.

    For each file:
      green:   in both simulator and hook events (loaded as expected)
      neutral: in simulator only (loader-suppressed — observation-based, no
               hardcoded setting name per Phase 3 plan section 4)
      red:     in hook events only (simulator gap — missed something)

    If session_id is not provided, uses the most recent session for this cwd.

    Returns {cwd, session_id, results: [{file_path, outcome, ...}]}
    """
    p = Path(cwd).expanduser()
    if not p.is_dir():
        raise HTTPException(status_code=400, detail=f"cwd not a directory: {cwd}")
    cwd_resolved = p.resolve()

    # Get simulator prediction.
    files, edges, _ = _cache(req).snapshot()
    from .simulator import simulate as _simulate
    sim_resp = _simulate(cwd_resolved, files, edges)
    sim_loaded = {
        (Path.home() / s.file_path[2:] if s.file_path.startswith("~/") else Path(s.file_path)).resolve()
        for s in sim_resp.steps
        if s.status == "loaded"
    }
    sim_loaded_strs = {str(p) for p in sim_loaded}

    # Get hook events.
    events = tier2.read_events()
    cwd_str = str(cwd_resolved)
    cwd_events = [e for e in events if e.get("cwd") == cwd_str]

    if session_id is None and cwd_events:
        # Use most recent session for this cwd.
        session_id = cwd_events[-1].get("session_id")

    if session_id:
        cwd_events = [e for e in cwd_events if e.get("session_id") == session_id]

    results = tier2.compare_for_cwd(cwd_resolved, cwd_events, sim_loaded_strs)
    return {
        "cwd": str(cwd_resolved),
        "session_id": session_id,
        "hook_events_found": len(cwd_events),
        "results": results,
    }


# Sentinel glob used to "disable" an always-loaded rule by making its paths:
# field point to a pattern that can never match any real file.
_DISABLED_SENTINEL = ".DISABLED"

# HTML comment marker injected into CLAUDE.md @-import lines and MEMORY.md
# index entries when toggling a knowledge file's autoload off.
# HTML comments are invisible when the file is rendered as Markdown and do not
# trigger Claude Code's special handling of leading-# lines (which are treated
# as external prompts in CLAUDE.md). Round-trip: disable prepends the marker,
# re-enable strips exactly marker + trailing space to restore original bytes.
_DISABLED_COMMENT_PREFIX = "<!-- [disabled by Observatory] --> "


def _autoload_toggle_rule(current: str, enabled: bool) -> tuple[str, AutoloadMechanism]:
    """Compute new content for a rule file toggle and the mechanism used.

    Returns (new_content, mechanism).
    """
    fm, body = _split_frontmatter(current)

    if enabled:
        # Re-enable: restore original globs from paths_disabled if present,
        # otherwise remove the sentinel (fall back to always-loaded).
        original = fm.pop("paths_disabled", None)
        fm.pop("paths", None)
        if original:
            fm["paths"] = original
    else:
        # Disable: if paths: exists, save it under paths_disabled, then
        # replace with the sentinel so the rule never matches.
        existing = fm.get("paths")
        if existing and existing != [_DISABLED_SENTINEL]:
            fm["paths_disabled"] = existing
        fm["paths"] = [_DISABLED_SENTINEL]

    if not fm:
        new_content = body.lstrip("\n")
    else:
        new_content = _emit_frontmatter(fm, body)
    return new_content, "paths_sentinel"


def _autoload_toggle_skill(
    current_settings: str, enabled: bool, skill_literal: str
) -> tuple[str, AutoloadMechanism]:
    """Patch settings.json permissions.deny for a skill toggle.

    Returns (new_settings_content, mechanism).
    """
    try:
        data = json.loads(current_settings)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=500, detail=f"settings.json parse error: {exc}")
    deny: list = data.get("permissions", {}).get("deny", [])
    if enabled:
        deny = [d for d in deny if d != skill_literal]
    else:
        if skill_literal not in deny:
            deny.append(skill_literal)
    if deny:
        data.setdefault("permissions", {})["deny"] = deny
    else:
        perm = data.get("permissions", {})
        perm.pop("deny", None)
        if perm:
            data["permissions"] = perm
        else:
            data.pop("permissions", None)
    return json.dumps(data, indent=2, ensure_ascii=False) + "\n", "permissions_deny"


def _autoload_toggle_knowledge_memory_index(
    memory_index_path: Path, target_path: Path, enabled: bool
) -> tuple[str | None, AutoloadMechanism]:
    """Comment or uncomment the line in MEMORY.md that references target_path.

    Returns (new_content_or_None_if_no_change, mechanism). None means no
    reference to target_path was found in MEMORY.md.
    """
    if not memory_index_path.is_file():
        return None, "memory_index_comment"
    content = memory_index_path.read_text(encoding="utf-8")
    target_display = config.collapse_home(target_path)
    target_basename = target_path.name

    lines = content.splitlines(keepends=True)
    new_lines = []
    changed = False
    for line in lines:
        stripped = line.rstrip("\n")
        if enabled:
            # Remove the disabled prefix if present on a line mentioning the file.
            if stripped.startswith(_DISABLED_COMMENT_PREFIX) and (
                target_display in stripped or target_basename in stripped
            ):
                new_lines.append(stripped[len(_DISABLED_COMMENT_PREFIX):] + "\n")
                changed = True
                continue
        else:
            # Add the disabled prefix to a line that isn't already disabled and
            # mentions the target file. Guard against double-wrapping by
            # checking the HTML comment marker rather than a bare #.
            if not stripped.startswith(_DISABLED_COMMENT_PREFIX) and (
                target_display in stripped or target_basename in stripped
            ):
                new_lines.append(_DISABLED_COMMENT_PREFIX + stripped + "\n")
                changed = True
                continue
        new_lines.append(line)
    if not changed:
        return None, "memory_index_comment"
    return "".join(new_lines), "memory_index_comment"


def _find_at_import_parent(
    files: list, target_path: Path
) -> tuple[Path | None, int | None, str | None]:
    """Find the file that @-imports target_path and the line number.

    Returns (parent_path, line_number, raw_line) or (None, None, None).
    """
    target_display = config.collapse_home(target_path)
    target_abs = str(target_path)
    import_patterns = [
        f"@{target_display}",
        f"@{target_abs}",
    ]
    for f in files:
        if f.kind not in ("claude_md", "rule"):
            continue
        try:
            text = Path(f.path).read_text(encoding="utf-8")
        except OSError:
            continue
        for i, line in enumerate(text.splitlines(), 1):
            stripped = line.strip()
            # Also match lines that are currently disabled (HTML comment wrapper).
            # The re-enable path needs to locate the commented-out import.
            candidate = stripped
            if candidate.startswith(_DISABLED_COMMENT_PREFIX):
                candidate = candidate[len(_DISABLED_COMMENT_PREFIX):]
            for pat in import_patterns:
                if candidate == pat or candidate.startswith(pat + " "):
                    return Path(f.path), i, line
    return None, None, None


def _autoload_toggle_knowledge_import(
    current_parent: str, line_number: int, enabled: bool
) -> tuple[str, AutoloadMechanism]:
    """Comment or uncomment the @-import line in the parent CLAUDE.md.

    Returns (new_parent_content, mechanism).
    """
    lines = current_parent.splitlines(keepends=True)
    idx = line_number - 1
    if idx < 0 or idx >= len(lines):
        raise HTTPException(status_code=500, detail="import line index out of range")
    stripped_line = lines[idx].rstrip("\n")
    if enabled:
        if stripped_line.startswith(_DISABLED_COMMENT_PREFIX):
            lines[idx] = stripped_line[len(_DISABLED_COMMENT_PREFIX):] + "\n"
        else:
            lines[idx] = stripped_line + "\n"
    else:
        if not stripped_line.startswith(_DISABLED_COMMENT_PREFIX):
            lines[idx] = _DISABLED_COMMENT_PREFIX + stripped_line + "\n"
    return "".join(lines), "comment_out_import"


@router.post("/autoload-toggle-preview", response_model=AutoloadTogglePreviewResponse)
def post_autoload_toggle_preview(
    req: Request, body: AutoloadToggleRequest
) -> AutoloadTogglePreviewResponse:
    """Preview toggling autoload on/off for a file.

    Returns a DiffModal-ready token when the toggle is applicable, or a
    non-interactive indicator payload when it is not.

    The caller confirms by POSTing the confirm_token to /api/write exactly
    as any other write — the full pipeline (snapshot + atomic write +
    IndexCache rebuild) is reused unchanged.
    """
    _purge_expired_pending()
    target = Path(body.path).expanduser().resolve()

    files, _, _ = _cache(req).snapshot()
    in_scope = {Path(f.path): f for f in files}

    entry = in_scope.get(target)
    if entry is None:
        raise HTTPException(status_code=400, detail=f"path not in scanned set: {body.path}")

    kind = entry.kind

    # Kinds for which autoload toggling has no defined mechanism.
    NOT_APPLICABLE = {
        "claude_md": "CLAUDE.md loads whenever its directory is on the ancestor walk — there is no opt-out field",
        "settings": "settings.json loads based on cwd — there is no per-file toggle",
        "mcp": "The .mcp.json file itself is always loaded; individual servers are toggled via Extensions",
        "automemory": "Auto-memory is managed by Claude Code — it cannot be toggled here",
        "plugin_manifest": "Plug-in manifests are managed by Claude Code. Enable or disable individual skills via the Extensions tab",
        "plugin_registry": "Plug-in registry is managed by Claude Code and cannot be toggled here",
        "script": "Hook scripts are lifecycle callbacks, not loaded context",
        "memory_index": "MEMORY.md is the knowledge index — disabling it would break all knowledge file discovery",
    }
    if kind in NOT_APPLICABLE:
        return AutoloadTogglePreviewResponse(
            toggle_applicable=False,
            reason=NOT_APPLICABLE[kind],
        )

    # --- rule ---
    if kind == "rule":
        if not entry.writable:
            raise HTTPException(status_code=403, detail="rule file is not writable")
        try:
            current = target.read_text(encoding="utf-8")
        except OSError as exc:
            raise HTTPException(status_code=500, detail=f"read error: {exc}")
        new_content, mechanism = _autoload_toggle_rule(current, body.enabled)
        write_target = target
        current_for_diff = current

    # --- skill ---
    elif kind == "skill":
        # Skills toggle writes to settings.json, not the SKILL.md itself.
        # Derive the skill literal: Skill(<plugin_id>:<name> *)
        # We need the plugin_id and name from the manifest.
        skill_literal = _derive_skill_literal(target)
        if skill_literal is None:
            return AutoloadTogglePreviewResponse(
                toggle_applicable=False,
                reason="Could not derive skill identifier from SKILL.md — check that the frontmatter has a valid name field",
            )
        settings_path = config.CLAUDE_DIR / "settings.json"
        try:
            current_for_diff = settings_path.read_text(encoding="utf-8") if settings_path.is_file() else "{}\n"
        except OSError as exc:
            raise HTTPException(status_code=500, detail=f"settings.json read error: {exc}")
        new_content, mechanism = _autoload_toggle_skill(current_for_diff, body.enabled, skill_literal)
        write_target = settings_path

    # --- memory ---
    elif kind == "memory":
        # Memory files load only when referenced. Determine how this file is referenced:
        # (a) @-import in a CLAUDE.md or rule file, or
        # (b) entry in MEMORY.md knowledge index.
        # Try (a) first; fall back to (b).
        parent_path, line_number, _ = _find_at_import_parent(files, target)
        if parent_path is not None and line_number is not None:
            try:
                current_for_diff = parent_path.read_text(encoding="utf-8")
            except OSError as exc:
                raise HTTPException(status_code=500, detail=f"parent read error: {exc}")
            new_content, mechanism = _autoload_toggle_knowledge_import(
                current_for_diff, line_number, body.enabled
            )
            write_target = parent_path
        else:
            # Try MEMORY.md
            memory_index = config.CLAUDE_DIR / "knowledge" / "MEMORY.md"
            new_content_opt, mechanism = _autoload_toggle_knowledge_memory_index(
                memory_index, target, body.enabled
            )
            if new_content_opt is None:
                return AutoloadTogglePreviewResponse(
                    toggle_applicable=False,
                    reason="This file is not referenced by any @-import or MEMORY.md entry — it is already only loaded on-demand",
                )
            try:
                current_for_diff = memory_index.read_text(encoding="utf-8")
            except OSError as exc:
                raise HTTPException(status_code=500, detail=f"MEMORY.md read error: {exc}")
            new_content = new_content_opt
            write_target = memory_index

    else:
        return AutoloadTogglePreviewResponse(
            toggle_applicable=False,
            reason=f"Autoload toggling is not supported for kind '{kind}'",
        )

    # Common: verify writable (for write_target, not necessarily the original file)
    write_entry = in_scope.get(write_target)
    if write_entry is not None and not write_entry.writable:
        raise HTTPException(status_code=403, detail=f"target file '{write_target}' is not writable")

    base_hash = writer.compute_content_hash(current_for_diff)
    diff_lines = difflib.unified_diff(
        current_for_diff.splitlines(keepends=True),
        new_content.splitlines(keepends=True),
        fromfile=f"a/{config.collapse_home(write_target)}",
        tofile=f"b/{config.collapse_home(write_target)}",
        n=3,
    )
    diff = "".join(diff_lines)

    confirm_token = uuid.uuid4().hex
    PENDING_WRITES[confirm_token] = PendingWrite(
        path=str(write_target),
        new_content=new_content,
        base_hash=base_hash,
        is_creation=False,
        created_at=datetime.now(timezone.utc),
    )
    return AutoloadTogglePreviewResponse(
        toggle_applicable=True,
        confirm_token=confirm_token,
        diff=diff,
        base_hash=base_hash,
        is_creation=False,
        new_enabled=body.enabled,
        mechanism=mechanism,
    )


def _derive_skill_literal(skill_md_path: Path) -> str | None:
    """Derive the Skill(<plugin_id>:<name> *) literal from a SKILL.md path.

    SKILL.md lives at ~/.claude/skills/<plugin_id>/SKILL.md or inside a
    plugin's cached snapshot. We infer plugin_id from the parent directory
    name and name from the SKILL.md frontmatter.
    """
    try:
        text = skill_md_path.read_text(encoding="utf-8")
    except OSError:
        return None
    fm, _ = _split_frontmatter(text)
    name = fm.get("name") if fm else None
    if not name:
        return None
    plugin_id = skill_md_path.parent.name
    return f"Skill({plugin_id}:{name} *)"


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
