// Small shared helpers. No wall clock, no randomness: every timestamp the forge
// stamps comes from the trial's MAKEFUN_TRIAL_NOW (via store.nowIso()), never Date.now().

export const ZERO_OID = '0000000000000000000000000000000000000000';

export function isZeroOid(oid) { return oid === ZERO_OID; }

export function validOid(oid) { return typeof oid === 'string' && /^[0-9a-f]{40}$/.test(oid); }

export function b64Encode(bytes) { return Buffer.from(bytes).toString('base64'); }

export function b64Decode(text) {
  if (typeof text !== 'string') return null;
  const clean = text.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 !== 0) return null;
  try { return Buffer.from(clean, 'base64'); } catch { return null; }
}

export function b64urlEncode(text) {
  return Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(text) {
  if (typeof text !== 'string') return null;
  const pad = (4 - (text.length % 4)) % 4;
  try { return Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad), 'base64').toString('utf8'); } catch { return null; }
}

export function bytesOf(text) { return Buffer.from(text, 'utf8'); }

export function textOf(buf) { return buf.toString('utf8'); }

// Line diff for pull-request file stats: longest-common-subsequence counts.
export function lineDiff(oldText, newText) {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  const n = a.length, m = b.length;
  if (n === 0) return { additions: m, deletions: 0, changes: m };
  if (m === 0) return { additions: 0, deletions: n, changes: n };
  // Keep the table small: cap the comparison, fall back to a cheap count.
  if (n * m > 400000) {
    const oldSet = new Set(a), newSet = new Set(b);
    let adds = 0, dels = 0;
    for (const line of b) if (!oldSet.has(line)) adds++;
    for (const line of a) if (!newSet.has(line)) dels++;
    return { additions: adds, deletions: dels, changes: adds + dels };
  }
  const dp = new Array((n + 1) * (m + 1)).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] = a[i] === b[j] ? dp[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
    }
  }
  const common = dp[0];
  return { additions: m - common, deletions: n - common, changes: (m - common) + (n - common) };
}

export function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
