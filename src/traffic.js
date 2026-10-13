const DAY = 86400000;
const OFFSET = 8 * 3600000;
export const sqlDate = value => new Date(value).toISOString().slice(0, 23).replace('T', ' ');
export const parseDate = value => value ? new Date(String(value).includes('T') ? value : `${value.replace(' ', 'T')}Z`) : null;
export const dayKey = value => new Date(new Date(value).getTime() + OFFSET).toISOString().slice(0, 10);
export function totals(up, down) {
  const u = BigInt(up || 0), d = BigInt(down || 0);
  return { up: Number(u) / 1073741824, down: Number(d) / 1073741824, total: Number(u + d) / 1073741824,
    uplinkBytes: String(u), downlinkBytes: String(d), totalBytes: String(u + d) };
}
export function counterDelta(previous, current, epoch) {
  const up = BigInt(current.uplinkBytes), down = BigInt(current.downlinkBytes);
  if (!previous?.counter_sampled_at) return { up: 0n, down: 0n, quality: 'baseline' };
  if (previous.epoch_id !== epoch || up < BigInt(previous.last_uplink_bytes) || down < BigInt(previous.last_downlink_bytes)) {
    return { up, down, quality: 'reset' };
  }
  return { up: up - BigInt(previous.last_uplink_bytes), down: down - BigInt(previous.last_downlink_bytes), quality: 'normal' };
}
export function splitDays(start, end, up, down) {
  let from = new Date(start).getTime(); const to = new Date(end).getTime();
  if (to < from) throw new Error('OUT_OF_ORDER_SAMPLE');
  if (to === from) return [{ date: dayKey(to), up, down }];
  const duration = BigInt(to - from), result = [];
  let usedUp = 0n, usedDown = 0n;
  while (from < to) {
    const next = Math.min(to, (Math.floor((from + OFFSET) / DAY) + 1) * DAY - OFFSET);
    const final = next === to, span = BigInt(next - from);
    const u = final ? up - usedUp : up * span / duration;
    const d = final ? down - usedDown : down * span / duration;
    result.push({ date: dayKey(from), up: u, down: d }); usedUp += u; usedDown += d; from = next;
  }
  return result;
}
