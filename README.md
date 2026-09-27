# SUPER-NEMO

SUPER-NEMO is a coding workflow for [Oh My Pi](https://github.com/can1357/oh-my-pi) (`omp`). It picks a review process based on the risk of your request: small changes stay small; higher-risk changes get more checks and independent reviewers. It runs inside OMP, not as a separate chat app.

We use OMP because SuperNemo isn't just “an AI that writes code.” It's an orchestration system of implementers, advisors and independent reviewers, and OMP gives us unusually good primitives for building that

## Install

You need `omp` 18.3.0+ (signed in with `omp login` for the model providers you use), git, and Node.js 20+.

```sh
curl -fsSL https://raw.githubusercontent.com/Glumac7/super-nemo/main/install.sh | bash
```

The installer downloads SUPER-NEMO to `~/.super-nemo/repo`, suggests models for coding, advising, and review, then asks before changing your OMP setup. It backs up files it changes. The optional live test makes additional model calls; you can skip it.

## Use it

From the repository you want to work on, ask OMP for a code change as usual:

```sh
cd path/to/your-project
omp "Fix the login form error and check the changed behavior"
```

SUPER-NEMO activates automatically for requests to change a repository. It does not run for questions or code-reading requests. It selects:

| Mode | When | What happens |
| --- | --- | --- |
| LIGHT | Small, low-risk changes | Implement, check, quality review |
| NORMAL | Most code changes | Implementer with advisor; checks and independent reviews |
| CRITICAL | Security, secrets, data, deploy, or other high-risk changes | Stronger advisor, security review, and human-review handoff |

You can choose a mode explicitly: `omp "super-nemo light: Fix the typo in the footer"` (or `normal` / `critical`). To let it choose, just describe the task; `super-nemo:` also uses automatic selection. Work happens on a non-protected branch. SUPER-NEMO does not push, deploy, or merge unless you explicitly ask.

## Manage the install

```sh
~/.super-nemo/repo/sn status       # Show installation, model choices, and changed settings
~/.super-nemo/repo/sn verify       # Check the installation
~/.super-nemo/repo/sn update       # Fetch updates and reapply your choices
~/.super-nemo/repo/sn uninstall    # Remove SUPER-NEMO; restore settings where safe
```

`sn update` requires a clean checkout with an upstream branch. `sn uninstall` asks before removing anything and keeps settings you changed yourself. Use `~/.super-nemo/repo/sn --help` for flags, including `--dry-run` to preview install, update, or uninstall and `--profile` for a non-default OMP profile. If you cloned the repository yourself, use `./sn install` and the corresponding `./sn` commands from that checkout instead.

**Costs and safety:** Reviews and the optional live test make model calls, which can incur API charges. The installer defaults to tool approval on writes, but its command deny rules are *not a sandbox*: a project-level OMP config can replace them. Review commands and permissions before using this on a sensitive project. See the [workflow](skills/super-nemo/SKILL.md) for the full mode rules.
