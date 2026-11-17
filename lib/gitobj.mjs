// Git object model + pack codec, ported from the suite's own git-client.ts semantics:
// SHA-1 over `<type> <size>\0` + bytes; trees sorted by git's rule (dirs compare as if
// ending in '/'); commits `tree/parent/author/committer/message`; packs version 2 with
// plain objects (the suite's client only ever writes plain objects) plus OFS/REF delta
// resolution on read, for safety. No clock, no I/O.
//
// Perf notes (v2): objects are immutable once stored (an oid names its bytes), so a
// parsed commit/tree can be cached per objects Map and reused by every walk that
// re-reads it — the push chain, the clone fetch and the merge-base walks all re-parse
// the same objects otherwise. hashObject feeds the header and the body to the hash
// separately instead of copying the body into a concatenated buffer.
import { deflateSync, inflateSync, inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { sha1hex, ZERO_OID } from './util.mjs';

export { ZERO_OID };

const TYPE_CODES = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** The SHA-1 id of an object: sha1(`<type> <size>\0` + bytes). */
export function hashObject(type, data) {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'ascii');
  hash.update(data);
  return hash.digest('hex');
}

/** Compare two tree-entry names by git's rule: dirs sort as if their name ended in '/'. */
function treeSortKey(entry) {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function sortTreeEntries(entries) {
  return [...entries].sort((a, b) => {
    const ka = Buffer.from(treeSortKey(a), 'utf8');
    const kb = Buffer.from(treeSortKey(b), 'utf8');
    return Buffer.compare(ka, kb);
  });
}

/** Build a tree object from [{mode, name, oid}]; returns {oid, data}. */
export function buildTree(entries) {
  const sorted = sortTreeEntries(entries);
  const parts = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  const data = Buffer.concat(parts);
  return { oid: hashObject('tree', data), data };
}

/** Parse a tree object into [{mode, name, oid}]. */
export function parseTree(data) {
  const entries = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('malformed tree object');
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/**
 * Build a commit object. `message` is stored with a trailing newline, as git does.
 * `author`/`committer` are full lines: `Name <email> <epoch> +0000`.
 */
export function buildCommit({ tree, parents = [], author, committer, message }) {
  const msg = message.endsWith('\n') ? message : `${message}\n`;
  let text = `tree ${tree}\n`;
  for (const parent of parents) text += `parent ${parent}\n`;
  text += `author ${author}\ncommitter ${committer}\n\n${msg}`;
  const data = Buffer.from(text, 'utf8');
  return { oid: hashObject('commit', data), data };
}

/** Parse a commit object. */
export function parseCommit(data) {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Build an annotated tag object. */
export function buildTag({ object, type, tag, tagger, message }) {
  const msg = message.endsWith('\n') ? message : `${message}\n`;
  const text = `object ${object}\ntype ${type}\ntag ${tag}\ntagger ${tagger}\n\n${msg}`;
  const data = Buffer.from(text, 'utf8');
  return { oid: hashObject('tag', data), data };
}

/** Parse a tag object. */
export function parseTag(data) {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ------------------------------------------------------------------ parsed-object cache
//
// Git objects are immutable: an oid always names the same bytes, and a repo's
// objects Map only ever grows (a repo is dropped whole, never edited in place).
// So a parsed commit/tree can be cached per objects Map and shared by every walk.
// Callers must NOT mutate the returned object — it is shared.

const commitCache = new WeakMap(); // objects Map -> Map<oid, parsed commit>
const treeCache = new WeakMap(); // objects Map -> Map<oid, parsed tree entries>

/** The parsed commit for `oid` in `objects`, or null when it is not a commit. */
export function getParsedCommit(objects, oid) {
  let perRepo = commitCache.get(objects);
  if (!perRepo) { perRepo = new Map(); commitCache.set(objects, perRepo); }
  let parsed = perRepo.get(oid);
  if (parsed === undefined) {
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'commit') return null;
    parsed = parseCommit(obj.data);
    perRepo.set(oid, parsed);
  }
  return parsed;
}

/** The parsed tree entries for `oid` in `objects`, or null when it is not a tree. */
export function getParsedTree(objects, oid) {
  let perRepo = treeCache.get(objects);
  if (!perRepo) { perRepo = new Map(); treeCache.set(objects, perRepo); }
  let parsed = perRepo.get(oid);
  if (parsed === undefined) {
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'tree') return null;
    parsed = parseTree(obj.data);
    perRepo.set(oid, parsed);
  }
  return parsed;
}

/**
 * Flatten a tree into path -> {oid, mode} (files only, mode 100644; subtrees walked).
 * `objects` is a Map<oid, {type, data}>.
 */
export function flattenTree(objects, treeOid, prefix = '', out = new Map()) {
  const entries = getParsedTree(objects, treeOid);
  if (entries === null) return out;
  for (const entry of entries) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(objects, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/**
 * Build nested tree objects from a flat path -> {oid, mode} map. Returns {rootOid, created}
 * where `created` holds every new tree object ({type:'tree', data}) keyed by oid.
 * Existing tree objects are reused when their bytes are identical.
 */
export function buildTreesFromPaths(objects, flat) {
  const created = new Map();
  const getOrCreate = (entries) => {
    const { oid, data } = buildTree(entries);
    if (!objects.has(oid) && !created.has(oid)) created.set(oid, { type: 'tree', data });
    return oid;
  };
  const buildLevel = (paths, prefix) => {
    const direct = [];
    const byDir = new Map();
    for (const path of paths) {
      const rest = prefix === '' ? path : path.slice(prefix.length + 1);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        const file = flat.get(path);
        direct.push({ mode: file.mode, name: rest, oid: file.oid });
      } else {
        const dir = rest.slice(0, slash);
        if (!byDir.has(dir)) byDir.set(dir, []);
        byDir.get(dir).push(path);
      }
    }
    for (const [dir, subPaths] of byDir) {
      direct.push({ mode: '40000', name: dir, oid: buildLevel(subPaths, prefix === '' ? dir : `${prefix}/${dir}`) });
    }
    return getOrCreate(direct);
  };
  const rootOid = buildLevel([...flat.keys()], '');
  return { rootOid, created };
}

/** Every object reachable from `tips` (commits, trees, blobs, tags), as a Set of oids. */
export function collectReachable(objects, tips) {
  const seen = new Set();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop();
    if (oid === ZERO_OID || seen.has(oid)) continue;
    const obj = objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const commit = getParsedCommit(objects, oid);
      stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (obj.type === 'tree') {
      for (const entry of getParsedTree(objects, oid)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}

/** Whether `anc` is an ancestor of (or equal to) `desc`. */
export function isAncestor(objects, anc, desc) {
  if (anc === desc) return true;
  const seen = new Set();
  const stack = [desc];
  while (stack.length > 0) {
    const oid = stack.pop();
    if (oid === ZERO_OID || seen.has(oid)) continue;
    seen.add(oid);
    const commit = getParsedCommit(objects, oid);
    if (!commit) continue;
    for (const parent of commit.parents) {
      if (parent === anc) return true;
      stack.push(parent);
    }
  }
  return false;
}

/** The best common ancestor of `a` and `b` (first common commit found walking from b). */
export function mergeBase(objects, a, b) {
  const ancestorsA = new Set();
  const stackA = [a];
  while (stackA.length > 0) {
    const oid = stackA.pop();
    if (oid === ZERO_OID || ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const commit = getParsedCommit(objects, oid);
    if (!commit) continue;
    for (const parent of commit.parents) stackA.push(parent);
  }
  const stackB = [b];
  const seenB = new Set();
  while (stackB.length > 0) {
    const oid = stackB.pop();
    if (oid === ZERO_OID || seenB.has(oid)) continue;
    seenB.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const commit = getParsedCommit(objects, oid);
    if (!commit) continue;
    for (const parent of commit.parents) stackB.push(parent);
  }
  return null;
}

/** Diff two trees: [{path, status, oldOid, newOid}]. */
export function diffTrees(objects, treeA, treeB) {
  const a = treeA ? flattenTree(objects, treeA) : new Map();
  const b = treeB ? flattenTree(objects, treeB) : new Map();
  const out = [];
  const paths = new Set([...a.keys(), ...b.keys()]);
  for (const path of [...paths].sort()) {
    const oldEntry = a.get(path);
    const newEntry = b.get(path);
    if (oldEntry && !newEntry) out.push({ path, status: 'removed', oldOid: oldEntry.oid, newOid: null });
    else if (!oldEntry && newEntry) out.push({ path, status: 'added', oldOid: null, newOid: newEntry.oid });
    else if (oldEntry.oid !== newEntry.oid) out.push({ path, status: 'modified', oldOid: oldEntry.oid, newOid: newEntry.oid });
  }
  return out;
}

/** Count lines in a buffer (a trailing newline does not start a new line). */
export function countLines(data) {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

// --------------------------------------------------------------------------- packs

function encodePackEntryHeader(typeCode, size) {
  const bytes = [];
  let first = (typeCode << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Write a version-2 pack of plain objects only. `oids` is an iterable of ids present in `objects`. */
export function writePack(objects, oids) {
  const list = [...oids].sort();
  const chunks = [Buffer.from('PACK'), Buffer.alloc(4), Buffer.alloc(4)];
  chunks[1].writeUInt32BE(2, 0);
  chunks[2].writeUInt32BE(list.length, 0);
  for (const oid of list) {
    const obj = objects.get(oid);
    if (!obj) throw new Error(`pack: missing object ${oid}`);
    const typeCode = TYPE_CODES[obj.type];
    if (typeCode === undefined) throw new Error(`pack: unknown type ${obj.type}`);
    chunks.push(encodePackEntryHeader(typeCode, obj.data.length));
    chunks.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(chunks);
  return Buffer.concat([body, Buffer.from(sha1hex(body), 'hex')]);
}

/** Verify a pack's trailer SHA-1. */
export function verifyPackChecksum(pack) {
  if (pack.length < 32) return { ok: false };
  const body = pack.subarray(0, pack.length - 20);
  const expected = sha1hex(body);
  const actual = pack.subarray(pack.length - 20).toString('hex');
  return { ok: expected === actual, expected, actual };
}

function readVarint(buf, offset) {
  let value = buf[offset] & 0x7f;
  let shift = 7;
  offset += 1;
  while (buf[offset - 1] & 0x80) {
    value |= (buf[offset] & 0x7f) << shift;
    shift += 7;
    offset += 1;
  }
  return { value, offset };
}

/** Apply a git delta to `base`, returning the result bytes. */
export function applyDelta(base, delta) {
  let offset = 0;
  const readDeltaVarint = () => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset];
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readDeltaVarint();
  if (sourceSize !== base.length) throw new Error('delta source size mismatch');
  const targetSize = readDeltaVarint();
  const out = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset];
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) { copyOffset |= delta[offset] << (8 * i); offset += 1; }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) { copySize |= delta[offset] << (8 * i); offset += 1; }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      out.push(delta.subarray(offset, offset + op));
      offset += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (produced !== targetSize) throw new Error('delta target size mismatch');
  return Buffer.concat(out);
}

/**
 * Read a pack (version 2 or 3) into a Map<oid, {type, data}>. Plain objects resolve
 * directly; OFS_DELTA (6) and REF_DELTA (7) resolve against their base. Throws on
 * malformed input or a bad trailer.
 */
export function readPack(pack) {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const checksum = verifyPackChecksum(pack);
  if (!checksum.ok) throw new Error('pack trailer checksum mismatch');
  const objects = new Map();
  const byOffset = new Map();
  let offset = 12;
  const end = pack.length - 20;
  for (let i = 0; i < declaredCount; i += 1) {
    if (offset >= end) throw new Error('pack ends before its declared entry count');
    const entryOffset = offset;
    let byte = pack[offset];
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset];
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOid = null;
    let baseOffset = null;
    if (typeCode === 6) {
      byte = pack[offset];
      offset += 1;
      let off = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset];
        offset += 1;
        off = ((off + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = entryOffset - off;
    } else if (typeCode === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    // inflateSync ignores trailing bytes, so inflate the remainder, then find how many
    // bytes this entry's zlib stream actually consumed (adler32 scan, see zlibStreamLength).
    const inflated = inflateSync(pack.subarray(offset, end));
    if (inflated.length !== size) throw new Error(`pack entry size mismatch: header ${size}, inflated ${inflated.length}`);
    offset += zlibStreamLength(pack.subarray(offset, end), inflated);
    if (typeCode >= 1 && typeCode <= 4) {
      const type = CODE_TYPES[typeCode];
      const oid = hashObject(type, inflated);
      objects.set(oid, { type, data: inflated });
      byOffset.set(entryOffset, { type, data: inflated, oid });
    } else if (typeCode === 6 || typeCode === 7) {
      let base;
      if (typeCode === 6) {
        base = byOffset.get(baseOffset);
        if (!base) throw new Error('ofs-delta base not found');
      } else {
        base = objects.get(baseOid);
        if (!base) throw new Error('ref-delta base not found');
      }
      const data = applyDelta(base.data, inflated);
      const oid = hashObject(base.type, data);
      objects.set(oid, { type: base.type, data });
      byOffset.set(entryOffset, { type: base.type, data, oid });
    } else {
      throw new Error(`unknown pack entry type ${typeCode}`);
    }
  }
  if (objects.size !== declaredCount) throw new Error('pack entry count mismatch');
  return objects;
}

// How many bytes the zlib stream at the start of `buf` occupies (2-byte header +
// deflate body + 4-byte adler32). `inflatedLen` bounds the search: a deflate stream
// never expands its input by more than a fraction of a percent plus block overhead.
/** Adler-32 checksum (zlib's trailer), computed with deferred mod like zlib itself. */
function adler32(buf) {
  let a = 1;
  let b = 0;
  let i = 0;
  while (i < buf.length) {
    const chunk = Math.min(buf.length - i, 5552);
    for (let j = 0; j < chunk; j += 1) {
      a += buf[i + j];
      b += a;
    }
    a %= 65521;
    b %= 65521;
    i += chunk;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Find how many bytes of `buf` one zlib stream consumes. A zlib stream is a 2-byte
 * header, a raw deflate stream, then the 4-byte adler32 of the inflated bytes — so
 * scan for that adler32, verify by inflating exactly that slice, and confirm the
 * slice is minimal (one byte shorter must fail). Falls back to binary search if
 * the scan finds nothing (valid packs always carry the adler32; the fallback is
 * paranoia). This replaces ~11 re-inflations per object with ~2.
 */
function zlibStreamLength(buf, inflated) {
  const adlerBytes = Buffer.alloc(4);
  adlerBytes.writeUInt32BE(adler32(inflated), 0);
  let pos = 2;
  for (;;) {
    const idx = buf.indexOf(adlerBytes, pos);
    if (idx < 0) return zlibStreamLengthBinary(buf, inflated.length);
    try {
      const out = inflateRawSync(buf.subarray(2, idx));
      if (out.length === inflated.length && out.equals(inflated)) {
        let truncatedOk = false;
        try {
          inflateRawSync(buf.subarray(2, idx - 1));
          truncatedOk = true;
        } catch {
          // Expected: one byte shorter must not decode.
        }
        if (!truncatedOk) return idx + 4;
      }
    } catch {
      // Not a valid stream end — keep scanning past this adler32 lookalike.
    }
    pos = idx + 1;
  }
}

function zlibStreamLengthBinary(buf, inflatedLen) {
  let hi = Math.min(buf.length, inflatedLen + Math.floor(inflatedLen / 64) + 1024);
  try {
    inflateRawSync(buf.subarray(2, hi));
  } catch {
    hi = buf.length;
    try {
      inflateRawSync(buf.subarray(2, hi));
    } catch {
      throw new Error('truncated zlib stream in pack');
    }
  }
  let lo = 2;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateRawSync(buf.subarray(2, mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return lo + 4;
}
