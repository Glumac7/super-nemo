# SUPER-NEMO

A risk-routed engineering workflow for [Oh My Pi](https://github.com/can1357/oh-my-pi) (`omp`). Every request to change code is routed to LIGHT, NORMAL or CRITICAL; each mode runs its own set of implementer, advisor and reviewer agents (`nemo-*`) plus OMP's `reviewer`.

## Prerequisites

- `omp` 18.3.0 or newer, logged in to at least one model provider
- Node.js 20+, git, bash

## Install

```sh
git clone <this repository> super-nemo && cd super-nemo
./sn install
```

The installer shows your current values as defaults, prints the full plan and changes nothing until you confirm. Use `./sn install --dry-run` to see the plan only; `./sn --help` lists the flags for scripted installs (`--yes --impl … --no-smoke`).

What it does: links the skills and agents into your OMP agent dir (`~/.omp/agent`, or the `--profile`/`OMP_PROFILE`/`PI_CODING_AGENT_DIR` one), links `~/.super-nemo/current` to this repo, adds marked blocks to `AGENTS.md`/`WATCHDOG.md`, adds a `SUPER-NEMO` advisor to `WATCHDOG.yml`, and sets the keys below in `config.yml`. Every file is backed up first; state lives in `~/.super-nemo/state`. Keep the repo where it is. To move it: `./sn uninstall`, move it, then `./sn install` from the new place.

Coming from a manual install? Move your hand-copied `nemo-*` agents and SUPER-NEMO skills out of the agent dir first; install lists anything in its way and writes nothing until it is clear.

`./sn status` shows roles, drift and broken links. `./sn verify [--smoke]` checks the installation.

## Models

| Role | Used by | Default |
|---|---|---|
| `modelRoles.default` | you and the implementers | your current model, thinking high |
| `modelRoles.nemo-fast` | `scout`, `sonic` (optional) | cheapest reasoning model of the same provider, low |
| `modelRoles.advisor` | NORMAL advisor (can be off) | implementation model, medium |
| `modelRoles.advisor-critical` | CRITICAL advisor | advisor model, high |
| `modelRoles.nemo-review` | all reviewers | a model from another provider if you have one, high |

Tool approval defaults to `write` (not yolo). `eval` always prompts, and a deny list for publish/deploy/destructive/secret-reading commands is put at the head of `bash.patterns`, with a few read-only `git` allow rules at the end (`config/deny-patterns.json`). `git push` is not blocked; the agents only push when you ask.

## Uninstall

```sh
./sn uninstall            # add --dry-run to see the plan
```

Files you did not touch since install are restored byte for byte. Otherwise only our entries are removed; settings you changed yourself are kept and listed. The backups and the state dir go too.

## Cost per mode

Measured on the smoke evals with a Claude Opus-class main model and a GPT reviewer at API prices:

| Mode | Agents | Cost | Time |
|---|---|---|---|
| LIGHT | 1 reviewer | ~$0.40 | ~1 min |
| NORMAL | implementer + advisor, 4 reviewers, final review | ~$1.30 | ~3 min |
| CRITICAL | NORMAL + security review, stronger advisor | more than NORMAL (not measured) | |

The optional smoke run after install (LIGHT + NORMAL) costs about $2 and 5 minutes.

## Limits

- `bash.patterns` is an approval rule, not a sandbox. A project `.omp/config.yml` or a `--config` overlay that sets `bash.patterns` replaces the global list, so the deny list does not apply there.
- A symlinked agent dir or `~/.super-nemo` is followed, and its real path is recorded; if it later points elsewhere, the commands stop. Symlinked `config.yml`/`AGENTS.md`/`WATCHDOG.*` files and symlinked `skills`/`agents` dirs are refused rather than written through.
- Running `omp` creates its own files (`agent.db`, logs); uninstall leaves those alone.
