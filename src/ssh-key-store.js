import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { root, httpError } from './db.js';

const exec = promisify(execFile);
const MAX_KEY_BYTES = 64 * 1024;

function safeOriginalName(value) {
  return path.basename(String(value || 'ssh-private-key')).slice(0, 255);
}

async function publicKeyFingerprint(privatePath, directory) {
  let publicKey;
  try {
    ({ stdout: publicKey } = await exec('ssh-keygen', ['-y', '-P', '', '-f', privatePath], { timeout: 8000, windowsHide: true, maxBuffer: 128 * 1024 }));
  } catch {
    throw httpError('私钥无效或带有密码；当前仅支持无密码 SSH 私钥', 400);
  }
  const publicPath = path.join(directory, `.${randomUUID()}.pub`);
  try {
    await writeFile(publicPath, publicKey, { mode: 0o600, flag: 'wx' });
    const { stdout } = await exec('ssh-keygen', ['-lf', publicPath, '-E', 'sha256'], { timeout: 8000, windowsHide: true, maxBuffer: 128 * 1024 });
    const fingerprint = stdout.match(/SHA256:[A-Za-z0-9+/=]+/)?.[0];
    if (!fingerprint) throw httpError('无法读取 SSH 私钥指纹', 400);
    return fingerprint;
  } finally {
    await rm(publicPath, { force: true });
  }
}

async function securePrivateKey(filePath) {
  await chmod(filePath, 0o600).catch(() => {});
  if (process.platform !== 'win32') return;
  const account = [process.env.USERDOMAIN, process.env.USERNAME].filter(Boolean).join('\\') || process.env.USERNAME;
  if (!account) throw httpError('无法确定本机账户，SSH 私钥权限未设置', 500);
  try { await exec('icacls', [filePath, '/inheritance:r', '/grant:r', `${account}:(F)`], { timeout: 8000, windowsHide: true, maxBuffer: 128 * 1024 }); }
  catch { throw httpError('无法收紧 SSH 私钥文件权限', 500); }
}

export class SshKeyStore {
  constructor(directory = path.join(root, 'storage', 'ssh-keys')) {
    this.directory = path.resolve(directory);
  }

  async init() {
    await mkdir(this.directory, { recursive: true });
    return this;
  }

  resolve(reference) {
    if (!reference) throw httpError('尚未上传 SSH 私钥', 409);
    if (path.isAbsolute(reference)) return reference;
    const resolved = path.resolve(root, reference);
    if (resolved !== this.directory && !resolved.startsWith(`${this.directory}${path.sep}`)) throw httpError('SSH 私钥路径不在受控目录内', 500);
    return resolved;
  }

  async save(buffer, originalName) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw httpError('请选择 SSH 私钥文件');
    if (buffer.length > MAX_KEY_BYTES) throw httpError('SSH 私钥文件不能超过 64 KiB', 413);
    const text = buffer.toString('utf8');
    if (text.includes('\0') || /ssh-(rsa|ed25519)|ecdsa-sha2-/i.test(text.trim().split(/\r?\n/, 1)[0]) || !/BEGIN (?:OPENSSH|RSA|EC|DSA) PRIVATE KEY/.test(text)) {
      throw httpError('上传内容不是受支持的 SSH 私钥', 400);
    }
    await this.init();
    const fileName = `${randomUUID()}.key`;
    const fullPath = path.join(this.directory, fileName);
    try {
      await writeFile(fullPath, buffer, { mode: 0o600, flag: 'wx' });
      await securePrivateKey(fullPath);
      const fingerprint = await publicKeyFingerprint(fullPath, this.directory);
      return { reference: path.relative(root, fullPath).split(path.sep).join('/'), originalName: safeOriginalName(originalName), fingerprint };
    } catch (error) {
      await rm(fullPath, { force: true });
      throw error;
    }
  }

  async migrateLegacyReferences(pool) {
    await this.init();
    const [rows] = await pool.query('SELECT id,ssh_key_ref,ssh_key_original_name FROM vps_servers');
    for (const row of rows) {
      if (!path.isAbsolute(row.ssh_key_ref || '')) continue;
      try {
        const info = await stat(row.ssh_key_ref);
        if (!info.isFile() || info.size > MAX_KEY_BYTES) continue;
        const saved = await this.save(await readFile(row.ssh_key_ref), row.ssh_key_original_name || path.basename(row.ssh_key_ref));
        await pool.execute('UPDATE vps_servers SET ssh_key_ref=?,ssh_key_original_name=?,ssh_key_fingerprint=? WHERE id=? AND ssh_key_ref=?',
          [saved.reference, saved.originalName, saved.fingerprint, row.id, row.ssh_key_ref]);
      } catch (error) {
        console.warn(`VPS ${row.id} 的旧私钥未迁移：${error.publicMessage || error.code || '无法读取'}`);
      }
    }
  }
}

export { MAX_KEY_BYTES };
