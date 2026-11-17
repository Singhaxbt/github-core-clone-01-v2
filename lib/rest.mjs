// GitHub REST v3 surface under /api/v3. Every reply is application/json with a
// non-empty X-GitHub-Request-Id; errors are JSON {message}; no token is 401; the same
// repository name under another owner is 404, never 403; malformed JSON is 400.
//
// Perf notes (v2): a single issue's GET/PATCH/create replies are served from the
// cached serialized view (store.mjs issueViewJson) instead of rebuilding and
// re-stringifying the view on every read; the cache is invalidated on mutation.
import { b64decode, b64encode } from './util.mjs';
import { parseCommit, parseTree, flattenTree } from './gitobj.mjs';
import { DEFAULT_BRANCH } from './store.mjs';

const MAX_PAGE = 100;

function parseIntParam(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Build a pagination Link header (rel="next"/rel="last") for an absolute URL. */
function linkHeader(req, path, query, page, perPage, total) {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (page >= totalPages) return null;
  const host = req.headers.host ?? 'localhost';
  const proto = 'http';
  const urlFor = (p) => {
    const q = new URLSearchParams({ ...query, per_page: String(perPage), page: String(p) });
    return `${proto}://${host}${path}?${q.toString()}`;
  };
  const links = [`<${urlFor(page + 1)}>; rel="next"`, `<${urlFor(totalPages)}>; rel="last"`];
  return links.join(', ');
}

export class RestApi {
  constructor(forge) {
    this.forge = forge;
  }

  /** Route one request. `ctx` = {req, res, params, query, body, authed}. */
  handle(ctx) {
    const { method, path } = ctx;
    const seg = path.split('/').filter((s) => s !== '');
    // seg[0] === 'api', seg[1] === 'v3'
    const rest = seg.slice(2);
    if (rest.length === 0) {
      if (method === 'GET') return ctx.json(200, {}, { 'x-oauth-scopes': 'repo' });
      return ctx.error(404, 'Not Found');
    }
    if (rest[0] === 'meta' && rest.length === 1) {
      if (method === 'GET') return ctx.json(200, { installed_version: '1.0.0' });
      return ctx.error(404, 'Not Found');
    }
    if (rest[0] === 'user' && rest.length === 1) {
      if (method === 'GET') return ctx.json(200, this.forge.userView());
      return ctx.error(404, 'Not Found');
    }
    if (rest[0] === 'user' && rest[1] === 'repos') {
      if (method === 'GET') return this.listUserRepos(ctx);
      if (method === 'POST') return this.createUserRepo(ctx);
      return ctx.error(404, 'Not Found');
    }
    if (rest[0] === 'repos' && rest.length >= 3) {
      const owner = decodeURIComponent(rest[1]);
      const name = decodeURIComponent(rest[2]);
      const repo = this.forge.getRepo(owner, name);
      const tail = rest.slice(3);
      if (repo === null) return ctx.error(404, 'Not Found');
      return this.repoRoute(ctx, repo, tail);
    }
    return ctx.error(404, 'Not Found');
  }

  listUserRepos(ctx) {
    const perPage = Math.min(MAX_PAGE, parseIntParam(ctx.query.per_page, 30));
    const page = parseIntParam(ctx.query.page, 1);
    const repos = this.forge.listRepos(this.forge.viewer.login);
    const total = repos.length;
    const start = (page - 1) * perPage;
    const items = repos.slice(start, start + perPage).map((repo) => this.forge.repoView(repo));
    const headers = {};
    const link = linkHeader(ctx.req, '/api/v3/user/repos', {}, page, perPage, total);
    if (link !== null) headers.link = link;
    return ctx.json(200, items, headers);
  }

  createUserRepo(ctx) {
    const body = ctx.body ?? {};
    const name = typeof body.name === 'string' ? body.name : '';
    if (name === '') return ctx.error(422, 'name is required');
    const repo = this.forge.createRepo(this.forge.viewer.login, name, {
      isPrivate: body.private === true,
      description: typeof body.description === 'string' ? body.description : '',
    });
    if (repo === null) return ctx.error(422, 'name already exists on this account');
    return ctx.json(201, this.forge.repoView(repo));
  }

  repoRoute(ctx, repo, tail) {
    const { method } = ctx;
    if (tail.length === 0) {
      if (method === 'GET') return ctx.json(200, this.forge.repoView(repo));
      if (method === 'PATCH') {
        const body = ctx.body ?? {};
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.private = body.private;
        return ctx.json(200, this.forge.repoView(repo));
      }
      if (method === 'DELETE') {
        this.forge.deleteRepo(repo.owner, repo.name);
        return ctx.empty(204);
      }
      return ctx.error(404, 'Not Found');
    }
    const head = tail[0];
    if (head === 'branches') {
      if (tail.length === 1 && method === 'GET') {
        return ctx.json(200, this.forge.branches(repo).map((b) => ({ name: b.name, commit: { sha: b.sha } })));
      }
      if (tail.length === 2 && method === 'GET') {
        const name = decodeURIComponent(tail[1]);
        const branch = this.forge.branches(repo).find((b) => b.name === name);
        if (!branch) return ctx.error(404, 'Branch not found');
        return ctx.json(200, { name: branch.name, commit: { sha: branch.sha } });
      }
      return ctx.error(404, 'Not Found');
    }
    if (head === 'commits') {
      if (method === 'GET') {
        const commits = this.forge.listCommits(repo, ctx.query.sha);
        return ctx.json(200, commits.map(({ sha, commit }) => this.forge.commitView(sha, commit)));
      }
      return ctx.error(404, 'Not Found');
    }
    if (head === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) return this.createRef(ctx, repo);
      if (method === 'GET' && tail.length === 2) {
        return ctx.json(200, this.forge.listRefs(repo).map((r) => ({ ref: r.name, object: { sha: r.oid, type: 'commit' } })));
      }
      if (method === 'GET' && tail.length > 2) {
        const refname = tail.slice(2).map((s) => decodeURIComponent(s)).join('/');
        const oid = this.forge.refTip(repo, refname);
        if (oid === null) return ctx.error(404, 'Not Found');
        return ctx.json(200, { ref: refname, object: { sha: oid, type: 'commit' } });
      }
      return ctx.error(404, 'Not Found');
    }
    if (head === 'contents') {
      const path = tail.slice(1).map((s) => decodeURIComponent(s)).join('/');
      if (method === 'GET') return this.getContents(ctx, repo, path);
      if (method === 'PUT') return this.putContents(ctx, repo, path);
      if (method === 'DELETE') return this.deleteContents(ctx, repo, path);
      return ctx.error(404, 'Not Found');
    }
    if (head === 'labels') {
      if (method === 'GET') return ctx.json(200, [...repo.labels.values()]);
      if (method === 'POST') {
        const body = ctx.body ?? {};
        const name = typeof body.name === 'string' ? body.name : '';
        if (name === '') return ctx.error(422, 'name is required');
        const label = this.forge.createLabel(repo, name, typeof body.color === 'string' ? body.color : 'ededed');
        if (label === null) return ctx.error(422, 'already exists');
        return ctx.json(201, label);
      }
      return ctx.error(404, 'Not Found');
    }
    if (head === 'issues') {
      if (tail.length === 1) {
        if (method === 'GET') return this.listIssues(ctx, repo);
        if (method === 'POST') return this.createIssue(ctx, repo);
        return ctx.error(404, 'Not Found');
      }
      const number = Number.parseInt(tail[1], 10);
      if (!Number.isFinite(number)) return ctx.error(404, 'Not Found');
      const issue = this.forge.getIssue(repo, number);
      if (tail.length === 2) {
        if (method === 'GET') {
          if (issue === null) return ctx.error(404, 'Not Found');
          return ctx.jsonText(200, this.forge.issueViewJson(repo, issue));
        }
        if (method === 'PATCH') {
          if (issue === null) return ctx.error(404, 'Not Found');
          const body = ctx.body ?? {};
          if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) issue.state = body.state;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          this.forge.invalidateIssueView(repo, issue);
          return ctx.jsonText(200, this.forge.issueViewJson(repo, issue));
        }
        return ctx.error(404, 'Not Found');
      }
      if (tail[2] === 'comments') {
        if (issue === null) return ctx.error(404, 'Not Found');
        if (method === 'GET') return ctx.json(200, issue.comments.map((c) => ({ id: c.id, body: c.body })));
        if (method === 'POST') {
          const body = ctx.body ?? {};
          if (typeof body.body !== 'string') return ctx.error(422, 'body is required');
          const comment = this.forge.addComment(repo, issue, body.body);
          return ctx.json(201, { id: comment.id, body: comment.body });
        }
        return ctx.error(404, 'Not Found');
      }
      return ctx.error(404, 'Not Found');
    }
    if (head === 'pulls') {
      if (tail.length === 1) {
        if (method === 'GET') return this.listPulls(ctx, repo);
        if (method === 'POST') return this.createPull(ctx, repo);
        return ctx.error(404, 'Not Found');
      }
      const number = Number.parseInt(tail[1], 10);
      if (!Number.isFinite(number)) return ctx.error(404, 'Not Found');
      const pull = this.forge.getPull(repo, number);
      if (tail.length === 2) {
        if (method === 'GET') {
          if (pull === null) return ctx.error(404, 'Not Found');
          return ctx.json(200, this.forge.pullView(repo, pull));
        }
        return ctx.error(404, 'Not Found');
      }
      if (tail[2] === 'files' && method === 'GET') {
        if (pull === null) return ctx.error(404, 'Not Found');
        return ctx.json(200, this.forge.pullFiles(repo, pull));
      }
      if (tail[2] === 'merge' && method === 'PUT') {
        if (pull === null) return ctx.error(404, 'Not Found');
        const merged = this.forge.mergePull(repo, pull);
        if (merged.conflict) return ctx.error(405, 'Merge conflict');
        if (merged.error) return ctx.error(merged.code ?? 405, merged.error);
        return ctx.json(200, { merged: true, sha: merged.sha, message: merged.message });
      }
      return ctx.error(404, 'Not Found');
    }
    return ctx.error(404, 'Not Found');
  }

  createRef(ctx, repo) {
    const body = ctx.body ?? {};
    const ref = typeof body.ref === 'string' ? body.ref : '';
    const sha = typeof body.sha === 'string' ? body.sha : '';
    if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/i.test(sha)) {
      return ctx.error(422, 'ref and sha are required');
    }
    if (this.forge.refTip(repo, ref) !== null) return ctx.error(422, 'Reference already exists');
    const obj = repo.objects.get(sha.toLowerCase());
    if (!obj) return ctx.error(422, 'Object does not exist');
    this.forge.setRef(repo, ref, sha.toLowerCase());
    return ctx.json(201, { ref, object: { sha: sha.toLowerCase(), type: obj.type } });
  }

  // ---------------------------------------------------------------- contents

  getContents(ctx, repo, path) {
    const treeOid = this.forge.treeAt(repo, ctx.query.ref);
    if (treeOid === null) return ctx.error(404, 'Not Found');
    const flat = flattenTree(repo.objects, treeOid);
    if (path === '') {
      return ctx.json(200, this.directoryListing(repo, treeOid, ''));
    }
    const file = flat.get(path);
    if (file) {
      const obj = repo.objects.get(file.oid);
      return ctx.json(200, {
        type: 'file',
        encoding: 'base64',
        content: b64encode(obj.data),
        sha: file.oid,
        size: obj.data.length,
        name: path.split('/').pop(),
        path,
      });
    }
    // A directory: list its direct children.
    const prefix = `${path}/`;
    const children = new Map();
    for (const [entryPath, entry] of flat) {
      if (!entryPath.startsWith(prefix)) continue;
      const rest = entryPath.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        children.set(rest, { type: 'file', name: rest, path: entryPath, sha: entry.oid });
      } else {
        const dir = rest.slice(0, slash);
        if (!children.has(dir)) {
          // The directory's sha: the tree object that holds it.
          const dirOid = this.subtreeOid(repo, treeOid, `${path}/${dir}`);
          children.set(dir, { type: 'dir', name: dir, path: `${path}/${dir}`, sha: dirOid ?? '' });
        }
      }
    }
    if (children.size === 0) return ctx.error(404, 'Not Found');
    const list = [...children.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
    return ctx.json(200, list);
  }

  directoryListing(repo, treeOid, prefix) {
    const entries = [];
    const tree = repo.objects.get(treeOid);
    if (!tree) return entries;
    for (const entry of parseTree(tree.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      entries.push({
        type: entry.mode === '40000' ? 'dir' : 'file',
        name: entry.name,
        path,
        sha: entry.oid,
      });
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    return entries;
  }

  subtreeOid(repo, treeOid, path) {
    const segments = path.split('/').filter((s) => s !== '');
    let current = treeOid;
    for (const segment of segments) {
      const tree = repo.objects.get(current);
      if (!tree) return null;
      const entry = parseTree(tree.data).find((e) => e.name === segment);
      if (!entry || entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return current;
  }

  putContents(ctx, repo, path) {
    const body = ctx.body ?? {};
    if (typeof body.message !== 'string' || typeof body.content !== 'string') {
      return ctx.error(422, 'message and content are required');
    }
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const content = b64decode(body.content);
    const refname = `refs/heads/${branch}`;
    const tip = repo.refs.get(refname) ?? null;
    let currentSha = null;
    if (tip !== null) {
      const flat = flattenTree(repo.objects, parseCommit(repo.objects.get(tip).data).tree);
      const existing = flat.get(path);
      currentSha = existing ? existing.oid : null;
    }
    const isUpdate = currentSha !== null;
    if (typeof body.sha === 'string' && body.sha !== '') {
      if (currentSha === null) return ctx.error(422, 'sha was supplied but the file does not exist');
      if (body.sha.toLowerCase() !== currentSha.toLowerCase()) {
        return ctx.error(409, 'sha does not match the current file');
      }
    }
    const { commitOid, contentOid } = this.forge.commitFile(repo, branch, path, content, body.message);
    return ctx.json(isUpdate ? 200 : 201, {
      content: { name: path.split('/').pop(), path, sha: contentOid, size: content.length, encoding: 'base64' },
      commit: { sha: commitOid, message: body.message },
    });
  }

  deleteContents(ctx, repo, path) {
    const body = ctx.body ?? {};
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const refname = `refs/heads/${branch}`;
    const tip = repo.refs.get(refname) ?? null;
    if (tip === null) return ctx.error(404, 'Not Found');
    const flat = flattenTree(repo.objects, parseCommit(repo.objects.get(tip).data).tree);
    if (!flat.has(path)) return ctx.error(404, 'Not Found');
    const { commitOid } = this.forge.commitFile(repo, branch, path, null, typeof body.message === 'string' ? body.message : 'Delete file');
    return ctx.json(200, { commit: { sha: commitOid } });
  }

  // ---------------------------------------------------------------- issues / pulls

  listIssues(ctx, repo) {
    const perPage = Math.min(MAX_PAGE, parseIntParam(ctx.query.per_page, 30));
    const page = parseIntParam(ctx.query.page, 1);
    const state = typeof ctx.query.state === 'string' ? ctx.query.state : 'open';
    const sort = typeof ctx.query.sort === 'string' ? ctx.query.sort : 'created';
    const direction = typeof ctx.query.direction === 'string' ? ctx.query.direction : 'desc';
    const { items, total } = this.forge.listIssues(repo, { state, sort, direction, perPage, page });
    const headers = {};
    const link = linkHeader(ctx.req, `/api/v3/repos/${repo.owner}/${repo.name}/issues`, { state, sort, direction }, page, perPage, total);
    if (link !== null) headers.link = link;
    return ctx.json(200, items.map((issue) => this.forge.issueView(repo, issue)), headers);
  }

  createIssue(ctx, repo) {
    const body = ctx.body ?? {};
    if (typeof body.title !== 'string' || body.title === '') return ctx.error(422, 'title is required');
    const labels = Array.isArray(body.labels) ? body.labels.filter((l) => typeof l === 'string') : [];
    const created = this.forge.createIssue(repo, { title: body.title, body: typeof body.body === 'string' ? body.body : '', labels });
    if (created.error) return ctx.error(422, created.error);
    return ctx.jsonText(201, this.forge.issueViewJson(repo, created.issue));
  }

  listPulls(ctx, repo) {
    const perPage = Math.min(MAX_PAGE, parseIntParam(ctx.query.per_page, 30));
    const page = parseIntParam(ctx.query.page, 1);
    const state = typeof ctx.query.state === 'string' ? ctx.query.state : 'open';
    const { items, total } = this.forge.listPulls(repo, { state, perPage, page });
    const headers = {};
    const link = linkHeader(ctx.req, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`, { state }, page, perPage, total);
    if (link !== null) headers.link = link;
    return ctx.json(200, items.map((pull) => this.forge.pullView(repo, pull)), headers);
  }

  createPull(ctx, repo) {
    const body = ctx.body ?? {};
    const head = typeof body.head === 'string' ? body.head : '';
    const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
    const title = typeof body.title === 'string' ? body.title : '';
    if (head === '' || title === '') return ctx.error(422, 'head and title are required');
    const created = this.forge.createPull(repo, { title, body: typeof body.body === 'string' ? body.body : '', head, base });
    if (created.error) return ctx.error(created.code ?? 422, created.error);
    return ctx.json(201, this.forge.pullView(repo, created.pull));
  }
}
