import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { root, httpError } from './db.js';

const exec = promisify(execFile);

async function secureFile(filePath) {
  await chmod(filePath, 0o600).catch(() => {});
  if (process.platform !== 'win32') return;
  const account = [process.env.USERDOMAIN, process.env.USERNAME].filter(Boolean).join('\\') || process.env.USERNAME;
  if (!account) throw httpError('无法确定本机账户，KiwiVM 密钥权限未设置', 500);
  try {
    await exec('icacls', [filePath, '/inheritance:r', '/grant:r', `${account}:(F)`], { timeout: 8000, windowsHide: true, maxBuffer: 128 * 1024 });
  } catch {
    throw httpError('无法收紧 KiwiVM 密钥文件权限', 500);
  }
}

export class ProviderSecretStore {
  constructor(directory = path.join(root, 'storage', 'provider-secrets')) {
    this.directory = path.resolve(directory);
  }
  async init() { await mkdir(this.directory, { recursive: true }); return this; }
  resolve(reference) {
    if (!reference || path.isAbsolute(reference)) throw httpError('KiwiVM 密钥引用无效', 500);
    const resolved = path.resolve(root, reference);
    if (resolved !== this.directory && !resolved.startsWith(`${this.directory}${path.sep}`)) throw httpError('KiwiVM 密钥不在受控目录内', 500);
    return resolved;
  }
  async save(secret) {
    if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(secret.trim())) throw httpError('KiwiVM API Key 格式无效（应为 16–128 位字母、数字、下划线或连字符）');
    await this.init();
    const fullPath = path.join(this.directory, `${randomUUID()}.secret`);
    try {
      await writeFile(fullPath, secret.trim(), { mode: 0o600, flag: 'wx' });
      await secureFile(fullPath);
      return path.relative(root, fullPath).split(path.sep).join('/');
    } catch (error) {
      await rm(fullPath, { force: true });
      throw error;
    }
  }
  async read(reference) {
    try { return (await readFile(this.resolve(reference), 'utf8')).trim(); }
    catch (error) { if (error.publicMessage) throw error; throw httpError('无法读取 KiwiVM API Key，请重新配置', 409); }
  }
  async remove(reference) {
    if (!reference) return;
    await rm(this.resolve(reference), { force: true });
  }
}
