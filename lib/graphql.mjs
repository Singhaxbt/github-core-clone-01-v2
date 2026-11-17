// GraphQL v4 at /api/graphql: a small parser + executor for the documents gh and
// github-mcp-server actually send (viewer, repository, issue/pull reads, the five
// mutations, __type introspection, node(id:), batched operations). Unknown fields are
// a 200 with an `errors` array naming the field, as the suite requires; an unknown
// repository reads data.repository = null with no errors. Global ids are opaque
// base64url values, stable across reads.
import { globalId, parseGlobalId } from './store.mjs';

// ------------------------------------------------------------------ tokenizer

function tokenize(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') { i += 1; continue; }
    if (ch === '#') { while (i < source.length && source[i] !== '\n') i += 1; continue; }
    if (ch === '.' && source.slice(i, i + 3) === '...') { tokens.push({ kind: '...', value: '...' }); i += 3; continue; }
    if ('{}()[]:!=$@'.includes(ch)) { tokens.push({ kind: ch, value: ch }); i += 1; continue; }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const esc = source[i + 1];
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else value += esc;
          i += 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let value = '';
      while (i < source.length && /[0-9.]/.test(source[i])) { value += source[i]; i += 1; }
      tokens.push({ kind: value.includes('.') ? 'float' : 'int', value });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let value = '';
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i])) { value += source[i]; i += 1; }
      tokens.push({ kind: 'name', value });
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ------------------------------------------------------------------ parser

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }
  peek() { return this.tokens[this.pos]; }
  next() { return this.tokens[this.pos++]; }
  expect(kind) {
    const token = this.next();
    if (token.kind !== kind) throw new Error(`expected ${kind}, got ${token.kind} (${token.value})`);
    return token;
  }
  match(kind) {
    if (this.peek().kind === kind) { this.pos += 1; return true; }
    return false;
  }

  parseDocument() {
    const operations = [];
    while (this.peek().kind !== 'eof') {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  parseOperation() {
    let operationType = 'query';
    let name = null;
    const token = this.peek();
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
      operationType = this.next().value;
      if (this.peek().kind === 'name') name = this.next().value;
    }
    let variableDefinitions = [];
    if (this.peek().kind === '(') variableDefinitions = this.parseVariableDefinitions();
    const selectionSet = this.parseSelectionSet();
    return { operationType, name, variableDefinitions, selectionSet };
  }

  parseVariableDefinitions() {
    const defs = [];
    this.expect('(');
    while (this.peek().kind !== ')') {
      this.expect('$');
      const name = this.expect('name').value;
      this.expect(':');
      this.parseType();
      if (this.match('=')) this.parseValue(true);
      defs.push(name);
    }
    this.expect(')');
    return defs;
  }

  parseType() {
    if (this.match('[')) {
      this.parseType();
      this.expect(']');
    } else {
      this.expect('name');
    }
    this.match('!');
  }

  parseSelectionSet() {
    this.expect('{');
    const selections = [];
    while (this.peek().kind !== '}') {
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }

  parseSelection() {
    if (this.match('...')) {
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeName = this.expect('name').value;
        return { kind: 'inlineFragment', typeName, selectionSet: this.parseSelectionSet() };
      }
      const name = this.expect('name').value;
      return { kind: 'fragmentSpread', name };
    }
    let alias = null;
    let name = this.expect('name').value;
    if (this.match(':')) {
      alias = name;
      name = this.expect('name').value;
    }
    let args = {};
    if (this.peek().kind === '(') args = this.parseArguments();
    let selectionSet = null;
    if (this.peek().kind === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'field', name, alias: alias ?? name, args, selectionSet };
  }

  parseArguments() {
    const args = {};
    this.expect('(');
    while (this.peek().kind !== ')') {
      const name = this.expect('name').value;
      this.expect(':');
      args[name] = this.parseValue(false);
    }
    this.expect(')');
    return args;
  }

  parseValue(isConst) {
    const token = this.peek();
    if (token.kind === '$') {
      this.next();
      return { kind: 'variable', name: this.next().value };
    }
    if (token.kind === 'int') { this.next(); return { kind: 'int', value: Number.parseInt(token.value, 10) }; }
    if (token.kind === 'float') { this.next(); return { kind: 'float', value: Number.parseFloat(token.value) }; }
    if (token.kind === 'string') { this.next(); return { kind: 'string', value: token.value }; }
    if (token.kind === '[') {
      this.next();
      const values = [];
      while (this.peek().kind !== ']') values.push(this.parseValue(isConst));
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token.kind === '{') {
      this.next();
      const fields = {};
      while (this.peek().kind !== '}') {
        const name = this.expect('name').value;
        this.expect(':');
        fields[name] = this.parseValue(isConst);
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      this.next();
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null', value: null };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.kind}`);
  }
}

function valueOf(node, variables) {
  if (node === undefined) return undefined;
  switch (node.kind) {
    case 'variable': return variables[node.name];
    case 'int': case 'float': case 'string': case 'boolean': case 'enum': return node.value;
    case 'null': return null;
    case 'list': return node.values.map((entry) => valueOf(entry, variables));
    case 'object': {
      const out = {};
      for (const [key, entry] of Object.entries(node.fields)) out[key] = valueOf(entry, variables);
      return out;
    }
    default: return undefined;
  }
}

// ------------------------------------------------------------------ schema

// Field lists the __type introspection reports (gh's feature probes read these).
const TYPE_FIELDS = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt', 'url', 'comments', 'labels'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'createdAt', 'updatedAt', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'url', 'createdAt', 'updatedAt'],
  User: ['id', 'login', 'name', 'email', 'url'],
};
const TYPE_ENUMS = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'WIKI'],
  IssueState: ['OPEN', 'CLOSED'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

function typeDescriptor(name) {
  if (TYPE_FIELDS[name]) {
    return {
      __typename: '__Type',
      name,
      kind: 'OBJECT',
      fields: TYPE_FIELDS[name].map((field) => ({ __typename: '__Field', name: field })),
      enumValues: null,
    };
  }
  if (TYPE_ENUMS[name]) {
    return {
      __typename: '__Type',
      name,
      kind: 'ENUM',
      fields: null,
      enumValues: TYPE_ENUMS[name].map((value) => ({ __typename: '__EnumValue', name: value })),
    };
  }
  return null;
}

// ------------------------------------------------------------------ executor

class GraphQLError extends Error {}

export class GraphQLApi {
  constructor(forge) {
    this.forge = forge;
  }

  execute(body, variables) {
    if (Array.isArray(body)) {
      return body.map((entry) => this.executeOne(entry.query ?? '', entry.variables ?? {}));
    }
    return this.executeOne(body.query ?? '', body.variables ?? variables ?? {});
  }

  executeOne(query, variables) {
    let operations;
    try {
      operations = new Parser(tokenize(query)).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
    if (operations.length === 0) {
      return { data: null, errors: [{ message: 'no operation in document' }] };
    }
    const operation = operations[0];
    const errors = [];
    const ctx = { forge: this.forge, errors };
    try {
      const data = this.executeSelectionSet(operation.selectionSet, this.rootValue(operation.operationType), operation.operationType === 'mutation' ? 'Mutation' : 'Query', variables, ctx);
      if (errors.length > 0) return { data: null, errors };
      return { data };
    } catch (err) {
      if (err instanceof GraphQLError) {
        return { data: null, errors: [{ message: err.message }] };
      }
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
  }

  rootValue(operationType) {
    return { __typename: operationType === 'mutation' ? 'Mutation' : 'Query' };
  }

  executeSelectionSet(selections, source, typeName, variables, ctx) {
    const out = {};
    for (const selection of selections) {
      if (selection.kind === 'fragmentSpread') {
        throw new GraphQLError(`fragment spread ${selection.name} is not supported`);
      }
      if (selection.kind === 'inlineFragment') {
        if (source.__typename === selection.typeName || selection.typeName === 'Node') {
          Object.assign(out, this.executeSelectionSet(selection.selectionSet, source, typeName, variables, ctx));
        }
        continue;
      }
      const value = this.resolveField(source, typeName, selection, variables, ctx);
      out[selection.alias] = value;
    }
    return out;
  }

  resolveField(source, typeName, selection, variables, ctx) {
    const fieldName = selection.name;
    const args = {};
    for (const [key, node] of Object.entries(selection.args)) args[key] = valueOf(node, variables);
    const known = this.knownFields(typeName);
    if (known !== null && !known.includes(fieldName) && fieldName !== '__typename') {
      ctx.errors.push({ message: `Cannot query field "${fieldName}" on type "${typeName}".` });
      throw new GraphQLError(`Cannot query field "${fieldName}" on type "${typeName}".`);
    }
    const value = this.fieldValue(source, typeName, fieldName, args, ctx);
    if (selection.selectionSet === null) return value;
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) {
      return value.map((entry) => this.executeSelectionSet(selection.selectionSet, entry, entry.__typename, variables, ctx));
    }
    return this.executeSelectionSet(selection.selectionSet, value, value.__typename, variables, ctx);
  }

  knownFields(typeName) {
    switch (typeName) {
      case 'Query': return ['viewer', 'repository', 'node', '__type'];
      case 'Mutation': return ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'];
      case 'Repository': return TYPE_FIELDS.Repository;
      case 'Issue': return TYPE_FIELDS.Issue;
      case 'PullRequest': return TYPE_FIELDS.PullRequest;
      case 'User': return TYPE_FIELDS.User;
      case 'IssueConnection': return ['nodes', 'edges', 'pageInfo', 'totalCount'];
      case 'PullRequestConnection': return ['nodes', 'edges', 'pageInfo', 'totalCount'];
      case 'PullRequestChangedFileConnection': return ['nodes', 'edges', 'pageInfo', 'totalCount'];
      case 'PageInfo': return ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'];
      case 'Ref': return ['name'];
      case '__Type': return ['name', 'kind', 'fields', 'enumValues', 'description'];
      case '__Field': return ['name', 'description', 'type'];
      case '__EnumValue': return ['name', 'description'];
      case 'PullRequestChangedFile': return ['path', 'additions', 'deletions', 'changeType'];
      case 'IssueCommentEdge': return ['node', 'cursor'];
      case 'IssueComment': return ['id', 'body'];
      case 'CreateIssuePayload': return ['issue'];
      case 'CloseIssuePayload': return ['issue'];
      case 'CreatePullRequestPayload': return ['pullRequest'];
      case 'MergePullRequestPayload': return ['pullRequest'];
      case 'AddCommentPayload': return ['commentEdge'];
      default: return null;
    }
  }

  fieldValue(source, typeName, field, args, ctx) {
    const forge = this.forge;
    if (field === '__typename') return source.__typename ?? typeName;
    switch (typeName) {
      case 'Query': {
        if (field === 'viewer') return { __typename: 'User', login: forge.viewer.login, id: forge.viewer.id, name: forge.viewer.name, email: forge.viewer.email };
        if (field === 'repository') {
          const repo = forge.getRepo(args.owner, args.name);
          return repo === null ? null : this.repositoryValue(repo);
        }
        if (field === 'node') return this.nodeValue(args.id);
        if (field === '__type') return typeDescriptor(args.name);
        return null;
      }
      case 'Mutation': return this.mutationValue(field, args, ctx);
      case 'Repository': return this.repositoryField(source, field, args);
      case 'Issue': return this.issueField(source, field, args);
      case 'PullRequest': return this.pullRequestField(source, field, args);
      case 'User': return source[field] ?? null;
      case 'IssueConnection': case 'PullRequestConnection': case 'PullRequestChangedFileConnection': {
        if (field === 'nodes') return source.nodes;
        if (field === 'pageInfo') return source.pageInfo;
        if (field === 'totalCount') return source.nodes.length;
        return null;
      }
      case 'PageInfo': return source[field] ?? null;
      case 'Ref': return source[field] ?? null;
      case '__Type': {
        if (field === 'fields') return source.fields;
        if (field === 'enumValues') return source.enumValues;
        return source[field] ?? null;
      }
      case '__Field': case '__EnumValue': return source[field] ?? null;
      case 'IssueCommentEdge': {
        if (field === 'node') return source.node;
        if (field === 'cursor') return source.cursor ?? null;
        return null;
      }
      case 'IssueComment': return source[field] ?? null;
      case 'CreateIssuePayload': case 'CloseIssuePayload': return source.issue ?? null;
      case 'CreatePullRequestPayload': case 'MergePullRequestPayload': return source.pullRequest ?? null;
      case 'AddCommentPayload': return source.commentEdge ?? null;
      case 'PullRequestChangedFile': return source[field] ?? null;
      default: return source[field] ?? null;
    }
  }

  repositoryValue(repo) {
    return {
      __typename: 'Repository',
      __repo: repo,
      id: globalId('R', repo.owner, repo.name),
      databaseId: repo.id,
      name: repo.name,
      nameWithOwner: `${repo.owner}/${repo.name}`,
      owner: { __typename: 'User', login: repo.owner },
      description: repo.description,
      isPrivate: repo.private,
    };
  }

  repositoryField(source, field, args) {
    const repo = source.__repo;
    const forge = this.forge;
    switch (field) {
      case 'id': case 'databaseId': case 'name': case 'nameWithOwner': case 'owner': case 'description': case 'isPrivate':
        return source[field] ?? null;
      case 'defaultBranchRef': {
        const tip = forge.refTip(repo, `refs/heads/${repo.defaultBranch}`);
        return tip === null ? null : { __typename: 'Ref', name: repo.defaultBranch };
      }
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'issue': {
        const issue = forge.getIssue(repo, args.number);
        return issue === null ? null : this.issueValue(repo, issue);
      }
      case 'issues': return this.issuesConnection(repo, args);
      case 'pullRequests': {
        const { items } = forge.listPulls(repo, { state: 'open', perPage: args.first ?? 30, page: 1 });
        return {
          __typename: 'PullRequestConnection',
          nodes: items.slice(0, args.first ?? 30).map((pull) => this.pullRequestValue(repo, pull)),
          pageInfo: { __typename: 'PageInfo', hasNextPage: false, endCursor: null },
        };
      }
      case 'pullRequest': {
        const pull = forge.getPull(repo, args.number);
        return pull === null ? null : this.pullRequestValue(repo, pull);
      }
      default: return source[field] ?? null;
    }
  }

  issuesConnection(repo, args) {
    const states = Array.isArray(args.states) ? args.states : null;
    const stateFilter = states === null ? 'all' : states.includes('OPEN') && states.includes('CLOSED') ? 'all' : states.includes('OPEN') ? 'open' : 'closed';
    const orderBy = args.orderBy ?? {};
    const direction = orderBy.direction === 'ASC' ? 'asc' : 'desc';
    const { items: all } = this.forge.listIssues(repo, { state: stateFilter, sort: 'created', direction, perPage: 100000, page: 1 });
    let start = 0;
    if (typeof args.after === 'string' && args.after !== '') {
      try {
        const decoded = Buffer.from(args.after, 'base64url').toString('utf8');
        const number = Number.parseInt(decoded.slice('cursor:'.length), 10);
        const index = all.findIndex((issue) => issue.number === number);
        if (index >= 0) start = index + 1;
      } catch { /* an unknown cursor starts at the beginning */ }
    }
    const first = typeof args.first === 'number' ? args.first : 30;
    const page = all.slice(start, start + first);
    const endCursor = page.length > 0
      ? Buffer.from(`cursor:${page[page.length - 1].number}`, 'utf8').toString('base64url')
      : null;
    return {
      __typename: 'IssueConnection',
      nodes: page.map((issue) => this.issueValue(repo, issue)),
      pageInfo: {
        __typename: 'PageInfo',
        hasNextPage: start + first < all.length,
        endCursor,
      },
    };
  }

  issueValue(repo, issue) {
    return {
      __typename: 'Issue',
      __repo: repo,
      __issue: issue,
      id: globalId('I', repo.owner, repo.name, String(issue.number)),
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    };
  }

  issueField(source, field) {
    return source[field] ?? null;
  }

  pullRequestValue(repo, pull) {
    return {
      __typename: 'PullRequest',
      __repo: repo,
      __pull: pull,
      id: globalId('P', repo.owner, repo.name, String(pull.number)),
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state === 'open' ? 'OPEN' : pull.merged ? 'MERGED' : 'CLOSED',
      merged: pull.merged,
      headRefName: pull.headRef,
      baseRefName: pull.baseRef,
    };
  }

  pullRequestField(source, field, args) {
    const repo = source.__repo;
    const pull = source.__pull;
    const forge = this.forge;
    if (field === 'mergeable') return forge.pullMergeable(repo, pull);
    if (field === 'files') {
      const files = forge.pullFiles(repo, pull);
      const first = typeof args.first === 'number' ? args.first : 30;
      return {
        __typename: 'PullRequestChangedFileConnection',
        nodes: files.slice(0, first).map((file) => ({ __typename: 'PullRequestChangedFile', path: file.filename, additions: file.additions, deletions: file.deletions })),
        pageInfo: { __typename: 'PageInfo', hasNextPage: files.length > first, endCursor: null },
      };
    }
    return source[field] ?? null;
  }

  nodeValue(id) {
    if (typeof id !== 'string') return null;
    const { kind, parts } = parseGlobalId(id);
    const forge = this.forge;
    if (kind === 'R' && parts.length >= 2) {
      const repo = forge.getRepo(parts[0], parts[1]);
      return repo === null ? null : this.repositoryValue(repo);
    }
    if (kind === 'I' && parts.length >= 3) {
      const repo = forge.getRepo(parts[0], parts[1]);
      if (repo === null) return null;
      const issue = forge.getIssue(repo, Number.parseInt(parts[2], 10));
      return issue === null ? null : this.issueValue(repo, issue);
    }
    if (kind === 'P' && parts.length >= 3) {
      const repo = forge.getRepo(parts[0], parts[1]);
      if (repo === null) return null;
      const pull = forge.getPull(repo, Number.parseInt(parts[2], 10));
      return pull === null ? null : this.pullRequestValue(repo, pull);
    }
    return null;
  }

  mutationValue(field, args, ctx) {
    const forge = this.forge;
    const input = args.input ?? {};
    if (field === 'createIssue') {
      const { kind, parts } = parseGlobalId(input.repositoryId ?? '');
      if (kind !== 'R' || parts.length < 2) throw new GraphQLError('createIssue: unknown repositoryId');
      const repo = forge.getRepo(parts[0], parts[1]);
      if (repo === null) throw new GraphQLError('createIssue: repository not found');
      const created = forge.createIssue(repo, { title: input.title ?? '', body: input.body ?? '', labels: [] });
      if (created.error) throw new GraphQLError(`createIssue: ${created.error}`);
      return { __typename: 'CreateIssuePayload', issue: this.issueValue(repo, created.issue) };
    }
    if (field === 'closeIssue') {
      const { kind, parts } = parseGlobalId(input.issueId ?? '');
      if (kind !== 'I' || parts.length < 3) throw new GraphQLError('closeIssue: unknown issueId');
      const repo = forge.getRepo(parts[0], parts[1]);
      if (repo === null) throw new GraphQLError('closeIssue: repository not found');
      const issue = forge.getIssue(repo, Number.parseInt(parts[2], 10));
      if (issue === null) throw new GraphQLError('closeIssue: issue not found');
      issue.state = 'closed';
      forge.invalidateIssueView(repo, issue); // the cached REST view must not keep "open"
      return { __typename: 'CloseIssuePayload', issue: this.issueValue(repo, issue) };
    }
    if (field === 'createPullRequest') {
      const { kind, parts } = parseGlobalId(input.repositoryId ?? '');
      if (kind !== 'R' || parts.length < 2) throw new GraphQLError('createPullRequest: unknown repositoryId');
      const repo = forge.getRepo(parts[0], parts[1]);
      if (repo === null) throw new GraphQLError('createPullRequest: repository not found');
      const created = forge.createPull(repo, {
        title: input.title ?? '',
        body: input.body ?? '',
        head: input.headRefName ?? '',
        base: input.baseRefName ?? repo.defaultBranch,
      });
      if (created.error) throw new GraphQLError(`createPullRequest: ${created.error}`);
      return { __typename: 'CreatePullRequestPayload', pullRequest: this.pullRequestValue(repo, created.pull) };
    }
    if (field === 'mergePullRequest') {
      const { kind, parts } = parseGlobalId(input.pullRequestId ?? '');
      if (kind !== 'P' || parts.length < 3) throw new GraphQLError('mergePullRequest: unknown pullRequestId');
      const repo = forge.getRepo(parts[0], parts[1]);
      if (repo === null) throw new GraphQLError('mergePullRequest: repository not found');
      const pull = forge.getPull(repo, Number.parseInt(parts[2], 10));
      if (pull === null) throw new GraphQLError('mergePullRequest: pull request not found');
      const merged = forge.mergePull(repo, pull);
      if (merged.conflict) throw new GraphQLError('mergePullRequest: merge conflict');
      if (merged.error) throw new GraphQLError(`mergePullRequest: ${merged.error}`);
      return { __typename: 'MergePullRequestPayload', pullRequest: this.pullRequestValue(repo, pull) };
    }
    if (field === 'addComment') {
      const { kind, parts } = parseGlobalId(input.subjectId ?? '');
      if (kind !== 'I' || parts.length < 3) throw new GraphQLError('addComment: unknown subjectId');
      const repo = forge.getRepo(parts[0], parts[1]);
      if (repo === null) throw new GraphQLError('addComment: repository not found');
      const issue = forge.getIssue(repo, Number.parseInt(parts[2], 10));
      if (issue === null) throw new GraphQLError('addComment: issue not found');
      const comment = forge.addComment(repo, issue, input.body ?? '');
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'IssueCommentEdge',
          node: { __typename: 'IssueComment', id: globalId('C', repo.owner, repo.name, String(issue.number), String(comment.id)), body: comment.body },
        },
      };
    }
    throw new GraphQLError(`unknown mutation ${field}`);
  }
}
