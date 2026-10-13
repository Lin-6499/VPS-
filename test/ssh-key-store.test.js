import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { SshKeyStore } from '../src/ssh-key-store.js';

const exec = promisify(execFile);

test('SSH private keys are validated, fingerprinted and stored with opaque names', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'raygate-key-test-'));
  try {
    const source = path.join(temp, 'fixture_ed25519');
    await exec('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'raygate-test', '-f', source], { windowsHide: true });
    const store = await new SshKeyStore(path.join(temp, 'managed')).init();
    const saved = await store.save(await readFile(source), 'fixture_ed25519');
    assert.match(saved.reference, /[0-9a-f-]{36}\.key$/);
    assert.equal(saved.originalName, 'fixture_ed25519');
    assert.match(saved.fingerprint, /^SHA256:/);
    assert.equal((await stat(store.resolve(saved.reference))).size > 0, true);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('encrypted SSH private keys are rejected without prompting', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'raygate-key-test-'));
  try {
    const source = path.join(temp, 'encrypted_ed25519');
    await exec('ssh-keygen', ['-q', '-t', 'ed25519', '-N', 'not-used-by-raygate', '-f', source], { windowsHide: true });
    const store = await new SshKeyStore(path.join(temp, 'managed')).init();
    await assert.rejects(store.save(await readFile(source), 'encrypted_ed25519'), /无密码 SSH 私钥/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
