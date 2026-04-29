"""Phase 2 write pipeline — snapshot, atomic write, content hash.

**Critical invariant**: every caller MUST run `take_snapshot()` BEFORE
`atomic_write()`. If snapshotting fails, abort the write — there is no
recovery for an overwritten file without a snapshot. The api.py /api/write
handler enforces this ordering.

Snapshots live under ``~/.claude/.observatory/snapshots/<sha1-of-target-path>/``
with one file per snapshot named by UTC ISO timestamp. Retention: keep the
most recent ``MAX_SNAPSHOTS_PER_TARGET`` snapshots and delete the rest.

Atomic write contract: write a tempfile in the target's directory (so the
final ``os.replace`` stays on the same filesystem and is atomic), then
``os.replace`` it onto the target.
"""
from __future__ import annotations

import hashlib
import os
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from . import config

SNAPSHOTS_ROOT = config.HOME / ".claude" / ".observatory" / "snapshots"
MAX_SNAPSHOTS_PER_TARGET = 10


def _target_dir(target_path: Path) -> Path:
    """Snapshot directory for a target path, keyed by sha1 of its absolute form."""
    abs_str = str(target_path.resolve()) if target_path.exists() else str(target_path)
    digest = hashlib.sha1(abs_str.encode("utf-8")).hexdigest()
    return SNAPSHOTS_ROOT / digest


def _utc_timestamp() -> str:
    """ISO-8601 UTC timestamp safe for use as a filename (no colons)."""
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")


def take_snapshot(target_path: Path) -> str:
    """Copy current file content to ``<snapshots_root>/<sha1>/<timestamp>.snap``.

    For "creation" calls where the target does not yet exist on disk, an empty
    snapshot is still written so the timeline records the moment of creation.

    Returns the snapshot id (the timestamp string).
    Retention: prunes to the last ``MAX_SNAPSHOTS_PER_TARGET`` snapshots per target.
    Raises OSError if the snapshot dir cannot be created or the copy fails —
    the caller MUST abort the write in that case.
    """
    snap_dir = _target_dir(target_path)
    snap_dir.mkdir(parents=True, exist_ok=True)
    timestamp = _utc_timestamp()
    snap_path = snap_dir / f"{timestamp}.snap"
    if target_path.is_file():
        shutil.copy2(target_path, snap_path)
    else:
        snap_path.write_bytes(b"")
    _prune_snapshots(snap_dir)
    return timestamp


def _prune_snapshots(snap_dir: Path) -> None:
    """Keep the most recent ``MAX_SNAPSHOTS_PER_TARGET`` snapshots; delete older."""
    try:
        snaps = sorted(
            (p for p in snap_dir.iterdir() if p.is_file() and p.suffix == ".snap"),
            key=lambda p: p.name,
            reverse=True,
        )
    except OSError:
        return
    for old in snaps[MAX_SNAPSHOTS_PER_TARGET:]:
        try:
            old.unlink()
        except OSError:
            continue


def atomic_write(target_path: Path, content: str) -> None:
    """Write `content` to `target_path` atomically.

    Tempfile is created in the same directory as the target so the final
    ``os.replace`` stays on the same filesystem (cross-fs replace is not atomic).
    The parent directory is created if missing — this enables file creation in
    allowed creation zones.
    """
    target_path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(
        prefix=f".{target_path.name}.",
        suffix=".tmp",
        dir=target_path.parent,
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
        os.replace(tmp, target_path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def compute_content_hash(content: str | bytes) -> str:
    """sha1 hex digest of content (utf-8 if str). Used for conflict detection."""
    if isinstance(content, str):
        data = content.encode("utf-8")
    else:
        data = content
    return hashlib.sha1(data).hexdigest()


def read_current_hash(target_path: Path) -> str:
    """sha1 of file currently on disk; raises FileNotFoundError if absent."""
    return compute_content_hash(target_path.read_bytes())
