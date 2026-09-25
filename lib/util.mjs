import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export class SnError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

export const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

export function lstat(p) {
  try {
    return fs.lstatSync(p);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
    throw err;
  }
}

export function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function readLink(p) {
  const st = lstat(p);
  return st?.isSymbolicLink() ? fs.readlinkSync(p) : null;
}

export function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function readRegularFile(p) {
  const st = lstat(p);
  if (!st) return null;
  if (!st.isFile()) throw new SnError(`${p} is not a regular file`);
  return fs.readFileSync(p, "utf8");
}

export function atomicWrite(p, content, mode) {
  const tmp = path.join(path.dirname(p), `.${path.basename(p)}.sn-${process.pid}.tmp`);
  fs.writeFileSync(tmp, content, { mode: mode ?? 0o644, flag: "wx" });
  try {
    if (mode !== undefined) fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, p);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

const changed = (p) => new SnError(`${p} changed while SUPER-NEMO was editing it; try again`);

export function writeIfUnchanged(p, expected, content) {
  const st = lstat(p);
  const current = st ? readRegularFile(p) : null;
  if (current !== expected) throw changed(p);
  if (content === null) fs.unlinkSync(p);
  else atomicWrite(p, content, st ? st.mode & 0o7777 : undefined);
}

export function replaceIfHash(p, hash, content) {
  const st = lstat(p);
  if (!st?.isFile() || sha256(fs.readFileSync(p)) !== hash) throw changed(p);
  if (content === null) fs.unlinkSync(p);
  else atomicWrite(p, content, st.mode & 0o7777);
}

export const fileHash = (p) => (lstat(p)?.isFile() ? sha256(fs.readFileSync(p)) : null);

export function symlinkedComponent(root, p) {
  const rel = path.relative(root, path.dirname(p));
  if (rel.startsWith("..") || path.isAbsolute(rel)) return p;
  let d = root;
  for (const part of rel ? rel.split(path.sep) : []) {
    d = path.join(d, part);
    const st = lstat(d);
    if (!st) return null;
    if (!st.isDirectory()) return d;
  }
  return null;
}

export function realish(p) {
  const missing = [];
  let d = p;
  while (!lstat(d)) {
    missing.unshift(path.basename(d));
    d = path.dirname(d);
  }
  try {
    return path.join(fs.realpathSync(d), ...missing);
  } catch {
    throw new SnError(`${d} is a dangling symlink`);
  }
}

export function rmdirIfEmpty(p) {
  try {
    fs.rmdirSync(p);
    return true;
  } catch (err) {
    if (["ENOENT", "ENOTEMPTY", "EEXIST"].includes(err.code)) return false;
    throw err;
  }
}

export function missingDirs(dir) {
  const missing = [];
  for (let d = dir; !lstat(d); d = path.dirname(d)) missing.unshift(d);
  return missing;
}
