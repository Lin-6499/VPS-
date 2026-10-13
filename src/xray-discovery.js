import { randomUUID } from 'node:crypto';
import { ManagedSshProvider } from './managed-ssh.js';
import { trustedSsh } from './ssh-check.js';
import { snapshotDiagnosis } from './node-capabilities.js';
import { safeError, httpError } from './db.js';

const DISCOVERY_SCRIPT = String.raw`
import json,subprocess,re,os,shlex
def run(args):
    return subprocess.run(args,text=True,capture_output=True,timeout=15)
services=[]
raw=run(['systemctl','list-units','--type=service','--all','--no-legend','--plain']).stdout
names=[]
for line in raw.splitlines():
    name=line.split()[0] if line.split() else ''
    if name.endswith('.service') and 'xray' in name.lower(): names.append(name)
for name in sorted(set(names)):
    command=run(['systemctl','show',name,'-p','ExecStart','--value']).stdout.strip()
    active=run(['systemctl','is-active',name]).stdout.strip()
    binary=''
    m=re.search(r'(\/[^ ;{}]*xray)(?:\s|;)',command+';')
    if m: binary=m.group(1)
    if not binary:
        binary=run(['sh','-lc','command -v xray || true']).stdout.strip()
    config=''
    directory=False
    for pattern in [r'(?:-config|-c)\s+([^ ;}]+)',r'(?:-config=|-c=)([^ ;}]+)']:
        m=re.search(pattern,command)
        if m: config=m.group(1).strip('"'); break
    d=re.search(r'(?:-confdir|-config-dir)\s+([^ ;}]+)',command)
    if d: directory=True; config=d.group(1).strip('"')
    if not config:
        for candidate in ['/usr/local/etc/xray/config.json','/etc/xray/config.json']:
            if os.path.isfile(candidate): config=candidate; break
    item={'serviceName':name,'serviceState':active,'binaryPath':binary or '/usr/local/bin/xray','configPath':config,
          'complexConfig':directory,'apiAddress':'127.0.0.1:10085','version':'','nodes':[],'supported':False,'reason':''}
    if directory: item['reason']='当前使用配置目录，首版仅支持单个 JSON 配置文件'
    elif not config or not os.path.isfile(config): item['reason']='未找到可读取的 Xray 配置文件'
    else:
        try:
            c=json.load(open(config)); item['apiAddress']=c.get('api',{}).get('listen') or item['apiAddress']
            for i,ib in enumerate(c.get('inbounds',[])):
                stream=ib.get('streamSettings',{}); reality=stream.get('realitySettings',{})
                network=stream.get('network','tcp'); security=stream.get('security','none')
                ok=ib.get('protocol')=='vless' and network in ['tcp','raw'] and security=='reality'
                item['nodes'].append({'tag':ib.get('tag') or '#index:'+str(i),'port':ib.get('port'),
                  'protocol':ib.get('protocol',''),'transport':network,'security':security,
                  'credentialCount':len(ib.get('settings',{}).get('clients',[])),'supported':ok})
            item['supported']=any(n['supported'] for n in item['nodes'])
            if not item['supported']: item['reason']='未发现受支持的 VLESS + TCP/RAW + REALITY 节点'
        except Exception as e: item['reason']='配置文件不是有效 JSON：'+str(e)[:120]
    if os.path.isfile(item['binaryPath']):
        version=run([item['binaryPath'],'version']).stdout
        item['version']=version.splitlines()[0] if version else ''
    services.append(item)
print(json.dumps({'services':services},ensure_ascii=False))
`;

function remoteCommand(script, data) {
  const source=`import base64,json\np=json.loads(base64.b64decode('${Buffer.from(JSON.stringify(data)).toString('base64')}'))\n${script}`;
  return `python3 -c "import base64;exec(base64.b64decode('${Buffer.from(source).toString('base64')}'))"`;
}
export class XrayDiscovery {
  constructor(pool,keyStore,providerFactory=i=>new ManagedSshProvider(i)) { this.pool=pool;this.keyStore=keyStore;this.providerFactory=providerFactory; }
  async server(id) {
    const [[row]]=await this.pool.execute('SELECT * FROM vps_servers WHERE id=?',[id]);
    if(!row)throw httpError('VPS 不存在',404);
    if(row.ssh_check_status!=='online'||!row.ssh_host_key)throw httpError('请先测试 SSH 并确认主机指纹',409);
    return row;
  }
  async discover(serverId) {
    const server=await this.server(serverId);
    const {stdout}=await trustedSsh(server,this.keyStore.resolve(server.ssh_key_ref),remoteCommand(DISCOVERY_SCRIPT,{}));
    try{return JSON.parse(stdout);}catch{throw httpError('远端服务发现结果无效',502);}
  }
  normalize(server,body) {
    const serviceName=String(body.serviceName||'').trim(),configPath=String(body.configPath||'').trim();
    const binaryPath=String(body.binaryPath||'/usr/local/bin/xray').trim(),apiAddress=String(body.apiAddress||'127.0.0.1:10085').trim();
    if(!/^[a-zA-Z0-9_.@-]+\.service$/.test(serviceName))throw httpError('systemd 服务名格式无效');
    if(!configPath.startsWith('/')||!binaryPath.startsWith('/'))throw httpError('程序和配置路径必须是绝对路径');
    if(!/^(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/.test(apiAddress))throw httpError('API 地址必须监听 VPS 回环地址');
    return {server_id:server.id,server_name:server.name,ssh_host:server.ssh_host,ssh_port:server.ssh_port,ssh_user:server.ssh_user,
      ssh_key_ref:server.ssh_key_ref,ssh_host_key:server.ssh_host_key,service_name:serviceName,config_path:configPath,binary_path:binaryPath,api_address:apiAddress,allow_write:0,enabled:1};
  }
  async preflight(serverId,body) {
    const server=await this.server(serverId),candidate=this.normalize(server,body);
    const snapshot=await this.providerFactory(candidate).collect();
    const diagnosis=snapshotDiagnosis(snapshot);
    return {candidate:{serviceName:candidate.service_name,configPath:candidate.config_path,binaryPath:candidate.binary_path,apiAddress:candidate.api_address},snapshot,diagnosis};
  }
  async connect(serverId,body,collector) {
    const checked=await this.preflight(serverId,body),c=checked.candidate;
    if(!checked.diagnosis.nodes.some(node=>node.supported))throw httpError('未发现可接入的 VLESS + TCP/RAW + REALITY 节点',409);
    const [[existing]]=await this.pool.execute('SELECT * FROM xray_instances WHERE server_id=? AND service_name=?',[serverId,c.serviceName]);
    if(existing){
      if(existing.config_path!==c.configPath||existing.binary_path!==c.binaryPath||existing.api_address!==c.apiAddress)throw httpError('同名服务已接入，但程序、配置或 API 地址不同，请检查现有记录',409);
      return {instanceId:String(existing.id),existing:true,diagnosis:checked.diagnosis};
    }
    const [result]=await this.pool.execute(`INSERT INTO xray_instances(server_id,service_name,config_path,binary_path,api_address,allow_write,diagnostics,diagnosed_at)
      VALUES (?,?,?,?,?,FALSE,?,UTC_TIMESTAMP(3))`,[serverId,c.serviceName,c.configPath,c.binaryPath,c.apiAddress,JSON.stringify(checked.diagnosis)]);
    const collected=await collector.refresh(result.insertId);
    if(!collected.some(item=>item.ok||item.skipped)){
      await this.pool.execute('DELETE FROM xray_instances WHERE id=?',[result.insertId]);
      throw httpError(collected[0]?.error||'首次节点导入失败',502);
    }
    return {instanceId:String(result.insertId),existing:false,diagnosis:checked.diagnosis};
  }
}

export class BackgroundJobs {
  constructor(){this.jobs=new Map();}
  start(type,runner){const id=randomUUID(),job={id,type,status:'running',step:'正在连接 VPS',createdAt:new Date().toISOString()};this.jobs.set(id,job);
    if(this.jobs.size>200){const oldest=this.jobs.keys().next().value;if(oldest)this.jobs.delete(oldest);}
    Promise.resolve().then(()=>runner(step=>{job.step=step;})).then(result=>Object.assign(job,{status:'success',step:'已完成',result,finishedAt:new Date().toISOString()}))
      .catch(error=>Object.assign(job,{status:'failed',step:'执行失败',error:safeError(error),finishedAt:new Date().toISOString()}));return job;}
  get(id){const job=this.jobs.get(id);if(!job)throw httpError('后台任务不存在或服务已重启',404);return job;}
}
