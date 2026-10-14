import test from 'node:test';
import assert from 'node:assert/strict';
import { heartbeatAge } from '../src/elapsed-time.mjs';

test('monotonic heartbeat ages require the publishing process and ignore wall-clock jumps', () => {
  const snapshot = { pid: 42, heartbeatMonotonicMs: 1500, updatedAt: '2999-01-01T00:00:00.000Z' };
  const options = { nowWall: 0, nowMono: 2000, isAlive: pid => pid === 42 };
  assert.equal(heartbeatAge(snapshot, options), 500);
  assert.equal(heartbeatAge(snapshot, { ...options, isAlive: () => false }), Infinity);
  assert.equal(heartbeatAge(snapshot, { ...options, nowMono: 1000 }), -500);
});

test('legacy wall-clock heartbeat ages remain readable but reject future timestamps', () => {
  const snapshot = { updatedAt: '2026-10-14T00:00:00.000Z' };
  assert.equal(heartbeatAge(snapshot, { nowWall: Date.parse(snapshot.updatedAt) + 1500 }), 1500);
  assert.equal(heartbeatAge(snapshot, { nowWall: Date.parse(snapshot.updatedAt) - 1500 }), -1500);
  assert.equal(heartbeatAge({}, { nowWall: 0 }), Infinity);
});
