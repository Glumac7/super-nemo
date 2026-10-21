# ENG-35: Should Super-Nemo use UHP?

Research date: 2026-10-21. Issue: [ENG-35](https://linear.app/side-projects-glumac/issue/ENG-35/uhp).

## Recommendation

**UHP is worth evaluating as an optional harness interoperability boundary, not as a replacement for Super-Nemo or an immediate dependency.** Its likely value is letting Super-Nemo request work from different complete coding agents through one task/session API. It does not itself improve review judgment, enforce our authorship gates, or prove generated code correct.

The issue does not expand “UHP” or supply a URL. This report assumes **Unified Harness Protocol**, the agent-harness standard at [unifiedharnessprotocol.org](https://unifiedharnessprotocol.org/). If a different UHP was intended, this assessment does not apply.

Decision: keep the OMP-native workflow unchanged. Consider a separately approved, local, read-only reviewer experiment first. Do not install a server, migrate orchestration, or grant remote agents repository write/publication access on the strength of this research.

## What UHP actually provides

The [versioned specification](https://unifiedharnessprotocol.org/spec/2026-10-19/lifecycle) defines HTTP discovery, version negotiation, capability flags, task states and sessions. The [task contract](https://unifiedharnessprotocol.org/spec/2026-10-19/tasks) submits work via `POST /v1/responses`; a configured `metadata.harness_id` selects the agent runtime, and `previous_response_id` continues its session. Streaming and artifact retrieval let a client follow work and collect results.

This is **harness selection**, not merely model selection. Calling Codex or Claude Code means using its own agent loop and tools, rather than running a different model inside OMP. UHP is not a model API, and a Responses-shaped payload does not mean OMP's existing model-provider configuration can use it unchanged.

The [ecosystem guide](https://unifiedharnessprotocol.org/ecosystem) separates UHP's product-to-harness boundary from MCP's agent-to-tools boundary, A2A's collaboration boundary and ACP's editor-to-coding-agent boundary. They can coexist; adding MCP tools alone would not supply interchangeable harness execution.

The [homepage](https://unifiedharnessprotocol.org/) labels version `2026-10-19` a **draft standard** under Apache-2.0, and says a conformant server can run locally without a hosted service. That does not make every backend or model free, local, licensed identically, or available through the user's existing subscription.

## Fit with Super-Nemo

Super-Nemo's current goal is a risk-routed workflow **inside OMP**, not a standalone agent platform: see [README](README.md#whats-in-this-repository) and [workflow](skills/super-nemo/SKILL.md). It already selects models and assigns implementer, tester and reviewer roles. Its differentiation is scope control, independent evidence/review, and human approval, not a missing generic task endpoint.

The following benefits are architectural inferences, not measured improvements:

| Opportunity | Potential value | What still belongs to Super-Nemo |
| --- | --- | --- |
| Cross-harness reviewer | Ask a different agent runtime for a second opinion through a common API. | Supply exact snapshot and evidence; validate findings; preserve independent review and required gates. Different harnesses do not guarantee independent models or better findings. |
| Harness comparison | Reuse task inputs and result collection when comparing OMP with other runtimes. | Control snapshots, models, budgets and scoring; measure defects, false positives, cost and elapsed time. |
| Background worker/status UI | Common task states, events, continuation and files could reduce per-harness adapter code. | Durable issue ownership, Git branch policy, interruption handling, publication authorization and user-visible status. |
| Future non-OMP entry point | An external application could drive a Super-Nemo-enabled runtime through a server adapter. | Prove OMP agents, advisor roles, tools and workflow instructions survive that boundary; this would be a separate product/architecture decision. |

The strongest first use is a supplementary read-only reviewer: it can establish whether another runtime adds useful findings without moving production edits or reviewer acceptance into a new service. It must not substitute for existing mandatory reviewers during evaluation.

## Compatibility gaps and risks

1. **Generic OMP support is not Super-Nemo support.** HarnessRouter's [published support matrix](https://github.com/HarnessRouter/harnessrouter/blob/main/docs/support-matrix.md) includes an `omp` row reporting first-turn, follow-up, model-switch, artifact and recycle passes for an Anthropic configuration. These are upstream claims, not tests run here. They do not establish support for installed `nemo-*` agents, advisor/model-role resolution, task messaging, trusted orchestrator state or our tester-isolation gate. Do not confuse a separate `pi` backend with OMP compatibility.
2. **Permissions must exist below the prompt.** UHP's [security chapter](https://unifiedharnessprotocol.org/spec/2026-10-19/security) explicitly says it cannot prevent prompt injection. A “read-only reviewer” needs enforced filesystem/process/network restrictions in the chosen runtime, not an instruction to avoid writes. The server, configured harness, plugins and artifact path become additional trust boundaries. Local hosting alone does not prevent model-provider data egress.
3. **Tool events are not an approval protocol.** The task specification makes request-level `tools` reserved and ignored; tools run inside the harness, and tool-call outputs are observability, not a client-executed tool loop. Watching an event is not proof that a prohibited action can be intercepted before execution. Configure allowed tools on the server/runtime and verify enforcement separately.
4. **Completion is not acceptance.** `completed` means the harness finished, not that tests passed or reviewers approved. `incomplete`, `failed` and `cancelled` must never be mapped to successful engineering completion. Capability flags must be checked: missing flags mean false; session cancellation and idempotency must not be assumed from the API shape alone.
5. **Model identity and usage need validation.** The task contract permits an explicitly reported authorized model fallback. Super-Nemo roles that require a particular model must reject a fallback rather than quietly accepting it. Usage can be null, so absent cost accounting must not be displayed as zero cost.
6. **Parallelism and retry semantics are not our Git policy.** The lifecycle forbids concurrent tasks in one session but permits different sessions. Separate tasks still need separate workspaces and safe integration. Server idempotency cannot replace existing issue claims, interruption recovery, or a policy against automatically replaying a possibly executed edit/publication.
7. **Artifacts cannot bypass authorship checks.** Returned patches and files are untrusted. Pin their originating source revision, validate paths and content, and preserve our session-held snapshot/digest and test-path allowlist checks before integrating anything. A server session ID or passing conformance badge is not proof of isolation or provenance.
8. **Maturity and operating cost remain open.** The [implementation list](https://unifiedharnessprotocol.org/examples) lists HarnessRouter and SuperQode, with displayed conformance evidence for `2026-09-12`, older than the current draft. The homepage also retains older schema/version examples. Select an exact server release, negotiated protocol version and matching conformance evidence; do not equate a listing with certification or assume latest-version compatibility. A server adds packaging, authentication, retention, upgrades and debugging work even when self-hosted.

## Options

| Option | Assessment |
| --- | --- |
| Stay OMP-native | Recommended default. No new server or protocol boundary; retains our current workflow and evidence model. Does not add complete alternative runtimes. |
| Add one direct CLI adapter | Plausible for one proven harness use case. Less protocol infrastructure, but per-CLI session/error/output handling becomes our responsibility. Compare this with UHP rather than assuming a common protocol is automatically cheaper. |
| Optional UHP client for external workers | Best candidate if multiple runtimes demonstrably help. Keep policy and acceptance in Super-Nemo; isolate task transport behind a narrow boundary only after the experiment justifies it. |
| Replace orchestration or expose Super-Nemo as a UHP service now | Not recommended. Much larger integration and security scope, with no measured benefit and no demonstrated preservation of native OMP workflow semantics. |

## Bounded evaluation proposal — not implemented

A separate implementation decision should authorize the following experiment and its runtime/data access. No provider credentials, server installation, model calls or repository write grants are part of ENG-35.

1. Select and pin one self-hosted server release plus two available harnesses, including the exact OMP build if testing OMP compatibility. Confirm license/provider access, negotiated `UHP-Version`, discovery flags and matching conformance report. Use a disposable synthetic repository with no private code, secrets, home-directory mounts or GitHub/Linear credentials. Enforce read-only reviewer access and bounded runtime/network access independently of task text.
2. Give the OMP-native baseline and each external reviewer the same fixed source snapshot, diff, task contract and evidence. Use a small curated set with known correctness defects, a clean change and hostile repository instructions attempting an unauthorized write/tool call. Record harness/model identity, allowed tools, budgets and the source hash; run three repetitions per case to expose obvious variability.
3. Record confirmed defects found/missed, false positives, elapsed time, tokens/usage where available, actual billed cost where available, and setup/maintenance work. Do not label a harness effect if the model or budget also changed. Unknown usage/cost stays unknown.
4. Exercise unsupported-version rejection, absent capabilities, model fallback, timeout/partial output, cancellation, dropped stream and same-session concurrency. A missing safety capability is a reason to stop or explicitly narrow the experiment, not silently downgrade. Verify actual process termination and denied writes/tool calls independently of returned status. Do not auto-retry ambiguous executions.
5. Separately probe the Super-Nemo-specific gaps: named agents, advisor roles, evidence visibility, independent reviewer context and trusted snapshot handling. A generic harness smoke pass cannot clear these gates. Keep all existing required reviews and publication decisions in the native orchestrator.

**Go for a later optional integration only if** the experiment finds additional confirmed defects missed by the native baseline (without extra false positives), stays within a cost/latency budget agreed before running, demonstrates the needed native workflow semantics, and passes every permission, identity and failure-state check. Stop on any unauthorized action or untraceable result. These are proposed acceptance criteria, not achieved outcomes.

**No-go / defer** if it merely duplicates native reviews, requires broad write/credential access, cannot honor required model/tool policy, or costs more operational work than a single direct adapter. Even a successful small experiment is a signal for a reviewed integration proposal, not evidence for a default migration.

## Evidence limits and bottom line

This is desk research against the primary pages linked above and this repository's README/workflow, not a live UHP integration, security audit or benchmark. Mutable upstream support matrices and implementation listings can change; their claims have not been independently reproduced here. There is no measured quality, speed or cost gain for Super-Nemo.

**Yes, UHP could help take Super-Nemo beyond a single harness. No, adopting it alone would not take the engineering workflow to another level.** The useful hypothesis is cross-harness review quality and reusable execution plumbing; validate that cheaply and safely before adding infrastructure or changing our core workflow.
