import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const SNAPSHOT_SCRIPT = String.raw`
import json, subprocess, re, time
CONFIG='/usr/local/etc/xray/config-test-device.json'
XRAY='/usr/local/bin/xray'
SERVICE='xray-test-device.service'

def run(args):
    return subprocess.run(args, text=True, capture_output=True, timeout=15)

def api_json(args):
    p=run([XRAY,'api']+args)
    if p.returncode != 0:
        return {}
    try: return json.loads(p.stdout)
    except: return {}

c=json.load(open(CONFIG))
ib=c['inbounds'][0]
stream=ib.get('streamSettings',{})
reality=stream.get('realitySettings',{})
api=c.get('api',{})
listen=api.get('listen','127.0.0.1:10086')
private=reality.get('privateKey','')
derived=run([XRAY,'x25519','-i',private]).stdout if private else ''
match=re.search(r'Password \(PublicKey\):\s*(\S+)', derived)
public=match.group(1) if match else ''
version=run([XRAY,'version']).stdout.splitlines()[0]
active=run(['systemctl','is-active',SERVICE]).stdout.strip()
started=run(['systemctl','show',SERVICE,'-p','ActiveEnterTimestamp','--value']).stdout.strip()
devices=[]
for client in ib.get('settings',{}).get('clients',[]):
    email=client.get('email') or ('uuid-'+client.get('id','')[:8])
    stats=api_json(['statsquery','--server='+listen,'-pattern','user>>>'+email+'>>>traffic','-reset=false']).get('stat',[])
    values={s.get('name','').split('>>>')[-1]:int(s.get('value',0)) for s in stats}
    online=api_json(['statsonline','--server='+listen,'-email',email]).get('stat',{}).get('value',0)
    ipdata=api_json(['statsonlineiplist','--server='+listen,'-email',email]).get('ips',{}) if online else {}
    devices.append({
      'uuid':client.get('id'),'email':email,'level':client.get('level',0),'flow':client.get('flow',''),
      'enabled':True,'status':'online' if online else 'offline','sessions':int(online or 0),
      'sourceIps':list(ipdata.keys()),'lastActive':max(ipdata.values()) if ipdata else None,
      'uplinkBytes':values.get('uplink',0),'downlinkBytes':values.get('downlink',0)
    })
print(json.dumps({
  'provider':'ssh-xray','host':'144.34.147.212','service':SERVICE,'serviceState':active,'serviceStartedAt':started,
  'version':version,'api':{'listen':listen,'services':api.get('services',[]),'available':active=='active'},
  'inbound':{'tag':ib.get('tag'),'port':ib.get('port'),'protocol':ib.get('protocol'),'network':stream.get('network'),'security':stream.get('security'),
    'sni':(reality.get('serverNames') or [''])[0],'shortId':(reality.get('shortIds') or [''])[0],'publicKey':public},
  'devices':devices,'collectedAt':int(time.time())
}, ensure_ascii=False))
`;

function mutationScript({ uuid, email, enabled }) {
  const payload = Buffer.from(JSON.stringify({ uuid, email, enabled })).toString('base64');
  return String.raw`
import json, base64, tempfile, os, shutil, subprocess, time
CONFIG='/usr/local/etc/xray/config-test-device.json'
XRAY='/usr/local/bin/xray'
SERVICE='xray-test-device.service'
p=json.loads(base64.b64decode('${payload}'))
c=json.load(open(CONFIG))
clients=c['inbounds'][0]['settings']['clients']
existing=next((x for x in clients if x.get('id')==p['uuid'] or x.get('email')==p['email']),None)
if p['enabled']:
    if not existing:
        flow=(clients[0].get('flow','xtls-rprx-vision') if clients else 'xtls-rprx-vision')
        clients.append({'id':p['uuid'],'email':p['email'],'flow':flow,'level':0})
else:
    clients[:]=[x for x in clients if x.get('id')!=p['uuid']]
backup=CONFIG+'.bak.'+time.strftime('%Y%m%d-%H%M%S')
source_stat=os.stat(CONFIG)
shutil.copy2(CONFIG,backup)
fd,temp=tempfile.mkstemp(prefix='config-test-device.',suffix='.json',dir=os.path.dirname(CONFIG))
try:
    with os.fdopen(fd,'w') as f: json.dump(c,f,ensure_ascii=False,indent=2)
    os.chmod(temp, source_stat.st_mode & 0o7777)
    os.chown(temp, source_stat.st_uid, source_stat.st_gid)
    check=subprocess.run([XRAY,'run','-test','-config',temp],text=True,capture_output=True,timeout=20)
    if check.returncode!=0: raise RuntimeError('Xray config validation failed: '+check.stderr[-500:])
    os.replace(temp,CONFIG)
    restart=subprocess.run(['systemctl','restart',SERVICE],text=True,capture_output=True,timeout=25)
    active=subprocess.run(['systemctl','is-active',SERVICE],text=True,capture_output=True,timeout=10).stdout.strip()
    if restart.returncode!=0 or active!='active':
        shutil.copy2(backup,CONFIG); subprocess.run(['systemctl','restart',SERVICE],timeout=25)
        raise RuntimeError('test service restart failed; configuration rolled back')
    print(json.dumps({'ok':True,'backup':backup,'serviceState':active}))
finally:
    if os.path.exists(temp): os.unlink(temp)
`;
}

function gb(bytes) {
  return Number((Number(bytes || 0) / 1024 / 1024 / 1024).toFixed(4));
}

export class SshXrayProvider {
  constructor(options = {}) {
    this.host = options.host || process.env.XRAY_SSH_HOST || '144.34.147.212';
    this.user = options.user || process.env.XRAY_SSH_USER || 'root';
    this.keyPath = options.keyPath || process.env.XRAY_SSH_KEY || path.join(os.homedir(), '.ssh', 'bandwagon_ed25519');
    this.cacheMs = Number(options.cacheMs ?? 4000);
    this.cache = null;
    this.inflight = null;
  }

  async remotePython(script) {
    const encoded = Buffer.from(script).toString('base64');
    const command = `python3 -c "import base64;exec(base64.b64decode('${encoded}'))"`;
    const { stdout } = await execFileAsync('ssh', [
      '-i', this.keyPath, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
      `${this.user}@${this.host}`, command
    ], { timeout: 45_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
    return JSON.parse(stdout.trim());
  }

  async snapshot({ fresh = false } = {}) {
    if (!fresh && this.cache && Date.now() - this.cache.at < this.cacheMs) return this.cache.value;
    if (this.inflight) return this.inflight;
    this.inflight = this.remotePython(SNAPSHOT_SCRIPT).then(raw => {
      const value = {
        ...raw,
        host: this.host,
        devices: raw.devices.map(device => ({
          ...device,
          lastActive: device.lastActive ? new Date(device.lastActive * 1000).toISOString() : null,
          traffic: { up: gb(device.uplinkBytes), down: gb(device.downlinkBytes), total: gb(device.uplinkBytes + device.downlinkBytes) }
        }))
      };
      this.cache = { at: Date.now(), value };
      return value;
    }).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async createDevice() {
    const uuid = randomUUID();
    const email = `device-${uuid.slice(0, 8)}`;
    await this.remotePython(mutationScript({ uuid, email, enabled: true }));
    this.cache = null;
    return { uuid, email };
  }

  async setEnabled(device, enabled) {
    await this.remotePython(mutationScript({ uuid: device.uuid, email: device.email, enabled }));
    this.cache = null;
    return { uuid: device.uuid, enabled };
  }
}

export function createVlessUri(snapshot, device) {
  const inbound = snapshot.inbound;
  const label = encodeURIComponent(`${device.name || device.email} · ${snapshot.host}`);
  const params = new URLSearchParams({
    encryption: 'none', flow: device.flow ?? '', security: inbound.security,
    sni: inbound.sni, fp: 'chrome', pbk: inbound.publicKey, sid: inbound.shortId,
    type: inbound.network || 'tcp', headerType: 'none'
  });
  return `vless://${device.uuid}@${snapshot.host}:${inbound.port}?${params}#${label}`;
}
