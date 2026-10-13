import test from 'node:test';
import assert from 'node:assert/strict';
import { counterDelta,splitDays,totals } from '../src/traffic.js';

test('first observation is a baseline; cumulative history excludes traffic before enrollment',()=>{
  assert.deepEqual(counterDelta(null,{uplinkBytes:'9007199254740995',downlinkBytes:'200'},'a'),{up:0n,down:0n,quality:'baseline'});
});
test('integer increments remain exact beyond Number.MAX_SAFE_INTEGER',()=>{
  const prev={counter_sampled_at:'2026-10-10 00:00:00.000',epoch_id:'a',last_uplink_bytes:'9007199254740995',last_downlink_bytes:'100'};
  const result=counterDelta(prev,{uplinkBytes:'9007199254741002',downlinkBytes:'105'},'a');
  assert.equal(result.up,7n);assert.equal(result.down,5n);
  assert.equal(totals('9007199254740995','10').totalBytes,'9007199254741005');
});
test('new service epoch and a counter rollback both preserve newly observed bytes',()=>{
  const prev={counter_sampled_at:'2026-10-10 00:00:00.000',epoch_id:'a',last_uplink_bytes:'100',last_downlink_bytes:'200'};
  assert.deepEqual(counterDelta(prev,{uplinkBytes:'5',downlinkBytes:'7'},'b'),{up:5n,down:7n,quality:'reset'});
  assert.equal(counterDelta(prev,{uplinkBytes:'5',downlinkBytes:'7'},'a').quality,'reset');
});
test('Beijing midnight allocation preserves every byte including integer remainder',()=>{
  const parts=splitDays('2026-10-09T15:59:30Z','2026-10-09T16:00:30Z',101n,3n);
  assert.deepEqual(parts,[{date:'2026-10-09',up:50n,down:1n},{date:'2026-10-10',up:51n,down:2n}]);
  assert.throws(()=>splitDays('2026-10-10','2026-10-09',1n,1n));
});
