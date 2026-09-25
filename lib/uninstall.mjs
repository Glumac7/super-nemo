import fs from "node:fs";
import path from "node:path";
import { watchdogEntry } from "./context.mjs";
import { originUrl, redact, tryGit, unpushedWork } from "./git.mjs";
import { backupPath, dirAllowed, fileAllowed, isOurSymlink, isStaleLink, removeState, staleLinkSpec, stateProblems, symlinkSpec } from "./manifest.mjs";
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
  const ours = (p) => isOurSymlink(ctx, p) || isStaleLink(ctx, p);
  for (const p of manifest.symlinks) {
    if (typeof p !== "string" || !(symlinkSpec(ctx, p) || staleLinkSpec(ctx, p))) report(`left ${p}: not a path this installer manages`);
    else if (!lstat(p)) continue;
    else if (!ours(p)) report(`left ${p}: not a symlink into ${ctx.repo}`);
    else {
      actions.push({
        desc: `unlink ${p}`,
        run: () => {
          if (ours(p)) fs.unlinkSync(p);
          else report(`left ${p}: changed while uninstalling`);
        },
      });
    }
  }
  return actions;
}

function cloneKeepReason(ctx, manifest) {
  const { path: p, origin } = manifest.clone;
  const st = lstat(p);
  if (!st) return "it no longer exists";
  if (p !== ctx.cloneDir || st.isSymbolicLink() || !st.isDirectory()) return `it is not the plain directory ${ctx.cloneDir}`;
  if (manifest.repo !== p || ctx.repo !== p) return `SUPER-NEMO is not running from it; run ${p}/sn uninstall`;
  if (tryGit(p, ["rev-parse", "--show-toplevel"]) !== p) return "it is not a git checkout of its own";
  if (originUrl(p) !== origin) return `its origin is no longer ${redact(origin)}`;
  return unpushedWork(p);
}

function cloneAction(ctx, manifest, report) {
  const state = { desc: `remove ${ctx.manifestPath}, recorded backups and ${ctx.state} if empty`, run: () => removeState(ctx, manifest, report) };
  if (!manifest.clone || !lstat(manifest.clone.path)) return state;
  const p = manifest.clone.path;
  const why = cloneKeepReason(ctx, manifest);
  if (why) {
    report(`kept ${p}: ${why}`);
    return state;
  }
  return {
    desc: `remove ${p} (the checkout the bootstrap installer created; no local changes), then ${state.desc.slice(7)}`,
    run: () => {
      const again = cloneKeepReason(ctx, manifest);
      if (again) {
        report(`kept ${p}: ${again}`);
        state.run();
        return;
      }
      const trash = path.join(ctx.snHome, `.repo-removing-${process.pid}-${Date.now()}`);
      if (lstat(trash)) throw new SnError(`${trash} already exists; nothing about ${p} or ${ctx.manifestPath} was changed`);
      try {
        fs.renameSync(p, trash);
      } catch (err) {
        throw new SnError(`Could not move ${p} aside (${err.message}); it and ${ctx.manifestPath} were kept. Fix the problem and run the uninstall again.`);
      }
      try {
        state.run();
      } catch (err) {
        fs.renameSync(trash, p);
        throw new SnError(`Could not remove ${ctx.state} (${err.message}); ${p} was put back and ${ctx.manifestPath} was kept. Fix the problem and run the uninstall again.`);
      }
      try {
        fs.rmSync(trash, { recursive: true });
      } catch (err) {
        throw new SnError(`SUPER-NEMO was uninstalled, but ${trash} (the old ${p}) could not be deleted (${err.message}). It is safe to delete that directory.`);
      }
    },
  };
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
  const blockers = stateProblems(ctx, manifest);
  const actions = [...fileActions(ctx, manifest, report, blockers), ...symlinkActions(ctx, manifest, report), ...dirActions(ctx, manifest, report)];
  if (blockers.length) {
    for (const n of notes) log(`note: ${n}`);
    throw new SnError(`Uninstall incomplete, nothing was changed. Fix these files and run ./sn uninstall again:\n${blockers.map((b) => `  - ${b}`).join("\n")}`);
  }
  actions.push(cloneAction(ctx, manifest, report));
  if (manifest.createdHome) actions.push({ desc: `remove ${ctx.snHome} if empty`, run: () => rmdirIfEmpty(ctx.snHome) });

  if (dryRun) {
    log("Uninstall plan (dry run, nothing written):");
    for (const a of actions) log(`  ${a.desc}`);
    for (const n of notes) log(`note: ${n}`);
    return 0;
  }
  try {
    for (const a of actions) a.run();
  } finally {
    for (const n of notes) log(`note: ${n}`);
  }
  log(`Uninstalled SUPER-NEMO from ${ctx.agentDir}.`);
  return 0;
}
