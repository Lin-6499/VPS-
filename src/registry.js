import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class DeviceRegistry {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { devices: {} };
  }

  async init() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try { this.data = JSON.parse(await readFile(this.filePath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return this;
  }

  decorate(device) {
    const meta = this.data.devices[device.uuid] || {};
    return { ...device, name: meta.name || device.email, note: meta.note || '来自 Xray 配置', createdAt: meta.createdAt || null, kind: meta.kind || 'desktop' };
  }

  async set(uuid, meta) {
    this.data.devices[uuid] = { ...this.data.devices[uuid], ...meta };
    const temp = `${this.filePath}.tmp`;
    await writeFile(temp, JSON.stringify(this.data, null, 2), 'utf8');
    await rename(temp, this.filePath);
  }
}
