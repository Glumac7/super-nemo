# SUPER-NEMO

SUPER-NEMO is a risk-routed coding workflow for [Oh My Pi](https://github.com/can1357/oh-my-pi) (`omp`). It runs inside OMP while you work on **your** Git repository; it is not a separate chat app or a library you add to your project. A small change gets a short review path; higher-risk changes get more checks and independent reviewers.

## What's in this repository?

| Path | Purpose |
| --- | --- |
| [`skills/super-nemo/SKILL.md`](skills/super-nemo/SKILL.md) | Routing rules, exact steps for each mode, and review gates |
| [`agents/`](agents/) | Production implementer, dedicated test author, and independent reviewer roles used by OMP |
| [`extensions/`](extensions/) | OMP integration for the workflow |
| [`standards/`](standards/) | Engineering baseline applied during work |
| [`sn`](sn), [`lib/`](lib/), [`install.sh`](install.sh) | Installer and commands to manage or verify the OMP setup |
| [`test/`](test/), [`evals/`](evals/) | Automated tests and live smoke evaluation |

Installation links this workflow into your OMP configuration and sets up model roles; the actual code changes happen in whichever Git repository you open with OMP. Reviewers inspect the change; they do not replace your approval or a security sandbox.

## Install

You need `omp` 18.3.0+ (signed in with `omp login` for the model providers you use), git, and Node.js 20+.

```sh
curl -fsSL https://raw.githubusercontent.com/Glumac7/super-nemo/main/install.sh | bash
```

The installer downloads SUPER-NEMO to `~/.super-nemo/repo`, suggests remote models for coding, advising, and review (not OMP's built-in Ollama, LM Studio, or llama.cpp providers by default), then asks before changing your OMP setup. It keeps model roles and the general approval mode you already selected; explicit local model flags still work. **A fresh setup defaults to YOLO:** OMP runs commands without asking, including commands that change files. Choose `--approval write` or `--approval always-ask` to retain command prompts. Separately, interactive install asks whether eval code may run without confirmation, default [Y/n]: yes enables `tools.approval.eval: allow`, no retains `prompt`. `sn install --yes` accepts the fresh allow default; use `--eval-approval prompt` for unattended installs that require confirmation. Reinstall preselects the saved choice; `--reuse` and `sn update` retain it, including legacy installations that previously managed `prompt`. To change an old prompt choice explicitly, use `--eval-approval allow`. Settings you changed yourself (including eval approval) are not silently replaced; use `--overwrite-drift` to replace them.

If an older installation never managed eval approval, any existing value stays unmanaged unless you explicitly let SUPER-NEMO manage it—even if that value is already `prompt`. Interactive reinstall asks separately before adopting or replacing the value (default: leave it unmanaged); unattended reinstall requires both `--eval-approval allow|prompt` and `--overwrite-drift`. This protects a user-set `deny` from being silently weakened to `prompt`.

## Use it

From the repository you want to work on, ask OMP for a code change as usual:

```sh
cd path/to/your-project
omp "Fix the login form error and check the changed behavior"
```

SUPER-NEMO activates automatically for requests to change a repository. It does not run for questions or code-reading requests. Risk determines the mode:

| Mode | When | Review path |
| --- | --- | --- |
| LIGHT | Tiny, isolated, low-risk fixes | Implement directly, run checks, get one independent quality review |
| NORMAL | Most features, bugs, and meaningful refactors | Production implementer with advisor, dedicated tester, checks, independent architecture/quality/QA reviews and a code review, then final review |
| CRITICAL | Auth, security, secrets, data, infrastructure, deploy, or other high-risk work | Production implementer with stronger advisor, dedicated tester covering failure/abuse paths, security review, and a human-review handoff |

NORMAL and CRITICAL separate authorship: `nemo-implementer` / `nemo-implementer-critical` change production code and its documentation; `nemo-tester` writes behavioral tests and necessary fixtures **after source integration, in a dedicated disposable repository target containing the exact same effective source snapshot**. It receives the absolute target root, source revision/snapshot and an explicit test/fixture allowlist, not the production working tree as an edit target. Dispatch uses `isolated: false` so runtime isolation cannot auto-apply its changes. The tester uses the default coding model, adds no advisor configuration, and never fixes production code or approves work. `nemo-qa` independently verifies acceptance criteria read-only. LIGHT explicitly keeps direct implementation and any necessary tests with the orchestrator, without a dedicated tester.

Before dispatch, the orchestrator retains the pre-tester Git revision, complete integrated-source snapshot's cryptographic digest and approved test/fixture path set in its **trusted session state**. Snapshots/diffs saved under `$SN` are mutable evidence/storage, not trust anchors. Immediately before acceptance and **before any** integration/auto-application, it recomputes the snapshot digest against that session-held anchor and independently generates/audits the full candidate diff, including new files. Agent-supplied digests or summaries are not authority. Modified baselines, out-of-scope production/config/agent/permission edits and auto-applied output are rejected; only independently validated test/fixture changes are applied. It records target/source/test evidence for reviewers, then runs checks after integration. Disposable targets contain only repository material, not copies of home directories, user configuration or secrets.

This authorship gate is a workflow responsibility, **not an OS sandbox**. The tester and its tools are trusted same-user execution: prompts and disposable workspaces do not prevent secret reads, network access or destructive side effects. Such actions remain prohibited by instructions rather than technically confined; this inherited runtime risk requires human review for CRITICAL work.

If the runtime cannot preserve trusted session state or prevent auto-application, the split is **advisory only**: human review of the full diff is required before accepting tester work, and no enforced isolation is claimed.

Each diagram starts **after** you have asked OMP to change code. The orchestrator runs relevant repository checks after source and tests are integrated. Red checks and material findings go to the responsible owner: production defects to the implementer, test/fixture defects or missing coverage to the tester, with specific evidence. Tests must not be weakened to fit a production defect. Source fixes are integrated before the tester updates coverage; affected checks and failed review gates then run again. See the [full workflow](skills/super-nemo/SKILL.md) for routing and review criteria.

### LIGHT

```mermaid
flowchart TD
    A["Small, isolated change"] --> B["Implement directly"]
    B --> C["Run relevant checks"]
    C --> D{"Checks green?"}
    D -- No --> B
    D -- Yes --> E["Independent quality review"]
    E --> F{"Fix required?"}
    F -- Yes --> G["Fix and re-check"]
    G --> H["Report result"]
    F -- No --> H
```

### NORMAL

```mermaid
flowchart TD
    A["Most code changes"] --> B["Production implementer + advisor"]
    B --> T["Integrate source; tester writes tests and fixtures"]
    T --> C["Integrate tests; run relevant checks"]
    C -- Failing --> O{"Production or test defect?"}
    O -- Production --> B
    O -- Tests --> T
    C -- Green --> D["Architecture + quality + read-only QA + code reviews"]
    D --> E{"Material finding?"}
    E -- Yes --> F{"Responsible owner fixes"}
    F -- Production --> P["Implementer fixes; integrate source; tester updates coverage"]
    F -- Tests --> Q["Tester fixes tests or fixtures"]
    P --> R["Integrate tests; re-check affected paths"]
    Q --> R
    R -- Failing --> F
    R -- Green --> J["Re-run failed reviews only"]
    J --> E
    E -- No --> G["Independent final review"]
    G --> H["Report result"]
```

### CRITICAL

```mermaid
flowchart TD
    A["High-risk change"] --> B["Requirements + threat sketch"]
    B --> C["Production implementer + stronger advisor"]
    C --> T["Integrate source; tester covers behavior, failures and abuse"]
    T --> D["Integrate tests; checks including security"]
    D -- Failing --> O{"Production or test defect?"}
    O -- Production --> C
    O -- Tests --> T
    D -- Green --> E["Architecture + security + quality + read-only QA + code reviews"]
    E --> F{"Material finding?"}
    F -- Yes --> G{"Responsible owner fixes"}
    G -- Production --> P["Implementer fixes; integrate source; tester updates coverage"]
    G -- Tests --> Q["Tester fixes tests or fixtures"]
    P --> R["Integrate tests; re-check affected paths"]
    Q --> R
    R -- Failing --> G
    R -- Green --> J["Re-run failed reviews only"]
    J --> F
    F -- No --> H["Independent final review"]
    H --> I["Human review required; no automatic merge"]
```

You can choose a mode explicitly: `omp "super-nemo light: Fix the typo in the footer"` (or `normal` / `critical`). To let it choose, just describe the task; `super-nemo:` also uses automatic selection. Work happens on a non-protected branch. SUPER-NEMO does not push, deploy, or merge unless you explicitly ask.

### Give it your own name

The first install question asks what to call it: type `jake` and it becomes SUPER-JAKE, answering to `super-jake:`, `super-jake light:` and so on (`super-nemo` prefixes keep working). Press Enter to keep SUPER-NEMO. Without questions, pass `--name jake`; `sn install --name nemo` switches back. Updates keep the name you chose.

## Manage the install

```sh
sn status       # Show installation, model choices, and changed settings
sn verify       # Check the installation
sn update       # Fetch updates and reapply your choices
sn uninstall    # Remove SUPER-NEMO; restore settings where safe
```

Install creates an `~/.local/bin/sn` link to the checkout without changing shell startup files or overwriting an existing command. If `~/.local/bin` is not already on `PATH`, add `export PATH="$HOME/.local/bin:$PATH"` to your shell configuration, or keep using `~/.super-nemo/repo/sn` directly. Uninstall removes only the launcher it created; it leaves `~/.local/bin` in place even if install created that directory. If an install is interrupted after creating the command but before recording its identity, recovery leaves the command and pending state untouched rather than risk deleting an unowned replacement; inspect `~/.local/bin/sn`, move it away if appropriate, then retry.

Launcher cleanup is not a security boundary against another process running as your user: a hostile same-user process can replace its private temporary link between verification and deletion during uninstall. Do not run uninstall alongside untrusted same-user processes.

For an installer-managed official GitHub checkout on `main`, interactive OMP sessions make a best-effort background check at most once every 24 hours and may show a notice when a newer commit is available. There are no checks in headless sessions, forks, manually cloned checkouts, or other branches. The notice uses the Git executable recorded at installation; if Git moves, rerun `~/.super-nemo/repo/sn install` from a clean checkout. The notice never installs anything: preview available commits anytime with `~/.super-nemo/repo/sn update --dry-run`, then install manually with `~/.super-nemo/repo/sn update`. Updates require a clean checkout with an upstream branch.

Running the one-line installer again updates its managed checkout. `~/.super-nemo/repo/sn uninstall` asks before removing anything and keeps settings you changed yourself. Use `~/.super-nemo/repo/sn --help` for flags, including `--dry-run` to preview actions and `--profile` for a non-default OMP profile. If you cloned the repository yourself, run `./sn install` and `./sn update --dry-run` / `./sn update` from that checkout instead; these checkouts do not receive automatic notices.

**Costs and safety:** Reviews and the optional live test make model calls, which can incur API charges. The fresh-install YOLO default removes OMP command approval prompts. If you accept eval auto-approval, it applies even with `--approval write` or `--approval always-ask`: eval can execute local code with access to your files and processes without asking first. Choose no at the eval question or pass `--eval-approval prompt` to require eval confirmation. Command deny rules are *not a sandbox*, and a project-level OMP config can replace them. Review commands and permissions before using this on a sensitive project. See the [workflow](skills/super-nemo/SKILL.md) for the full mode rules.
