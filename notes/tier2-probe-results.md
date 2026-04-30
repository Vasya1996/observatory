# Tier 2 invocation probe results

Machine: VPS prestage, `claude` version **2.1.123** (Claude Code).

---

## Flag availability

Flags confirmed present in `claude --help` (2.1.123):

| Flag | Present? | Notes |
|------|----------|-------|
| `-p` / `--print` | YES | Non-interactive output mode |
| `--output-format stream-json` | YES | Choices: text / json / stream-json (only works with `--print`) |
| `--include-hook-events` | YES | "Include all hook lifecycle events in the output stream (only works with `--output-format=stream-json`)" |
| `--dangerously-skip-permissions` | YES | Full bypass |
| `--bare` | YES | "Minimal mode: skip hooks, LSP, plugin sync, attribution, auto-memory, background prefetches, keychain reads, and CLAUDE.md auto-discovery." Sets `CLAUDE_CODE_SIMPLE=1`. |
| `--init-only` | **NO** | Does not exist in 2.1.123. Confirmed by reading full `--help` output. |

`--bare` is a relevant find: it explicitly DISABLES CLAUDE.md auto-discovery and hooks — the opposite of what Tier 2 needs. Do NOT use `--bare` for the probe.

---

## Plan-B viability

The Phase 3 plan's Plan-B is:
```
claude -p "" --output-format stream-json --include-hook-events --dangerously-skip-permissions
```
Kill child on first `InstructionsLoaded` event.

**Empty prompt `""` fails**: Claude 2.1.123 returns exit code 1 with:
```
Error: Input must be provided either through stdin or as a prompt argument when using --print
```

**Sandbox block**: attempting to spawn `claude -p` with `--dangerously-skip-permissions` from within an Observatory agent session is blocked by the Claude Code sandbox (unsandboxed agent loop prevention). This means the Tier 2 orchestrator **must run as a direct subprocess from the FastAPI backend process**, not from any nested Claude agent context.

**Implication for empty prompt**: a non-empty single-character prompt such as `"x"` would likely be accepted. The correct invocation for Plan B is:
```
claude -p "x" --output-format stream-json --include-hook-events --dangerously-skip-permissions
```
However: with a non-empty prompt, Claude will make an **API call** to Anthropic (the model processes the prompt). This is NOT offline behaviour. The `InstructionsLoaded` events fire before the model call (during session init), so the sequence is:

1. Process spawns, reads CLAUDE.md files → emits `InstructionsLoaded` events.
2. Observatory kills child on first `InstructionsLoaded` hit.
3. Kill happens before the API call completes (and possibly before it starts, depending on timing).

Whether the API call is actually dispatched before the kill depends on the implementation internals of `claude`. We cannot guarantee it is offline.

**Timing target**: Goal is < 10 s from spawn to kill. The CLAUDE.md discovery happens synchronously at session init before any API call, so hitting `InstructionsLoaded` and killing should be well under 10 s on local hardware. However, this is unverified empirically on this machine due to the sandbox constraint.

---

## Event payload shape

`InstructionsLoaded` hook event payload shape per Phase 3 plan (section 5):
```
session_id, cwd, hook_event_name, file_path, memory_type, load_reason,
globs, trigger_file_path, parent_file_path
```

**Status: unverified empirically** — sandbox blocked live capture. The shape listed in the plan comes from the official Claude Code docs (audit round 4). It should be treated as the expected shape pending a real probe outside the agent context.

Fields NOT in the payload per docs: content hash (Observatory computes SHA-256 itself).

---

## Offline-ness

`--init-only` was described in the blueprint as offline. Since `--init-only` does not exist, Plan B uses `-p` with a prompt, which **will** make an API call.

However, the `InstructionsLoaded` events fire during session initialisation (CLAUDE.md loading), which happens before the model round-trip. If Observatory kills the child immediately on the first `InstructionsLoaded` event, the model API call may not have been dispatched yet. This is implementation-dependent and untestable without live subprocess capture.

**Conservative conclusion**: Plan B is not reliably offline. Spawning `claude -p` always involves at minimum an authentication/token check on startup. An outbound connection to `api.anthropic.com` is likely before any user prompt reaches the model.

**Practical implication**: Tier 2 is opt-in ("deep verify" checkbox per Phase 3 plan). The banner should note that each verification run may perform a brief network call to authenticate. This is acceptable given the opt-in nature.

---

## Recommendation: DEFER Tier 2 (ship behind banner)

**Reasons to defer the orchestrator (not the flag):**

1. `--init-only` does not exist. Plan B works but fires a live API call.
2. Plan B with a non-empty prompt produces an actual model response alongside the hook events — the backend must filter that output carefully and kill promptly.
3. Sandbox verification was impossible during this probe session. The orchestrator code must be tested outside an agent loop.
4. The `--bare` flag disables CLAUDE.md discovery — it is NOT an alternative.

**Recommended path:**
- Ship the Tier 2 **flag and UI toggle** in a future commit (gated behind "deep verify: off by default").
- Display a static banner: "Deep verify requires a Claude API call per directory. Enable only if you want real-time load-chain confirmation."
- Implement the orchestrator in the next commit once the sandbox constraint is understood and the backend can be tested via direct `curl`/script.
- Do NOT ship the orchestrator in this commit to avoid brittle behaviour.

**Nothing in this probe blocks Tier 1 (always-on, offline, deterministic).**
