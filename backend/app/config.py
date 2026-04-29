"""Filesystem scope configuration for the scanner.

The scanner is intentionally permissive about *what* exists (each in-scope
target is opportunistic — absent files are silently skipped) and strict about
*where* it refuses to look (the blacklist below).
"""
from __future__ import annotations

from pathlib import Path

HOME = Path.home()
CLAUDE_DIR = HOME / ".claude"

# Auto-memory zone — read-only, scanned but not parsed for outbound refs.
AUTO_MEMORY_DIR = CLAUDE_DIR / "projects" / "-home-voxdecaelo" / "memory"

# Hard blacklist: directories the scanner refuses to descend into even if a
# scope target above transitively implies them. These all contain hundreds to
# thousands of session-log / cache files that would drown the graph.
BLACKLIST_DIRS = [
    CLAUDE_DIR / "file-history",
    CLAUDE_DIR / "remote" / "file-history",
    CLAUDE_DIR / "plugins" / "cache",
    # Everything under projects/ except the auto-memory subdir.
    # Enforced by an explicit check in scanner.py rather than this list.
]

# Project-discovery walker config (used by /api/cwds).
DISCOVERY_MAX_DEPTH = 4
DISCOVERY_SKIP_DIRS = {
    "node_modules", ".git", "__pycache__", "dist", "build",
    ".venv", "venv", ".next", ".cache", ".idea", ".vscode",
}

# State file lives inside the observatory repo, so user-machine state is local
# to the tool and survives reinstalls without leaking into ~/.claude/.
STATE_FILE = HOME / "observatory" / ".state.json"

# Server bind.
BACKEND_HOST = "127.0.0.1"
BACKEND_PORT = 8765
FRONTEND_ORIGINS = [
    "http://127.0.0.1:5173",
    "http://localhost:5173",
]


def collapse_home(path: Path | str) -> str:
    """Render an absolute path with `~` for display."""
    p = str(path)
    home = str(HOME)
    if p == home:
        return "~"
    if p.startswith(home + "/"):
        return "~" + p[len(home):]
    return p


def is_blacklisted(path: Path) -> bool:
    """True if the path lives under a blacklisted directory."""
    try:
        resolved = path.resolve()
    except OSError:
        return True
    for bad in BLACKLIST_DIRS:
        try:
            resolved.relative_to(bad)
            return True
        except ValueError:
            continue
    # projects/* is blacklisted except the auto-memory subdir.
    projects = CLAUDE_DIR / "projects"
    try:
        rel = resolved.relative_to(projects)
        # Allow the auto-memory subdir.
        try:
            resolved.relative_to(AUTO_MEMORY_DIR)
            return False
        except ValueError:
            return True
    except ValueError:
        pass
    return False
