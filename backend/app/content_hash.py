"""Content-identity helpers for Phase 3 verification primitives.

sha256_of_body   — canonical file fingerprint used by sim_diff and migration checks.
body_contains    — substring assertion for the "merge" option content-identity check.
"""
from __future__ import annotations

import hashlib
from pathlib import Path


def sha256_of_body(path: Path) -> str:
    """Return the hex-encoded SHA-256 of the file's raw bytes.

    Raises FileNotFoundError / OSError if the file cannot be read.
    """
    data = path.read_bytes()
    return hashlib.sha256(data).hexdigest()


def body_contains(target: Path, source: Path) -> bool:
    """True if target's text body contains source's text body as a substring.

    Both bodies are stripped of leading/trailing whitespace before comparison.
    Comparison is byte-for-byte (case-sensitive). Returns False if either file
    cannot be read.
    """
    try:
        target_text = target.read_text(encoding="utf-8", errors="replace").strip()
        source_text = source.read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        return False
    return source_text in target_text
