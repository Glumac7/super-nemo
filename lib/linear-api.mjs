import { UUID } from './linear-config.mjs';
export class LinearAPI {
  constructor(token, fetcher = globalThis.fetch) { this.token = token; this.fetcher = fetcher; }
  async query(query, variables) {
    let response;
    try {
      response = await this.fetcher('https://api.linear.app/graphql', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: this.token }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(30000) });
    } catch { throw new Error('Linear transport failed'); }
    if (!response.ok) throw new Error(`Linear HTTP failure (${response.status})`);
    let result;
    try { result = await response.json(); } catch { throw new Error('Invalid Linear response'); }
    if (result.errors?.length || !result.data) throw new Error('Linear GraphQL failure');
    return result.data;
  }
  async identity() {
    if (!this.viewerId) {
      const data = await this.query('query Identity { viewer { id } }', {});
      if (!UUID.test(data.viewer?.id ?? '')) throw new Error('Invalid Linear viewer');
      this.viewerId = data.viewer.id;
    }
    return this.viewerId;
  }
  async pages(query, variables, select) {
    let after = null;
    const nodes = [], cursors = new Set();
    for (;;) {
      const page = select(await this.query(query, { ...variables, after }));
      if (!page || !Array.isArray(page.nodes) || !page.pageInfo || typeof page.pageInfo.hasNextPage !== 'boolean') throw new Error('Invalid Linear pagination');
      nodes.push(...page.nodes);
      if (!page.pageInfo.hasNextPage) return nodes;
      after = page.pageInfo.endCursor;
      if (typeof after !== 'string' || !after || cursors.has(after)) throw new Error('Invalid Linear cursor');
      cursors.add(after);
    }
  }
  async issues(projectId) {
    const issues = await this.pages(`query Poll($projectId: ID!, $after: String) { issues(first: 50, after: $after, filter: { project: { id: { eq: $projectId } }, labels: { name: { eq: "auto-implement" } } }) { nodes { id identifier title description url project { id } } pageInfo { hasNextPage endCursor } } }`, { projectId }, d => d.issues);
    for (const issue of issues) {
      if (!UUID.test(issue.id ?? '') || issue.project?.id?.toLowerCase() !== projectId.toLowerCase() || typeof issue.description !== 'string' && issue.description !== null || typeof issue.title !== 'string') throw new Error('Invalid Linear issue');
      issue.labels = await this.pages(`query Labels($id: String!, $after: String) { issue(id: $id) { labels(first: 50, after: $after) { nodes { name } pageInfo { hasNextPage endCursor } } } }`, { id: issue.id }, d => d.issue?.labels);
    }
    return issues.filter(issue => issue.labels.some(label => label.name === 'auto-implement'));
  }
  comments(id) {
    return this.pages(`query Comments($id: String!, $after: String) { issue(id: $id) { comments(first: 50, after: $after) { nodes { body user { id name } } pageInfo { hasNextPage endCursor } } } }`, { id }, d => d.issue?.comments);
  }
  async post(id, body) {
    const result = await this.query(`mutation Post($id: String!, $body: String!) { commentCreate(input: { issueId: $id, body: $body }) { success } }`, { id, body });
    if (result.commentCreate?.success !== true) throw new Error('Linear comment failed');
  }
}
export async function flushOutbox(config, state, api, save) {
  // Persist each acknowledgement together with queue removal. Unknown mutation
  // outcomes retain the pending item and are resolved by exact author/body lookup.
  for (const item of [...state.outbox]) {
    if (!item.sent) {
      const comments = await api.comments(item.issueId);
      const viewerId = await api.identity();
      if (!comments.some(comment => comment.user?.id === viewerId && comment.body === item.body)) await api.post(item.issueId, item.body);
    }
    const claim = state.claims[item.issueId];
    if (claim && item.event) claim.notified = [...new Set([...(claim.notified ?? []), item.event])];
    state.outbox = state.outbox.filter(pending => pending !== item);
    save(config, state);
  }
}
