import { randomBytes, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { isIP } from 'node:net';
import { httpError } from './db.js';

const scrypt = promisify(scryptCallback);
const COOKIE_NAME = 'raygate_session';
const SHORT_SESSION_MS = 12 * 60 * 60 * 1000;
const REMEMBER_SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const FAILURE_LIMIT = 5;
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

const sha256 = value => createHash('sha256').update(value).digest();
const base64url = value => value.toString('base64url');

export function normalizeUsername(value) {
  const username = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,64}$/.test(username)) throw httpError('用户名格式无效');
  return username;
}

export function validatePassword(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128) throw httpError('密码长度必须为 12–128 个字符');
  return value;
}

export async function hashPassword(password) {
  validatePassword(password);
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64, SCRYPT_OPTIONS);
  return `scrypt$${SCRYPT_OPTIONS.N}$${SCRYPT_OPTIONS.r}$${SCRYPT_OPTIONS.p}$${base64url(salt)}$${base64url(derived)}`;
}

export async function verifyPassword(password, encoded) {
  try {
    const [algorithm,n,r,p,salt,expected] = String(encoded).split('$');
    if (algorithm !== 'scrypt' || !n || !r || !p || !salt || !expected) return false;
    const expectedBytes = Buffer.from(expected, 'base64url');
    const actual = await scrypt(String(password), Buffer.from(salt, 'base64url'), expectedBytes.length, { N:Number(n), r:Number(r), p:Number(p), maxmem:64*1024*1024 });
    return actual.length === expectedBytes.length && timingSafeEqual(actual, expectedBytes);
  } catch { return false; }
}

async function consumePasswordWork(password) {
  await scrypt(String(password),Buffer.alloc(16),64,SCRYPT_OPTIONS);
  return false;
}

function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(item=>item.trim()).filter(Boolean).map(item=>{
    const index=item.indexOf('=');return index<0?[item,'']:[item.slice(0,index),decodeURIComponent(item.slice(index+1))];
  }));
}

function isLoopback(value) {
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

export class AuthService {
  constructor(pool, { publicOrigin, trustProxy = false, now = () => Date.now() } = {}) {
    this.pool = pool;
    this.publicOrigin = publicOrigin || null;
    this.trustProxy = trustProxy;
    this.now = now;
    this.failures = new Map();
    this.setupToken = base64url(randomBytes(32));
  }

  async isConfigured() {
    const [[row]] = await this.pool.query('SELECT COUNT(*) count FROM admin_users');
    return Number(row.count) > 0;
  }

  async requireConfigured() {
    const [[row]] = await this.pool.query('SELECT COUNT(*) count FROM admin_users WHERE enabled=TRUE');
    if (Number(row.count) !== 1) throw new Error('RayGate 尚未创建管理员，请先执行 npm run admin:create');
  }

  async initializeAdmin(req, { token, username: rawUsername, password, confirmPassword }) {
    if (!isLoopback(req.socket.remoteAddress || '')) throw httpError('初始化只允许从服务器本机访问',403);
    const actual=Buffer.from(String(token||'')),expected=Buffer.from(String(this.setupToken||''));
    if(!this.setupToken||actual.length!==expected.length||!timingSafeEqual(actual,expected))throw httpError('初始化链接无效或已失效',403);
    const username=normalizeUsername(rawUsername),validated=validatePassword(password);
    if(validated!==confirmPassword)throw httpError('两次输入的密码不一致');
    const connection=await this.pool.getConnection();
    try {
      const [[lock]]=await connection.query("SELECT GET_LOCK(CONCAT(DATABASE(),':initial-admin'),5) acquired");
      if(!Number(lock.acquired))throw httpError('初始化正在处理中，请稍后重试',409);
      const [[row]]=await connection.query('SELECT COUNT(*) count FROM admin_users');
      if(Number(row.count)>0)throw httpError('管理员已经创建，请直接登录',409);
      const encoded=await hashPassword(validated);
      const [result]=await connection.execute('INSERT INTO admin_users(username,password_hash) VALUES (?,?)',[username,encoded]);
      this.setupToken=null;
      const user={id:result.insertId,username};
      const session=await this.issueSession(req,user,false);
      await this.audit(req,'initial_setup',true,{userId:user.id,username});
      return {user:{id:String(user.id),username},...session};
    } finally {
      await connection.query("SELECT RELEASE_LOCK(CONCAT(DATABASE(),':initial-admin'))").catch(()=>{});
      connection.release();
    }
  }

  requestIp(req) {
    const remote = req.socket.remoteAddress || '';
    if (this.trustProxy && isLoopback(remote)) {
      const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (isIP(forwarded)) return forwarded;
    }
    return remote.replace(/^::ffff:/, '').slice(0,45);
  }

  async audit(req, eventType, success, { userId = null, username = null, details = null } = {}) {
    await this.pool.execute(`INSERT INTO auth_audit_logs(user_id,username_attempt,event_type,success,ip_address,user_agent,details)
      VALUES (?,?,?,?,?,?,?)`,[userId,username,eventType,success,this.requestIp(req),String(req.headers['user-agent']||'').slice(0,512),details?JSON.stringify(details):null]);
  }

  failureKey(req, username) { return `${this.requestIp(req)}|${username}`; }
  failureState(key) {
    const cutoff=this.now()-FAILURE_WINDOW_MS;
    const values=(this.failures.get(key)||[]).filter(value=>value>cutoff);
    if(values.length)this.failures.set(key,values);else this.failures.delete(key);
    return values;
  }

  cookie(value, { remember = false, clear = false } = {}) {
    const secure = this.publicOrigin?.startsWith('https://');
    const parts=[`${COOKIE_NAME}=${clear?'':encodeURIComponent(value)}`,'Path=/','HttpOnly','SameSite=Lax'];
    if(secure)parts.push('Secure');
    if(clear)parts.push('Max-Age=0');else if(remember)parts.push(`Max-Age=${Math.floor(REMEMBER_SESSION_MS/1000)}`);
    return parts.join('; ');
  }

  async issueSession(req, user, remember = false) {
    const token=base64url(randomBytes(32)),csrf=base64url(randomBytes(32));
    const expiresAt=new Date(this.now()+(remember?REMEMBER_SESSION_MS:SHORT_SESSION_MS));
    await this.pool.execute(`INSERT INTO auth_sessions(token_hash,user_id,csrf_token,remember,ip_address,user_agent,expires_at)
      VALUES (?,?,?,?,?,?,?)`,[sha256(token),user.id,csrf,remember,this.requestIp(req),String(req.headers['user-agent']||'').slice(0,512),expiresAt]);
    return {token,csrf,expiresAt:expiresAt.toISOString(),cookie:this.cookie(token,{remember})};
  }

  async login(req, { username: rawUsername, password, remember = false }) {
    let username='';
    try { username=normalizeUsername(rawUsername); } catch { username=String(rawUsername||'').slice(0,64).toLowerCase(); }
    const key=this.failureKey(req,username),failures=this.failureState(key);
    if(failures.length>=FAILURE_LIMIT){await this.audit(req,'login',false,{username,details:{reason:'rate_limited'}});throw Object.assign(httpError('登录尝试过多，请 15 分钟后重试',429),{retryAfter:900});}
    const [[user]]=await this.pool.execute('SELECT * FROM admin_users WHERE username=? AND enabled=TRUE',[username]);
    const passwordValid=user?await verifyPassword(password,user.password_hash):await consumePasswordWork(password);
    const valid=Boolean(user)&&passwordValid;
    if(!valid){failures.push(this.now());this.failures.set(key,failures);await this.audit(req,'login',false,{username,details:{reason:'invalid_credentials'}});throw httpError('用户名或密码错误',401);}
    this.failures.delete(key);
    const session=await this.issueSession(req,user,Boolean(remember));
    await this.audit(req,'login',true,{userId:user.id,username:user.username});
    return {user:{id:String(user.id),username:user.username},...session};
  }

  async authenticate(req) {
    const token=cookies(req)[COOKIE_NAME];if(!token)return null;
    const [[row]]=await this.pool.execute(`SELECT s.*,u.username,u.enabled FROM auth_sessions s JOIN admin_users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>UTC_TIMESTAMP(3)`,[sha256(token)]);
    if(!row||!row.enabled)return null;
    if(this.now()-new Date(`${row.last_seen_at}Z`).getTime()>5*60*1000)await this.pool.execute('UPDATE auth_sessions SET last_seen_at=UTC_TIMESTAMP(3) WHERE token_hash=?',[sha256(token)]);
    return {user:{id:String(row.user_id),username:row.username},tokenHash:sha256(token),csrfToken:row.csrf_token,expiresAt:new Date(`${row.expires_at}Z`).toISOString(),remember:Boolean(row.remember)};
  }

  verifyCsrf(req, session) {
    const value=String(req.headers['x-csrf-token']||'');
    const actual=Buffer.from(value),expected=Buffer.from(session.csrfToken||'');
    if(!value||actual.length!==expected.length||!timingSafeEqual(actual,expected))throw httpError('页面验证已失效，请刷新后重试',403);
  }

  async revokeCurrent(req, session) {
    await this.pool.execute('UPDATE auth_sessions SET revoked_at=UTC_TIMESTAMP(3) WHERE token_hash=?',[session.tokenHash]);
    await this.audit(req,'logout',true,{userId:session.user.id,username:session.user.username});
  }

  async revokeOthers(req, session) {
    const [result]=await this.pool.execute('UPDATE auth_sessions SET revoked_at=UTC_TIMESTAMP(3) WHERE user_id=? AND token_hash<>? AND revoked_at IS NULL',[session.user.id,session.tokenHash]);
    await this.audit(req,'session_revoke',true,{userId:session.user.id,username:session.user.username,details:{count:result.affectedRows}});
    return result.affectedRows;
  }

  async changePassword(req, session, currentPassword, newPassword) {
    validatePassword(newPassword);
    const [[user]]=await this.pool.execute('SELECT * FROM admin_users WHERE id=? AND enabled=TRUE',[session.user.id]);
    if(!user||!await verifyPassword(currentPassword,user.password_hash)){await this.audit(req,'password_change',false,{userId:user?.id||null,username:session.user.username});throw httpError('当前密码不正确',401);}
    const encoded=await hashPassword(newPassword);
    await this.pool.execute('UPDATE admin_users SET password_hash=?,password_changed_at=UTC_TIMESTAMP(3) WHERE id=?',[encoded,user.id]);
    await this.pool.execute('UPDATE auth_sessions SET revoked_at=UTC_TIMESTAMP(3) WHERE user_id=? AND token_hash<>? AND revoked_at IS NULL',[user.id,session.tokenHash]);
    await this.audit(req,'password_change',true,{userId:user.id,username:user.username});
  }

  async auditRows(userId, limit = 50) {
    const safeLimit=Math.min(100,Math.max(1,Number(limit)||50));
    const [rows]=await this.pool.query(`SELECT event_type,success,ip_address,user_agent,details,created_at FROM auth_audit_logs
      WHERE user_id=? OR user_id IS NULL ORDER BY id DESC LIMIT ${safeLimit}`,[userId]);
    return rows.map(row=>({eventType:row.event_type,success:Boolean(row.success),ipAddress:row.ip_address,userAgent:row.user_agent,details:typeof row.details==='string'?JSON.parse(row.details):row.details,createdAt:row.created_at}));
  }

  async cleanup() {
    await this.pool.query('DELETE FROM auth_sessions WHERE expires_at<UTC_TIMESTAMP(3) OR revoked_at<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 7 DAY)');
    await this.pool.query('DELETE FROM auth_audit_logs WHERE created_at<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 90 DAY)');
  }
}

export const authConstants = { COOKIE_NAME, SHORT_SESSION_MS, REMEMBER_SESSION_MS };
