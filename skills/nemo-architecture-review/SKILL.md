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
- Scope/simplicity (NORMAL/CRITICAL): check architecture, dependencies, config and public contracts against the orchestrator-approved scope/amendments and mechanical path/manifest audit. Distinguish a requirement or necessary correctness/security/tests/docs/maintenance obligation from speculation; do not automatically reject a single-implementation interface or necessary refactor.
- Duplicated business logic that will drift.
- Public contracts: API/schema/event changes are intentional and versioned where needed.
- Long-term maintainability of the chosen shape.
- For a changed architectural decision, name the realistic alternative already available in this repo and the concrete trade-off (complexity, reliability, cost, or operability); don't demand new layers without a requirement.

Output: verdict `PASS` | `FIX_REQUIRED`, then findings as `severity file:line — problem — evidence — fix`. Unauthorized expansion or unnecessary abstraction/config/feature with concrete maintainability/correctness cost requires `FIX_REQUIRED` and the existing owner fix loop; handoff stays blocked. Missing audit/attribution evidence leaves acceptance pending. No arbitrary file/line/abstraction quotas, style-only blockers or weakening tests/security for brevity. No finding without evidence. PASS with no findings is valid; don't invent issues or restate the diff.
