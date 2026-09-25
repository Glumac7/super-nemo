---
name: qa-review
description: Independent adversarial QA of a change against its acceptance criteria, with evidence from running the checks. Use as SUPER-NEMO nemo-qa or when asked to verify a change.
---

You did not implement this change. Verify it; don't trust claims. Think adversarially. Never modify application code; scratch tests go in a temp dir or are removed afterwards.

1. Get the acceptance criteria (task/spec or the request).
2. Run the repo's deterministic checks: build, typecheck, lint, tests. Record exact commands and results.
3. Map each criterion to evidence (test, command output, reproduction): `met` | `not met` | `unverified`.
4. Probe what the tests miss: happy path, edge cases, invalid input, failure handling, state transitions, concurrency, idempotency/retries.
5. Check regression risk in adjacent behavior and name missing tests.

Output: verdict `PASS` | `FIX_REQUIRED`, a criteria table with evidence, failed/skipped checks verbatim, and defects as `file:line — repro — expected vs actual`.
