import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { pairConnector } from '../scripts/setup-connector.mjs';
import { onboardConnector } from '../scripts/onboard-connector.mjs';

test('pairing credentials are atomically persisted with Windows private ACL support', async () => {
  const root = await mkdtemp(join(tmpdir(), 'connector-private-'));
  try {
    const path = join(root, 'credentials.json'), deviceId = randomUUID(), deviceToken = randomBytes(32).toString('base64url');
    await pairConnector({ origin: 'https://hub.example', pairingCode: randomBytes(32).toString('base64url'), configPath: path, fetchImpl: async () => new Response(JSON.stringify({ deviceId, deviceToken }), { status: 200 }) });
    const saved = JSON.parse(await readFile(path)); assert.equal(saved.deviceId, deviceId); assert.equal(saved.deviceToken, deviceToken);
    await assert.rejects(pairConnector({ origin: 'https://hub.example', pairingCode: randomBytes(32).toString('base64url'), configPath: path, fetchImpl: () => assert.fail('existing credentials must not trigger pairing') }), /已有连接器配置/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('onboarding must verify local desktop health before reading a code or consuming a pairing', async () => {
  await assert.rejects(onboardConnector({ origin: 'https://hub.example', ensureBridge: async () => ({ connected: false, port: 4317 }), pair: () => assert.fail('pairing must not run'), readCode: () => assert.fail('code must not be read'), launch: () => assert.fail('offline bridge must not launch') }), /尚未就绪/);
});

test('onboarding persists the verified bridge port before submitting connector startup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'connector-onboard-'));
  const configPath = join(root, 'credentials.json');
  try {
    const deviceId = randomUUID();
    const result = await onboardConnector({ origin: 'https://hub.example', root, configPath,
      ensureBridge: async () => ({ connected: true, port: 54321 }), readCode: async () => 'test-code',
      pair: async options => {
        assert.equal(options.bridgePort, 54321); assert.equal(options.pairingCode, 'test-code');
        const { writeFile } = await import('node:fs/promises');
        await writeFile(configPath, JSON.stringify({ hubOrigin: options.origin, bridgePort: options.bridgePort, deviceId }));
      }, launch: async options => { assert.equal(options.instanceName, 'hub-connector'); return { pid: 123 }; } });
    assert.equal(result.deviceId, deviceId); assert.equal(result.bridgePort, 54321); assert.equal(result.pid, 123);
    await onboardConnector({ origin: 'https://hub.example', root, configPath,
      ensureBridge: async () => ({ connected: true, port: 54321 }), readCode: () => assert.fail('existing credentials must be reused'),
      pair: () => assert.fail('existing credentials must be reused'), launch: async () => ({ pid: 123 }) });
  } finally { await rm(root, { recursive: true, force: true }); }
});
