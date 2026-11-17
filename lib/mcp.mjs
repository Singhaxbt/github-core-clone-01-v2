// MCP over Streamable HTTP (JSON-RPC 2.0, modern era 2026-07-28). Plain JSON
// replies are fine; no SSE session is created. The tool list is a module
// constant, so two tools/list calls answer byte-identical results. Auth is
// checked before anything else on every request.

const TOOLS = [
  {
    name: 'create_repo', description: 'Create a repository owned by the authenticated user.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Repository name' }, description: { type: 'string', description: 'Repository description' }, private: { type: 'boolean', description: 'Whether the repository is private' } }, required: ['name'] },
  },
  {
    name: 'get_repo', description: 'Get a repository by owner and name.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_issue', description: 'Create an issue in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string', description: 'Issue title' }, body: { type: 'string', description: 'Issue body' } }, required: ['owner', 'repo', 'title'] },
  },
  {
    name: 'list_issues', description: 'List issues in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string', description: 'open, closed or all' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_pull_request', description: 'Open a pull request from a head branch onto a base branch.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string', description: 'Pull request title' }, body: { type: 'string', description: 'Pull request body' }, head: { type: 'string', description: 'Head branch name' }, base: { type: 'string', description: 'Base branch name' } }, required: ['owner', 'repo', 'title', 'head', 'base'] },
  },
  {
    name: 'merge_pull_request', description: 'Merge an open pull request.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'integer', description: 'Pull request number' } }, required: ['owner', 'repo', 'pull_number'] },
  },
];

const SERVER_INFO = { name: 'forge-mcp', version: '1.0.0' };

function rpcResult(id, result) {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, result }), type: 'application/json' };
}

function rpcError(id, code, message) {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), type: 'application/json' };
}

function toolText(result) {
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
}

function toolFault(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

function missingArg(tool, args) {
  for (const name of tool.inputSchema.required || []) {
    const v = args ? args[name] : undefined;
    if (v === undefined || v === null || v === '') return name;
  }
  return null;
}

function callTool(forge, name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { error: { code: -32602, message: `unknown tool: ${name}` } };
  const missing = missingArg(tool, args);
  if (missing) return { result: toolFault(`missing required argument: ${missing}`) };
  const viewer = forge.viewer;
  if (name === 'create_repo') {
    const repo = forge.createRepo(viewer.login, args.name, args.description || '', !!args.private);
    if (!repo) return { result: toolFault(`repository "${args.name}" already exists`) };
    return { result: toolText(forge.repoJson(repo)) };
  }
  const repo = forge.getRepo(args.owner, args.repo);
  if (!repo) return { result: toolFault(`repository "${args.owner}/${args.repo}" not found`) };
  if (name === 'get_repo') return { result: toolText(forge.repoJson(repo)) };
  if (name === 'create_issue') {
    const made = forge.createIssue(repo, args.title, args.body || '', []);
    if (made.error) return { result: toolFault(made.error) };
    return { result: toolText(forge.issueJson(repo, made.issue)) };
  }
  if (name === 'list_issues') {
    let list = repo.issues;
    if (args.state === 'open') list = list.filter((i) => i.state === 'open');
    else if (args.state === 'closed') list = list.filter((i) => i.state === 'closed');
    const views = list.map((i) => forge.issueJson(repo, i));
    return { result: toolText(views) };
  }
  if (name === 'create_pull_request') {
    const made = forge.createPull(repo, args.title, args.body || '', args.head, args.base);
    if (made.error) return { result: toolFault(made.error) };
    return { result: toolText(forge.pullJson(repo, made.pull)) };
  }
  if (name === 'merge_pull_request') {
    const merged = forge.mergePull(repo, Number(args.pull_number), 'squash');
    if (merged.error) return { result: toolFault(merged.error === 'conflict' ? 'merge conflict' : 'pull request not found') };
    return { result: toolText(forge.pullJson(repo, merged.pull)) };
  }
  return { error: { code: -32602, message: `unknown tool: ${name}` } };
}

export function handleMcp(forge, token, req, rawBody) {
  const auth = req.headers.authorization || '';
  const ok = token && (auth === `Bearer ${token}` || auth === `token ${token}`);
  if (!ok) {
    return { status: 401, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'unauthorized' } }), type: 'application/json' };
  }
  let msg;
  try {
    msg = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }), type: 'application/json' };
  }
  // Notifications carry no id and expect no reply.
  if (msg && typeof msg === 'object' && msg.id === undefined) {
    return { status: 202, body: '', type: 'application/json' };
  }
  const id = msg && typeof msg === 'object' ? (msg.id ?? null) : null;
  const method = msg && typeof msg === 'object' ? msg.method : null;
  if (method === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: ['2026-07-28', '2025-06-18', '2025-03-26'],
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === 'initialize') {
    return rpcResult(id, { protocolVersion: '2026-07-28', capabilities: { tools: {} }, serverInfo: SERVER_INFO });
  }
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const params = msg.params || {};
    const out = callTool(forge, params.name, params.arguments || {});
    if (out.error) return rpcError(id, out.error.code, out.error.message);
    return rpcResult(id, out.result);
  }
  return rpcError(id, -32601, `method not found: ${method}`);
}
