"""UI state persistence — pinned node positions, last cwd, last view.

State lives in `~/observatory/.state.json` (covered by .gitignore via
`.observatory/` … wait, actually we use `.state.json` directly. Add it to
.gitignore explicitly when seeding the repo).

Atomic writes: temp file + rename, so a crash mid-write can't corrupt state.
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

from . import config
from .models import UiState


def load() -> UiState:
    path = config.STATE_FILE
    if not path.exists():
        return UiState()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return UiState(**data)
    except (OSError, json.JSONDecodeError, ValueError):
        # Corrupt state — start fresh rather than crash.
        return UiState()


def save(state: UiState) -> None:
    path = config.STATE_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(state.model_dump(), indent=2, ensure_ascii=False)
    fd, tmp = tempfile.mkstemp(prefix=".state.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(payload)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
