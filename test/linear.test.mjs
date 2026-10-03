import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { main } from '../lib/linear-cli.mjs';
import { loadConfig, readToken, validateExecutable } from '../lib/linear-config.mjs';
import { acquire, loadState, saveState, privateDir, createLock, enqueue, reserveOutbox, OUTBOX_LIMIT } from '../lib/linear-state.mjs';
import { LinearAPI } from '../lib/linear-api.mjs';
import { childEnvironment, runAgent, preparePlan, createWorktree, verifyPublishedPR } from '../lib/linear-runner.mjs';
const projectId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const id = n => `bbbbbbbb-bbbb-bbbb-bbbb-${String(n).padStart(12, '0')}`;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linear-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), home = path.join(root, 'home');
  fs.mkdirSync(repo); fs.mkdirSync(home);
  const git = args => execFileSync('/usr/bin/git', ['-C', repo, ...args], { stdio: 'pipe' });
  git(['init', '-b', 'main']); fs.writeFileSync(path.join(repo, 'file'), 'fixture');
  git(['add', 'file']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
  git(['remote', 'add', 'origin', 'https://github.com/example/fixture.git']);
  for (const resource of ['skills/super-nemo/SKILL.md', 'agents/nemo-implementer-critical.md', 'agents/nemo-security.md', 'agents/nemo-final-review.md', 'extensions/super-nemo.js']) {
    const file = path.join(home, '.omp', 'agent', resource); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'fixture resource');
  }
  const ompPath = path.join(root, 'fake-omp');
  // Actual executable child records cwd, prefix and full context in its private log.
  fs.writeFileSync(ompPath, `#!${process.execPath}\nconsole.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),env:Object.keys(process.env)}));\nprocess.exit(process.argv.join(' ').includes('FAIL_FIXTURE') ? 7 : 0);\n`, { mode: 0o700 });
  const tokenFile = path.join(root, 'token'); fs.writeFileSync(tokenFile, 'fixture-not-a-secret', { mode: 0o600 });
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ stateDir: path.join(root, 'state'), tokenFile, ompPath, projects: { [projectId]: { name: 'Fixture', repo, github: 'example/fixture' } } }), { mode: 0o600 });
  return { root, repo, home, configPath, tokenFile, config: loadConfig(configPath), deps: { home, controlDir: path.join(root, 'control') } };
}
async function serverFixture(t) {
  const issues = [], comments = new Map(); let failPost = false;
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const { query, variables: v } = JSON.parse(body);
    const page = nodes => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
    let data;
    if (query.includes('query Identity')) data = { viewer: { id: projectId } };
    else if (query.includes('query Poll')) data = { issues: page(issues.map(({ labels, ...issue }) => issue)) };
    else if (query.includes('query Labels')) data = { issue: { labels: page(issues.find(i => i.id === v.id).labels.map(name => ({ name }))) } };
    else if (query.includes('query Comments')) data = { issue: { comments: page(comments.get(v.id) ?? []) } };
    else if (query.includes('mutation Post')) {
      if (failPost) { res.writeHead(503); res.end('{}'); return; }
      const rows = comments.get(v.id) ?? []; rows.push({ body: v.body, user: { id: projectId } }); comments.set(v.id, rows); data = { commentCreate: { success: true } };
    } else { res.writeHead(400); res.end('{}'); return; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const fetcher = (_url, options) => fetch(`http://127.0.0.1:${server.address().port}/graphql`, options);
  return { issues, comments, fetch: fetcher, failPost(value) { failPost = value; }, issue(n, labels = ['auto-implement'], title = 'Implement fixture') { return { id: id(n), identifier: `FIX-${n}`, title, description: 'Complete description', project: { id: projectId }, labels }; } };
}
test('offline operational CLI: exact label, actual child cwd/context, failure, restart and notification-only retry', async t => {
  const f = fixture(t), api = await serverFixture(t);
  const deps = { ...f.deps, fetch: api.fetch };
  api.issues.push(api.issue(1), api.issue(2, ['Auto-implement']), api.issue(3, ['auto-implement'], 'FAIL_FIXTURE'));
  api.comments.set(id(1), [{ body: 'Complete comment context', user: { name: 'Fixture' } }]);
  let state = await main(['once', '--config', f.configPath], deps);
  assert.equal(state.claims[id(1)].status, 'completed');
  assert.equal(state.claims[id(3)].status, 'failed');
  assert.equal(state.claims[id(2)], undefined);
  assert.equal(api.comments.has(id(2)), false);
  const log = fs.readFileSync(state.claims[id(1)].logPath, 'utf8');
  const child = JSON.parse(log.trim());
  assert.equal(child.cwd, state.claims[id(1)].worktree);
  assert.equal(child.args[0], '-p'); assert.match(child.args[1], /^super-nemo critical:/);
  assert.match(child.args[1], /Complete comment context/); assert.match(child.args[1], /Complete description/);
  assert.equal(child.env.includes('LINEAR_API_KEY'), false);
  const count = api.comments.get(id(1)).length;
  await main(['once', '--config', f.configPath], deps);
  assert.equal(fs.readFileSync(state.claims[id(1)].logPath, 'utf8'), log);
  assert.equal(api.comments.get(id(1)).length, count);
  assert.match(api.comments.get(id(3)).at(-1).body, /Automation failed/);
  assert.equal(api.comments.get(id(3)).some(c => c.body.includes('FAIL_FIXTURE')), false);
  // Unknown successful mutation: marker lookup prevents duplicate redelivery.
  const terminalBody = api.comments.get(id(1)).find(c => c.body.startsWith(`[super-nemo:${id(1)}:terminal]`)).body;
  state.outbox.push({ issueId: id(1), event: 'terminal', marker: `[super-nemo:${id(1)}:terminal]`, body: terminalBody });
  saveState(f.config, state);
  await main(['retry', '--config', f.configPath], deps);
  assert.equal(api.comments.get(id(1)).length, count);
  assert.equal(fs.readFileSync(state.claims[id(1)].logPath, 'utf8'), log);
  // Pending delivery retries without launching another process.
  state = loadState(f.config);
  state.outbox.push({ issueId: id(1), event: 'terminal', marker: `[super-nemo:${id(1)}:terminal]`, body: `[super-nemo:${id(1)}:terminal]\nControlled fixture notification` }); saveState(f.config, state);
  api.failPost(true); await assert.rejects(main(['retry', '--config', f.configPath], deps));
  api.failPost(false); await main(['retry', '--config', f.configPath], deps);
  assert.equal(fs.readFileSync(state.claims[id(1)].logPath, 'utf8'), log);
  assert.equal(api.comments.get(id(1)).filter(c => c.body.endsWith('Controlled fixture notification')).length, 1);
  // An issue author cannot spoof the deterministic outbox marker.
  state = loadState(f.config);
  const forged = { issueId: id(1), event: 'terminal', marker: `[super-nemo:${id(1)}:terminal]`, body: `[super-nemo:${id(1)}:terminal]\nControlled notification` };
  state.outbox.push(forged); saveState(f.config, state);
  api.comments.get(id(1)).push({ body: forged.body, user: { id: id(99) } });
  await main(['retry', '--config', f.configPath], deps);
  assert.equal(api.comments.get(id(1)).filter(c => c.body === forged.body && c.user?.id === projectId).length, 1);
});
test('launch-intent recovery never spawns and retains global lock', async t => {
  const f = fixture(t), api = await serverFixture(t);
  privateDir(f.config.stateDir);
  saveState(f.config, { version: 1, claims: { [id(1)]: { issueId: id(1), status: 'launch-intent', branch: `linear/auto-${id(1)}`, repo: f.config.projects[projectId].repo, commonDir: path.join(f.config.projects[projectId].repo, '.git'), worktree: path.join(f.config.stateDir, 'worktrees', id(1)), baseSHA: '1'.repeat(40) } }, outbox: [] });
  await assert.rejects(main(['once', '--config', f.configPath], { ...f.deps, fetch: api.fetch }), /Interrupted-in-doubt/);
  assert.equal(api.comments.get(id(1)).filter(c => c.body.startsWith(`[super-nemo:${id(1)}:terminal]`)).length, 1);
  assert.equal(loadState(f.config).claims[id(1)].status, 'interrupted-in-doubt');
  assert.equal(fs.existsSync(path.join(f.config.stateDir, 'logs')), false);
  assert.equal(fs.existsSync(path.join(f.deps.controlDir, 'lock.json')), true);
  await assert.rejects(main(['once', '--config', f.configPath], { ...f.deps, fetch: api.fetch }), /locked/);
  await assert.rejects(main(['acknowledge', '--config', f.configPath, '--issue', id(1)], f.deps), /confirm-stopped/);
  const acknowledged = await main(['acknowledge', '--config', f.configPath, '--issue', id(1), '--confirm-stopped'], f.deps);
  assert.equal(acknowledged.claims[id(1)].status, 'acknowledged-interruption');
  assert.equal(fs.existsSync(path.join(f.deps.controlDir, 'lock.json')), false);
  api.issues.push(api.issue(1), api.issue(2));
  const resumed = await main(['once', '--config', f.configPath], { ...f.deps, fetch: api.fetch });
  assert.equal(resumed.claims[id(1)].status, 'acknowledged-interruption');
  assert.equal(resumed.claims[id(2)].status, 'completed');
  assert.equal(fs.existsSync(path.join(f.config.stateDir, 'logs', `${id(1)}.log`)), false);
  await main(['retry', '--config', f.configPath], { ...f.deps, fetch: api.fetch });
  assert.equal(api.comments.get(id(1)).filter(c => c.body.startsWith(`[super-nemo:${id(1)}:acknowledged]`)).length, 1);
  assert.equal(api.comments.get(id(1)).filter(c => c.body.startsWith(`[super-nemo:${id(1)}:terminal]`)).length, 1);
  assert.equal(fs.existsSync(path.join(f.config.stateDir, 'logs', `${id(1)}.log`)), false);
});
test('global singleton rejects other configs and stale locks without PID guessing', t => {
  const f = fixture(t);
  const lock = acquire(f.config, f.deps.controlDir);
  assert.throws(() => acquire(f.config, f.deps.controlDir), /locked/);
  lock.release();
  assert.throws(() => acquire({ ...f.config, configPath: '/other/config' }, f.deps.controlDir), /Another configuration/);
  const next = acquire(f.config, f.deps.controlDir); next.retain(); next.release();
  assert.throws(() => acquire(f.config, f.deps.controlDir), /locked/);
});
test('credential descriptor rejects symlinks/modes and minimal child environment', t => {
  const f = fixture(t);
  assert.equal(readToken(f.config), 'fixture-not-a-secret');
  fs.chmodSync(f.tokenFile, 0o644); assert.throws(() => readToken(f.config), /0600/);
  fs.chmodSync(f.tokenFile, 0o600);
  const link = path.join(f.root, 'token-link'); fs.symlinkSync(f.tokenFile, link);
  assert.throws(() => readToken({ tokenFile: link }));
  const env = childEnvironment(f.config, f.home);
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'PATH', 'USER']);
});
test('API paginates complete context and rejects repeated cursors and remote error disclosure', async () => {
  let calls = 0;
  const api = new LinearAPI('fixture', async (_url, options) => {
    const { variables } = JSON.parse(options.body); calls++;
    return { ok: true, json: async () => ({ data: { issue: { comments: { nodes: [{ body: variables.after ? 'second' : 'first' }], pageInfo: { hasNextPage: !variables.after, endCursor: 'next' } } } } }) };
  });
  assert.deepEqual((await api.comments(id(1))).map(c => c.body), ['first', 'second']); assert.equal(calls, 2);
  api.fetcher = async () => ({ ok: true, json: async () => ({ data: { issue: { comments: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'same' } } } } }) });
  await assert.rejects(api.comments(id(1)), /cursor/);
  api.fetcher = async () => ({ ok: true, json: async () => ({ errors: [{ message: 'fixture-secret' }] }) });
  await assert.rejects(api.comments(id(1)), error => error.message === 'Linear GraphQL failure');
});
test('untrusted labels/origin and missing Super-Nemo profile fail without launching', async t => {
  const f = fixture(t), api = await serverFixture(t);
  api.issues.push(api.issue(1));
  execFileSync('/usr/bin/git', ['-C', f.repo, 'remote', 'set-url', 'origin', 'https://evil.invalid/example/fixture']);
  const state = await main(['once', '--config', f.configPath], { ...f.deps, fetch: api.fetch });
  assert.equal(state.claims[id(1)].status, 'failed');
  assert.equal(fs.existsSync(path.join(f.config.stateDir, 'logs')), false);
});

test('trusted publication verifies ready PR ownership, exact branch and SHA without echoing PR contents', async t => {
  for (const scenario of ['ready', 'draft', 'foreign-repo', 'wrong-sha', 'wrong-branch', 'missing']) {
    await t.test(scenario, async t => {
      const f = fixture(t), api = await serverFixture(t);
      const ghPath = path.join(f.root, 'fake-gh');
      fs.writeFileSync(ghPath, `#!${process.execPath}\nconst {execFileSync}=require('node:child_process');\nconst branch=execFileSync('/usr/bin/git',['symbolic-ref','--short','HEAD'],{encoding:'utf8'}).trim();\nconst sha=execFileSync('/usr/bin/git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();\nconst scenario=${JSON.stringify(scenario)};\nconst pr={number:17,state:'open',draft:scenario==='draft',base:{repo:{full_name:'example/fixture'}},head:{repo:{full_name:scenario==='foreign-repo'?'attacker/fixture':'example/fixture'},ref:scenario==='wrong-branch'?'main':branch,sha:scenario==='wrong-sha'?'0'.repeat(40):sha},body:'untrusted PR body fixture-secret',html_url:'https://attacker.invalid'};\nconsole.log(JSON.stringify(scenario==='missing'?[]:[pr]));\n`, { mode: 0o700 });
      const raw = JSON.parse(fs.readFileSync(f.configPath, 'utf8'));
      Object.assign(raw, { allowPublish: true, ghPath });
      fs.writeFileSync(f.configPath, JSON.stringify(raw));
      api.issues.push(api.issue(1));
      const state = await main(['once', '--config', f.configPath], { ...f.deps, fetch: api.fetch });
      assert.equal(state.claims[id(1)].status, scenario === 'ready' ? 'completed' : 'failed');
      if (scenario !== 'ready') assert.equal(state.claims[id(1)].failure, 'ready PR metadata validation failed');
      const comment = api.comments.get(id(1)).at(-1).body;
      assert.equal(comment.includes('fixture-secret'), false);
      if (scenario === 'ready') {
        assert.equal(state.claims[id(1)].pr.url, 'https://github.com/example/fixture/pull/17');
        assert.match(comment, /require human review/);
        assert.match(fs.readFileSync(state.claims[id(1)].logPath, 'utf8'), /Operator authorizes commit/);
      }
      await main(['once', '--config', f.configPath], { ...f.deps, fetch: api.fetch });
      assert.equal(api.comments.get(id(1)).length, 2);
    });
  }
});

test('missing installed profile fails closed before creating a worktree or child', async t => {
  const f = fixture(t), api = await serverFixture(t);
  fs.unlinkSync(path.join(f.home, '.omp', 'agent', 'extensions', 'super-nemo.js'));
  api.issues.push(api.issue(1));
  const state = await main(['once', '--config', f.configPath], { ...f.deps, fetch: api.fetch });
  assert.equal(state.claims[id(1)].status, 'failed');
  assert.equal(fs.existsSync(path.join(f.config.stateDir, 'worktrees')), false);
  assert.equal(fs.existsSync(path.join(f.config.stateDir, 'logs')), false);
});

test('configuration refuses relative paths, credentials in repository and unsafe intervals', t => {
  const f = fixture(t);
  const raw = JSON.parse(fs.readFileSync(f.configPath, 'utf8'));
  for (const patch of [{ stateDir: 'relative' }, { pollSeconds: 29 }, { pollSeconds: 61 }, { allowPublish: 'yes' }, { projects: {} }]) {
    fs.writeFileSync(f.configPath, JSON.stringify({ ...raw, ...patch }));
    assert.throws(() => loadConfig(f.configPath));
  }
  const tokenFile = path.join(f.repo, 'token');
  fs.writeFileSync(tokenFile, 'fixture', { mode: 0o600 });
  fs.writeFileSync(f.configPath, JSON.stringify({ ...raw, tokenFile }));
  assert.throws(() => loadConfig(f.configPath), /outside repositories/);
});

test('actual timed-out executable fails actionably and is never relaunched', async t => {
  const f = fixture(t), api = await serverFixture(t);
  fs.writeFileSync(f.config.ompPath, `#!${process.execPath}\nconsole.log('fixture timeout'); setInterval(()=>{},1000);\n`, { mode: 0o700 });
  api.issues.push(api.issue(1));
  const deps = { ...f.deps, fetch: api.fetch, timeoutMs: 100 };
  const state = await main(['once', '--config', f.configPath], deps);
  assert.equal(state.claims[id(1)].status, 'failed');
  assert.equal(state.claims[id(1)].failure, 'agent timed out');
  const log = fs.readFileSync(state.claims[id(1)].logPath, 'utf8');
  await main(['once', '--config', f.configPath], deps);
  assert.equal(fs.readFileSync(state.claims[id(1)].logPath, 'utf8'), log);
});

test('durable state rejects array claims and malformed identities before executing', async t => {
  const f = fixture(t), api = await serverFixture(t);
  privateDir(f.config.stateDir); api.issues.push(api.issue(1));
  const malformed = [
    { version: 1, claims: [], outbox: [] },
    { version: 1, claims: { [id(1)]: { issueId: id(2), status: 'claimed' } }, outbox: [] },
    { version: 1, claims: { [id(1)]: { issueId: id(1), status: 'unknown' } }, outbox: [] },
    { version: 1, claims: { [id(1)]: { issueId: id(1), status: 'running' } }, outbox: [] },
    { version: 1, claims: {}, outbox: [{ issueId: id(1), body: 'uncontrolled' }] },
  ];
  for (const state of malformed) {
    saveState(f.config, state);
    await assert.rejects(main(['once', '--config', f.configPath], { ...f.deps, fetch: api.fetch }), /Invalid durable/);
    assert.equal(fs.existsSync(path.join(f.config.stateDir, 'logs')), false);
  }
});

test('configuration rejects unsafe modes, symlinks, hardlinks and normalized UUID duplicates', t => {
  const f = fixture(t);
  fs.chmodSync(f.configPath, 0o644); assert.throws(() => loadConfig(f.configPath), /0600/); fs.chmodSync(f.configPath, 0o600);
  const link = path.join(f.root, 'config-link'); fs.symlinkSync(f.configPath, link); assert.throws(() => loadConfig(link));
  const hard = path.join(f.root, 'config-hardlink'); fs.linkSync(f.configPath, hard); assert.throws(() => loadConfig(f.configPath), /single-link/); fs.unlinkSync(hard);
  const raw = JSON.parse(fs.readFileSync(f.configPath, 'utf8'));
  raw.projects[projectId.toUpperCase()] = raw.projects[projectId];
  fs.writeFileSync(f.configPath, JSON.stringify(raw)); assert.throws(() => loadConfig(f.configPath), /Duplicate canonical/);
});

test('lock metadata write and fsync failures clean only the owned pre-sideeffect lock', t => {
  const f = fixture(t), lockPath = path.join(f.root, 'fault-lock');
  for (const operation of ['writeFileSync', 'fsyncSync']) {
    const io = { ...fs, [operation]() { throw new Error('fixture persistence failure'); } };
    assert.throws(() => createLock(lockPath, { operation: 'fixture' }, io), /persistence failure/);
    assert.equal(fs.existsSync(lockPath), false);
  }
  const remove = createLock(lockPath, { operation: 'fixture' });
  fs.renameSync(lockPath, path.join(f.root, 'old-lock'));
  fs.writeFileSync(lockPath, 'foreign replacement', { mode: 0o600 });
  remove();
  assert.equal(fs.readFileSync(lockPath, 'utf8'), 'foreign replacement');
});

test('directory creation syncs each new parent entry before durable claims are possible', t => {
  const f = fixture(t), target = path.join(f.root, 'new-parent', 'state');
  const operations = [], handles = new Map();
  const io = { ...fs,
    mkdirSync(dir, options) { operations.push(`mkdir:${dir}`); return fs.mkdirSync(dir, options); },
    openSync(file, ...args) { const fd = fs.openSync(file, ...args); handles.set(fd, file); return fd; },
    fsyncSync(fd) { operations.push(`sync:${handles.get(fd)}`); return fs.fsyncSync(fd); },
  };
  privateDir(target, io);
  assert.deepEqual(operations, [`sync:${path.dirname(f.root)}`, `mkdir:${path.dirname(target)}`, `sync:${f.root}`, `mkdir:${target}`, `sync:${path.dirname(target)}`, `sync:${path.dirname(target)}`, `sync:${target}`]);
  const faultTarget = path.join(f.root, 'fault-parent', 'state');
  assert.throws(() => privateDir(faultTarget, { ...fs, fsyncSync() { throw new Error('fixture directory sync failure'); } }), /directory sync failure/);
  assert.equal(fs.existsSync(faultTarget), false);
  fs.mkdirSync(path.dirname(faultTarget), { mode: 0o700 });
  let finalCreated = false;
  const failureIO = { ...fs,
    openSync(file, ...args) { const fd = fs.openSync(file, ...args); handles.set(fd, file); return fd; },
    mkdirSync(dir, options) { fs.mkdirSync(dir, options); if (dir === faultTarget) finalCreated = true; },
    fsyncSync(fd) { if (finalCreated && handles.get(fd) === path.dirname(faultTarget)) { finalCreated = false; throw new Error('fixture final-parent sync failure'); } fs.fsyncSync(fd); },
    rmdirSync() { throw new Error('fixture rollback unavailable'); },
  };
  assert.throws(() => privateDir(faultTarget, failureIO), /final-parent sync failure/);
  assert.equal(fs.existsSync(faultTarget), true);
  operations.length = 0;
  privateDir(faultTarget, io);
  assert.deepEqual(operations, [`sync:${path.dirname(faultTarget)}`, `sync:${path.dirname(faultTarget)}`, `sync:${faultTarget}`]);
});

test('outbox is capped before new claims, compacted on delivery and cannot lose reserved terminal events', async t => {
  const f = fixture(t), api = await serverFixture(t), state = { version: 1, claims: {}, outbox: [] };
  for (let n = 1; n <= OUTBOX_LIMIT; n++) {
    state.claims[id(n)] = { issueId: id(n), status: 'failed' };
    enqueue(state, id(n), 'terminal', 'Controlled fixture terminal');
  }
  assert.equal(state.outbox.length, OUTBOX_LIMIT);
  assert.throws(() => reserveOutbox(state, 2), /limit/);
  assert.throws(() => enqueue(state, id(101), 'terminal', 'Controlled'), /limit/);
  privateDir(f.config.stateDir); saveState(f.config, state);
  api.issues.push(api.issue(101)); api.failPost(true);
  await assert.rejects(main(['once', '--config', f.configPath], { ...f.deps, fetch: api.fetch }));
  assert.equal(loadState(f.config).claims[id(101)], undefined);
  api.failPost(false);
  const delivered = await main(['retry', '--config', f.configPath], { ...f.deps, fetch: api.fetch });
  assert.equal(delivered.outbox.length, 0);
  assert.deepEqual(delivered.claims[id(1)].notified, ['terminal']);
  enqueue(delivered, id(1), 'terminal', 'Already sent');
  assert.equal(delivered.outbox.length, 0);
});

test('actual executable resolves trusted Node npm and configured gh using minimal environment', t => {
  const f = fixture(t), toolDir = path.join(f.root, 'trusted-tools');
  fs.mkdirSync(toolDir);
  const ghPath = path.join(toolDir, 'gh');
  fs.writeFileSync(ghPath, '#!/bin/sh\nprintf fixture-gh\n', { mode: 0o700 });
  const probe = path.join(f.root, 'probe');
  fs.writeFileSync(probe, `#!${process.execPath}\nconst {execFileSync}=require('node:child_process');\nconsole.log(JSON.stringify({node:execFileSync('node',['--version'],{encoding:'utf8'}).trim(),npm:execFileSync('npm',['--version'],{encoding:'utf8'}).trim(),gh:execFileSync('gh',['--version'],{encoding:'utf8'}).trim(),credential:Object.keys(process.env).some(k=>k.includes('TOKEN')||k==='LINEAR_API_KEY')}));\n`, { mode: 0o700 });
  const output = execFileSync(probe, [], { cwd: f.repo, env: childEnvironment({ ...f.config, allowPublish: true, ghPath }, f.home), encoding: 'utf8' });
  const result = JSON.parse(output);
  assert.match(result.node, /^v\d+/); assert.match(result.npm, /^\d+/); assert.equal(result.gh, 'fixture-gh'); assert.equal(result.credential, false);
});

test('unsafe executable file or parent is rejected and changed OMP/gh permissions are revalidated before execution', async t => {
  const f = fixture(t);
  fs.chmodSync(f.config.ompPath, 0o722);
  assert.throws(() => loadConfig(f.configPath), /Executable/);
  let spawned = false;
  await assert.rejects(runAgent(f.config, { issueId: id(1), worktree: f.repo }, 'fixture', () => { spawned = true; }, { home: f.home }), /Executable/);
  assert.equal(spawned, false);
  fs.chmodSync(f.config.ompPath, 0o700);
  const unsafeParent = path.join(f.root, 'unsafe-bin');
  fs.mkdirSync(unsafeParent, { mode: 0o700 });
  const binary = path.join(unsafeParent, 'gh'); fs.copyFileSync(f.config.ompPath, binary); fs.chmodSync(binary, 0o700);
  fs.chmodSync(unsafeParent, 0o777); assert.throws(() => validateExecutable(binary), /Unsafe path parent/); fs.chmodSync(unsafeParent, 0o700);
  const safeLink = path.join(f.root, 'omp-link'); fs.symlinkSync(f.config.ompPath, safeLink);
  assert.equal(validateExecutable(safeLink), f.config.ompPath);
  const ghPath = validateExecutable(binary);
  privateDir(f.config.stateDir);
  const plan = preparePlan(f.config, f.config.projects[projectId], id(2)); createWorktree(f.config, plan);
  fs.chmodSync(binary, 0o722);
  assert.throws(() => verifyPublishedPR({ ...f.config, allowPublish: true, ghPath }, f.config.projects[projectId], plan, f.home), /Executable/);
});

test('user-controlled ancestor symlinks cannot redirect configuration or managed state', t => {
  const f = fixture(t), linked = path.join(f.root, 'linked-parent');
  fs.symlinkSync(f.root, linked);
  assert.throws(() => loadConfig(path.join(linked, 'config.json')), /Unsafe symlinked path parent/);
  assert.throws(() => privateDir(path.join(linked, 'redirected-state')), /Unsafe symlinked path parent/);
  assert.equal(fs.existsSync(path.join(f.root, 'redirected-state')), false);
});
