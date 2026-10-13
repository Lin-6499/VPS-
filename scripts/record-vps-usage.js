import { isIP } from 'node:net';
import { createPool, migrate, transaction, safeError, httpError } from '../src/db.js';

// Store a provider snapshot separately; never modify per-device Xray counters.
const [host, usedGb] = process.argv.slice(2);
if (isIP(host || '') !== 4 || !/^\d{1,12}(?:\.\d{1,2})?$/.test(usedGb || '')) {
  console.error('用法：node scripts/record-vps-usage.js <VPS IPv4> <服务商已用 GB，最多两位小数>');
  process.exitCode = 1;
} else {
  const pool = createPool();
  try {
    await migrate(pool);
    const result = await transaction(pool, async conn => {
      const [rows] = await conn.execute('SELECT id,name,ssh_host,traffic_quota_gb,provider_traffic_used_gb FROM vps_servers WHERE ssh_host=? FOR UPDATE', [host]);
      if (rows.length !== 1) throw httpError('IPv4 必须唯一匹配一台 VPS，未修改数据');
      const row = rows[0];
      await conn.execute('UPDATE vps_servers SET provider_traffic_used_gb=?,provider_traffic_recorded_at=UTC_TIMESTAMP(3) WHERE id=?', [usedGb, row.id]);
      return { id: String(row.id), name: row.name, ipv4: row.ssh_host, quotaGb: row.traffic_quota_gb, previousUsedGb: row.provider_traffic_used_gb, usedGb };
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(safeError(error));
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
