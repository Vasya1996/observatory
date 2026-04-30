"""Pre/post simulator diff helpers for Phase 3 verification primitives.

snapshot_simulator_state — capture (file_path, sha256) for every loaded/conditional
                           file the simulator reports for a list of cwds.
compare_states           — diff two snapshots and return a per-cwd SimDiffResult.
"""
from __future__ import annotations

from pathlib import Path

from .content_hash import sha256_of_body
from .models import SimDiffResult
from .scanner import discover_cwds
from .watcher import IndexCache


def snapshot_simulator_state(
    cwds: list[Path],
    cache: IndexCache,
) -> dict[Path, list[tuple[str, str]]]:
    """Return, per cwd, the list of (absolute_file_path, sha256) for every
    file the simulator reports as 'loaded' or 'conditional'.

    Calls simulate() directly — no HTTP overhead. Files that no longer exist
    on disk are skipped (their path is still returned but without a hash).

    Returns: {cwd_path: [(file_path_str, sha256_or_empty_on_missing), ...]}
    """
    from .simulator import simulate

    files, edges, _ = cache.snapshot()
    result: dict[Path, list[tuple[str, str]]] = {}
    for cwd in cwds:
        if not cwd.is_dir():
            result[cwd] = []
            continue
        sim_resp = simulate(cwd, files, edges)
        entries: list[tuple[str, str]] = []
        for step in sim_resp.steps:
            if step.status not in ("loaded", "conditional"):
                continue
            # file_path in steps is display (~-collapsed); resolve it.
            fp_raw = step.file_path
            if fp_raw.startswith("~"):
                fp = Path.home() / fp_raw[2:]
            else:
                fp = Path(fp_raw)
            fp = fp.resolve()
            try:
                digest = sha256_of_body(fp)
            except OSError:
                digest = ""
            entries.append((str(fp), digest))
        result[cwd] = entries
    return result


def compare_states(
    before: dict[Path, list[tuple[str, str]]],
    after: dict[Path, list[tuple[str, str]]],
) -> dict[Path, SimDiffResult]:
    """Compare two snapshots produced by snapshot_simulator_state.

    For each cwd present in either snapshot, returns a SimDiffResult with:
      added          — paths present in after but not before
      removed        — paths present in before but not after
      hash_changed   — paths present in both but with different SHA-256
      unchanged_count — paths where path AND hash are identical
    """
    all_cwds = set(before) | set(after)
    result: dict[Path, SimDiffResult] = {}
    for cwd in all_cwds:
        b_map = dict(before.get(cwd, []))
        a_map = dict(after.get(cwd, []))
        b_paths = set(b_map)
        a_paths = set(a_map)
        added = sorted(a_paths - b_paths)
        removed = sorted(b_paths - a_paths)
        hash_changed: list[str] = []
        unchanged_count = 0
        for p in sorted(b_paths & a_paths):
            if b_map[p] and a_map[p] and b_map[p] != a_map[p]:
                hash_changed.append(p)
            else:
                unchanged_count += 1
        result[cwd] = SimDiffResult(
            added=added,
            removed=removed,
            hash_changed=hash_changed,
            unchanged_count=unchanged_count,
        )
    return result
