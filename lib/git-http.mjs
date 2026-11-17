// Git smart HTTP: info/refs advertisements (v0 and v2), upload-pack
// (ls-refs and fetch, v2 and v0) and receive-pack. The fetch response is a pure
// function of the repo's objects plus the request arguments, so the whole
// response bytes are cached per repo revision.
//
// PROTOCOL FIX: the `acknowledgments` section is sent ONLY when the request
// carries haves. Sending it unconditionally breaks real `git clone` with
// "fatal: expected 'packfile', received 'acknowledgments'".

import {
  buildPack, readPack, splitPktLines, pktLine, pktFlush, pktDelim, pktText,
  TYPE_COMMIT, TYPE_TAG,
} from './gitobj.mjs';
import { ZERO_OID, validOid } from './util.mjs';

const AGENT = 'forge/1.0';
const UPLOAD_CAPS_V0 = `side-band-64k multi_ack multi_ack_detailed thin-pack ofs-delta shallow symref=HEAD:refs/heads/main agent=${AGENT}`;
const RECEIVE_CAPS_V0 = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

function sideband(data, band) {
  const chunks = [];
  for (let i = 0; i < data.length; i += 65515) {
    chunks.push(pktLine(Buffer.concat([Buffer.from([band]), data.subarray(i, i + 65515)])));
  }
  return Buffer.concat(chunks);
}

function refList(forge, repo) {
  const out = [];
  const tip = forge.defaultTip(repo);
  out.push({ oid: tip || ZERO_OID, name: 'HEAD', symref: 'refs/heads/main' });
  for (const branch of forge.branchNames(repo)) {
    out.push({ oid: forge.refOid(repo, `refs/heads/${branch}`), name: `refs/heads/${branch}` });
  }
  const tags = [...repo.refs.keys()].filter((r) => r.startsWith('refs/tags/')).sort();
  for (const ref of tags) {
    const oid = repo.refs.get(ref);
    const peeled = forge.peelCommit(repo, oid);
    out.push({ oid, name: ref, peeled: peeled && peeled !== oid ? peeled : null });
  }
  return out;
}

function advertisementV2Upload() {
  return Buffer.concat([
    pktLine(Buffer.from('version 2\n', 'utf8')),
    pktLine(Buffer.from('fetch=shallow wait-for-done\n', 'utf8')),
    pktLine(Buffer.from('ls-refs=unborn\n', 'utf8')),
    pktLine(Buffer.from(`agent=${AGENT}\n`, 'utf8')),
    pktLine(Buffer.from('object-format=sha1\n', 'utf8')),
    pktFlush(),
  ]);
}

function advertisementV0(forge, repo, service, caps) {
  const refs = refList(forge, repo);
  const parts = [pktLine(Buffer.from(`# service=${service}\n`, 'utf8')), pktFlush()];
  if (!refs[0].oid || refs[0].oid === ZERO_OID) {
    parts.push(pktLine(Buffer.from(`${ZERO_OID} capabilities^{}\0${caps}\n`, 'utf8')));
  } else {
    parts.push(pktLine(Buffer.from(`${refs[0].oid} HEAD\0${caps}\n`, 'utf8')));
    for (let i = 1; i < refs.length; i++) {
      const r = refs[i];
      parts.push(pktLine(Buffer.from(`${r.oid} ${r.name}\n`, 'utf8')));
      if (r.peeled) parts.push(pktLine(Buffer.from(`${r.peeled} ${r.name}^{}\n`, 'utf8')));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export function infoRefs(forge, repo, service, req) {
  if (!repo) return { status: 404, body: Buffer.from(JSON.stringify({ message: 'repository not found' }), 'utf8'), type: 'application/json' };
  if (service === 'git-upload-pack') {
    const proto = (req.headers['git-protocol'] || '').trim();
    if (proto === 'version=2') {
      return { status: 200, body: advertisementV2Upload(), type: 'application/x-git-upload-pack-advertisement' };
    }
    return { status: 200, body: advertisementV0(forge, repo, service, UPLOAD_CAPS_V0), type: 'application/x-git-upload-pack-advertisement' };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, body: advertisementV0(forge, repo, service, RECEIVE_CAPS_V0), type: 'application/x-git-receive-pack-advertisement' };
  }
  return { status: 400, body: Buffer.from(JSON.stringify({ message: 'unknown service' }), 'utf8'), type: 'application/json' };
}

// ---- ls-refs (v2) ----

function lsRefsResponse(forge, repo, prefixes) {
  const lines = [];
  // HEAD is a line of the reply like any other: it is included only when it
  // matches a requested ref-prefix (real clients ask for the literal prefix
  // "HEAD"; a prefix of refs/heads/ does not match it) or when no prefix
  // was given at all.
  if (prefixes.length === 0 || prefixes.some((p) => 'HEAD'.startsWith(p))) {
    const tip = forge.defaultTip(repo);
    if (!tip) {
      lines.push('unborn HEAD symref-target:refs/heads/main');
    } else {
      lines.push(`${tip} HEAD symref-target:refs/heads/main`);
    }
  }
  const refs = refList(forge, repo).slice(1);
  for (const r of refs) {
    if (prefixes.length && !prefixes.some((p) => r.name.startsWith(p))) continue;
    let line = `${r.oid} ${r.name}`;
    if (r.peeled) line += ` peeled:${r.peeled}`;
    lines.push(line);
  }
  const parts = lines.map((l) => pktLine(Buffer.from(`${l}\n`, 'utf8')));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---- fetch ----

function ackLines(forge, repo, wants, haves) {
  const lines = [];
  let any = false;
  for (const have of haves) {
    if (!forge.hasObject(repo, have)) continue;
    const ok = wants.some((w) => forge.isAncestor(repo, have, w));
    if (ok) { lines.push(`ACK ${have}`); any = true; }
  }
  if (!any) lines.push('NAK');
  return lines;
}

function fetchResponse(forge, repo, wants, haves, shallows, deepen, version) {
  const key = JSON.stringify({ w: wants, h: haves, s: shallows, d: deepen, v: version });
  const cached = repo.fetchCache.get(key);
  if (cached && cached.rev === repo.rev) return cached.buf;
  const { objects, shallow, unshallow } = forge.fetchSet(repo, wants, haves, shallows, deepen);
  const pack = buildPack([...objects.values()]);
  const parts = [];
  const acks = haves.length > 0 ? ackLines(forge, repo, wants, haves) : null;
  if (version === 2) {
    if (acks) {
      parts.push(pktLine(Buffer.from('acknowledgments\n', 'utf8')));
      for (const line of acks) parts.push(pktLine(Buffer.from(`${line}\n`, 'utf8')));
      parts.push(pktDelim());
    }
    if (shallow.length || unshallow.length) {
      parts.push(pktLine(Buffer.from('shallow-info\n', 'utf8')));
      for (const oid of shallow) parts.push(pktLine(Buffer.from(`shallow ${oid}\n`, 'utf8')));
      for (const oid of unshallow) parts.push(pktLine(Buffer.from(`unshallow ${oid}\n`, 'utf8')));
      parts.push(pktDelim());
    }
    if (wants.length > 0) {
      parts.push(pktLine(Buffer.from('packfile\n', 'utf8')));
      parts.push(sideband(pack, 1));
    }
    parts.push(pktFlush());
  } else {
    // Protocol v0 always opens the fetch reply with ACK/NAK lines, even when
    // the client sent no haves (then it is a bare NAK). Without one, a real
    // client rejects the reply with "expected ACK/NAK".
    const acks = ackLines(forge, repo, wants, haves);
    for (const line of acks) parts.push(pktLine(Buffer.from(`${line}\n`, 'utf8')));
    for (const oid of shallow) parts.push(pktLine(Buffer.from(`shallow ${oid}\n`, 'utf8')));
    for (const oid of unshallow) parts.push(pktLine(Buffer.from(`unshallow ${oid}\n`, 'utf8')));
    if (wants.length > 0) parts.push(sideband(pack, 1));
    parts.push(pktFlush());
  }
  const buf = Buffer.concat(parts);
  repo.fetchCache.set(key, { rev: repo.rev, buf });
  return buf;
}

function firstToken(line) { return line.split(/\s+/)[0] || ''; }

function parseFetchV2(lines) {
  const out = { wants: [], haves: [], shallows: [], deepen: 0 };
  let inArgs = false;
  for (const entry of lines) {
    if (entry.special === 1) { inArgs = true; continue; }
    if (entry.special !== undefined) continue;
    const text = entry.data.toString('utf8').trim();
    if (!inArgs) continue;
    if (text.startsWith('want ')) out.wants.push(firstToken(text.slice(5)));
    else if (text.startsWith('have ')) out.haves.push(firstToken(text.slice(5)));
    else if (text.startsWith('shallow ')) out.shallows.push(firstToken(text.slice(8)));
    else if (text.startsWith('deepen ')) out.deepen = Number(text.slice(7).trim()) || 0;
  }
  return out;
}

function parseFetchV0(lines) {
  const out = { wants: [], haves: [], shallows: [], deepen: 0 };
  let section = 0;
  for (const entry of lines) {
    if (entry.special === 0) { section++; continue; }
    if (entry.special !== undefined) continue;
    const text = entry.data.toString('utf8').trim();
    if (section === 0) {
      if (text.startsWith('want ')) out.wants.push(firstToken(text.slice(5)));
      else if (text.startsWith('shallow ')) out.shallows.push(firstToken(text.slice(8)));
      else if (text.startsWith('deepen ')) out.deepen = Number(text.slice(7).trim()) || 0;
    } else if (text.startsWith('have ')) {
      out.haves.push(firstToken(text.slice(5)));
    }
  }
  return out;
}

export function uploadPack(forge, repo, req, body) {
  if (!repo) return { status: 404, body: Buffer.from(JSON.stringify({ message: 'repository not found' }), 'utf8'), type: 'application/json' };
  const proto = (req.headers['git-protocol'] || '').trim();
  const lines = splitPktLines(body);
  if (!lines) return { status: 400, body: Buffer.from(JSON.stringify({ message: 'malformed request' }), 'utf8'), type: 'application/json' };
  if (proto === 'version=2') {
    const first = lines.find((e) => e.data)?.data.toString('utf8') || '';
    if (first.startsWith('command=ls-refs')) {
      const prefixes = [];
      for (const entry of lines) {
        if (entry.data) {
          const text = entry.data.toString('utf8').trim();
          if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
        }
      }
      return { status: 200, body: lsRefsResponse(forge, repo, prefixes), type: 'application/x-git-upload-pack-result' };
    }
    if (first.startsWith('command=fetch')) {
      const args = parseFetchV2(lines);
      return { status: 200, body: fetchResponse(forge, repo, args.wants, args.haves, args.shallows, args.deepen, 2), type: 'application/x-git-upload-pack-result' };
    }
    return { status: 400, body: Buffer.from(JSON.stringify({ message: 'unknown command' }), 'utf8'), type: 'application/json' };
  }
  const args = parseFetchV0(lines);
  return { status: 200, body: fetchResponse(forge, repo, args.wants, args.haves, args.shallows, args.deepen, 0), type: 'application/x-git-upload-pack-result' };
}

// ---- receive-pack ----

function closureComplete(forge, repo, oid) {
  const start = forge.peelCommit(repo, oid);
  if (!start && !forge.hasObject(repo, oid)) return false;
  const seenCommits = new Set();
  const stack = start ? [start] : [];
  const checkTree = (treeOid) => {
    const entries = forge.treeOf(repo, treeOid);
    if (!entries) return false;
    for (const e of entries) {
      if (e.mode === '160000') continue;
      if (!forge.hasObject(repo, e.oid)) return false;
      if (e.dir && !checkTree(e.oid)) return false;
    }
    return true;
  };
  while (stack.length) {
    const cur = stack.pop();
    if (seenCommits.has(cur)) continue;
    seenCommits.add(cur);
    const commit = forge.commitOf(repo, cur);
    if (!commit) return false;
    if (!forge.hasObject(repo, commit.tree) || !checkTree(commit.tree)) return false;
    for (const p of commit.parents) {
      if (!forge.hasObject(repo, p)) return false;
      stack.push(p);
    }
  }
  return true;
}

export function receivePack(forge, repo, req, body) {
  if (!repo) return { status: 404, body: Buffer.from(JSON.stringify({ message: 'repository not found' }), 'utf8'), type: 'application/json' };
  // Walk pkt-lines from the start until the first flush; everything after it
  // is the pack, raw bytes that must never be parsed as pkt-lines.
  const commands = [];
  let pos = 0;
  let packOffset = null;
  while (pos + 4 <= body.length) {
    const head = body.toString('utf8', pos, pos + 4);
    if (head === '0000') { packOffset = pos + 4; break; }
    if (head === '0001' || head === '0002') { pos += 4; continue; }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || pos + len > body.length) {
      return { status: 400, body: Buffer.from(JSON.stringify({ message: 'malformed request' }), 'utf8'), type: 'application/json' };
    }
    const text = body.toString('utf8', pos + 4, pos + len);
    const nul = text.indexOf('\0');
    const clean = (nul === -1 ? text : text.slice(0, nul)).trim();
    const parts = clean.split(/\s+/);
    if (parts.length === 3 && validOid(parts[0]) && validOid(parts[1])) {
      commands.push({ old: parts[0], next: parts[1], ref: parts[2] });
    }
    pos += len;
  }
  if (packOffset === null) {
    return { status: 400, body: Buffer.from(JSON.stringify({ message: 'malformed request' }), 'utf8'), type: 'application/json' };
  }
  const packBytes = body.subarray(packOffset);
  let unpackOk = true;
  if (packBytes.length > 0) {
    const parsed = readPack(packBytes, (oid) => forge.getObject(repo, oid));
    if (!parsed) {
      unpackOk = false;
    } else {
      for (const [oid, obj] of parsed.objects) {
        if (!forge.hasObject(repo, oid)) forge.putObject(repo, obj.type, obj.body);
      }
    }
  }
  const results = [];
  if (unpackOk) {
    for (const cmd of commands) {
      if (cmd.next !== ZERO_OID && !closureComplete(forge, repo, cmd.next)) { unpackOk = false; break; }
    }
  }
  if (unpackOk) {
    for (const cmd of commands) {
      const current = forge.refOid(repo, cmd.ref);
      if (cmd.old === ZERO_OID && cmd.next === ZERO_OID) { results.push({ ref: cmd.ref, ok: false, reason: 'invalid command' }); continue; }
      if (cmd.old === ZERO_OID) {
        // create
        if (current) { results.push({ ref: cmd.ref, ok: false, reason: 'already exists' }); continue; }
        forge.setRef(repo, cmd.ref, cmd.next);
        results.push({ ref: cmd.ref, ok: true });
      } else if (cmd.next === ZERO_OID) {
        // delete
        if (!current || current !== cmd.old) { results.push({ ref: cmd.ref, ok: false, reason: 'stale info' }); continue; }
        forge.deleteRef(repo, cmd.ref);
        results.push({ ref: cmd.ref, ok: true });
      } else {
        // update
        if (!current || current !== cmd.old) { results.push({ ref: cmd.ref, ok: false, reason: 'stale info' }); continue; }
        // Linear-push fast path: a new commit whose only parent is the old tip
        // is a fast-forward by construction, no ancestry walk needed.
        let fastForward = false;
        const newCommit = forge.commitOf(repo, cmd.next);
        if (newCommit && newCommit.parents.length === 1 && newCommit.parents[0] === current) fastForward = true;
        else if (cmd.next === current) fastForward = true;
        else fastForward = forge.isAncestor(repo, current, cmd.next);
        if (!fastForward) { results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' }); continue; }
        forge.setRef(repo, cmd.ref, cmd.next);
        results.push({ ref: cmd.ref, ok: true });
      }
    }
  } else {
    for (const cmd of commands) results.push({ ref: cmd.ref, ok: false, reason: 'unpack error' });
  }
  const report = [pktLine(Buffer.from(unpackOk ? 'unpack ok\n' : 'unpack error\n', 'utf8'))];
  for (const r of results) {
    report.push(pktLine(Buffer.from(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`, 'utf8')));
  }
  report.push(pktFlush());
  const bodyOut = Buffer.concat([sideband(Buffer.concat(report), 1), pktFlush()]);
  return { status: 200, body: bodyOut, type: 'application/x-git-receive-pack-result' };
}
