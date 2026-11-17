// Mechanical SUPER-NEMO gates, loaded by extensions/super-nemo.js.
//
// SKILL.md describes ownership, review and publication rules in prose; this module enforces the
// parts OMP's extension API can check deterministically (ported from a Claude Code verify-gate):
//   - tool_call: secrets are never read; nemo-tester writes only test/fixture paths; implementers
//     never write tests; nemo-qa / nemo-performance bash stays read-only; git push / gh pr create
//     wait for the review gate. Risky edits get a non-blocking security note.
//   - receipts: reviewer verdicts are captured from their structured `yield`, bound to a content
//     fingerprint (git tree) of the working tree.
//   - session_stop: a run with unreviewed changes is refused once per code state, with the missing
//     gates listed. The diff's own risk sets a minimum mode the orchestrator cannot route below.
//   - tool_result: UI edits are linted with `impeccable detect` when it is installed.
// It is not a sandbox: shell heuristics can be bypassed by a determined agent.

import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------- path classes

export const SENSITIVE_FILE = /(^|\/)(\.env(\.(?!example$|sample$|template$|dist$)[^/]*)?|[^/]*\.(pem|key|p12|pfx|keystore)|id_(rsa|ed25519|ecdsa)|\.npmrc|\.netrc|credentials(\.json)?)$/i;
export const TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs|e2e)\/|(^|\/)test_[^/]*\.py$|_test\.(py|go)$|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)Tests\//i;
const FIXTURE_PATH = /(^|\/)(fixtures?|__fixtures__|testdata|__snapshots__|__mocks__)\//i;
const SENSITIVE_PATH = /auth|login|session|token|passw|secret|credential|crypt|permission|acl|rbac|payment|billing|checkout|stripe|webhook|oauth|jwt|saml|sso|admin|migrat|\.sql$|security|sanitiz|upload|(^|\/)\.github\/workflows\/|dockerfile|terraform|\.tf$/i;
const RISKY_CODE = /\beval\(|\bexec\(|subprocess|child_process|os\.system|shell\s*=\s*True|dangerouslySetInnerHTML|\.innerHTML|pickle\.loads?|yaml\.load\(|\brm\s+-rf|DROP\s+TABLE|DELETE\s+FROM|\b(SELECT|INSERT|UPDATE)\b[^\n]*(\+\s*\w|\$\{|%s|f"|\.format\()|jwt|bcrypt|hashlib|createHash|\bcrypto\b|fs\.(rm|unlink)|os\.remove|shutil\.rmtree|chmod|setuid/i;
// The edit-time warning skips the crypto/hash words above: they are risk signals, not mistakes.
const RISKY_EDIT = /\beval\(|\bexec\(|child_process|os\.system|shell\s*=\s*True|dangerouslySetInnerHTML|\.innerHTML\s*=|pickle\.loads?|yaml\.load\(|\brm\s+-rf|\b(SELECT|INSERT|UPDATE|DELETE)\b[^\n]*(\+\s*\w|\$\{|%s|f"|\.format\()/i;
export const ERROR_HANDLING = /\btry\b|\bcatch\b|\bexcept\b|\.catch\(|\brecover\(|unwrap_or|\|\|\s*true|\bfinally\b|\brescue\b|if err != nil/;
const REMOVED_GUARD = /\b(raise|throw|assert|deny|forbid|permission|authori[sz]e?|is_?admin|require|abort|validate|guard)\b/i;
const DOC = /\.(md|mdx|txt|rst|adoc|png|jpe?g|gif|webp|ico|pdf)$|(^|\/)(LICEN[CS]E|NOTICE|AUTHORS|CHANGELOG|CONTRIBUTING|CODEOWNERS)(\.\w+)?$/i;
const CONFIG = /(^|\/)(package(-lock)?\.json|pnpm-(lock|workspace)\.yaml|yarn\.lock|bun\.lockb?|tsconfig[^/]*\.json|jsconfig\.json|pyproject\.toml|setup\.(py|cfg)|requirements[^/]*\.txt|Pipfile(\.lock)?|poetry\.lock|uv\.lock|go\.(mod|sum)|Cargo\.(toml|lock)|Package\.(swift|resolved)|Makefile|Dockerfile[^/]*|docker-compose[^/]*|turbo\.json|nx\.json|vercel\.(json|ts)|\.nvmrc|[^/]*\.config\.[cm]?[jt]s|\.eslintrc[^/]*|\.babelrc|[^/]*\.(ya?ml|toml|tf|gradle|xcconfig|plist))$|(^|\/)\.github\/|(^|\/)migrations?\/|\.sql$/i;
const UI_FILE = /\.(tsx|jsx|vue|svelte|astro|html|css|scss|sass|less)$/i;

export function category(p) {
  if (DOC.test(p)) return "docs";
  if (TEST_PATH.test(p) || FIXTURE_PATH.test(p)) return "test";
  if (CONFIG.test(p)) return "config";
  return "code";
}

// ---------------------------------------------------------------- tool inputs

const local = (p) => typeof p === "string" && p && !/^[a-z][a-z0-9+.-]*:\/\//i.test(p.replace(/^file:\/\//, ""))
  ? p.replace(/^file:\/\//, "").replace(/^\[(.+?)#[^\]]*\]$/, "$1") : null;

// Paths a write-capable tool call targets. `edit` names its files inside the patch text.
export function writeTargets(tool, input = {}) {
  const out = [];
  if (tool === "write") out.push(input.path);
  if (tool === "ast_edit") out.push(...(Array.isArray(input.paths) ? input.paths : []));
  if (tool === "edit") {
    if (typeof input.path === "string") out.push(input.path);
    if (Array.isArray(input.paths)) out.push(...input.paths);
    const text = typeof input.input === "string" ? input.input : "";
    for (const re of [/^\[([^\]#\n]+)#[^\]\n]*\]/gm, /^\*\*\* (?:Add|Update|Delete|Edit) File: (.+?)\s*$/gm, /^\*\*\* Move to: (.+?)\s*$/gm]) {
      for (const m of text.matchAll(re)) out.push(m[1]);
    }
  }
  return [...new Set(out.map(local).filter(Boolean))];
}

// Paths whose *contents* a read-only tool call returns.
export function readTargets(tool, input = {}) {
  if (tool !== "read" && tool !== "grep") return [];
  const p = local(input.path);
  return p ? [p.replace(/:(raw|img|\d+(-\d+)?)$/, "").split("?")[0]] : [];
}

const words = (cmd) => cmd.split(/[\s;&|()<>"'`=]+/).filter(Boolean);
export const mentionsSecret = (cmd) => words(cmd).some((w) => SENSITIVE_FILE.test(w));

// ponytail: shell heuristics, not a parser; `node -e "a>b"` reads as a redirect. Good enough to stop
// a reviewer drifting into edits; a real sandbox would need OS-level isolation.
const WRITE_BASH = new RegExp([
  String.raw`(^|[;&|(]\s*|\s)(rm|mv|cp|mkdir|rmdir|touch|chmod|chown|ln|tee|truncate|dd|patch|install)\s`,
  String.raw`(^|[^0-9&>])>{1,2}\s*(?!\/dev\/null|&)[^\s>]`,
  String.raw`\bsed\s+(-[a-zA-Z]*i|--in-place)`,
  String.raw`\b(perl|ruby)\s+-[a-zA-Z]*i`,
  String.raw`\bgit\s+(add|commit|push|checkout|switch|reset|restore|apply|am|stash|rm|mv|clean|merge|rebase|cherry-pick|revert|tag)\b`,
  String.raw`\b(npm|pnpm|yarn|bun)\s+(i|install|add|remove|uninstall|update|up|link|publish|ci)\b`,
  String.raw`\bpip3?\s+install\b`,
].join("|"));
export const writesFiles = (cmd) => WRITE_BASH.test(cmd);
export const PUBLISH = /\bgit(?:\s+(?:-[Cc]\s+\S+|--?[\w-]+(?:=\S+)?))*\s+push\b|\bgh\s+pr\s+(create|ready|merge)\b/;
// gh api calls that can write: an explicit write method, any request-body flag, or GraphQL.
// A write method anywhere wins over a GET elsewhere in the command.
export function ghApiWrite(cmd) {
  if (!/\bgh\s+api\b/.test(cmd)) return false;
  if (/\bgraphql\b/.test(cmd) || /(-X|--method)[\s=]*(POST|PATCH|PUT|DELETE)\b/i.test(cmd)) return true;
  return !/(-X|--method)[\s=]*GET\b/i.test(cmd) && words(cmd).some((w) => /^(-[fF]|--field|--raw-field|--input)/.test(w));
}
// What the orchestrator's publication gate checks: a real push / PR command.
export const publishes = (cmd) => PUBLISH.test(cmd) || (ghApiWrite(cmd) && /\/pulls\b|graphql/.test(cmd))
  || (/\bgit\b/.test(cmd) && (/\b(send-pack|http-push)\b/.test(cmd) || /\balias\.[\w-]+=\S*push/.test(cmd)));
// Subagents may never publish, so their test is broad: any git command naming push or a push plumbing
// command, git aliases (which can hide one) and any gh api write.
export const subagentPublishes = (cmd) => publishes(cmd) || ghApiWrite(cmd)
  || (/\bgit\b/.test(cmd) && (words(cmd).some((w) => ["push", "send-pack", "http-push"].includes(w)) || /\balias\./.test(cmd)));
// The directory a publish command acts on: `git -C <dir>` or a leading `cd <dir> &&`.
// Returns null when the target cannot be told with confidence (the push is then refused).
export function publishDir(cmd, cwd) {
  if (/--git-dir|--work-tree|\bGIT_DIR=|\bGIT_WORK_TREE=/.test(cmd)) return null;
  const m = /\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)(?=\s|$)/.exec(cmd) ?? /^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*&&/.exec(cmd);
  if (!m && /(^|[;&|(]\s*)(cd|pushd)\s/.test(cmd)) return null;
  // One directory change at most, written plainly; anything else is ambiguous and refused.
  if ((cmd.match(/(^|[\s;&|(])(-C|cd|pushd)(?=[\s"'\\]|$)/g) ?? []).length > 1 || /-C["'\\]|["'\\]-C/.test(cmd)) return null;
  const arg = m?.[1].replace(/^["']|["']$/g, "");
  if (arg !== undefined && !/^[\w.\/@+,:-]+$/.test(arg)) return null;   // plain path characters only: no expansion, globs or quoting tricks
  const dir = arg ? path.resolve(cwd ?? ".", arg) : cwd;
  if (dir && !fs.existsSync(dir)) return null;
  return dir && /(^|\/)\.git(\/|$)/.test(dir) ? null : dir;   // inside .git the repository would not be seen
}

export const PROD_AUTHORS = new Set(["nemo-implementer", "nemo-implementer-critical"]);
export const READ_ONLY_BASH = new Set(["nemo-qa", "nemo-performance"]);
export const REVIEWERS = new Set(["nemo-architect", "nemo-quality", "nemo-qa", "nemo-security", "nemo-performance", "nemo-final-review", "nemo-failures"]);

// Per-call policy. agent: lowercase agent name ("" for the main session). rel maps a target to its
// repository-relative path, so a parent folder named "tests" does not make a file a test.
// Returns {block, reason} or null.
export function policy(agent, tool, input = {}, rel = (p) => p) {
  const deny = (reason) => ({ block: true, reason: `SUPER-NEMO gate: ${reason}` });
  for (const p of readTargets(tool, input)) {
    if (SENSITIVE_FILE.test(p)) return deny(`${p} may hold secrets; reading it is not allowed. Use its .example file or ask the user.`);
  }
  if (tool === "bash" && typeof input.command === "string") {
    const cmd = input.command;
    if (mentionsSecret(cmd)) return deny("this command touches a secrets file (.env, keys, credentials); not allowed.");
    if (READ_ONLY_BASH.has(agent) && writesFiles(cmd)) return deny(`${agent} is read-only: this command would change files or git state. Report what you need instead.`);
    if (agent && subagentPublishes(cmd)) return deny(`only the primary orchestrator may publish (push / PR); ${agent} may not.`);
  }
  const targets = writeTargets(tool, input);
  for (const p of targets.map(rel)) {
    if (SENSITIVE_FILE.test(p)) return deny(`${p} may hold secrets; writing it is not allowed.`);
    if (agent === "nemo-tester" && !(TEST_PATH.test(p) || FIXTURE_PATH.test(p))) {
      return deny(`nemo-tester may only write test or fixture paths; ${p} is not one. Report the needed production change to the orchestrator.`);
    }
    if (PROD_AUTHORS.has(agent) && TEST_PATH.test(p)) {
      return deny(`${agent} owns production code; tests belong to nemo-tester (${p}). Hand the behavior to test to the orchestrator.`);
    }
  }
  return null;
}

// Non-blocking note for edits that add risky constructs.
export function securityNote(tool, input = {}, rel = (p) => p) {
  const text = tool === "write" ? input.content : tool === "edit" ? input.input : tool === "ast_edit" ? JSON.stringify(input) : null;
  if (typeof text !== "string") return null;
  const targets = writeTargets(tool, input).filter((p) => !TEST_PATH.test(rel(p)));
  const hit = targets.length && RISKY_EDIT.exec(text);
  return hit ? `SUPER-NEMO security note: this edit to ${targets.join(", ")} adds \`${hit[0]}\`. Make sure untrusted input cannot reach it (validate, escape, parameterize) and name it for the security review.` : null;
}

// ---------------------------------------------------------------- git state

function gitEnv(extra = {}) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", ...extra };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_PREFIX", "GIT_COMMON_DIR"]) delete env[k];
  if (!extra.GIT_INDEX_FILE) delete env.GIT_INDEX_FILE;
  return env;
}
// stderr is captured (never printed into OMP's terminal) and kept on the error for callers.
const git = (cwd, args, extra) => execFileSync("git", args, { cwd, env: gitEnv(extra), encoding: "utf8", maxBuffer: 64 << 20, timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] }).trim();

// The repository holding dir (or its nearest existing ancestor); null only when it is not in one.
// Other git failures (git missing, timeout, safe.directory) throw, so callers can report them.
export function repoRoot(dir) {
  let d = path.resolve(dir);
  while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
  try {
    return git(d, ["rev-parse", "--show-toplevel"]);
  } catch (error) {
    // Not in a repository, or inside a .git directory (SUPER-NEMO's own $SN evidence lives there).
    if (/not a git repository|must be run in a work tree/i.test(String(error.stderr ?? ""))) return null;
    throw error;
  }
}

export function insideGitDir(dir) {
  try { return git(dir, ["rev-parse", "--git-dir"]) !== ""; } catch { return false; }
}

// Content fingerprint of the working tree (tracked + untracked, minus ignored) as a git tree id.
// Identical before and after a commit of the same content, so review receipts survive committing.
export function treeOf(root) {
  const gitDir = git(root, ["rev-parse", "--absolute-git-dir"]);
  const tmp = path.join(os.tmpdir(), `sn-gate-${process.pid}-${Math.random().toString(36).slice(2)}`);
  try {
    if (fs.existsSync(path.join(gitDir, "index"))) fs.copyFileSync(path.join(gitDir, "index"), tmp);
    git(root, ["add", "-A"], { GIT_INDEX_FILE: tmp });
    return git(root, ["write-tree"], { GIT_INDEX_FILE: tmp });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// Risk of the change between two trees, as the Claude Code verify-gate scores it.
export function assess(root, base, tree) {
  const files = git(root, ["diff", "--name-only", base, tree]).split("\n").filter(Boolean);
  const numstat = git(root, ["diff", "--numstat", base, tree]).split("\n").filter(Boolean);
  const lines = numstat.reduce((s, l) => s + (Number(l.split("\t")[0]) || 0) + (Number(l.split("\t")[1]) || 0), 0);
  // Only code and config lines carry risk: a test importing child_process or a doc saying "try" does not.
  const scored = files.filter((p) => ["code", "config"].includes(category(p)));
  const patch = (scored.length ? git(root, ["diff", "-U0", base, tree, "--", ...scored]) : "").slice(0, 400_000).split("\n");
  const added = patch.filter((l) => l.startsWith("+") && !l.startsWith("+++")).join("\n");
  const removed = patch.filter((l) => l.startsWith("-") && !l.startsWith("---")).join("\n");
  return score(files, lines, added, removed);
}

export function score(files, lines, added, removed) {
  const cats = Object.fromEntries(files.map((p) => [p, category(p)]));
  const code = files.filter((p) => cats[p] === "code");
  const config = files.filter((p) => cats[p] === "config");
  const changed = added + "\n" + removed;
  const errorHandling = ERROR_HANDLING.test(changed);
  const critical = [];
  if ([...code, ...config].some((p) => SENSITIVE_PATH.test(p)) || files.some((p) => SENSITIVE_FILE.test(p))) critical.push("security-sensitive paths");
  if (RISKY_CODE.test(added)) critical.push("risky constructs in changed code");
  if (critical.length) return { floor: "CRITICAL", reasons: critical, errorHandling, files };
  const normal = [];
  if (config.length) normal.push("build/config/manifest change");
  if (REMOVED_GUARD.test(removed)) normal.push("a guard, check or error path was removed or changed");
  if (lines > 400 || code.length > 15) normal.push(`large change (${lines} lines, ${code.length} code files)`);
  else if (code.length && (lines > 25 || code.length > 2)) normal.push(`${code.length} code files, ${lines} changed lines`);
  if (normal.length) return { floor: "NORMAL", reasons: normal, errorHandling, files };
  return { floor: "LIGHT", reasons: [code.length ? "small change" : "tests/docs only"], errorHandling, files };
}

// ---------------------------------------------------------------- the gate

const RANK = { LIGHT: 0, NORMAL: 1, CRITICAL: 2 };
const higher = (a, b) => (RANK[a] >= RANK[b] ? a : b);

export function modeFromSpawns(spawned) {
  if (["nemo-implementer-critical", "nemo-security", "nemo-performance"].some((a) => spawned.has(a))) return "CRITICAL";
  if (["nemo-implementer", "nemo-tester", "nemo-architect", "nemo-qa", "nemo-final-review"].some((a) => spawned.has(a))) return "NORMAL";
  return "LIGHT";
}

export function required(mode, errorHandling) {
  if (mode === "LIGHT") return { latest: ["nemo-quality"], current: [] };
  const latest = ["nemo-architect", "nemo-quality", "nemo-qa"];
  if (mode === "CRITICAL") latest.push("nemo-security", "nemo-performance");
  if (errorHandling) latest.push("nemo-failures");
  return { latest, current: ["nemo-final-review"] };
}

// What still blocks this code state. run: {spawned:Set, receipts:[{agent, verdict, tree}]}; risk from assess().
// LIGHT needs nemo-quality to have run. NORMAL/CRITICAL need every specialist's latest verdict to be PASS
// (SKILL.md re-runs only failed reviewers) and nemo-final-review PASS on exactly this code state.
export function missing(run, risk, tree) {
  const chosen = modeFromSpawns(run.spawned);
  const mode = higher(chosen, risk.floor);
  const out = [];
  if (RANK[risk.floor] > RANK[chosen]) out.push(`risk floor: the diff needs ${risk.floor} (${risk.reasons.join("; ")}), but the run used ${chosen}`);
  const last = (a) => run.receipts.filter((r) => r.agent === a).at(-1);
  const req = required(mode, risk.errorHandling);
  for (const a of req.latest) {
    const r = last(a);
    if (!r) out.push(`${a}: no verdict yet`);
    else if (mode !== "LIGHT" && r.verdict !== "PASS") out.push(`${a}: last verdict ${r.verdict}`);
  }
  for (const a of req.current) {
    const r = last(a);
    if (!r) out.push(`${a}: no verdict yet`);
    else if (r.verdict !== "PASS") out.push(`${a}: last verdict ${r.verdict}`);
    else if (r.tree !== tree) out.push(`${a}: PASS was for an earlier code state; review the current one`);
  }
  return { mode, items: out };
}

// Finds a reviewer verdict in a structured payload (yield input or task result data).
export function findVerdict(v, depth = 0) {
  if (!v || typeof v !== "object" || depth > 4) return null;
  if (v.verdict === "PASS" || v.verdict === "FIX_REQUIRED") return v.verdict;
  for (const x of Object.values(v)) {
    const found = findVerdict(x, depth + 1);
    if (found) return found;
  }
  return null;
}

// ---------------------------------------------------------------- OMP wiring

const agentName = (ctx) => (ctx?.agent?.kind === "sub" ? String(ctx.agent.name ?? "").toLowerCase() : "");
const errText = (e) => String(e?.stderr || e?.message || e).trim().split("\n")[0];

// repo root -> {root, base, spawned, receipts, lastTree}. Module level on purpose: OMP calls the extension
// factory again for every subagent session, and only module state is shared between them.
// ponytail: in memory only; after an OMP restart the gate starts a fresh run (it blocks at most once per code state).
const RUNS = new Map();

// Where unpushed work starts when no run saw it being made: the upstream, else origin's default branch,
// else the empty tree (everything counts as unreviewed). Only a missing ref is a miss; other git errors throw.
const MISSING_REF = /no upstream|not a valid object name|unknown revision|ambiguous argument|no such branch|bad revision/i;
export function publishBase(root) {
  for (const ref of ["@{upstream}", "origin/HEAD"]) {
    try {
      return git(root, ["rev-parse", `${git(root, ["merge-base", "HEAD", ref])}^{tree}`]);
    } catch (error) {
      if (!MISSING_REF.test(String(error.stderr ?? "")) && error.status !== 1) throw error;   // merge-base exits 1 when unrelated
    }
  }
  return execFileSync("git", ["hash-object", "-t", "tree", "--stdin"], { cwd: root, env: gitEnv(), input: "", encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

export function register(pi, { runs = RUNS, impeccable = findImpeccable() } = {}) {
  const fresh = (root, base) => ({ root, base, spawned: new Set(), receipts: [] });
  const refused = new Set();   // code states the stop gate already reported
  const runFor = (dir, start) => {
    for (const [r] of runs) if (!fs.existsSync(r)) runs.delete(r);   // a removed worktree is no longer gated
    const root = dir && repoRoot(dir);
    if (!root) return null;
    if (!runs.has(root) && start) runs.set(root, fresh(root, typeof start === "function" ? start(root) : treeOf(root)));
    return runs.get(root) ?? null;
  };
  const relTo = (cwd) => (p) => {
    const abs = path.resolve(cwd ?? ".", p);
    const root = repoRoot(path.dirname(abs));
    return path.relative(root ?? cwd ?? path.dirname(abs), abs);
  };
  // Open items for a run; a passing state starts a new run, so old verdicts never satisfy a later task.
  const evaluate = (run) => {
    const tree = treeOf(run.root);
    run.lastTree = tree;
    let state = { tree, mode: "LIGHT", items: [] };
    if (tree !== run.base) {
      const risk = assess(run.root, run.base, tree);
      if (!risk.files.every((p) => category(p) === "docs")) state = { tree, ...missing(run, risk, tree) };
    }
    if (!state.items.length && tree !== run.base) runs.set(run.root, { ...fresh(run.root, tree), lastTree: tree });
    return state;
  };
  // Every repository this session changed: a second repo or worktree is gated too.
  const openItems = () => [...runs.values()].filter((run) => fs.existsSync(run.root)).flatMap((run) => {
    const state = evaluate(run);
    return state.items.length ? [`${path.basename(run.root)} (${state.mode}):\n- ${state.items.join("\n- ")}`] : [];
  });
  const pending = new Map();   // subagent id -> verdict awaiting OMP's acceptance of its yield
  let stopErrorReported = false;

  pi.on("before_subagent_spawn", (event, ctx) => {
    const name = String(event?.agent?.name ?? event?.agent ?? "").toLowerCase();
    try {
      if (name.startsWith("nemo-")) runFor(ctx.cwd, true)?.spawned.add(name);
    } catch (e) {
      console.error(`SUPER-NEMO gate: could not record ${name}: ${errText(e)}`);
    }
  });

  pi.on("tool_call", (event, ctx) => {
    const agent = agentName(ctx);
    const tool = event.toolName;
    const input = event.input ?? {};
    if (tool === "yield") {
      const verdict = findVerdict(input);
      if (REVIEWERS.has(agent) && verdict) pending.set(ctx.agent?.id ?? agent, { agent, verdict, cwd: ctx.cwd });
      return;
    }
    const notes = [];
    const relOf = new Map();
    try {
      const toRel = relTo(input.cwd ?? ctx.cwd);
      for (const t of writeTargets(tool, input)) relOf.set(t, toRel(t));   // one git lookup per target, inside the catch
    } catch (e) {
      relOf.clear();
      notes.push(`SUPER-NEMO gate could not inspect the repository (${errText(e)}); ownership checks used raw paths.`);
    }
    const rel = (p) => relOf.get(p) ?? p;
    const verdict = policy(agent, tool, input, rel);
    if (verdict) return verdict;
    try {
      const cmd = tool === "bash" ? String(input.command ?? "") : "";
      const targets = writeTargets(tool, input);
      // Baseline before the first change, in the repository that will change.
      // The tester works in a disposable copy; its accepted tests reach the real repository through the orchestrator.
      // The tester's disposable copy is not gated; a tester writing the session's own repository is.
      let home;
      const gated = (dir) => agent !== "nemo-tester" || repoRoot(dir) === (home ??= repoRoot(ctx.cwd ?? "."));
      for (const t of targets) {
        const dir = path.dirname(path.resolve(ctx.cwd ?? ".", t));
        if (gated(dir)) runFor(dir, true);
      }
      const bashDir = input.cwd ?? ctx.cwd;
      if (cmd && writesFiles(cmd) && !publishes(cmd) && gated(bashDir)) runFor(bashDir, true);
      if (!agent && publishes(cmd)) {
        const dir = publishDir(cmd, input.cwd ?? ctx.cwd);
        const unclear = "SUPER-NEMO gate: cannot tell which repository this publishes; run it as `git -C <repo> push` (or from the repository directory).";
        if (!dir) return { block: true, reason: unclear };
        // Git sees a repository here but no work tree (a .git dir, bare or symlinked git dir): refuse rather than skip.
        if (!runFor(dir, publishBase) && insideGitDir(dir)) return { block: true, reason: unclear };
        const open = openItems();   // every touched repository: a compound command may push more than one
        if (open.length) return { block: true, reason: `SUPER-NEMO gate: publication waits for open review gates:\n${open.join("\n")}` };
      }
    } catch (e) {
      if (!agent && tool === "bash" && publishes(String(input.command ?? ""))) {
        return { block: true, reason: `SUPER-NEMO gate could not evaluate the review gates (${errText(e)}); not publishing. Fix the cause or ask the user.` };
      }
      notes.push(`SUPER-NEMO gate could not record a baseline (${errText(e)}); the stop gate may miss this change.`);
    }
    const note = securityNote(tool, input, rel);
    if (note) notes.push(note);
    return notes.length ? { additionalContext: notes.join("\n") } : undefined;
  });

  const receipt = (cwd, agent, verdict) => {
    if (!REVIEWERS.has(agent) || !verdict) return null;
    try {
      // A review covers the session's work in every repository it touched (multi-repo and author worktrees).
      runFor(cwd, true);
      for (const run of runs.values()) {
        if (!fs.existsSync(run.root)) continue;
        const tree = treeOf(run.root);
        if (!run.receipts.some((r) => r.agent === agent && r.verdict === verdict && r.tree === tree)) run.receipts.push({ agent, verdict, tree });
      }
      return null;
    } catch (e) {
      return `SUPER-NEMO gate could not record ${agent}'s ${verdict} (${errText(e)}); the stop gate will list it as missing.`;
    }
  };

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName === "yield") {   // the verdict counts only once OMP accepted the payload
      const key = ctx.agent?.id ?? agentName(ctx);
      const p = pending.get(key);
      pending.delete(key);
      const problem = p && !event.isError && receipt(p.cwd, p.agent, p.verdict);
      return problem ? { additionalContext: problem } : undefined;
    }
    if (event.toolName === "task") {
      const problems = (event.details?.results ?? [])
        .map((r) => receipt(ctx.cwd, String(r.agent ?? "").toLowerCase(), findVerdict(r.structuredOutput?.data) ?? findVerdict(r.extractedToolData)))
        .filter(Boolean);
      return problems.length ? { additionalContext: problems.join("\n") } : undefined;
    }
    if (!impeccable || event.isError) return;
    const ui = writeTargets(event.toolName, event.input).filter((p) => UI_FILE.test(p) && !TEST_PATH.test(path.basename(p)));
    if (!ui.length) return;
    const found = await lintUi(impeccable, ui, ctx.cwd);
    return found ? { additionalContext: `Impeccable design check on ${ui.join(", ")}:\n${found}` } : undefined;
  });

  pi.on("session_stop", (_event, ctx) => {
    if (ctx?.agent?.kind === "sub") return;
    let open;
    try {
      open = openItems();
      stopErrorReported = false;   // a later failure is news again
    } catch (e) {
      if (stopErrorReported) return;   // once per session; repeating it would only loop the agent
      stopErrorReported = true;
      return { continue: true, additionalContext: `SUPER-NEMO gate could not evaluate the review gates (${errText(e)}); report the gates as unverified.` };
    }
    const key = [...runs.values()].map((r) => r.lastTree).join(",");
    if (!open.length || refused.has(key)) return;   // told once about this code state: let it report
    refused.add(key);
    return {
      decision: "block",
      reason: `SUPER-NEMO gate has open items for the current changes:\n${open.join("\n")}\n`
        + "Run the missing gates now. If one cannot run (quota, auth, timeout), report it as GATE NOT RUN; "
        + "the gate will not stop you again for this code state.",
    };
  });
}

// ---------------------------------------------------------------- Impeccable (optional)

function findImpeccable() {
  for (const p of [process.env.SN_IMPECCABLE, path.join(os.homedir(), ".claude", "skills", "impeccable", "scripts", "impeccable")]) {
    if (p && fs.existsSync(p)) return p;
  }
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const p = dir && path.join(dir, "impeccable");
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

function lintUi(bin, files, cwd) {
  return new Promise((resolve) => {
    execFile(bin, ["detect", ...files], { cwd, encoding: "utf8", timeout: 20_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      const text = String(stdout ?? "").trim();
      if (err && !text) return resolve(`impeccable detect failed (${err.code ?? err.signal ?? err.message}): ${String(stderr ?? "").trim().split("\n").slice(0, 5).join(" ")}`);
      // Exit 0 with output that reports no findings is clean; anything else worth a look is passed on.
      if (!text || (!err && /\b0 (findings|issues)\b|no (findings|issues)/i.test(text))) return resolve(null);
      resolve(text.split("\n").slice(0, 40).join("\n"));
    });
  });
}
