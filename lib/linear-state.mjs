import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { controlDir, UUID, safeParents } from './linear-config.mjs';

export const OUTBOX_LIMIT = 100;
export function compactOutbox(state) {
  state.outbox = state.outbox.filter(item => {
    if (!item.sent) return true;
    const claim = state.claims[item.issueId];
    if (claim && item.event) claim.notified = [...new Set([...(claim.notified ?? []), item.event])];
    return false;
  });
}
export function reserveOutbox(state, slots = 2) {
  compactOutbox(state);
  if (state.outbox.length + slots > OUTBOX_LIMIT) throw new Error('Pending notification limit reached; deliver pending notifications before claiming more work');
}
export function privateDir(dir, io = fs) {
  const missing = [];
  let parent = dir;
  while (!io.existsSync(parent)) { missing.unshift(parent); parent = path.dirname(parent); }
  safeParents(path.join(parent, 'managed-child'));
  // An existing anchor may be the last mkdir from an earlier failed fsync.
  syncDir(path.dirname(parent), io);
  for (const next of missing) {
    io.mkdirSync(next, { mode: 0o700 });
    try { syncDir(path.dirname(next), io); } catch (error) {
      try { io.rmdirSync(next); syncDir(path.dirname(next), io); } catch {}
      throw error;
    }
  }
  const st = io.lstatSync(dir);
  if (!st.isDirectory() || st.uid !== process.getuid() || (st.mode & 0o077)) throw new Error('State directory must be owned private directory');
  syncDir(path.dirname(dir), io);
  syncDir(dir, io);
}
export function syncDir(dir, io = fs) {
  const fd = io.openSync(dir, 'r');
  try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
}
export function durableWrite(file, value) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  syncDir(path.dirname(file));
}
export function readJSON(file, includeIdentity = false) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o077)) throw new Error('Unsafe state file');
    const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
    return includeIdentity ? { value, identity: st } : value;
  } finally { fs.closeSync(fd); }
}
export function createLock(file, value, io = fs) {
  const fd = io.openSync(file, 'wx', 0o600);
  const identity = io.fstatSync(fd);
  let closed = false;
  const remove = () => {
    const current = io.lstatSync(file, { throwIfNoEntry: false });
    if (current?.dev === identity.dev && current?.ino === identity.ino) { io.unlinkSync(file); syncDir(path.dirname(file), io); }
  };
  try {
    io.writeFileSync(fd, JSON.stringify(value)); io.fsyncSync(fd);
    io.closeSync(fd); closed = true; syncDir(path.dirname(file), io);
    return remove;
  } catch (error) {
    if (!closed) { try { io.closeSync(fd); } catch {} }
    try { remove(); } catch {}
    throw error;
  }
}
export function acquire(config, dir = controlDir()) {
  privateDir(dir);
  if (fs.existsSync(path.join(dir, 'recovery.json'))) throw new Error('Control plane recovery in progress');
  const lock = path.join(dir, 'lock.json');
  let removeLock;
  try { removeLock = createLock(lock, { pid: process.pid, configPath: config.configPath, stateDir: config.stateDir }); } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Control plane locked or interrupted-in-doubt; stop poller and ALL descendants, then use acknowledge --issue <UUID> --confirm-stopped');
    throw error;
  }
  if (fs.existsSync(path.join(dir, 'recovery.json'))) { removeLock(); throw new Error('Control plane recovery in progress'); }
  let safe = true;
  try {
    const registryFile = path.join(dir, 'registry.json');
    let registry;
    try { registry = readJSON(registryFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (registry && (registry.configPath !== config.configPath || registry.stateDir !== config.stateDir)) throw new Error('Another configuration is registered; explicitly uninstall it first');
    if (!registry) durableWrite(registryFile, { configPath: config.configPath, stateDir: config.stateDir });
    privateDir(config.stateDir);
    return {
      retain() { safe = false; },
      release() { if (safe) removeLock(); },
    };
  } catch (error) { removeLock(); throw error; }
}
export function releaseRegistration(configPath, dir = controlDir(), callback = () => {}) {
  privateDir(dir);
  if (fs.existsSync(path.join(dir, 'recovery.json'))) throw new Error('Control plane recovery in progress');
  let removeLock;
  try { removeLock = createLock(path.join(dir, 'lock.json'), { pid: process.pid, configPath, operation: 'uninstall' }); } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Cannot unregister an active or uncertain control plane');
    throw error;
  }
  try {
    if (fs.existsSync(path.join(dir, 'recovery.json'))) throw new Error('Control plane recovery in progress');
    const file = path.join(dir, 'registry.json');
    if (fs.existsSync(file) && readJSON(file).configPath !== configPath) throw new Error('Configuration does not own registry');
    callback();
    if (fs.existsSync(file)) { fs.unlinkSync(file); syncDir(dir); }
  } finally { removeLock(); }
}
export function loadState(config) {
  const file = path.join(config.stateDir, 'state.json');
  let state;
  try { state = readJSON(file); } catch (error) { if (error.code !== 'ENOENT') throw error; state = { version: 1, claims: {}, outbox: [] }; }
  validateState(state);
  return state;
}
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
export function validateState(state) {
  const statuses = new Set(['claimed', 'preparing', 'launch-intent', 'running', 'completed', 'failed', 'interrupted-in-doubt', 'acknowledged-interruption']);
  if (!plainObject(state) || state.version !== 1 || !plainObject(state.claims) || !Array.isArray(state.outbox) || state.outbox.filter(item => !item?.sent).length > OUTBOX_LIMIT) throw new Error('Invalid durable state');
  for (const [key, claim] of Object.entries(state.claims)) {
    if (!UUID.test(key) || key !== key.toLowerCase() || !plainObject(claim) || claim.issueId !== key || !statuses.has(claim.status) || claim.notified !== undefined && (!Array.isArray(claim.notified) || claim.notified.some(event => !['progress', 'terminal', 'acknowledged'].includes(event)))) throw new Error('Invalid durable claim');
    if (claim.projectId !== undefined && !UUID.test(claim.projectId)) throw new Error('Invalid claim project');
    if (claim.branch !== undefined && claim.branch !== `linear/auto-${key}`) throw new Error('Invalid claim branch');
    if (['preparing', 'launch-intent', 'running', 'completed'].includes(claim.status)) {
      if (claim.branch !== `linear/auto-${key}` || !['repo', 'commonDir', 'worktree'].every(field => typeof claim[field] === 'string' && path.isAbsolute(claim[field])) || !/^[0-9a-f]{40,64}$/.test(claim.baseSHA ?? '')) throw new Error('Invalid durable execution identity');
    }
  }
  for (const item of state.outbox) {
    if (!plainObject(item) || !UUID.test(item.issueId ?? '') || !state.claims[item.issueId] || !['progress', 'terminal', 'acknowledged'].includes(item.event) || item.marker !== `[super-nemo:${item.issueId}:${item.event}]` || typeof item.body !== 'string' || item.body.length > 4096 || !item.body.startsWith(item.marker + '\n') || item.sent !== undefined && typeof item.sent !== 'boolean') throw new Error('Invalid durable notification');
  }
}
export function saveState(config, state) { durableWrite(path.join(config.stateDir, 'state.json'), state); }
export function enqueue(state, issueId, event, body) {
  const marker = `[super-nemo:${issueId}:${event}]`;
  if (state.claims[issueId]?.notified?.includes(event) || state.outbox.some(item => item.marker === marker)) return;
  reserveOutbox(state, 1);
  state.outbox.push({ issueId, event, marker, body: `${marker}\n${body}` });
}

export function acknowledgeInterruption(config, issueId, confirmed, dir = controlDir()) {
  if (confirmed !== true || !UUID.test(issueId ?? '')) throw new Error('Issue UUID and explicit all-processes-stopped confirmation required');
  privateDir(dir);
  const guard = path.join(dir, 'recovery.json');
  const removeGuard = createLock(guard, { pid: process.pid, configPath: config.configPath });
  try {
    const registry = readJSON(path.join(dir, 'registry.json'));
    if (registry.configPath !== config.configPath || registry.stateDir !== config.stateDir) throw new Error('Configuration does not own registry');
    const lockFile = path.join(dir, 'lock.json');
    let interruptedLock;
    if (fs.existsSync(lockFile)) {
      const captured = readJSON(lockFile, true);
      if (captured.value.configPath !== config.configPath || captured.value.stateDir !== config.stateDir) throw new Error('Configuration does not own interrupted lock');
      interruptedLock = captured.identity;
    }
    const state = loadState(config);
    const claim = state.claims[issueId.toLowerCase()];
    if (!claim || !['claimed', 'preparing', 'launch-intent', 'running', 'interrupted-in-doubt'].includes(claim.status)) throw new Error('Issue is not an interrupted or uncertain execution');
    claim.status = 'acknowledged-interruption';
    claim.acknowledgedAt = new Date().toISOString();
    enqueue(state, claim.issueId, 'acknowledged', 'Automation interruption acknowledged by operator: all poller and child processes confirmed stopped. This issue will never automatically rerun. Retained private state/worktree/logs require manual review.');
    saveState(config, state);
    const currentLock = fs.lstatSync(lockFile, { throwIfNoEntry: false });
    if (currentLock) {
      if (!interruptedLock || currentLock.dev !== interruptedLock.dev || currentLock.ino !== interruptedLock.ino) throw new Error('Interrupted lock changed; refusing to remove replacement');
      fs.unlinkSync(lockFile); syncDir(dir);
    }
    return state;
  } finally { removeGuard(); }
}
