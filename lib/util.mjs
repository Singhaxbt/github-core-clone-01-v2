// Shared low-level helpers: SHA-1, base64, pkt-line codec.
import { createHash } from 'node:crypto';

export const ZERO_OID = '0'.repeat(40);

export function sha1hex(data) {
  return createHash('sha1').update(data).digest('hex');
}

export function b64encode(data) {
  return Buffer.from(data).toString('base64');
}

export function b64decode(text) {
  return Buffer.from(text, 'base64');
}

/** One pkt-line: 4 hex digits of total length (header included) + payload. */
export function pktLine(payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const len = body.length + 4;
  if (len > 65520) throw new Error(`pkt-line of ${len} bytes exceeds 65520`);
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), body]);
}

export function flushPkt() {
  return Buffer.from('0000', 'ascii');
}

export function delimPkt() {
  return Buffer.from('0001', 'ascii');
}

/**
 * Parse pkt-lines from the start of `buf` until the first flush (0000), delim (0001) or
 * response-end (0002) packet, or the buffer ends. Returns the data packets (as Buffers, in
 * order), the kind of terminator found ('flush' | 'delim' | 'end' | 'eof'), and the bytes
 * after the terminator (`rest`). Throws on a malformed length prefix.
 */
export function parsePktLines(buf) {
  const packets = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const hex = buf.subarray(offset, offset + 4).toString('ascii');
    if (hex === '0000') return { packets, terminator: 'flush', rest: buf.subarray(offset + 4) };
    if (hex === '0001') return { packets, terminator: 'delim', rest: buf.subarray(offset + 4) };
    if (hex === '0002') return { packets, terminator: 'end', rest: buf.subarray(offset + 4) };
    const len = Number.parseInt(hex, 16);
    if (!Number.isFinite(len) || len < 4 || offset + len > buf.length) {
      throw new Error(`malformed pkt-line length ${JSON.stringify(hex)} at offset ${offset}`);
    }
    packets.push(buf.subarray(offset + 4, offset + len));
    offset += len;
  }
  if (offset !== buf.length) throw new Error(`truncated pkt-line at offset ${offset}`);
  return { packets, terminator: 'eof', rest: Buffer.alloc(0) };
}

/** Parse every pkt-line in `buf` (for full bodies such as advertisements). */
export function parseAllPktLines(buf) {
  const packets = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line');
    const hex = buf.subarray(offset, offset + 4).toString('ascii');
    if (hex === '0000') { packets.push({ kind: 'flush' }); offset += 4; continue; }
    if (hex === '0001') { packets.push({ kind: 'delim' }); offset += 4; continue; }
    if (hex === '0002') { packets.push({ kind: 'end' }); offset += 4; continue; }
    const len = Number.parseInt(hex, 16);
    if (!Number.isFinite(len) || len < 4 || offset + len > buf.length) {
      throw new Error(`malformed pkt-line length ${JSON.stringify(hex)} at offset ${offset}`);
    }
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return packets;
}

/** Split a sideband payload stream into its band-1 bytes (pack data). */
export function demuxSideband(packets) {
  const out = [];
  for (const packet of packets) {
    if (packet.kind !== 'data' || packet.payload.length < 1) continue;
    if (packet.payload[0] === 1) out.push(packet.payload.subarray(1));
  }
  return Buffer.concat(out);
}
