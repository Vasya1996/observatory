"""Filesystem scope configuration for the scanner.

The scanner is intentionally permissive about *what* exists (each in-scope
target is opportunistic — absent files are silently skipped) and strict about
*where* it refuses to look (the blacklist below).
"""
from __future__ import annotations

import platform
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
    # Phase 2 writer's snapshot store. Defensive: if a user happens to drop
    # markdown in here we still don't want it to appear as a graph node.
    CLAUDE_DIR / ".observatory",
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


# ---------------------------------------------------------------------------
# Tier 2 deep-verify availability flag.
# Flip TIER2_AVAILABLE to True when --init-only empirical probe is confirmed
# working on this Claude version (see Phase 3 plan section 5 open questions).
# ---------------------------------------------------------------------------
TIER2_AVAILABLE: bool = False
TIER2_REASON: str = (
    "Deep verification requires --init-only flag, "
    "not present in this Claude version"
)


def os_managed_claude_md_path() -> Path:
    """Return the OS-level managed CLAUDE.md path for the current platform.

    This is the "Managed" slot (slot 1 in the 5-slot Simulator ribbon) —
    org-level instructions that cannot be excluded by user-level settings.

    Linux/WSL: /etc/claude-code/CLAUDE.md
    macOS:     /Library/Application Support/ClaudeCode/CLAUDE.md
    Windows:   C:\\Program Files\\ClaudeCode\\CLAUDE.md
    """
    system = platform.system()
    if system == "Darwin":
        return Path("/Library/Application Support/ClaudeCode/CLAUDE.md")
    if system == "Windows":
        return Path(r"C:\Program Files\ClaudeCode\CLAUDE.md")
    # Linux — check for WSL (WSL_DISTRO_NAME is set in WSL environments).
    # Both native Linux and WSL use the same path.
    return Path("/etc/claude-code/CLAUDE.md")


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
        resolved.relative_to(projects)
        # Allow the auto-memory subdir.
        try:
            resolved.relative_to(AUTO_MEMORY_DIR)
            return False
        except ValueError:
            return True
    except ValueError:
        pass
    return False
