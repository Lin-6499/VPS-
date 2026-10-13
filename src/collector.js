import { ManagedSshProvider } from './managed-ssh.js';
import { safeError } from './db.js';

export class Collector {
  constructor(repo, providerFactory = i => new ManagedSshProvider(i)) {
    this.repo = repo; this.pool = repo.pool; this.providerFactory = providerFactory;
    this.inflight = new Map(); this.timers = []; this.stopping = false;
    this.active = 0; this.waiters = [];
  }
  async snapshot(instance, provider) {
    const [run] = await this.pool.execute('INSERT INTO collection_runs(instance_id) VALUES (?)', [instance.id]);
    try {
      const snapshot = await provider.collect();
      await this.repo.saveSnapshot(instance, run.insertId, snapshot);
      return snapshot;
    } catch (error) {
      const message = safeError(error);
      await this.pool.execute("UPDATE collection_runs SET status='failed',finished_at=UTC_TIMESTAMP(3),error_summary=? WHERE id=?", [message,run.insertId]);
      await this.pool.execute("UPDATE xray_instances SET api_state='unknown',last_error=? WHERE id=?", [message,instance.id]);
      throw error;
    }
  }
  run(instance) {
    const key = String(instance.id);
    if (this.inflight.has(key)) return this.inflight.get(key);
    const work = this.withSlot(() => this.runLocked(instance)).finally(() => this.inflight.delete(key));
    this.inflight.set(key,work); return work;
  }
  async withSlot(callback) {
    if (this.active >= 2) await new Promise(resolve => this.waiters.push(resolve));
    else this.active++;
    try { return await callback(); }
    finally { const next=this.waiters.shift(); if(next)next();else this.active--; }
  }
  async runLocked(instance) {
    const conn = await this.pool.getConnection();
    const lockName = `${process.env.DB_NAME}:xray:${instance.id}`;
    let locked = false;
    try {
      const [[r]] = await conn.execute('SELECT GET_LOCK(?,0) acquired', [lockName]);
      locked = Boolean(r.acquired); if (!locked) return { skipped: true };
      await this.pool.execute("UPDATE collection_runs SET status='failed',finished_at=UTC_TIMESTAMP(3),error_summary='上次采集进程中断' WHERE instance_id=? AND status='running'", [instance.id]);
      const provider = this.providerFactory(instance);
      let snapshot = await this.snapshot(instance,provider);
      const [jobs] = await this.pool.execute(`SELECT op.*,cr.uuid,cr.xray_email,cr.flow,cr.level,cr.revision,n.inbound_tag
        FROM management_operations op JOIN device_credentials cr ON cr.id=op.credential_id JOIN nodes n ON n.id=cr.node_id
        WHERE op.instance_id=? AND op.status IN ('pending','running','uncertain') ORDER BY op.id LIMIT 10`, [instance.id]);
      for (const job of jobs) {
        if (!instance.allow_write) { await this.finish(job,'failed','服务为只读'); continue; }
        if (Number(job.target_revision) !== Number(job.revision)) { await this.finish(job,'failed','操作版本已过期'); continue; }
        const matches = data => {
          const node = data.nodes.find(n => n.tag === job.inbound_tag);
          if (!node) return false;
          const client = node.clients.find(c => c.uuid === job.uuid);
          if (!node.runtimeAvailable) return false;
          const live = node.runtimeUsers.find(c => c.uuid === job.uuid || c.email === job.xray_email);
          return Boolean(job.desired_enabled) ? Boolean(client && client.email === job.xray_email && client.flow === job.flow && live && live.uuid === job.uuid && live.email === job.xray_email && live.flow === job.flow && Number(live.level) === Number(job.level)) : !client && !live;
        };
        if (matches(snapshot) && snapshot.serviceState === 'active') { await this.finish(job,'success'); continue; }
        // Retry idempotently against both persisted config and live users after lost SSH replies.
        await this.pool.execute("UPDATE management_operations SET status='running',attempts=attempts+1 WHERE id=?", [job.id]);
        try {
          const result = await provider.mutate({ uuid:job.uuid,email:job.xray_email,flow:job.flow,level:job.level,
            tag:job.inbound_tag,enabled:Boolean(job.desired_enabled),configHash:snapshot.configHash,operationKey:job.idempotency_key });
          await this.pool.execute('UPDATE management_operations SET backup_path=? WHERE id=?', [result.backup || null,job.id]);
          snapshot = await this.snapshot(instance,provider);
          await this.finish(job, matches(snapshot) && snapshot.serviceState === 'active' ? 'success' : 'failed',
            matches(snapshot) && snapshot.serviceState === 'active' ? null : '远端配置或运行状态未达到目标');
        } catch (error) {
          if (/HANDLER_SERVICE_REQUIRED|CONFIG_CONFLICT|INBOUND_NOT_FOUND|EMAIL_CONFLICT|RUNTIME_IDENTITY_CONFLICT|CONFIG_VALIDATION_OR_PERMISSION_FAILED/.test(String(error.stderr || ''))) {
            await this.finish(job,'failed',safeError(error)); continue;
          }
          await this.pool.execute("UPDATE management_operations SET status='uncertain',error_summary=? WHERE id=?", [safeError(error),job.id]);
          await this.pool.execute("UPDATE device_credentials SET sync_status='uncertain' WHERE id=? AND revision=?", [job.credential_id,job.target_revision]);
          // A dropped SSH response does not prove failure. Next collection reconciles before any retry.
          break;
        }
      }
      return { ok: snapshot.apiAvailable };
    } catch (error) {
      if (locked) {
        await this.pool.execute("UPDATE management_operations SET status='uncertain',error_summary=? WHERE instance_id=? AND status IN ('pending','running','uncertain')", [safeError(error),instance.id]);
        await this.pool.execute("UPDATE device_credentials SET sync_status='uncertain' WHERE instance_id=? AND sync_status='pending'", [instance.id]);
      }
      throw error;
    } finally {
      if (locked) await conn.execute('SELECT RELEASE_LOCK(?)', [lockName]);
      conn.release();
    }
  }
  async finish(job,status,error = null) {
    const c = await this.pool.getConnection();
    try {
      await c.beginTransaction();
      await c.execute('UPDATE management_operations SET status=?,error_summary=?,finished_at=UTC_TIMESTAMP(3) WHERE id=?', [status,error,job.id]);
      await c.execute('UPDATE device_credentials SET sync_status=?,applied_enabled=IF(?, ?,applied_enabled) WHERE id=? AND revision=?', [status === 'success' ? 'synced' : 'failed',status==='success',job.desired_enabled,job.credential_id,job.target_revision]);
      await c.commit();
    } catch(e) { await c.rollback(); throw e; } finally { c.release(); }
  }
  async refresh(instanceId) {
    const instances = (await this.repo.instances()).filter(i => !instanceId || String(i.id) === String(instanceId));
    const results = [];
    // Bound SSH concurrency to two services, while each service has its own database lock.
    for (let offset = 0; offset < instances.length; offset += 2) {
      const chunk = await Promise.allSettled(instances.slice(offset,offset+2).map(i => this.run(i)));
      results.push(...chunk.map(r => r.status === 'fulfilled' ? r.value : { ok:false,error:safeError(r.reason) }));
    }
    return results;
  }
  start() {
    const guard = fn => () => { if (!this.stopping) fn().catch(e => console.error(safeError(e))); };
    guard(() => this.repo.cleanup())();
    this.timers.push(setInterval(guard(() => this.refresh()),60000));
    this.timers.push(setInterval(guard(async () => {
      const [pending] = await this.pool.query("SELECT DISTINCT instance_id FROM management_operations WHERE status IN ('pending','running','uncertain')");
      for (const row of pending) await this.refresh(row.instance_id);
    }),5000));
    this.timers.push(setInterval(guard(() => this.repo.cleanup()),86400000));
  }
  async stop() { this.stopping = true; this.timers.forEach(clearInterval); await Promise.allSettled([...this.inflight.values()]); }
}
