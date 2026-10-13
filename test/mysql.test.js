import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import mysql from 'mysql2/promise';
import { mkdtemp,readFile,rm,stat } from 'node:fs/promises';
import { createPool,migrate,root } from '../src/db.js';
import { createDatabaseServer } from '../src/database-server.js';

const exec=promisify(execFile);

test('MySQL persistence, collection, device operations and HTTP contracts', {skip:process.env.XRAY_MYSQL_TEST!=='1'},async t=>{
  const database=`raygate_test_${randomUUID().replaceAll('-','')}`;
  const admin=await mysql.createConnection({host:process.env.DB_HOST,port:Number(process.env.DB_PORT||3306),user:process.env.DB_USER,password:process.env.DB_PASSWORD});
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
  const original=process.env.DB_NAME;process.env.DB_NAME=database;
  const pool=createPool();
  const keyTestDir=await mkdtemp(path.join(root,'.test-vps-keys-'));
  const uploadKey=path.join(keyTestDir,'upload-source');
  await exec('ssh-keygen',['-q','-t','ed25519','-N','','-C','raygate-api-test','-f',uploadKey],{windowsHide:true});
  let app;
  try {
    // Start from the original schema to exercise an existing installation upgrade.
    const initialSql=await readFile(new URL('../sql/001_initial.sql',import.meta.url),'utf8');
    for(const statement of initialSql.split(';').map(s=>s.trim()).filter(Boolean)) await pool.query(statement);
    // Simulate a prior upgrade interrupted after adding its first column.
    await pool.query("ALTER TABLE vps_servers ADD COLUMN memory_mib INT UNSIGNED NULL DEFAULT NULL COMMENT '内存容量，MiB，NULL 表示未填写'");
    await migrate(pool);await migrate(pool);
    let frame={collectedAt:Date.now(),epoch:'epoch-one',apiAvailable:true,serviceState:'active',version:'Xray fixture',serviceStartedAt:'fixture',configHash:'a'.repeat(64),nodes:[
      {tag:'test-in',port:18443,protocol:'vless',network:'tcp',security:'reality',sni:'example.com',publicKey:'fixture',shortId:'abcd',clients:[
        {uuid:'11111111-1111-4111-8111-111111111111',email:'fixture-device',flow:'xtls-rprx-vision',level:0,trafficAvailable:true,onlineAvailable:true,sourceIps:['203.0.113.8'],uplinkBytes:'9007199254740995',downlinkBytes:'200'}]}]};
    let calls=0;
    const liveFrame = data => {const copy=structuredClone(data);for(const node of copy.nodes){node.supported=true;node.trafficConfigured=true;node.onlineConfigured=true;node.runtimeAvailable=true;node.runtimeUsers=structuredClone(node.clients);}return copy;};
    const fake={collect:async()=>{frame.collectedAt+=1000;return liveFrame(frame);},mutate:async change=>{
      calls++;const clients=frame.nodes[0].clients;
      if(change.enabled)clients.push({uuid:change.uuid,email:change.email,flow:change.flow,level:change.level,trafficAvailable:true,onlineAvailable:true,sourceIps:[],uplinkBytes:'0',downlinkBytes:'0'});
      else frame.nodes[0].clients=clients.filter(c=>c.uuid!==change.uuid);
      return {ok:true,backup:'fixture-backup'};
    }};
    const otherFrame=structuredClone(frame);otherFrame.nodes[0].clients=[];otherFrame.nodes[0].port=28443;
    const otherFake={collect:async()=>{otherFrame.collectedAt+=1000;return liveFrame(otherFrame);},mutate:async change=>{
      otherFrame.nodes[0].clients.push({uuid:change.uuid,email:change.email,flow:change.flow,level:change.level,trafficAvailable:true,onlineAvailable:true,sourceIps:[],uplinkBytes:'0',downlinkBytes:'0'});return {ok:true};
    }};
    let kiwiResult={usedGb:12.5,quotaGb:100,multiplier:1,resetAt:new Date('2030-01-01T00:00:00Z')},kiwiError=null,kiwiCredentials=null;
    const kiwiVmClientFactory=credentials=>({getServiceInfo:async()=>{kiwiCredentials=credentials;if(kiwiError)throw kiwiError;return kiwiResult;}});
    app=await createDatabaseServer({pool,authDisabled:true,startCollector:false,startProviderSync:false,migrateSshKeys:false,allowLegacySshKeyRef:true,
      sshKeyDirectory:path.join(keyTestDir,'managed'),providerSecretDirectory:path.join(keyTestDir,'provider-secrets'),kiwiVmClientFactory,
      providerFactory:i=>String(i.id)==='1'?fake:otherFake});
    await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${app.server.address().port}`;
    const request=async(path,method='GET',data,key)=>{const r=await fetch(base+path,{method,headers:{'content-type':'application/json',...(key?{'idempotency-key':key}:{})},...(data?{body:JSON.stringify(data)}:{})});return {status:r.status,body:await r.json()};};
    const waitJob=async id=>{for(let i=0;i<50;i++){const job=(await request(`/api/xray-jobs/${id}`)).body;if(job.status==='success')return job.result;if(job.status==='failed')throw new Error(job.error);await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('fixture job timeout');};
    await t.test('VPS resource columns default to unknown and preserve values across migration',async()=>{
      const [[before]]=await pool.query('SELECT * FROM vps_servers WHERE id=1');
      for(const field of ['memory_gb','system_disk_gb','traffic_quota_gb','provider_traffic_used_gb','provider_traffic_recorded_at','official_url','expires_on','ssh_key_original_name','ssh_key_fingerprint','ssh_host_key','ssh_checked_at','ssh_check_error']) assert.equal(before[field],null);
      assert.equal(before.ssh_check_status,'untested');
      assert.equal('memory_mib' in before,false);
      await pool.execute('UPDATE vps_servers SET memory_gb=?,system_disk_gb=?,traffic_quota_gb=?,official_url=? WHERE id=1',['2.50','40.50','1000.25','https://example.com/']);
      const [[saved]]=await pool.query('SELECT * FROM vps_servers WHERE id=1');
      await migrate(pool);
      const [[after]]=await pool.query('SELECT * FROM vps_servers WHERE id=1');
      assert.deepEqual(after,saved);
      assert.equal(after.memory_gb,'2.50');assert.equal(after.system_disk_gb,'40.50');assert.equal(after.traffic_quota_gb,'1000.25');
      assert.equal(after.ssh_key_ref,before.ssh_key_ref);
      await assert.rejects(pool.query('UPDATE vps_servers SET memory_gb=-1 WHERE id=1'));
      await assert.rejects(pool.query('UPDATE vps_servers SET system_disk_gb=-1 WHERE id=1'));
      await assert.rejects(pool.query('UPDATE vps_servers SET traffic_quota_gb=-1 WHERE id=1'));
    });
    await t.test('legacy memory converts to GB exactly once and conflicting values are preserved',async()=>{
      await pool.query('ALTER TABLE vps_servers ADD COLUMN memory_mib INT UNSIGNED NULL');
      await pool.query('UPDATE vps_servers SET memory_mib=2048 WHERE id=1');
      await assert.rejects(migrate(pool),/Conflicting memory/);
      const [[conflict]]=await pool.query('SELECT memory_gb,memory_mib FROM vps_servers WHERE id=1');
      assert.equal(conflict.memory_gb,'2.50');assert.equal(conflict.memory_mib,2048);
      await pool.query('UPDATE vps_servers SET memory_gb=NULL WHERE id=1');
      await migrate(pool);await migrate(pool);
      const [[converted]]=await pool.query('SELECT * FROM vps_servers WHERE id=1');
      assert.equal(converted.memory_gb,'2.15');assert.equal('memory_mib' in converted,false);
    });
    await t.test('baseline import and repeated migration preserve data',async()=>{
      await app.collector.refresh();const list=await request('/api/devices');assert.equal(list.body.total,1);
      assert.equal(list.body.items[0].traffic.totalBytes,'0');assert.equal(list.body.items[0].credentials[0].onlineIpCount,1);
      assert.equal(list.body.items[0].credentials[0].uuid,frame.nodes[0].clients[0].uuid);
      const [[clock]]=await pool.query('SELECT @@session.time_zone zone');assert.equal(clock.zone,'+00:00');
      const [[run]]=await pool.query('SELECT started_at,finished_at FROM collection_runs ORDER BY id DESC LIMIT 1');assert.ok(run.started_at<=run.finished_at);
    });
    await t.test('provider usage snapshot persists separately from Xray traffic',async()=>{
      const before=(await request('/api/servers/1')).body.server;
      assert.equal(before.providerTrafficUsedGb,null);
      const callsBefore=calls;
      const saved=await request('/api/servers/1/traffic-usage','PATCH',{usedGb:'111.88'});
      assert.equal(saved.status,200);assert.equal(saved.body.server.providerTrafficUsedGb,111.88);
      assert.equal(calls,callsBefore,'manual calibration must not mutate Xray');
      await migrate(pool);
      await app.collector.refresh();
      const detail=(await request('/api/servers/1')).body.server;
      const list=(await request('/api/servers')).body.items.find(s=>s.id==='1');
      assert.equal(detail.providerTrafficUsedGb,111.88);
      assert.equal(list.providerTrafficUsedGb,111.88);
      assert.match(detail.providerTrafficRecordedAt,/Z$/);
      assert.equal(detail.monthTrafficBytes,before.monthTrafficBytes);
      assert.equal(detail.trafficQuotaGb,before.trafficQuotaGb);
      await assert.rejects(pool.query('UPDATE vps_servers SET provider_traffic_used_gb=-1 WHERE id=1'));
      for(const usedGb of [null,true,{},[], '', ' ', '-1', '1.001', 'NaN', 'Infinity', '1e3', '1000000000000']) {
        assert.equal((await request('/api/servers/1/traffic-usage','PATCH',{usedGb})).status,400);
      }
      assert.equal((await request('/api/servers/1/traffic-usage','PATCH',{})).status,400);
      assert.equal((await request('/api/servers/999999/traffic-usage','PATCH',{usedGb:'1'})).status,404);
      const blocked=await fetch(base+'/api/servers/1/traffic-usage',{method:'PATCH',headers:{origin:'https://example.com','content-type':'application/json'},body:JSON.stringify({usedGb:'5'})});
      assert.equal(blocked.status,403);
      assert.equal((await request('/api/servers/1')).body.server.providerTrafficUsedGb,111.88);
      assert.equal((await request('/api/servers/1/traffic-usage','PATCH',{usedGb:'2000'})).status,200,'over-quota readings are valid');
      const reset=await request('/api/servers/1/traffic-usage','PATCH',{usedGb:0});
      assert.equal(reset.status,200);
      assert.equal((await request('/api/servers/1')).body.server.providerTrafficUsedGb,0);
      assert.equal(reset.body.server.monthTrafficBytes,before.monthTrafficBytes);
      assert.equal(reset.body.server.sshKeyRef,before.sshKeyRef);
      assert.equal(reset.body.server.sshCheckStatus,before.sshCheckStatus);
      await pool.query('UPDATE vps_servers SET traffic_quota_gb=NULL WHERE id=1');
      assert.equal((await request('/api/servers/1/traffic-usage','PATCH',{usedGb:'0.01'})).status,200,'a reading does not require a quota');
      await pool.execute('UPDATE vps_servers SET traffic_quota_gb=? WHERE id=1',[before.trafficQuotaGb]);
    });
    await t.test('KiwiVM credentials stay server-side and API usage can sync, fail, and be removed',async()=>{
      const key='abcdefghijklmnop';
      const configured=await request('/api/servers/1/kiwivm','PUT',{veid:'123456',apiKey:key});
      assert.equal(configured.status,200);
      assert.equal(configured.body.server.bandwidthProvider,'kiwivm');
      assert.equal(configured.body.server.kiwiVmVeid,'123456');
      assert.equal(configured.body.server.hasKiwiVmApiKey,true);
      assert.equal(configured.body.server.providerUsageSource,'kiwivm');
      assert.equal(configured.body.server.providerTrafficUsedGb,12.5);
      assert.equal(configured.body.server.trafficQuotaGb,100);
      assert.equal(configured.body.server.providerSyncStatus,'ok');
      assert.equal(JSON.stringify(configured.body).includes(key),false);
      assert.deepEqual(kiwiCredentials,{veid:'123456',apiKey:key});
      const [[stored]]=await pool.query('SELECT * FROM vps_servers WHERE id=1');
      assert.notEqual(stored.kiwivm_api_key_ref,key);
      assert.equal(path.isAbsolute(stored.kiwivm_api_key_ref),false);
      assert.equal((await readFile(path.resolve(root,stored.kiwivm_api_key_ref),'utf8')).trim(),key);

      kiwiResult={usedGb:14.25,quotaGb:100,multiplier:2,resetAt:new Date('2030-02-01T00:00:00Z')};
      const synced=await request('/api/servers/1/sync-bandwidth','POST',{});
      assert.equal(synced.status,200);assert.equal(synced.body.server.providerTrafficUsedGb,14.25);assert.equal(synced.body.server.providerTrafficMultiplier,2);

      const manual=await request('/api/servers/1/traffic-usage','PATCH',{usedGb:'15'});
      assert.equal(manual.body.server.providerUsageSource,'manual');
      assert.equal(manual.body.server.bandwidthProvider,'kiwivm','manual fallback must retain automatic configuration');
      assert.equal((await request('/api/servers/1/sync-bandwidth','POST',{})).body.server.providerUsageSource,'kiwivm');

      kiwiError=Object.assign(new Error('provider unavailable'),{publicMessage:'KiwiVM 暂时不可用',status:502});
      const failed=await request('/api/servers/1/sync-bandwidth','POST',{});
      assert.equal(failed.status,502);
      const preserved=(await request('/api/servers/1')).body.server;
      assert.equal(preserved.providerTrafficUsedGb,14.25);assert.equal(preserved.providerSyncStatus,'error');assert.match(preserved.providerSyncError,/暂时不可用/);
      kiwiError=null;

      assert.equal((await request('/api/servers/1/kiwivm','PUT',{veid:'bad',apiKey:key})).status,400);
      const blocked=await fetch(base+'/api/servers/1/sync-bandwidth',{method:'POST',headers:{origin:'https://example.com','content-type':'application/json'},body:'{}'});
      assert.equal(blocked.status,403);
      const removed=await request('/api/servers/1/kiwivm','DELETE',{});
      assert.equal(removed.status,200);assert.equal(removed.body.server.bandwidthProvider,'manual');assert.equal(removed.body.server.hasKiwiVmApiKey,false);
      await assert.rejects(stat(path.resolve(root,stored.kiwivm_api_key_ref)));
      assert.equal((await request('/api/servers/1/sync-bandwidth','POST',{})).status,409);
    });
    await t.test('two collectors and duplicate delivery do not double count',async()=>{
      frame.nodes[0].clients[0].uplinkBytes='9007199254741002';frame.nodes[0].clients[0].downlinkBytes='205';
      await Promise.all([app.collector.refresh(),app.collector.refresh()]);
      const [[runtime]]=await pool.query('SELECT * FROM credential_runtime LIMIT 1');assert.equal(runtime.total_uplink_bytes,'7');assert.equal(runtime.total_downlink_bytes,'5');
      const [instances]=await Promise.all([app.repo.instances()]);
      assert.equal(await app.repo.saveSnapshot(instances[0],runtime.last_run_id,frame),false);
    });
    await t.test('restart retains saved totals and counts new epoch',async()=>{
      frame.epoch='epoch-two';frame.nodes[0].clients[0].uplinkBytes='3';frame.nodes[0].clients[0].downlinkBytes='9';await app.collector.refresh();
      const [c]=await app.repo.credentials();assert.equal(c.traffic.uplinkBytes,'10');assert.equal(c.traffic.downlinkBytes,'14');
      const history=await request(`/api/credentials/${c.id}/traffic?groupBy=month`);assert.equal(history.body.rangeTotals.totalBytes,'24');assert.equal(history.body.hasGap,true);
    });
    await t.test('partial API failure cannot write fake zero counters',async()=>{
      frame.apiAvailable=false;frame.nodes[0].clients[0].trafficAvailable=false;frame.nodes[0].clients[0].onlineAvailable=false;
      await app.collector.refresh();const [c]=await app.repo.credentials();assert.equal(c.status,'unknown');assert.equal(c.traffic.totalBytes,'24');
      frame.apiAvailable=true;frame.nodes[0].clients[0].trafficAvailable=true;frame.nodes[0].clients[0].onlineAvailable=true;
      await app.collector.refresh();
    });
    await t.test('create request is idempotent, and worker confirms before success',async()=>{
      const [node]=await app.repo.nodes(),key=randomUUID(),payload={name:'fixture second',note:'test',nodeId:node.id};
      const a=await request('/api/devices','POST',payload,key),b=await request('/api/devices','POST',payload,key);
      assert.equal(a.status,202,JSON.stringify(a.body));assert.equal(a.body.operationId,b.body.operationId);
      assert.equal((await app.repo.operation(a.body.operationId)).status,'pending');
      await app.collector.refresh();assert.equal((await app.repo.operation(a.body.operationId)).status,'success');assert.equal(calls,1);
      const [cred]=await app.repo.credentials({deviceId:'2'});
      const detail=await request(`/api/credentials/${cred.id}`);assert.ok(detail.body.vlessUri.includes(cred.uuid));
      const qr=await fetch(base+`/api/credentials/${cred.id}/qrcode`);assert.equal(qr.status,200);assert.match(await qr.text(),/<svg/);
      const off=await request(`/api/credentials/${cred.id}/enabled`,'PATCH',{enabled:false},randomUUID());await app.collector.refresh();
      assert.equal((await app.repo.operation(off.body.operationId)).status,'success');
      const [disabled]=await app.repo.credentials({credentialId:cred.id});assert.equal(disabled.status,'disabled');
    });
    await t.test('lost SSH reply is reconciled without repeating a successful mutation',async()=>{
      const [cred]=await app.repo.credentials({deviceId:'2'});
      const originalMutate=fake.mutate;
      fake.mutate=async change=>{await originalMutate(change);throw Object.assign(new Error('lost reply'),{code:255});};
      const op=await app.repo.queueEnabled(cred.id,true,randomUUID());
      await app.collector.refresh();
      assert.equal((await app.repo.operation(op)).status,'uncertain');
      const [waiting]=await app.repo.credentials({credentialId:cred.id});
      assert.equal(waiting.enabled,false);assert.equal(waiting.syncStatus,'uncertain');
      await assert.rejects(app.repo.queueEnabled(cred.id,false,randomUUID()),/已有操作/);
      const before=calls;fake.mutate=originalMutate;
      await app.collector.refresh();
      assert.equal((await app.repo.operation(op)).status,'success');assert.equal(calls,before);
      assert.equal((await app.repo.credentials({credentialId:cred.id}))[0].enabled,true);
    });
    await t.test('persisted config alone cannot confirm a runtime change',async()=>{
      const [cred]=await app.repo.credentials({deviceId:'2'});
      const originalCollect=fake.collect,originalMutate=fake.mutate;
      const live=structuredClone(frame.nodes[0].clients);
      fake.collect=async()=>{const s=await originalCollect();s.nodes[0].runtimeUsers=live;return s;};
      fake.mutate=async change=>{await originalMutate(change);throw Object.assign(new Error('API connection lost'),{code:255});};
      const op=await app.repo.queueEnabled(cred.id,false,randomUUID());
      await app.collector.refresh();await app.collector.refresh();
      assert.equal((await app.repo.operation(op)).status,'uncertain');
      assert.equal((await app.repo.credentials({credentialId:cred.id}))[0].enabled,true);
      fake.collect=originalCollect;fake.mutate=originalMutate;
      await app.collector.refresh();assert.equal((await app.repo.operation(op)).status,'success');
      assert.equal((await app.repo.credentials({credentialId:cred.id}))[0].enabled,false);
    });
    await t.test('failed sample transaction rolls back samples and totals',async()=>{
      const [instance]=await app.repo.instances();const [r]=await pool.execute('INSERT INTO collection_runs(instance_id) VALUES (?)',[instance.id]);
      const broken=structuredClone(frame);broken.collectedAt+=1000;broken.nodes[0].clients[0].uplinkBytes='invalid';
      await assert.rejects(app.repo.saveSnapshot(instance,r.insertId,broken));
      const [[count]]=await pool.execute('SELECT COUNT(*) n FROM traffic_samples WHERE run_id=?',[r.insertId]);assert.equal(Number(count.n),0);
      const [c]=await app.repo.credentials({deviceId:'1'});assert.equal(c.traffic.totalBytes,'24');
    });
    await t.test('large history survives cleanup and changing metadata',async()=>{
      const [c]=await app.repo.credentials({deviceId:'1'});
      await request(`/api/devices/${c.deviceId}`,'PATCH',{name:'renamed fixture',note:'metadata only'});
      await app.repo.cleanup();const [after]=await app.repo.credentials({deviceId:'1'});assert.equal(after.uuid,c.uuid);assert.equal(after.traffic.totalBytes,c.traffic.totalBytes);
    });
    await t.test('multipart VPS create validates and stores an uploaded private key',async()=>{
      const form=new FormData();
      for(const [key,value] of Object.entries({name:'uploaded fixture',sshHost:'198.51.100.45',sshPort:'2222',sshUser:'root',memoryGb:'8',systemDiskGb:'80',trafficQuotaGb:'2000',expiresOn:'2031-01-02',officialUrl:'https://example.com/account'})) form.set(key,value);
      form.set('sshKey',new Blob([await readFile(uploadKey)]),'fixture_ed25519');
      const response=await fetch(base+'/api/servers',{method:'POST',body:form});const payload=await response.json();
      assert.equal(response.status,201);assert.equal(payload.server.sshKeyOriginalName,'fixture_ed25519');assert.match(payload.server.sshKeyFingerprint,/^SHA256:/);
      assert.equal(path.isAbsolute(payload.server.sshKeyRef),false);assert.equal((await stat(path.resolve(root,payload.server.sshKeyRef))).size>0,true);
    });
    await t.test('same device on two VPS has distinct UUIDs and aggregated history',async()=>{
      const addedServer=await request('/api/servers','POST',{name:'second fixture',sshHost:'198.51.100.44',sshPort:22,sshUser:'test',sshKeyRef:'test-only',memoryGb:4,systemDiskGb:60,trafficQuotaGb:1000,expiresOn:'2030-01-01',officialUrl:'https://example.com/vps'});
      assert.equal(addedServer.status,201);
      assert.equal(addedServer.body.server.memoryGb,4);assert.equal(addedServer.body.server.systemDiskGb,60);assert.equal(addedServer.body.server.trafficQuotaGb,1000);
      await pool.execute("UPDATE vps_servers SET ssh_check_status='online',ssh_host_key='[198.51.100.44]:22 ssh-ed25519 AAAATEST' WHERE id=?",[addedServer.body.id]);
      const instanceJob=await request('/api/instances','POST',{serverId:addedServer.body.id,serviceName:'fixture.service',configPath:'/fixture.json',binaryPath:'/usr/local/bin/xray',apiAddress:'127.0.0.1:11000'});
      assert.equal(instanceJob.status,202);const connected=await waitJob(instanceJob.body.operationId);assert.equal(connected.existing,false);
      const instance={body:{id:connected.instanceId}};
      const nodes=await request(`/api/nodes?serverId=${addedServer.body.id}`);assert.equal(nodes.body.items.length,1);
      assert.equal(nodes.body.items[0].allowWrite,false,'new services are read-only');
      assert.equal((await request(`/api/instances/${instance.body.id}`,'PATCH',{allowWrite:true})).status,200);
      const added=await request('/api/devices','POST',{deviceId:'1',name:'existing device',nodeId:nodes.body.items[0].id},randomUUID());
      await app.collector.refresh(instance.body.id);assert.equal((await app.repo.operation(added.body.operationId)).status,'success');
      const cs=await app.repo.credentials({deviceId:'1'});assert.equal(cs.length,2);assert.notEqual(cs[0].uuid,cs[1].uuid);
      otherFrame.nodes[0].clients[0].uplinkBytes='11';otherFrame.nodes[0].clients[0].downlinkBytes='13';await app.collector.refresh(instance.body.id);
      const history=await request('/api/devices/1/traffic');assert.equal(history.body.totals.totalBytes,'48');
      const filtered=await request(`/api/devices?serverId=${addedServer.body.id}`);assert.equal(filtered.body.total,1);assert.equal(filtered.body.items[0].credentials.length,1);
    });
  } finally {
    if(app)await app.close();else await pool.end();
    process.env.DB_NAME=original;
    // Only this test-created schema is eligible for deletion; never the configured production DB.
    assert.match(database,/^raygate_test_[0-9a-f]{32}$/);
    await admin.query(`DROP DATABASE \`${database}\``);await admin.end();await rm(keyTestDir,{recursive:true,force:true});
  }
});
