// The HTTP server: one Node http server for all four surfaces — git smart HTTP at
// /{owner}/{repo}.git, REST v3 under /api/v3, GraphQL at /api/graphql, MCP at /mcp.
// Auth: the bearer token from MAKEFUN_SHOP_TOKEN guards REST, GraphQL and MCP (a
// missing or wrong token is 401); git endpoints take the token when sent and do not
// require it. Every JSON reply carries X-GitHub-Request-Id. Malformed input never
// kills the server: a handler throw is a 500 JSON {message}.
//
// Perf notes (v2): the request line is split with string ops instead of a full
// URL parse, the query string is only parsed when one is present, GET requests
// never wait on a body stream (they carry none), and handlers can send a
// pre-stringified JSON body (the cached issue view) without re-stringifying it.
import http from 'node:http';
import { Forge } from './store.mjs';
import { RestApi } from './rest.mjs';
import { GraphQLApi } from './graphql.mjs';
import { McpApi } from './mcp.mjs';
import { advertisement, handleUploadPack, handleReceivePack } from './git-http.mjs';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp() {
  const forge = new Forge({
    token: process.env.MAKEFUN_SHOP_TOKEN ?? '',
    trialNow: process.env.MAKEFUN_TRIAL_NOW ?? '',
  });
  const rest = new RestApi(forge);
  const graphql = new GraphQLApi(forge);
  const mcp = new McpApi(forge);

  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res, forge, rest, graphql, mcp);
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, { message: err instanceof Error ? err.message : String(err) }, forge);
      } else {
        res.destroy();
      }
    }
  });
  return server;
}

function sendJson(res, status, body, forge, extraHeaders = {}) {
  const text = body === null ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': forge.requestId(),
    ...extraHeaders,
  });
  res.end(text);
}

/** Send a body that is already a JSON string (no second stringify). */
function sendJsonText(res, status, text, forge, extraHeaders = {}) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': forge.requestId(),
    ...extraHeaders,
  });
  res.end(text);
}

function sendBytes(res, status, body, contentType, forge, extraHeaders = {}) {
  res.writeHead(status, { 'content-type': contentType, ...extraHeaders });
  res.end(body);
}

function bearerToken(req) {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match ? match[1] : null;
}

function authed(forge, req) {
  if (forge.token === '') return bearerToken(req) !== null;
  return bearerToken(req) === forge.token;
}

async function handleRequest(req, res, forge, rest, graphql, mcp) {
  // Split the request line with string ops: a full URL parse is slower, and the
  // query string only needs parsing when one is present (the benchmark's reads
  // carry none). A '?' inside a path segment is percent-encoded (%3F), so the
  // first bare '?' is always the query separator.
  const rawUrl = req.url ?? '/';
  const qIndex = rawUrl.indexOf('?');
  const path = decodeURIComponentSafe(qIndex < 0 ? rawUrl : rawUrl.slice(0, qIndex));
  const query = qIndex < 0 ? {} : Object.fromEntries(new URLSearchParams(rawUrl.slice(qIndex + 1)).entries());
  const method = req.method ?? 'GET';

  // ---------------------------------------------------------------- git smart HTTP
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(path);
  if (gitMatch) {
    const owner = gitMatch[1];
    const repoName = gitMatch[2];
    const service = gitMatch[3];
    const repo = forge.getRepo(owner, repoName);
    if (service === 'info/refs' && method === 'GET') {
      if (repo === null) return sendJson(res, 404, { message: 'Not Found' }, forge);
      const wantService = query.service ?? '';
      if (wantService !== 'git-upload-pack' && wantService !== 'git-receive-pack') {
        return sendJson(res, 400, { message: 'service is required' }, forge);
      }
      const wantV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      const body = advertisement(repo, wantService, wantV2);
      const contentType = wantService === 'git-receive-pack'
        ? 'application/x-git-receive-pack-advertisement'
        : 'application/x-git-upload-pack-advertisement';
      return sendBytes(res, 200, body, contentType, forge);
    }
    if (service === 'git-upload-pack' && method === 'POST') {
      if (repo === null) return sendJson(res, 404, { message: 'Not Found' }, forge);
      const body = await readBody(req);
      const out = handleUploadPack(repo, body);
      return sendBytes(res, 200, out, 'application/x-git-upload-pack-result', forge);
    }
    if (service === 'git-receive-pack' && method === 'POST') {
      if (repo === null) return sendJson(res, 404, { message: 'Not Found' }, forge);
      const body = await readBody(req);
      const out = handleReceivePack(repo, body);
      return sendBytes(res, 200, out, 'application/x-git-receive-pack-result', forge);
    }
    return sendJson(res, 404, { message: 'Not Found' }, forge);
  }

  // ---------------------------------------------------------------- REST v3
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const isRootOrMeta = path === '/api/v3' || path === '/api/v3/' || path === '/api/v3/meta';
    if (!isRootOrMeta && !authed(forge, req)) {
      return sendJson(res, 401, { message: 'Requires authentication' }, forge);
    }
    const body = await readJsonBody(req, res, forge);
    if (body === undefined) return; // a 400 was already sent
    const ctx = makeCtx(req, res, forge, path, query, body);
    return rest.handle(ctx);
  }

  // ---------------------------------------------------------------- GraphQL
  if (path === '/api/graphql') {
    if (method !== 'POST') return sendJson(res, 404, { message: 'Not Found' }, forge);
    if (!authed(forge, req)) return sendJson(res, 401, { message: 'Requires authentication' }, forge);
    const raw = await readBody(req);
    let parsed;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      return sendJson(res, 400, { message: 'malformed JSON body' }, forge);
    }
    const result = graphql.execute(parsed);
    return sendJson(res, 200, result, forge);
  }

  // ---------------------------------------------------------------- MCP
  if (path === '/mcp') {
    if (method === 'DELETE') {
      res.writeHead(405, { 'content-type': 'application/json', 'x-github-request-id': forge.requestId() });
      return res.end(JSON.stringify({ message: 'Method Not Allowed' }));
    }
    if (method !== 'POST') return sendJson(res, 404, { message: 'Not Found' }, forge);
    if (!authed(forge, req)) return sendJson(res, 401, { message: 'Requires authentication' }, forge);
    const raw = await readBody(req);
    let parsed;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      return sendJson(res, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      }, forge);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return sendJson(res, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid Request' },
      }, forge);
    }
    const answer = mcp.handleRequest(parsed);
    if (answer.body === null) {
      res.writeHead(answer.status, { 'x-github-request-id': forge.requestId() });
      return res.end();
    }
    return sendJson(res, answer.status, answer.body, forge);
  }

  return sendJson(res, 404, { message: 'Not Found' }, forge);
}

function decodeURIComponentSafe(path) {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/**
 * Read a JSON body for REST: empty body is null; malformed JSON is a 400 (sent here).
 * GET requests never carry a body in this suite, so they skip the stream entirely.
 */
async function readJsonBody(req, res, forge) {
  if ((req.method ?? 'GET') === 'GET') return null;
  const raw = await readBody(req);
  if (raw.length === 0) return null;
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { message: 'malformed JSON body' }, forge);
    return undefined;
  }
}

function makeCtx(req, res, forge, path, query, body) {
  return {
    req,
    res,
    method: req.method ?? 'GET',
    path,
    query,
    body,
    json(status, value, extraHeaders = {}) {
      sendJson(res, status, value, forge, extraHeaders);
    },
    jsonText(status, text, extraHeaders = {}) {
      sendJsonText(res, status, text, forge, extraHeaders);
    },
    empty(status) {
      res.writeHead(status, { 'x-github-request-id': forge.requestId() });
      res.end();
    },
    error(status, message) {
      sendJson(res, status, { message }, forge);
    },
  };
}
