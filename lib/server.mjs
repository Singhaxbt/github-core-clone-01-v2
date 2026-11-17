// HTTP plumbing: lean request handling, routing, auth, and the JSON discipline
// (every reply carries a non-empty X-GitHub-Request-Id; errors are JSON).
// GET requests never wait on a body stream; the query string is parsed only
// when one is present.

import http from 'node:http';
import { handleRest } from './rest.mjs';
import { executeGraphQL } from './graphql.mjs';
import { handleMcp } from './mcp.mjs';
import { infoRefs, uploadPack, receivePack } from './git-http.mjs';

const MAX_BODY = 64 * 1024 * 1024;

function send(res, forge, status, body, type, extraHeaders) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body || '', 'utf8');
  const headers = {
    'Content-Type': type || 'application/json',
    'Content-Length': buf.length,
    'X-GitHub-Request-Id': forge.nextRequestId(),
    ...(extraHeaders || {}),
  };
  res.writeHead(status, headers);
  res.end(buf);
}

function jsonError(res, forge, status, message) {
  send(res, forge, status, JSON.stringify({ message }), 'application/json');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseQuery(raw) {
  const out = {};
  if (!raw) return out;
  for (const pair of raw.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = decodeURIComponent(eq === -1 ? pair : pair.slice(0, eq));
    if (!(key in out)) out[key] = eq === -1 ? '' : decodeURIComponent(pair.slice(eq + 1));
  }
  return out;
}

export function createServer(forge, token) {
  const authed = (req) => {
    const auth = req.headers.authorization || '';
    return !!token && (auth === `Bearer ${token}` || auth === `token ${token}`);
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = req.url || '/';
      const q = url.indexOf('?');
      const rawPath = q === -1 ? url : url.slice(0, q);
      const query = q === -1 ? {} : parseQuery(url.slice(q + 1));
      const segments = rawPath.split('/').filter((s) => s !== '');

      if (req.method === 'GET' && rawPath === '/healthz') {
        send(res, forge, 200, '{"ok": true}', 'application/json');
        return;
      }

      // MCP: auth is checked inside the handler so its 401 stays JSON-RPC.
      if (rawPath === '/mcp') {
        if (req.method === 'DELETE') { send(res, forge, 405, JSON.stringify({ message: 'method not allowed' }), 'application/json'); return; }
        if (req.method !== 'POST') { jsonError(res, forge, 404, 'not found'); return; }
        const body = await readBody(req);
        const out = handleMcp(forge, token, req, body);
        send(res, forge, out.status, out.body, out.type);
        return;
      }

      // GraphQL.
      if (rawPath === '/api/graphql') {
        if (req.method !== 'POST') { jsonError(res, forge, 404, 'not found'); return; }
        if (!authed(req)) { jsonError(res, forge, 401, 'unauthorized'); return; }
        const body = await readBody(req);
        let parsed;
        try { parsed = JSON.parse(body.toString('utf8')); } catch { jsonError(res, forge, 400, 'malformed JSON'); return; }
        const result = executeGraphQL(forge, parsed);
        send(res, forge, 200, JSON.stringify(result), 'application/json');
        return;
      }

      // REST v3.
      if (segments[0] === 'api' && segments[1] === 'v3') {
        const isPublic = req.method === 'GET' && (segments.length === 2 || (segments.length === 3 && segments[2] === 'meta'));
        if (!isPublic && !authed(req)) { jsonError(res, forge, 401, 'unauthorized'); return; }
        let body = null;
        if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE') {
          const raw = await readBody(req);
          if (raw.length > 0) {
            try { body = JSON.parse(raw.toString('utf8')); } catch { jsonError(res, forge, 400, 'malformed JSON'); return; }
          }
        }
        const out = handleRest(forge, {
          method: req.method,
          segments: segments.slice(2),
          query,
          body,
          host: req.headers.host || 'localhost',
        });
        send(res, forge, out.status, out.body, out.type, out.headers || null);
        return;
      }

      // Git smart HTTP: /{owner}/{repo}.git/{info/refs|git-upload-pack|git-receive-pack}
      if (segments.length >= 3 && segments[1] && segments[1].endsWith('.git')) {
        const owner = decodeURIComponent(segments[0]);
        const repoName = decodeURIComponent(segments[1].slice(0, -4));
        const repo = owner === forge.viewer.login ? forge.getRepo(owner, repoName) : null;
        const tail = segments.slice(2).join('/');
        if (tail === 'info/refs' && req.method === 'GET') {
          const out = infoRefs(forge, repo, query.service, req);
          send(res, forge, out.status, out.body, out.type);
          return;
        }
        if (tail === 'git-upload-pack' && req.method === 'POST') {
          const body = await readBody(req);
          const out = uploadPack(forge, repo, req, body);
          send(res, forge, out.status, out.body, out.type);
          return;
        }
        if (tail === 'git-receive-pack' && req.method === 'POST') {
          const body = await readBody(req);
          const out = receivePack(forge, repo, req, body);
          send(res, forge, out.status, out.body, out.type);
          return;
        }
        jsonError(res, forge, 404, 'not found');
        return;
      }

      jsonError(res, forge, 404, 'not found');
    } catch (e) {
      console.error('handler error:', e && e.message ? e.message : e);
      try { jsonError(res, forge, 500, 'internal error'); } catch { /* socket gone */ }
    }
  });
  return server;
}
