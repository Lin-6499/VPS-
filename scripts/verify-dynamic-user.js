// Opt-in live verification: temporary unused credential only; original clients are untouched.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool,safeError } from '../src/db.js';
import { Repository } from '../src/repository.js';
import { ManagedSshProvider } from '../src/managed-ssh.js';
if (!process.argv.includes('--test-service-only')) throw new Error('Explicit live-test flag required');
const pool=createPool();
try {
  const instance=(await new Repository(pool).instances()).find(i=>i.service_name==='xray-test-device.service');
  assert.ok(instance?.allow_write);
  const provider=new ManagedSshProvider(instance),initial=await provider.collect();
  const node=initial.nodes.find(n=>n.tag==='test-device-in');assert.ok(node?.runtimeAvailable);
  const uuid=randomUUID(),change={uuid,email:`raygate-check-${uuid}`,tag:node.tag,flow:'xtls-rprx-vision',level:0,operationKey:randomUUID()};
  const start=Date.now();
  try {
    await provider.mutate({...change,enabled:true,configHash:initial.configHash});
    const enabled=await provider.collect();assert.equal(enabled.epoch,initial.epoch);
    const actual=enabled.nodes.find(n=>n.tag===node.tag);
    assert.ok(actual.clients.some(c=>c.uuid===uuid));assert.ok(actual.runtimeUsers.some(c=>c.uuid===uuid));
    console.log('Dynamic add: config and runtime verified; service epoch unchanged.');
  } finally {
    const before=await provider.collect();
    await provider.mutate({...change,enabled:false,configHash:before.configHash,operationKey:randomUUID()});
  }
  const final=await provider.collect();assert.equal(final.epoch,initial.epoch);
  const endNode=final.nodes.find(n=>n.tag===node.tag);
  assert.deepEqual(endNode.clients.map(c=>c.uuid).sort(),node.clients.map(c=>c.uuid).sort());
  assert.deepEqual(endNode.runtimeUsers.map(c=>c.uuid).sort(),node.runtimeUsers.map(c=>c.uuid).sort());
  console.log(JSON.stringify({passed:true,serviceRestarted:false,originalUsersPreserved:true,elapsedSeconds:(Date.now()-start)/1000}));
} catch(error) { console.error(error instanceof assert.AssertionError ? error.message : safeError(error));process.exitCode=1; }
finally {await pool.end();}
