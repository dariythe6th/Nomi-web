// ECDH P-256 + HKDF-SHA256 -> AES-256-GCM. Works in browsers and Node 20+.
import { HEADER, VERSION, T, decode } from './protocol.mjs';
const s = globalThis.crypto.subtle;
const ALG = { name: 'ECDH', namedCurve: 'P-256' };

export async function genKeys() {
  const k = await s.generateKey(ALG, true, ['deriveBits']);
  return { k, pub: new Uint8Array(await s.exportKey('raw', k.publicKey)) };
}
export async function derive(privateKey, peerPub) {
  const pk = await s.importKey('raw', peerPub, ALG, false, []);
  const bits = await s.deriveBits({ name: 'ECDH', public: pk }, privateKey, 256);
  const hk = await s.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return s.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('nomi-v1') },
    hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
// Header stays open (AAD). Nonce = direction(4B: 1 client, 2 server) + counter(8B): never repeats per key.
export async function seal(key, dir, counter, inner) {
  const hdr = new Uint8Array(HEADER), v = new DataView(hdr.buffer);
  v.setUint8(0, T.ENCRYPTED); v.setUint16(1, (inner[1] << 8) | inner[2]);
  v.setUint16(3, 12 + inner.length + 16); v.setUint16(5, VERSION);
  const n = new Uint8Array(12), nv = new DataView(n.buffer);
  nv.setUint32(0, dir); nv.setBigUint64(4, BigInt(counter));
  const ct = new Uint8Array(await s.encrypt({ name: 'AES-GCM', iv: n, additionalData: hdr }, key, inner));
  const out = new Uint8Array(HEADER + 12 + ct.length);
  out.set(hdr); out.set(n, HEADER); out.set(ct, HEADER + 12);
  return out;
}
export async function open(key, raw) {
  const d = decode(raw);
  if (!d || d.type !== T.ENCRYPTED || d.payload.length < 28) return null;
  try {
    const pt = await s.decrypt({ name: 'AES-GCM', iv: d.payload.slice(0, 12), additionalData: d.header }, key, d.payload.slice(12));
    return decode(new Uint8Array(pt));
  } catch { return null; } // tag mismatch -> caller logs AUTH_FAIL
}
