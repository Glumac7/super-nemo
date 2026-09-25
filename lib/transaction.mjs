import fs from "node:fs";
import path from "node:path";
import { MANAGED_KEYS, watchdogEntry } from "./context.mjs";
import {
  backupDirPath, backupPath, checkRoots, dirAllowed, fileAllowed, hasOrphanedInstall, loadManifest, removeState, saveManifest,
  staleLinkSpec, symlinkSpec,
} from "./manifest.mjs";
import { isEmptyText, revertFromBackup, unmerge } from "./merge.mjs";
import { SnError, fileHash, lstat, readLink, replaceIfHash, rmdirIfEmpty, sha256 } from "./util.mjs";

function readBackup(ctx, f) {
  const src = backupPath(ctx, f.backup);
  const saved = src ? fs.readFileSync(src) : null;
  if (!saved || sha256(saved) !== f.backupHash) throw new SnError(`${f.path}: backup ${f.backup} is missing or damaged`);
  return saved;
}

function revert(ctx, manifest, f, text, report) {
  const watchdog = watchdogEntry(ctx);
  if (!manifest.txn.previous) return unmerge(manifest, f.kind, text, f.path, report, watchdog);
  const backup = f.existed ? readBackup(ctx, f).toString("utf8") : "";
  return revertFromBackup(f.kind, text, backup, f.path, { keys: MANAGED_KEYS, watchdog, report });
}

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
      try {
        const saved = readBackup(ctx, f);
        steps.push(() => replaceIfHash(f.path, f.afterHash, saved));
      } catch (err) {
        if (!(err instanceof SnError)) throw err;
        blockers.push(err.message);
      }
      continue;
    }
    const text = fs.readFileSync(f.path, "utf8");
    let next;
    try {
      next = revert(ctx, manifest, f, text, report);
    } catch (err) {
      if (!(err instanceof SnError)) throw err;
      blockers.push(`${f.path} changed after the interrupted install and cannot be reverted automatically: ${err.message}`);
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
  for (const s of Array.isArray(txn.removedLinks) ? txn.removedLinks : []) {
    const spec = staleLinkSpec(ctx, s?.path);
    if (spec && !lstat(spec.path)) fs.symlinkSync(spec.target, spec.path);
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

export function openManifest(ctx, log, dryRun, note = (m) => log(m)) {
  const manifest = loadManifest(ctx);
  if (!manifest) {
    if (hasOrphanedInstall(ctx)) throw new SnError(`SUPER-NEMO is installed in ${ctx.agentDir} but its state is missing at ${ctx.state}; restore ${ctx.snHome} or remove the SUPER-NEMO links and marker blocks by hand`);
    return null;
  }
  checkRoots(ctx, manifest);
  for (const ignored of manifest.ignored) note(`ignored manifest entry, ${ignored}`);
  if (manifest.status !== "pending") return manifest;
  if (dryRun) throw new SnError("a previous install was interrupted; run without --dry-run to roll it back first");
  log("Found an interrupted install; rolling it back first.");
  rollback(ctx, manifest, note);
  return loadManifest(ctx);
}

export const timestamp = () => new Date().toISOString().replace(/[:.]/g, "-");

export function backupRel(ts, file) {
  return path.posix.join("backups", ts, path.basename(file));
}
