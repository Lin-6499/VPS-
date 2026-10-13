import { httpError } from './db.js';

export function normalizeUsedGb(value) {
  if (typeof value !== 'string' && typeof value !== 'number') throw httpError('请填写已用流量（GB）');
  const text = String(value).trim();
  if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(text)) {
    throw httpError('已用流量须为 0–999999999999.99 GB 的数字，最多两位小数');
  }
  return text;
}
