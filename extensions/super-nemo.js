import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ORIGIN = "https://github.com/Glumac7/super-nemo.git";
const API = "https://api.github.com/repos/Glumac7/super-nemo/commits/main";
const COMPARE = "https://api.github.com/repos/Glumac7/super-nemo/compare/";
const DAY = 24 * 60 * 60 * 1000;
const MAX_JSON = 64 * 1024;
const MAX_COMPARE = 256 * 1024;
const SHA = /^[0-9a-f]{40}$/;
const NOTICE = "SUPER-NEMO update available. Run ~/.super-nemo/repo/sn update --dry-run to review it; run ~/.super-nemo/repo/sn update manually to install.";
const SOURCE = fs.realpathSync(fileURLToPath(import.meta.url));
const GIT_LOCATION = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_PREFIX"];

function stat(p) {
  try {
    return fs.lstatSync(p);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
}

function directory(p, privateState = false) {
  const s = stat(p);
  return s?.isDirectory() && !(s.mode & (privateState ? 0o077 : 0o022));
}

function regular(p, maxBytes) {
  const s = stat(p);
  if (!s?.isFile() || s.size > maxBytes) return null;
  return fs.readFileSync(p, "utf8");
}
function safePath(root, target) {
  if (!target.startsWith(root + path.sep)) return false;
  let current = root;
  for (const part of path.relative(root, target).split(path.sep)) {
    current = path.join(current, part);
    if (!directory(current)) return false;
  }
  return true;
}


function git(repo, gitPath, args) {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_COUNT: "0", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
  for (const key of GIT_LOCATION) delete env[key];
  for (const key of Object.keys(env)) if (key.startsWith("GIT_TRACE") || key.startsWith("GIT_CONFIG_KEY_") || key.startsWith("GIT_CONFIG_VALUE_") || key.startsWith("GIT_CONFIG_PARAMETERS")) delete env[key];
  return new Promise((resolve) => {
    execFile(gitPath, args, { cwd: repo, env, encoding: "utf8", timeout: 2000, maxBuffer: 4096 }, (error, output) => {
      resolve(error ? null : output.trim());
    });
  });
}

function installation(home) {
  // Only a bootstrap-managed checkout at the default location is eligible.
  const root = fs.realpathSync(home);
  const snHome = path.join(root, ".super-nemo");
  const state = path.join(snHome, "state");
  const repo = path.join(snHome, "repo");
  const manifestPath = path.join(state, "manifest.json");
  if (!safePath(root, snHome) || !directory(state, true) || !safePath(snHome, repo) || !directory(path.join(repo, "extensions"))) return null;
  if (SOURCE !== path.join(repo, "extensions", "super-nemo.js")) return null;
  const raw = regular(manifestPath, 256 * 1024);
  if (raw === null) return null;
  const m = JSON.parse(raw);
  if (m?.tool !== "super-nemo" || m.version !== 1 || m.status !== "installed" || m.repo !== repo || m.snHome !== snHome
    || m.clone?.path !== repo || m.clone?.createdByBootstrap !== true || m.clone?.origin !== ORIGIN
    || typeof m.agentDir !== "string" || !path.isAbsolute(m.agentDir) || path.resolve(m.agentDir) !== m.agentDir
    || !m.agentDir.startsWith(root + path.sep) || !Array.isArray(m.symlinks)
    || typeof m.gitPath !== "string" || !path.isAbsolute(m.gitPath) || fs.realpathSync(m.gitPath) !== m.gitPath
    || !fs.statSync(m.gitPath).isFile()) return null;
  const link = path.join(m.agentDir, "extensions", "super-nemo.js");
  if (!m.symlinks.includes(link) || !safePath(root, m.agentDir) || !directory(path.join(m.agentDir, "extensions"))
    || !stat(link)?.isSymbolicLink() || fs.readlinkSync(link) !== SOURCE) return null;
  return { repo, state, gitPath: m.gitPath };
}

async function installed(home) {
  const files = installation(home);
  if (!files) return null;
  const { repo, state, gitPath } = files;
  const [branch, origin, head] = await Promise.all([
    git(repo, gitPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    git(repo, gitPath, ["config", "--local", "--get", "remote.origin.url"]),
    git(repo, gitPath, ["rev-parse", "--verify", "HEAD"]),
  ]);
  return branch === "main" && origin === ORIGIN && SHA.test(head ?? "") && installation(home)?.repo === repo ? { head, state } : null;
}

function writeMarker(state, now) {
  const marker = path.join(state, "update-check.json");
  const current = stat(marker);
  if (current) {
    if (!current.isFile() || (current.mode & 0o777) !== 0o600 || current.size > 256) return false;
    let saved;
    try { saved = JSON.parse(fs.readFileSync(marker, "utf8")); } catch { return false; }
    if (!saved || Object.keys(saved).length !== 2 || saved.tool !== "super-nemo"
      || !Number.isSafeInteger(saved.checkedAt) || saved.checkedAt < 0 || saved.checkedAt > now) return false;
    if (now - saved.checkedAt < DAY) return false;
  }
  const tmp = path.join(state, `.update-check.json.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify({ tool: "super-nemo", checkedAt: now })}\n`, { mode: 0o600, flag: "wx" });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, marker);
  } finally {
    if (stat(tmp)) fs.unlinkSync(tmp);
  }
  return true;
}

function releaseClaim(lock, identity) {
  const current = stat(lock);
  if (!current || current.dev !== identity.dev || current.ino !== identity.ino) return false;
  const tomb = `${lock}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.renameSync(lock, tomb);
  const moved = stat(tomb);
  if (moved?.dev === identity.dev && moved.ino === identity.ino) {
    fs.unlinkSync(tomb);
    return true;
  }
  // A concurrent writer replaced our pathname; never delete that writer's claim.
  try { fs.linkSync(tomb, lock); fs.unlinkSync(tomb); } catch {}
  return false;
}

function markChecked(state, now) {
  if (!Number.isSafeInteger(now) || now < 0 || !directory(state, true)) return false;
  const lock = path.join(state, ".update-check.lock");
  const prior = stat(lock);
  if (prior) {
    if (!prior.isFile() || (prior.mode & 0o777) !== 0o600 || prior.size > 256) return false;
    let owner;
    try { owner = JSON.parse(fs.readFileSync(lock, "utf8")); } catch { return false; }
    if (!owner || Object.keys(owner).length !== 3 || owner.tool !== "super-nemo"
      || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || !Number.isSafeInteger(owner.claimedAt)
      || owner.claimedAt < 0 || now - owner.claimedAt < 60_000) return false;
    let alive = true;
    try { process.kill(owner.pid, 0); } catch (error) { alive = error.code !== "ESRCH"; }
    if (alive && now - owner.claimedAt < DAY) return false;
    if (!releaseClaim(lock, prior)) return false;
  }
  // Publish a complete lock with an exclusive hard link: a crash while writing
  // the temporary file cannot leave a malformed lock blocking future checks.
  const tmp = `${lock}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  let mine;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify({ tool: "super-nemo", pid: process.pid, claimedAt: now })}\n`, { flag: "wx", mode: 0o600 });
    mine = stat(tmp);
    fs.linkSync(tmp, lock);
    return writeMarker(state, now);
  } finally {
    if (mine) {
      releaseClaim(lock, mine);
      const current = stat(tmp);
      if (current?.dev === mine.dev && current.ino === mine.ino) fs.unlinkSync(tmp);
    }
  }
}

async function apiJson(fetchImpl, url, signal, limit) {
  const response = await fetchImpl(url, {
    redirect: "error", credentials: "omit", cache: "no-store", signal,
    headers: { Accept: "application/vnd.github+json", "User-Agent": "super-nemo-update-notice" },
  });
  if (response.status !== 200 || !/^application\/(?:json|[\w.-]+\+json)(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) return null;
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) return null;
  if (!response.body) return null;
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) return null;
      parts.push(value);
    }
  } finally {
    if (size > limit) void reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

async function newer(fetchImpl, local) {
  const signal = AbortSignal.timeout(5000);
  const upstream = await apiJson(fetchImpl, API, signal, MAX_JSON);
  const sha = upstream?.sha;
  if (typeof sha !== "string" || !SHA.test(sha) || sha === local) return false;
  // GitHub compares base..head: 'ahead' means main descends from this local commit.
  const comparison = await apiJson(fetchImpl, `${COMPARE}${local}...main`, signal, MAX_COMPARE);
  const commits = comparison?.commits;
  const last = Array.isArray(commits) ? commits.at(-1)?.sha : null;
  // A complete compare page must end at the previously fetched head. GitHub
  // truncates long comparisons, where the last returned commit is not main.
  const complete = last === sha;
  const truncated = Number.isSafeInteger(comparison?.total_commits)
    && comparison.total_commits === comparison.ahead_by && comparison.ahead_by > commits?.length;
  return comparison?.status === "ahead" && Number.isSafeInteger(comparison.ahead_by) && comparison.ahead_by > 0
    && comparison.behind_by === 0 && comparison.base_commit?.sha === local && comparison.merge_base_commit?.sha === local
    && Array.isArray(commits) && commits.length > 0 && SHA.test(last) && (complete || truncated);
}

export function registerUpdateNotice(pi, { home = os.homedir(), fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    setImmediate(() => {
      void (async () => {
        const checkout = await installed(home);
        if (!checkout || !markChecked(checkout.state, now())) return;
        if (!await newer(fetchImpl, checkout.head) || !ctx.hasUI) return;
        // The user may have uninstalled or changed branches while the request was in flight.
        const stillInstalled = await installed(home);
        if (stillInstalled?.head !== checkout.head) return;
        ctx.ui.notify(NOTICE, "info");
      })().catch(() => {}); // Startup and offline operation must never fail because of a notification.
    });
  });
}

export default function superNemo(pi) {
  registerUpdateNotice(pi);
}
