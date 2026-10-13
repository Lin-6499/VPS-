import test from 'node:test';
import assert from 'node:assert/strict';
import { KiwiVmClient, normalizeKiwiVmCredentials, normalizeServiceInfo } from '../src/kiwivm-client.js';

test('KiwiVM credentials are validated without exposing the key', () => {
  assert.deepEqual(normalizeKiwiVmCredentials({veid:' 12345 ',apiKey:'abcdefghijklmnop'}),{veid:'12345',apiKey:'abcdefghijklmnop'});
  for (const value of ['', 'abc', '1.2', '-1']) assert.throws(() => normalizeKiwiVmCredentials({veid:value,apiKey:'abcdefghijklmnop'}));
  for (const value of ['', 'short', 'contains space 123456']) assert.throws(() => normalizeKiwiVmCredentials({veid:'123',apiKey:value}));
});

test('KiwiVM service info applies traffic multiplier only to used bandwidth', () => {
  const info=normalizeServiceInfo({error:0,data_counter:1073741824,plan_monthly_data:107374182400,monthly_data_multiplier:2,data_next_reset:1893456000});
  assert.equal(info.usedGb,2);
  assert.equal(info.quotaGb,100);
  assert.equal(info.multiplier,2);
  assert.equal(info.resetAt.toISOString(),'2030-01-01T00:00:00.000Z');
});

test('KiwiVM client sends credentials to the official endpoint and normalizes response', async () => {
  let requested;
  const client=new KiwiVmClient({veid:'42',apiKey:'abcdefghijklmnop'},{fetchImpl:async(url,options)=>{
    requested={url:new URL(url),options};
    return new Response(JSON.stringify({error:0,data_counter:536870912,plan_monthly_data:10737418240,data_next_reset:0}),{status:200});
  }});
  const result=await client.getServiceInfo();
  assert.equal(requested.url.origin,'https://api.64clouds.com');
  assert.equal(requested.url.pathname,'/v1/getServiceInfo');
  assert.equal(requested.url.searchParams.get('veid'),'42');
  assert.equal(requested.url.searchParams.get('api_key'),'abcdefghijklmnop');
  assert.equal(requested.options.redirect,'error');
  assert.deepEqual(result,{usedGb:0.5,quotaGb:10,multiplier:1,resetAt:null});
});

test('KiwiVM client converts provider and malformed responses into public errors', async () => {
  const denied=new KiwiVmClient({veid:'42',apiKey:'abcdefghijklmnop'},{fetchImpl:async()=>new Response(JSON.stringify({error:1,message:'invalid credentials'}),{status:200})});
  await assert.rejects(denied.getServiceInfo(),error=>error.status===502&&/invalid credentials/.test(error.publicMessage));
  assert.throws(()=>normalizeServiceInfo({error:0,data_counter:-1,plan_monthly_data:10}),error=>error.status===502);
});
