import { KiwiVmClient, normalizeKiwiVmCredentials } from './kiwivm-client.js';
import { httpError, safeError, transaction } from './db.js';
import { sqlDate } from './traffic.js';

export class BandwidthSync {
  constructor(pool, secretStore, clientFactory = credentials => new KiwiVmClient(credentials)) {
    this.pool = pool;
    this.secretStore = secretStore;
    this.clientFactory = clientFactory;
    this.chains = new Map();
    this.timers = [];
    this.stopping = false;
  }
  exclusive(serverId, task) {
    const key = String(serverId), previous = this.chains.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    this.chains.set(key, current);
    return current.finally(() => { if (this.chains.get(key) === current) this.chains.delete(key); });
  }
  async configured(serverId) {
    const [[row]] = await this.pool.execute('SELECT * FROM vps_servers WHERE id=?', [serverId]);
    if (!row) throw httpError('VPS 不存在', 404);
    if (row.bandwidth_provider !== 'kiwivm' || !row.kiwivm_veid || !row.kiwivm_api_key_ref) throw httpError('请先配置 KiwiVM VEID 和 API Key', 409);
    return row;
  }
  async fetch(row, reference = row.kiwivm_api_key_ref, veid = row.kiwivm_veid) {
    const apiKey = await this.secretStore.read(reference);
    const credentials = normalizeKiwiVmCredentials({ veid, apiKey });
    return this.clientFactory(credentials).getServiceInfo();
  }
  async writeSuccess(serverId, info, extraSql = '', extraParams = []) {
    await this.pool.execute(`UPDATE vps_servers SET traffic_quota_gb=?,provider_traffic_used_gb=?,provider_traffic_recorded_at=UTC_TIMESTAMP(3),provider_usage_source='kiwivm',provider_sync_status='ok',provider_synced_at=UTC_TIMESTAMP(3),provider_sync_error=NULL,provider_traffic_reset_at=?,provider_traffic_multiplier=?${extraSql} WHERE id=?`,
      [info.quotaGb, info.usedGb, info.resetAt ? sqlDate(info.resetAt) : null, info.multiplier, ...extraParams, serverId]);
  }
  sync(serverId) {
    return this.exclusive(serverId, async () => {
      const row = await this.configured(serverId);
      await this.pool.execute("UPDATE vps_servers SET provider_sync_status='syncing',provider_sync_error=NULL WHERE id=?", [serverId]);
      try {
        const info = await this.fetch(row);
        await this.writeSuccess(serverId, info);
        return info;
      } catch (error) {
        await this.pool.execute("UPDATE vps_servers SET provider_sync_status='error',provider_sync_error=? WHERE id=?", [safeError(error).slice(0, 512), serverId]);
        throw error;
      }
    });
  }
  configure(serverId, { veid, apiKey }) {
    return this.exclusive(serverId, async () => {
      const [[row]] = await this.pool.execute('SELECT * FROM vps_servers WHERE id=?', [serverId]);
      if (!row) throw httpError('VPS 不存在', 404);
      const normalizedVeid = String(veid || '').trim();
      if (!/^\d{1,20}$/.test(normalizedVeid)) throw httpError('VEID 必须是 1–20 位数字');
      let newReference = null;
      if (apiKey != null && String(apiKey).trim()) newReference = await this.secretStore.save(String(apiKey));
      const reference = newReference || row.kiwivm_api_key_ref;
      if (!reference) throw httpError('首次配置必须填写 KiwiVM API Key');
      try {
        const info = await this.fetch(row, reference, normalizedVeid);
        await this.writeSuccess(serverId, info, ",bandwidth_provider='kiwivm',kiwivm_veid=?,kiwivm_api_key_ref=?", [normalizedVeid, reference]);
        if (newReference && row.kiwivm_api_key_ref && row.kiwivm_api_key_ref !== newReference) await this.secretStore.remove(row.kiwivm_api_key_ref).catch(() => {});
        return info;
      } catch (error) {
        if (newReference) await this.secretStore.remove(newReference).catch(() => {});
        throw error;
      }
    });
  }
  remove(serverId) {
    return this.exclusive(serverId, async () => {
      let reference;
      await transaction(this.pool, async conn => {
        const [[row]] = await conn.execute('SELECT kiwivm_api_key_ref FROM vps_servers WHERE id=? FOR UPDATE', [serverId]);
        if (!row) throw httpError('VPS 不存在', 404);
        reference = row.kiwivm_api_key_ref;
        await conn.execute("UPDATE vps_servers SET bandwidth_provider='manual',kiwivm_veid=NULL,kiwivm_api_key_ref=NULL,provider_sync_status='unconfigured',provider_sync_error=NULL,provider_synced_at=NULL,provider_traffic_reset_at=NULL,provider_traffic_multiplier=NULL WHERE id=?", [serverId]);
      });
      await this.secretStore.remove(reference).catch(() => {});
    });
  }
  async syncAll() {
    const [rows] = await this.pool.query("SELECT id FROM vps_servers WHERE bandwidth_provider='kiwivm' AND enabled=1");
    const results = [];
    for (let offset = 0; offset < rows.length; offset += 3) results.push(...await Promise.allSettled(rows.slice(offset, offset + 3).map(row => this.sync(row.id))));
    return results;
  }
  start() {
    const run = () => { if (!this.stopping) this.syncAll().catch(error => console.error(safeError(error))); };
    const initial = setTimeout(run, 3000);
    this.timers.push(initial, setInterval(run, 15 * 60 * 1000));
  }
  async stop() {
    this.stopping = true;
    this.timers.forEach(clearTimeout);
    await Promise.allSettled([...this.chains.values()]);
  }
}
