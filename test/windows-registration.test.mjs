import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWindowsRegistration, recoveryIdentity, startupCommand } from '../src/recovery.mjs';

const execute = promisify(execFile);
const literal = value => `'${String(value).replaceAll("'", "''")}'`;
async function powershell(script) {
  const { stdout } = await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ErrorActionPreference='Stop'\n${script}`, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15000 });
  return stdout.trim();
}

test('Windows registration changes only its owned value and preserves siblings and alien commands', { skip: process.platform !== 'win32', timeout: 40000 }, async () => {
  const registryKey = `HKCU:\\Software\\CodexBridgeTests-${randomUUID()}`;
  const root = "C:\\bridge's test";
  const nodePath = 'C:\\node.exe';
  const name = `CodexMobileBridge-${recoveryIdentity(root)}`;
  const registration = createWindowsRegistration({ root, nodePath, registryKey });
  const readValues = async () => JSON.parse(await powershell(`$properties=Get-ItemProperty -LiteralPath ${literal(registryKey)}\n@{ sibling=$properties.Sibling; owned=$properties.PSObject.Properties[${literal(name)}].Value } | ConvertTo-Json -Compress`));
  try {
    await powershell(`New-Item -Path ${literal(registryKey)} | Out-Null\nSet-ItemProperty -LiteralPath ${literal(registryKey)} -Name Sibling -Value 'keep-me'`);
    assert.deepEqual(await registration.read(), { enabled: false, conflict: false });
    assert.deepEqual(await registration.set(true), { enabled: true, conflict: false });
    assert.deepEqual(await readValues(), { sibling: 'keep-me', owned: startupCommand(root, nodePath) });
    assert.deepEqual(await registration.set(false), { enabled: false, conflict: false });
    assert.deepEqual(await readValues(), { sibling: 'keep-me', owned: null });
    await powershell(`Set-ItemProperty -LiteralPath ${literal(registryKey)} -Name ${literal(name)} -Value 'alien-command'`);
    assert.deepEqual(await registration.read(), { enabled: false, conflict: true });
    await assert.rejects(registration.set(true));
    await assert.rejects(registration.set(false));
    assert.deepEqual(await readValues(), { sibling: 'keep-me', owned: 'alien-command' });
  } finally {
    // Remove only this freshly generated isolated test key, never the shared Run key.
    await powershell(`if (Test-Path -LiteralPath ${literal(registryKey)}) { Remove-Item -LiteralPath ${literal(registryKey)} -Recurse }`);
  }
});
