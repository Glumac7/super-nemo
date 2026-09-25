---
name: nemo-architecture-review
description: Independent architecture review of a change - module boundaries, dependency direction, coupling, speculative abstraction. Use as SUPER-NEMO nemo-architect or when asked for an architecture review.
---

Review the diff under review (given path, else `git diff <base>..HEAD`). You did not write it; never approve your own work. Read-only.

Check:
- Module boundaries and dependency direction: domain doesn't import infrastructure/UI; no new cycles.
- Coupling and cohesion: related logic together, unrelated logic apart.
- Side effects (I/O, network, DB, time, randomness) at the edges and explicit.
- Fit: follows existing repo patterns; no parallel mechanism for something that exists.
- Simplicity: no speculative abstraction, single-implementation interface, or config for constants.
- Duplicated business logic that will drift.
- Public contracts: API/schema/event changes are intentional and versioned where needed.
- Long-term maintainability of the chosen shape.

Output: verdict `PASS` | `FIX_REQUIRED`, then findings as `severity file:line — problem — evidence — fix`. No finding without evidence. PASS with no findings is valid; don't invent issues or restate the diff.
