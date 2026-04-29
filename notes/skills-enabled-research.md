# Skills `enabled` toggle — how to actually disable a skill

**TL;DR**: do NOT write to `~/.claude/remote/plugins/<hash>/manifest.json`. The
official mechanism is a `Skill(name)` deny rule in `permissions.deny` of any
`settings.json` file. Recommended write target for Observatory:
`~/.claude/settings.json` → `permissions.deny[]`.

## What I checked (29 Apr 2026)

### 1. `~/.claude/settings.json`

No `disabledSkills`, `enabledSkills`, or any skills-specific key. Existing
shape:

```json
{
  "permissions": { "defaultMode": "bypassPermissions" },
  "hooks": { ... },
  "statusLine": { ... },
  "enabledPlugins": { ... },
  "effortLevel": "medium",
  "skipDangerousModePermissionPrompt": true
}
```

There is no `permissions.deny` array yet — we'd be creating it.

### 2. `~/.claude/settings.local.json`

`permissions.allow` array exists with ~300 entries; no `permissions.deny` and
no skills-specific key. This file is the obvious second-choice write target
(it's already where local-only permission overrides live), but it scrolls
forever which is bad UX for "manage my skills".

### 3. `~/.claude/remote/plugins/<hash>/manifest.json`

Each manifest has `skills[].enabled` flags (currently every flag is `true`
across the 33 manifests on this machine). Mtimes show repeated rewrites:

| File                                                | Last touched (UTC)         |
| --------------------------------------------------- | -------------------------- |
| `4a62c0716efd1082/manifest.json` (most recent)      | 2026-04-29 16:33:26        |
| `127cf34abbfed201/manifest.json` (oldest)           | 2026-04-21 18:27:13        |

Several manifests were rewritten within the last few hours of the snapshot
(current time 2026-04-29 19:08). That confirms Claude Code re-fetches and
overwrites these files on its own schedule — any manual edit Vasya makes
to `enabled: false` will be wiped on the next refresh. This file is the
WRONG write target.

### 4. Official Claude Code docs

`https://code.claude.com/docs/en/skills` (the "Restrict Claude's skill
access" section) and `https://code.claude.com/docs/en/permissions` (the
"Permission rule syntax" + "Tool-specific permission rules" sections) are
explicit:

> **Allow or deny specific skills** using permission rules:
>
> ```text
> # Allow only specific skills
> Skill(commit)
> Skill(review-pr *)
>
> # Deny specific skills
> Skill(deploy *)
> ```
>
> Permission syntax: `Skill(name)` for exact match, `Skill(name *)` for
> prefix match with any arguments.

So the API is `Skill(name)` literals inside `permissions.deny[]` (or
`permissions.allow[]`), not a separate `disabledSkills` key.

### Bonus mechanism: `disable-model-invocation: true`

The docs also call out per-skill frontmatter `disable-model-invocation: true`
as a way to hide a skill from Claude entirely (still lets the user invoke it
via `/skill-name`). This is a different semantics: "user can run, model
can't auto-trigger". Useful for `/deploy`-style skills, NOT the "kill switch"
Vasya wants.

For Observatory's "off / on" toggle in the Extensions view, deny rules are
the right primitive — they kill the skill for both user and model.

## Recommendation for Observatory

**Write target**: `~/.claude/settings.json` → `permissions.deny[]`. Add
`Skill(<skill-name>)` entries to disable, remove them to re-enable.

**Why not `settings.local.json`**: it's already an unwieldy 300-line file
of one-off Bash allowances. Keeping skill toggles in the smaller, curated
`settings.json` makes the intent visible and easier to read at a glance.

**JSON shape we'll write**:

```json
{
  "permissions": {
    "defaultMode": "bypassPermissions",
    "deny": ["Skill(consolidate-memory)", "Skill(setup-cowork)"]
  },
  "...": "..."
}
```

When the toggle flips off:

1. Read `~/.claude/settings.json`.
2. Ensure `permissions` object exists (it does on Vasya's machine — we
   already see `permissions.defaultMode`).
3. Ensure `permissions.deny` array exists (we'll create it on first toggle).
4. Append `Skill(<name>)` if absent.
5. Run through the standard `/api/preview` + `/api/write` pipeline so the
   diff modal lands like every other write.

When the toggle flips on:

1. Same read sequence.
2. Filter `Skill(<name>)` out of `permissions.deny`.
3. If `deny` becomes empty, drop the key entirely (smaller file).

## Gotchas

1. **Skill name format**. `Skill(name)` exact match vs `Skill(name *)` prefix
   match. For toggling a whole skill including its `/skill-name` invocations
   we should use the prefix form: `Skill(consolidate-memory *)` — otherwise
   only the bare `/consolidate-memory` (no arguments) is denied. Verify
   empirically before shipping by setting one and asking Claude to invoke
   it with arguments.

2. **Plugin-namespaced skills**. The docs note plugin skills use a
   `<plugin>:<skill-name>` namespace. So `Skill(anthropic-skills:pdf)` may
   be the correct form for skills shipped from a plugin manifest.
   Observatory's existing `/api/extensions` SkillCard already carries
   `plugin_id` — the toggle handler should compose the deny string as
   `Skill(<plugin_id>:<name> *)` for plugin-sourced skills and
   `Skill(<name> *)` for personal/project skills. Verify on the live
   manifest data before trusting this.

3. **Settings precedence**. Managed > project > user. If Vasya ever
   inherits managed settings from somewhere (he doesn't today, but might if
   he plugs into an org policy file), our user-level deny rules can be
   overridden. Not a blocker now, but the UI should surface the source of
   each rule when it eventually grows.

4. **Live reload**. The skills doc says skill directory changes are
   picked up live ("Live change detection"). Whether `permissions.deny`
   changes are also picked up live within an active session is NOT
   documented — probably yes (permissions usually are), but expect the
   first user-visible disable to require a re-prompt or a session restart.
   Surface this in the toast: "disabled — restart Claude Code to apply
   in active sessions" if we hit issues during testing.

5. **`bypassPermissions` mode interaction**. Vasya's `defaultMode` is
   `bypassPermissions`. The permissions doc says "Deny rules always take
   precedence" and "Hook decisions do not bypass permission rules", but
   verify experimentally that `bypassPermissions` doesn't somehow short-
   circuit `Skill(...)` deny rules.

## Out of scope for the toggle PR

- Plugin disable/enable (already lives in `enabledPlugins` in
  `~/.claude/settings.json` — separate code path).
- MCP disable (per blueprint answer 12: move into `mcpServers_disabled`).
- The actual UI for the toggle — that's frontend-dev's task.

This research note should give the next backend ticket enough to wire the
skill-toggle endpoint without re-doing discovery.
