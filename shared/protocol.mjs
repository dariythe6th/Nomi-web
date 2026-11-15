// Nomi protocol v1. Header (8 bytes, big-endian), no struct memcpy:
// type u8 | seq u16 | payloadSize u16 | version u16 | requiresAck u8
export const VERSION = 1;
export const HEADER = 8;
export const T = {
  PING: 1, PONG: 2, POSITION: 3, CHAT: 4, REACTION: 5, ACK: 6,
  CORRECTION: 7, WELCOME: 8, PROFILE: 9, KEY_EXCHANGE: 10, ENCRYPTED: 11,
};
const TYPES = new Set(Object.values(T));

export function encode(type, seq, payload = new Uint8Array(0), requiresAck = 0) {
  const b = new Uint8Array(HEADER + payload.length);
  const v = new DataView(b.buffer);
  v.setUint8(0, type);
  v.setUint16(1, seq);
  v.setUint16(3, payload.length);
  v.setUint16(5, VERSION);
  v.setUint8(7, requiresAck);
  b.set(payload, HEADER);
  return b;
}

// Returns null for any invalid datagram (never throws).
export function decode(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (b.length < HEADER) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.length);
  const type = v.getUint8(0), seq = v.getUint16(1), size = v.getUint16(3);
  if (v.getUint16(5) !== VERSION || !TYPES.has(type) || size !== b.length - HEADER) return null;
  return { type, seq, requiresAck: v.getUint8(7), payload: b.subarray(HEADER), header: b.subarray(0, HEADER) };
}

// POSITION payload: id u8 | lat i32 | lon i32 (degrees * 1e7, ~1 cm) = 9 bytes
export function encPos(id, lat, lon) {
  const b = new Uint8Array(9), v = new DataView(b.buffer);
  v.setUint8(0, id); v.setInt32(1, Math.round(lat * 1e7)); v.setInt32(5, Math.round(lon * 1e7));
  return b;
}
export function decPos(p) {
  if (p.length !== 9) return null;
  const v = new DataView(p.buffer, p.byteOffset, 9);
  return { id: v.getUint8(0), lat: v.getInt32(1) / 1e7, lon: v.getInt32(5) / 1e7 };
}
export const json = (o) => new TextEncoder().encode(JSON.stringify(o));
export const unjson = (p) => { try { return JSON.parse(new TextDecoder().decode(p)); } catch { return null; } };
export const u16 = (n) => new Uint8Array([n >> 8, n & 255]);
