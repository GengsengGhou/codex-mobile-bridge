import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import TOML from '@iarna/toml';
import { registerCollaboration, collaborationServerName } from '../scripts/collaboration-registration.mjs';
import { collaborationSettings } from '../scripts/collaboration-settings.mjs';

async function fixture(t) {
  const evidence = resolve('work/collaboration-binding-followup'); await mkdir(evidence, { recursive: true });
  const base = await mkdtemp(resolve(evidence, 'registration-root-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const oldRoot = resolve(base, 'old-install'), root = resolve(base, 'current-install'), codexHome = resolve(base, 'codex-home');
  for (const path of [resolve(oldRoot, '.local'), resolve(root, '.local'), codexHome]) await mkdir(path, { recursive: true });
  const configPath = resolve(codexHome, 'config.toml');
  const provider = '# fixture provider\nmodel_provider="fixture"\n[model_providers.fixture]\napi_key="fixture-key-only"\n'; await writeFile(configPath, provider);
  await registerCollaboration({ root: oldRoot, codexHome, enabled: true });
  const ledgerPath = resolve(root, '.local/collaboration-registration.json');
  await copyFile(resolve(oldRoot, '.local/collaboration-registration.json'), ledgerPath);
  return { oldRoot, root, codexHome, configPath, ledgerPath, provider };
}

test('copied valid ownership ledger cannot claim another installation script as current-root ready', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), beforeConfig = await readFile(f.configPath), beforeLedger = await readFile(f.ledgerPath);
  await assert.rejects(registerCollaboration({ root: f.root, codexHome: f.codexHome, enabled: true }), error => error.code === 'MCP_REGISTRATION_ROOT_MISMATCH' && /关闭指挥并保存/.test(error.message));
  assert.deepEqual(await readFile(f.configPath), beforeConfig); assert.deepEqual(await readFile(f.ledgerPath), beforeLedger);
  assert.equal(TOML.parse(beforeConfig.toString()).mcp_servers[collaborationServerName].args[0], resolve(f.oldRoot, 'scripts/collaboration-mcp.mjs'));
});

test('explicit verified old-root disable then enable preserves pairing and selected grants without automatic migration', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), deviceId = randomUUID(), peerId = randomUUID(), project = resolve(f.root, 'project'); await mkdir(project);
  const pairingPath = resolve(f.root, '.local/hub-connector.json'), policyPath = resolve(f.root, '.local/computer-collaboration.json'), receipt = resolve(f.root, '.local/receipt-fixture.json');
  const pairing = { version: 1, hubOrigin: 'https://fixture.invalid', deviceId, deviceToken: 'f'.repeat(43), bridgePort: 4317 };
  const policy = { version: 1, hubOrigin: pairing.hubOrigin, deviceId, controlEnabled: true, receiveEnabled: true, requiresAuthorization: false, allowedDeviceIds: [peerId], allowedProjectRoots: [project] };
  await writeFile(pairingPath, JSON.stringify(pairing)); await writeFile(policyPath, JSON.stringify(policy)); await writeFile(receipt, 'fixture-receipt-kept\r\n');
  const beforePairing = await readFile(pairingPath), beforeConfig = await readFile(f.configPath), beforeReceipt = await readFile(receipt);
  const options = { root: f.root, codexHome: f.codexHome, fetchImpl: async () => Response.json({ version: 1, sourceDeviceId: deviceId, devices: [{ id: peerId, online: true }] }), bridge: async () => ({ projects: [{ projectId: 'fixture-project', path: project, label: 'Fixture' }] }) };
  const save = { action: 'save-collaboration', controlEnabled: true, receiveEnabled: true, allowedDeviceIds: [peerId], allowedProjectRoots: [project] };
  await assert.rejects(collaborationSettings(save, options), error => error.code === 'MCP_REGISTRATION_ROOT_MISMATCH');
  assert.deepEqual(await readFile(f.configPath), beforeConfig); assert.deepEqual(await readFile(pairingPath), beforePairing);
  const blockedPolicy = JSON.parse(await readFile(policyPath, 'utf8'));
  assert.equal(blockedPolicy.controlEnabled, false); assert.equal(blockedPolicy.receiveEnabled, true); assert.deepEqual(blockedPolicy.allowedDeviceIds, [peerId]); assert.deepEqual(blockedPolicy.allowedProjectRoots, [project]);
  assert.equal(JSON.parse(await readFile(resolve(f.root, '.local/collaboration-registration-state.json'), 'utf8')).code, 'MCP_REGISTRATION_ROOT_MISMATCH');
  await collaborationSettings({ ...save, controlEnabled: false }, options);
  assert.equal(TOML.parse(await readFile(f.configPath, 'utf8')).mcp_servers?.[collaborationServerName], undefined);
  const enabled = await collaborationSettings(save, options); assert.equal(enabled.collaboration.registration.status, 'registered'); assert.equal(enabled.collaboration.controlEnabled, true);
  assert.equal(TOML.parse(await readFile(f.configPath, 'utf8')).mcp_servers[collaborationServerName].args[0], resolve(f.root, 'scripts/collaboration-mcp.mjs'));
  assert.equal((await readFile(f.configPath, 'utf8')).startsWith(f.provider), true); assert.deepEqual(await readFile(pairingPath), beforePairing); assert.deepEqual(await readFile(receipt), beforeReceipt);
  const finalPolicy = JSON.parse(await readFile(policyPath, 'utf8')); assert.equal(finalPolicy.receiveEnabled, true); assert.deepEqual(finalPolicy.allowedDeviceIds, [peerId]); assert.deepEqual(finalPolicy.allowedProjectRoots, [project]);
});
