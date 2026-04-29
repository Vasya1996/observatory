"""Filesystem watcher with debouncing + SSE event broker.

Watchdog runs in a background thread, drops every event into a coalescing
debouncer, and after 200ms of quiet, schedules `IndexCache.rebuild()` on the
asyncio loop. Each rebuild fans out a `reindex` SSE event to all subscribers.
"""
from __future__ import annotations

import asyncio
import threading
import time
from pathlib import Path
from typing import Iterator, Optional

from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer

from . import scanner
from .models import Edge, FileEntry, IndexResponse
from .resolver import build_index

DEBOUNCE_SECONDS = 0.2


class IndexCache:
    """Holds the current scan result; rebuilds on watcher events.

    Singleton-ish — instantiated once in main.py, accessed everywhere via
    dependency injection.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._files: list[FileEntry] = []
        self._edges: list[Edge] = []
        self._version: int = 0
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._subscribers: list[asyncio.Queue[dict]] = []
        self.rebuild_sync()

    def attach_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def snapshot(self) -> tuple[list[FileEntry], list[Edge], int]:
        with self._lock:
            return list(self._files), list(self._edges), self._version

    def rebuild_sync(self) -> None:
        files, edges = build_index()
        with self._lock:
            self._files = files
            self._edges = edges
            self._version += 1
        self._fanout({"type": "reindex", "version": self._version,
                      "files": len(files), "edges": len(edges)})

    def _fanout(self, payload: dict) -> None:
        loop = self._loop
        if loop is None:
            return
        for q in list(self._subscribers):
            try:
                loop.call_soon_threadsafe(q.put_nowait, payload)
            except Exception:
                # Subscriber's queue is closed — drop silently.
                continue

    def subscribe(self) -> asyncio.Queue[dict]:
        q: asyncio.Queue[dict] = asyncio.Queue()
        self._subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[dict]) -> None:
        try:
            self._subscribers.remove(q)
        except ValueError:
            pass


class _DebouncedHandler(FileSystemEventHandler):
    def __init__(self, cache: IndexCache) -> None:
        self._cache = cache
        self._last_event_at = 0.0
        self._timer: Optional[threading.Timer] = None
        self._lock = threading.Lock()

    def _on_any(self, event: FileSystemEvent) -> None:
        # Filter: only react if the event path is a file we'd actually scan.
        # Cheap pre-filter on extension keeps the debouncer from firing on
        # every editor temp file.
        try:
            p = Path(event.src_path)
        except Exception:
            return
        if p.suffix not in (".md", ".json"):
            # Allow CLAUDE.md without suffix? CLAUDE.md HAS suffix .md, so OK.
            return
        with self._lock:
            self._last_event_at = time.time()
            if self._timer is not None:
                self._timer.cancel()
            self._timer = threading.Timer(DEBOUNCE_SECONDS, self._fire)
            self._timer.daemon = True
            self._timer.start()

    def _fire(self) -> None:
        try:
            self._cache.rebuild_sync()
        except Exception:
            # Swallow — a bad rebuild shouldn't kill the watcher thread.
            pass

    on_modified = _on_any
    on_created = _on_any
    on_deleted = _on_any
    on_moved = _on_any


def start_watcher(cache: IndexCache) -> Observer:
    handler = _DebouncedHandler(cache)
    obs = Observer()
    for root, recursive in scanner.scan_roots():
        try:
            obs.schedule(handler, str(root), recursive=recursive)
        except OSError:
            continue
    obs.daemon = True
    obs.start()
    return obs
