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

That is the only behavioural change; it is a no-op on upstream Pi.

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
