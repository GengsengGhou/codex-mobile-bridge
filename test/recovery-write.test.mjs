import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { writeRecoveryFile } from '../src/recovery.mjs';

const scratchRoot = resolve('work/recovery-write-tests');

async function fixture(t) {
  await mkdir(scratchRoot, { recursive: true });
  const root = await mkdtemp(resolve(scratchRoot, 'recovery-write-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, target: resolve(root, 'hub-connector-state.json') };
}

function codedError(code) {
  return Object.assign(new Error(`rename failed: ${code}`), { code });
}

test('Windows transient rename conflict retries and publishes the new state', async t => {
  const { target } = await fixture(t);
  const staleTemporary = `${target}.old-uuid.tmp`;
  await writeFile(target, '{"state":"old"}\n');
  await writeFile(staleTemporary, 'unrelated temporary data');
  let calls = 0;

  await writeRecoveryFile(target, { state: 'connected' }, {
    platform: 'win32',
    renameFile: async (from, to) => {
      calls++;
      if (calls === 1) throw codedError('EBUSY');
      return rename(from, to);
    }
  });

  assert.equal(calls, 2);
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { state: 'connected' });
  assert.deepEqual((await readdir(resolve(target, '..'))).sort(), ['hub-connector-state.json', 'hub-connector-state.json.old-uuid.tmp']);
  assert.equal(await readFile(staleTemporary, 'utf8'), 'unrelated temporary data');
});

test('permanent Windows rename failure preserves target, cause and cleans temporary state', async t => {
  const { target } = await fixture(t);
  const staleTemporary = `${target}.old-uuid.tmp`;
  const original = '{"state":"old"}\n';
  await writeFile(target, original);
  await writeFile(staleTemporary, 'unrelated temporary data');
  const failure = codedError('EPERM');
  let calls = 0;

  await assert.rejects(writeRecoveryFile(target, { state: 'new' }, {
    platform: 'win32',
    renameFile: async () => { calls++; throw failure; }
  }), error => error === failure && error.code === 'EPERM');

  assert.equal(calls, 6);
  assert.equal(await readFile(target, 'utf8'), original);
  assert.deepEqual((await readdir(resolve(target, '..'))).sort(), ['hub-connector-state.json', 'hub-connector-state.json.old-uuid.tmp']);
  assert.equal(await readFile(staleTemporary, 'utf8'), 'unrelated temporary data');
});

test('non-transient rename errors do not retry on Windows', async t => {
  const { target } = await fixture(t);
  const original = '{"state":"old"}\n';
  await writeFile(target, original);
  const failure = codedError('EINVAL');
  let calls = 0;

  await assert.rejects(writeRecoveryFile(target, { state: 'new' }, {
    platform: 'win32',
    renameFile: async () => { calls++; throw failure; }
  }), error => error === failure && error.code === 'EINVAL');

  assert.equal(calls, 1);
  assert.equal(await readFile(target, 'utf8'), original);
  assert.deepEqual(await readdir(resolve(target, '..')), ['hub-connector-state.json']);
});

test('transient Windows rename errors do not retry on other platforms', async t => {
  const { target } = await fixture(t);
  const failure = codedError('EPERM');
  let calls = 0;

  await assert.rejects(writeRecoveryFile(target, { state: 'new' }, {
    platform: 'linux',
    renameFile: async () => { calls++; throw failure; }
  }), error => error === failure && error.code === 'EPERM');

  assert.equal(calls, 1);
  assert.deepEqual(await readdir(resolve(target, '..')), []);
});

test('concurrent writes publish complete snapshots and preserve unrelated temporary files', async t => {
  const { target } = await fixture(t);
  const staleTemporary = `${target}.previous-run.tmp`;
  await writeFile(staleTemporary, 'leave this file alone');

  await Promise.all([
    writeRecoveryFile(target, { generation: 'first', values: Array.from({ length: 128 }, (_, i) => i) }),
    writeRecoveryFile(target, { generation: 'second', values: Array.from({ length: 128 }, (_, i) => 127 - i) })
  ]);

  const snapshot = JSON.parse(await readFile(target, 'utf8'));
  assert.ok(['first', 'second'].includes(snapshot.generation));
  assert.equal(snapshot.values.length, 128);
  assert.deepEqual((await readdir(resolve(target, '..'))).sort(), ['hub-connector-state.json', 'hub-connector-state.json.previous-run.tmp']);
  assert.equal(await readFile(staleTemporary, 'utf8'), 'leave this file alone');
});
