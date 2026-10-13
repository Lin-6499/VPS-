import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env'), quiet: true });

export function createPool() {
  if (!process.env.DB_NAME || !process.env.DB_USER) throw new Error('请在项目 .env 配置 DB_NAME、DB_USER 和连接密码');
  const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    timezone: 'Z', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true,
    connectionLimit: 8, multipleStatements: false, charset: 'utf8mb4'
  });
  // mysql2 timezone controls JS conversion, not server-side CURRENT_TIMESTAMP defaults.
  pool.on('connection', connection => { connection.query("SET time_zone = '+00:00'"); });
  return pool;
}

export async function migrate(pool) {
  const conn = await pool.getConnection();
  try {
    const [[lock]] = await conn.query("SELECT GET_LOCK(CONCAT(DATABASE(),':migration'),10) acquired");
    if (!lock.acquired) throw new Error('数据库迁移被其他进程占用');
    const sql = await readFile(path.join(root, 'sql', '001_initial.sql'), 'utf8');
    for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) await conn.query(statement);
    // MySQL DDL commits implicitly. Check each additive column under the migration
    // lock so both repeated runs and interrupted partial upgrades are safe.
    for (const migration of ['002_vps_resources.sql', '003_vps_management.sql', '004_vps_provider_usage.sql', '005_kiwivm_bandwidth.sql', '006_node_management.sql']) {
      const additions = await readFile(path.join(root, 'sql', migration), 'utf8');
      for (const statement of additions.split(';').map(s => s.trim()).filter(Boolean)) {
        const match = /^ALTER TABLE (\w+) ADD COLUMN (\w+)\b/i.exec(statement);
        if (!match) throw new Error(`Unsupported additive column migration in ${migration}`);
        const [[existing]] = await conn.execute('SELECT COUNT(*) n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?', [match[1],match[2]]);
        if (Number(existing.n) === 0) await conn.query(statement);
      }
    }
    const authMigration = await readFile(path.join(root, 'sql', '007_auth.sql'), 'utf8');
    for (const statement of authMigration.split(';').map(s => s.trim()).filter(Boolean)) await conn.query(statement);
    const [[legacyMemory]] = await conn.query("SELECT COUNT(*) n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='vps_servers' AND COLUMN_NAME='memory_mib'");
    if (Number(legacyMemory.n)) {
      // Convert MiB to decimal GB once; keep NULL and pre-existing GB values.
      // A conflicting partial/manual migration must not silently discard data.
      const [[conflict]] = await conn.query('SELECT COUNT(*) n FROM vps_servers WHERE memory_mib IS NOT NULL AND memory_gb IS NOT NULL AND memory_gb <> ROUND(memory_mib * 0.001048576, 2)');
      if (Number(conflict.n)) throw new Error('Conflicting memory_mib and memory_gb values; legacy column retained');
      await conn.query('UPDATE vps_servers SET memory_gb=ROUND(memory_mib * 0.001048576, 2),updated_at=updated_at WHERE memory_gb IS NULL AND memory_mib IS NOT NULL');
      await conn.query('ALTER TABLE vps_servers DROP COLUMN memory_mib');
    }
  } finally {
    await conn.query("SELECT RELEASE_LOCK(CONCAT(DATABASE(),':migration'))");
    conn.release();
  }
}

export async function transaction(pool, callback) {
  const conn = await pool.getConnection();
  try { await conn.beginTransaction(); const result = await callback(conn); await conn.commit(); return result; }
  catch (e) { await conn.rollback(); throw e; }
  finally { conn.release(); }
}

export function safeError(error) {
  // Never return execFile.message (it contains the full SSH command and mutation payload).
  if (error.publicMessage) return error.publicMessage;
  if (String(error.stderr || '').includes('CONFIG_CONFLICT')) return '远端配置已改变，请刷新后重试';
  if (String(error.stderr || '').includes('HANDLER_SERVICE_REQUIRED')) return '请先启用 HandlerService，当前操作未修改远端配置';
  if (String(error.stderr || '').includes('HANDLER_API_UNAVAILABLE')) return '动态管理 API 暂不可达，正在核实';
  if (String(error.stderr || '').includes('RUNTIME_CONFIRMATION_PENDING')) return '配置已保存，正在核实运行时状态';
  if (String(error.stderr || '').includes('permission denied')) return '远端权限校验失败';
  return error.code ? `操作失败 (${String(error.code).slice(0, 80)})` : 'SSH 或数据库操作失败，请检查服务连接';
}
export function httpError(message, status = 400) { return Object.assign(new Error(message), { publicMessage: message, status }); }
