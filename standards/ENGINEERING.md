# Engineering baseline

Repository and company instructions override this file.

- Understand the required outcome and acceptance criteria before editing; inspect the existing code and design first.
- Preserve the existing architecture unless the task is to change it. Pragmatic Clean Architecture and Clean Code, not ceremony.
- Correct dependency direction: domain does not depend on infrastructure or UI. Side effects at the edges and explicit.
- Simplest maintainable implementation. No speculative abstractions, no duplicated business logic.
- Treat all external input as untrusted. Check authn/authz boundaries and data exposure on every boundary you touch.
- Consider concurrency and idempotency where state is shared or operations can retry.
- Test behavior, not implementation trivia. Cover edge cases and failure paths.
- Deterministic facts come from deterministic checks: run the repo's lint, typecheck, tests, build and security tooling where they exist, and report actual results.
- An implementer never approves its own work. Reviews are independent.
- Review findings need evidence (file:line, a failing command, or a reproducible case). PASS without findings is a valid review outcome; never invent issues.
- Git: work on a non-protected branch or worktree. Never push, merge into main/master/protected branches, deploy, run destructive DB/infra operations, or read secrets without explicit instruction. Keep changes visible to git; don't edit a shared `.gitignore` for tooling — use `.git/info/exclude`.
