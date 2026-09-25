import fs from "node:fs";
import path from "node:path";
import { watchdogEntry } from "./context.mjs";
import {
  backupDirPath, backupPath, checkRoots, dirAllowed, fileAllowed, hasOrphanedInstall, loadManifest, removeState, saveManifest,
  symlinkSpec,
} from "./manifest.mjs";
import { isEmptyText, revertTxn } from "./merge.mjs";
import { SnError, fileHash, lstat, readLink, replaceIfHash, rmdirIfEmpty, sha256 } from "./util.mjs";

function planFiles(ctx, manifest, report) {
  const steps = [];
  const blockers = [];
  for (const f of manifest.txn.files) {
    if (!f || !fileAllowed(ctx, f.kind, f.path)) {
      report(`left ${f?.path}: not a destination this installer manages`);
      continue;
    }
    const st = lstat(f.path);
    if (st && !st.isFile()) {
      blockers.push(`${f.path} is no longer a regular file`);
      continue;
    }
    const cur = fileHash(f.path);
    if (cur === null) {
      if (f.existed) report(`${f.path} was deleted after the interrupted install; left it deleted`);
      continue;
    }
    if (f.existed && cur === f.backupHash) continue;
    if (cur === f.afterHash) {
      if (!f.existed) {
        steps.push(() => replaceIfHash(f.path, f.afterHash, null));
        continue;
      }
      const src = backupPath(ctx, f.backup);
      const saved = src ? fs.readFileSync(src) : null;
      if (!saved || sha256(saved) !== f.backupHash) blockers.push(`${f.path}: backup ${f.backup} is missing or damaged`);
      else steps.push(() => replaceIfHash(f.path, f.afterHash, saved));
      continue;
    }
    const text = fs.readFileSync(f.path, "utf8");
    let next;
    try {
      next = revertTxn(manifest, f.kind, text, f.path, report, watchdogEntry(ctx));
    } catch (err) {
      if (!(err instanceof SnError)) throw err;
      blockers.push(`${f.path} changed after the interrupted install and SUPER-NEMO's entries cannot be removed from it: ${err.message}`);
      continue;
    }
    if (!f.existed && isEmptyText(next, f.kind === "config" || f.kind === "watchdogYml")) steps.push(() => replaceIfHash(f.path, cur, null));
    else if (next !== text) steps.push(() => replaceIfHash(f.path, cur, next));
  }
  return { steps, blockers };
}

export function rollback(ctx, manifest, report) {
  const txn = manifest.txn;
  if (!txn || !Array.isArray(txn.files) || !Array.isArray(txn.symlinks) || !Array.isArray(txn.dirs)) {
    throw new SnError(`${ctx.manifestPath} is pending but has no transaction record; not touching anything`);
  }
  const { steps, blockers } = planFiles(ctx, manifest, report);
  if (blockers.length) {
    throw new SnError(`The interrupted install cannot be rolled back automatically. Nothing was changed; ${ctx.manifestPath} and the backups were kept:\n${blockers.map((b) => `  - ${b}`).join("\n")}`);
  }
  for (const step of steps) step();
  for (const s of [...txn.symlinks].reverse()) {
    const spec = symlinkSpec(ctx, s?.path);
    if (spec && readLink(s.path) === spec.target) fs.unlinkSync(s.path);
  }
  for (const d of [...txn.dirs].reverse()) {
    if (dirAllowed(ctx, d) && lstat(d)?.isDirectory()) rmdirIfEmpty(d);
  }
  if (txn.previous) {
    const keep = new Set(Object.values(txn.previous.files ?? {}).map((f) => f?.backup).filter(Boolean));
    for (const f of txn.files) {
      const abs = f?.backup && !keep.has(f.backup) ? backupPath(ctx, f.backup) : null;
      if (abs) fs.unlinkSync(abs);
    }
    const dir = backupDirPath(ctx, txn.backupDir);
    if (dir) rmdirIfEmpty(dir);
    saveManifest(ctx, txn.previous);
    return;
  }
  removeState(ctx, manifest, report);
  if (manifest.createdHome) rmdirIfEmpty(ctx.snHome);
}

export function openManifest(ctx, log, dryRun) {
  const manifest = loadManifest(ctx);
  if (!manifest) {
    if (hasOrphanedInstall(ctx)) throw new SnError(`SUPER-NEMO is installed in ${ctx.agentDir} but its state is missing at ${ctx.state}; restore ${ctx.snHome} or remove the SUPER-NEMO links and marker blocks by hand`);
    return null;
  }
  checkRoots(ctx, manifest);
  for (const note of manifest.ignored) log(`note: ignored manifest entry, ${note}`);
  if (manifest.status !== "pending") return manifest;
  if (dryRun) throw new SnError("a previous install was interrupted; run without --dry-run to roll it back first");
  log("Found an interrupted install; rolling it back first.");
  rollback(ctx, manifest, log);
  return loadManifest(ctx);
}

export const timestamp = () => new Date().toISOString().replace(/[:.]/g, "-");

export function backupRel(ts, file) {
  return path.posix.join("backups", ts, path.basename(file));
}
