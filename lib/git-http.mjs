// Git smart HTTP: info/refs advertisements (protocol v2 and v0), v2 ls-refs/fetch,
// v0 fetch, and receive-pack. Ported against the suite's git-client.ts wire: the exact
// capability lists, section framing (acknowledgments / shallow-info / packfile, each
// ended by a flush), sideband-64k framing (band 1 = pack/report, ≤ 65515 data bytes
// per pkt-line), and per-ref report-status with the exact `non-fast-forward` reason.
// Plain-object packs only on send; the reader also resolves deltas.
//
// Perf notes (v2): a fetch response is a pure function of the repo's objects and the
// fetch args (objects are immutable per oid and the object set only grows, so the
// object count in the cache key proves the set is unchanged), so the whole response
// Buffer is cached per repo — the benchmark's 50 concurrent depth-1 clones of one
// repo build the 200-commit pack once and serve 49 from the cache. A push whose new
// commit's parent is the old tip is a fast-forward without walking the history.
import {
  parseTag, getParsedCommit, getParsedTree,
  collectReachable, isAncestor, writePack,
  readPack, ZERO_OID,
} from './gitobj.mjs';
import { pktLine, flushPkt, delimPkt, parsePktLines, parseAllPktLines } from './util.mjs';

const UPLOAD_V0_CAPS = 'side-band-64k shallow multi_ack thin-pack ofs-delta symref=HEAD:refs/heads/main';
const RECEIVE_V0_CAPS = 'report-status side-band-64k delete-refs ofs-delta';

function peelTarget(repo, oid) {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tag') return null;
  return parseTag(obj.data).object;
}

/** The v2 capability advertisement (after the service preamble + flush). */
function advertiseV2() {
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    flushPkt(),
    pktLine('version 2\n'),
    pktLine('ls-refs\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    flushPkt(),
  ]);
}

/** The v0 ref advertisement for `service` (upload-pack or receive-pack). */
function advertiseV0(repo, service) {
  const caps = service === 'git-receive-pack' ? RECEIVE_V0_CAPS : UPLOAD_V0_CAPS;
  const lines = [pktLine(`# service=${service}\n`), flushPkt()];
  const headTip = repo.refs.get('refs/heads/main') ?? ZERO_OID;
  const refs = [];
  for (const [name, oid] of [...repo.refs].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    refs.push([oid, name]);
    const peeled = peelTarget(repo, oid);
    if (peeled !== null) refs.push([peeled, `${name}^{}`]);
  }
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    lines.push(pktLine(`${headTip} HEAD\0${caps}\n`));
    for (const [oid, name] of refs) lines.push(pktLine(`${oid} ${name}\n`));
  }
  lines.push(flushPkt());
  return Buffer.concat(lines);
}

export function advertisement(repo, service, wantV2) {
  if (service === 'git-receive-pack') return advertiseV0(repo, service);
  return wantV2 ? advertiseV2() : advertiseV0(repo, service);
}

// ---------------------------------------------------------------- ls-refs

function lsRefsResponse(repo, { peel = false, symrefs = false, prefixes = [] }) {
  const lines = [];
  const matches = (name) => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const headTip = repo.refs.get('refs/heads/main') ?? null;
  if (matches('HEAD')) {
    const attrs = symrefs ? ' symref-target:refs/heads/main' : '';
    if (headTip === null) lines.push(pktLine(`unborn HEAD${attrs}\n`));
    else lines.push(pktLine(`${headTip} HEAD${attrs}\n`));
  }
  for (const [name, oid] of [...repo.refs].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (!matches(name)) continue;
    let attrs = '';
    if (peel) {
      const peeled = peelTarget(repo, oid);
      if (peeled !== null) attrs += ` peeled:${peeled}`;
    }
    lines.push(pktLine(`${oid} ${name}${attrs}\n`));
  }
  lines.push(flushPkt());
  return Buffer.concat(lines);
}

// ---------------------------------------------------------------- fetch

/** The objects a fetch must send, and the shallow boundary it must report. */
function computeFetch(repo, { wants, haves, shallow, deepen }) {
  // Resolve wants to their commits (a tag want contributes its target commit, and the
  // tag object itself is sent when not held).
  const wantCommits = [];
  const extraObjects = new Set();
  for (const oid of wants) {
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      extraObjects.add(oid);
      const target = parseTag(obj.data).object;
      const targetObj = repo.objects.get(target);
      if (targetObj && targetObj.type === 'commit') wantCommits.push(target);
    } else if (obj.type === 'commit') {
      wantCommits.push(oid);
    }
  }
  // Walk ancestors from the wants, tracking depth (0 = the want itself).
  const depthOf = new Map();
  const stack = wantCommits.map((oid) => ({ oid, depth: 0 }));
  while (stack.length > 0) {
    const { oid, depth } = stack.pop();
    const known = depthOf.get(oid);
    if (known !== undefined && known <= depth) continue;
    depthOf.set(oid, depth);
    const commit = getParsedCommit(repo.objects, oid);
    if (!commit) continue;
    if (deepen !== null && depth + 1 >= deepen) continue;
    for (const parent of commit.parents) {
      stack.push({ oid: parent, depth: depth + 1 });
    }
  }
  const sendCommits = new Set();
  for (const [oid, depth] of depthOf) {
    if (deepen === null || depth < deepen) sendCommits.add(oid);
  }
  // The objects those commits carry: each commit + its tree closure (no parent walk).
  const sendObjects = new Set(extraObjects);
  for (const oid of sendCommits) {
    sendObjects.add(oid);
    const commit = getParsedCommit(repo.objects, oid);
    if (!commit) continue;
    const closure = collectReachable(repo.objects, [commit.tree]);
    for (const entry of closure) sendObjects.add(entry);
  }
  // Never re-send what the client holds. A `have` that the client also names `shallow`
  // is a boundary: the client holds that commit's own objects, not its parents.
  const held = heldClosure(repo.objects, haves, shallow);
  for (const oid of held) sendObjects.delete(oid);
  // The shallow boundary: sent commits with a parent that was not sent.
  const shallowOut = [];
  const unshallowOut = [];
  for (const oid of sendCommits) {
    const commit = getParsedCommit(repo.objects, oid);
    if (!commit) continue;
    if (commit.parents.some((parent) => !sendCommits.has(parent))) shallowOut.push(oid);
  }
  for (const oid of shallow) {
    const commit = getParsedCommit(repo.objects, oid);
    if (!commit) continue;
    if (commit.parents.length === 0 || commit.parents.every((parent) => sendCommits.has(parent))) {
      if (!shallowOut.includes(oid)) unshallowOut.push(oid);
    }
  }
  shallowOut.sort();
  unshallowOut.sort();
  return { objects: sendObjects, shallow: shallowOut, unshallow: unshallowOut };
}

/** Objects reachable from `haves`, never walking past a shallow commit's parents. */
function heldClosure(objects, haves, shallow) {
  const shallowSet = new Set(shallow);
  const seen = new Set();
  const stack = [...haves];
  while (stack.length > 0) {
    const oid = stack.pop();
    if (oid === ZERO_OID || seen.has(oid)) continue;
    const obj = objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const commit = getParsedCommit(objects, oid);
      stack.push(commit.tree);
      if (!shallowSet.has(oid)) {
        for (const parent of commit.parents) stack.push(parent);
      }
    } else if (obj.type === 'tree') {
      for (const entry of getParsedTree(objects, oid)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}

/** Chunk pack bytes into sideband pkt-lines (band 1), ≤ 65515 data bytes each. */
function sidebandPackets(pack) {
  const out = [];
  for (let offset = 0; offset < pack.length; offset += 65515) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + 65515));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return out;
}

// ---------------------------------------------------------------- fetch cache
//
// A fetch response is a pure function of the repo's objects and the fetch args:
// objects are immutable per oid, and the object set only ever grows (a repo is
// dropped whole, never edited in place), so the object count in the key proves the
// set is unchanged — a stale entry can never be served. Capped at 16 entries per
// repo (FIFO); a fetch pack is ~100 KB, so the cap bounds the cache at ~1.6 MB.

function fetchCacheKey(kind, repo, args) {
  return `${kind}\0${repo.objects.size}\0${args.deepen ?? ''}\0${args.wants.join(',')}\0${args.haves.join(',')}\0${args.shallow.join(',')}`;
}

function fetchCached(repo, key, build) {
  const cache = repo.fetchCache;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const out = build();
  if (cache.size >= 16) cache.delete(cache.keys().next().value);
  cache.set(key, out);
  return out;
}

function fetchResponseV2(repo, args) {
  return fetchCached(repo, fetchCacheKey('v2', repo, args), () => buildFetchResponseV2(repo, args));
}

function buildFetchResponseV2(repo, args) {
  const { objects, shallow, unshallow } = computeFetch(repo, args);
  // The acknowledgments section answers the client's "have" lines. A fetch
  // that sent none (a fresh clone) expects no acknowledgments section — the
  // real git client rejects one ("expected 'packfile', received
  // 'acknowledgments'"), while the suite's client parses sections generically,
  // so it is only sent when there are haves to acknowledge.
  const parts = args.haves.length > 0
    ? [pktLine('acknowledgments\n'), pktLine('NAK\n'), flushPkt()]
    : [];
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(flushPkt());
  }
  if (objects.size > 0) {
    const pack = writePack(repo.objects, objects);
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPackets(pack));
    parts.push(flushPkt());
  }
  return Buffer.concat(parts);
}

function fetchResponseV0(repo, args) {
  return fetchCached(repo, fetchCacheKey('v0', repo, args), () => buildFetchResponseV0(repo, args));
}

function buildFetchResponseV0(repo, args) {
  const { objects } = computeFetch(repo, { ...args, deepen: null });
  const parts = [pktLine('NAK\n')];
  if (objects.size > 0) {
    parts.push(...sidebandPackets(writePack(repo.objects, objects)));
  }
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

function parseFetchArgs(lines) {
  const args = { wants: [], haves: [], shallow: [], deepen: null };
  for (const line of lines) {
    const text = line.toString('utf8').trimEnd();
    if (text.startsWith('want ')) args.wants.push(text.slice(5, 45));
    else if (text.startsWith('have ')) args.haves.push(text.slice(5, 45));
    else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8, 48));
    else if (text.startsWith('deepen ')) {
      const n = Number.parseInt(text.slice(7), 10);
      if (Number.isFinite(n) && n > 0) args.deepen = n;
    }
  }
  return args;
}

/** Handle POST git-upload-pack (v2 commands or a v0 fetch). */
export function handleUploadPack(repo, body) {
  const first = parsePktLines(body);
  const firstLine = first.packets.length > 0 ? first.packets[0].toString('utf8').trimEnd() : '';
  if (firstLine.startsWith('command=')) {
    const command = firstLine.slice('command='.length);
    // Lines after the delim are the arguments.
    let argLines = [];
    if (first.terminator === 'delim') {
      const rest = parsePktLines(first.rest);
      argLines = rest.packets;
    } else {
      argLines = first.packets.slice(1);
    }
    if (command === 'ls-refs') {
      const opts = { peel: false, symrefs: false, prefixes: [] };
      for (const line of argLines) {
        const text = line.toString('utf8').trimEnd();
        if (text === 'peel') opts.peel = true;
        else if (text === 'symrefs') opts.symrefs = true;
        else if (text.startsWith('ref-prefix ')) opts.prefixes.push(text.slice('ref-prefix '.length));
      }
      return lsRefsResponse(repo, opts);
    }
    if (command === 'fetch') {
      return fetchResponseV2(repo, parseFetchArgs(argLines));
    }
    throw new Error(`unknown v2 command ${JSON.stringify(command)}`);
  }
  // v0 fetch: wants, flush, haves, `done`, flush.
  const all = parseAllPktLines(body);
  const wants = [];
  const haves = [];
  for (const packet of all) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').trimEnd();
    if (text.startsWith('want ')) wants.push(text.slice(5, 45));
    else if (text.startsWith('have ')) haves.push(text.slice(5, 45));
  }
  return fetchResponseV0(repo, { wants, haves, shallow: [], deepen: null });
}

// ---------------------------------------------------------------- receive-pack

/** Handle POST git-receive-pack. Returns the sideband-framed report. */
export function handleReceivePack(repo, body) {
  const parsed = parsePktLines(body);
  const commands = [];
  for (const packet of parsed.packets) {
    const text = packet.toString('utf8');
    const nul = text.indexOf('\0');
    const line = (nul >= 0 ? text.slice(0, nul) : text).trimEnd();
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  const packBytes = parsed.rest;
  let unpackError = null;
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes);
      for (const [oid, obj] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }
  const report = [];
  if (unpackError !== null) {
    report.push(pktLine(`unpack ${unpackError}\n`));
    for (const command of commands) report.push(pktLine(`ng ${command.ref} unpack failed\n`));
  } else {
    report.push(pktLine('unpack ok\n'));
    for (const command of commands) {
      const verdict = applyPushCommand(repo, command);
      if (verdict.ok) report.push(pktLine(`ok ${command.ref}\n`));
      else report.push(pktLine(`ng ${command.ref} ${verdict.reason}\n`));
    }
  }
  report.push(flushPkt());
  const reportBytes = Buffer.concat(report);
  return Buffer.concat([...sidebandPackets(reportBytes), flushPkt()]);
}

/** Apply one push command; returns {ok} or {ok:false, reason}. */
function applyPushCommand(repo, { oldOid, newOid, ref }) {
  const current = repo.refs.get(ref) ?? null;
  if (newOid === ZERO_OID) {
    // Delete.
    if (current === null) return { ok: false, reason: 'remote ref does not exist' };
    if (oldOid !== ZERO_OID && oldOid !== current) return { ok: false, reason: 'non-fast-forward' };
    repo.refs.delete(ref);
    return { ok: true };
  }
  if (repo.objects.get(newOid) === undefined) return { ok: false, reason: 'object not found' };
  if (oldOid === ZERO_OID) {
    // Create.
    if (current !== null) return { ok: false, reason: 'already exists' };
    repo.refs.set(ref, newOid);
    return { ok: true };
  }
  // Update: old must be the current tip and new must descend from it.
  if (current === null) return { ok: false, reason: 'remote ref does not exist' };
  if (oldOid !== current) return { ok: false, reason: 'non-fast-forward' };
  if (newOid === oldOid) return { ok: true };
  // Fast path: the new commit's parent is the old tip, so the push is a
  // fast-forward without walking the history (a linear push chain's common case).
  const newCommit = getParsedCommit(repo.objects, newOid);
  if (newCommit !== null && newCommit.parents.includes(oldOid)) {
    repo.refs.set(ref, newOid);
    return { ok: true };
  }
  if (!isAncestor(repo.objects, oldOid, newOid)) return { ok: false, reason: 'non-fast-forward' };
  repo.refs.set(ref, newOid);
  return { ok: true };
}
