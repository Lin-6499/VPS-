import { parseDate } from './traffic.js';

export function jsonValue(value) {
  if (typeof value !== 'string') return value || null;
  try { return JSON.parse(value); } catch { return null; }
}
export function nodeDiagnosis(node, snapshot) {
  const reasons = [...(node.reasons || [])];
  const supported = node.supported ?? (node.protocol === 'vless' && ['tcp','raw'].includes(node.network) && node.security === 'reality' && Boolean(node.sni && node.publicKey));
  if (!supported && !reasons.length) reasons.push('首版支持 VLESS + TCP/RAW + REALITY，且需要完整节点参数');
  const clients = node.clients || [];
  const identities = clients.every(c => Boolean(c.email)) && new Set(clients.map(c=>c.email)).size === clients.length;
  const traffic = node.trafficConfigured ?? (snapshot.apiAvailable && clients.length > 0 && clients.every(c=>c.trafficAvailable));
  const online = node.onlineConfigured ?? (snapshot.apiAvailable && clients.length > 0 && clients.every(c=>c.onlineAvailable));
  const manageable = Boolean(supported && snapshot.serviceState === 'active' && node.runtimeAvailable && identities && !node.tag?.startsWith('#index:') && node.manageable !== false);
  if (!traffic) reasons.push('流量统计不可用：检查 StatsService、stats、用户 email 及上下行统计策略');
  if (!online) reasons.push('活跃 IP 查询不可用：检查 StatsService、statsUserOnline 及当前 Xray 命令支持情况');
  if (!node.runtimeAvailable) reasons.push('动态管理不可用：检查 HandlerService 与运行时用户查询接口');
  if (!identities) reasons.push('用户 email 缺失或重复，请在远端配置中补齐后重新诊断');
  if (node.tag?.startsWith('#index:')) reasons.push('inbound 缺少稳定 tag，不能动态管理用户');
  const readyForDeviceManagement=Boolean(manageable && traffic && online);
  return {tag:node.tag,port:node.port,protocol:node.protocol,transport:node.network,security:node.security,
    supported:Boolean(supported),traffic:Boolean(traffic),online:Boolean(online),management:manageable,readyForDeviceManagement,
    credentialCount:clients.length,reasons:[...new Set(reasons)]};
}
export function snapshotDiagnosis(snapshot) {
  const nodes = snapshot.nodes.map(n=>nodeDiagnosis(n,snapshot));
  return {serviceState:snapshot.serviceState,version:snapshot.version,statsApi:Boolean(snapshot.apiAvailable),nodes,
    management:Boolean(snapshot.apiAvailable) && nodes.some(n=>n.supported) && nodes.filter(n=>n.supported).every(n=>n.readyForDeviceManagement),
    unsupported:snapshot.unsupported || []};
}
export function nodeAccess(row) {
  const diagnosis = jsonValue(row.diagnostics ?? row.node_diagnostics);
  const fresh = Boolean(row.diagnosed_at && Date.now()-parseDate(row.diagnosed_at).getTime()<180000 && !row.last_error);
  const present = row.observed_state === 'present';
  const active = row.service_state === 'active' && row.instance_enabled !== 0 && row.server_enabled !== 0;
  return {canManage:Boolean(fresh && present && active && row.allow_write && diagnosis?.readyForDeviceManagement),
    canQr:Boolean(fresh && present && active && diagnosis?.supported),diagnosis,fresh,
    reason:!present?'配置中未发现或尚未采集':!fresh?'诊断已过期或采集失败，请重新诊断':!active?'服务未运行':!row.allow_write?'服务为只读':!diagnosis?.readyForDeviceManagement?'流量、在线或动态管理能力不完整，请查看诊断':''};
}
