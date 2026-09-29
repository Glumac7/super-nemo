import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SnError } from "./util.mjs";

function lstat(p) {
  try {
    return fs.lstatSync(p, { bigint: true });
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
}

const identity = (st) => ({ dev: String(st.dev), ino: String(st.ino) });
export const sameLauncher = (st, recorded) => Boolean(st && recorded && st.isSymbolicLink()
  && String(st.dev) === recorded.dev && String(st.ino) === recorded.ino);

// A process's CWD pins each directory inode. Relative operations below cannot follow
// a replacement of ~/.local or ~/.local/bin made after entering that directory.
function inBin(ctx, create, action) {
  const previous = process.cwd();
  try {
    process.chdir(ctx.home);
    for (const component of [".local", "bin"]) {
      let before = lstat(component);
      if (!before && create) {
        fs.mkdirSync(component);
        before = lstat(component);
      }
      if (!before?.isDirectory()) throw new SnError(`launcher parent ${component} is missing, a symlink or not a directory`);
      process.chdir(component);
      const here = fs.statSync(".", { bigint: true });
      if (here.dev !== before.dev || here.ino !== before.ino) throw new SnError(`launcher parent ${component} changed while opening it`);
    }
    return action();
  } finally {
    process.chdir(previous);
  }
}

function removeHere(ctx, recorded, report) {
  const st = lstat("sn");
  if (!st) return false;
  const target = path.join(ctx.repo, "sn");
  if (!sameLauncher(st, recorded) || fs.readlinkSync("sn") !== target) {
    report(`left ${ctx.launcher}: not the launcher created by SUPER-NEMO`);
    return false;
  }
  // A single unpredictable leaf under the pinned bin directory avoids a replaceable
  // quarantine-directory component between the ownership check and the rename.
  const held = `.sn-removing-${randomUUID()}`;
  fs.renameSync("sn", held);
  const moved = lstat(held);
  if (sameLauncher(moved, recorded) && fs.readlinkSync(held) === target) {
    fs.unlinkSync(held);
    return true;
  }
  // The leaf changed between the ownership check and rename. Never unlink it.
  try {
    if (moved?.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(held), "sn");
    else if (moved?.isFile()) fs.linkSync(held, "sn");
  } catch {
    // Keep the unexpected entry in quarantine if its name cannot be restored.
  }
  report(`left ${path.join(process.cwd(), held)}: launcher changed during removal`);
  return false;
}

export function createLauncher(ctx) {
  return inBin(ctx, true, () => {
    try {
      fs.symlinkSync(path.join(ctx.repo, "sn"), "sn");
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const conflict = new SnError(`${ctx.launcher} appeared during install; refusing to replace it`);
      conflict.code = "LAUNCHER_CONFLICT";
      throw conflict;
    }
    const created = lstat("sn");
    if (!created?.isSymbolicLink() || fs.readlinkSync("sn") !== path.join(ctx.repo, "sn")) {
      throw new SnError(`launcher changed during install at ${ctx.launcher}`);
    }
    const recorded = identity(created);
    const bin = lstat(ctx.binDir);
    const here = fs.statSync(".", { bigint: true });
    if (!ctx.ourPath(ctx.launcher) || !bin?.isDirectory() || bin.dev !== here.dev || bin.ino !== here.ino) {
      removeHere(ctx, recorded, () => {});
      throw new SnError(`launcher parent changed during install; no link was installed at ${ctx.launcher}`);
    }
    return recorded;
  });
}

export function removeLauncher(ctx, recorded, report) {
  try {
    return inBin(ctx, false, () => removeHere(ctx, recorded, report));
  } catch (error) {
    if (!(error instanceof SnError) && error.code !== "ENOENT") throw error;
    report(`left ${ctx.launcher}: ${error.message}`);
    return false;
  }
}

export function launcherMatches(ctx, recorded) {
  const st = lstat(ctx.launcher);
  return ctx.ourPath(ctx.launcher) && sameLauncher(st, recorded) && fs.readlinkSync(ctx.launcher) === path.join(ctx.repo, "sn");
}
