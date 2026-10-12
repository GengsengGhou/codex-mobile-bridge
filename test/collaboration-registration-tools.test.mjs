import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import TOML from '@iarna/toml';
import { registerCollaboration, collaborationServerName } from '../scripts/collaboration-registration.mjs';
import { collaborationSettings } from '../scripts/collaboration-settings.mjs';
import { disableCollaborationForUninstall } from '../scripts/collaboration-lifecycle.mjs';

const tools = { list_computers: { approval_mode: 'prompt', output_token_limit: 512 }, create_task: { approval_mode: 'approve' } };
async function fixture(t, name) {
  const evidence = resolve('work/collaboration-binding-followup'); await mkdir(evidence, { recursive: true });
  const root = await mkdtemp(resolve(evidence, name + '-')); t.after(() => rm(root, { recursive: true, force: true }));
  const codexHome = resolve(root, 'codex-home'); await mkdir(codexHome);
  const configPath = resolve(codexHome, 'config.toml'), provider = '# isolated provider\r\n[model_providers.fixture]\r\napi_key="fixture-provider-only"\r\n';
  await writeFile(configPath, provider);
  await registerCollaboration({ root, codexHome, enabled: true });
  const ledgerPath = resolve(root, '.local/collaboration-registration.json'), ledgerBytes = await readFile(ledgerPath), ledger = JSON.parse(ledgerBytes);
  return { root, codexHome, configPath, provider, ledgerPath, ledgerBytes, ledger };
}
async function setEntry(f, entry) {
  const before = f.provider + '# custom per-tool choices remain verbatim\r\n' + TOML.stringify({ mcp_servers: { [collaborationServerName]: entry } }).replaceAll('\n', '\r\n');
  await writeFile(f.configPath, before); return before;
}

test('valid owned core plus Codex per-tool settings enables without rewriting limits or formatting', { skip: process.platform !== 'win32' }, async t => {
  // Exact LAPTOP-JLLUNG5K report: one approval override, no budget or enabled.
  const targetTools = { collaboration_devices: { approval_mode: 'approve' } };
  const f = await fixture(t, 'tools-enable'), before = await setEntry(f, { ...f.ledger.entry, tools: targetTools });
  assert.equal((await registerCollaboration({ ...f, enabled: true })).status, 'registered');
  assert.equal(await readFile(f.configPath, 'utf8'), before); assert.deepEqual(await readFile(f.ledgerPath), f.ledgerBytes);
  for (const approval_mode of ['auto', 'prompt', 'writes', 'approve']) {
    const changedTools = { ...tools, read_file: { approval_mode, output_token_limit: 1 } };
    const changed = await setEntry(f, { ...f.ledger.entry, tools: changedTools });
    assert.equal((await registerCollaboration({ ...f, enabled: true })).status, 'registered');
    assert.equal(await readFile(f.configPath, 'utf8'), changed); assert.deepEqual(await readFile(f.ledgerPath), f.ledgerBytes);
  }
});

test('explicit control disable and re-enable preserve tool restrictions, pairing, receipts and provider bytes', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t, 'tools-cycle'), before = await setEntry(f, { ...f.ledger.entry, tools });
  const deviceId = randomUUID(), pairingPath = resolve(f.root, '.local/hub-connector.json'), policyPath = resolve(f.root, '.local/computer-collaboration.json'), receiptPath = resolve(f.root, '.local/receipt-fixture.json');
  const pairing = { version: 1, hubOrigin: 'https://fixture.invalid', deviceId, deviceToken: 'f'.repeat(43), bridgePort: 4317 };
  await writeFile(pairingPath, JSON.stringify(pairing)); await writeFile(receiptPath, 'fixture-receipt-kept\r\n');
  await writeFile(policyPath, JSON.stringify({ version: 1, hubOrigin: pairing.hubOrigin, deviceId, controlEnabled: true, receiveEnabled: false, allowedDeviceIds: [], allowedProjectRoots: [] }));
  const pairingBytes = await readFile(pairingPath), receiptBytes = await readFile(receiptPath);
  const options = { root: f.root, codexHome: f.codexHome, fetchImpl: async () => Response.json({ version: 1, sourceDeviceId: deviceId, devices: [] }), bridge: async () => ({ projects: [] }) };
  const command = { action: 'save-collaboration', controlEnabled: false, receiveEnabled: false, allowedDeviceIds: [], allowedProjectRoots: [] };
  const disabled = await collaborationSettings(command, options);
  assert.equal(disabled.collaboration.controlEnabled, false); assert.equal(disabled.collaboration.registration.status, 'disabled'); assert.equal(disabled.collaboration.registration.configurationPreserved, true);
  assert.match(disabled.collaboration.registration.message, /工具设置.*保留/);
  assert.equal(JSON.parse(await readFile(policyPath, 'utf8')).controlEnabled, false);
  assert.equal(await readFile(f.configPath, 'utf8'), before); assert.deepEqual(await readFile(f.ledgerPath), f.ledgerBytes);
  const enabled = await collaborationSettings({ ...command, controlEnabled: true }, options);
  assert.equal(enabled.collaboration.controlEnabled, true); assert.equal(enabled.collaboration.registration.status, 'registered');
  assert.equal(await readFile(f.configPath, 'utf8'), before); assert.deepEqual(await readFile(f.ledgerPath), f.ledgerBytes);
  assert.deepEqual(await readFile(pairingPath), pairingBytes); assert.deepEqual(await readFile(receiptPath), receiptBytes);
});

test('uninstall closes authorization and reports preserved per-tool config rather than deleting restrictions', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t, 'tools-uninstall'), before = await setEntry(f, { ...f.ledger.entry, tools });
  const policyPath = resolve(f.root, '.local/computer-collaboration.json');
  await writeFile(policyPath, JSON.stringify({ controlEnabled: true, receiveEnabled: true, controlPending: true, requiresAuthorization: true, allowedDeviceIds: ['fixture'] }));
  const result = await disableCollaborationForUninstall({ root: f.root });
  assert.equal(result.disabled, true); assert.equal(result.configurationPreserved, true); assert.equal(result.ownedRegistrationRemoved, false); assert.match(result.warning, /工具设置.*保留/); assert.match(result.warning, /手动移除/);
  assert.equal(await readFile(f.configPath, 'utf8'), before); assert.deepEqual(await readFile(f.ledgerPath), f.ledgerBytes);
  const policy = JSON.parse(await readFile(policyPath, 'utf8'));
  assert.equal(policy.controlEnabled, false); assert.equal(policy.receiveEnabled, false); assert.equal(policy.controlPending, false); assert.equal(policy.requiresAuthorization, false);
});

test('tools preferences do not bypass the current installation guard or disappear on disable', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t, 'tools-old-root'), before = await setEntry(f, { ...f.ledger.entry, tools });
  const copiedRoot = resolve(f.root, 'copied-install'); await mkdir(resolve(copiedRoot, '.local'), { recursive: true });
  const copiedLedger = resolve(copiedRoot, '.local/collaboration-registration.json'); await writeFile(copiedLedger, f.ledgerBytes);
  await assert.rejects(registerCollaboration({ root: copiedRoot, codexHome: f.codexHome, enabled: true }), error => error.code === 'MCP_REGISTRATION_ROOT_MISMATCH' && /工具限制/.test(error.message));
  const disabled = await registerCollaboration({ root: copiedRoot, codexHome: f.codexHome, enabled: false });
  assert.equal(disabled.configurationPreserved, true); assert.equal(await readFile(f.configPath, 'utf8'), before); assert.deepEqual(await readFile(copiedLedger), f.ledgerBytes);
});

test('tools compatibility never accepts altered core, unknown options, malformed tools or invalid ownership', { skip: process.platform !== 'win32' }, async t => {
  const changes = [
    ['command', entry => ({ ...entry, command: 'foreign-command', tools })],
    ['args', entry => ({ ...entry, args: [...entry.args, '--foreign-option'], tools })],
    ['env', entry => ({ ...entry, env: {}, tools })],
    ['enabled', entry => ({ ...entry, enabled: true, tools })],
    ['unknown', entry => ({ ...entry, startup_timeout_sec: 20, tools })],
    ['array', entry => ({ ...entry, tools: [] })],
    ['scalar', entry => ({ ...entry, tools: false })],
    ['datetime', entry => ({ ...entry, tools: new Date('2026-01-01T00:00:00Z') })],
    ['tool-datetime', entry => ({ ...entry, tools: { list_computers: new Date('2026-01-01T00:00:00Z') } })],
    ['flat-enabled', entry => ({ ...entry, tools: { enabled: true } })],
    ['bad-enabled', entry => ({ ...entry, tools: { list_computers: { enabled: 'false' } } })],
    ['undocumented-enabled', entry => ({ ...entry, tools: { list_computers: { enabled: false } } })],
    ['bad-approval', entry => ({ ...entry, tools: { create_task: { approval_mode: 'never' } } })],
    ['non-string-approval', entry => ({ ...entry, tools: { create_task: { approval_mode: true } } })],
    ['zero-budget', entry => ({ ...entry, tools: { read_file: { output_token_limit: 0 } } })],
    ['negative-budget', entry => ({ ...entry, tools: { read_file: { output_token_limit: -1 } } })],
    ['fractional-budget', entry => ({ ...entry, tools: { read_file: { output_token_limit: 1.5 } } })],
    ['string-budget', entry => ({ ...entry, tools: { read_file: { output_token_limit: '512' } } })],
    ['nested-command', entry => ({ ...entry, tools: { list_computers: { enabled: true, command: 'foreign' } } })],
    ['nested-unknown', entry => ({ ...entry, tools: { list_computers: { unknown: true } } })]
  ];
  for (const [name, change] of changes) {
    const f = await fixture(t, 'tools-reject-' + name), before = await setEntry(f, change(f.ledger.entry));
    for (const enabled of [true, false]) await assert.rejects(registerCollaboration({ ...f, enabled }), error => error.code === 'MCP_REGISTRATION_CONFLICT');
    assert.equal(await readFile(f.configPath, 'utf8'), before); assert.deepEqual(await readFile(f.ledgerPath), f.ledgerBytes);
  }
  for (const damage of ['missing-ledger', 'hash', 'config-path']) {
    const f = await fixture(t, 'tools-ownership-' + damage), before = await setEntry(f, { ...f.ledger.entry, tools });
    if (damage === 'missing-ledger') await rm(f.ledgerPath);
    else await writeFile(f.ledgerPath, JSON.stringify({ ...f.ledger, ...(damage === 'hash' ? { blockHash: 'damaged' } : { configPath: resolve(f.root, 'other-config.toml') }) }));
    const ledgerBefore = await readFile(f.ledgerPath).catch(() => null);
    for (const enabled of [true, false]) await assert.rejects(registerCollaboration({ ...f, enabled }), error => error.code === (damage === 'missing-ledger' ? 'MCP_REGISTRATION_CONFLICT' : 'MCP_REGISTRATION_RECOVERY_REQUIRED'));
    assert.equal(await readFile(f.configPath, 'utf8'), before); assert.deepEqual(await readFile(f.ledgerPath).catch(() => null), ledgerBefore);
  }
});
