import test from 'node:test';
import assert from 'node:assert/strict';
import { T, encode, decode, encPos, decPos, json } from '../shared/protocol.mjs';
import { genKeys, derive, seal, open } from '../shared/crypto.mjs';
import { ReliableChannel, AdaptiveTimeout } from '../shared/reliability.mjs';
import { validateMove, meetingPoint, dist } from '../shared/geo.mjs';

test('protocol round trip', () => {
  const d = decode(encode(T.POSITION, 7, encPos(3, 55.7558, 37.6173), 1));
  assert.equal(d.seq, 7); assert.equal(d.requiresAck, 1);
  const p = decPos(d.payload); assert.ok(Math.abs(p.lat - 55.7558) < 1e-6);
});
test('invalid datagrams are rejected', () => {
  const ok = encode(T.PING, 1, new Uint8Array(8));
  assert.equal(decode(ok.subarray(0, 5)), null);          // short header
  assert.equal(decode(ok.subarray(0, ok.length - 1)), null); // size mismatch
  const bad = ok.slice(); bad[5] = 9; assert.equal(decode(bad), null); // version
  const t = ok.slice(); t[0] = 99; assert.equal(decode(t), null);      // type
});
test('encryption round trip and tamper detection', async () => {
  const a = await genKeys(), b = await genKeys();
  const ka = await derive(a.k.privateKey, b.pub), kb = await derive(b.k.privateKey, a.pub);
  const sealed = await seal(ka, 1, 0, encode(T.CHAT, 5, json({ text: 'hi' }), 1));
  assert.equal((await open(kb, sealed)).type, T.CHAT);
  const t = sealed.slice(); t[25] ^= 1; assert.equal(await open(kb, t), null);
});
test('retransmission, duplicate ACK, failure', () => {
  const c = new ReliableChannel(3);
  c.onSent(1, new Uint8Array(3), 0);
  assert.equal(c.collect(50_000, 200_000).length, 0);
  assert.equal(c.collect(250_000, 200_000)[0].attempts, 2);
  assert.ok(c.onAck(1)); assert.equal(c.onAck(1), null);
  c.onSent(2, new Uint8Array(0), 0);
  for (let t = 1; t <= 10; t++) c.collect(t * 2_000_000, 200_000);
  assert.deepEqual(c.drainFailed(), [2]); assert.equal(c.pending.size, 0);
});
test('RTO is clamped', () => {
  const a = new AdaptiveTimeout(); a.onSample(1); assert.equal(a.rtoMs(), 100);
  a.onSample(5000); assert.equal(a.rtoMs(), 3000);
});
test('server authority: teleport rejected, walking accepted', () => {
  const a = { lat: 55.75, lon: 37.6 };
  assert.equal(validateMove(a, { lat: 60.75, lon: 37.6 }, 1000), false);
  assert.equal(validateMove(a, { lat: 55.7501, lon: 37.6 }, 1000), true);
});
test('meeting point beats centroid on total distance with an outlier', () => {
  const pts = [{ lat: 55.75, lon: 37.6 }, { lat: 55.751, lon: 37.601 }, { lat: 55.76, lon: 37.7 }];
  const c = { lat: (55.75 + 55.751 + 55.76) / 3, lon: (37.6 + 37.601 + 37.7) / 3 };
  assert.ok(meetingPoint(pts).total <= pts.reduce((s, p) => s + dist(c, p), 0));
});
