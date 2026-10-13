import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rm, writeFile } from 'node:fs/promises';
import { root, httpError } from './db.js';

const exec = promisify(execFile);

async function run(command, args, timeout = 15000) {
  try { return await exec(command, args, { timeout, windowsHide: true, maxBuffer: 512 * 1024 }); }
  catch (error) {
    if (error.killed) throw httpError('SSH 检测超时，请检查公网地址、端口和防火墙', 504);
    throw error;
  }
}

export async function hostKeyFingerprint(hostKey) {
  const temp = path.join(root, 'storage', 'ssh-keys', `.${randomUUID()}.host.pub`);
  try {
    await writeFile(temp, `${hostKey.trim()}\n`, { mode: 0o600, flag: 'wx' });
    const { stdout } = await run('ssh-keygen', ['-lf', temp, '-E', 'sha256'], 8000);
    const fingerprint = stdout.match(/SHA256:[A-Za-z0-9+/=]+/)?.[0];
    if (!fingerprint) throw httpError('无法读取远端主机指纹', 502);
    return fingerprint;
  } finally { await rm(temp, { force: true }); }
}

export async function scanHostKey(host, port) {
  let stdout;
  try { ({ stdout } = await run('ssh-keyscan', ['-T', '8', '-p', String(port), host], 12000)); }
  catch { throw httpError('无法读取 SSH 主机密钥，请检查 IPv4、端口和防火墙', 502); }
  const lines = stdout.split(/\r?\n/).map(v => v.trim()).filter(v => v && !v.startsWith('#'));
  const hostKey = lines.find(v => /\s+ssh-ed25519\s+/.test(v)) || lines.find(v => /\s+ecdsa-sha2-/.test(v)) || lines.find(v => /\s+ssh-rsa\s+/.test(v));
  if (!hostKey) throw httpError('远端未返回可识别的 SSH 主机密钥', 502);
  return { hostKey, fingerprint: await hostKeyFingerprint(hostKey) };
}

export async function trustedSsh(server, keyPath, command, options = {}) {
  const knownHostLine = server.ssh_host_key;
  if (!knownHostLine) throw httpError('请先在 VPS 管理中测试 SSH 并确认主机指纹', 409);
  const knownHostsPath = path.join(root, 'storage', 'ssh-keys', `.${randomUUID()}.known_hosts`);
  try {
    await writeFile(knownHostsPath, `${knownHostLine.trim()}\n`, { mode: 0o600, flag: 'wx' });
    return await exec('ssh', ['-i', keyPath, '-p', String(server.ssh_port), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
      '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${knownHostsPath}`, '-o', `GlobalKnownHostsFile=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
      '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2',
      `${server.ssh_user}@${server.ssh_host}`, command], {timeout:options.timeout || 120000,maxBuffer:8*1024*1024,windowsHide:true});
  } catch (error) {
    if (error.publicMessage) throw error;
    const stderr = String(error.stderr || '').toLowerCase();
    if (error.killed) throw httpError('SSH 检测超时，请检查网络后重试', 504);
    if (stderr.includes('permission denied')) throw httpError('SSH 身份验证失败，请检查用户名和私钥', 401);
    if (stderr.includes('host key verification failed')) throw httpError('SSH 主机密钥校验失败，连接已阻止', 409);
    throw error;
  } finally { await rm(knownHostsPath, { force: true }); }
}

export async function verifySsh(server, keyPath, knownHostLine) {
  const {stdout} = await trustedSsh({...server,ssh_host_key:knownHostLine},keyPath,'printf RAYGATE_OK',{timeout:20000});
  if (stdout.trim() !== 'RAYGATE_OK') throw httpError('SSH 已连接，但远端校验响应异常', 502);
}
