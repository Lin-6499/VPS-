import test from 'node:test';
import assert from 'node:assert/strict';
import { nodeDiagnosis, snapshotDiagnosis, nodeAccess } from '../src/node-capabilities.js';

const baseNode={tag:'vless-in',port:443,protocol:'vless',network:'tcp',security:'reality',sni:'example.com',publicKey:'key',runtimeAvailable:true,
  clients:[{email:'device-a',trafficAvailable:true,onlineAvailable:true}]};
const baseSnapshot={serviceState:'active',apiAvailable:true,version:'Xray fixture',nodes:[baseNode]};

test('device management requires traffic, online and dynamic user capabilities',()=>{
  const complete=nodeDiagnosis(baseNode,baseSnapshot);
  assert.equal(complete.readyForDeviceManagement,true);
  const withoutStats=snapshotDiagnosis({...baseSnapshot,apiAvailable:false,nodes:[{...baseNode,trafficConfigured:false,onlineConfigured:false}]});
  assert.equal(withoutStats.management,false);
  assert.match(withoutStats.nodes[0].reasons.join(' '),/流量统计不可用/);
});

test('QR remains available for a supported read-only node while mutations are blocked',()=>{
  const diagnostics=nodeDiagnosis(baseNode,baseSnapshot),row={diagnostics,diagnosed_at:new Date().toISOString(),observed_state:'present',service_state:'active',instance_enabled:1,server_enabled:1,allow_write:0};
  const access=nodeAccess(row);
  assert.equal(access.canQr,true);
  assert.equal(access.canManage,false);
  assert.equal(access.reason,'服务为只读');
});
