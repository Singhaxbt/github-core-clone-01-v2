// The in-memory forge: repositories, git objects, refs, issues, pull requests and
// the caches that make the benchmark workloads fast. Every mutation goes through
// putObject/setRef/deleteRef, which bump the repo revision and so invalidate the
// whole-fetch-response cache. Timestamps come only from the trial clock.

import { createHash } from 'node:crypto';
import { buildScenario, SCENARIO_EPOCH_SEC } from './scenario.mjs';
import {
  hashObject, buildTreeBlob, buildCommitBlob, buildTagBlob,
  encodeTree, decodeTree, parseCommit, parseTag,
  TYPE_COMMIT, TYPE_TREE, TYPE_BLOB, TYPE_TAG,
} from './gitobj.mjs';
import { b64urlEncode, lineDiff, ZERO_OID } from './util.mjs';

const FIXTURE_EPOCH = 1735689600;

export class Forge {
  constructor(opts) {
    this.trialNowSec = opts.trialNowSec || SCENARIO_EPOCH_SEC;
    this.scenario = buildScenario();
    this.viewer = this.scenario.viewer;
    this.repos = new Map();
    this.globalId = 1;
    this.requestSeq = 1;
  }

  nowSec() { return this.trialNowSec; }

  nowIso() { return new Date(this.trialNowSec * 1000).toISOString(); }

  nextId() { return this.globalId++; }

  nextRequestId() {
    const n = this.requestSeq++;
    return `req_${n.toString(16).padStart(12, '0')}`;
  }

  identity() { return `${this.viewer.login} <${this.viewer.email}>`; }

  // ---- repositories ----

  repoKey(owner, name) { return `${owner}/${name}`; }

  createRepo(owner, name, description, isPrivate) {
    const key = this.repoKey(owner, name);
    if (this.repos.has(key)) return null;
    const repo = {
      id: this.nextId(), owner, name, fullName: key,
      description: description || '', private: !!isPrivate, defaultBranch: 'main',
      createdAt: this.nowIso(), updatedAt: this.nowIso(),
      refs: new Map(), objects: new Map(),
      parsedCommits: new Map(), parsedTrees: new Map(),
      labels: new Map(),
      issues: [], issuesByNumber: new Map(),
      pulls: [], pullsByNumber: new Map(),
      issueSeq: 0, pullSeq: 0, commentSeq: 0,
      issueViews: new Map(), fetchCache: new Map(), rev: 0,
    };
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner, name) { return this.repos.get(this.repoKey(owner, name)) || null; }

  listRepos(owner) {
    const out = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    return out;
  }

  deleteRepo(owner, name) { return this.repos.delete(this.repoKey(owner, name)); }

  bumpRev(repo) { repo.rev++; }

  // ---- git objects ----

  putObject(repo, typeId, body) {
    const oid = hashObject(typeId, body);
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type: typeId, body });
      this.bumpRev(repo);
    }
    return oid;
  }

  getObject(repo, oid) { return repo.objects.get(oid) || null; }

  hasObject(repo, oid) { return repo.objects.has(oid); }

  commitOf(repo, oid) {
    let parsed = repo.parsedCommits.get(oid);
    if (parsed) return parsed;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== TYPE_COMMIT) return null;
    parsed = parseCommit(obj.body);
    repo.parsedCommits.set(oid, parsed);
    return parsed;
  }

  treeOf(repo, oid) {
    let entries = repo.parsedTrees.get(oid);
    if (entries) return entries;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== TYPE_TREE) return null;
    entries = decodeTree(obj.body);
    repo.parsedTrees.set(oid, entries);
    return entries;
  }

  peelCommit(repo, oid) {
    let cur = oid, guard = 0;
    while (cur && guard++ < 16) {
      const obj = repo.objects.get(cur);
      if (!obj) return null;
      if (obj.type === TYPE_COMMIT) return cur;
      if (obj.type === TYPE_TAG) { cur = parseTag(obj.body).object; continue; }
      return null;
    }
    return null;
  }

  isAncestor(repo, ancOid, descOid) {
    const anc = this.peelCommit(repo, ancOid);
    let cur = this.peelCommit(repo, descOid);
    if (!anc || !cur) return false;
    if (anc === cur) return true;
    const seen = new Set([cur]);
    const stack = [cur];
    while (stack.length) {
      const oid = stack.pop();
      const c = this.commitOf(repo, oid);
      if (!c) continue;
      for (const p of c.parents) {
        if (p === anc) return true;
        if (!seen.has(p)) { seen.add(p); stack.push(p); }
      }
    }
    return false;
  }

  // All commit ancestors of `oids` (tags peeled), unlimited depth.
  ancestorClosure(repo, oids) {
    const out = new Set();
    const stack = [];
    for (const oid of oids) {
      const c = this.peelCommit(repo, oid);
      if (c && !out.has(c)) { out.add(c); stack.push(c); }
    }
    while (stack.length) {
      const oid = stack.pop();
      const commit = this.commitOf(repo, oid);
      if (!commit) continue;
      for (const p of commit.parents) {
        if (!out.has(p)) { out.add(p); stack.push(p); }
      }
    }
    return out;
  }

  // The exact object set a fetch must send: reachable(wants) minus
  // reachable(haves), honouring depth. A shallow have is held by the client
  // without its parents, so the walk descends through it; a plain have is
  // held with its whole history, so its ancestors are never re-sent — and
  // neither are any tree or blob the client already holds.
  fetchSet(repo, wants, haves, shallowHaves, deepen) {
    const shallowSet = new Set();
    for (const o of shallowHaves) {
      shallowSet.add(o);
      const peeled = this.peelCommit(repo, o);
      if (peeled) shallowSet.add(peeled);
    }
    const haveCommits = new Set();
    const haveObjects = new Set();
    const addHaveTree = (treeOid) => {
      if (!treeOid || haveObjects.has(treeOid)) return;
      const obj = repo.objects.get(treeOid);
      if (!obj) return;
      haveObjects.add(treeOid);
      const entries = this.treeOf(repo, treeOid) || [];
      for (const e of entries) {
        if (e.mode === '160000') continue;
        if (e.dir) addHaveTree(e.oid);
        else haveObjects.add(e.oid);
      }
    };
    const addHaveClosure = (commitOid) => {
      const stack = [commitOid];
      const seen = new Set();
      while (stack.length) {
        const oid = stack.pop();
        if (seen.has(oid)) continue;
        seen.add(oid);
        haveCommits.add(oid);
        haveObjects.add(oid);
        const c = this.commitOf(repo, oid);
        if (!c) continue;
        addHaveTree(c.tree);
        for (const p of c.parents) stack.push(p);
      }
    };
    for (const have of haves) {
      const commitOid = this.peelCommit(repo, have);
      if (!commitOid) continue;
      haveObjects.add(have);
      if (shallowSet.has(have) || shallowSet.has(commitOid)) {
        haveCommits.add(commitOid);
        haveObjects.add(commitOid);
        const c = this.commitOf(repo, commitOid);
        if (c) addHaveTree(c.tree);
      } else {
        addHaveClosure(commitOid);
      }
    }
    const sent = new Map();
    const sentCommits = new Set();
    const shallow = [];
    const unshallow = [];
    const queue = [];
    for (const want of wants) {
      const obj = repo.objects.get(want);
      if (!obj) continue;
      if (obj.type === TYPE_TAG) {
        if (!haveObjects.has(want)) sent.set(want, obj);
        const target = this.peelCommit(repo, want);
        if (target) queue.push({ oid: target, depth: 1 });
      } else if (obj.type === TYPE_COMMIT) {
        queue.push({ oid: want, depth: 1 });
      }
    }
    const seenDepth = new Map();
    while (queue.length) {
      const { oid, depth } = queue.shift();
      const prev = seenDepth.get(oid);
      if (prev !== undefined && prev <= depth) continue;
      seenDepth.set(oid, depth);
      const inHave = haveCommits.has(oid);
      if (!inHave && (deepen === 0 || depth <= deepen)) {
        if (!sentCommits.has(oid)) {
          sentCommits.add(oid);
          const obj = repo.objects.get(oid);
          if (obj) sent.set(oid, obj);
        }
      }
      // A plain have's ancestors are all held: nothing beyond it is sendable.
      // A shallow have's parents are not held: the walk must descend through it.
      if (inHave && !shallowSet.has(oid)) continue;
      if (deepen > 0 && depth >= deepen) continue;
      const commit = this.commitOf(repo, oid);
      if (commit) for (const p of commit.parents) queue.push({ oid: p, depth: depth + 1 });
    }
    // Trees and blobs for every sent commit, skipping objects the client holds.
    const addTree = (treeOid) => {
      if (!treeOid || sent.has(treeOid) || haveObjects.has(treeOid)) return;
      const obj = repo.objects.get(treeOid);
      if (!obj) return;
      sent.set(treeOid, obj);
      const entries = this.treeOf(repo, treeOid) || [];
      for (const e of entries) {
        if (e.mode === '160000') continue;
        if (haveObjects.has(e.oid)) continue;
        const child = repo.objects.get(e.oid);
        if (!child) continue;
        if (e.dir) addTree(e.oid);
        else sent.set(e.oid, child);
      }
    };
    for (const oid of [...sentCommits]) {
      const commit = this.commitOf(repo, oid);
      if (commit) addTree(commit.tree);
    }
    // Boundary lists.
    for (const oid of sentCommits) {
      const commit = this.commitOf(repo, oid);
      if (!commit || commit.parents.length === 0) continue;
      if (commit.parents.some((p) => !sentCommits.has(p))) shallow.push(oid);
    }
    for (const oid of shallowHaves) {
      const commitOid = this.peelCommit(repo, oid);
      if (!commitOid) continue;
      const commit = this.commitOf(repo, commitOid);
      if (!commit || commit.parents.length === 0) continue;
      if (commit.parents.every((p) => sentCommits.has(p))) unshallow.push(oid);
    }
    return { objects: sent, shallow, unshallow };
  }

  // ---- refs ----

  refOid(repo, ref) { return repo.refs.get(ref) || null; }

  setRef(repo, ref, oid) { repo.refs.set(ref, oid); this.bumpRev(repo); }

  deleteRef(repo, ref) { const ok = repo.refs.delete(ref); if (ok) this.bumpRev(repo); return ok; }

  branchNames(repo) {
    const out = [];
    for (const ref of repo.refs.keys()) if (ref.startsWith('refs/heads/')) out.push(ref.slice('refs/heads/'.length));
    return out.sort();
  }

  defaultTip(repo) { return repo.refs.get(`refs/heads/${repo.defaultBranch}`) || null; }

  // ---- trees / paths ----

  flattenTree(repo, treeOid, prefix, out) {
    const entries = this.treeOf(repo, treeOid);
    if (!entries) return;
    for (const e of entries) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.dir) this.flattenTree(repo, e.oid, path, out);
      else out.set(path, { oid: e.oid, mode: e.mode });
    }
  }

  treeAtRef(repo, refName) {
    const tip = this.refOid(repo, refName);
    if (!tip) return null;
    const commitOid = this.peelCommit(repo, tip);
    if (!commitOid) return null;
    const commit = this.commitOf(repo, commitOid);
    return commit ? commit.tree : null;
  }

  blobAtPath(repo, refName, path) {
    const treeOid = this.treeAtRef(repo, refName);
    if (!treeOid) return null;
    const parts = path.split('/').filter((p) => p !== '');
    let cur = treeOid;
    for (let i = 0; i < parts.length; i++) {
      const entries = this.treeOf(repo, cur);
      if (!entries) return null;
      const hit = entries.find((e) => e.name === parts[i]);
      if (!hit) return null;
      if (i === parts.length - 1) {
        if (hit.dir) return null;
        const obj = repo.objects.get(hit.oid);
        return obj ? { oid: hit.oid, body: obj.body, mode: hit.mode } : null;
      }
      if (!hit.dir) return null;
      cur = hit.oid;
    }
    return null;
  }

  dirAtPath(repo, refName, path) {
    let treeOid = this.treeAtRef(repo, refName);
    if (!treeOid) return null;
    if (!path) return this.treeOf(repo, treeOid);
    const parts = path.split('/').filter((p) => p !== '');
    let cur = treeOid;
    for (const part of parts) {
      const entries = this.treeOf(repo, cur);
      if (!entries) return null;
      const hit = entries.find((e) => e.name === part && e.dir);
      if (!hit) return null;
      cur = hit.oid;
    }
    return this.treeOf(repo, cur);
  }

  // Rebuild a nested tree from a flat path map; returns the root tree oid.
  buildTreeFromFlat(repo, flat) {
    const build = (prefix) => {
      const entries = [];
      const seenDirs = new Set();
      for (const [path, entry] of flat) {
        if (prefix && !path.startsWith(`${prefix}/`)) continue;
        const rest = prefix ? path.slice(prefix.length + 1) : path;
        const slash = rest.indexOf('/');
        if (slash === -1) entries.push({ mode: entry.mode, name: rest, oid: entry.oid, dir: false });
        else {
          const dir = rest.slice(0, slash);
          if (!seenDirs.has(dir)) { seenDirs.add(dir); entries.push({ mode: '40000', name: dir, oid: build(prefix ? `${prefix}/${dir}` : dir), dir: true }); }
        }
      }
      return this.putObject(repo, TYPE_TREE, buildTreeBlob(entries));
    };
    return build('');
  }

  writeFile(repo, branch, path, contentBuf, message) {
    const ref = `refs/heads/${branch}`;
    let tip = this.refOid(repo, ref);
    let createdBranch = false;
    if (!tip && branch !== repo.defaultBranch) {
      const base = this.defaultTip(repo);
      if (base) { this.setRef(repo, ref, base); tip = base; createdBranch = true; }
    }
    const flat = new Map();
    if (tip) {
      const commitOid = this.peelCommit(repo, tip);
      const commit = commitOid ? this.commitOf(repo, commitOid) : null;
      if (commit) this.flattenTree(repo, commit.tree, '', flat);
    }
    const blobOid = this.putObject(repo, TYPE_BLOB, contentBuf);
    flat.set(path, { oid: blobOid, mode: '100644' });
    const treeOid = this.buildTreeFromFlat(repo, flat);
    const parents = tip ? [this.peelCommit(repo, tip)] : [];
    const commitOid = this.putObject(repo, TYPE_COMMIT, buildCommitBlob(treeOid, parents.filter(Boolean), this.identity(), this.identity(), this.nowSec(), `${message}\n`));
    this.setRef(repo, ref, commitOid);
    return { commitOid, blobOid, createdBranch };
  }

  deleteFile(repo, branch, path, message) {
    const ref = `refs/heads/${branch}`;
    const tip = this.refOid(repo, ref);
    if (!tip) return null;
    const commitOid = this.peelCommit(repo, tip);
    const commit = commitOid ? this.commitOf(repo, commitOid) : null;
    if (!commit) return null;
    const flat = new Map();
    this.flattenTree(repo, commit.tree, '', flat);
    if (!flat.has(path)) return null;
    flat.delete(path);
    const treeOid = this.buildTreeFromFlat(repo, flat);
    const next = this.putObject(repo, TYPE_COMMIT, buildCommitBlob(treeOid, [commitOid], this.identity(), this.identity(), this.nowSec(), `${message}\n`));
    this.setRef(repo, ref, next);
    return { commitOid: next };
  }

  listCommits(repo, refName, limit) {
    const tip = this.refOid(repo, refName);
    if (!tip) return [];
    const start = this.peelCommit(repo, tip);
    if (!start) return [];
    const out = [];
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length) {
      const oid = queue.shift();
      const commit = this.commitOf(repo, oid);
      if (!commit) continue;
      out.push({ sha: oid, commit });
      for (const p of commit.parents) if (!seen.has(p)) { seen.add(p); queue.push(p); }
      if (limit && out.length >= limit) break;
    }
    // Newest-first by commit timestamp, then by walk order.
    out.sort((a, b) => (b.commit.ts - a.commit.ts) || 0);
    return out;
  }

  // ---- labels / issues ----

  createLabel(repo, name, color) {
    const label = { name, color: color || 'ededed' };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo, title, body, labelNames) {
    const labels = [];
    for (const name of labelNames || []) {
      const label = repo.labels.get(name);
      if (!label) return { error: `label "${name}" does not exist` };
      labels.push({ name: label.name });
    }
    const number = ++repo.issueSeq;
    const issue = {
      id: this.nextId(), number, title, body: body || '', state: 'open', labels,
      user: { login: this.viewer.login }, createdAt: this.nowIso(), updatedAt: this.nowIso(),
      comments: [],
    };
    repo.issues.push(issue);
    repo.issuesByNumber.set(number, issue);
    return { issue };
  }

  getIssue(repo, number) { return repo.issuesByNumber.get(number) || null; }

  issueView(repo, issue) {
    const cached = repo.issueViews.get(issue.number);
    if (cached) return cached;
    const view = JSON.stringify(this.issueJson(repo, issue));
    repo.issueViews.set(issue.number, view);
    return view;
  }

  invalidateIssue(repo, number) { repo.issueViews.delete(number); }

  patchIssue(repo, number, fields) {
    const issue = this.getIssue(repo, number);
    if (!issue) return null;
    if (fields.state) issue.state = fields.state === 'closed' ? 'closed' : 'open';
    if (fields.title !== undefined) issue.title = fields.title;
    if (fields.body !== undefined) issue.body = fields.body;
    issue.updatedAt = this.nowIso();
    this.invalidateIssue(repo, number);
    return issue;
  }

  addComment(repo, number, body) {
    const issue = this.getIssue(repo, number);
    if (!issue) return null;
    const comment = {
      id: ++repo.commentSeq, nodeId: `C_${b64urlEncode(`comment:${repo.id}:${number}:${repo.commentSeq}`)}`,
      body, user: { login: this.viewer.login }, createdAt: this.nowIso(), updatedAt: this.nowIso(),
    };
    issue.comments.push(comment);
    issue.updatedAt = this.nowIso();
    this.invalidateIssue(repo, number);
    return comment;
  }

  // ---- pull requests ----

  createPull(repo, title, body, head, base) {
    for (const pr of repo.pulls) {
      if (pr.state === 'open' && pr.head.ref === head && pr.base.ref === base) return { error: 'a pull request already exists for this head and base' };
    }
    const headRef = `refs/heads/${head}`;
    const baseRef = `refs/heads/${base}`;
    const headTip = this.refOid(repo, headRef);
    const baseTip = this.refOid(repo, baseRef);
    if (!headTip || !baseTip) return { error: 'head or base branch not found' };
    const number = ++repo.pullSeq;
    const pull = {
      id: this.nextId(), number, title, body: body || '', state: 'open', merged: false,
      mergedAt: null, mergeCommitSha: null,
      head: { ref: head, sha: this.peelCommit(repo, headTip) || headTip },
      base: { ref: base, sha: this.peelCommit(repo, baseTip) || baseTip },
      user: { login: this.viewer.login }, createdAt: this.nowIso(), updatedAt: this.nowIso(),
    };
    repo.pulls.push(pull);
    repo.pullsByNumber.set(number, pull);
    return { pull };
  }

  getPull(repo, number) { return repo.pullsByNumber.get(number) || null; }

  mergeBase(repo, headOid, baseOid) {
    const headAncestors = this.ancestorClosure(repo, [headOid]);
    const queue = [baseOid];
    const seen = new Set([baseOid]);
    while (queue.length) {
      const oid = queue.shift();
      if (headAncestors.has(oid)) return oid;
      const commit = this.commitOf(repo, oid);
      if (!commit) continue;
      for (const p of commit.parents) if (!seen.has(p)) { seen.add(p); queue.push(p); }
    }
    return null;
  }

  // Three-way merge of the head tree onto the base tip. Returns {flat, conflict}.
  threeWay(repo, pull) {
    const headTip = this.refOid(repo, `refs/heads/${pull.head.ref}`);
    const baseTip = this.refOid(repo, `refs/heads/${pull.base.ref}`);
    if (!headTip || !baseTip) return { flat: null, conflict: true };
    const headCommit = this.peelCommit(repo, headTip);
    const baseCommit = this.peelCommit(repo, baseTip);
    const baseOid = this.mergeBase(repo, headCommit, baseCommit);
    const baseFlat = new Map(), headFlat = new Map(), tipFlat = new Map();
    if (baseOid) {
      const c = this.commitOf(repo, baseOid);
      if (c) this.flattenTree(repo, c.tree, '', baseFlat);
    }
    const hc = this.commitOf(repo, headCommit);
    if (hc) this.flattenTree(repo, hc.tree, '', headFlat);
    const bc = this.commitOf(repo, baseCommit);
    if (bc) this.flattenTree(repo, bc.tree, '', tipFlat);
    const flat = new Map(tipFlat);
    let conflict = false;
    const paths = new Set([...baseFlat.keys(), ...headFlat.keys(), ...tipFlat.keys()]);
    for (const path of paths) {
      const b = baseFlat.get(path), h = headFlat.get(path), t = tipFlat.get(path);
      const same = (x, y) => (x === undefined && y === undefined) || (x && y && x.oid === y.oid && x.mode === y.mode);
      if (same(h, b)) continue; // head unchanged: keep base tip's version
      if (same(t, b)) { if (h) flat.set(path, h); else flat.delete(path); continue; } // base unchanged: take head
      if (same(h, t)) continue; // both changed identically
      conflict = true;
    }
    return { flat, conflict };
  }

  mergeable(repo, pull) {
    if (pull.state !== 'open') return 'UNKNOWN';
    return this.threeWay(repo, pull).conflict ? 'CONFLICTING' : 'MERGEABLE';
  }

  mergePull(repo, number, method) {
    const pull = this.getPull(repo, number);
    if (!pull) return { error: 'not_found' };
    if (pull.state !== 'open') return { error: 'already_closed' };
    const { flat, conflict } = this.threeWay(repo, pull);
    if (conflict || !flat) return { error: 'conflict' };
    const baseRef = `refs/heads/${pull.base.ref}`;
    const baseTip = this.peelCommit(repo, this.refOid(repo, baseRef));
    const treeOid = this.buildTreeFromFlat(repo, flat);
    const message = method === 'squash' ? `${pull.title} (#${pull.number})\n` : `Merge pull request #${pull.number} from ${pull.head.ref}\n`;
    const commitOid = this.putObject(repo, TYPE_COMMIT, buildCommitBlob(treeOid, baseTip ? [baseTip] : [], this.identity(), this.identity(), this.nowSec(), message));
    this.setRef(repo, baseRef, commitOid);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.nowIso();
    pull.mergeCommitSha = commitOid;
    pull.updatedAt = this.nowIso();
    return { pull, sha: commitOid };
  }

  pullFiles(repo, pull) {
    const headTip = this.refOid(repo, `refs/heads/${pull.head.ref}`);
    const baseTip = this.refOid(repo, `refs/heads/${pull.base.ref}`);
    if (!headTip || !baseTip) return [];
    const headCommit = this.peelCommit(repo, headTip);
    const baseCommit = this.peelCommit(repo, baseTip);
    const baseOid = this.mergeBase(repo, headCommit, baseCommit);
    const baseFlat = new Map(), headFlat = new Map();
    if (baseOid) {
      const c = this.commitOf(repo, baseOid);
      if (c) this.flattenTree(repo, c.tree, '', baseFlat);
    }
    const hc = this.commitOf(repo, headCommit);
    if (hc) this.flattenTree(repo, hc.tree, '', headFlat);
    const out = [];
    const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
    for (const path of [...paths].sort()) {
      const b = baseFlat.get(path), h = headFlat.get(path);
      if (b && h && b.oid === h.oid) continue;
      let status = 'added', additions = 0, deletions = 0;
      const oldText = b ? (this.getObject(repo, b.oid)?.body?.toString('utf8') ?? '') : '';
      const newText = h ? (this.getObject(repo, h.oid)?.body?.toString('utf8') ?? '') : '';
      if (b && !h) { status = 'removed'; const d = lineDiff(oldText, ''); deletions = d.deletions; additions = 0; }
      else if (!b && h) { status = 'added'; const d = lineDiff('', newText); additions = d.additions; }
      else { status = 'modified'; const d = lineDiff(oldText, newText); additions = d.additions; deletions = d.deletions; }
      out.push({ filename: path, status, additions, deletions, changes: additions + deletions });
    }
    return out;
  }

  // ---- JSON views ----

  repoJson(repo) {
    return {
      id: repo.id, node_id: `R_${b64urlEncode(`repo:${repo.id}`)}`,
      name: repo.name, full_name: repo.fullName,
      owner: { login: repo.owner, id: this.viewer.id, type: 'User' },
      private: repo.private, description: repo.description, default_branch: repo.defaultBranch,
      created_at: repo.createdAt, updated_at: repo.updatedAt, pushed_at: repo.updatedAt,
      html_url: `https://github.com/${repo.fullName}`, url: `/api/v3/repos/${repo.fullName}`,
      git_url: `git://github.com/${repo.fullName}.git`, ssh_url: `git@github.com:${repo.fullName}.git`,
      clone_url: `https://github.com/${repo.fullName}.git`,
      fork: false, has_issues: true, has_projects: true, has_wiki: true,
      open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    };
  }

  issueJson(repo, issue) {
    return {
      id: issue.id, node_id: `I_${b64urlEncode(`issue:${repo.id}:${issue.number}`)}`,
      number: issue.number, title: issue.title, body: issue.body, state: issue.state,
      labels: issue.labels.map((l) => ({ name: l.name })),
      user: { login: issue.user.login }, created_at: issue.createdAt, updated_at: issue.updatedAt,
      comments: issue.comments.length,
      html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
      url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    };
  }

  commentJson(repo, issue, comment) {
    return {
      id: comment.id, node_id: comment.nodeId, body: comment.body,
      user: { login: comment.user.login }, created_at: comment.createdAt, updated_at: comment.updatedAt,
      html_url: `https://github.com/${repo.fullName}/issues/${issue.number}#issuecomment-${comment.id}`,
      url: `/api/v3/repos/${repo.fullName}/issues/comments/${comment.id}`,
    };
  }

  pullJson(repo, pull) {
    return {
      id: pull.id, node_id: `P_${b64urlEncode(`pull:${repo.id}:${pull.number}`)}`,
      number: pull.number, title: pull.title, body: pull.body, state: pull.state,
      merged: pull.merged, merged_at: pull.mergedAt, merge_commit_sha: pull.mergeCommitSha,
      head: { ref: pull.head.ref, sha: pull.head.sha },
      base: { ref: pull.base.ref, sha: pull.base.sha },
      user: { login: pull.user.login }, created_at: pull.createdAt, updated_at: pull.updatedAt,
      html_url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
      url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
    };
  }
}
