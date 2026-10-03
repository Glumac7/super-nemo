import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { realish } from './util.mjs';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const controlDir = () => path.join(os.homedir(), '.super-nemo', 'linear-control');
const absolute = (value, field) => {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw new Error(`Invalid ${field}: absolute path required`);
  return realish(value);
};
const within = (child, parent) => child === parent || child.startsWith(parent + path.sep);
export function safeParents(file) {
  const originalParent = path.resolve(path.dirname(file));
  let original = path.parse(originalParent).root;
  for (const component of originalParent.slice(original.length).split(path.sep).filter(Boolean)) {
    original = path.join(original, component);
    const st = fs.lstatSync(original);
    if (st.isSymbolicLink()) {
      // macOS /var and /tmp are root-owned system links. Never accept a
      // user-controlled link in an authorization or managed-state ancestor.
      const linkParent = fs.statSync(path.dirname(original));
      if (st.uid !== 0 || linkParent.uid !== 0 || (linkParent.mode & 0o022)) throw new Error('Unsafe symlinked path parent');
    } else if (!st.isDirectory() || st.uid !== 0 && st.uid !== process.getuid() || (st.mode & 0o022) && !(st.uid === 0 && (st.mode & 0o1000))) throw new Error('Unsafe path parent ownership or permissions');
  }
  for (let dir = fs.realpathSync(path.dirname(file));; dir = path.dirname(dir)) {
    const st = fs.statSync(dir);
    if (st.uid !== 0 && st.uid !== process.getuid() || (st.mode & 0o022) && !(st.uid === 0 && (st.mode & 0o1000))) throw new Error('Unsafe path parent ownership or permissions');
    if (dir === path.dirname(dir)) break;
  }
}
export function validateExecutable(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) throw new Error('Absolute executable path required');
  safeParents(file);
  const original = fs.lstatSync(file);
  if (original.isSymbolicLink() && original.uid !== 0 && original.uid !== process.getuid()) throw new Error('Unsafe executable link owner');
  const canonical = fs.realpathSync(file);
  safeParents(canonical);
  const st = fs.lstatSync(canonical);
  if (!st.isFile() || st.uid !== 0 && st.uid !== process.getuid() || (st.mode & 0o022)) throw new Error('Executable must be trusted owned regular non-writable file');
  fs.accessSync(canonical, fs.constants.X_OK);
  return canonical;
}
export function loadConfig(configPath) {
  if (typeof configPath !== 'string' || !path.isAbsolute(configPath) || configPath.includes('\0')) throw new Error('Absolute config path required');
  safeParents(configPath);
  const fd = fs.openSync(configPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let raw;
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid() || st.nlink !== 1 || (st.mode & 0o777) !== 0o600 || st.size > 1024 * 1024) throw new Error('Config must be owned regular single-link 0600 file of at most 1 MiB');
    raw = JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
  configPath = absolute(configPath, 'config path');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid config');
  const stateDir = absolute(raw.stateDir, 'stateDir');
  const tokenFile = absolute(raw.tokenFile, 'tokenFile');
  // Preserve the final pathname: opening it must reject a symlink, not follow realish.
  if (fs.lstatSync(raw.tokenFile).isSymbolicLink()) throw new Error('tokenFile must not be a symlink');
  const ompPath = validateExecutable(raw.ompPath);
  if (raw.allowPublish !== undefined && typeof raw.allowPublish !== 'boolean') throw new Error('allowPublish must be boolean');
  const allowPublish = raw.allowPublish === true;
  const ghPath = allowPublish ? validateExecutable(raw.ghPath ?? '/opt/homebrew/bin/gh') : undefined;
  const pollSeconds = raw.pollSeconds ?? 45;
  if (!Number.isInteger(pollSeconds) || pollSeconds < 30 || pollSeconds > 60) throw new Error('pollSeconds must be 30..60');
  if (raw.profile !== undefined && (typeof raw.profile !== 'string' || !/^[a-zA-Z0-9_.-]{1,80}$/.test(raw.profile))) throw new Error('Invalid profile');
  if (!raw.projects || typeof raw.projects !== 'object' || Array.isArray(raw.projects) || !Object.keys(raw.projects).length) throw new Error('Explicit projects required');
  const projects = {};
  for (const [id, project] of Object.entries(raw.projects)) {
    if (!UUID.test(id) || !project || typeof project.name !== 'string' || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(project.github ?? '')) throw new Error('Invalid project mapping');
    if (Object.hasOwn(projects, id.toLowerCase())) throw new Error('Duplicate canonical project UUID');
    const repo = absolute(project.repo, 'project repo');
    if (!fs.statSync(repo).isDirectory()) throw new Error('Repository must be a directory');
    if ([stateDir, tokenFile, configPath, controlDir()].some(p => within(p, repo))) throw new Error('Config, credentials and state must be outside repositories');
    projects[id.toLowerCase()] = { name: project.name, repo, github: project.github };
  }
  if (within(tokenFile, stateDir)) throw new Error('Credentials must be outside stateDir');
  return { configPath, stateDir, tokenFile, ompPath, pollSeconds, projects, profile: raw.profile, allowPublish, ghPath };
}
export function readToken(config) {
  const fd = fs.openSync(config.tokenFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.size > 8192) throw new Error('tokenFile must be owned regular 0600 file');
    const token = fs.readFileSync(fd, 'utf8').trim();
    if (!token || /\s/.test(token)) throw new Error('Invalid credential file');
    return token;
  } finally { fs.closeSync(fd); }
}
