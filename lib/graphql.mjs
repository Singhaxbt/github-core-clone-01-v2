// GraphQL v4: a small parser for the fixed documents the suite sends, plus the
// resolvers for viewer/repository/issue/pull-request/node/introspection and the
// five mutations. Unknown fields fail at the GraphQL level (HTTP 200 with an
// errors array naming the field); an unknown repository resolves to null.

import { b64urlDecode } from './util.mjs';

// ---------- lexer ----------

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') { i++; continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (ch === '{' || ch === '}' || ch === '(' || ch === ')' || ch === '[' || ch === ']' || ch === ':' || ch === '!' || ch === '=' || ch === '$' || ch === '@') {
      tokens.push({ kind: ch }); i++; continue;
    }
    if (src.startsWith('...', i)) { tokens.push({ kind: '...' }); i += 3; continue; }
    if (ch === '"') {
      let j = i + 1, out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') {
          const esc = src[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'b') out += '\b';
          else if (esc === 'f') out += '\f';
          else if (esc === 'u') { out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)); j += 4; }
          else out += esc;
          j += 2;
        } else { out += src[j]; j++; }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j])) j++;
      const raw = src.slice(i, j);
      tokens.push({ kind: /[.eE]/.test(raw) ? 'float' : 'int', value: raw });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${ch}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------- parser ----------

class Parser {
  constructor(tokens) { this.t = tokens; this.p = 0; }
  peek() { return this.t[this.p]; }
  next() { return this.t[this.p++]; }
  expect(kind) {
    const tok = this.next();
    if (tok.kind !== kind) throw new Error(`expected ${kind}, got ${tok.kind}`);
    return tok;
  }
  parseDocument() {
    const op = this.parseOperation();
    return op;
  }
  parseOperation() {
    let operation = 'query';
    const first = this.peek();
    if (first.kind === 'name' && (first.value === 'query' || first.value === 'mutation')) {
      operation = this.next().value;
    }
    let name = null;
    if (this.peek().kind === 'name') name = this.next().value;
    const variables = [];
    if (this.peek().kind === '(') {
      this.next();
      while (this.peek().kind !== ')') {
        this.expect('$');
        const varName = this.expect('name').value;
        this.expect(':');
        this.skipType();
        let def = null;
        if (this.peek().kind === '=') { this.next(); def = this.parseValue(); }
        variables.push({ name: varName, default: def });
      }
      this.expect(')');
    }
    const selections = this.parseSelectionSet();
    return { operation, name, variables, selections };
  }
  skipType() {
    if (this.peek().kind === '[') {
      this.next(); this.skipType(); this.expect(']');
    } else {
      this.expect('name');
    }
    if (this.peek().kind === '!') this.next();
  }
  parseSelectionSet() {
    this.expect('{');
    const sels = [];
    while (this.peek().kind !== '}') sels.push(this.parseSelection());
    this.expect('}');
    return sels;
  }
  parseSelection() {
    if (this.peek().kind === '...') {
      this.next();
      let typeCondition = null;
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        typeCondition = this.expect('name').value;
      }
      const selections = this.parseSelectionSet();
      return { kind: 'fragment', typeCondition, selections };
    }
    let name = this.expect('name').value;
    let alias = null;
    if (this.peek().kind === ':') { this.next(); alias = name; name = this.expect('name').value; }
    const args = {};
    if (this.peek().kind === '(') {
      this.next();
      while (this.peek().kind !== ')') {
        const argName = this.expect('name').value;
        this.expect(':');
        args[argName] = this.parseValue();
      }
      this.expect(')');
    }
    let selections = null;
    if (this.peek().kind === '{') selections = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, selections };
  }
  parseValue() {
    const tok = this.next();
    if (tok.kind === '$') return { kind: 'variable', name: this.expect('name').value };
    if (tok.kind === 'string') return { kind: 'string', value: tok.value };
    if (tok.kind === 'int') return { kind: 'int', value: Number(tok.value) };
    if (tok.kind === 'float') return { kind: 'float', value: Number(tok.value) };
    if (tok.kind === '[') {
      const items = [];
      while (this.peek().kind !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', value: items };
    }
    if (tok.kind === '{') {
      const obj = {};
      while (this.peek().kind !== '}') {
        const key = this.expect('name').value;
        this.expect(':');
        obj[key] = this.parseValue();
      }
      this.expect('}');
      return { kind: 'object', value: obj };
    }
    if (tok.kind === 'name') {
      if (tok.value === 'true') return { kind: 'boolean', value: true };
      if (tok.value === 'false') return { kind: 'boolean', value: false };
      if (tok.value === 'null') return { kind: 'null', value: null };
      return { kind: 'enum', value: tok.value };
    }
    throw new Error(`unexpected value token ${tok.kind}`);
  }
}

// ---------- schema ----------

const SCHEMA = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  PullRequest: ['id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files'],
  PullRequestConnection: ['nodes', 'pageInfo'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo'],
  PullRequestChangedFile: ['path'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  CommentEdge: ['node'],
  Comment: ['id', 'body'],
  BranchRef: ['name'],
  __Type: ['name', 'kind', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
};

const ENUM_VALUES = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'ORGANIZATION', 'PROJECT', 'TEAM', 'LABEL'],
};

function typeFields(typeName) {
  return SCHEMA[typeName] || [];
}

function decodeGlobalId(id) {
  if (typeof id !== 'string') return null;
  const prefix = id.slice(0, 2);
  const payload = b64urlDecode(id.slice(2));
  if (!payload) return null;
  const parts = payload.split(':');
  return { prefix, parts };
}

function repoById(forge, dbId) {
  for (const repo of forge.repos.values()) if (repo.id === dbId) return repo;
  return null;
}

function valueOf(node, vars, defaults) {
  if (!node) return null;
  switch (node.kind) {
    case 'variable': {
      if (vars && Object.prototype.hasOwnProperty.call(vars, node.name)) return vars[node.name];
      if (defaults && defaults[node.name] !== undefined) return defaults[node.name];
      return null;
    }
    case 'list': return node.value.map((v) => valueOf(v, vars, defaults));
    case 'object': {
      const out = {};
      for (const [k, v] of Object.entries(node.value)) out[k] = valueOf(v, vars, defaults);
      return out;
    }
    default: return node.value;
  }
}

// ---------- execution ----------

function resolveIssue(forge, repo, issue) {
  return {
    __type: 'Issue', __repo: repo, __issue: issue,
    id: `I_${Buffer.from(`issue:${repo.id}:${issue.number}`, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`,
    number: issue.number, title: issue.title,
    state: issue.state === 'closed' ? 'CLOSED' : 'OPEN',
    body: issue.body,
  };
}

function resolvePull(forge, repo, pull) {
  return {
    __type: 'PullRequest', __repo: repo, __pull: pull,
    id: `P_${Buffer.from(`pull:${repo.id}:${pull.number}`, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`,
    number: pull.number, title: pull.title,
    state: pull.merged ? 'MERGED' : pull.state === 'closed' ? 'CLOSED' : 'OPEN',
    merged: pull.merged,
    headRefName: pull.head.ref, baseRefName: pull.base.ref,
  };
}

function issuesConnection(forge, repo, args) {
  let list = repo.issues.slice();
  const states = args.states;
  if (Array.isArray(states) && states.length) {
    const wanted = new Set(states.map((s) => (s === 'CLOSED' ? 'closed' : 'open')));
    list = list.filter((i) => wanted.has(i.state));
  }
  const orderBy = args.orderBy || {};
  const desc = orderBy.direction === 'DESC';
  list.sort((a, b) => desc ? b.number - a.number : a.number - b.number);
  if (args.after) {
    const decoded = Buffer.from(String(args.after), 'base64').toString('utf8');
    const cursor = Number(decoded);
    if (Number.isFinite(cursor)) list = list.filter((i) => desc ? i.number < cursor : i.number > cursor);
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, first);
  const hasNext = list.length > first;
  const endCursor = page.length ? Buffer.from(String(page[page.length - 1].number), 'utf8').toString('base64') : null;
  return {
    __type: 'IssueConnection',
    nodes: page.map((i) => resolveIssue(forge, repo, i)),
    pageInfo: { __type: 'PageInfo', hasNextPage: hasNext, endCursor, hasPreviousPage: false, startCursor: null },
    totalCount: list.length,
  };
}

function fieldValue(forge, type, value, field, vars, defaults) {
  const a = {};
  for (const [k, v] of Object.entries(field.args || {})) a[k] = valueOf(v, vars, defaults);
  switch (type) {
    case 'Query': {
      if (field.name === 'viewer') {
        const v = forge.viewer;
        return { __type: 'User', login: v.login, id: v.id, name: v.name, email: v.email };
      }
      if (field.name === 'repository') {
        if (a.owner !== forge.viewer.login) return null;
        const repo = forge.getRepo(a.owner, a.name);
        if (!repo) return null;
        return {
          __type: 'Repository', __repo: repo,
          id: `R_${Buffer.from(`repo:${repo.id}`, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`,
          databaseId: repo.id, name: repo.name, nameWithOwner: repo.fullName,
          viewerPermission: 'ADMIN', hasIssuesEnabled: true,
        };
      }
      if (field.name === 'node') {
        const decoded = decodeGlobalId(a.id);
        if (!decoded) return null;
        if (decoded.prefix === 'R_') {
          const repo = repoById(forge, Number(decoded.parts[1]));
          if (!repo) return null;
          return {
            __type: 'Repository', __repo: repo,
            id: a.id, databaseId: repo.id, name: repo.name, nameWithOwner: repo.fullName,
            viewerPermission: 'ADMIN', hasIssuesEnabled: true,
          };
        }
        if (decoded.prefix === 'I_') {
          const repo = repoById(forge, Number(decoded.parts[1]));
          const issue = repo ? forge.getIssue(repo, Number(decoded.parts[2])) : null;
          return issue ? resolveIssue(forge, repo, issue) : null;
        }
        if (decoded.prefix === 'P_') {
          const repo = repoById(forge, Number(decoded.parts[1]));
          const pull = repo ? forge.getPull(repo, Number(decoded.parts[2])) : null;
          return pull ? resolvePull(forge, repo, pull) : null;
        }
        return null;
      }
      if (field.name === '__type') {
        const name = a.name;
        if (!name) return null;
        const isEnum = Object.prototype.hasOwnProperty.call(ENUM_VALUES, name);
        return {
          __type: '__Type', name, kind: isEnum ? 'ENUM' : 'OBJECT',
          fields: isEnum ? [] : typeFields(name).map((n) => ({ __type: '__Field', name: n })),
          enumValues: isEnum ? ENUM_VALUES[name].map((n) => ({ __type: '__EnumValue', name: n })) : [],
        };
      }
      return null;
    }
    case 'Repository': {
      const repo = value.__repo;
      if (field.name === 'id') return value.id;
      if (field.name === 'databaseId') return value.databaseId;
      if (field.name === 'name') return value.name;
      if (field.name === 'nameWithOwner') return value.nameWithOwner;
      if (field.name === 'viewerPermission') return value.viewerPermission;
      if (field.name === 'hasIssuesEnabled') return value.hasIssuesEnabled;
      if (field.name === 'owner') return { __type: 'User', login: repo.owner, id: forge.viewer.id, name: forge.viewer.name, email: forge.viewer.email };
      if (field.name === 'defaultBranchRef') {
        return forge.branchNames(repo).length ? { __type: 'BranchRef', name: repo.defaultBranch } : null;
      }
      if (field.name === 'issue') {
        const issue = forge.getIssue(repo, a.number);
        return issue ? resolveIssue(forge, repo, issue) : null;
      }
      if (field.name === 'issues') return issuesConnection(forge, repo, a);
      if (field.name === 'pullRequests') {
        const open = repo.pulls.filter((p) => p.state === 'open');
        const first = typeof a.first === 'number' ? a.first : open.length;
        return {
          __type: 'PullRequestConnection',
          nodes: open.slice(0, first).map((p) => resolvePull(forge, repo, p)),
          pageInfo: { __type: 'PageInfo', hasNextPage: open.length > first, endCursor: null, hasPreviousPage: false, startCursor: null },
        };
      }
      if (field.name === 'pullRequest') {
        const pull = forge.getPull(repo, a.number);
        return pull ? resolvePull(forge, repo, pull) : null;
      }
      return null;
    }
    case 'PullRequest': {
      const repo = value.__repo;
      const pull = value.__pull;
      if (field.name === 'files') {
        const files = forge.pullFiles(repo, pull);
        const first = typeof a.first === 'number' ? a.first : files.length;
        return {
          __type: 'PullRequestChangedFileConnection',
          nodes: files.slice(0, first).map((f) => ({ __type: 'PullRequestChangedFile', path: f.filename })),
          pageInfo: { __type: 'PageInfo', hasNextPage: files.length > first, endCursor: null, hasPreviousPage: false, startCursor: null },
        };
      }
      if (field.name === 'mergeable') return forge.mergeable(repo, pull);
      return value[field.name] ?? null;
    }
    case 'Mutation': {
      if (field.name === 'createIssue') {
        const input = a.input || {};
        const decoded = decodeGlobalId(input.repositoryId);
        if (!decoded || decoded.prefix !== 'R_') throw new Error('unknown repository');
        const repo = repoById(forge, Number(decoded.parts[1]));
        if (!repo) throw new Error('unknown repository');
        const result = forge.createIssue(repo, input.title, input.body || '', []);
        if (result.error) throw new Error(result.error);
        return { __type: 'CreateIssuePayload', issue: resolveIssue(forge, repo, result.issue) };
      }
      if (field.name === 'closeIssue') {
        const input = a.input || {};
        const decoded = decodeGlobalId(input.issueId);
        if (!decoded || decoded.prefix !== 'I_') throw new Error('unknown issue');
        const repo = repoById(forge, Number(decoded.parts[1]));
        const issue = repo ? forge.patchIssue(repo, Number(decoded.parts[2]), { state: 'closed' }) : null;
        if (!issue) throw new Error('unknown issue');
        return { __type: 'CloseIssuePayload', issue: resolveIssue(forge, repo, issue) };
      }
      if (field.name === 'createPullRequest') {
        const input = a.input || {};
        const decoded = decodeGlobalId(input.repositoryId);
        if (!decoded || decoded.prefix !== 'R_') throw new Error('unknown repository');
        const repo = repoById(forge, Number(decoded.parts[1]));
        if (!repo) throw new Error('unknown repository');
        const result = forge.createPull(repo, input.title, '', input.headRefName, input.baseRefName);
        if (result.error) throw new Error(result.error);
        return { __type: 'CreatePullRequestPayload', pullRequest: resolvePull(forge, repo, result.pull) };
      }
      if (field.name === 'mergePullRequest') {
        const input = a.input || {};
        const decoded = decodeGlobalId(input.pullRequestId);
        if (!decoded || decoded.prefix !== 'P_') throw new Error('unknown pull request');
        const repo = repoById(forge, Number(decoded.parts[1]));
        const method = input.mergeMethod === 'SQUASH' ? 'squash' : 'merge';
        const result = repo ? forge.mergePull(repo, Number(decoded.parts[2]), method) : { error: 'not_found' };
        if (result.error) throw new Error(result.error === 'conflict' ? 'merge conflict' : 'unknown pull request');
        const pull = forge.getPull(repo, Number(decoded.parts[2]));
        return { __type: 'MergePullRequestPayload', pullRequest: resolvePull(forge, repo, pull) };
      }
      if (field.name === 'addComment') {
        const input = a.input || {};
        const decoded = decodeGlobalId(input.subjectId);
        if (!decoded || decoded.prefix !== 'I_') throw new Error('unknown subject');
        const repo = repoById(forge, Number(decoded.parts[1]));
        const comment = repo ? forge.addComment(repo, Number(decoded.parts[2]), input.body || '') : null;
        if (!comment) throw new Error('unknown subject');
        return { __type: 'AddCommentPayload', commentEdge: { __type: 'CommentEdge', node: { __type: 'Comment', id: comment.nodeId, body: comment.body } } };
      }
      return null;
    }
    default:
      return value[field.name] ?? null;
  }
}

function validateSelections(type, selections) {
  const fields = typeFields(type);
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition) validateSelections(sel.typeCondition, sel.selections);
      else validateSelections(type, sel.selections);
      continue;
    }
    if (!fields.includes(sel.name)) {
      throw new Error(`Field "${sel.name}" doesn't exist on type "${type}"`);
    }
    // Validate nested selections against the field's result type.
    if (sel.selections) {
      const childType = childTypeOf(type, sel.name);
      if (childType) validateSelections(childType, sel.selections);
    }
  }
}

function childTypeOf(type, field) {
  const map = {
    'Query.viewer': 'User', 'Query.repository': 'Repository', 'Query.node': null,
    'Repository.owner': 'User', 'Repository.defaultBranchRef': 'BranchRef',
    'Repository.issue': 'Issue', 'Repository.issues': 'IssueConnection',
    'Repository.pullRequests': 'PullRequestConnection', 'Repository.pullRequest': 'PullRequest',
    'IssueConnection.nodes': 'Issue', 'IssueConnection.pageInfo': 'PageInfo',
    'PullRequestConnection.nodes': 'PullRequest', 'PullRequestConnection.pageInfo': 'PageInfo',
    'PullRequest.files': 'PullRequestChangedFileConnection',
    'PullRequestChangedFileConnection.nodes': 'PullRequestChangedFile',
    'CreateIssuePayload.issue': 'Issue', 'CloseIssuePayload.issue': 'Issue',
    'CreatePullRequestPayload.pullRequest': 'PullRequest', 'MergePullRequestPayload.pullRequest': 'PullRequest',
    'AddCommentPayload.commentEdge': 'CommentEdge', 'CommentEdge.node': 'Comment',
    '__Type.fields': '__Field', '__Type.enumValues': '__EnumValue',
  };
  return map[`${type}.${field}`] ?? null;
}

function executeSelections(forge, type, value, selections, vars, defaults) {
  if (value === null || value === undefined) return null;
  const out = {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition && value.__type !== sel.typeCondition) continue;
      const inner = executeSelections(forge, sel.typeCondition || type, value, sel.selections, vars, defaults);
      Object.assign(out, inner || {});
      continue;
    }
    const key = sel.alias || sel.name;
    const raw = fieldValue(forge, type, value, sel, vars, defaults);
    if (raw === null || raw === undefined) { out[key] = null; continue; }
    if (!sel.selections) { out[key] = raw; continue; }
    const childType = childTypeOf(type, sel.name);
    if (Array.isArray(raw)) {
      out[key] = raw.map((item) => executeSelections(forge, childType, item, sel.selections, vars, defaults));
    } else {
      out[key] = executeSelections(forge, childType, raw, sel.selections, vars, defaults);
    }
  }
  return out;
}

export function executeGraphQL(forge, body) {
  if (Array.isArray(body)) return body.map((op) => runOperation(forge, op));
  return runOperation(forge, body);
}

function runOperation(forge, op) {
  try {
    if (!op || typeof op.query !== 'string') return { data: null, errors: [{ message: 'query is required' }] };
    const doc = new Parser(tokenize(op.query)).parseDocument();
    const rootType = doc.operation === 'mutation' ? 'Mutation' : 'Query';
    validateSelections(rootType, doc.selections);
    const defaults = {};
    for (const v of doc.variables) if (v.default) defaults[v.name] = valueOf(v.default, {}, {});
    const data = executeSelections(forge, rootType, {}, doc.selections, op.variables || {}, defaults);
    return { data };
  } catch (e) {
    return { data: null, errors: [{ message: e.message }] };
  }
}
