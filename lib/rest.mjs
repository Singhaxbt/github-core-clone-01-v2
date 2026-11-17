// REST v3. Every reply is JSON (never HTML), every reply carries a non-empty
// X-GitHub-Request-Id (the server adds it), errors are {"message": string}.
// Only the token's login owns repositories: any other owner reads as 404.

import { b64Decode } from './util.mjs';

function json(status, value, extraHeaders) {
  return { status, body: JSON.stringify(value), type: 'application/json', headers: extraHeaders || null };
}

function repoOr404(forge, owner, name) {
  if (owner !== forge.viewer.login) return null;
  return forge.getRepo(owner, name);
}

function parseAuthor(line) {
  const m = /^(.*) <([^>]*)> (\d+) \+0000$/.exec(line || '');
  if (!m) return { name: '', email: '', date: '' };
  return { name: m[1], email: m[2], date: new Date(Number(m[3]) * 1000).toISOString() };
}

function commitJson(forge, repo, entry) {
  const c = entry.commit;
  const message = c.message.endsWith('\n') ? c.message.slice(0, -1) : c.message;
  return {
    sha: entry.sha, node_id: `C_${entry.sha}`,
    commit: {
      message,
      author: parseAuthor(c.author),
      committer: parseAuthor(c.committer),
    },
    author: { login: forge.viewer.login },
    committer: { login: forge.viewer.login },
    parents: c.parents.map((p) => ({ sha: p })),
    url: `/api/v3/repos/${repo.fullName}/commits/${entry.sha}`,
    html_url: `https://github.com/${repo.fullName}/commit/${entry.sha}`,
  };
}

function resolveRefParam(forge, repo, param) {
  if (!param) return `refs/heads/${repo.defaultBranch}`;
  if (param.startsWith('refs/')) return param;
  if (/^[0-9a-f]{40}$/.test(param)) return param;
  return `refs/heads/${param}`;
}

export function handleRest(forge, ctx) {
  const { method, segments: s, query, body, host } = ctx;
  const viewer = forge.viewer;

  // Root and meta are public.
  if (s.length === 0) {
    if (method === 'GET') return json(200, { current_user_url: '/api/v3/user', repository_url: '/api/v3/repos/{owner}/{repo}' }, { 'X-OAuth-Scopes': 'repo' });
    return json(404, { message: 'not found' });
  }
  if (s[0] === 'meta' && s.length === 1) {
    if (method === 'GET') return json(200, { installed_version: '1.0.0' });
    return json(404, { message: 'not found' });
  }
  if (s[0] === 'user' && s.length === 1) {
    if (method === 'GET') return json(200, { login: viewer.login, id: viewer.id, name: viewer.name, email: viewer.email, type: 'User' });
    return json(404, { message: 'not found' });
  }
  if (s[0] === 'user' && s[1] === 'repos') {
    if (method === 'POST') {
      if (!body || typeof body.name !== 'string' || !body.name) return json(422, { message: 'name is required' });
      const repo = forge.createRepo(viewer.login, body.name, body.description || '', !!body.private);
      if (!repo) return json(422, { message: `repository "${body.name}" already exists` });
      return json(201, forge.repoJson(repo));
    }
    if (method === 'GET') {
      const perPage = Math.max(1, Math.min(100, Number(query.per_page) || 30));
      const page = Math.max(1, Number(query.page) || 1);
      const all = forge.listRepos(viewer.login);
      const slice = all.slice((page - 1) * perPage, page * perPage);
      const headers = {};
      if (page * perPage < all.length) {
        headers.Link = `<http://${host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}>; rel="next"`;
      }
      return json(200, slice.map((r) => forge.repoJson(r)), headers);
    }
    return json(404, { message: 'not found' });
  }

  if (s[0] !== 'repos' || s.length < 3) return json(404, { message: 'not found' });
  const owner = s[1], name = s[2];
  const repo = repoOr404(forge, owner, name);
  if (!repo) return json(404, { message: 'repository not found' });
  const rest = s.slice(3);

  if (rest.length === 0) {
    if (method === 'GET') return json(200, forge.repoJson(repo));
    if (method === 'PATCH') {
      if (body) {
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.private = body.private;
        repo.updatedAt = forge.nowIso();
      }
      return json(200, forge.repoJson(repo));
    }
    if (method === 'DELETE') {
      forge.deleteRepo(owner, name);
      return { status: 204, body: '', type: 'application/json' };
    }
    return json(404, { message: 'not found' });
  }

  // git/refs
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      if (!body || typeof body.ref !== 'string' || typeof body.sha !== 'string') return json(422, { message: 'ref and sha are required' });
      if (forge.refOid(repo, body.ref)) return json(422, { message: 'reference already exists' });
      if (!forge.hasObject(repo, body.sha)) return json(422, { message: 'unknown sha' });
      forge.setRef(repo, body.ref, body.sha);
      return json(201, { ref: body.ref, node_id: `R_${body.ref}`, url: `/api/v3/repos/${repo.fullName}/git/refs/${body.ref}`, object: { sha: body.sha, type: 'commit', url: `/api/v3/repos/${repo.fullName}/git/commits/${body.sha}` } });
    }
    if (method === 'GET' && rest.length > 2) {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const oid = forge.refOid(repo, ref);
      if (!oid) return json(404, { message: 'reference not found' });
      return json(200, { ref, node_id: `R_${ref}`, url: `/api/v3/repos/${repo.fullName}/git/refs/${ref}`, object: { sha: oid, type: 'commit', url: `/api/v3/repos/${repo.fullName}/git/commits/${oid}` } });
    }
    return json(404, { message: 'not found' });
  }

  // branches
  if (rest[0] === 'branches') {
    if (method === 'GET' && rest.length === 1) {
      const out = forge.branchNames(repo).map((b) => ({
        name: b, commit: { sha: forge.refOid(repo, `refs/heads/${b}`), url: `/api/v3/repos/${repo.fullName}/commits/${forge.refOid(repo, `refs/heads/${b}`)}` }, protected: false,
      }));
      return json(200, out);
    }
    if (method === 'GET' && rest.length === 2) {
      const branch = decodeURIComponent(rest[1]);
      const oid = forge.refOid(repo, `refs/heads/${branch}`);
      if (!oid) return json(404, { message: 'branch not found' });
      return json(200, { name: branch, commit: { sha: oid, url: `/api/v3/repos/${repo.fullName}/commits/${oid}` }, protected: false });
    }
    return json(404, { message: 'not found' });
  }

  // commits
  if (rest[0] === 'commits') {
    if (method === 'GET' && rest.length === 1) {
      const ref = resolveRefParam(forge, repo, query.sha);
      let entries;
      if (/^[0-9a-f]{40}$/.test(ref)) {
        const c = forge.commitOf(repo, ref);
        entries = c ? [{ sha: ref, commit: c }] : [];
      } else {
        entries = forge.listCommits(repo, ref);
      }
      return json(200, entries.map((e) => commitJson(forge, repo, e)));
    }
    return json(404, { message: 'not found' });
  }

  // contents
  if (rest[0] === 'contents') {
    const path = rest.slice(1).map((p) => decodeURIComponent(p)).join('/');
    // Reads take the branch from ?ref=; writes take it from the body's branch.
    const readBranch = typeof query.ref === 'string' && query.ref ? query.ref : repo.defaultBranch;
    const bodyBranch = (body && typeof body.branch === 'string' && body.branch)
      ? body.branch.replace(/^refs\/heads\//, '')
      : repo.defaultBranch;
    if (method === 'GET') {
      const refName = resolveRefParam(forge, repo, readBranch);
      const blob = forge.blobAtPath(repo, refName, path);
      if (blob) {
        return json(200, { type: 'file', encoding: 'base64', size: blob.body.length, name: path.split('/').pop(), path, content: blob.body.toString('base64'), sha: blob.oid });
      }
      const entries = forge.dirAtPath(repo, refName, path);
      if (!entries) return json(404, { message: 'not found' });
      const out = entries.map((e) => {
        const obj = forge.getObject(repo, e.oid);
        return { type: e.dir ? 'dir' : 'file', name: e.name, path: path ? `${path}/${e.name}` : e.name, sha: e.oid, size: e.dir ? 0 : (obj ? obj.body.length : 0) };
      });
      return json(200, out);
    }
    if (method === 'PUT') {
      if (!body || typeof body.message !== 'string' || typeof body.content !== 'string') return json(400, { message: 'message and content are required' });
      const contentBuf = b64Decode(body.content);
      if (!contentBuf) return json(400, { message: 'content is not valid base64' });
      const refName = `refs/heads/${bodyBranch}`;
      const existing = forge.blobAtPath(repo, refName, path);
      if (body.sha && (!existing || existing.oid !== body.sha)) return json(409, { message: 'sha does not match the current blob' });
      const created = !existing;
      const result = forge.writeFile(repo, bodyBranch, path, contentBuf, body.message);
      return json(created ? 201 : 200, {
        content: { name: path.split('/').pop(), path, sha: result.blobOid, size: contentBuf.length, encoding: 'base64', type: 'file' },
        commit: { sha: result.commitOid, message: body.message },
      });
    }
    if (method === 'DELETE') {
      const refName = `refs/heads/${bodyBranch}`;
      const existing = forge.blobAtPath(repo, refName, path);
      if (!existing) return json(404, { message: 'not found' });
      if (body && body.sha && existing.oid !== body.sha) return json(409, { message: 'sha does not match the current blob' });
      const result = forge.deleteFile(repo, bodyBranch, path, (body && body.message) || `Delete ${path}`);
      if (!result) return json(404, { message: 'not found' });
      return json(200, { commit: { sha: result.commitOid, message: (body && body.message) || '' } });
    }
    return json(404, { message: 'not found' });
  }

  // labels
  if (rest[0] === 'labels') {
    if (method === 'POST' && rest.length === 1) {
      if (!body || typeof body.name !== 'string' || !body.name) return json(422, { message: 'name is required' });
      const label = forge.createLabel(repo, body.name, body.color);
      return json(201, { name: label.name, color: label.color });
    }
    return json(404, { message: 'not found' });
  }

  // issues
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        if (!body || typeof body.title !== 'string' || !body.title) return json(422, { message: 'title is required' });
        const result = forge.createIssue(repo, body.title, body.body || '', body.labels || []);
        if (result.error) return json(422, { message: result.error });
        return json(201, forge.issueJson(repo, result.issue));
      }
      if (method === 'GET') {
        const state = query.state || 'open';
        let list = repo.issues;
        if (state === 'open') list = list.filter((i) => i.state === 'open');
        else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
        if ((query.sort || 'created') === 'created' && (query.direction || 'asc') === 'desc') list = list.slice().reverse();
        return json(200, list.map((i) => forge.issueJson(repo, i)));
      }
      return json(404, { message: 'not found' });
    }
    const number = Number(rest[1]);
    if (!Number.isInteger(number) || number < 1) return json(404, { message: 'not found' });
    if (rest.length === 2) {
      const issue = forge.getIssue(repo, number);
      if (!issue) return json(404, { message: 'issue not found' });
      if (method === 'GET') return { status: 200, body: forge.issueView(repo, issue), type: 'application/json' };
      if (method === 'PATCH') {
        const updated = forge.patchIssue(repo, number, body || {});
        return json(200, forge.issueJson(repo, updated));
      }
      return json(404, { message: 'not found' });
    }
    if (rest[2] === 'comments') {
      const issue = forge.getIssue(repo, number);
      if (!issue) return json(404, { message: 'issue not found' });
      if (method === 'POST') {
        if (!body || typeof body.body !== 'string') return json(400, { message: 'body is required' });
        const comment = forge.addComment(repo, number, body.body);
        return json(201, forge.commentJson(repo, issue, comment));
      }
      if (method === 'GET') {
        return json(200, issue.comments.map((c) => forge.commentJson(repo, issue, c)));
      }
      return json(404, { message: 'not found' });
    }
    return json(404, { message: 'not found' });
  }

  // pulls
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        if (!body || typeof body.title !== 'string' || typeof body.head !== 'string' || typeof body.base !== 'string') {
          return json(422, { message: 'title, head and base are required' });
        }
        const result = forge.createPull(repo, body.title, body.body || '', body.head, body.base);
        if (result.error) return json(422, { message: result.error });
        return json(201, forge.pullJson(repo, result.pull));
      }
      if (method === 'GET') {
        const state = query.state || 'open';
        let list = repo.pulls;
        if (state === 'open') list = list.filter((p) => p.state === 'open');
        else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
        return json(200, list.map((p) => forge.pullJson(repo, p)));
      }
      return json(404, { message: 'not found' });
    }
    const number = Number(rest[1]);
    if (!Number.isInteger(number) || number < 1) return json(404, { message: 'not found' });
    const pull = forge.getPull(repo, number);
    if (!pull) return json(404, { message: 'pull request not found' });
    if (rest.length === 2) {
      if (method === 'GET') return json(200, forge.pullJson(repo, pull));
      return json(404, { message: 'not found' });
    }
    if (rest[2] === 'files' && rest.length === 3) {
      if (method === 'GET') return json(200, forge.pullFiles(repo, pull));
      return json(404, { message: 'not found' });
    }
    if (rest[2] === 'merge' && rest.length === 3) {
      if (method === 'PUT') {
        const result = forge.mergePull(repo, number, (body && body.merge_method) || 'merge');
        if (result.error === 'conflict') return json(405, { message: 'merge conflict' });
        if (result.error) return json(404, { message: 'pull request not found' });
        return json(200, { sha: result.sha, merged: true, message: `${pull.title} (#${pull.number})` });
      }
      return json(404, { message: 'not found' });
    }
    return json(404, { message: 'not found' });
  }

  return json(404, { message: 'not found' });
}
