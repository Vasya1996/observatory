"""Hook extraction — find file targets behind every command-string in a
Claude-Code config or plugin hook bundle.

A "hook" here is any JSON object that pairs a lifecycle event with a shell
command Claude Code is supposed to run. Two file shapes:

* Top-level `hooks` and `statusLine` blocks in `settings.json` / `settings.local.json`:

    {
      "hooks": {
        "PreToolUse": [
          { "matcher": "Bash",
            "hooks": [{"type": "command", "command": "/path/to/script.sh"}] }
        ]
      },
      "statusLine": { "type": "command", "command": "~/.claude/statusline.sh" }
    }

* Plugin-shipped `hooks.json` (lives at `<plugin>/hooks/hooks.json`):

    {
      "description": "...",
      "hooks": {
        "Stop": [{ "hooks": [{"type":"command","command":"bash ${CLAUDE_PLUGIN_ROOT}/hooks/stop.sh"}] }]
      }
    }

Result of extraction is a list of `HookRef` records. The resolver turns each
into a `hook` edge from the source file → target file, attaching the event
name(s). Targets that exist on disk but aren't otherwise scanned become opt-in
`script` leaf nodes (see `resolver._scan_hook_scripts`).

The command-line parser is intentionally simple: it strips a leading interpreter
(`bash`, `sh`, `python`, `python3`, `node`, …) plus any flags, then returns the
first remaining arg as the file path. Inline commands (no file, e.g.
`"echo hello"`) and unresolvable env vars yield no target.
"""
from __future__ import annotations

import json
import re
import shlex
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


@dataclass(frozen=True)
class HookRef:
    """One hook → file relation, pre-resolution.

    `source_path` is the JSON file the hook was declared in (settings.json,
    plugin hooks.json, etc.). `event` is the lifecycle name. `target_path` is
    the resolved absolute path of the script the command runs, or None if the
    command is inline / target missing.
    """
    source_path: Path
    event: str
    raw_command: str
    target_path: Optional[Path]


# Common interpreters: when a command starts with one of these, the FILE we
# care about is the next non-flag argument, not the interpreter itself.
_INTERPRETERS = {
    "bash", "sh", "zsh", "ksh",
    "python", "python3", "python2",
    "node", "nodejs", "deno",
    "ruby", "perl", "uvx", "uv",
}


def _strip_interpreter(tokens: list[str]) -> list[str]:
    """If the first token is a common interpreter, drop it AND any flag tokens
    (anything starting with `-`) until we hit the first non-flag arg.
    """
    if not tokens:
        return tokens
    head = Path(tokens[0]).name  # handles `/usr/bin/python3`, `python3` alike
    if head not in _INTERPRETERS:
        return tokens
    # Drop the interpreter and any leading flags.
    out = list(tokens[1:])
    while out and out[0].startswith("-"):
        # `-c` would consume the next token as its arg; we don't try to parse
        # that — return empty so the caller treats the command as inline.
        if out[0] in ("-c", "-m", "--module"):
            return []
        out = out[1:]
    return out


def _resolve_command_target(
    command: str,
    source_dir: Path,
    plugin_root: Optional[Path],
) -> Optional[Path]:
    """Extract the file the command invokes and resolve it to an absolute path.

    Returns None for inline commands (no file), unresolvable env vars, or
    paths that don't exist on disk. The "exists on disk" check is what makes
    this static — we only emit edges for files that actually back the hook.
    """
    try:
        tokens = shlex.split(command, posix=True)
    except ValueError:
        return None
    tokens = _strip_interpreter(tokens)
    if not tokens:
        return None
    raw = tokens[0]
    # Substitute ${CLAUDE_PLUGIN_ROOT}; treat unset as unresolvable.
    if "${CLAUDE_PLUGIN_ROOT}" in raw or "$CLAUDE_PLUGIN_ROOT" in raw:
        if plugin_root is None:
            return None
        raw = raw.replace("${CLAUDE_PLUGIN_ROOT}", str(plugin_root))
        raw = raw.replace("$CLAUDE_PLUGIN_ROOT", str(plugin_root))
    # Reject any other unsubstituted $VAR — we don't have its value.
    if re.search(r"\$\{?[A-Za-z_]", raw):
        return None
    if raw.startswith("~"):
        path = Path(raw).expanduser()
    elif raw.startswith("/"):
        path = Path(raw)
    else:
        path = (source_dir / raw)
    try:
        path = path.resolve()
    except OSError:
        return None
    if not path.is_file():
        return None
    return path


def extract(
    source_path: Path,
    plugin_root: Optional[Path] = None,
) -> list[HookRef]:
    """Read a JSON file and emit one HookRef per resolvable command.

    Walks two top-level sites:
      * `hooks.{Event}[].hooks[].command` (any depth, any event name).
      * `statusLine.command` (event = "statusLine").

    `plugin_root` is the directory `${CLAUDE_PLUGIN_ROOT}` should expand to.
    Pass it for plugin-shipped `hooks.json` files; pass None for user/project
    settings.json.
    """
    try:
        data = json.loads(source_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    if not isinstance(data, dict):
        return []
    refs: list[HookRef] = []
    source_dir = source_path.parent

    hooks_obj = data.get("hooks")
    if isinstance(hooks_obj, dict):
        for event_name, entries in hooks_obj.items():
            if not isinstance(entries, list):
                continue
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                inner = entry.get("hooks")
                if not isinstance(inner, list):
                    continue
                for h in inner:
                    if not isinstance(h, dict):
                        continue
                    cmd = h.get("command")
                    if not isinstance(cmd, str) or not cmd.strip():
                        continue
                    target = _resolve_command_target(cmd, source_dir, plugin_root)
                    refs.append(
                        HookRef(
                            source_path=source_path,
                            event=str(event_name),
                            raw_command=cmd,
                            target_path=target,
                        )
                    )

    status = data.get("statusLine")
    if isinstance(status, dict):
        cmd = status.get("command")
        if isinstance(cmd, str) and cmd.strip():
            target = _resolve_command_target(cmd, source_dir, plugin_root)
            refs.append(
                HookRef(
                    source_path=source_path,
                    event="statusLine",
                    raw_command=cmd,
                    target_path=target,
                )
            )
    return refs
