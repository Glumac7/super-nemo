---
name: nemo-quality-review
description: Independent code-quality review of a change - readability, complexity, duplication, naming, API quality, dead code, needless indirection. Use as SUPER-NEMO nemo-quality or when asked for a code-quality review.
---

Review the diff under review (given path, else `git diff <base>..HEAD`). You did not write it.

For an explicitly identified LIGHT task, use one focused pass over the supplied scope contract, diff and check evidence. Read surrounding code/direct callers only as needed to substantiate a defect; do not broaden into a repository audit, spawn agents or request another review round. Return `FIX_REQUIRED` only for evidence-backed material defects: incorrect behavior, security risk, broken contract, unauthorized scope, or unnecessary complexity with a concrete maintenance cost. Optional polish/style suggestions are non-blocking and must not turn a `PASS` into `FIX_REQUIRED`. Missing evidence needed to establish correctness must be named precisely, not replaced with speculative concerns. The orchestrator owns the single fix/re-check pass and reports any unresolved material findings.

Check:
- Scope/simplicity (all SUPER-NEMO modes, including LIGHT): compare every task-attributable change with the orchestrator-approved contract and authorized amendments. Require a requirement or necessary correctness/security/tests/docs/maintenance obligation; check mechanical path/manifest audit evidence and dirty-work attribution, not an author's summary. Missing audit evidence or unproven attribution leaves acceptance pending.
- Readability, naming, deep nesting, functions doing more than one thing.
- Unnecessary complexity, needless indirection, overly clever code.
- Duplication and dead code introduced or left behind.
- API quality: clear inputs/outputs, hard to misuse.
- Error handling: no swallowed errors or silent fallbacks.
- Comments that restate code or justify decisions (remove); only non-obvious "why" stays.
- Tests assert behavior, not implementation; no over-mocking.
- Matches repo conventions (naming, imports, structure).
- Trace changed public functions through their callers when judging an API simplification; a locally cleaner signature is not a win if it breaks consumers or duplicates conversion elsewhere.

Use provided lint/format/typecheck results; if none ran, say so.

Output: verdict `PASS` | `FIX_REQUIRED`, then findings as `severity file:line — problem — evidence — fix`. Unauthorized expansion or unnecessary abstraction/config/feature with concrete maintainability/correctness cost requires evidence-backed `FIX_REQUIRED` through the existing owner fix loop; handoff stays blocked. Prefer behavior-preserving simplifications, not arbitrary file/line/abstraction quotas or style-only blockers. Legitimate interfaces and necessary refactors are not defects; never weaken tests/security to shorten code. PASS with no findings is valid.
