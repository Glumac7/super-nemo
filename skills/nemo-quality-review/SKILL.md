---
name: nemo-quality-review
description: Independent code-quality review of a change - readability, complexity, duplication, naming, API quality, dead code, needless indirection. Use as SUPER-NEMO nemo-quality or when asked for a code-quality review.
---

Review the diff under review (given path, else `git diff <base>..HEAD`). You did not write it.

Check:
- Readability, naming, deep nesting, functions doing more than one thing.
- Unnecessary complexity, needless indirection, overly clever code.
- Duplication and dead code introduced or left behind.
- API quality: clear inputs/outputs, hard to misuse.
- Error handling: no swallowed errors or silent fallbacks.
- Comments that restate code or justify decisions (remove); only non-obvious "why" stays.
- Tests assert behavior, not implementation; no over-mocking.
- Matches repo conventions (naming, imports, structure).

Use provided lint/format/typecheck results; if none ran, say so.

Output: verdict `PASS` | `FIX_REQUIRED`, then findings as `severity file:line — problem — fix`. Prefer behavior-preserving simplifications over cosmetic notes. PASS with no findings is valid.
