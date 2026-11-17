// The forge's in-memory state: repositories, git objects, refs, issues, pull requests,
// labels and comments. One Forge per process; a fresh process starts empty, as the suite
// requires. All timestamps come from the trial's fixed now (MAKEFUN_TRIAL_NOW), never the
// wall clock, so two passes of a trial see identical state. Ordering uses a monotonic
// creation sequence, not a clock.
//
// Perf notes (v2): issues are indexed by number (O(1) lookup instead of an array
// scan), and a single issue's serialized REST view is cached and served verbatim —
// the benchmark reads the same issue 2,000 times, and the view is a pure function
// of the issue's state, so the cache is invalidated on every mutation (PATCH,
// close, comment). Each repo also carries a fetch-response cache (see git-http.mjs).
import {
  hashObject, buildTree, parseTree, buildCommit, parseCommit, buildTag,
  getParsedCommit,
  flattenTree, buildTreesFromPaths, collectReachable, isAncestor, mergeBase,
  diffTrees, countLines, ZERO_OID,
} from './gitobj.mjs';
import { b64encode } from './util.mjs';
import { VIEWER } from './scenario.mjs';

export const DEFAULT_BRANCH = 'main';

/** Opaque Relay-style global ids: base64url of `kind:part:part...` — never a bare number. */
export function globalId(kind, ...parts) {
  return Buffer.from([kind, ...parts].join(':'), 'utf8').toString('base64url');
}

export function parseGlobalId(id) {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const [kind, ...parts] = text.split(':');
    return { kind, parts };
  } catch {
    return { kind: '', parts: [] };
  }
}

let nextRepoDbId = 5000;
let nextIssueDbId = 1;
let nextCommentDbId = 1;

export class Forge {
  constructor(options = {}) {
    this.token = options.token ?? '';
    // The trial's fixed now: an ISO-8601 UTC instant from MAKEFUN_TRIAL_NOW, or the
    // scenario epoch when unset (local runs). All created/merged timestamps use it.
    const nowText = options.trialNow ?? '';
    const parsed = nowText !== '' ? Date.parse(nowText) : Number.NaN;
    this.nowEpoch = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 1735689600;
    this.nowIso = new Date(this.nowEpoch * 1000).toISOString().replace('.000Z', 'Z');
    this.viewer = VIEWER;
    this.repos = new Map(); // `${owner}\0${name}` -> Repo
    this.repoOrder = []; // creation order, for GET /user/repos pagination
    this.requestSeq = 0;
    this.createSeq = 0; // monotonic creation order for issues/pulls/repos
  }

  requestId() {
    this.requestSeq += 1;
    return `req-${this.requestSeq}`;
  }

  nextSeq() {
    this.createSeq += 1;
    return this.createSeq;
  }

  /** The identity REST-created commits carry: the token owner's name and email. */
  identityLine() {
    return `${this.viewer.name} <${this.viewer.email}> ${this.nowEpoch} +0000`;
  }

  userView() {
    return {
      login: this.viewer.login,
      id: this.viewer.id,
      name: this.viewer.name,
      email: this.viewer.email,
      type: 'User',
      html_url: `https://github.example.invalid/${this.viewer.login}`,
    };
  }

  // ---------------------------------------------------------------- repositories

  repoKey(owner, name) {
    return `${owner}\0${name}`;
  }

  getRepo(owner, name) {
    return this.repos.get(this.repoKey(owner, name)) ?? null;
  }

  createRepo(owner, name, { isPrivate = false, description = '' } = {}) {
    if (this.getRepo(owner, name) !== null) return null;
    const repo = {
      id: nextRepoDbId,
      owner,
      name,
      private: isPrivate,
      description,
      defaultBranch: DEFAULT_BRANCH,
      refs: new Map(), // refname -> oid
      objects: new Map(), // oid -> {type, data}
      labels: new Map(), // name -> {name, color}
      issues: [],
      pulls: [],
      issueByNumber: new Map(), // number -> issue (O(1) lookup)
      issueJson: new Map(), // number -> cached serialized issue view
      fetchCache: new Map(), // fetch-args key -> cached response Buffer (git-http.mjs)
      nextIssueNumber: 1,
      nextPullNumber: 1,
      nextCommentId: 1,
      createdSeq: this.nextSeq(),
    };
    nextRepoDbId += 1;
    this.repos.set(this.repoKey(owner, name), repo);
    this.repoOrder.push(repo);
    return repo;
  }

  deleteRepo(owner, name) {
    const repo = this.getRepo(owner, name);
    if (repo === null) return false;
    this.repos.delete(this.repoKey(owner, name));
    this.repoOrder = this.repoOrder.filter((entry) => entry !== repo);
    return true;
  }

  listRepos(owner) {
    return this.repoOrder.filter((repo) => repo.owner === owner);
  }

  repoView(repo) {
    return {
      id: repo.id,
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: { login: repo.owner, id: repo.owner === this.viewer.login ? this.viewer.id : 0, type: 'User' },
      private: repo.private,
      description: repo.description,
      default_branch: repo.defaultBranch,
      html_url: `https://github.example.invalid/${repo.owner}/${repo.name}`,
      created_at: this.nowIso,
      updated_at: this.nowIso,
      has_issues: true,
      has_pull_requests: true,
    };
  }

  // ---------------------------------------------------------------- git objects

  storeObject(repo, type, data) {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo, oid) {
    return repo.objects.get(oid) ?? null;
  }

  /** Resolve a ref-ish to a commit oid: branch name, full ref, or a 40-hex oid. */
  resolveRef(repo, ref) {
    if (ref === undefined || ref === null || ref === '') return this.refTip(repo, `refs/heads/${repo.defaultBranch}`);
    if (/^[0-9a-f]{40}$/i.test(ref)) {
      const obj = repo.objects.get(ref.toLowerCase());
      if (obj && obj.type === 'commit') return ref.toLowerCase();
      if (obj && obj.type === 'tag') return parseTagObj(obj.data).object;
      return null;
    }
    if (ref.startsWith('refs/')) return this.refTip(repo, ref);
    const branch = this.refTip(repo, `refs/heads/${ref}`);
    if (branch !== null) return branch;
    return this.refTip(repo, `refs/tags/${ref}`);
  }

  refTip(repo, refname) {
    return repo.refs.get(refname) ?? null;
  }

  setRef(repo, refname, oid) {
    repo.refs.set(refname, oid);
  }

  deleteRef(repo, refname) {
    return repo.refs.delete(refname);
  }

  /** All refs, sorted: heads first, then tags, each by name. */
  listRefs(repo) {
    const refs = [];
    for (const [name, oid] of repo.refs) refs.push({ name, oid });
    refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return refs;
  }

  branches(repo) {
    const out = [];
    for (const [name, oid] of repo.refs) {
      if (name.startsWith('refs/heads/')) out.push({ name: name.slice('refs/heads/'.length), sha: oid });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : 1));
    return out;
  }

  /** Commits reachable from `ref`, newest first (parents walked depth-first). */
  listCommits(repo, ref) {
    const tip = this.resolveRef(repo, ref);
    if (tip === null) return [];
    const out = [];
    const seen = new Set();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop();
      if (oid === ZERO_OID || seen.has(oid)) continue;
      seen.add(oid);
      const commit = getParsedCommit(repo.objects, oid);
      if (!commit) continue;
      out.push({ sha: oid, commit });
      for (const parent of commit.parents) stack.push(parent);
    }
    return out;
  }

  commitView(sha, commit) {
    // The object stores the message with git's trailing newline; the REST view
    // presents it without, as GitHub does (checks compare it exactly).
    const message = commit.message.endsWith('\n') ? commit.message.slice(0, -1) : commit.message;
    return {
      sha,
      commit: {
        message,
        author: { name: this.viewer.name, email: this.viewer.email, date: this.nowIso },
        committer: { name: this.viewer.name, email: this.viewer.email, date: this.nowIso },
        tree: { sha: commit.tree },
      },
      parents: commit.parents.map((parent) => ({ sha: parent })),
    };
  }

  /**
   * Commit one file change on a branch: `content` null deletes the path. Creates the
   * branch (from the default branch tip, or unborn) when it does not exist yet.
   * Returns {commitOid, contentOid} — the new commit and the new blob (null on delete).
   */
  commitFile(repo, branch, path, content, message) {
    const refname = `refs/heads/${branch}`;
    const tip = repo.refs.get(refname) ?? null;
    let flat;
    if (tip === null) {
      flat = new Map();
    } else {
      const commit = parseCommit(repo.objects.get(tip).data);
      flat = flattenTree(repo.objects, commit.tree);
    }
    let contentOid = null;
    if (content === null) {
      flat.delete(path);
    } else {
      const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
      contentOid = this.storeObject(repo, 'blob', data);
      flat.set(path, { oid: contentOid, mode: '100644' });
    }
    const { rootOid, created } = buildTreesFromPaths(repo.objects, flat);
    for (const [oid, obj] of created) repo.objects.set(oid, obj);
    const { oid: commitOid, data } = buildCommit({
      tree: rootOid,
      parents: tip === null ? [] : [tip],
      author: this.identityLine(),
      committer: this.identityLine(),
      message,
    });
    repo.objects.set(commitOid, { type: 'commit', data });
    repo.refs.set(refname, commitOid);
    return { commitOid, contentOid };
  }

  /** The tree oid at a ref, or null. */
  treeAt(repo, ref) {
    const tip = this.resolveRef(repo, ref);
    if (tip === null) return null;
    const commit = getParsedCommit(repo.objects, tip);
    return commit === null ? null : commit.tree;
  }

  // ---------------------------------------------------------------- labels

  createLabel(repo, name, color = 'ededed') {
    if (repo.labels.has(name)) return null;
    const label = { name, color };
    repo.labels.set(name, label);
    return label;
  }

  // ---------------------------------------------------------------- issues

  issueView(repo, issue) {
    return {
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((name) => {
        const label = repo.labels.get(name);
        return label ? { name: label.name, color: label.color } : { name };
      }),
      user: { login: this.viewer.login, id: this.viewer.id, type: 'User' },
      created_at: this.nowIso,
      updated_at: this.nowIso,
      comments: issue.comments.length,
    };
  }

  /**
   * The serialized issue view, cached per issue. The view is a pure function of the
   * issue's state (plus the repo's labels and the trial's fixed now), so the cache
   * is only valid until the issue mutates — every mutation path invalidates it
   * (see invalidateIssueView). REST GET single issue serves this string verbatim.
   */
  issueViewJson(repo, issue) {
    const cached = repo.issueJson.get(issue.number);
    if (cached !== undefined) return cached;
    const text = JSON.stringify(this.issueView(repo, issue));
    repo.issueJson.set(issue.number, text);
    return text;
  }

  /** Drop one issue's cached view after a mutation (PATCH, close, comment). */
  invalidateIssueView(repo, issue) {
    repo.issueJson.delete(issue.number);
  }

  createIssue(repo, { title, body = '', labels = [] }) {
    for (const name of labels) {
      if (!repo.labels.has(name)) return { error: `Label does not exist: ${name}` };
    }
    const issue = {
      id: nextIssueDbId,
      number: repo.nextIssueNumber,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdSeq: this.nextSeq(),
    };
    nextIssueDbId += 1;
    repo.nextIssueNumber += 1;
    repo.issues.push(issue);
    repo.issueByNumber.set(issue.number, issue);
    return { issue };
  }

  getIssue(repo, number) {
    return repo.issueByNumber.get(number) ?? null;
  }

  listIssues(repo, { state = 'open', sort = 'created', direction = 'desc', perPage = 30, page = 1 } = {}) {
    let list = [...repo.issues];
    if (state !== 'all') list = list.filter((issue) => issue.state === state);
    const dir = direction === 'asc' ? 1 : -1;
    if (sort === 'created') list.sort((a, b) => dir * (a.createdSeq - b.createdSeq));
    const start = (page - 1) * perPage;
    return { items: list.slice(start, start + perPage), total: list.length };
  }

  addComment(repo, issue, body) {
    const comment = { id: repo.nextCommentId, body, createdSeq: this.nextSeq() };
    repo.nextCommentId += 1;
    issue.comments.push(comment);
    this.invalidateIssueView(repo, issue); // the comments count in the view changed
    return comment;
  }

  // ---------------------------------------------------------------- pull requests

  pullView(repo, pull) {
    return {
      id: pull.id,
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      merged: pull.merged,
      merged_at: pull.mergedAt,
      merge_commit_sha: pull.mergeCommitSha,
      head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
      base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
      user: { login: this.viewer.login, id: this.viewer.id, type: 'User' },
      created_at: this.nowIso,
      updated_at: this.nowIso,
    };
  }

  createPull(repo, { title, body = '', head, base }) {
    const headSha = this.refTip(repo, `refs/heads/${head}`);
    const baseSha = this.refTip(repo, `refs/heads/${base}`);
    if (headSha === null || baseSha === null) return { error: 'head or base branch does not exist' };
    const existing = repo.pulls.find(
      (pull) => pull.headRef === head && pull.baseRef === base && pull.state === 'open',
    );
    if (existing) return { error: 'a pull request from this head branch is already open', code: 422 };
    const pull = {
      id: nextIssueDbId,
      number: repo.nextPullNumber,
      title,
      body,
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdSeq: this.nextSeq(),
    };
    nextIssueDbId += 1;
    repo.nextPullNumber += 1;
    repo.pulls.push(pull);
    return { pull };
  }

  getPull(repo, number) {
    return repo.pulls.find((pull) => pull.number === number) ?? null;
  }

  listPulls(repo, { state = 'open', perPage = 30, page = 1 } = {}) {
    let list = [...repo.pulls];
    if (state !== 'all') list = list.filter((pull) => pull.state === state);
    list.sort((a, b) => b.createdSeq - a.createdSeq);
    const start = (page - 1) * perPage;
    return { items: list.slice(start, start + perPage), total: list.length };
  }

  /** The merge base of a pull request (best common ancestor of head and base tips). */
  pullMergeBase(repo, pull) {
    const headSha = this.refTip(repo, `refs/heads/${pull.headRef}`) ?? pull.headSha;
    const baseSha = this.refTip(repo, `refs/heads/${pull.baseRef}`) ?? pull.baseSha;
    return mergeBase(repo.objects, headSha, baseSha);
  }

  /** 'MERGEABLE' or 'CONFLICTING': a path changed on both sides of the merge base. */
  pullMergeable(repo, pull) {
    const base = this.pullMergeBase(repo, pull);
    if (base === null) return 'CONFLICTING';
    const headSha = this.refTip(repo, `refs/heads/${pull.headRef}`) ?? pull.headSha;
    const baseSha = this.refTip(repo, `refs/heads/${pull.baseRef}`) ?? pull.baseSha;
    if (headSha === baseSha) return 'MERGEABLE';
    const baseTree = this.treeOfCommit(repo, base);
    const headTree = this.treeOfCommit(repo, headSha);
    const baseTipTree = this.treeOfCommit(repo, baseSha);
    const headDiff = new Map(diffTrees(repo.objects, baseTree, headTree).map((d) => [d.path, d]));
    const baseDiff = new Map(diffTrees(repo.objects, baseTree, baseTipTree).map((d) => [d.path, d]));
    for (const [path, headChange] of headDiff) {
      const baseChange = baseDiff.get(path);
      if (!baseChange) continue;
      if (headChange.newOid !== baseChange.newOid) return 'CONFLICTING';
    }
    return 'MERGEABLE';
  }

  treeOfCommit(repo, oid) {
    const commit = getParsedCommit(repo.objects, oid);
    return commit === null ? null : commit.tree;
  }

  /** Files changed by a pull request: diff of merge base vs head tip. */
  pullFiles(repo, pull) {
    const base = this.pullMergeBase(repo, pull);
    const headSha = this.refTip(repo, `refs/heads/${pull.headRef}`) ?? pull.headSha;
    const baseTree = base === null ? null : this.treeOfCommit(repo, base);
    const headTree = this.treeOfCommit(repo, headSha);
    const out = [];
    for (const change of diffTrees(repo.objects, baseTree, headTree)) {
      const status = change.status === 'removed' ? 'removed' : change.status === 'added' ? 'added' : 'modified';
      let additions = 0;
      let deletions = 0;
      if (change.newOid !== null) {
        const obj = repo.objects.get(change.newOid);
        if (obj) additions = countLines(obj.data);
      }
      if (change.oldOid !== null) {
        const obj = repo.objects.get(change.oldOid);
        if (obj) deletions = countLines(obj.data);
      }
      if (change.status === 'added') deletions = 0;
      if (change.status === 'removed') additions = 0;
      out.push({
        filename: change.path,
        status,
        additions,
        deletions,
        changes: additions + deletions,
        sha: change.newOid ?? change.oldOid,
      });
    }
    return out;
  }

  /**
   * Squash-merge a pull request onto its base branch. Returns {pull, sha} on success,
   * {conflict: true} when the merge base diverged on a path, or {notFound: true}.
   */
  mergePull(repo, pull) {
    if (pull.state !== 'open') return { error: 'pull request is not open', code: 405 };
    if (this.pullMergeable(repo, pull) === 'CONFLICTING') return { conflict: true };
    const base = this.pullMergeBase(repo, pull);
    const headSha = this.refTip(repo, `refs/heads/${pull.headRef}`) ?? pull.headSha;
    const baseSha = this.refTip(repo, `refs/heads/${pull.baseRef}`) ?? pull.baseSha;
    const baseTree = base === null ? null : this.treeOfCommit(repo, base);
    const headTree = this.treeOfCommit(repo, headSha);
    // The merged tree: the base tip's tree with the head's changes over the merge base.
    const baseTipFlat = baseSha === null ? new Map() : flattenTree(repo.objects, this.treeOfCommit(repo, baseSha));
    for (const change of diffTrees(repo.objects, baseTree, headTree)) {
      if (change.status === 'removed') baseTipFlat.delete(change.path);
      else baseTipFlat.set(change.path, { oid: change.newOid, mode: '100644' });
    }
    const { rootOid, created } = buildTreesFromPaths(repo.objects, baseTipFlat);
    for (const [oid, obj] of created) repo.objects.set(oid, obj);
    const message = `${pull.title} (#${pull.number})`;
    const { oid: mergeSha, data } = buildCommit({
      tree: rootOid,
      parents: baseSha === null ? [] : [baseSha],
      author: this.identityLine(),
      committer: this.identityLine(),
      message,
    });
    repo.objects.set(mergeSha, { type: 'commit', data });
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.nowIso;
    pull.mergeCommitSha = mergeSha;
    pull.baseSha = mergeSha;
    return { pull, sha: mergeSha, message };
  }
}

function parseTagObj(data) {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  let object = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
  }
  return { object };
}
