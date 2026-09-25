import { spawnSync } from "node:child_process";
import path from "node:path";
import { cleanStatus, git, githubAccess, redact, tryGit } from "./git.mjs";
import { openManifest } from "./transaction.mjs";
import { SnError } from "./util.mjs";
import { verify } from "./verify.mjs";

const short = (sha) => sha.slice(0, 12);
const refuse = (why) => new SnError(`Update refused, nothing was changed: ${why}`);

function tracking(repo, clone) {
  if (tryGit(repo, ["rev-parse", "--show-toplevel"]) !== repo) throw refuse(`${repo} is not a git checkout`);
  const status = cleanStatus(repo);
  if (status === null) throw refuse(`git status failed in ${repo}`);
  if (status) throw refuse(`${repo} has local changes; commit, stash or discard them first:\n${status}`);
  const branch = tryGit(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!branch) throw refuse(`${repo} is not on a branch`);
  const remote = tryGit(repo, ["config", "--get", `branch.${branch}.remote`]);
  const upstream = tryGit(repo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  const configured = remote && remote !== "." ? tryGit(repo, ["config", "--get-all", `remote.${remote}.url`]) : null;
  const url = configured?.split("\n")[0];
  const fetchUrl = url ? tryGit(repo, ["remote", "get-url", remote]) : null;
  if (!upstream || !url || !fetchUrl) throw refuse(`branch ${branch} does not track a remote branch`);
  if (clone?.path === repo) {
    if (remote !== "origin") throw refuse(`branch ${branch} tracks ${remote}, not origin`);
    if (url !== clone.origin) throw refuse(`origin is ${redact(url)}, but SUPER-NEMO was installed from ${redact(clone.origin)}`);
  }
  return { branch, remote, upstream, fetchUrl };
}

const FETCH_HINT = {
  gh: "\nthe repository may be private or unreachable; check that `gh auth status` shows an account with access to it",
  anonymous: "\nthe repository may be private or unreachable; for a private fork install `gh` and run `gh auth login`",
};

function fetch(repo, remote, url) {
  const access = githubAccess(url);
  try {
    git(repo, ["fetch", "--quiet", "--no-write-fetch-head", remote], { access });
  } catch (err) {
    const detail = redact(err.stderr ?? "").trim();
    throw refuse(`git fetch ${remote} (${redact(url)}) failed${detail ? `:\n${detail}` : ""}${FETCH_HINT[access] ?? ""}`);
  }
}

async function verifyCurrent(ctx, branch, upstream, old, log) {
  const lines = [];
  if (await verify(ctx, { smoke: false }, (line) => lines.push(line))) {
    log(`Already up to date: ${branch} is at ${upstream} (${short(old)}).`);
    return 0;
  }
  const problems = lines.filter((l) => l.startsWith("FAIL ")).map((l) => `  - ${l.slice(5)}`);
  log(`update applied but verification fails:\n${problems.join("\n")}\nfix and run \`sn update\` again`);
  return 1;
}

export async function update(ctx, opts, log = console.log) {
  const dryRun = Boolean(opts["dry-run"]);
  const manifest = openManifest(ctx, log, dryRun);
  if (!manifest) throw new SnError("SUPER-NEMO is not installed; nothing to update", 2);
  const repo = manifest.repo;
  if (repo !== ctx.repo) throw new SnError(`SUPER-NEMO is installed from ${repo}; run ${path.join(repo, "sn")} update`, 2);
  const { branch, remote, upstream, fetchUrl } = tracking(repo, manifest.clone);
  fetch(repo, remote, fetchUrl);
  const old = git(repo, ["rev-parse", "HEAD"]);
  const next = git(repo, ["rev-parse", "@{upstream}"]);
  if (old === next) {
    if (opts["pull-only"]) {
      log(`Already up to date: ${branch} is at ${upstream} (${short(old)}).`);
      return 0;
    }
    if (manifest.installedCommit === old) return verifyCurrent(ctx, branch, upstream, old, log);
    log(`${repo} is at ${upstream} (${short(old)}), but the installed settings were not applied from this commit yet.`);
    return reapply(ctx, repo, old, opts, log);
  }
  if (tryGit(repo, ["merge-base", "--is-ancestor", old, next]) === null) {
    throw refuse(`${branch} has commits that are not on ${upstream}, so it cannot be fast-forwarded`);
  }
  const commits = git(repo, ["log", "--oneline", "--no-decorate", `${old}..${next}`]).split("\n").map((l) => `  ${l}`);
  log([`${dryRun ? "Would update" : "Updating"} ${repo}: ${short(old)}..${short(next)} (${upstream})`, ...commits].join("\n"));
  if (dryRun) {
    log("Dry run: nothing was merged or re-applied.");
    return 0;
  }
  const deps = git(repo, ["diff", "--name-only", old, next, "--", "package.json", "package-lock.json"]);
  git(repo, ["merge", "--ff-only", "--quiet", next]);
  if (deps) {
    const res = spawnSync("npm", ["ci", "--omit=dev", "--silent"], { cwd: repo, env: ctx.env, stdio: ["ignore", "inherit", "inherit"] });
    if (res.status !== 0) throw new SnError(`The code is now at ${short(next)}, but installing its dependencies failed; run npm ci --omit=dev in ${repo}, then ${path.join(repo, "sn")} update`);
  }
  if (opts["pull-only"]) return 0;
  return reapply(ctx, repo, next, opts, log);
}

function reapply(ctx, repo, commit, opts, log) {
  log("Re-applying your recorded answers:");
  const flags = [...(opts["overwrite-drift"] ? ["--overwrite-drift"] : []), ...(opts["dry-run"] ? ["--dry-run"] : [])];
  const res = spawnSync(process.execPath, [path.join(repo, "lib", "sn.mjs"), "install", "--reuse", "--no-smoke", ...flags], { env: ctx.env, stdio: "inherit" });
  if (res.status !== 0) {
    log(`The code is at ${short(commit)}, but re-applying the settings did not finish; fix the problem above, then run ${path.join(repo, "sn")} update again (add --overwrite-drift to replace settings you changed)`);
    return res.status ?? 1;
  }
  return 0;
}
