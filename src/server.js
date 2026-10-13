import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, stat } from 'node:fs/promises';
import QRCode from 'qrcode';
import { SshXrayProvider, createVlessUri } from './ssh-provider.js';
import { DeviceRegistry } from './registry.js';
import { createDatabaseServer } from './database-server.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(root, 'public');
const contentTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': contentTypes['.json'], 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw Object.assign(new Error('请求内容过大'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('JSON 格式无效'), { status: 400 }); }
}

async function serveStatic(pathname, response) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(publicRoot, relative);
  if (!filePath.startsWith(`${publicRoot}${path.sep}`)) return false;
  try {
    if (!(await stat(filePath)).isFile()) return false;
    response.writeHead(200, { 'content-type': contentTypes[path.extname(filePath)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    response.end(await readFile(filePath));
    return true;
  } catch { return false; }
}

function publicDevices(snapshot, registry) {
  return snapshot.devices.map(device => registry.decorate(device));
}

export async function createAppServer(options = {}) {
  if (!options.provider) return createDatabaseServer(options);
  const provider = options.provider || new SshXrayProvider(options.ssh);
  const registry = options.registry || await new DeviceRegistry(options.registryFile || path.join(root, 'data', 'registry.json')).init();
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const segments = url.pathname.split('/').filter(Boolean);

      if (request.method === 'GET' && url.pathname === '/api/health') {
        const snapshot = await provider.snapshot({ fresh: true });
        return sendJson(response, 200, { ok: snapshot.serviceState === 'active' && snapshot.api.available, provider: snapshot.provider, host: snapshot.host, xrayVersion: snapshot.version, service: snapshot.service, serviceState: snapshot.serviceState, api: snapshot.api });
      }

      if (request.method === 'GET' && url.pathname === '/api/dashboard') {
        const snapshot = await provider.snapshot();
        const traffic = snapshot.devices.reduce((sum, device) => sum + device.traffic.total, 0);
        return sendJson(response, 200, { total: snapshot.devices.length, online: snapshot.devices.filter(device => device.status === 'online').length, disabled: 0, totalTraffic: Number(traffic.toFixed(4)), provider: snapshot.provider, version: snapshot.version, serviceState: snapshot.serviceState, collectedAt: snapshot.collectedAt });
      }

      if (request.method === 'GET' && url.pathname === '/api/devices') {
        const snapshot = await provider.snapshot();
        const query = (url.searchParams.get('query') || '').trim().toLowerCase();
        const status = url.searchParams.get('status') || 'all';
        const items = publicDevices(snapshot, registry).filter(device => status === 'all' || device.status === status).filter(device => !query || [device.name, device.note, device.uuid, device.email, ...device.sourceIps].join(' ').toLowerCase().includes(query));
        return sendJson(response, 200, { items, collectedAt: snapshot.collectedAt });
      }

      if (request.method === 'POST' && url.pathname === '/api/devices') {
        const body = await readJson(request);
        if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 30) return sendJson(response, 400, { error: '设备名称必填，且不能超过 30 个字符' });
        if (body.note != null && (typeof body.note !== 'string' || body.note.length > 60)) return sendJson(response, 400, { error: '设备备注不能超过 60 个字符' });
        const created = await provider.createDevice();
        await registry.set(created.uuid, { name: body.name.trim(), note: body.note?.trim() || 'SSH 创建的测试设备', createdAt: new Date().toISOString(), kind: 'desktop' });
        const snapshot = await provider.snapshot({ fresh: true });
        const device = registry.decorate(snapshot.devices.find(item => item.uuid === created.uuid));
        return sendJson(response, 201, { device, warning: '创建过程仅重启了隔离测试服务，累计统计已重新开始。' });
      }

      if (segments[0] === 'api' && segments[1] === 'devices' && segments[2]) {
        const uuid = decodeURIComponent(segments[2]);
        const snapshot = await provider.snapshot();
        const rawDevice = snapshot.devices.find(device => device.uuid === uuid);
        if (!rawDevice) return sendJson(response, 404, { error: '测试节点配置中没有该 UUID' });
        const device = registry.decorate(rawDevice);

        if (request.method === 'GET' && segments.length === 3) return sendJson(response, 200, { device, vlessUri: createVlessUri(snapshot, device), node: snapshot.inbound });
        if (request.method === 'GET' && segments[3] === 'traffic') return sendJson(response, 200, { uuid: device.uuid, name: device.name, scope: 'service-session', scopeLabel: '测试服务本次运行累计', serviceStartedAt: snapshot.serviceStartedAt, collectedAt: snapshot.collectedAt, unit: 'GB', totals: device.traffic, samples: [{ collectedAt: snapshot.collectedAt, ...device.traffic }] });
        if (request.method === 'GET' && segments[3] === 'qrcode') {
          const svg = await QRCode.toString(createVlessUri(snapshot, device), { type: 'svg', width: 220, margin: 2, color: { dark: '#162235', light: '#ffffff' }, errorCorrectionLevel: 'M' });
          response.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-store' });
          return response.end(svg);
        }
      }

      if (request.method === 'GET' || request.method === 'HEAD') {
        if (await serveStatic(url.pathname, response)) return;
      }
      sendJson(response, 404, { error: '接口或页面不存在' });
    } catch (error) {
      console.error(error.message);
      sendJson(response, error.status || 502, { error: error.status ? error.message : `SSH/Xray 操作失败：${error.message}` });
    }
  });
  return { server, provider, registry };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8787);
  const app = await createAppServer();
  const { server } = app;
  server.listen(port, '127.0.0.1', () => {
    console.log(`XrayManagement running at http://127.0.0.1:${port}`);
    console.log('Provider: MySQL + SSH collector (60 seconds)');
    if(app.auth?.setupToken)console.log(`首次设置管理员：http://127.0.0.1:${port}/setup.html?token=${app.auth.setupToken}`);
  });
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal,async()=>{await app.close();process.exit(0);});
}
