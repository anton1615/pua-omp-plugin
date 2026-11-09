# pua-omp-plugin

PUA high-agency governance extension + skill, packaged for **omp (Oh My Pi)**.

Derived from [`tanweai/pua`](https://github.com/tanweai/pua) `pi/package` (v3.5.1, MIT).

This is a standalone derivative package, not a GitHub fork of the upstream repo:
upstream has no root `package.json` (its installable unit is the `pi/package`
subdirectory), and `omp plugin install` / bun git specs cannot address a
subdirectory (`github:tanweai/pua#pi/package` resolves `pi/package` as a git ref).
A fork would also mirror the whole upstream tree and cannot be narrowed.

## Why a fork

omp passes `before_agent_start` `systemPrompt` as `string[]` (one entry per prompt
block); upstream Pi declares it as `string`. The upstream extension does
`String(event.systemPrompt) + behavior`, which in omp fuses every base block into
one comma-joined string. omp closed the compatibility issue as `not_planned`
([#12511](https://github.com/can1357/oh-my-pi/issues/12511)), so the adapter keeps
the host's own shape here:

```ts
const behavior = behaviorPrompt(config, failures);
const base = event?.systemPrompt;
const systemPrompt = Array.isArray(base) ? [...base, behavior] : `${String(base ?? "")}${behavior}`;
```

That shape adaption remains; on upstream Pi it is a no-op.

## Claude Code hook parity

The Claude Code plugin gates its context on user frustration and keeps failure
pressure that successes never reset. This extension ports that policy:

- **Frustration gate.** The base context block is injected on every enabled turn.
  When the submitted prompt matches the trigger set from
  `hooks/frustration-trigger.sh` (single regex, CJK included), an extra
  frustration paragraph is appended. Matching uses the prompt text
  `before_agent_start` already carries, so it works in every mode, including
  print mode.
- **Pressure accounting.** Only failed tool calls increment `~/.pua/.failure_count`
  (an error result, or a non-zero exit code); a successful call never resets it.
- **Integrity guard.** Writes that name a protected path are refused with the
  ported reason: CI config, scoring/grader/verifier assets, hidden-solution
  artifacts, secrets, status/progress files, and memory files. Test-file writes
  pass with a passive warning instead of a block.
- **Compaction state.** `session_before_compact` writes
  `~/.pua/checkpoint.json` (`level`, `failures`, `flavor`, `saved_at`); a newer
  checkpoint than the live counter is restored on session start.
- **Stop reminder.** `session_stop` (the per-turn stop hook) emits one visible
  completion reminder, at the first stop of a session, and records no rating.

### Documented divergences from the Claude hooks

| Divergence | Why |
|---|---|
| Test-file writes are advisory, not blocked | omp runs (including this repo's own `ce-work` runs) author tests; a hard block makes the plugin unusable. Evidence that would flip this: a run where the model weakened an existing assertion after the warning. |
| Shell-mediated writes are not intercepted | The guard inspects tools that name a file; a `bash` redirect into a protected path passes. Porting the Claude mutating-command heuristic is deferred. |
| `ast_edit` rewrites apply unguarded | `ast_edit` only previews; the apply pass is a `write` to `xd://resolve`, which names staged state rather than a file, so a globbed rewrite can reach a protected path. |
| No blocking stop loop, subagent teardown, or survey rating | omp's `session_stop` continuation cap, the absence of a subagent-stop event, and the interactive rating flow are out of scope for the extension. |

## Install

```bash
omp plugin install github:anton1615/pua-omp-plugin
```

Then restart omp. Commands:

| Command | Effect |
|---|---|
| `/pua-on` | enable persistent diligence context |
| `/pua-off` | disable it |
| `/pua-status` | show config, failure count, pressure level |
| `/pua-reset` | reset the failure counter |

State is shared with the Pi / Claude Code / Codex versions of PUA:

```
~/.pua/config.json
~/.pua/.failure_count
```

The `pua` skill ships in `skills/pua/` and is auto-discovered by omp's
conventional plugin scan (`skill:pua`).

## Governance boundary

Does not replace sandboxing, permissions, or human approval. Action, self-review,
scoring, and environment mutation stay separated so "looks done" never passes as
"verified done".
