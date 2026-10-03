import { loadConfig, readToken } from './linear-config.mjs';
import { acquire, loadState, saveState, enqueue, releaseRegistration, reserveOutbox, acknowledgeInterruption } from './linear-state.mjs';
import { LinearAPI, flushOutbox } from './linear-api.mjs';
import { verifyProfile, preparePlan, createWorktree, buildPrompt, runAgent, verifyPublishedPR, verifyResultWorktree } from './linear-runner.mjs';
export { loadConfig, releaseRegistration };
const activeStates = new Set(['claimed', 'preparing', 'launch-intent', 'running']);
function recover(config, state, lock) {
  let uncertain = false;
  for (const claim of Object.values(state.claims)) {
    if (activeStates.has(claim.status)) {
      claim.status = 'interrupted-in-doubt';
      enqueue(state, claim.issueId, 'terminal', 'Automation interrupted-in-doubt. No automatic rerun. Confirm all processes stopped before manual recovery. Verification unavailable; retained private state/logs require operator review.');
      uncertain = true;
    } else if (claim.status === 'interrupted-in-doubt') uncertain = true;
  }
  if (uncertain) { saveState(config, state); lock.retain(); }
  return uncertain;
}
async function poll(config, state, lock, api, deps) {
  if (recover(config, state, lock)) {
    await flushOutbox(config, state, api, saveState);
    throw new Error('Interrupted-in-doubt claim blocks all new executions; manual recovery required');
  }
  await flushOutbox(config, state, api, saveState);
  for (const [projectId, project] of Object.entries(config.projects)) {
    for (const issue of await api.issues(projectId)) {
      const issueId = issue.id.toLowerCase();
      if (state.claims[issueId]) continue;
      reserveOutbox(state, 2);
      const claim = state.claims[issueId] = { issueId, projectId, status: 'claimed', createdAt: new Date().toISOString() };
      saveState(config, state);
      let intent = false;
      let stage = 'context retrieval failed';
      try {
        const comments = await api.comments(issue.id);
        stage = 'Super-Nemo profile validation failed';
        verifyProfile(config, deps.home);
        stage = 'repository/origin validation failed';
        Object.assign(claim, preparePlan(config, project, issueId), { status: 'preparing' });
        stage = 'worktree plan persistence failed';
        saveState(config, state);
        stage = 'worktree creation failed';
        createWorktree(config, claim);
        stage = 'progress notification persistence failed';
        enqueue(state, issueId, 'progress', `Automation started on branch ${claim.branch}. Private execution log retained locally. No merge or deployment authorized.`);
        saveState(config, state);
        stage = 'progress notification delivery failed';
        await flushOutbox(config, state, api, saveState);
        stage = 'launch intent persistence failed';
        claim.status = 'launch-intent';
        saveState(config, state);
        intent = true;
        stage = 'agent process execution uncertain';
        const result = await runAgent(config, claim, buildPrompt(issue, comments, claim, config, project), pid => {
          claim.pid = pid; claim.status = 'running'; saveState(config, state);
        }, { home: deps.home, timeoutMs: deps.timeoutMs });
        intent = false;
        claim.logPath = result.logPath;
        stage = 'result worktree identity validation failed';
        verifyResultWorktree(claim);
        if (result.success && config.allowPublish) {
          stage = 'ready PR metadata validation failed';
          claim.pr = verifyPublishedPR(config, project, claim, deps.home);
        }
        claim.status = result.success ? 'completed' : 'failed';
        if (!result.success) claim.failure = result.timedOut ? 'agent timed out' : 'agent exited unsuccessfully';
        stage = 'terminal result persistence failed';
        claim.verification = claim.pr ? 'Ready PR repository, branch and head SHA verified. Checks reported in PR/private log require human review; they are not independently certified.' : 'Operator review required: private log contains agent verification; exit status alone does not certify correctness. No ready PR verified by this automation.';
        enqueue(state, issueId, 'terminal', `Automation ${claim.status}. ${claim.failure ? `Reason: ${claim.failure}. ` : ''}Branch: ${claim.branch}. PR: ${claim.pr?.url ?? (config.allowPublish ? 'not verified' : 'not authorized')}. ${claim.verification}`);
        saveState(config, state);
      } catch {
        claim.status = intent ? 'interrupted-in-doubt' : 'failed';
        claim.failure = stage;
        state.outbox = state.outbox.filter(item => !(item.issueId === issueId && item.event === 'terminal' && !item.sent));
        if (intent) lock.retain();
        enqueue(state, issueId, 'terminal', `Automation ${claim.status}. Reason: ${claim.failure}. No automatic execution retry. Branch: ${claim.branch ?? 'not created'}. PR: not verified. Verification unavailable; inspect retained private state/worktree/logs.`);
        saveState(config, state);
      }
      await flushOutbox(config, state, api, saveState);
      if (claim.status === 'interrupted-in-doubt') throw new Error('Execution uncertain; control plane remains locked');
    }
  }
  return state;
}
async function controlled(configPath, deps, callback) {
  const config = loadConfig(configPath);
  const lock = acquire(config, deps.controlDir);
  try {
    const state = loadState(config);
    const api = deps.api ?? new LinearAPI(readToken(config), deps.fetch);
    return await callback(config, state, lock, api);
  } finally { lock.release(); }
}
export function runOnce(configPath, deps = {}) { return controlled(configPath, deps, (config, state, lock, api) => poll(config, state, lock, api, deps)); }
export function retry(configPath, deps = {}) {
  return controlled(configPath, deps, async (config, state, lock, api) => {
    recover(config, state, lock);
    await flushOutbox(config, state, api, saveState);
    return state;
  });
}
export function status(configPath) { return loadState(loadConfig(configPath)); }
export function acknowledge(configPath, issueId, confirmed, deps = {}) {
  return acknowledgeInterruption(loadConfig(configPath), issueId, confirmed, deps.controlDir);
}
export function runDaemon(configPath, deps = {}) {
  return controlled(configPath, deps, async (config, state, lock, api) => {
    let stopped = false;
    const stop = () => { stopped = true; };
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
    try {
      while (!stopped) {
        try { await poll(config, state, lock, api, deps); } catch (error) {
          if (Object.values(state.claims).some(c => c.status === 'interrupted-in-doubt')) throw error;
          // Transport failures are retried at the next polling interval; claims remain durable.
          deps.onError?.('Polling/notification failed; durable state retained');
        }
        if (!stopped) await new Promise(resolve => {
          const finish = () => { clearTimeout(timer); process.off('SIGTERM', finish); process.off('SIGINT', finish); resolve(); };
          const timer = setTimeout(finish, config.pollSeconds * 1000);
          process.once('SIGTERM', finish); process.once('SIGINT', finish);
        });
      }
      return state;
    } finally { process.off('SIGTERM', stop); process.off('SIGINT', stop); }
  });
}
