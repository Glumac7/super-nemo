# SUPER-NEMO

A risk-routed coding workflow for [Oh My Pi](https://github.com/can1357/oh-my-pi) (`omp`). Once installed, it runs inside OMP whenever you ask for a change to a Git repository: small changes get a short path, risky ones get a dedicated tester, independent reviewers and a human-review handoff. It is OMP configuration (skills, agents, an extension), not a library you add to your project.

The authoritative workflow is [`skills/super-nemo/SKILL.md`](skills/super-nemo/SKILL.md). This README covers installing, using and maintaining it.

## Install

Requires `omp` 18.3.0+ (signed in with `omp login`), git, Node.js 20+ and npm (the `sn` launcher runs `npm ci` on a fresh checkout).

```sh
curl -fsSL https://raw.githubusercontent.com/Glumac7/super-nemo/main/install.sh | bash
```

This clones to `~/.super-nemo/repo` and proposes models and settings. You confirm them or change them per role, then approve the plan before your OMP config changes. From your own clone, run `./sn install` instead. `--yes` accepts the proposed defaults **and runs the paid live smoke test** unless you also pass `--no-smoke`.

Install links the skills, agents and `extensions/super-nemo.js` into `~/.omp/agent/` (or `~/.omp/profiles/<name>/agent/` with `--profile`) and points `~/.super-nemo/current` at the checkout. It sets the model roles `default` and `nemo-review`, adds `advisor`, `advisor-critical` and `nemo-fast` when you select them, and adds the `AGENTS.md` block, the advisor watchdog and bash allow/deny patterns. It also creates `~/.local/bin/sn` but never edits shell startup files. If `~/.local/bin` is not on `PATH`, use `~/.super-nemo/repo/sn`.

> [!WARNING]
> **Approval defaults are permissive.** Install keeps your existing `tools.approvalMode`. If none is set, it uses `yolo`, and OMP runs commands without asking. Pass `--approval write` or `--approval always-ask` to keep prompts. Eval approval is a separate setting: the fresh default `allow` runs eval code without confirmation, even under `write` or `always-ask`. Use `--eval-approval prompt`, or answer no, to keep the prompt.
>
> Deny patterns are not a sandbox, and a project-level OMP config can override them. `sn verify` warns when the effective value differs from the installed one. Check effective approvals before using this on a sensitive repository. Reviews and smoke tests cost model API calls.

## Use

From the repository you want to change:

```sh
omp "Fix the login form error and check the changed behavior"
omp "super-nemo light: Fix the typo in the footer"   # force a mode: light | normal | critical
```

Change requests trigger the workflow automatically. Questions and code reading don't. `super-nemo:` with no mode, or no prefix at all, lets it choose:

| Mode | When | Path |
| --- | --- | --- |
| LIGHT | Tiny, isolated, low-risk | Implement directly → checks → one `nemo-quality` review |
| NORMAL | Most features, bug fixes, refactors | `nemo-implementer` with advisor → `nemo-tester` → checks → architect, quality, QA and native `reviewer` (plus `nemo-failures` if error handling changed) → `nemo-final-review` |
| CRITICAL | Auth, secrets, PII, migrations, infra/deploy, permissions, money | `nemo-implementer-critical` with a stronger advisor → tester (including abuse cases) → checks including security tooling → NORMAL reviewers plus `nemo-security` and `nemo-performance` → final review → **human review required** |

Rules that hold in every mode:

- Work happens on a non-protected branch, and changes stay local. Only an explicit request in the session lets the orchestrator commit, push the feature branch and open a **draft** PR. It never merges, deploys or marks a PR ready.
- Authors never approve their own work. Implementers own production code, and the tester writes only tests and fixtures, in a disposable copy of the integrated source.
- Infrastructure failures (quota, auth, timeout) leave a gate *not run*, never passed.

**Mechanical gates** ([`lib/gate.mjs`](lib/gate.mjs), loaded by the extension) back up a narrower subset of these rules through OMP tool hooks:

- No agent may read or write `.env`, key, `.npmrc`/`.netrc` or credential files. This includes this repo's own `.npmrc`.
- Per-role write limits apply. Testers write only test paths, implementers never write tests, and `nemo-qa`/`nemo-performance` can't change files from the shell.
- Only the final review's PASS has to match the current working-tree fingerprint. Other specialists just need their latest verdict to be PASS. The diff's own risk sets a minimum mode.
- `git push` and `gh pr create` are refused while tracked reviews are open. In LIGHT, `nemo-quality` only has to have run. The native `reviewer` is not tracked.

If the gate module fails to load, OMP shows a warning and the rules fall back to instructions only. The hooks only see recognized tool calls and are heuristics against same-user processes, not a sandbox.

## Manage the install

```sh
sn status      # installed state, chosen models, settings changed since install
sn verify      # check links and skills; --smoke also runs live light + normal evals
sn update      # fast-forward the checkout, reapply your recorded answers
sn uninstall   # remove what install added, restore settings where safe
sn --help      # all flags
```

Key flags:

| Flag | Effect |
| --- | --- |
| `--profile <name>` | Target a different OMP profile |
| `--dry-run` | Install/uninstall: print the plan only. Update: fetch and list new commits only |
| `--yes` | No questions. This does **not** decide drift (see below) |
| `--reuse` | Install: reuse recorded answers |
| `--name <name>` | Rename the workflow to SUPER-`<NAME>`. `super-nemo` prefixes keep working |
| `--impl`, `--fast`, `--advisor`, `--advisor-critical`, `--review` | Pick a model per role (`sel[:thinking]`) |
| `--keep-settings` / `--overwrite-drift` | Resolve drift non-interactively. The two can't be combined |
| `--no-smoke` | Skip the post-install live test |
| `--pull-only` | Update: fast-forward only, don't reapply |

Exit codes: `0` ok, `1` failed, `2` bad usage, `3` drift needs a decision.

**Drift.** If settings SUPER-NEMO manages were changed by hand, install and update list them and ask whether to keep them all. Without a terminal, or with `--yes`, unresolved drift exits `3`. Add `--keep-settings` (keeps your values and leaves them unmanaged) or `--overwrite-drift`. Unattended examples:

```sh
sn update --keep-settings
sn install --reuse --keep-settings --no-smoke
```

Gotchas:

- **Eval approval and `nemo-performance` override.** An older install may already have `tools.approval.eval` or `task.agentModelOverrides.nemo-performance` set without SUPER-NEMO managing it. Those values stay unmanaged until you explicitly adopt them. Non-interactively, that takes `--overwrite-drift` (plus `--eval-approval allow|prompt` for eval).
- **CRITICAL model check.** Before dispatching `nemo-performance`, CRITICAL checks the model it will actually get. The override wins, then the agent's frontmatter, then the session default. That model must be an available `@advisor-critical`. `@nemo-review` is allowed only when advisors are disabled and neither advisor role is configured. Install sets the override to match, but a missing, weaker or unresolvable selection blocks the run instead of repairing your config.
- **Old prompts.** Start a new OMP session after `sn update`. Running sessions keep the old prompts.
- **Updates.** They need a clean checkout with an upstream branch. If reapplying fails after the fast-forward, the checkout is not rolled back. Rerun with a decision flag.
- **Update notice.** It only appears for the installer-managed checkout of the official repo on `main`, in interactive sessions, at most once every 24 hours. It never installs anything.
- **Launcher.** Uninstall removes `~/.local/bin/sn` only if install created it. If install was interrupted, inspect the file yourself.

## Linear automation (macOS, optional)

A standalone daemon polls Linear (every 30–60 s, default 45). It picks up issues carrying the exact label `auto-implement` in explicitly mapped projects. Each one runs as a **`super-nemo critical:`** task in a private worktree on a new `linear/auto-<issue-uuid>` branch. Issue text is untrusted task input, never configuration.

Before using it:

- Run `omp login`, `sn install` and `sn verify` in the same OMP profile the config names (`--profile <name>`), or omit `profile` to use the default.
- Create the token file with a trusted editor or secret manager, not shell history or command arguments.
- Authenticate `gh` if you will publish.

Config (`~/.config/super-nemo/linear.json`):

```json
{
  "stateDir": "/Users/you/.super-nemo/linear-state",
  "tokenFile": "/Users/you/.config/super-nemo/linear-token",
  "ompPath": "/absolute/path/to/omp",
  "pollSeconds": 45,
  "allowPublish": false,
  "ghPath": "/opt/homebrew/bin/gh",
  "profile": "optional-omp-profile",
  "projects": {
    "<linear-project-uuid>": { "name": "My App", "repo": "/absolute/path/to/repo", "github": "owner/repo" }
  }
}
```

Requirements (checked when the config loads, when the token is read, or when a task is prepared):

- Config, token, state and control directory all live outside every mapped repo, and the token lives outside `stateDir`.
- The config is a single-link `0600` file you own. The token is a `0600` file you own, not a symlink, at most 8 KiB. Never put the token in a plist or the environment.
- `ompPath` and `ghPath` are absolute, trusted (owned by you or root, not group- or world-writable, under trusted parent directories) executables. `ghPath` is only needed when `allowPublish` is true.
- Project keys are real Linear project UUIDs, not names or guesses. The repo path must be the repository root, and its origin must match `github`.
- `allowPublish` defaults to `false`, which leaves a local branch. When `true`, the daemon asks the agent to push and open one **ready (non-draft)** PR, then verifies that PR's repo, branch and head. It never merges or deploys.

> [!CAUTION]
> **`allowPublish` conflicts with the workflow.** The daemon expects a ready PR, but the CRITICAL workflow it requests allows only a **draft** PR and forbids marking it ready. Expect publication to fail verification. Keep `allowPublish: false` until the two agree. This is untested end to end.

```sh
C="$HOME/.config/super-nemo/linear.json"
node lib/linear-cli.mjs status    --config "$C"
node lib/linear-cli.mjs once      --config "$C"   # real pass: may launch paid agents and open PRs
node lib/linear-cli.mjs run       --config "$C"   # poll continuously
node lib/linear-cli.mjs retry     --config "$C"   # resend pending Linear comments only
node lib/linear-cli.mjs install   --config "$C"   # LaunchAgent com.super-nemo.linear.<hash>, logs in <stateDir>/launchd
node lib/linear-cli.mjs uninstall --config "$C"
node lib/linear-cli.mjs acknowledge --config "$C" --issue "$ISSUE_UUID" --confirm-stopped
```

Operational rules:

- **One daemon per macOS user.** The control lock in `~/.super-nemo/linear-control` serializes work. Never delete locks, claims or registration by hand.
- **At-most-once execution.** After a crash, recovery marks the issue `interrupted-in-doubt`, and it is never relaunched automatically. `status` may show the last active state until recovery runs. Agents run in a detached process group. Stop the exact LaunchAgent, independently confirm the poller **and every agent descendant** have stopped, and inspect the branch, worktree and logs. Then `acknowledge` that issue's full UUID. A lock with no matching interrupted issue can't be acknowledged: investigate it, don't guess. `retry` never re-executes a task.
- **Install and uninstall.** The LaunchAgent stores absolute paths, so uninstall it before moving the checkout, Node or `stateDir`. Uninstall refuses while the lock is active: run `launchctl bootout "gui/$(id -u)/<label>"` first, using the label install reported. It keeps state, logs, branches and worktrees.
- **Not a sandbox.** The worktree isolates nothing: OMP runs as your user with your files, network and provider credentials. Don't label untrusted content on an account that holds valuable secrets. Uninstall doesn't revoke the Linear token or your `gh`/OMP logins.

## Repository layout

| Path | Contents |
| --- | --- |
| `skills/super-nemo/` | The workflow ([`SKILL.md`](skills/super-nemo/SKILL.md)) and the fallback PR template |
| `skills/nemo-*-review/`, `skills/super-nemo-security-review/` | Review skills used by the reviewer agents |
| `agents/` | Implementer, tester and reviewer agent definitions |
| `extensions/super-nemo.js` | OMP extension: mechanical gates and the update notice |
| `standards/ENGINEERING.md`, `blocks/AGENTS.md` | Engineering baseline and the block installed into `AGENTS.md` |
| `watchdog/` | Advisor guidance (`WATCHDOG.md`/`.yml`) |
| `config/deny-patterns.json` | Bash allow/deny patterns added to OMP config |
| `sn`, `install.sh`, `lib/` | CLI and installer (`lib/sn.mjs` entry point), gate logic, Linear daemon (`lib/linear-*.mjs`) |
| `test/`, `evals/` | Unit tests and live smoke evals |
| `.github/pull_request_template.md` | PR template for *this* repo only |

## Development

```sh
npm ci
npm test                      # node --test
evals/smoke.sh light          # live eval in a throwaway repo: light|normal|critical|auto|implicit|question
```

Smoke evals call real models, cost money and run `omp` in YOLO mode inside a temp repo. `sn verify --smoke` runs the light and normal ones.
