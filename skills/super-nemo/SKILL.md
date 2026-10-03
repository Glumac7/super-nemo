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

Between two modes, pick the higher. State the mode and a one-line reason. The chosen mode alone decides the native review gate and test author (§3): LIGHT has neither; NORMAL and CRITICAL always require both, including automatically routed requests.

## 2. Prepare (all modes)

1. Must be inside a git repo. Read its instructions and the code the task touches.
2. If on `main`/`master`/a protected branch, create a branch first (repo's naming convention, else `super-nemo/<slug>`). Never commit to a protected branch.
3. Record `BASE=$(git rev-parse HEAD)`.
4. `SN="$(git rev-parse --absolute-git-dir)/super-nemo"; mkdir -p "$SN"` — evidence lives there, inside `.git`, so it is never tracked.
5. Write `$SN/task.md`: intent, acceptance criteria, constraints, relevant files, the repo's check commands. Ask the user only if acceptance criteria are genuinely ambiguous.

Evidence for reviewers:
- Refresh the diff snapshot after every edit: `git add -N . && git diff $BASE > "$SN/diff.patch"` (intent-to-add so new files show; nothing is committed).
- In NORMAL/CRITICAL, run deterministic checks and behavior probes only after source and test changes are integrated, including on fix loops; never mid-flight. In LIGHT, run them after your direct implementation and any tests.
- At that check stage, run the repo's deterministic checks yourself (lint, typecheck, tests, build; security tooling in CRITICAL) and write exact commands + results to `$SN/checks.md`.
- At that same stage, exercise changed behavior (including a failure/abuse case in CRITICAL) and record observed output in `checks.md`; a green unit suite or lint alone is not operational proof.

Reviewers are read-only and only get what you give them: give their `context` the absolute paths of those three files. Pass evidence, not your conclusions.

## 3. Modes

The mode selects the implementer, and the implementer's definition attaches the advisor (models `@advisor` / `@advisor-critical`, guidance from the SUPER-NEMO watchdog). Never change `advisor.*` settings or run `/advisor` yourself. Advisor notes are input for the implementer, not verdicts.

**Source/test ownership and handoff** (NORMAL and CRITICAL):
- `nemo-implementer` / `nemo-implementer-critical` own production code and its documentation only. `nemo-tester` owns behavioral tests and necessary test fixtures only; it uses `@default`, with no new advisor configuration. Neither approves its own work.
- Finish and integrate source first. BEFORE tester dispatch, retain the pre-tester Git revision, a cryptographic digest of the complete integrated-source snapshot (including new source files), and the approved test/fixture path set in the orchestrator's trusted session state. Record the production worktree's absolute path and base revision in `$SN/task.md`; save a separate source snapshot under `$SN` without overwriting it when refreshing review diffs. Record the explicit test/necessary-fixture allowlist in the task. Files under `$SN` are mutable evidence/storage, not trust anchors; the session-held revision, digest and approved paths are authoritative.
- Prepare a dedicated disposable repository copy/worktree containing EXACTLY that integrated source snapshot, using existing repository copy/diff mechanisms. It must represent the same effective source state, not a stale base. Do not copy home directories, user configuration or secrets. Pass the disposable target's absolute root, source revision/snapshot paths and test/fixture allowlist in the tester's context. Dispatch `nemo-tester` in a later task call with `isolated: false` to avoid runtime auto-application of isolated changes; never give it the production working tree as its edit target or draft tests in parallel with source implementation.
- Immediately before acceptance and BEFORE any integration or auto-application, recompute the stored source snapshot's digest yourself against the session-held expected digest and generate a fresh complete candidate diff (including new files) against that verified baseline. Audit it against the session-held approved test/fixture paths. Never accept an agent-supplied digest, diff summary or changed allowlist as authority. Reject a modified baseline, out-of-scope production/config/agent/permission edits, or auto-applied output; return the candidate to the responsible owner without accepting it. Independently apply only validated test/fixture changes to the production worktree, preserving unrelated user changes. Save the accepted scoped tester diff under `$SN` and provide target root/source snapshot and tester diff evidence paths to reviewers. Repeat with a fresh disposable target and fresh session-held anchors for every tester fix loop.
- If the runtime cannot preserve trusted session state or prevent auto-application, describe the split as advisory only: require human review of the full diff before accepting tester work and never claim enforced isolation. Do not treat mutable evidence files as a substitute for trusted state.
- This is orchestrator-validated authorship, not an OS sandbox. The tester and its tools are trusted same-user execution; prompts and disposable workspaces do not prevent secret reads, network access or destructive side effects. Those actions remain prohibited by instructions, not technically confined. Do not change runtime permissions or advisor configuration to implement the split; include this inherited runtime risk in the CRITICAL human-review handoff.
- Integrate accepted test changes before running deterministic checks yourself. Do not ask authors to run checks mid-flight. `nemo-qa` remains an independent read-only verifier, not a test author or production fixer.
- For red checks or confirmed review findings, send specific evidence (command, expected/observed behavior and location) via `hub` to the appropriate owner: production defects to the same implementer; test/fixture defects or missing coverage to the same tester. Never weaken tests to fit a production defect. For mixed findings, integrate production fixes first, then let the tester update coverage on that state.
- After fixes, refresh evidence, re-run affected checks (including security checks where relevant), and re-run only failed review gates. Keep the same ownership in every fix loop.

**Native review gate** (NORMAL and CRITICAL; never LIGHT). OMP's `/review` only expands into a prompt that dispatches the bundled `reviewer` agent, and you cannot type slash commands, so dispatch that agent directly:
- Only once checks are green. Add `agent: "reviewer"` tasks to the mode's review batch, sized like `/review`: 1 task for <100 changed lines or ≤2 files, else split the files across 2 (<500 lines), up to 4 (<2000), up to 8.
- Assignment: the files it owns plus "MUST run `git diff $BASE -- <path>` for assigned files; MAY read full files". Context: the three evidence paths. Add no rubric or output schema; the bundled prompt defines the review.
- It yields `overall_correctness`, `confidence` and findings with `priority` P0–P3, `confidence`, `file_path`, lines.
- Material: P0/P1, or P2 with confidence ≥ 0.8 describing a correctness, security or data-loss defect. Everything else (P3, style, low confidence) is recorded and reported, never fixed or re-reviewed.
- Before forwarding a material finding, read the cited code and confirm it; record refuted findings with the reason instead of fixing them.
- Confirmed findings join the fix loop like `FIX_REQUIRED`. It is an additional gate: never skip or replace a specialist because `reviewer` passed.

**LIGHT** — explicit tiny-change exception: no swarm, no advisor, no dedicated tester, no native review gate. If the work turns out bigger or riskier than LIGHT, stop and re-route upward.
1. Implement it yourself, including any necessary tests.
2. Checks → `checks.md`.
3. One `nemo-quality` review. Fix `FIX_REQUIRED` findings once, re-check.

**NORMAL**
1. Plan: add a short spec to `task.md` (approach, production files, tests and ownership).
2. Spawn one `nemo-implementer` (`isolated: true` when available) with the spec for production changes only; it runs with the NORMAL advisor.
3. Integrate its source, then dispatch `nemo-tester` with `isolated: false` in the dedicated disposable target containing that exact effective source state, as above, for behavioral tests and necessary fixtures, including failure paths.
4. Audit the complete candidate against the source snapshot and explicit allowlist before applying validated tests, then diff + checks. Route failures to the appropriate owner as above and repeat until green.
5. One batch in parallel: `nemo-architect`, `nemo-quality`, `nemo-qa`, native `reviewer`.
6. On `FIX_REQUIRED` or a confirmed material `reviewer` finding: route to the responsible implementer or tester as above, then refresh evidence, re-run affected checks, and re-run only reviewers that failed (`reviewer` only if it had material findings). Max two loops, then report what is open.
7. `nemo-final-review` with task, diff, checks and all findings, including `reviewer`'s and any you refuted.

**CRITICAL** — safety over speed.
1. Add requirements and a threat sketch to `task.md`: assets, trust boundaries, abuse cases, rollback.
2. If the design is non-trivial: `nemo-architect` pre-review of the plan.
3. `nemo-implementer-critical` (`isolated: true`) for production changes only; it runs with the stronger critical advisor and reports how it resolved each advisor concern/blocker.
4. Integrate its source, then dispatch `nemo-tester` with `isolated: false` in the dedicated disposable target containing that exact effective source state, as above, for behavioral tests and necessary fixtures, including failure and threat-sketch abuse paths.
5. Audit the complete candidate against the source snapshot and explicit allowlist before applying validated tests, then diff + checks including security tooling; route failures by ownership and require green before continuing, as in NORMAL.
6. One batch in parallel: `nemo-architect`, `nemo-security`, `nemo-quality`, `nemo-qa`, native `reviewer`.
7. Fix loop as in NORMAL, preserving production/test ownership and integration order.
8. `nemo-final-review`.
9. End with **HUMAN REVIEW REQUIRED**: list what the human must check. Don't commit; leave the change on the branch for review.

## 4. Rules

- You orchestrate; you never approve. Verdicts come from the reviewers.
- Never push, merge into protected branches, open PRs, deploy, run destructive DB/infra commands, or read secrets unless the user explicitly asks in this session.
- Report (short): mode, branch, what changed, checks with actual results, each reviewer's verdict (`reviewer`: `overall_correctness` + material findings and how each was resolved), the final verdict, open items.
