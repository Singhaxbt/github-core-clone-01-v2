// Git objects: SHA-1 hashing, object encoding/decoding, packfile read/write and the
// pkt-line wire codec. Objects are immutable, so callers may cache parses freely.

import { createHash } from 'node:crypto';
import { deflateSync as zlibDeflate, inflateSync as zlibInflate } from 'node:zlib';
import { ZERO_OID, validOid } from './util.mjs';

export const TYPE_COMMIT = 1;
export const TYPE_TREE = 2;
export const TYPE_BLOB = 3;
export const TYPE_TAG = 4;

const TYPE_NAMES = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_IDS = { commit: 1, tree: 2, blob: 3, tag: 4 };

export function hashObject(typeId, body) {
  const head = Buffer.from(`${TYPE_NAMES[typeId]} ${body.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(body).digest('hex');
}

export function objectBytes(typeId, body) {
  return Buffer.concat([Buffer.from(`${TYPE_NAMES[typeId]} ${body.length}\0`, 'utf8'), body]);
}

export function hashBytes(bytes) { return createHash('sha1').update(bytes).digest('hex'); }

// ---- trees ----

// A tree entry: mode as a string without leading zeros ('40000' for dirs),
// name as raw bytes, oid as hex. Sorting follows git: directory names sort as if
// they ended with '/'.
export function encodeTree(entries) {
  const sorted = entries.slice().sort((a, b) => {
    const an = a.dir ? `${a.name}/` : a.name;
    const bn = b.dir ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts = sorted.map((e) => {
    const mode = e.dir ? '40000' : e.mode;
    return Buffer.concat([Buffer.from(`${mode} ${e.name}\0`, 'utf8'), Buffer.from(e.oid, 'hex')]);
  });
  return Buffer.concat(parts);
}

export function decodeTree(body) {
  const entries = [];
  let i = 0;
  while (i < body.length) {
    const sp = body.indexOf(0x20, i);
    const nul = body.indexOf(0, sp + 1);
    const mode = body.toString('utf8', i, sp);
    const name = body.toString('utf8', sp + 1, nul);
    const oid = body.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid, dir: mode === '40000' });
    i = nul + 21;
  }
  return entries;
}

export function buildTreeBlob(entries) { return encodeTree(entries); }

export function buildCommitBlob(treeOid, parents, author, committer, ts, message) {
  const lines = [`tree ${treeOid}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${author} ${ts} +0000`);
  lines.push(`committer ${committer} ${ts} +0000`);
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

export function buildTagBlob(targetOid, targetType, tagName, tagger, ts, message) {
  return Buffer.from(
    `object ${targetOid}\ntype ${targetType}\ntag ${tagName}\ntagger ${tagger} ${ts} +0000\n\n${message}`,
    'utf8',
  );
}

export function parseCommit(body) {
  const text = body.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const out = { tree: '', parents: [], author: '', committer: '', ts: 0, message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) out.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) out.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) { out.author = line.slice(7); const m = line.match(/ (\d+) \+0000$/); if (m) out.ts = Number(m[1]); }
    else if (line.startsWith('committer ')) out.committer = line.slice(10);
  }
  return out;
}

export function parseTag(body) {
  const text = body.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const out = { object: '', type: '', tag: '', tagger: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) out.object = line.slice(7).trim();
    else if (line.startsWith('type ')) out.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) out.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) out.tagger = line.slice(7);
  }
  return out;
}

// ---- pkt-lines ----

export function pktLine(data) {
  const len = data.length + 4;
  const head = len.toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(head, 'utf8'), data]);
}

export function pktFlush() { return Buffer.from('0000', 'utf8'); }
export function pktDelim() { return Buffer.from('0001', 'utf8'); }
export function pktEnd() { return Buffer.from('0002', 'utf8'); }

// Split a buffer into pkt-line payloads. Returns null on malformed input.
// A flush/delim/end line yields a marker entry { special: 0 | 1 | 2 }.
export function splitPktLines(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    if (i + 4 > buf.length) return null;
    const head = buf.toString('utf8', i, i + 4);
    if (head === '0000') { out.push({ special: 0 }); i += 4; continue; }
    if (head === '0001') { out.push({ special: 1 }); i += 4; continue; }
    if (head === '0002') { out.push({ special: 2 }); i += 4; continue; }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || i + len > buf.length) return null;
    out.push({ data: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return out;
}

export function pktText(lines) {
  return Buffer.concat(lines.map((l) => pktLine(Buffer.from(l, 'utf8'))));
}

// ---- packfiles ----

function packEntryHeader(typeId, size) {
  const bytes = [];
  let b = (typeId << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) b |= 0x80;
  bytes.push(b);
  while (size > 0) {
    b = size & 0x7f;
    size >>= 7;
    if (size > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

export function buildPack(objects) {
  // objects: [{ type: typeId, body: Buffer }]
  const chunks = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  chunks.push(head);
  for (const obj of objects) {
    const zipped = zlibDeflate(obj.body);
    chunks.push(packEntryHeader(obj.type, obj.body.length));
    chunks.push(zipped);
  }
  const trailer = createHash('sha1').update(Buffer.concat(chunks)).digest();
  return Buffer.concat([...chunks, trailer]);
}

function readVarintHeader(buf, offset) {
  let byte = buf[offset];
  let type = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  let pos = offset + 1;
  while (byte & 0x80) {
    byte = buf[pos];
    size |= (byte & 0x7f) << shift;
    shift += 7;
    pos++;
  }
  return { type, size, next: pos };
}

// Read a packfile. Returns { objects: Map<oid, {type, body}> } or null on bad input.
// `lookup` resolves a REF_DELTA base that is not in the pack itself (thin packs
// delta against objects the server already holds); it returns {type, body} or null.
export function readPack(buf, lookup) {
  if (!buf || buf.length < 32) return null;
  if (buf.toString('ascii', 0, 4) !== 'PACK') return null;
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) return null;
  const count = buf.readUInt32BE(8);
  const trailerStart = buf.length - 20;
  const expected = createHash('sha1').update(buf.subarray(0, trailerStart)).digest();
  if (!expected.equals(buf.subarray(trailerStart))) return null;
  const objects = new Map();
  const byOffset = new Map();
  let pos = 12;
  const rawEntries = [];
  for (let n = 0; n < count; n++) {
    if (pos >= trailerStart) return null;
    const start = pos;
    const { type, size, next } = readVarintHeader(buf, pos);
    pos = next;
    let objType = type;
    let baseOid = null;
    let baseOffset = 0;
    if (type === 6) {
      // OFS_DELTA: negative offset varint
      let byte = buf[pos++];
      let off = byte & 0x7f;
      while (byte & 0x80) { byte = buf[pos++]; off = ((off + 1) << 7) | (byte & 0x7f); }
      baseOffset = start - off;
      const base = byOffset.get(baseOffset);
      if (!base) return null;
      objType = base.type;
      baseOid = base.oid;
    } else if (type === 7) {
      baseOid = buf.subarray(pos, pos + 20).toString('hex');
      pos += 20;
      const base = objects.get(baseOid) || (lookup ? lookup(baseOid) : null);
      if (!base) return null;
      objType = base.type;
    } else if (type < 1 || type > 4) {
      return null;
    }
    let body;
    try { body = zlibInflate(buf.subarray(pos)); } catch { return null; }
    // Find how many bytes the zlib stream consumed.
    const consumed = zlibStreamLength(buf, pos);
    if (consumed === null) return null;
    pos += consumed;
    const entry = { type: objType, body, baseOid, start, offset: start };
    if (type === 6 || type === 7) {
      const base = baseOid ? (objects.get(baseOid) || (lookup ? lookup(baseOid) : null)) : byOffset.get(baseOffset);
      if (!base) return null;
      try { entry.body = applyDelta(base.body, body); } catch { return null; }
    }
    const oid = hashObject(entry.type, entry.body);
    entry.oid = oid;
    objects.set(oid, { type: entry.type, body: entry.body });
    byOffset.set(start, { type: entry.type, oid });
    rawEntries.push(entry);
  }
  if (pos !== trailerStart) return null;
  void rawEntries;
  return { objects };
}

// How many bytes a zlib stream starting at `pos` consumes. inflateSync tolerates
// trailing bytes but throws on a truncated stream, so the predicate "this prefix
// inflates cleanly" is monotone and a binary search finds the true end.
function zlibStreamLength(buf, pos) {
  let lo = 1, hi = buf.length - pos, best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try { zlibInflate(buf.subarray(pos, pos + mid)); best = mid; hi = mid - 1; } catch { lo = mid + 1; }
  }
  return best;
}

export function applyDelta(base, delta) {
  let p = 0;
  const readVarint = () => {
    let v = 0, shift = 0;
    for (;;) {
      const b = delta[p++];
      v |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const baseSize = readVarint();
  const resultSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const out = [];
  while (p < delta.length) {
    const op = delta[p++];
    if (op & 0x80) {
      let off = 0, size = 0;
      if (op & 0x01) off = delta[p++];
      if (op & 0x02) off |= delta[p++] << 8;
      if (op & 0x04) off |= delta[p++] << 16;
      if (op & 0x08) off |= delta[p++] << 24;
      if (op & 0x10) size = delta[p++];
      if (op & 0x20) size |= delta[p++] << 8;
      if (op & 0x40) size |= delta[p++] << 16;
      if (size === 0) size = 0x10000;
      if (off + size > base.length) throw new Error('delta copy out of range');
      out.push(base.subarray(off, off + size));
    } else if (op > 0) {
      out.push(delta.subarray(p, p + op));
      p += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== resultSize) throw new Error('delta result size mismatch');
  return result;
}

export { ZERO_OID, validOid };
