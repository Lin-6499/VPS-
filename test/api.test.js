import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createAppServer } from '../src/server.js';
import { SshXrayProvider } from '../src/ssh-provider.js';

function fakeSnapshot() {
  return {
    provider: 'ssh-xray', host: '198.51.100.10', service: 'xray-test.service', serviceState: 'active',
    serviceStartedAt: 'Fri 2026-10-10 02:47:42 UTC', version: 'Xray 26.3.27', collectedAt: 1791604800,
    api: { listen: '127.0.0.1:10086', services: ['StatsService'], available: true },
    inbound: { tag: 'test-in', port: 8443, protocol: 'vless', network: 'tcp', security: 'reality', sni: 'www.example.com', shortId: '0123456789abcdef', publicKey: 'public-key' },
    devices: [{ uuid: '11111111-1111-4111-8111-111111111111', email: 'real-device', flow: 'xtls-rprx-vision', enabled: true, status: 'online', sessions: 1, sourceIps: ['203.0.113.5'], lastActive: '2026-10-10T03:00:00.000Z', traffic: { up: .125, down: .5, total: .625 } }]
  };
}

class FakeProvider {
  constructor() { this.value = fakeSnapshot(); }
  async snapshot() { return structuredClone(this.value); }
  async createDevice() {
    const device = { uuid: '22222222-2222-4222-8222-222222222222', email: 'device-22222222', flow: 'xtls-rprx-vision', enabled: true, status: 'offline', sessions: 0, sourceIps: [], lastActive: null, traffic: { up: 0, down: 0, total: 0 } };
    this.value.devices.push(device);
    return device;
  }
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xray-management-'));
  const { server } = await createAppServer({ provider: new FakeProvider(), registryFile: path.join(directory, 'registry.json') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  return baseUrl;
}

async function json(url, options) {
  const response = await fetch(url, options);
  return { response, body: await response.json() };
}

test('health reports SSH Xray service and API state', async t => {
  const baseUrl = await fixture(t);
  const { response, body } = await json(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  assert.equal(body.provider, 'ssh-xray');
  assert.equal(body.xrayVersion, 'Xray 26.3.27');
  assert.equal(body.api.available, true);
});

test('lists only provider devices with real counters and source IPs', async t => {
  const baseUrl = await fixture(t);
  const { body } = await json(`${baseUrl}/api/devices`);
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].email, 'real-device');
  assert.equal(body.items[0].traffic.total, .625);
  assert.deepEqual(body.items[0].sourceIps, ['203.0.113.5']);
});

test('returns service-session traffic without fabricated history', async t => {
  const baseUrl = await fixture(t);
  const uuid = '11111111-1111-4111-8111-111111111111';
  const { body } = await json(`${baseUrl}/api/devices/${uuid}/traffic`);
  assert.equal(body.scope, 'service-session');
  assert.equal(body.totals.total, .625);
  assert.equal(body.samples.length, 1);
  assert.equal('series' in body, false);
});

test('generates QR from the same real VLESS URI returned by details', async t => {
  const baseUrl = await fixture(t);
  const uuid = '11111111-1111-4111-8111-111111111111';
  const details = await json(`${baseUrl}/api/devices/${uuid}`);
  assert.match(details.body.vlessUri, /^vless:\/\/11111111/);
  assert.match(details.body.vlessUri, /198\.51\.100\.10%3A8443|198\.51\.100\.10:8443/);
  const qr = await fetch(`${baseUrl}/api/devices/${uuid}/qrcode`);
  assert.match(qr.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(await qr.text(), /<svg/);
});

test('creates a provider device and records only user-supplied metadata', async t => {
  const baseUrl = await fixture(t);
  const created = await json(`${baseUrl}/api/devices`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '真实测试设备', note: 'SSH 测试' }) });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.device.name, '真实测试设备');
  assert.equal(created.body.device.email, 'device-22222222');
});

test('read-only SSH integration reaches the isolated Xray Stats API', { skip: process.env.XRAY_SSH_INTEGRATION !== '1' }, async () => {
  const snapshot = await new SshXrayProvider({ cacheMs: 0 }).snapshot({ fresh: true });
  assert.equal(snapshot.provider, 'ssh-xray');
  assert.equal(snapshot.serviceState, 'active');
  assert.ok(snapshot.api.services.includes('StatsService'));
  assert.equal(snapshot.inbound.port, 8443);
  assert.ok(snapshot.devices.length >= 1);
  assert.ok(snapshot.devices.every(device => typeof device.traffic.total === 'number'));
});
