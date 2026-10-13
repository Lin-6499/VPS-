import http from 'node:http';
import { readFile,rm,stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import Busboy from 'busboy';
import QRCode from 'qrcode';
import { root,createPool,migrate,httpError,safeError,transaction } from './db.js';
import { Repository } from './repository.js';
import { Collector } from './collector.js';
import { createVlessUri } from './ssh-provider.js';
import { dayKey,totals,parseDate } from './traffic.js';
import { SshKeyStore, MAX_KEY_BYTES } from './ssh-key-store.js';
import { scanHostKey, verifySsh } from './ssh-check.js';
import { normalizeUsedGb } from './provider-usage.js';
import { ProviderSecretStore } from './provider-secret-store.js';
import { BandwidthSync } from './bandwidth-sync.js';
import { XrayDiscovery, BackgroundJobs } from './xray-discovery.js';
import { nodeAccess, jsonValue } from './node-capabilities.js';
import { AuthService } from './auth.js';

const securityHeaders = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()'
};
function send(res,status,body,headers={}) {
  res.writeHead(status,{...securityHeaders,'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers});
  res.end(JSON.stringify(body));
}
async function serveFile(pathname,res) {
  const publicRoot=path.join(root,'public');
  const file=path.resolve(publicRoot,pathname==='/'?'index.html':pathname.slice(1));
  if(!file.startsWith(publicRoot+path.sep))return false;
  try { if(!(await stat(file)).isFile())return false;
    const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};
    res.writeHead(200,{...securityHeaders,'content-type':types[path.extname(file)]||'application/octet-stream','cache-control':'no-cache'});res.end(await readFile(file));return true;
  } catch(e) { if(e.code!=='ENOENT')throw e;return false; }
}
async function body(req) {
  if (!req.headers['content-type']?.includes('application/json')) throw httpError('请求必须使用 JSON',415);
  const data=[]; let size=0;
  for await (const chunk of req) { size+=chunk.length; if (size>65536) throw httpError('请求过大',413); data.push(chunk); }
  try { return JSON.parse(Buffer.concat(data).toString()); } catch { throw httpError('JSON 无效'); }
}
async function requestData(req) {
  if (req.headers['content-type']?.includes('application/json')) return { fields: await body(req), file: null };
  if (!req.headers['content-type']?.includes('multipart/form-data')) throw httpError('请求必须使用 JSON 或 multipart/form-data',415);
  return new Promise((resolve,reject)=>{
    let parser;
    try { parser=Busboy({headers:req.headers,limits:{fileSize:MAX_KEY_BYTES,files:1,fields:24,fieldSize:4096}}); }
    catch { reject(httpError('上传表单格式无效')); return; }
    const fields={}, chunks=[]; let file=null, tooLarge=false;
    parser.on('field',(name,value)=>{ fields[name]=value; });
    parser.on('file',(name,stream,info)=>{
      if(name!=='sshKey'||!info.filename){stream.resume();return;}
      file={name:info.filename || 'ssh-private-key',type:info.mimeType};
      stream.on('data',chunk=>chunks.push(chunk));
      stream.on('limit',()=>{tooLarge=true;});
    });
    parser.on('filesLimit',()=>reject(httpError('每次只能上传一个 SSH 私钥')));
    parser.on('fieldsLimit',()=>reject(httpError('表单字段过多')));
    parser.on('error',()=>reject(httpError('上传表单解析失败')));
    parser.on('close',()=>{
      if(tooLarge)return reject(httpError('SSH 私钥文件不能超过 64 KiB',413));
      if(file)file.buffer=Buffer.concat(chunks);
      resolve({fields,file});
    });
    req.pipe(parser);
  });
}
function optionalNumber(value,label) {
  if(value==null||value==='')return null;
  const parsed=Number(value); if(!Number.isFinite(parsed)||parsed<0)throw httpError(`${label}必须为不小于 0 的数字`); return parsed;
}
function normalizeServer(fields) {
  const name=String(fields.name||'').trim(),sshHost=String(fields.sshHost||fields.ssh_host||'').trim(),sshUser=String(fields.sshUser||fields.ssh_user||'').trim();
  const sshPort=Number(fields.sshPort||fields.ssh_port||22),officialUrl=String(fields.officialUrl||fields.official_url||'').trim()||null;
  const expiresOn=String(fields.expiresOn||fields.expires_on||'').trim()||null;
  if(!name||name.length>100)throw httpError('VPS 名称必填，且不能超过 100 个字符');
  if(isIP(sshHost)!==4)throw httpError('IPv4 地址格式无效');
  if(!Number.isInteger(sshPort)||sshPort<1||sshPort>65535)throw httpError('SSH 端口必须为 1–65535 的整数');
  if(!/^[a-zA-Z0-9._-]{1,64}$/.test(sshUser))throw httpError('SSH 用户名格式无效');
  if(expiresOn&&!/^\d{4}-\d{2}-\d{2}$/.test(expiresOn))throw httpError('到期时间格式无效');
  if(officialUrl){let parsed;try{parsed=new URL(officialUrl);}catch{throw httpError('官方链接格式无效');}if(!['http:','https:'].includes(parsed.protocol)||officialUrl.length>2048)throw httpError('官方链接仅支持 HTTP/HTTPS');}
  return {name,sshHost,sshPort,sshUser,memoryGb:optionalNumber(fields.memoryGb??fields.memory_gb,'内存'),systemDiskGb:optionalNumber(fields.systemDiskGb??fields.system_disk_gb,'系统盘'),
    trafficQuotaGb:optionalNumber(fields.trafficQuotaGb??fields.traffic_quota_gb,'套餐额度'),expiresOn,officialUrl};
}
function serverView(row) {
  return {id:String(row.id),name:row.name,ipv4:row.ssh_host,sshPort:Number(row.ssh_port),sshUser:row.ssh_user,
    sshKeyRef:row.ssh_key_ref,sshKeyOriginalName:row.ssh_key_original_name,sshKeyFingerprint:row.ssh_key_fingerprint,
    memoryGb:row.memory_gb==null?null:Number(row.memory_gb),systemDiskGb:row.system_disk_gb==null?null:Number(row.system_disk_gb),trafficQuotaGb:row.traffic_quota_gb==null?null:Number(row.traffic_quota_gb),
    providerTrafficUsedGb:row.provider_traffic_used_gb==null?null:Number(row.provider_traffic_used_gb),
    providerTrafficRecordedAt:row.provider_traffic_recorded_at ? parseDate(row.provider_traffic_recorded_at).toISOString() : null,
    bandwidthProvider:row.bandwidth_provider||'manual',kiwiVmVeid:row.kiwivm_veid||null,hasKiwiVmApiKey:Boolean(row.kiwivm_api_key_ref),
    providerUsageSource:row.provider_usage_source||'manual',providerSyncStatus:row.provider_sync_status||'unconfigured',
    providerSyncedAt:row.provider_synced_at?parseDate(row.provider_synced_at).toISOString():null,providerSyncError:row.provider_sync_error||null,
    providerTrafficResetAt:row.provider_traffic_reset_at?parseDate(row.provider_traffic_reset_at).toISOString():null,
    providerTrafficMultiplier:row.provider_traffic_multiplier==null?null:Number(row.provider_traffic_multiplier),
    monthTrafficBytes:String(row.month_traffic_bytes||0),officialUrl:row.official_url,expiresOn:row.expires_on,sshCheckStatus:row.ssh_check_status,sshCheckedAt:row.ssh_checked_at,sshCheckError:row.ssh_check_error,enabled:Boolean(row.enabled)};
}
async function serverById(pool,id) {
  const [[row]]=await pool.execute(`SELECT s.*,COALESCE(monthly.month_traffic_bytes,0) month_traffic_bytes FROM vps_servers s LEFT JOIN (
    SELECT i.server_id,SUM(td.uplink_bytes+td.downlink_bytes) month_traffic_bytes
    FROM traffic_daily td JOIN device_credentials dc ON dc.id=td.credential_id JOIN xray_instances i ON i.id=dc.instance_id
    WHERE td.stat_date>=DATE_FORMAT(DATE_ADD(UTC_TIMESTAMP(),INTERVAL 8 HOUR),'%Y-%m-01') GROUP BY i.server_id
  ) monthly ON monthly.server_id=s.id WHERE s.id=?`,[id]);
  if(!row)throw httpError('VPS 不存在',404);return row;
}
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function requestKey(req) {
  const key=req.headers['idempotency-key'] || randomUUID();
  if (!uuidPattern.test(key)) throw httpError('Idempotency-Key 必须为 UUID'); return key;
}
function view(c,full=false) {
  return { id:c.deviceId,credentialId:c.id,deviceId:c.deviceId,nodeId:c.nodeId,serverId:c.serverId,
    name:c.name,note:c.note,kind:c.kind,nodeName:c.node_name,uuidSummary:`${c.uuid.slice(0,8)}…${c.uuid.slice(-4)}`,
    uuid:c.uuid,email:c.email,status:c.status,enabled:c.enabled,appliedEnabled:c.applied_enabled==null?null:Boolean(c.applied_enabled),desiredEnabled:c.desiredEnabled,syncStatus:c.syncStatus,
    sourceIps:c.sourceIps,onlineIpCount:c.onlineIpCount,traffic:c.traffic,todayTraffic:c.todayTraffic,
    lastActive:c.lastActive,createdAt:c.createdAt,collectedAt:c.collectedAt,stale:c.stale,
    trafficAvailable:c.trafficAvailable,onlineAvailable:c.onlineAvailable };
}
function instanceView(row) { return {id:String(row.id),serverId:String(row.server_id),serverName:row.server_name,serviceName:row.service_name,
  configPath:row.config_path,binaryPath:row.binary_path,apiAddress:row.api_address,allowWrite:Boolean(row.allow_write),enabled:Boolean(row.enabled),
  version:row.version,serviceState:row.service_state,apiState:row.api_state,lastSuccessAt:row.last_success_at,lastError:row.last_error,
  diagnosedAt:row.diagnosed_at,diagnostics:jsonValue(row.diagnostics),nodeCount:Number(row.node_count||0),credentialCount:Number(row.credential_count||0)}; }
function nodeView(row) { return {id:String(row.id),instanceId:String(row.instance_id),serverId:String(row.server_id),name:row.name,
  serverName:row.server_name,serviceName:row.service_name,inboundTag:row.inbound_tag,publicHost:row.public_host,port:Number(row.port),
  protocol:row.protocol,transport:row.transport,security:row.security,serviceState:row.service_state,apiState:row.api_state,
  allowWrite:Boolean(row.allow_write),observedState:row.observed_state,lastSeenAt:row.last_seen_at,lastSuccessAt:row.last_success_at,
  lastError:row.last_error,diagnosedAt:row.diagnosed_at,diagnostics:row.diagnostics,access:row.access,
  credentialCount:Number(row.credential_count||0),version:row.version}; }
function link(c) {
  return createVlessUri({host:c.public_host,inbound:{port:c.port,security:c.security,sni:c.sni,publicKey:c.public_key,
    shortId:c.short_id,network:c.transport}}, {...c,email:c.xray_email});
}

export async function createDatabaseServer(options={}) {
  const pool=options.pool || createPool();
  await migrate(pool);
  const authDisabled=options.authDisabled===true;
  const auth=options.auth || new AuthService(pool,{publicOrigin:process.env.PUBLIC_ORIGIN||null,trustProxy:process.env.TRUST_PROXY==='loopback'});
  if(!authDisabled)await auth.cleanup();
  const repo=new Repository(pool); await repo.seed();
  const keyStore=options.keyStore || await new SshKeyStore(options.sshKeyDirectory).init();
  const providerSecretStore=options.providerSecretStore || await new ProviderSecretStore(options.providerSecretDirectory).init();
  if(options.migrateSshKeys!==false)await keyStore.migrateLegacyReferences(pool);
  const collector=new Collector(repo,options.providerFactory);
  const bandwidthSync=new BandwidthSync(pool,providerSecretStore,options.kiwiVmClientFactory);
  const discovery=options.discovery || new XrayDiscovery(pool,keyStore,options.providerFactory);
  const jobs=new BackgroundJobs();
  const server=http.createServer(async(req,res)=>{
    try {
      const url=new URL(req.url,'http://127.0.0.1'), s=url.pathname.split('/').filter(Boolean);
      const localOrigins=['http://127.0.0.1:'+server.address().port,'http://localhost:'+server.address().port];
      const allowedOrigins=new Set([...localOrigins,auth.publicOrigin].filter(Boolean));
      if (!['GET','HEAD'].includes(req.method) && req.headers.origin && !allowedOrigins.has(req.headers.origin)) throw httpError('不允许跨站修改',403);
      if(req.method==='GET'&&url.pathname==='/healthz')return send(res,200,{ok:true});
      if(!authDisabled&&req.method==='POST'&&url.pathname==='/api/auth/setup'){
        const result=await auth.initializeAdmin(req,await body(req));
        return send(res,201,{user:result.user,csrfToken:result.csrf,expiresAt:result.expiresAt},{'set-cookie':result.cookie});
      }
      if(!authDisabled&&req.method==='POST'&&url.pathname==='/api/auth/login'){
        if(!await auth.isConfigured())throw httpError('请先完成管理员初始化',409);
        const result=await auth.login(req,await body(req));
        return send(res,200,{user:result.user,csrfToken:result.csrf,expiresAt:result.expiresAt},{'set-cookie':result.cookie});
      }
      if(req.method==='GET'&&['/login.html','/login.js','/setup.html','/setup.js','/styles.css'].includes(url.pathname)){
        if(!authDisabled&&url.pathname==='/setup.html'&&await auth.isConfigured()){res.writeHead(302,{...securityHeaders,location:'/login.html'});return res.end();}
        if(!authDisabled&&url.pathname==='/login.html'&&await auth.authenticate(req)){res.writeHead(302,{...securityHeaders,location:'/'});return res.end();}
        if(await serveFile(url.pathname,res))return;
      }
      const session=authDisabled?null:await auth.authenticate(req);
      if(!authDisabled&&!session){
        if(url.pathname.startsWith('/api/'))return send(res,401,{code:'AUTH_REQUIRED',error:'请先登录'});
        if(['GET','HEAD'].includes(req.method)){const next=url.pathname+(url.search||'');res.writeHead(302,{...securityHeaders,location:`/login.html?next=${encodeURIComponent(next)}`});return res.end();}
        throw httpError('请先登录',401);
      }
      if(!authDisabled&&req.method==='GET'&&url.pathname==='/api/auth/session')return send(res,200,{authenticated:true,user:session.user,csrfToken:session.csrfToken,expiresAt:session.expiresAt,remember:session.remember});
      if(!authDisabled&&!['GET','HEAD'].includes(req.method))auth.verifyCsrf(req,session);
      if(!authDisabled&&req.method==='POST'&&url.pathname==='/api/auth/logout'){
        await auth.revokeCurrent(req,session);return send(res,200,{ok:true},{'set-cookie':auth.cookie('',{clear:true})});
      }
      if(!authDisabled&&req.method==='POST'&&url.pathname==='/api/auth/logout-all')return send(res,200,{ok:true,revoked:await auth.revokeOthers(req,session)});
      if(!authDisabled&&req.method==='POST'&&url.pathname==='/api/auth/change-password'){
        const data=await body(req);await auth.changePassword(req,session,data.currentPassword,data.newPassword);
        await pool.execute('UPDATE auth_sessions SET revoked_at=UTC_TIMESTAMP(3) WHERE token_hash=?',[session.tokenHash]);
        const [[user]]=await pool.execute('SELECT * FROM admin_users WHERE id=?',[session.user.id]);const replacement=await auth.issueSession(req,user,session.remember);
        return send(res,200,{ok:true,user:session.user,csrfToken:replacement.csrf,expiresAt:replacement.expiresAt},{'set-cookie':replacement.cookie});
      }
      if(!authDisabled&&req.method==='GET'&&url.pathname==='/api/auth/audit')return send(res,200,{items:await auth.auditRows(session.user.id,url.searchParams.get('limit'))});
      const filters=Object.fromEntries(['serverId','nodeId'].filter(k=>url.searchParams.get(k)).map(k=>[k,url.searchParams.get(k)]));
      if (req.method==='GET' && url.pathname==='/api/health') {
        let instances=await repo.instances();
        if(filters.serverId)instances=instances.filter(i=>String(i.server_id)===String(filters.serverId));
        if(filters.nodeId){const node=(await repo.nodes()).find(n=>String(n.id)===String(filters.nodeId));instances=instances.filter(i=>node&&String(i.id)===String(node.instance_id));}
        const healthy=i=>i.service_state==='active' && i.api_state==='available' && !i.last_error && i.last_success_at && Date.now()-parseDate(i.last_success_at).getTime()<180000;
        const healthyCount=instances.filter(healthy).length,ok=instances.length>0&&healthyCount===instances.length;
        return send(res,200,{ok,provider:'mysql-ssh-xray',database:'connected',xrayVersion:instances.length===1?(instances[0].version||'Xray'):`${healthyCount}/${instances.length} 服务正常`,
          summary:{healthy:healthyCount,total:instances.length},api:{available:ok},pollIntervalSeconds:60,instances:instances.map(i=>({id:i.id,serverId:i.server_id,service:i.service_name,version:i.version,serviceState:i.service_state,apiState:i.api_state,lastSuccessAt:i.last_success_at,error:i.last_error}))});
      }
      if (req.method==='GET' && url.pathname==='/api/servers') return send(res,200,{items:(await repo.servers()).map(serverView)});
      if (req.method==='GET' && s[0]==='api' && s[1]==='servers' && /^\d+$/.test(s[2]) && s.length===3) return send(res,200,{server:serverView(await serverById(pool,s[2]))});
      if (req.method==='GET' && url.pathname==='/api/nodes') return send(res,200,{items:(await repo.nodes(filters)).map(nodeView)});
      if (req.method==='GET' && url.pathname==='/api/instances') return send(res,200,{items:(await repo.instanceRows(filters)).map(instanceView)});
      if (req.method==='GET' && s[0]==='api' && s[1]==='instances' && /^\d+$/.test(s[2]) && s.length===3) {
        const row=(await repo.instanceRows()).find(v=>String(v.id)===s[2]);if(!row)throw httpError('Xray 服务不存在',404);return send(res,200,{instance:instanceView(row)});
      }
      if (req.method==='PATCH' && s[0]==='api' && s[1]==='instances' && /^\d+$/.test(s[2]) && s.length===3) {
        const data=await body(req);if(typeof data.allowWrite!=='boolean')throw httpError('allowWrite 必须为布尔值');
        const [[row]]=await pool.execute('SELECT * FROM xray_instances WHERE id=?',[s[2]]);if(!row)throw httpError('Xray 服务不存在',404);
        if(data.allowWrite){const diagnosis=jsonValue(row.diagnostics),fresh=row.diagnosed_at&&Date.now()-parseDate(row.diagnosed_at).getTime()<180000;
          if(!fresh||!diagnosis?.management)throw httpError('动态管理能力尚未通过诊断，不能开启设备管理',409);}
        await pool.execute('UPDATE xray_instances SET allow_write=? WHERE id=?',[data.allowWrite,s[2]]);
        const updated=(await repo.instanceRows()).find(v=>String(v.id)===s[2]);return send(res,200,{instance:instanceView(updated)});
      }
      if (req.method==='PATCH' && s[0]==='api' && s[1]==='nodes' && /^\d+$/.test(s[2]) && s.length===3) {
        const data=await body(req),name=String(data.name||'').trim();if(!name||name.length>100)throw httpError('节点名称必填且最多 100 字');
        const [result]=await pool.execute('UPDATE nodes SET name=? WHERE id=?',[name,s[2]]);if(!result.affectedRows)throw httpError('节点不存在',404);return send(res,200,{ok:true});
      }
      if (req.method==='GET' && s[0]==='api' && s[1]==='xray-jobs' && s[2]) return send(res,200,jobs.get(s[2]));
      if (req.method==='POST' && s[0]==='api' && s[1]==='servers' && /^\d+$/.test(s[2]) && s[3]==='discover-xray') {
        const job=jobs.start('discover',async step=>{step('正在扫描 systemd 服务');return discovery.discover(s[2]);});return send(res,202,{operationId:job.id});
      }
      if (req.method==='POST' && s[0]==='api' && s[1]==='servers' && /^\d+$/.test(s[2]) && s[3]==='preflight-xray') {
        const data=await body(req),job=jobs.start('preflight',async step=>{step('正在读取配置并检测 API 能力');return discovery.preflight(s[2],data);});return send(res,202,{operationId:job.id});
      }
      if (req.method==='POST' && s[0]==='api' && s[1]==='servers' && /^\d+$/.test(s[2]) && s[3]==='connect-xray') {
        const data=await body(req),job=jobs.start('connect',async step=>{step('正在复核服务配置');const result=await discovery.connect(s[2],data,collector);step('正在导入节点和凭证');return result;});return send(res,202,{operationId:job.id});
      }
      if (req.method==='POST' && s[0]==='api' && s[1]==='instances' && /^\d+$/.test(s[2]) && s[3]==='diagnose') {
        const job=jobs.start('diagnose',async step=>{step('正在重新采集并核对能力');await collector.refresh(s[2]);const row=(await repo.instanceRows()).find(v=>String(v.id)===s[2]);if(!row)throw httpError('Xray 服务不存在',404);return instanceView(row);});return send(res,202,{operationId:job.id});
      }
      if (req.method==='PATCH' && s[0]==='api' && s[1]==='servers' && /^\d+$/.test(s[2]) && s[3]==='traffic-usage' && s.length===4) {
        const data=await body(req),usedGb=normalizeUsedGb(data?.usedGb);
        const [result]=await pool.execute("UPDATE vps_servers SET provider_traffic_used_gb=?,provider_traffic_recorded_at=UTC_TIMESTAMP(3),provider_usage_source='manual' WHERE id=?",[usedGb,s[2]]);
        if(!result.affectedRows)throw httpError('VPS 不存在',404);
        return send(res,200,{server:serverView(await serverById(pool,s[2]))});
      }
      if (req.method==='PUT' && s[0]==='api' && s[1]==='servers' && /^\d+$/.test(s[2]) && s[3]==='kiwivm' && s.length===4) {
        const data=await body(req);
        await bandwidthSync.configure(s[2],{veid:data?.veid,apiKey:data?.apiKey});
        return send(res,200,{server:serverView(await serverById(pool,s[2]))});
      }
      if (req.method==='DELETE' && s[0]==='api' && s[1]==='servers' && /^\d+$/.test(s[2]) && s[3]==='kiwivm' && s.length===4) {
        await bandwidthSync.remove(s[2]);
        return send(res,200,{server:serverView(await serverById(pool,s[2]))});
      }
      if (req.method==='POST' && s[0]==='api' && s[1]==='servers' && /^\d+$/.test(s[2]) && s[3]==='sync-bandwidth' && s.length===4) {
        await bandwidthSync.sync(s[2]);
        return send(res,200,{server:serverView(await serverById(pool,s[2]))});
      }
      if (req.method==='POST' && url.pathname==='/api/servers') {
        const {fields,file}=await requestData(req),b=normalizeServer(fields);
        let saved=null;
        if(file)saved=await keyStore.save(file.buffer,file.name);
        const legacyRef=options.allowLegacySshKeyRef===true&&typeof fields.sshKeyRef==='string'&&fields.sshKeyRef.trim()?fields.sshKeyRef.trim():null;
        if(!saved&&!legacyRef)throw httpError('请上传 SSH 私钥');
        try {
          const [r]=await pool.execute(`INSERT INTO vps_servers(name,ssh_host,ssh_port,ssh_user,ssh_key_ref,ssh_key_original_name,ssh_key_fingerprint,memory_gb,system_disk_gb,traffic_quota_gb,official_url,expires_on)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,[b.name,b.sshHost,b.sshPort,b.sshUser,saved?.reference||legacyRef,saved?.originalName||null,saved?.fingerprint||null,b.memoryGb,b.systemDiskGb,b.trafficQuotaGb,b.officialUrl,b.expiresOn]);
          return send(res,201,{id:String(r.insertId),server:serverView(await serverById(pool,r.insertId))});
        } catch(error) { if(saved)await rm(keyStore.resolve(saved.reference),{force:true}); throw error; }
      }
      if (req.method==='PATCH' && s[0]==='api' && s[1]==='servers' && /^\d+$/.test(s[2]) && s.length===3) {
        const current=await serverById(pool,s[2]),{fields,file}=await requestData(req),b=normalizeServer(fields);let saved=null;
        if(file)saved=await keyStore.save(file.buffer,file.name);
        const hostChanged=current.ssh_host!==b.sshHost||Number(current.ssh_port)!==b.sshPort;
        const identityChanged=hostChanged||current.ssh_user!==b.sshUser||Boolean(saved);
        try {
          await pool.execute(`UPDATE vps_servers SET name=?,ssh_host=?,ssh_port=?,ssh_user=?,ssh_key_ref=?,ssh_key_original_name=?,ssh_key_fingerprint=?,memory_gb=?,system_disk_gb=?,traffic_quota_gb=?,official_url=?,expires_on=?,
            ssh_host_key=IF(?,NULL,ssh_host_key),ssh_check_status=IF(?,'untested',ssh_check_status),ssh_checked_at=IF(?,NULL,ssh_checked_at),ssh_check_error=IF(?,NULL,ssh_check_error) WHERE id=?`,
          [b.name,b.sshHost,b.sshPort,b.sshUser,saved?.reference||current.ssh_key_ref,saved?.originalName||current.ssh_key_original_name,saved?.fingerprint||current.ssh_key_fingerprint,b.memoryGb,b.systemDiskGb,b.trafficQuotaGb,b.officialUrl,b.expiresOn,hostChanged,identityChanged,identityChanged,identityChanged,s[2]]);
          return send(res,200,{server:serverView(await serverById(pool,s[2]))});
        } catch(error) { if(saved)await rm(keyStore.resolve(saved.reference),{force:true}); throw error; }
      }
      if (req.method==='POST' && s[0]==='api' && s[1]==='servers' && /^\d+$/.test(s[2]) && s[3]==='test-ssh') {
        const current=await serverById(pool,s[2]);await pool.execute("UPDATE vps_servers SET ssh_check_status='checking',ssh_check_error=NULL WHERE id=?",[s[2]]);
        try {
          const scanned=await scanHostKey(current.ssh_host,current.ssh_port);
          if(!current.ssh_host_key){await pool.execute("UPDATE vps_servers SET ssh_check_status='awaiting_trust',ssh_checked_at=UTC_TIMESTAMP(3) WHERE id=?",[s[2]]);return send(res,409,{code:'HOST_KEY_TRUST_REQUIRED',fingerprint:scanned.fingerprint,error:'首次连接需要确认 SSH 主机指纹'});}
          if(scanned.hostKey!==current.ssh_host_key){await pool.execute("UPDATE vps_servers SET ssh_check_status='host_key_changed',ssh_checked_at=UTC_TIMESTAMP(3),ssh_check_error='SSH 主机密钥已变化，连接已阻止' WHERE id=?",[s[2]]);return send(res,409,{code:'HOST_KEY_CHANGED',fingerprint:scanned.fingerprint,error:'SSH 主机密钥已变化，连接已阻止'});}
          await verifySsh(current,keyStore.resolve(current.ssh_key_ref),current.ssh_host_key);
          await pool.execute("UPDATE vps_servers SET ssh_check_status='online',ssh_checked_at=UTC_TIMESTAMP(3),ssh_check_error=NULL WHERE id=?",[s[2]]);
          return send(res,200,{ok:true,server:serverView(await serverById(pool,s[2]))});
        } catch(error) { await pool.execute("UPDATE vps_servers SET ssh_check_status='failed',ssh_checked_at=UTC_TIMESTAMP(3),ssh_check_error=? WHERE id=?",[(error.publicMessage||'SSH 检测失败').slice(0,512),s[2]]);throw error; }
      }
      if (req.method==='POST' && s[0]==='api' && s[1]==='servers' && /^\d+$/.test(s[2]) && s[3]==='trust-host-key') {
        const current=await serverById(pool,s[2]),b=await body(req),scanned=await scanHostKey(current.ssh_host,current.ssh_port);
        if(typeof b.fingerprint!=='string'||b.fingerprint!==scanned.fingerprint)throw httpError('远端主机指纹已变化，请重新检测后确认',409);
        await pool.execute("UPDATE vps_servers SET ssh_host_key=?,ssh_check_status='checking',ssh_check_error=NULL WHERE id=?",[scanned.hostKey,s[2]]);
        try {await verifySsh(current,keyStore.resolve(current.ssh_key_ref),scanned.hostKey);await pool.execute("UPDATE vps_servers SET ssh_check_status='online',ssh_checked_at=UTC_TIMESTAMP(3),ssh_check_error=NULL WHERE id=?",[s[2]]);return send(res,200,{ok:true,server:serverView(await serverById(pool,s[2]))});}
        catch(error){await pool.execute("UPDATE vps_servers SET ssh_check_status='failed',ssh_checked_at=UTC_TIMESTAMP(3),ssh_check_error=? WHERE id=?",[(error.publicMessage||'SSH 检测失败').slice(0,512),s[2]]);throw error;}
      }
      if (req.method==='POST' && url.pathname==='/api/instances') {
        const b=await body(req);
        if(!b.serverId)throw httpError('请选择 VPS');
        const job=jobs.start('connect',async step=>{step('正在复核服务配置');return discovery.connect(b.serverId,b,collector);});
        return send(res,202,{operationId:job.id});
      }
      if (req.method==='POST' && url.pathname==='/api/refresh') {
        const b=await body(req); const result=await collector.refresh(b.instanceId); return send(res,200,{results:result});
      }
      if (req.method==='GET' && url.pathname==='/api/dashboard') {
        const cs=await repo.credentials(filters), ids=new Set(cs.map(c=>c.deviceId));
        return send(res,200,{total:ids.size,credentialCount:cs.length,
          online:new Set(cs.filter(c=>c.status==='online').map(c=>c.deviceId)).size,
          disabled:[...ids].filter(id=>cs.filter(c=>c.deviceId===id).every(c=>c.status==='disabled')).length,
          totalTraffic:totals(cs.reduce((a,c)=>a+BigInt(c.traffic.uplinkBytes),0n),cs.reduce((a,c)=>a+BigInt(c.traffic.downlinkBytes),0n)).total});
      }
      if (req.method==='GET' && url.pathname==='/api/devices') {
        let cs=await repo.credentials(filters);
        const q=(url.searchParams.get('query')||'').toLowerCase(), status=url.searchParams.get('status')||'all';
        cs=cs.filter(c=>(status==='all'||c.status===status) && (!q||[c.name,c.note,c.uuid,c.email,...c.sourceIps].join(' ').toLowerCase().includes(q)));
        const grouped=new Map();
        for (const c of cs) { if (!grouped.has(c.deviceId)) grouped.set(c.deviceId,{id:c.deviceId,name:c.name,note:c.note,kind:c.kind,credentials:[]}); grouped.get(c.deviceId).credentials.push(view(c)); }
        const items=[...grouped.values()].map(d=>({...d,traffic:totals(d.credentials.reduce((a,c)=>a+BigInt(c.traffic.uplinkBytes),0n),d.credentials.reduce((a,c)=>a+BigInt(c.traffic.downlinkBytes),0n))}));
        const page=Math.max(1,parseInt(url.searchParams.get('page'))||1),pageSize=Math.min(100,Math.max(1,parseInt(url.searchParams.get('pageSize'))||50));
        return send(res,200,{items:items.slice((page-1)*pageSize,page*pageSize),total:items.length,page,pageSize,collectedAt:Math.max(0,...cs.map(c=>c.collectedAt||0))||null});
      }
      if (req.method==='POST' && url.pathname==='/api/devices') {
        const b=await body(req),key=requestKey(req);
        return send(res,202,{operationId:String(await repo.queueCreate(b,key)),idempotencyKey:key});
      }
      if (req.method==='GET' && s[1]==='operations' && s[2]) return send(res,200,await repo.operation(s[2]));
      if (req.method==='PATCH' && s[1]==='devices' && /^\d+$/.test(s[2]) && s.length===3) {
        const b=await body(req);
        if (typeof b.name!=='string'||!b.name.trim()||b.name.length>30||typeof b.note!=='string'||b.note.length>60) throw httpError('名称必填且最多30字，备注最多60字');
        await transaction(pool,async c=>{
          const [r]=await c.execute('UPDATE devices SET name=?,note=? WHERE id=?',[b.name.trim(),b.note,s[2]]);
          if (!r.affectedRows) throw httpError('设备不存在',404);
          await c.execute("INSERT INTO management_operations(idempotency_key,action,status,changes,finished_at) VALUES (?,'edit_device','success',?,UTC_TIMESTAMP(3))",[randomUUID(),JSON.stringify({deviceId:s[2],name:b.name,note:b.note})]);
        }); return send(res,200,{ok:true});
      }
      if (['devices','credentials'].includes(s[1]) && s[2]) {
        const isUuid=uuidPattern.test(s[2]);
        const lookup=s[1]==='credentials'?{credentialId:s[2]}:isUuid?{uuid:s[2]}:{deviceId:s[2]};
        const cs=await repo.credentials(lookup); if (!cs.length) throw httpError('设备或凭证不存在',404);
        const c=cs[0];
        if (req.method==='PATCH' && s[3]==='enabled' && s[1]==='credentials') {
          const b=await body(req),key=requestKey(req);
          return send(res,202,{operationId:String(await repo.queueEnabled(c.id,b.enabled,key)),idempotencyKey:key});
        }
        if (req.method==='GET' && s[3]==='traffic') {
          const from=url.searchParams.get('from')||dayKey(Date.now()-29*86400000),to=url.searchParams.get('to')||dayKey(Date.now());
          return send(res,200,await repo.traffic(lookup,from,to,url.searchParams.get('groupBy')||'day'));
        }
        if (req.method==='GET' && s[3]==='qrcode') {
          if (s[1]==='devices'&&!isUuid&&cs.length>1) throw httpError('请选择具体节点凭证');
          const access=nodeAccess(c);if(!access.canQr)throw httpError(access.reason||'节点参数或诊断状态不支持生成二维码',409);
          if (!c.enabled||c.syncStatus!=='synced') throw httpError('凭证尚未确认启用，暂不能导入',409);
          const svg=await QRCode.toString(link(c),{type:'svg',width:240,margin:2,errorCorrectionLevel:'M'});
          res.writeHead(200,{'content-type':'image/svg+xml; charset=utf-8','cache-control':'no-store'});return res.end(svg);
        }
        if (req.method==='GET'&&s.length===3) return send(res,200,{device:view(c,true),credentials:cs.map(v=>view(v,true)),vlessUri:cs.length===1?link(c):null,
          node:{port:c.port,protocol:c.protocol,network:c.transport,security:c.security,name:c.node_name}});
      }
      if (req.method==='GET' && !url.pathname.startsWith('/api/')) {
        if(await serveFile(url.pathname,res))return;
      }
      throw httpError('接口或页面不存在',404);
    } catch(e) { const message=e.code==='ER_DUP_ENTRY'?'记录已存在，请勿重复创建':safeError(e); send(res,e.status||(e.code==='ER_DUP_ENTRY'?409:502),{error:message},e.retryAfter?{'retry-after':String(e.retryAfter)}:{}); }
  });
  if(options.startCollector!==false) {
    collector.start();
    collector.refresh().catch(e=>console.error(safeError(e)));
  }
  const startProviderSync=options.startProviderSync ?? (options.startCollector!==false);
  if(startProviderSync) bandwidthSync.start();
  return {server,pool,repo,collector,bandwidthSync,auth,close:async()=>{await Promise.all([collector.stop(),bandwidthSync.stop()]);await new Promise(resolve=>server.close(resolve));await pool.end();}};
}
