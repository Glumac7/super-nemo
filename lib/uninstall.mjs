import fs from "node:fs";
import { watchdogEntry } from "./context.mjs";
import { backupPath, dirAllowed, fileAllowed, isOurSymlink, removeState, symlinkSpec } from "./manifest.mjs";
import { isEmptyText, unmerge } from "./merge.mjs";
import { openManifest } from "./transaction.mjs";
import { SnError, lstat, readRegularFile, rmdirIfEmpty, sha256, writeIfUnchanged } from "./util.mjs";

const YAML_KINDS = new Set(["config", "watchdogYml"]);

function fileActions(ctx, manifest, report, blockers) {
  const actions = [];
  for (const [kind, f] of Object.entries(manifest.files)) {
    if (!f || !fileAllowed(ctx, kind, f.path)) {
      report(`left ${f?.path ?? kind}: not a file this installer manages`);
      continue;
    }
    const st = lstat(f.path);
    if (!st) {
      report(`${f.path} no longer exists`);
      continue;
    }
    if (!st.isFile()) {
      blockers.push(`${f.path} is no longer a regular file`);
      continue;
    }
    const text = readRegularFile(f.path);
    const src = !f.created && sha256(text) === f.postHash ? backupPath(ctx, f.backup) : null;
    const saved = src ? fs.readFileSync(src) : null;
    if (saved && sha256(saved) === f.backupHash) {
      actions.push({ desc: `restore ${f.path} from backup`, run: () => writeIfUnchanged(f.path, text, saved) });
      continue;
    }
    let next;
    try {
      next = unmerge(manifest, kind, text, f.path, report, watchdogEntry(ctx));
    } catch (err) {
      if (!(err instanceof SnError)) throw err;
      blockers.push(err.message);
      continue;
    }
    if (f.created && isEmptyText(next, YAML_KINDS.has(kind))) {
      actions.push({ desc: `delete ${f.path} (created by install, now empty)`, run: () => writeIfUnchanged(f.path, text, null) });
    } else if (next !== text) {
      actions.push({ desc: `remove SUPER-NEMO entries from ${f.path}`, run: () => writeIfUnchanged(f.path, text, next) });
    }
  }
  return actions;
}

function symlinkActions(ctx, manifest, report) {
  const actions = [];
  for (const p of manifest.symlinks) {
    if (typeof p !== "string" || !symlinkSpec(ctx, p)) report(`left ${p}: not a path this installer manages`);
    else if (!lstat(p)) continue;
    else if (!isOurSymlink(ctx, p)) report(`left ${p}: not a symlink into ${ctx.repo}`);
    else {
      actions.push({
        desc: `unlink ${p}`,
        run: () => {
          if (isOurSymlink(ctx, p)) fs.unlinkSync(p);
          else report(`left ${p}: changed while uninstalling`);
        },
      });
    }
  }
  return actions;
}

function dirActions(ctx, manifest, report) {
  const dirs = manifest.createdDirs.filter((d) => {
    if (dirAllowed(ctx, d)) return true;
    report(`left ${d}: not a directory this installer creates`);
    return false;
  }).sort((a, b) => b.length - a.length);
  return dirs.map((d) => ({
    desc: `remove ${d} if empty`,
    run: () => {
      if (dirAllowed(ctx, d) && lstat(d)?.isDirectory() && !rmdirIfEmpty(d) && lstat(d)) report(`left ${d}: not empty`);
    },
  }));
}

export function uninstall(ctx, opts, log = console.log) {
  const dryRun = Boolean(opts["dry-run"]);
  const manifest = openManifest(ctx, log, dryRun);
  if (!manifest) {
    log("SUPER-NEMO is not installed (no manifest); nothing to do.");
    return 0;
  }
  const notes = [];
  const report = (msg) => notes.push(msg);
  const blockers = [];
  const actions = [...fileActions(ctx, manifest, report, blockers), ...symlinkActions(ctx, manifest, report), ...dirActions(ctx, manifest, report)];
  if (blockers.length) {
    for (const n of notes) log(`note: ${n}`);
    throw new SnError(`Uninstall incomplete, nothing was changed. Fix these files and run ./sn uninstall again:\n${blockers.map((b) => `  - ${b}`).join("\n")}`);
  }
  actions.push({ desc: `remove ${ctx.manifestPath}, recorded backups and ${ctx.state} if empty`, run: () => removeState(ctx, manifest, report) });
  if (manifest.createdHome) actions.push({ desc: `remove ${ctx.snHome} if empty`, run: () => rmdirIfEmpty(ctx.snHome) });

  if (dryRun) {
    log("Uninstall plan (dry run, nothing written):");
    for (const a of actions) log(`  ${a.desc}`);
  } else {
    for (const a of actions) a.run();
    log(`Uninstalled SUPER-NEMO from ${ctx.agentDir}.`);
  }
  for (const n of notes) log(`note: ${n}`);
  return 0;
}
