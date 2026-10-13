import { authFetch, mountAccountMenu } from './auth-client.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);

const icons = {
  desktop: '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2.5 19h19M9 19l.5-3h5l.5 3"/></svg>',
  laptop: '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2.5 19h19"/></svg>',
  phone: '<svg viewBox="0 0 24 24"><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/></svg>',
  tablet: '<svg viewBox="0 0 24 24"><rect x="5" y="2.5" width="14" height="19" rx="2"/><path d="M11 18.5h2"/></svg>',
  chart: '<svg viewBox="0 0 24 24"><path d="M4 19V9m5 10V5m6 14v-7m5 7V3"/></svg>',
  qr: '<svg viewBox="0 0 24 24"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v6h-2zM14 18h2v2h-2z"/></svg>'
};

const state = {
  devices: [],
  activeDevice: null,
  drawerReturnFocus: null,
  initialServerId: /^\d+$/.test(new URLSearchParams(location.search).get('serverId') || '') ? new URLSearchParams(location.search).get('serverId') : '',
  initialNodeId: /^\d+$/.test(new URLSearchParams(location.search).get('nodeId') || '') ? new URLSearchParams(location.search).get('nodeId') : ''
};
state.page = 1;
state.nodes = [];

async function api(path, options = {}) {
  const response = await authFetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  const type = response.headers.get('content-type') || '';
  const body = type.includes('json') ? await response.json() : await response.text();
  if (!response.ok) throw Object.assign(new Error(body.error || `请求失败（${response.status}）`), {status:response.status});
  return body;
}

function toast(message, kind = 'success') {
  const element = document.createElement('div');
  element.className = `toast${kind === 'error' ? ' error' : ''}`;
  element.textContent = message;
  $('#toastRegion').append(element);
  setTimeout(() => element.remove(), 2800);
}

function maskUuid(uuid) {
  return `${uuid.slice(0, 8)}…${uuid.slice(-4)}`;
}

function statusLabel(status) {
  return { online: '在线', offline: '离线', disabled: '已停用', unknown: '未知 / 过期', pending: '处理中', uncertain: '正在核实', failed: '操作失败' }[status] || status;
}

function displayStatus(device) {
  return ['pending','uncertain','failed'].includes(device.syncStatus) ? device.syncStatus : device.status;
}

function relativeTime(value) {
  if (!value) return '等待连接';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 20) return '刚刚';
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}

function renderRows() {
  const rows = $('#deviceRows');
  rows.innerHTML = state.devices.map(device => `
    <tr data-uuid="${device.credentialId}">
      <td data-label="设备名称"><div class="device-name"><span class="device-icon">${icons[device.kind] || icons.desktop}</span><span class="device-copy"><strong title="${escapeHtml(device.name)}">${escapeHtml(device.name)}</strong></span></div></td>
      <td data-label="UUID"><div class="uuid-cell"><span class="mono uuid-value" tabindex="0" title="${escapeHtml(device.uuid)}">${escapeHtml(device.uuid)}</span></div></td>
      <td data-label="状态" aria-live="polite"><span class="status ${displayStatus(device)}">${statusLabel(displayStatus(device))}</span></td>
      <td data-label="来源公网 IP" class="mono">${escapeHtml(device.sourceIps[0] || '—')}</td>
      <td data-label="活跃IP" class="sessions">${device.onlineIpCount ?? '—'}</td>
      <td data-label="今日消耗"><span class="traffic"><strong>${(Number(device.todayTraffic.totalBytes) / 1e9).toFixed(3)} GB</strong></span></td>
      <td data-label="最后活动" class="last-active">${relativeTime(device.lastActive)}</td>
      <td data-label="启停"><button type="button" class="device-switch" role="switch" data-action="toggle" aria-checked="${Boolean(device.enabled)}" aria-label="${escapeHtml(device.name)} 的启停" title="${device.enabled ? '点击停用' : '点击启用'} · ${escapeHtml(({synced:'已同步',pending:'处理中',uncertain:'正在核实',failed:'操作失败',drift:'配置不一致'})[device.syncStatus] || device.syncStatus)}" ${['pending','uncertain'].includes(device.syncStatus) ? 'disabled' : ''}><span aria-hidden="true"></span></button></td>
      <td><span class="row-actions"><button class="icon-button" data-action="traffic" aria-label="查看 ${escapeHtml(device.name)} 的流量" title="流量详情">${icons.chart}</button><button class="icon-button" data-action="qr" aria-label="显示 ${escapeHtml(device.name)} 的二维码" title="导入二维码">${icons.qr}</button></span></td>
    </tr>`).join('');
  $('#emptyState').hidden = state.devices.length > 0;
  rows.closest('table').hidden = state.devices.length === 0;
  $('#resultCount').textContent = `(${state.total || 0} 台设备 / 本页 ${state.devices.length} 份凭证)`;
}

async function loadDashboard() {
  const filters = new URLSearchParams({serverId:$('#serverFilter').value,nodeId:$('#nodeFilter').value});
  const [data, health] = await Promise.all([api(`/api/dashboard?${filters}`), api(`/api/health?${filters}`)]);
  $('#metricTotal').textContent = data.total;
  $('#metricOnline').textContent = data.online;
  $('#metricDisabled').textContent = data.disabled;
  $('#metricTraffic').textContent = data.totalTraffic.toFixed(3);
  $('#serviceBadge').innerHTML = `<i></i><b>${escapeHtml(health.xrayVersion.split(' ').slice(0, 2).join(' '))}</b> · API ${health.api.available ? '正常' : '异常'}`;
}

async function loadDevices({ quiet = false } = {}) {
  try {
    const params = new URLSearchParams({ query: $('#searchInput').value.trim(), status: $('#statusFilter').value,serverId:$('#serverFilter').value,nodeId:$('#nodeFilter').value,page:state.page,pageSize:50 });
    const [{ items, collectedAt, total }] = await Promise.all([api(`/api/devices?${params}`), loadDashboard()]);
    state.devices = items.flatMap(d => d.credentials);
    state.total = total;
    renderRows();
    $('#lastRefresh').textContent = collectedAt ? `最近采集：${new Date(collectedAt * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : '等待首次有效采集';
    $('#pageInfo').textContent = `第 ${state.page} 页 / 共 ${Math.max(1,Math.ceil(total/50))} 页`;
    $('#previousPage').disabled = state.page <= 1;
    $('#nextPage').disabled = state.page*50 >= total;
    if (!quiet) toast('设备数据已刷新');
  } catch (error) {
    toast(error.message, 'error');
  }
}

function openAddDialog() {
  $('#addForm').reset();
  $('#addError').textContent = '';
  state.createKey = crypto.randomUUID();
  $('#deviceName').readOnly = false;
  $('#addDialog').showModal();
  requestAnimationFrame(() => $('#deviceName').focus());
}

async function createDevice(event) {
  event.preventDefault();
  const button = $('#createDevice');
  button.disabled = true;
  button.textContent = '正在创建…';
  $('#addError').textContent = '';
  try {
    const { operationId } = await api('/api/devices', {
      method: 'POST',
      headers: {'idempotency-key':state.createKey},
      body: JSON.stringify({ name: $('#deviceName').value, note: $('#deviceNote').value,nodeId:$('#deviceNode').value,deviceId:$('#existingDevice').value || undefined })
    });
    const operation = await waitOperation(operationId);
    $('#addDialog').close();
    await loadDevices({ quiet: true });
    await loadTargets();
    toast('凭证已创建并确认生效');
    await showQr(operation.credential_id);
  } catch (error) {
    $('#addError').textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = '创建设备';
  }
}

async function showQr(uuid) {
  try {
    const { device, vlessUri, node } = await api(`/api/credentials/${encodeURIComponent(uuid)}`);
    if (!device.enabled || device.syncStatus !== 'synced') throw new Error('凭证尚未确认启用，暂不能导入');
    state.activeDevice = device;
    $('#qrSubtitle').textContent = `${device.name} · ${maskUuid(device.uuid)}`;
    $('#vlessLink').value = vlessUri;
    $('#qrNodeSummary').textContent = `${node.name} · ${node.protocol} · ${node.network} · ${node.security}`;
    const qrUrl = `/api/credentials/${encodeURIComponent(uuid)}/qrcode`;
    $('#qrImage').src = qrUrl;
    $('#downloadQr').href = qrUrl;
    $('#downloadQr').download = `${device.name.replace(/[\\/:*?"<>|]/g, '-')}-xray-qr.svg`;
    $('#qrDialog').showModal();
    requestAnimationFrame(() => $('#copyLink').focus());
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function copyLink() {
  const text = $('#vlessLink').value;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    $('#vlessLink').select();
    document.execCommand('copy');
  }
  toast('节点链接已复制');
}

function openDrawer() {
  state.drawerReturnFocus = document.activeElement;
  $('#drawerShell').classList.add('open');
  $('#drawerShell').setAttribute('aria-hidden', 'false');
  $('#appRoot').setAttribute('inert', '');
  document.body.style.overflow = 'hidden';
  requestAnimationFrame(() => $('#closeDrawer').focus());
}

function closeDrawer() {
  $('#drawerShell').classList.remove('open');
  $('#drawerShell').setAttribute('aria-hidden', 'true');
  $('#appRoot').removeAttribute('inert');
  document.body.style.overflow = '';
  const target = state.drawerReturnFocus;
  state.drawerReturnFocus = null;
  requestAnimationFrame(() => target?.isConnected && target.focus());
}

async function showTraffic(uuid) {
  try {
    const from = $('#trafficFrom')?.value || new Date(Date.now()-29*86400000+8*3600000).toISOString().slice(0,10);
    const to = $('#trafficTo')?.value || new Date(Date.now()+8*3600000).toISOString().slice(0,10);
    const groupBy = $('#trafficGroup')?.value || 'day';
    const scope = $('#trafficScope')?.value || 'credential';
    const deviceId = state.devices.find(d => d.credentialId === String(uuid))?.deviceId;
    const params = new URLSearchParams({from,to,groupBy});
    const [{ device }, traffic] = await Promise.all([
      api(`/api/credentials/${encodeURIComponent(uuid)}`),
      api(`/api/${scope === 'device' && deviceId ? 'devices/'+deviceId : 'credentials/'+encodeURIComponent(uuid)}/traffic?${params}`)
    ]);
    state.activeDevice = device;
    $('#drawerTitle').textContent = device.name;
    $('#drawerSubtitle').textContent = `${maskUuid(device.uuid)} · ${statusLabel(device.status)}`;
    $('#drawerBody').innerHTML = `
      <section class="detail-section">
        <h3>设备身份</h3>
        <div class="detail-grid"><div class="detail-item"><span>用户名称</span><b>${escapeHtml(device.email || '未配置')}</b></div><div class="detail-item"><span>状态</span><b>${statusLabel(device.status)}</b></div><div class="detail-item detail-item-wide"><span>UUID</span><b class="mono">${device.uuid}</b></div><div class="detail-item"><span>来源公网 IP</span><b class="mono">${escapeHtml(device.sourceIps.join(', ') || '—')}</b></div><div class="detail-item"><span>在线来源 IP 数</span><b>${device.onlineIpCount ?? '—'}</b></div></div>
      </section>
      <section class="detail-section">
        <h3>使用流量</h3>
        <div class="source-scope"><b>${escapeHtml(traffic.scopeLabel)}</b><span>已入库流量在服务重启后保留；采集空档可能造成缺口。</span></div>
        <div class="traffic-total"><strong>${traffic.totals.total.toFixed(4)}</strong><span>GiB 总流量</span></div>
        <div class="real-traffic-grid"><div><span>上传</span><b>${traffic.totals.up.toFixed(4)} GiB</b></div><div><span>下载</span><b>${traffic.totals.down.toFixed(4)} GiB</b></div></div>
        <div class="collection-meta"><span>统计起点 UTC</span><b>${escapeHtml(traffic.trackingStartedAt || '等待有效采集')}</b><span>本次采集</span><b>${traffic.collectedAt ? new Date(traffic.collectedAt * 1000).toLocaleString('zh-CN', { hour12: false }) : '—'}</b></div>
      </section>
      <section class="detail-section"><h3>历史流量 · 北京时间</h3>
        <div class="history-filters"><label>开始日期<input id="trafficFrom" type="date" value="${escapeHtml(from)}"></label><label>结束日期<input id="trafficTo" type="date" value="${escapeHtml(to)}"></label>
        <label>汇总方式<select id="trafficGroup"><option value="day" ${groupBy==='day'?'selected':''}>每日</option><option value="month" ${groupBy==='month'?'selected':''}>每月</option></select></label>
        <label>统计范围<select id="trafficScope"><option value="credential" ${scope==='credential'?'selected':''}>当前节点</option><option value="device" ${scope==='device'?'selected':''}>设备全部节点</option></select></label><button class="button" id="queryHistory">查询</button></div>
        <p>所选范围：${traffic.rangeTotals.total.toFixed(4)} GiB${traffic.hasGap?' · 含采集缺口，部分流量可能遗漏':''}</p>
        <div class="history-table"><table><thead><tr><th>日期</th><th>上传 GiB</th><th>下载 GiB</th><th>记录质量</th></tr></thead><tbody>${traffic.series.map(r=>`<tr><td>${escapeHtml(r.date)}</td><td>${r.up.toFixed(4)}</td><td>${r.down.toFixed(4)}</td><td>${r.hasGap?'有缺口':BigInt(r.estimatedBytes)>0n?'跨日估算':'已记录'}</td></tr>`).join('') || '<tr><td colspan="4">所选日期暂无采集记录</td></tr>'}</tbody></table></div>
      </section>
      <section class="detail-section"><h3>最近活动</h3><ul class="activity"><li>刷新 UUID 流量统计<time>${new Date().toLocaleString('zh-CN', { hour12: false })}</time></li><li>最近连接活动<time>${relativeTime(device.lastActive)}</time></li><li>凭证来源<time>${device.createdAt ? new Date(device.createdAt).toLocaleString('zh-CN', { hour12: false }) : '由现有 Xray 配置导入'}</time></li></ul></section>
      <button class="button primary drawer-qr-button" id="drawerQr">显示导入二维码</button>`;
    if (!$('#drawerShell').classList.contains('open')) openDrawer();
    $('#drawerQr').addEventListener('click', () => showQr(uuid));
    $('#queryHistory').addEventListener('click', () => showTraffic(uuid));
  } catch (error) {
    toast(error.message, 'error');
  }
}

$('#addDevice').addEventListener('click', openAddDialog);
$('#addForm').addEventListener('submit', createDevice);
$('#copyLink').addEventListener('click', copyLink);
$('#refreshButton').addEventListener('click', async () => {
  const button=$('#refreshButton');button.disabled=true;button.textContent='采集中…';
  try { const result=await api('/api/refresh',{method:'POST',body:'{}'});await loadTargets();await loadDevices({quiet:true});toast(result.results.every(r=>r.ok||r.skipped)?'采集完成':'部分节点采集失败，已保留历史数据',result.results.every(r=>r.ok||r.skipped)?'success':'error'); }
  catch(e){toast(e.message,'error');}finally{button.disabled=false;button.textContent='刷新';}
});
$('#statusFilter').addEventListener('change', () => {state.page=1;loadDevices({ quiet: true });});
let searchTimer;
$('#searchInput').addEventListener('input', () => {
  clearTimeout(searchTimer);
  state.page = 1;
  searchTimer = setTimeout(() => loadDevices({ quiet: true }), 180);
});

$('#deviceRows').addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const uuid = button.closest('tr').dataset.uuid;
  if (button.dataset.action === 'toggle') toggleDevice(uuid,button);
  if (button.dataset.action === 'traffic') showTraffic(uuid);
  if (button.dataset.action === 'qr') showQr(uuid);
});

$$('[data-close-dialog]').forEach(button => button.addEventListener('click', () => document.getElementById(button.dataset.closeDialog).close()));
$('#closeDrawer').addEventListener('click', closeDrawer);
$('#drawerBackdrop').addEventListener('click', closeDrawer);

document.addEventListener('keydown', event => {
  if (!$('#drawerShell').classList.contains('open') || event.defaultPrevented) return;
  if (event.key === 'Escape' && !document.querySelector('dialog[open]')) {
    event.preventDefault();
    closeDrawer();
    return;
  }
  if (event.key !== 'Tab' || document.querySelector('dialog[open]')) return;
  const items = $$('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])', $('.drawer')).filter(item => !item.disabled && item.offsetParent !== null);
  const first = items[0], last = items.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});

async function waitOperation(id, credentialId) {
  for(let i=0;i<180;i++) {
    let op;
    try { op=await api(`/api/operations/${id}`); }
    catch { op={status:'uncertain'}; }
    const device=state.devices.find(d=>d.credentialId===credentialId);
    if(device && !['success','failed'].includes(op.status)) { device.syncStatus=op.status==='uncertain'?'uncertain':'pending';renderRows(); }
    if(op.status==='success') return op;
    if(op.status==='failed') throw new Error(op.error_summary || '操作失败');
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  throw new Error(`操作 ${id} 仍在后台处理，请稍后刷新`);
}
function confirmToggle(device) {
  const dialog=$('#toggleDialog');
  if(dialog.open)return Promise.resolve(false);
  dialog.returnValue='cancel';
  $('#toggleTitle').textContent=device.enabled?'确认停用设备':'确认启用设备';
  $('#toggleDescription').textContent=`${device.enabled?'停用':'启用'}「${device.name}」在「${device.nodeName}」的凭证？`;
  $('#confirmToggle').textContent=device.enabled?'确认停用':'确认启用';
  return new Promise(resolve=>{
    dialog.addEventListener('close',()=>{
      const confirmed=dialog.returnValue==='confirm';
      if(!confirmed)document.querySelector(`tr[data-uuid="${device.credentialId}"] [data-action="toggle"]`)?.focus();
      resolve(confirmed);
    },{once:true});
    dialog.showModal();
  });
}
async function toggleDevice(id,button) {
  const device=state.devices.find(d=>d.credentialId===id);if(!device)return;
  if(['pending','uncertain'].includes(device.syncStatus)||!await confirmToggle(device))return;
  button.disabled=true;
  device.syncStatus='pending';renderRows();
  try { const r=await api(`/api/credentials/${id}/enabled`,{method:'PATCH',headers:{'idempotency-key':crypto.randomUUID()},body:JSON.stringify({enabled:!device.enabled})});await waitOperation(r.operationId,id);toast('操作已确认生效'); }
  catch(e){device.syncStatus=e.status?'failed':'uncertain';renderRows();toast(e.message,'error');}finally{await loadDevices({quiet:true});}
}
function renderNodeOptions() {
  const current=$('#nodeFilter').value || state.initialNodeId;
  $('#nodeFilter').innerHTML='<option value="">全部节点</option>'+state.nodes.filter(n=>!$('#serverFilter').value||String(n.serverId)===$('#serverFilter').value).map(n=>`<option value="${n.id}">${escapeHtml(n.name)}</option>`).join('');
  $('#nodeFilter').value=state.nodes.some(n=>String(n.id)===String(current))?String(current):'';
  state.initialNodeId='';
}
async function loadTargets() {
  const [servers,nodes,devices]=await Promise.all([api('/api/servers'),api('/api/nodes'),api('/api/devices?pageSize=100')]);
  const current=$('#serverFilter').value || state.initialServerId;
  $('#serverFilter').innerHTML='<option value="">全部 VPS</option>'+servers.items.map(s=>`<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  $('#serverFilter').value=servers.items.some(server=>String(server.id)===String(current))?String(current):'';
  state.initialServerId='';
  state.nodes=nodes.items;renderNodeOptions();
  $('#deviceNode').innerHTML=nodes.items.filter(n=>n.access?.canManage).map(n=>`<option value="${n.id}">${escapeHtml(n.name)}</option>`).join('');
  $('#existingDevice').innerHTML='<option value="">新建设备</option>'+devices.items.map(d=>`<option value="${d.id}">${escapeHtml(d.name)}</option>`).join('');
  state.deviceOptions=devices.items;
}
$('#serverFilter').addEventListener('change',()=>{state.page=1;$('#nodeFilter').value='';renderNodeOptions();const url=new URL(location.href);if($('#serverFilter').value)url.searchParams.set('serverId',$('#serverFilter').value);else url.searchParams.delete('serverId');history.replaceState(null,'',url);loadDevices({quiet:true});});
$('#nodeFilter').addEventListener('change',()=>{state.page=1;loadDevices({quiet:true});});
$('#existingDevice').addEventListener('change',()=>{const device=state.deviceOptions.find(d=>d.id===$('#existingDevice').value);$('#deviceName').readOnly=!!device;if(device){$('#deviceName').value=device.name;$('#deviceNote').value=device.note;}});
$('#previousPage').addEventListener('click',()=>{state.page--;loadDevices({quiet:true});});
$('#nextPage').addEventListener('click',()=>{state.page++;loadDevices({quiet:true});});
mountAccountMenu().catch(e=>toast(e.message,'error'));
loadTargets().then(()=>loadDevices({quiet:true})).catch(e=>toast(e.message,'error'));
let autoLoading=false;
let lastAutoLoad=0;
setInterval(async()=>{if(document.hidden||autoLoading)return;const busy=state.devices.some(d=>['pending','uncertain'].includes(d.syncStatus));if(!busy&&Date.now()-lastAutoLoad<30000)return;autoLoading=true;lastAutoLoad=Date.now();try{await loadDevices({quiet:true});}finally{autoLoading=false;}},2000);
