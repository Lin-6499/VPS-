import path from 'node:path';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import { root, transaction, httpError } from './db.js';
import { sqlDate, parseDate, dayKey, totals, counterDelta, splitDays } from './traffic.js';
import { snapshotDiagnosis, nodeDiagnosis, nodeAccess, jsonValue } from './node-capabilities.js';

export class Repository {
  constructor(pool) { this.pool = pool; this.metadata = {}; }
  async seed() {
    try { this.metadata = JSON.parse(await readFile(path.join(root, 'data/registry.json'), 'utf8')).devices || {}; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const [[count]] = await this.pool.query('SELECT COUNT(*) n FROM xray_instances');
    if (Number(count.n)) return;
    await transaction(this.pool, async c => {
      const [server] = await c.execute('INSERT INTO vps_servers(name,ssh_host,ssh_port,ssh_user,ssh_key_ref) VALUES (?,?,?,?,?)',
        ['当前 VPS', process.env.XRAY_SSH_HOST || '144.34.147.212', Number(process.env.XRAY_SSH_PORT || 22),
          process.env.XRAY_SSH_USER || 'root', process.env.XRAY_SSH_KEY || path.join(os.homedir(), '.ssh/bandwagon_ed25519')]);
      await c.execute('INSERT INTO xray_instances(server_id,service_name,config_path,binary_path,api_address,allow_write) VALUES (?,?,?,?,?,TRUE)',
        [server.insertId, 'xray-test-device.service', '/usr/local/etc/xray/config-test-device.json', '/usr/local/bin/xray', '127.0.0.1:10086']);
    });
  }
  async instances() {
    const [rows] = await this.pool.query('SELECT i.*,s.ssh_host,s.ssh_port,s.ssh_user,s.ssh_key_ref,s.ssh_host_key,s.enabled server_enabled,s.name server_name FROM xray_instances i JOIN vps_servers s ON s.id=i.server_id WHERE i.enabled=1 AND s.enabled=1');
    return rows;
  }
  async servers() {
    const [rows] = await this.pool.query(`SELECT s.id,s.name,s.ssh_host,s.ssh_port,s.ssh_user,s.ssh_key_ref,s.ssh_key_original_name,s.ssh_key_fingerprint,
      s.memory_gb,s.system_disk_gb,s.traffic_quota_gb,s.provider_traffic_used_gb,s.provider_traffic_recorded_at,s.bandwidth_provider,s.kiwivm_veid,s.kiwivm_api_key_ref,
      s.provider_usage_source,s.provider_sync_status,s.provider_synced_at,s.provider_sync_error,s.provider_traffic_reset_at,s.provider_traffic_multiplier,
      s.official_url,s.expires_on,s.ssh_check_status,s.ssh_checked_at,s.ssh_check_error,s.enabled,s.created_at,s.updated_at,
      COALESCE(monthly.month_traffic_bytes,0) month_traffic_bytes
      FROM vps_servers s LEFT JOIN (
        SELECT i.server_id,SUM(td.uplink_bytes+td.downlink_bytes) month_traffic_bytes
        FROM traffic_daily td JOIN device_credentials dc ON dc.id=td.credential_id JOIN xray_instances i ON i.id=dc.instance_id
        WHERE td.stat_date>=DATE_FORMAT(DATE_ADD(UTC_TIMESTAMP(),INTERVAL 8 HOUR),'%Y-%m-01')
        GROUP BY i.server_id
      ) monthly ON monthly.server_id=s.id ORDER BY s.id`);
    return rows;
  }
  async nodes(filters={}) {
    const params=[],where=[];
    if(filters.serverId){where.push('i.server_id=?');params.push(filters.serverId);}
    if(filters.instanceId){where.push('i.id=?');params.push(filters.instanceId);}
    const [rows] = await this.pool.execute(`SELECT n.*,n.diagnostics node_diagnostics,i.server_id,i.service_name,i.version,i.allow_write,i.service_state,i.api_state,
      i.enabled instance_enabled,i.last_success_at,i.last_error,i.diagnosed_at,i.diagnostics instance_diagnostics,
      s.name server_name,s.enabled server_enabled,COUNT(cr.id) credential_count
      FROM nodes n JOIN xray_instances i ON i.id=n.instance_id JOIN vps_servers s ON s.id=i.server_id
      LEFT JOIN device_credentials cr ON cr.node_id=n.id AND cr.archived_at IS NULL ${where.length?'WHERE '+where.join(' AND '):''}
      GROUP BY n.id ORDER BY s.id,i.id,n.port`,params);
    return rows.map(row=>({...row,id:String(row.id),instance_id:String(row.instance_id),server_id:String(row.server_id),credential_count:Number(row.credential_count),
      diagnostics:jsonValue(row.node_diagnostics),instanceDiagnostics:jsonValue(row.instance_diagnostics),access:nodeAccess(row)}));
  }
  async instanceRows(filters={}) {
    const params=[],where=[];if(filters.serverId){where.push('i.server_id=?');params.push(filters.serverId);}
    const [rows]=await this.pool.execute(`SELECT i.*,s.name server_name,s.ssh_host,s.enabled server_enabled,
      COUNT(DISTINCT n.id) node_count,COUNT(DISTINCT cr.id) credential_count
      FROM xray_instances i JOIN vps_servers s ON s.id=i.server_id LEFT JOIN nodes n ON n.instance_id=i.id
      LEFT JOIN device_credentials cr ON cr.instance_id=i.id AND cr.archived_at IS NULL ${where.length?'WHERE '+where.join(' AND '):''}
      GROUP BY i.id ORDER BY s.id,i.id`,params);
    return rows.map(row=>({...row,id:String(row.id),server_id:String(row.server_id),node_count:Number(row.node_count),credential_count:Number(row.credential_count),diagnostics:jsonValue(row.diagnostics)}));
  }
  async saveSnapshot(instance, runId, snapshot) {
    return transaction(this.pool, async c => {
      const [[run]] = await c.execute('SELECT * FROM collection_runs WHERE id=? FOR UPDATE', [runId]);
      if (!run || run.status !== 'running') return false;
      const at = sqlDate(snapshot.collectedAt);
      const instanceDiagnosis=snapshotDiagnosis(snapshot);
      await c.execute(`UPDATE xray_instances SET version=?,service_state=?,api_state=?,epoch_id=?,service_started_at=?,config_hash=?,diagnostics=?,diagnosed_at=?,
        last_success_at=IF(?, ?,last_success_at),last_error=? WHERE id=?`,
      [snapshot.version, snapshot.serviceState, snapshot.apiAvailable ? 'available' : 'unavailable', snapshot.epoch,
        snapshot.serviceStartedAt, snapshot.configHash,JSON.stringify(instanceDiagnosis),at, snapshot.apiAvailable, at, snapshot.apiAvailable ? null : 'Stats API 不可用，保留上次成功计数', instance.id]);
      await c.execute("UPDATE nodes SET observed_state='missing' WHERE instance_id=?",[instance.id]);
      const seen = new Set();
      for (const node of snapshot.nodes) {
        const diagnosis=nodeDiagnosis(node,snapshot);
        await c.execute(`INSERT INTO nodes(instance_id,name,inbound_tag,public_host,port,protocol,transport,security,sni,public_key,short_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE port=VALUES(port),protocol=VALUES(protocol),transport=VALUES(transport),
          security=VALUES(security),sni=VALUES(sni),public_key=VALUES(public_key),short_id=VALUES(short_id),observed_state='present'`,
        [instance.id, `${instance.server_name} · ${node.port}`, node.tag, instance.ssh_host, node.port, node.protocol, node.network, node.security, node.sni, node.publicKey, node.shortId]);
        const [[storedNode]] = await c.execute('SELECT id FROM nodes WHERE instance_id=? AND inbound_tag=?', [instance.id, node.tag]);
        await c.execute("UPDATE nodes SET observed_state='present',last_seen_at=?,diagnostics=? WHERE id=?",[at,JSON.stringify(diagnosis),storedNode.id]);
        for (const client of node.clients) {
          let [[credential]] = await c.execute('SELECT * FROM device_credentials WHERE uuid=?', [client.uuid]);
          if (credential && (String(credential.node_id) !== String(storedNode.id))) throw httpError('检测到跨节点重复 UUID，需先为节点分配独立凭证', 409);
          if (!credential) {
            const meta = this.metadata[client.uuid] || {};
            const [d] = await c.execute('INSERT INTO devices(name,note,kind,created_at) VALUES (?,?,?,?)',
              [(meta.name || client.email || '导入设备').slice(0, 30), (meta.note || '来自 Xray 配置').slice(0, 60), meta.kind || 'desktop', meta.createdAt ? sqlDate(meta.createdAt) : at]);
            const [cr] = await c.execute(`INSERT INTO device_credentials(device_id,node_id,instance_id,uuid,xray_email,flow,level,applied_enabled) VALUES (?,?,?,?,?,?,?,TRUE)`,
              [d.insertId, storedNode.id, instance.id, client.uuid, client.email, client.flow, client.level]);
            [[credential]] = await c.execute('SELECT * FROM device_credentials WHERE id=?', [cr.insertId]);
          }
          seen.add(String(credential.id));
          const sameIdentity = credential.xray_email === client.email && credential.flow === client.flow && Number(credential.level) === Number(client.level);
          const live = node.runtimeUsers?.find(u => u.uuid === client.uuid && u.email === client.email && u.flow === client.flow && Number(u.level) === Number(client.level));
          const verified = node.runtimeAvailable === true && Boolean(live);
          await c.execute(`UPDATE device_credentials SET applied_enabled=IF(sync_status IN ('pending','uncertain') OR NOT ?,applied_enabled,TRUE),sync_status=IF(sync_status IN ('pending','uncertain','failed'),sync_status,IF(desired_enabled=TRUE AND ? AND ?,'synced','drift')) WHERE id=?`, [verified, sameIdentity, verified, credential.id]);
          await c.execute('INSERT IGNORE INTO credential_runtime(credential_id) VALUES (?)', [credential.id]);
          const [[prev]] = await c.execute('SELECT * FROM credential_runtime WHERE credential_id=? FOR UPDATE', [credential.id]);
          if (prev.last_run_id && BigInt(prev.last_run_id) >= BigInt(runId)) continue;
          const onlineValid = client.onlineAvailable && sameIdentity;
          const trafficValid = client.trafficAvailable && sameIdentity;
          await c.execute(`UPDATE credential_runtime SET traffic_available=?,online_available=?,online_state=?,online_ip_count=?,last_seen_at=IF(?, ?,last_seen_at),
            last_success_at=IF(?, ?,last_success_at),last_run_id=? WHERE credential_id=?`,
          [trafficValid,onlineValid,onlineValid ? (client.sourceIps.length ? 'online' : 'offline') : 'unknown', onlineValid ? client.sourceIps.length : null,
            onlineValid && client.sourceIps.length > 0, at, onlineValid, at, runId, credential.id]);
          if (onlineValid) {
            await c.execute('UPDATE credential_ips SET present_in_last_sample=FALSE WHERE credential_id=?', [credential.id]);
            for (const ip of client.sourceIps.filter(ip => isIP(ip))) {
              await c.execute(`INSERT INTO credential_ips(credential_id,ip,first_seen_at,last_seen_at,last_observed_run_id) VALUES (?,INET6_ATON(?),?,?,?)
                ON DUPLICATE KEY UPDATE last_seen_at=VALUES(last_seen_at),last_observed_run_id=VALUES(last_observed_run_id),present_in_last_sample=TRUE`, [credential.id, ip, at, at, runId]);
            }
          }
          if (!trafficValid) continue;
          const delta = counterDelta(prev, client, snapshot.epoch);
          const start = prev.counter_sampled_at ? parseDate(prev.counter_sampled_at) : new Date(snapshot.collectedAt);
          if (start.getTime() > snapshot.collectedAt) throw httpError('采样时间早于统计基线，已拒绝写入', 409);
          if (delta.quality === 'normal' && snapshot.collectedAt - start.getTime() > 180000) delta.quality = 'gap';
          await c.execute(`INSERT INTO traffic_samples(run_id,credential_id,sampled_at,interval_start_at,raw_uplink_bytes,raw_downlink_bytes,delta_uplink_bytes,delta_downlink_bytes,quality) VALUES (?,?,?,?,?,?,?,?,?)`,
            [runId, credential.id, at, sqlDate(start), client.uplinkBytes, client.downlinkBytes, String(delta.up), String(delta.down), delta.quality]);
          await c.execute(`UPDATE credential_runtime SET epoch_id=?,last_uplink_bytes=?,last_downlink_bytes=?,counter_sampled_at=?,
            tracking_started_at=COALESCE(tracking_started_at,?),total_uplink_bytes=total_uplink_bytes+?,total_downlink_bytes=total_downlink_bytes+? WHERE credential_id=?`,
          [snapshot.epoch, client.uplinkBytes, client.downlinkBytes, at, at, String(delta.up), String(delta.down), credential.id]);
          const parts = splitDays(start, snapshot.collectedAt, delta.up, delta.down);
          for (const part of parts) {
            const gap = ['gap', 'reset'].includes(delta.quality);
            await c.execute(`INSERT INTO traffic_daily(credential_id,stat_date,uplink_bytes,downlink_bytes,sample_count,estimated_bytes,has_gap) VALUES (?,?,?,?,1,?,?)
              ON DUPLICATE KEY UPDATE uplink_bytes=uplink_bytes+VALUES(uplink_bytes),downlink_bytes=downlink_bytes+VALUES(downlink_bytes),
              sample_count=sample_count+1,estimated_bytes=estimated_bytes+VALUES(estimated_bytes),has_gap=has_gap OR VALUES(has_gap)`,
            [credential.id, part.date, String(part.up), String(part.down), String(parts.length > 1 || gap ? part.up + part.down : 0n), gap]);
          }
        }
      }
      const [all] = await c.execute('SELECT cr.id,cr.uuid,cr.xray_email,n.inbound_tag FROM device_credentials cr JOIN nodes n ON n.id=cr.node_id WHERE cr.instance_id=?', [instance.id]);
      for (const cr of all.filter(v => !seen.has(String(v.id)))) {
        const node = snapshot.nodes.find(n => n.tag === cr.inbound_tag);
        const verified = node?.runtimeAvailable === true && !node.runtimeUsers.some(u => u.uuid === cr.uuid || u.email === cr.xray_email);
        await c.execute("UPDATE device_credentials SET applied_enabled=IF(sync_status IN ('pending','uncertain') OR NOT ?,applied_enabled,FALSE),sync_status=IF(sync_status IN ('pending','uncertain','failed'),sync_status,IF(desired_enabled=FALSE AND ?,'synced','drift')) WHERE id=?", [verified,verified,cr.id]);
        await c.execute("UPDATE credential_runtime SET online_state='unknown',online_ip_count=NULL WHERE credential_id=?", [cr.id]);
      }
      await c.execute('UPDATE collection_runs SET status=?,finished_at=?,epoch_id=? WHERE id=?', [snapshot.apiAvailable ? 'success' : 'partial', at, snapshot.epoch, runId]);
      return true;
    });
  }
  async credentials(filters = {}) {
    const params = [];
    const where = ['d.archived_at IS NULL', 'cr.archived_at IS NULL'];
    for (const [key, column] of Object.entries({ serverId: 'i.server_id', nodeId: 'n.id', deviceId: 'd.id', credentialId: 'cr.id', uuid: 'cr.uuid' })) {
      if (filters[key]) { where.push(`${column}=?`); params.push(filters[key]); }
    }
    const [rows] = await this.pool.execute(`SELECT cr.*,d.name,d.note,d.kind,d.created_at device_created_at,n.name node_name,n.public_host,n.port,n.protocol,
      n.transport,n.security,n.sni,n.public_key,n.short_id,n.fingerprint,n.observed_state,n.diagnostics node_diagnostics,s.enabled server_enabled,
      i.server_id,i.service_state,i.api_state,i.last_error,i.service_started_at,i.diagnosed_at,i.allow_write,i.enabled instance_enabled,
      r.online_state,r.online_ip_count,r.last_seen_at,r.last_success_at,r.counter_sampled_at,r.tracking_started_at,r.traffic_available,r.online_available,
      COALESCE(r.total_uplink_bytes,0) total_up,COALESCE(r.total_downlink_bytes,0) total_down,
      COALESCE(td.uplink_bytes,0) today_up,COALESCE(td.downlink_bytes,0) today_down
      FROM device_credentials cr JOIN devices d ON d.id=cr.device_id JOIN nodes n ON n.id=cr.node_id
      JOIN xray_instances i ON i.id=cr.instance_id JOIN vps_servers s ON s.id=i.server_id LEFT JOIN credential_runtime r ON r.credential_id=cr.id
      LEFT JOIN traffic_daily td ON td.credential_id=cr.id AND td.stat_date=? WHERE ${where.join(' AND ')} ORDER BY d.id,cr.id`, [dayKey(Date.now()), ...params]);
    if (!rows.length) return [];
    const [ips] = await this.pool.query('SELECT credential_id,INET6_NTOA(ip) ip FROM credential_ips WHERE present_in_last_sample=TRUE');
    return rows.map(row => {
      const fresh = row.last_success_at && Date.now() - parseDate(row.last_success_at).getTime() < 180000;
      const status = row.applied_enabled === 0 ? 'disabled' : (!fresh || row.last_error ? 'unknown' : row.online_state || 'unknown');
      const traffic = totals(row.total_up, row.total_down);
      return { ...row, id: String(row.id), deviceId: String(row.device_id), credentialId: String(row.id), nodeId: String(row.node_id), serverId: String(row.server_id),
        email: row.xray_email, enabled: row.applied_enabled === 1, desiredEnabled: Boolean(row.desired_enabled), syncStatus: row.sync_status, status,
        sourceIps: fresh && status !== 'unknown' && status !== 'disabled' ? ips.filter(ip => String(ip.credential_id) === String(row.id)).map(ip => ip.ip) : [],
        onlineIpCount: fresh && status !== 'unknown' ? row.online_ip_count : null, sessions: fresh ? row.online_ip_count : null,
        lastActive: parseDate(row.last_seen_at)?.toISOString() || null, createdAt: parseDate(row.device_created_at)?.toISOString(),
        traffic, todayTraffic: totals(row.today_up, row.today_down), stale: !fresh,trafficAvailable:row.traffic_available===1,onlineAvailable:row.online_available===1,
        collectedAt: parseDate(row.counter_sampled_at)?.getTime() / 1000 || null };
    });
  }
  async traffic(filters, from, to, groupBy = 'day') {
    if (!['day','month'].includes(groupBy)) throw httpError('groupBy 仅支持 day 或 month');
    const validDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0,10) === s;
    if (!validDate(from) || !validDate(to) || from > to) throw httpError('日期范围无效');
    const devices = await this.credentials(filters);
    if (!devices.length) throw httpError('设备或凭证不存在', 404);
    const ids = devices.map(d => d.id), placeholders = ids.map(() => '?').join(',');
    const dateExpr = groupBy === 'day' ? 'stat_date' : "DATE_FORMAT(stat_date,'%Y-%m')";
    const [rows] = await this.pool.execute(`SELECT ${dateExpr} period,SUM(uplink_bytes) up,SUM(downlink_bytes) down,
      SUM(estimated_bytes) estimated,MAX(has_gap) has_gap FROM traffic_daily WHERE credential_id IN (${placeholders}) AND stat_date BETWEEN ? AND ? GROUP BY period ORDER BY period`, [...ids, from, to]);
    const series = rows.map(r => ({ date: r.period, ...totals(r.up, r.down), estimatedBytes: String(r.estimated), hasGap: Boolean(r.has_gap) }));
    return { scope: 'tracked-lifetime', scopeLabel: '接入数据库后的累计流量', unit: 'GiB', timezone: 'Asia/Shanghai', from, to, groupBy,
      totals: totals(devices.reduce((s,d) => s + BigInt(d.traffic.uplinkBytes),0n), devices.reduce((s,d) => s + BigInt(d.traffic.downlinkBytes),0n)),
      rangeTotals: totals(series.reduce((s,d) => s + BigInt(d.uplinkBytes),0n),series.reduce((s,d) => s + BigInt(d.downlinkBytes),0n)),
      trackingStartedAt: devices.map(d => d.tracking_started_at).filter(Boolean).sort()[0] || null, series,
      collectedAt: Math.max(...devices.map(d => d.collectedAt || 0)), serviceStartedAt: devices[0].service_started_at,
      hasGap: series.some(d => d.hasGap) };
  }
  async queueCreate(body, key) {
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 30) throw httpError('设备名称必填且最多30字');
    if (body.note != null && (typeof body.note !== 'string' || body.note.length > 60)) throw httpError('备注最多60字');
    return transaction(this.pool, async c => {
      const [[existing]] = await c.execute('SELECT id FROM management_operations WHERE idempotency_key=?', [key]);
      if (existing) return existing.id;
      const [[node]] = await c.execute(`SELECT n.*,n.diagnostics node_diagnostics,i.allow_write,i.service_state,i.last_error,i.diagnosed_at,
        i.enabled instance_enabled,s.enabled server_enabled FROM nodes n JOIN xray_instances i ON i.id=n.instance_id JOIN vps_servers s ON s.id=i.server_id WHERE n.id=?`, [body.nodeId]);
      if (!node) throw httpError('节点不存在',404);
      const access=nodeAccess(node);if(!access.canManage)throw httpError(access.reason||'该节点当前不能管理设备',409);
      let deviceId = body.deviceId;
      if (deviceId) {
        const [[device]] = await c.execute('SELECT id FROM devices WHERE id=? AND archived_at IS NULL', [deviceId]);
        if (!device) throw httpError('设备不存在', 404);
      } else {
        const [d] = await c.execute('INSERT INTO devices(name,note,kind) VALUES (?,?,?)', [body.name.trim(),body.note?.trim() || '', 'desktop']); deviceId = d.insertId;
      }
      const uuid = randomUUID(), email = `device-${uuid}`;
      const [cr] = await c.execute(`INSERT INTO device_credentials(device_id,node_id,instance_id,uuid,xray_email,flow,applied_enabled,sync_status,revision)
        VALUES (?,?,?,?,?,?,NULL,'pending',1)`, [deviceId,node.id,node.instance_id,uuid,email,node.security === 'reality' ? 'xtls-rprx-vision' : '']);
      const [operation] = await c.execute(`INSERT INTO management_operations(idempotency_key,instance_id,credential_id,action,target_revision,desired_enabled)
        VALUES (?,?,?,'create',1,TRUE)`, [key,node.instance_id,cr.insertId]);
      return operation.insertId;
    });
  }
  async queueEnabled(id, enabled, key) {
    if (typeof enabled !== 'boolean') throw httpError('enabled 必须为布尔值');
    return transaction(this.pool, async c => {
      const [[existing]] = await c.execute('SELECT id FROM management_operations WHERE idempotency_key=?', [key]);
      if (existing) return existing.id;
      const [[cr]] = await c.execute(`SELECT cr.*,n.observed_state,n.diagnostics node_diagnostics,i.allow_write,i.service_state,i.last_error,i.diagnosed_at,
        i.enabled instance_enabled,s.enabled server_enabled FROM device_credentials cr JOIN nodes n ON n.id=cr.node_id
        JOIN xray_instances i ON i.id=cr.instance_id JOIN vps_servers s ON s.id=i.server_id WHERE cr.id=? FOR UPDATE`, [id]);
      if (!cr) throw httpError('凭证不存在',404);
      const access=nodeAccess(cr);if(!access.canManage)throw httpError(access.reason||'该节点当前不能管理设备',409);
      if (['pending','uncertain'].includes(cr.sync_status)) throw httpError('已有操作正在执行或核实',409);
      const revision = Number(cr.revision) + 1;
      await c.execute("UPDATE device_credentials SET desired_enabled=?,sync_status='pending',revision=? WHERE id=?", [enabled,revision,id]);
      const [operation] = await c.execute(`INSERT INTO management_operations(idempotency_key,instance_id,credential_id,action,target_revision,desired_enabled)
        VALUES (?,?,?,'set_enabled',?,?)`, [key,cr.instance_id,id,revision,enabled]);
      return operation.insertId;
    });
  }
  async operation(id) {
    const [[r]] = await this.pool.execute('SELECT id,credential_id,action,status,attempts,backup_path,error_summary,created_at,finished_at FROM management_operations WHERE id=?',[id]);
    if (!r) throw httpError('操作不存在',404); return r;
  }
  async cleanup() {
    // Parent runs are removed only after their samples; metadata and totals are retained.
    await this.pool.query('DELETE FROM traffic_samples WHERE sampled_at < UTC_TIMESTAMP() - INTERVAL 30 DAY');
    await this.pool.query('DELETE FROM collection_runs WHERE started_at < UTC_TIMESTAMP() - INTERVAL 30 DAY AND id NOT IN (SELECT run_id FROM traffic_samples)');
    await this.pool.query('DELETE FROM credential_ips WHERE last_seen_at < UTC_TIMESTAMP() - INTERVAL 30 DAY');
    await this.pool.query("DELETE FROM management_operations WHERE status='success' AND finished_at < UTC_TIMESTAMP() - INTERVAL 180 DAY");
  }
}
