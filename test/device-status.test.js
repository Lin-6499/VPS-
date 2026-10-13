import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('pending and uncertain show progress without prematurely changing switch state',async()=>{
  const source=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/^import .*\r?\n+/,'').split('async function loadDashboard()')[0];
  for(const [syncStatus,label] of [['pending','处理中'],['uncertain','正在核实']]) {
    for(const enabled of [true,false]) {
      const rows={innerHTML:'',closest:()=>({hidden:false})};
      const elements={'#deviceRows':rows,'#emptyState':{},'#resultCount':{}};
      const context=vm.createContext({URLSearchParams,location:{search:''},document:{querySelector:s=>elements[s]},fixture:{credentialId:'1',name:'fixture',uuid:'11111111-1111-4111-8111-111111111111',kind:'desktop',status:'offline',sourceIps:[],todayTraffic:{totalBytes:'1000000000'},enabled,syncStatus,lastActive:null}});
      vm.runInContext(source+'\nstate.devices=[fixture];renderRows();',context);
      assert.ok(rows.innerHTML.includes(label));
      assert.ok(rows.innerHTML.includes(`aria-checked="${enabled}"`));
      assert.match(rows.innerHTML,/role="switch"[^>]*disabled/);
      assert.ok(rows.innerHTML.includes('1.000 GB'));
    }
  }
});
