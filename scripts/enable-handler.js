// Explicit one-time setup; never called by normal device operations.
import { createPool, safeError } from '../src/db.js';
import { Repository } from '../src/repository.js';
import { ManagedSshProvider } from '../src/managed-ssh.js';
if (!process.argv.includes('--confirm-test-service-restart')) throw new Error('Explicit restart confirmation required');
const pool=createPool();
try {
  const instance=(await new Repository(pool).instances()).find(i=>i.service_name==='xray-test-device.service');
  if (!instance || instance.config_path!=='/usr/local/etc/xray/config-test-device.json') throw new Error('Unexpected target');
  console.log(await new ManagedSshProvider(instance).execute(String.raw`
import json,os,subprocess,tempfile,shutil,time,fcntl
config=p['config_path']; service=p['service_name']; binary=p['binary_path']
lock=open(config+'.raygate.lock','a'); fcntl.flock(lock,fcntl.LOCK_EX)
c=json.load(open(config)); services=c['api']['services']
if 'HandlerService' in services:
    print(json.dumps({'alreadyConfigured':True})); raise SystemExit(0)
services.append('HandlerService')
st=os.stat(config); backup=config+'.bak.handler.'+time.strftime('%Y%m%d-%H%M%S')
shutil.copy2(config,backup); os.chown(backup,st.st_uid,st.st_gid)
fd,temp=tempfile.mkstemp(dir=os.path.dirname(config),prefix='handler.',suffix='.json')
try:
    with os.fdopen(fd,'w') as f:
        json.dump(c,f,indent=2); f.flush(); os.fsync(f.fileno())
    os.chown(temp,st.st_uid,st.st_gid); os.chmod(temp,st.st_mode & 0o7777)
    user=subprocess.run(['systemctl','show',service,'-p','User','--value'],text=True,capture_output=True,check=True).stdout.strip()
    check=subprocess.run((['runuser','-u',user,'--'] if user and user!='root' else [])+[binary,'run','-test','-config',temp],capture_output=True,timeout=20)
    if check.returncode: raise RuntimeError('CONFIG_VALIDATION_OR_PERMISSION_FAILED')
    os.replace(temp,config)
    subprocess.run(['systemctl','restart',service],check=True,capture_output=True,timeout=25)
    print(json.dumps({'initialized':True,'backup':backup,'service':service}))
finally:
    if os.path.exists(temp): os.unlink(temp)
`));
} catch(error) { console.error(safeError(error)); process.exitCode=1; }
finally { await pool.end(); }
