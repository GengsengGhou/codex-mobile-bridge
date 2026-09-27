import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DeliveryStore, DELIVERY_LIMIT, promptHash } from '../src/delivery-store.mjs';

const ID = '00000000-0000-0000-0000-000000000001';
const entry = () => ({ requestId: randomUUID(), threadId: ID, promptHash: promptHash('private prompt') });
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-delivery-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, 'deliveries.json') };
}

test('journal uses atomic replacement, serializes concurrent reservations, and stores no prompt text', async t => {
  const { path, directory } = await fixture(t), store = new DeliveryStore({ path });
  const entries = Array.from({ length: 15 }, entry);
  await Promise.all(entries.map(value => store.reserve(value)));
  const saved = await readFile(path, 'utf8');
  assert.ok(!saved.includes('private prompt')); assert.equal(JSON.parse(saved).deliveries.length, entries.length);
  assert.deepEqual(await readdir(directory), ['deliveries.json']);
  const restart = new DeliveryStore({ path });
  for (const value of entries) assert.equal((await restart.get(value.requestId)).state, 'pending');
});

test('a failed atomic write retains the previous journal and cleans temporary files', async t => {
  const { path, directory } = await fixture(t), store = new DeliveryStore({ path }), first = entry();
  await store.reserve(first);
  const saved = await readFile(path, 'utf8');
  const originalPath = store.path;
  store.path = directory; // rename onto a directory cannot replace the journal.
  await assert.rejects(store.reserve(entry()), error => error.code === 'DELIVERY_STORE_UNAVAILABLE');
  store.path = originalPath;
  assert.equal(await readFile(path, 'utf8'), saved);
  assert.deepEqual(await readdir(directory), ['deliveries.json']);
});

test('duplicate reservations serialize and the delivery limit never evicts unresolved entries', async () => {
  const store = new DeliveryStore({ path: null }), value = entry();
  const results = await Promise.allSettled([store.reserve(value), store.reserve(value)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'CONFLICT');
  for (let index = 1; index < DELIVERY_LIMIT; index++) await store.reserve(entry());
  await assert.rejects(store.reserve(entry()), error => error.code === 'LIMIT_REACHED');
  assert.equal((await store.get(value.requestId)).state, 'pending');
});

test('malformed ledger shapes, duplicate IDs, and mismatched accepted receipts fail closed', async t => {
  const { path } = await fixture(t), value = { ...entry(), state: 'pending', createdAt: new Date().toISOString() };
  for (const deliveries of [null, [{}], [value, value], [{ ...value, state: 'accepted', receipt: { accepted: true, threadId: randomUUID(), requestId: value.requestId, acceptedAt: value.createdAt } }]]) {
    await writeFile(path, JSON.stringify({ version: 1, deliveries }));
    const store = new DeliveryStore({ path });
    await assert.rejects(store.get(value.requestId), error => error.code === 'DELIVERY_STORE_UNAVAILABLE');
    await assert.rejects(store.reserve(entry()), error => error.code === 'DELIVERY_STORE_UNAVAILABLE');
  }
});
