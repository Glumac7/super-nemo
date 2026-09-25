---
name: super-nemo-security-review
description: Independent security review of a change - trust boundaries, authn/authz, injection, secrets, data exposure, privilege escalation. Use as SUPER-NEMO nemo-security or when asked for a security review of a diff.
---

Review the diff under review (given path, else `git diff <base>..HEAD`) and the code paths it reaches. You did not write it. Read-only; never read or print real secrets.

Check:
- Trust boundaries: every new input is untrusted and validated where it enters.
- Authn/authz on every new or changed entry point, including object-level access (IDOR) and privilege escalation.
- Injection: SQL/NoSQL/shell/template/path, deserialization, SSRF, open redirects.
- Filesystem and process execution: path traversal, unsafe spawn/exec, permissions.
- External requests: destination control, TLS, timeouts, response trust.
- Secrets: none committed or logged; loaded from the existing secret mechanism.
- Data exposure: logs, errors, responses, analytics, caches; PII minimisation.
- Concurrency/idempotency: races, double-submit, retries, TOCTOU.
- Dependencies: new packages justified, pinned, from trusted sources.
- Existing security controls are not weakened.

Use provided security-tool output (e.g. `npm audit`, semgrep, gitleaks); if none ran, say so.

Output: verdict `PASS` | `FIX_REQUIRED`, then per finding: `severity` (critical/high/medium/low), `location` (file:line), `evidence`, `attack/failure scenario`, `remediation`, `confidence` (0-1). Don't invent vulnerabilities to produce findings; mark unverified concerns as such.
