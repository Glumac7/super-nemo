import fs from "node:fs";
import path from "node:path";
import { KINDS, MANAGED_KEYS, ourPatterns } from "./context.mjs";
import { AGENTS_BODY, BEGIN, END, WATCHDOG_BODY, equal } from "./merge.mjs";
import { SnError, atomicWrite, lstat, readLink, symlinkedComponent } from "./util.mjs";

const BACKUP = /^backups\/[0-9A-Za-z-]+\/(config\.ya?ml|AGENTS\.md|WATCHDOG\.md|WATCHDOG\.yml)$/;
const BACKUP_DIR = /^backups\/[0-9A-Za-z-]+$/;
const MAP_PREFIXES = [...MANAGED_KEYS, "bash.patterns"];

const validPrior = (p) => p && typeof p === "object" && (p.absent === true || Object.hasOwn(p, "value"));
const validList = (p) => p && typeof p === "object" && (p.absent === true || Array.isArray(p.value));
const validBlockPrior = (p) => p === null || p === undefined || (typeof p === "string" && p.startsWith(BEGIN) && p.trimEnd().endsWith(END));

function sanitize(ctx, m) {
  const ignored = [];
  const keys = {};
  for (const [key, e] of Object.entries(m.config.keys)) {
    if (MANAGED_KEYS.includes(key) && e && validPrior(e.prior) && Object.hasOwn(e, "ours")) keys[key] = e;
    else ignored.push(`config key ${key}: not a setting SUPER-NEMO manages`);
  }
  m.config.keys = keys;
  for (const [kind, f] of Object.entries(m.files)) {
    if (!f || !fileAllowed(ctx, kind, f.path) || !ctx.ourPath(f.path)) {
      ignored.push(`file ${f?.path ?? kind}: not a file SUPER-NEMO manages`);
      delete m.files[kind];
    }
  }
  m.config.createdMaps = (m.config.createdMaps ?? []).filter((p) => typeof p === "string" && MAP_PREFIXES.some((k) => k.startsWith(`${p}.`)));
  const shipped = ourPatterns(ctx);
  const patterns = m.config.patterns ?? {};
  const inserted = Array.isArray(patterns.inserted) ? patterns.inserted : [];
  m.config.patterns = {
    inserted: inserted.filter((e) => shipped.some((x) => equal(x, e))),
    createdKey: patterns.createdKey === true,
    before: validList(patterns.before) ? patterns.before : null,
    after: Array.isArray(patterns.after) ? patterns.after : null,
  };
  for (const e of inserted) if (!m.config.patterns.inserted.includes(e)) ignored.push(`bash.patterns entry ${JSON.stringify(e)}: not shipped by SUPER-NEMO`);
  const c = m.clone;
  if (c && c.createdByBootstrap === true && c.path === ctx.cloneDir && typeof c.origin === "string" && c.origin) {
    m.clone = { path: c.path, createdByBootstrap: true, origin: c.origin };
  } else {
    if (c) ignored.push(`clone ${JSON.stringify(c.path)}: not ${ctx.cloneDir} created by the bootstrap installer`);
    m.clone = null;
  }
  for (const kind of ["agents", "watchdogMd"]) {
    if (m.blocks?.[kind] && !validBlockPrior(m.blocks[kind].prior)) {
      ignored.push(`${kind} block: recorded previous block is malformed`);
      m.blocks[kind] = { sep: null, prior: null };
    }
  }
  m.ignored = ignored;
  return m;
}

export function loadManifest(ctx) {
  const st = lstat(ctx.manifestPath);
  if (!st) return null;
  if (!st.isFile() || !ctx.ourPath(ctx.manifestPath)) throw new SnError(`${ctx.manifestPath} is not a regular file inside ${ctx.snHome}; not touching it`);
  let m;
  try {
    m = JSON.parse(fs.readFileSync(ctx.manifestPath, "utf8"));
  } catch {
    throw new SnError(`${ctx.manifestPath} is not valid JSON; not touching anything`);
  }
  const ok = m && m.tool === "super-nemo" && m.version === 1 && ["pending", "installed"].includes(m.status)
    && typeof m.repo === "string" && typeof m.agentDir === "string" && typeof m.snHome === "string"
    && Array.isArray(m.symlinks) && Array.isArray(m.createdDirs) && m.files && typeof m.files === "object"
    && m.config && m.config.keys && typeof m.config.keys === "object";
  if (!ok) throw new SnError(`${ctx.manifestPath} is not a SUPER-NEMO manifest; not touching anything`);
  return sanitize(ctx, m);
}

export function saveManifest(ctx, manifest) {
  const { ignored, ...rest } = manifest;
  atomicWrite(ctx.manifestPath, `${JSON.stringify(rest, null, 2)}\n`, 0o600);
}

export function checkRoots(ctx, manifest) {
  if (manifest.agentDir !== ctx.agentDir || manifest.snHome !== ctx.snHome) {
    throw new SnError(`SUPER-NEMO is installed for agent dir ${manifest.agentDir} and home ${manifest.snHome}, but they now resolve to ${ctx.agentDir} and ${ctx.snHome}; select the same OMP profile and restore the original directories`);
  }
}

export function fileAllowed(ctx, kind, p) {
  if (!KINDS.includes(kind) || typeof p !== "string") return false;
  return kind === "config" ? ctx.allowedConfigPaths.includes(p) : ctx.files[kind] === p;
}

export const dirAllowed = (ctx, p) => typeof p === "string" && ctx.allowedDirs.includes(p)
  && (ctx.ourPath(p) || p === ctx.agentDir || symlinkedComponent(ctx.home, p) === null);

export function backupPath(ctx, rel) {
  if (typeof rel !== "string" || !BACKUP.test(rel)) return null;
  const abs = path.join(ctx.state, rel);
  return ctx.ourPath(abs) && lstat(abs)?.isFile() ? abs : null;
}

export function backupDirPath(ctx, rel) {
  if (typeof rel !== "string" || !BACKUP_DIR.test(rel)) return null;
  const abs = path.join(ctx.state, rel);
  return ctx.ourPath(abs) && lstat(abs)?.isDirectory() ? abs : null;
}

export function symlinkSpec(ctx, p) {
  return ctx.symlinks.find((s) => s.path === p && ctx.ourPath(p)) ?? null;
}

export function isOurSymlink(ctx, p) {
  const spec = symlinkSpec(ctx, p);
  return spec !== null && readLink(p) === spec.target;
}

const LINK_NAME = /^[a-z0-9][a-z0-9-]*(\.md)?$/;

export function staleLinkSpec(ctx, p) {
  if (typeof p !== "string" || symlinkSpec(ctx, p) || !ctx.ourPath(p)) return null;
  const dir = ["skills", "agents"].find((d) => path.dirname(p) === path.join(ctx.agentDir, d));
  const name = path.basename(p);
  return dir && LINK_NAME.test(name) ? { path: p, target: path.join(ctx.repo, dir, name) } : null;
}

export function isStaleLink(ctx, p) {
  const spec = staleLinkSpec(ctx, p);
  return spec !== null && readLink(p) === spec.target;
}

function recordedBackups(ctx, manifest) {
  const rels = new Set();
  const entries = [...Object.entries(manifest.files), ...(manifest.txn?.files ?? []).map((f) => [f?.kind, f])];
  for (const [kind, f] of entries) if (f?.backup && fileAllowed(ctx, kind, f.path)) rels.add(f.backup);
  return rels;
}

export function stateProblems(ctx, manifest) {
  const dirs = new Set([ctx.state, ctx.backupsDir, ...[...recordedBackups(ctx, manifest)].map((rel) => backupPath(ctx, rel)).filter(Boolean).map((p) => path.dirname(p))]);
  const problems = [];
  for (const d of dirs) {
    if (!lstat(d)?.isDirectory()) continue;
    try {
      fs.accessSync(d, fs.constants.W_OK | fs.constants.X_OK);
    } catch {
      problems.push(`${d} is not writable, so the SUPER-NEMO state in it cannot be removed`);
    }
  }
  return problems;
}

export function removeState(ctx, manifest, report) {
  const rels = recordedBackups(ctx, manifest);
  const dirs = new Set();
  for (const rel of rels) {
    const abs = backupPath(ctx, rel);
    if (!abs) {
      if (lstat(path.join(ctx.state, String(rel)))) report(`left ${rel}: not a recorded backup file inside ${ctx.backupsDir}`);
      continue;
    }
    fs.unlinkSync(abs);
    dirs.add(path.dirname(rel));
  }
  if (manifest.txn?.backupDir) dirs.add(manifest.txn.backupDir);
  for (const rel of dirs) {
    const abs = backupDirPath(ctx, rel);
    if (abs) rmdirQuiet(abs, report);
  }
  if (lstat(ctx.backupsDir)?.isDirectory()) rmdirQuiet(ctx.backupsDir, report);
  if (lstat(ctx.manifestPath)?.isFile() && ctx.ourPath(ctx.manifestPath)) fs.unlinkSync(ctx.manifestPath);
  if (lstat(ctx.state)?.isDirectory()) rmdirQuiet(ctx.state, report);
}

function rmdirQuiet(p, report) {
  try {
    fs.rmdirSync(p);
  } catch (err) {
    if (err.code === "ENOTEMPTY" || err.code === "EEXIST") report(`left ${p}: contains files that are not ours`);
    else if (err.code !== "ENOENT") throw err;
  }
}

export function hasOrphanedInstall(ctx) {
  const marked = [[ctx.files.agents, AGENTS_BODY], [ctx.files.watchdogMd, WATCHDOG_BODY]].some(([f, body]) => (
    lstat(f)?.isFile() && fs.readFileSync(f, "utf8").includes(`${BEGIN}\n${body}\n${END}`)
  ));
  return marked || ctx.symlinks.some((s) => s.path.startsWith(ctx.agentDir + path.sep) && isOurSymlink(ctx, s.path));
}
