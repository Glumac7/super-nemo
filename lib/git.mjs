import { execFileSync } from "node:child_process";

const GITHUB = /^https:\/\/github\.com\//;
const LOCATION = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_PREFIX"];
const DISPOSABLE = /^!! (node_modules\/.*|(.*\/)?\.DS_Store)$/;

const credentialArgs = (url) => (GITHUB.test(url) ? ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"] : []);

export const redact = (text) => String(text).replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/gi, "$1***@");

function gitEnv() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
  for (const k of LOCATION) delete env[k];
  return env;
}

export function git(cwd, args, { url } = {}) {
  return execFileSync("git", [...(url ? credentialArgs(url) : []), ...args], {
    cwd,
    encoding: "utf8",
    env: gitEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  }).replace(/\n$/, "");
}

export function tryGit(cwd, args) {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

export const originUrl = (dir) => tryGit(dir, ["config", "--get", "remote.origin.url"]);

export const cleanStatus = (dir) => tryGit(dir, ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"]);

function unpushedBranch(dir, ref, upstream) {
  const name = ref.replace(/^refs\/heads\//, "");
  if (!upstream.startsWith("refs/remotes/") || tryGit(dir, ["rev-parse", "--verify", "--quiet", `${upstream}^{commit}`]) === null) {
    return `branch ${name} does not track a remote branch`;
  }
  const ahead = tryGit(dir, ["rev-list", "--count", `${upstream}..${ref}`]);
  if (ahead === null) return "git cannot read it";
  return ahead === "0" ? null : `branch ${name} has commits that are not on the remote (${upstream.replace(/^refs\/remotes\//, "")})`;
}

export function unpushedWork(dir) {
  const status = tryGit(dir, ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none", "--ignored"]);
  const stash = tryGit(dir, ["stash", "list"]);
  const head = tryGit(dir, ["symbolic-ref", "--quiet", "HEAD"]);
  const branches = tryGit(dir, ["for-each-ref", "--format=%(refname)%00%(upstream)", "refs/heads"]);
  if (status === null || stash === null || branches === null) return "git cannot read it";
  if (status.split("\n").some((l) => l && !DISPOSABLE.test(l))) return "it has local changes or ignored files (git status is not clean)";
  if (stash) return "it has stashed changes";
  if (!head) return "HEAD is detached";
  for (const line of branches.split("\n").filter(Boolean)) {
    const why = unpushedBranch(dir, ...line.split("\0"));
    if (why) return why;
  }
  return null;
}
