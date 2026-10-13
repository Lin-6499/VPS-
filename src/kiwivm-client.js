import { httpError } from './db.js';

const API_BASE = 'https://api.64clouds.com/v1/getServiceInfo';
const GIB = 1073741824;

export function normalizeKiwiVmCredentials({ veid, apiKey }) {
  const normalizedVeid = String(veid || '').trim();
  if (!/^\d{1,20}$/.test(normalizedVeid)) throw httpError('VEID 必须是 1–20 位数字');
  if (typeof apiKey !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(apiKey.trim())) throw httpError('KiwiVM API Key 格式无效');
  return { veid: normalizedVeid, apiKey: apiKey.trim() };
}

export function normalizeServiceInfo(data) {
  if (!data || typeof data !== 'object') throw httpError('KiwiVM 返回格式无效', 502);
  if (Number(data.error) !== 0) throw httpError(`KiwiVM 拒绝请求：${String(data.message || '请核对 VEID 和 API Key').slice(0, 180)}`, 502);
  const usedBytes = Number(data.data_counter), quotaBytes = Number(data.plan_monthly_data);
  const multiplier = data.monthly_data_multiplier == null ? 1 : Number(data.monthly_data_multiplier);
  const resetSeconds = Number(data.data_next_reset || 0);
  if (![usedBytes, quotaBytes, multiplier].every(Number.isFinite) || usedBytes < 0 || quotaBytes < 0 || multiplier <= 0) throw httpError('KiwiVM 流量字段无效', 502);
  const usedGb = Math.round(usedBytes * multiplier / GIB * 100) / 100;
  // KiwiVM's multiplier applies to metered usage, not to the plan allowance.
  const quotaGb = Math.round(quotaBytes / GIB * 100) / 100;
  const resetAt = Number.isFinite(resetSeconds) && resetSeconds > 0 ? new Date(resetSeconds * 1000) : null;
  if (resetAt && Number.isNaN(resetAt.getTime())) throw httpError('KiwiVM 重置时间无效', 502);
  return { usedGb, quotaGb, multiplier, resetAt };
}

export class KiwiVmClient {
  constructor(credentials, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
    this.credentials = normalizeKiwiVmCredentials(credentials);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }
  async getServiceInfo() {
    const url = new URL(API_BASE);
    url.searchParams.set('veid', this.credentials.veid);
    url.searchParams.set('api_key', this.credentials.apiKey);
    let response;
    try {
      response = await this.fetchImpl(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs), headers: { accept: 'application/json' } });
    } catch (error) {
      throw httpError(error?.name === 'TimeoutError' ? 'KiwiVM 请求超时，请稍后重试' : '无法连接 KiwiVM API，请检查本机网络', 502);
    }
    if (!response.ok) throw httpError(`KiwiVM API 返回 HTTP ${response.status}`, 502);
    const text = await response.text();
    if (text.length > 256 * 1024) throw httpError('KiwiVM 响应过大，已拒绝处理', 502);
    let data;
    try { data = JSON.parse(text); } catch { throw httpError('KiwiVM 返回的不是有效 JSON', 502); }
    return normalizeServiceInfo(data);
  }
}
