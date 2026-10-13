import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUsedGb } from '../src/provider-usage.js';

test('manual usage accepts zero and exact decimal GB within database precision', () => {
  for (const value of [0, '0.00', '111.88', '999999999999.99', ' 10.50 ']) {
    assert.equal(normalizeUsedGb(value), String(value).trim());
  }
});

test('manual usage rejects malformed, negative and imprecise values', () => {
  for (const value of [undefined, null, true, [], {}, '', ' ', -1, NaN, Infinity, '1e3', '1.001', '1000000000000', '1;UPDATE vps_servers']) {
    assert.throws(() => normalizeUsedGb(value), error => error.status === 400 && Boolean(error.publicMessage));
  }
});
