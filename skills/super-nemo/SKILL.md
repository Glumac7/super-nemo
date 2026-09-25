---
name: super-nemo
description: SUPER-NEMO risk-routed engineering workflow (LIGHT / NORMAL / CRITICAL) on Oh My Pi. Use whenever a message starts with "super-nemo:", "super-nemo light:", "super-nemo normal:" or "super-nemo critical:", and in OMP for any request to change code in a repository (AUTO).
---

# SUPER-NEMO

Standards: `~/.super-nemo/current/standards/ENGINEERING.md`. Repository and company instructions override SUPER-NEMO.

## 0. Runtime

SUPER-NEMO runs on OMP with the `nemo-*` task agents. If your `task` tool does not offer `nemo-implementer`, you are not in OMP. Without a `super-nemo` prefix, ignore this skill and work normally. With a prefix, don't emulate the workflow: tell the user to run `omp "<their original message>"` from the repository, and stop.

## 1. Route

An explicit mode wins. For `super-nemo:` or an unprefixed engineering request (AUTO), classify:

- **CRITICAL** — touches authn/authz, security-sensitive code, secrets, PII, DB migrations, infrastructure/deploy, agent/tool permissions, destructive operations, money, major architecture, or production-critical behavior.
- **LIGHT** — tiny fix, UI tweak, small test, trivial refactor; isolated and low-risk.
- **NORMAL** — everything else (features, business logic, APIs, meaningful refactors, bug fixes).

Between two modes, pick the higher. State the mode and a one-line reason. The chosen mode alone decides the native review gate (§3): LIGHT none, NORMAL and CRITICAL always.

## 2. Prepare (all modes)

1. Must be inside a git repo. Read its instructions and the code the task touches.
2. If on `main`/`master`/a protected branch, create a branch first (repo's naming convention, else `super-nemo/<slug>`). Never commit to a protected branch.
3. Record `BASE=$(git rev-parse HEAD)`.
4. `SN="$(git rev-parse --absolute-git-dir)/super-nemo"; mkdir -p "$SN"` — evidence lives there, inside `.git`, so it is never tracked.
5. Write `$SN/task.md`: intent, acceptance criteria, constraints, relevant files, the repo's check commands. Ask the user only if acceptance criteria are genuinely ambiguous.

Evidence for reviewers (refresh after every change):
- `git add -N . && git diff $BASE > "$SN/diff.patch"` (intent-to-add so new files show; nothing is committed).
- Run the repo's deterministic checks yourself (lint, typecheck, tests, build; security tooling in CRITICAL) and write exact commands + results to `$SN/checks.md`.

Reviewers are read-only and only get what you give them: give their `context` the absolute paths of those three files. Pass evidence, not your conclusions.

## 3. Modes

The mode selects the implementer, and the implementer's definition attaches the advisor (models `@advisor` / `@advisor-critical`, guidance from the SUPER-NEMO watchdog). Never change `advisor.*` settings or run `/advisor` yourself. Advisor notes are input for the implementer, not verdicts.

**Native review gate** (NORMAL and CRITICAL; never LIGHT). OMP's `/review` only expands into a prompt that dispatches the bundled `reviewer` agent, and you cannot type slash commands, so dispatch that agent directly:
- Only once checks are green. Add `agent: "reviewer"` tasks to the mode's review batch, sized like `/review`: 1 task for <100 changed lines or ≤2 files, else split the files across 2 (<500 lines), up to 4 (<2000), up to 8.
- Assignment: the files it owns plus "MUST run `git diff $BASE -- <path>` for assigned files; MAY read full files". Context: the three evidence paths. Add no rubric or output schema; the bundled prompt defines the review.
- It yields `overall_correctness`, `confidence` and findings with `priority` P0–P3, `confidence`, `file_path`, lines.
- Material: P0/P1, or P2 with confidence ≥ 0.8 describing a correctness, security or data-loss defect. Everything else (P3, style, low confidence) is recorded and reported, never fixed or re-reviewed.
- Before forwarding a material finding, read the cited code and confirm it; record refuted findings with the reason instead of fixing them.
- Confirmed findings join the fix loop like `FIX_REQUIRED`. It is an additional gate: never skip or replace a specialist because `reviewer` passed.

**LIGHT** — no swarm, no advisor, no native review gate. If the work turns out bigger or riskier than LIGHT, stop and re-route upward.
1. Implement it yourself.
2. Checks → `checks.md`.
3. One `nemo-quality` review. Fix `FIX_REQUIRED` findings once, re-check.

**NORMAL**
1. Plan: add a short spec to `task.md` (approach, files, tests).
2. Spawn one `nemo-implementer` (`isolated: true` when available) with the spec; it runs with the NORMAL advisor.
3. Diff + checks. If checks fail, send the failures to the implementer via `hub` and repeat until green.
4. One batch in parallel: `nemo-architect`, `nemo-quality`, `nemo-qa`, native `reviewer`.
5. On `FIX_REQUIRED` or a confirmed material `reviewer` finding: message the same implementer via `hub` with the findings, then refresh evidence, re-run the affected checks, and re-run only the reviewers that failed (`reviewer` only if it had material findings). Max two loops, then report what is open.
6. `nemo-final-review` with task, diff, checks and all findings, including `reviewer`'s and any you refuted.

**CRITICAL** — safety over speed.
1. Add requirements and a threat sketch to `task.md`: assets, trust boundaries, abuse cases, rollback.
2. If the design is non-trivial: `nemo-architect` pre-review of the plan.
3. `nemo-implementer-critical` (`isolated: true`); it runs with the stronger critical advisor and reports how it resolved each advisor concern/blocker.
4. Diff + checks including security tooling; green before continuing, as in NORMAL.
5. One batch in parallel: `nemo-architect`, `nemo-security`, `nemo-quality`, `nemo-qa`, native `reviewer`.
6. Fix loop as in NORMAL.
7. `nemo-final-review`.
8. End with **HUMAN REVIEW REQUIRED**: list what the human must check. Don't commit; leave the change on the branch for review.

## 4. Rules

- You orchestrate; you never approve. Verdicts come from the reviewers.
- Never push, merge into protected branches, open PRs, deploy, run destructive DB/infra commands, or read secrets unless the user explicitly asks in this session.
- Report (short): mode, branch, what changed, checks with actual results, each reviewer's verdict (`reviewer`: `overall_correctness` + material findings and how each was resolved), the final verdict, open items.
