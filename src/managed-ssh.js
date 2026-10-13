import { SshKeyStore } from './ssh-key-store.js';
import { trustedSsh } from './ssh-check.js';
const keyStore = new SshKeyStore();

const COLLECT = String.raw`
import json,subprocess,time,re,hashlib
def run(args):
    return subprocess.run(args,text=True,capture_output=True,timeout=8)
def call(args):
    r=run([p['binary_path'],'api']+args)
    if r.returncode:
        if 'not found' in r.stderr.lower(): return {},'not_found'
        return {},'api_error'
    try: return json.loads(r.stdout),None
    except: return {},'invalid_json'
def epoch():
    return run(['systemctl','show',p['service_name'],'-p','InvocationID','--value']).stdout.strip()
initial_epoch=epoch()
raw=open(p['config_path'],'rb').read()
c=json.loads(raw)
active=run(['systemctl','is-active',p['service_name']]).stdout.strip()
api=c.get('api',{})
address=api.get('listen') or p['api_address']
allstats,stats_error=call(['statsquery','--server='+address,'-pattern','user>>>','-reset=false']) if active=='active' else ({},'service_inactive')
api_ok=active=='active' and 'StatsService' in api.get('services',[]) and stats_error is None
values={s['name']:str(s.get('value',0)) for s in allstats.get('stat',[])}
nodes=[]
unsupported=[]
for index,ib in enumerate(c.get('inbounds',[])):
    if ib.get('protocol')!='vless':
        unsupported.append({'tag':ib.get('tag') or '#index:'+str(index),'port':ib.get('port'),'protocol':ib.get('protocol',''),'reason':'首版仅支持 VLESS 节点'})
        continue
    tag=ib.get('tag') or '#index:'+str(index)
    live,live_error=call(['inbounduser','--server='+address,'-tag='+tag]) if 'HandlerService' in api.get('services',[]) else ({},'handler_unavailable')
    runtime_users=[{'email':u.get('email',''),'uuid':u.get('account',{}).get('id','').lower(),'flow':u.get('account',{}).get('flow',''),'level':u.get('level',0)} for u in live.get('users',[])]
    stream=ib.get('streamSettings',{})
    reality=stream.get('realitySettings',{})
    public=''
    if reality.get('privateKey'):
        derived=run([p['binary_path'],'x25519','-i',reality['privateKey']]).stdout
        match=re.search(r'(?:Password \(PublicKey\)|Public key):\s*(\S+)',derived,re.I)
        if match: public=match.group(1)
    clients=[]
    for client in ib.get('settings',{}).get('clients',[]):
        email=client.get('email')
        policy=c.get('policy',{}).get('levels',{}).get(str(client.get('level',0)),{})
        traffic_ok=api_ok and 'stats' in c and bool(email) and policy.get('statsUserUplink',False) and policy.get('statsUserDownlink',False)
        online_ok=api_ok and 'stats' in c and bool(email) and policy.get('statsUserOnline',False)
        ips={}
        if online_ok:
            online,error=call(['statsonlineiplist','--server='+address,'-email',email])
            online_ok=error in (None,'not_found')
            ips=online.get('ips',{}) if online_ok else {}
        prefix='user>>>'+str(email)+'>>>traffic>>>'
        clients.append({'uuid':client['id'].lower(),'email':email,'flow':client.get('flow',''),'level':client.get('level',0),
          'trafficAvailable':traffic_ok,'onlineAvailable':online_ok,'sourceIps':list(ips.keys()),
          'lastActive':max(ips.values()) if ips else None,
          'uplinkBytes':values.get(prefix+'uplink','0') if traffic_ok else None,
          'downlinkBytes':values.get(prefix+'downlink','0') if traffic_ok else None})
    level_zero=c.get('policy',{}).get('levels',{}).get('0',{})
    traffic_configured=api_ok and 'stats' in c and (all(x['trafficAvailable'] for x in clients) if clients else level_zero.get('statsUserUplink',False) and level_zero.get('statsUserDownlink',False))
    online_configured=api_ok and 'stats' in c and (all(x['onlineAvailable'] for x in clients) if clients else level_zero.get('statsUserOnline',False))
    supported=ib.get('protocol')=='vless' and stream.get('network','tcp') in ['tcp','raw'] and stream.get('security','none')=='reality' and bool((reality.get('serverNames') or [''])[0]) and bool(public)
    nodes.append({'tag':tag,'port':ib['port'],'protocol':ib['protocol'],'network':stream.get('network','tcp'),
      'security':stream.get('security','none'),'sni':(reality.get('serverNames') or [''])[0],
      'shortId':(reality.get('shortIds') or [''])[0],'publicKey':public,'clients':clients,
      'supported':supported,'trafficConfigured':traffic_configured,'onlineConfigured':online_configured,
      'manageable':live_error is None,'runtimeAvailable':live_error is None,'runtimeUsers':runtime_users})
if initial_epoch!=epoch(): raise RuntimeError('SERVICE_RESTARTED_DURING_COLLECTION')
print(json.dumps({'nodes':nodes,'unsupported':unsupported,'epoch':initial_epoch,'serviceState':active,'apiAvailable':api_ok,
 'version':run([p['binary_path'],'version']).stdout.splitlines()[0],
 'serviceStartedAt':run(['systemctl','show',p['service_name'],'-p','ActiveEnterTimestamp','--value']).stdout.strip(),
 'configHash':hashlib.sha256(raw).hexdigest(),'collectedAt':int(time.time()*1000)}))
`;

const MUTATE = String.raw`
import json,subprocess,os,tempfile,shutil,hashlib,time,fcntl
config=p['config_path']; binary=p['binary_path']; service=p['service_name']; change=p['change']
lock=open(config+'.raygate.lock','a'); fcntl.flock(lock,fcntl.LOCK_EX)
raw=open(config,'rb').read()
if hashlib.sha256(raw).hexdigest()!=change['configHash']: raise RuntimeError('CONFIG_CONFLICT')
c=json.loads(raw)
if 'HandlerService' not in c.get('api',{}).get('services',[]): raise RuntimeError('HANDLER_SERVICE_REQUIRED')
address=c.get('api',{}).get('listen') or p['api_address']
def live_users():
    r=subprocess.run([binary,'api','inbounduser','--server='+address,'-tag='+change['tag']],text=True,capture_output=True,timeout=10)
    if r.returncode: raise RuntimeError('HANDLER_API_UNAVAILABLE')
    return json.loads(r.stdout).get('users',[])
def matching(u):
    a=u.get('account',{})
    return u.get('email')==change['email'] and a.get('id','').lower()==change['uuid'] and a.get('flow','')==change['flow'] and int(u.get('level',0))==int(change['level'])
before=live_users()
if any((u.get('email')==change['email'] or u.get('account',{}).get('id','').lower()==change['uuid']) and not matching(u) for u in before): raise RuntimeError('RUNTIME_IDENTITY_CONFLICT')
ib=next((v for i,v in enumerate(c['inbounds']) if (v.get('tag') or '#index:'+str(i))==change['tag']),None)
if not ib or ib.get('protocol')!='vless': raise RuntimeError('INBOUND_NOT_FOUND')
clients=ib['settings']['clients']
existing=next((v for v in clients if v.get('id','').lower()==change['uuid']),None)
if change['enabled']:
    if not existing:
        if any(v.get('email')==change['email'] for b in c['inbounds'] for v in b.get('settings',{}).get('clients',[])):
            raise RuntimeError('EMAIL_CONFLICT')
        clients.append({'id':change['uuid'],'email':change['email'],'level':change['level'],'flow':change['flow']})
elif existing:
    clients.remove(existing)
st=os.stat(config)
config_changed=c!=json.loads(raw)
backup=config+'.bak.'+time.strftime('%Y%m%d-%H%M%S')+'.'+change['operationKey'] if config_changed else None
if backup:
    shutil.copy2(config,backup); os.chown(backup,st.st_uid,st.st_gid)
fd,temp=tempfile.mkstemp(prefix='raygate.',suffix='.json',dir=os.path.dirname(config))
try:
    with os.fdopen(fd,'w') as f:
        json.dump(c,f,ensure_ascii=False,indent=2); f.flush(); os.fsync(f.fileno())
    os.chown(temp,st.st_uid,st.st_gid); os.chmod(temp,st.st_mode & 0o7777)
    user=subprocess.run(['systemctl','show',service,'-p','User','--value'],text=True,capture_output=True,check=True).stdout.strip()
    check_cmd=([ 'runuser','-u',user,'--'] if user and user!='root' else [])+[binary,'run','-test','-config',temp]
    check=subprocess.run(check_cmd,text=True,capture_output=True,timeout=20)
    if check.returncode: raise RuntimeError('CONFIG_VALIDATION_OR_PERMISSION_FAILED')
    if hashlib.sha256(open(config,'rb').read()).hexdigest()!=change['configHash']: raise RuntimeError('CONFIG_CONFLICT')
    if config_changed:
        os.replace(temp,config)
        directory=os.open(os.path.dirname(config),os.O_DIRECTORY)
        try: os.fsync(directory)
        finally: os.close(directory)
    present=any(matching(u) for u in before)
    if change['enabled'] and not present:
        user_inbound=json.loads(json.dumps(ib))
        user_inbound['settings']['clients']=[{'id':change['uuid'],'email':change['email'],'level':change['level'],'flow':change['flow']}]
        payload={'inbounds':[user_inbound]}
        subprocess.run([binary,'api','adu','--server='+address,'stdin:'],input=json.dumps(payload),text=True,capture_output=True,timeout=10)
    elif not change['enabled'] and present:
        subprocess.run([binary,'api','rmu','--server='+address,'-tag='+change['tag'],change['email']],text=True,capture_output=True,timeout=10)
    after=live_users()
    if bool(change['enabled'])!=any(matching(u) for u in after): raise RuntimeError('RUNTIME_CONFIRMATION_PENDING')
    print(json.dumps({'ok':True,'backup':backup}))
finally:
    if os.path.exists(temp): os.unlink(temp)
`;

export class ManagedSshProvider {
  constructor(instance) { this.instance = instance; }
  async execute(script, extra = {}) {
    const payload = Buffer.from(JSON.stringify({ ...this.instance, ...extra })).toString('base64');
    const code = `import base64,json\np=json.loads(base64.b64decode('${payload}'))\n${script}`;
    const encoded = Buffer.from(code).toString('base64');
    const i = this.instance;
    const { stdout } = await trustedSsh(i,keyStore.resolve(i.ssh_key_ref),
      `python3 -c "import base64;exec(base64.b64decode('${encoded}'))"`);
    return JSON.parse(stdout.trim());
  }
  collect() { return this.execute(COLLECT); }
  mutate(change) { return this.execute(MUTATE, { change }); }
}
