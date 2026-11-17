// Model Context Protocol at /mcp: the modern 2026-07-28 era (`server/discover`, no
// handshake, no session) plus the legacy 2025-11-25 era (`initialize` +
// `notifications/initialized`) for older clients. Plain JSON answers (no SSE).
// Tools: create_repo, get_repo, create_issue, list_issues, create_pull_request,
// merge_pull_request — the six github-mcp-server tools the suite needs, over the same
// store as REST and GraphQL. Auth is per request: no Authorization header is HTTP 401.
// A body that is not JSON is HTTP 400 with JSON-RPC -32700; an unknown tool is -32602.
import { globalId } from './store.mjs';

const SERVER_NAME = 'github-core-clone-forge';
const SERVER_VERSION = '1.0.0';
const MODERN_REVISION = '2026-07-28';
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function toolResult(data) {
  const text = JSON.stringify(data);
  return { content: [{ type: 'text', text }], structuredContent: data };
}

function toolError(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export class McpApi {
  constructor(forge) {
    this.forge = forge;
  }

  tools() {
    return [
      {
        name: 'create_repo',
        description: 'Create a repository owned by the authenticated user.',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'The owner login; defaults to the authenticated user.' },
            name: { type: 'string', description: 'The repository name.' },
            description: { type: 'string', description: 'A short description of the repository.' },
            private: { type: 'boolean', description: 'Whether the repository is private.' },
          },
          required: ['name'],
        },
      },
      {
        name: 'get_repo',
        description: 'Get a repository by owner and name.',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'The repository owner login.' },
            repo: { type: 'string', description: 'The repository name.' },
          },
          required: ['owner', 'repo'],
        },
      },
      {
        name: 'create_issue',
        description: 'Create an issue in a repository.',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'The repository owner login.' },
            repo: { type: 'string', description: 'The repository name.' },
            title: { type: 'string', description: 'The issue title.' },
            body: { type: 'string', description: 'The issue body.' },
          },
          required: ['owner', 'repo', 'title'],
        },
      },
      {
        name: 'list_issues',
        description: 'List issues in a repository.',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'The repository owner login.' },
            repo: { type: 'string', description: 'The repository name.' },
            state: { type: 'string', description: 'open, closed or all.', enum: ['open', 'closed', 'all'] },
          },
          required: ['owner', 'repo'],
        },
      },
      {
        name: 'create_pull_request',
        description: 'Open a pull request from a head branch into a base branch.',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'The repository owner login.' },
            repo: { type: 'string', description: 'The repository name.' },
            title: { type: 'string', description: 'The pull request title.' },
            body: { type: 'string', description: 'The pull request body.' },
            head: { type: 'string', description: 'The head branch name.' },
            base: { type: 'string', description: 'The base branch name.' },
          },
          required: ['owner', 'repo', 'title', 'head', 'base'],
        },
      },
      {
        name: 'merge_pull_request',
        description: 'Merge a pull request with a squash commit.',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'The repository owner login.' },
            repo: { type: 'string', description: 'The repository name.' },
            pull_number: { type: 'integer', description: 'The pull request number.' },
          },
          required: ['owner', 'repo', 'pull_number'],
        },
      },
    ];
  }

  toolByName(name) {
    return this.tools().find((tool) => tool.name === name) ?? null;
  }

  /** One JSON-RPC request object. Returns {status, body}. */
  handleRequest(request) {
    const id = request.id ?? null;
    const method = request.method ?? '';
    const params = request.params ?? {};
    const ok = (result) => ({ status: 200, body: { jsonrpc: '2.0', id, result } });
    const error = (code, message, status = 200) => ({ status, body: { jsonrpc: '2.0', id, error: { code, message } } });

    if (method === 'server/discover') {
      return ok({
        resultType: 'DiscoverResult',
        supportedVersions: [MODERN_REVISION],
        capabilities: { tools: {} },
        instructions: 'A GitHub-compatible git forge: repositories, issues, pull requests and git smart HTTP.',
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      });
    }
    if (method === 'initialize') {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = LEGACY_REVISIONS.includes(requested) ? requested : LEGACY_REVISIONS[0];
      return ok({
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
      return { status: 202, body: null };
    }
    if (method === 'ping') {
      return ok({});
    }
    if (method === 'tools/list') {
      return ok({ tools: this.tools() });
    }
    if (method === 'tools/call') {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = params.arguments ?? {};
      const tool = this.toolByName(name);
      if (tool === null) return error(-32602, `unknown tool ${JSON.stringify(name)}`);
      const missing = (tool.inputSchema.required ?? []).filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
      if (missing.length > 0) return error(-32602, `missing required argument(s): ${missing.join(', ')}`);
      try {
        const result = this.callTool(name, args);
        return ok(result);
      } catch (err) {
        return ok(toolError(err instanceof Error ? err.message : String(err)));
      }
    }
    return error(-32601, `method not found: ${method}`);
  }

  repoView(repo) {
    return {
      id: repo.id,
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: { login: repo.owner },
      private: repo.private,
      description: repo.description,
      default_branch: repo.defaultBranch,
      html_url: `https://github.example.invalid/${repo.owner}/${repo.name}`,
    };
  }

  callTool(name, args) {
    const forge = this.forge;
    if (name === 'create_repo') {
      const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : forge.viewer.login;
      const repo = forge.createRepo(owner, args.name, {
        isPrivate: args.private === true,
        description: typeof args.description === 'string' ? args.description : '',
      });
      if (repo === null) throw new Error(`repository ${owner}/${args.name} already exists`);
      return toolResult(this.repoView(repo));
    }
    const owner = args.owner;
    const repoName = args.repo;
    const repo = forge.getRepo(owner, repoName);
    if (name === 'get_repo') {
      if (repo === null) throw new Error(`repository ${owner}/${repoName} not found`);
      return toolResult(this.repoView(repo));
    }
    if (repo === null) throw new Error(`repository ${owner}/${repoName} not found`);
    if (name === 'create_issue') {
      const created = forge.createIssue(repo, { title: args.title, body: typeof args.body === 'string' ? args.body : '', labels: [] });
      if (created.error) throw new Error(created.error);
      const issue = created.issue;
      return toolResult({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        labels: issue.labels,
        html_url: `https://github.example.invalid/${owner}/${repoName}/issues/${issue.number}`,
      });
    }
    if (name === 'list_issues') {
      const state = typeof args.state === 'string' ? args.state : 'open';
      const { items } = forge.listIssues(repo, { state, sort: 'created', direction: 'desc', perPage: 100, page: 1 });
      const issues = items.map((issue) => ({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        labels: issue.labels.map((label) => ({ name: label })),
      }));
      return toolResult({ issues, total_count: issues.length });
    }
    if (name === 'create_pull_request') {
      const created = forge.createPull(repo, {
        title: args.title,
        body: typeof args.body === 'string' ? args.body : '',
        head: args.head,
        base: args.base,
      });
      if (created.error) throw new Error(created.error);
      const pull = created.pull;
      return toolResult({
        id: pull.id,
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        head: { ref: pull.headRef, sha: pull.headSha },
        base: { ref: pull.baseRef, sha: pull.baseSha },
      });
    }
    if (name === 'merge_pull_request') {
      const pull = forge.getPull(repo, Number(args.pull_number));
      if (pull === null) throw new Error(`pull request #${args.pull_number} not found`);
      const merged = forge.mergePull(repo, pull);
      if (merged.conflict) throw new Error('merge conflict');
      if (merged.error) throw new Error(merged.error);
      return toolResult({ number: pull.number, merged: true, sha: merged.sha, state: pull.state });
    }
    throw new Error(`unknown tool ${name}`);
  }
}
