import { authFetch, mountAccountMenu } from './auth-client.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const state = { servers: [], editingId: null, trust: null, usageServer: null, usageSaving: false, kiwiServer: null, kiwiSaving: false, kiwiRemoveArmed: false };

const icons = {
  server: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01M11 7h6M11 17h6"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
  dots: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>',
  devices: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 9h.01M7 15h.01M11 9h6M11 15h6"/></svg>',
  arrow: '<svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>'
};

function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char])); }

async function api(url, options = {}) {
  const response = await authFetch(url, { cache: 'no-store', ...options });
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { error: text || '响应格式无效' }; }
  if (!response.ok) throw Object.assign(new Error(payload.error || `请求失败（${response.status}）`), { status: response.status, payload });
  return payload;
}

function toast(message, kind = 'success') {
  const element = document.createElement('div');
  element.className = `toast${kind === 'error' ? ' error' : ''}`;
  element.textContent = message;
  $('#toastRegion').append(element);
  setTimeout(() => element.remove(), 3000);
}

function todayShanghai() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function expiry(server) {
  if (!server.expiresOn) return { type: 'unknown', label: '到期时间未填写', detail: '建议补充，便于续费提醒' };
  const days = Math.round((Date.parse(`${server.expiresOn}T00:00:00Z`) - Date.parse(`${todayShanghai()}T00:00:00Z`)) / 86400000);
  if (days < 0) return { type: 'expired', label: `${server.expiresOn} 已到期`, detail: `已过期 ${Math.abs(days)} 天` };
  if (days <= 7) return { type: 'soon', label: `${server.expiresOn} 到期`, detail: days === 0 ? '今天到期' : `${days} 天后到期` };
  return { type: 'normal', label: `${server.expiresOn} 到期`, detail: `剩余 ${days} 天` };
}

const statusMeta = {
  untested: ['未检测', 'neutral'], checking: ['检测中', 'checking'], awaiting_trust: ['待确认指纹', 'warning'],
  online: ['SSH 可连接', 'online'], failed: ['检测失败', 'failed'], host_key_changed: ['主机密钥变化', 'failed']
};

function valueOr(value, unit = '') { return value == null || value === '' ? '未填写' : `${Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}${unit}`; }

function localTime(value) {
  return value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '尚未同步';
}

function quotaUsage(server) {
  const providerUsage = server.providerTrafficUsedGb != null;
  const hasQuota = Number(server.trafficQuotaGb) > 0;
  if (!hasQuota && !providerUsage) return '<span class="quota-copy quota-missing" title="设置套餐额度后显示占比"><small>本月流量</small><b>额度未填写</b></span>';
  const bytes = providerUsage ? Number(server.providerTrafficUsedGb) * 1e9 : Number(server.monthTrafficBytes || 0);
  const usedGb = bytes / 1e9, quotaGb = Number(server.trafficQuotaGb);
  const usedValue = usedGb < 1 ? bytes / 1e6 : usedGb;
  const usedUnit = usedGb < 1 ? 'MB' : 'GB';
  const usedLabel = usedValue.toLocaleString('zh-CN', { minimumFractionDigits: usedGb < 1 ? 1 : 2, maximumFractionDigits: usedGb < 1 ? 1 : 2 });
  const rawPercent = quotaGb > 0 ? usedGb / quotaGb * 100 : 0;
  const percentLabel = rawPercent > 0 && rawPercent < 0.01 ? '<0.01%' : `${rawPercent.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
  const ringPercent = Math.min(100, Math.max(0, rawPercent));
  const quotaLabel = hasQuota ? `${quotaGb.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} GB` : '额度未设置';
  const fromKiwi = server.providerUsageSource === 'kiwivm';
  const label = fromKiwi ? `KiwiVM 已用${server.providerSyncStatus === 'error' ? ' · 同步异常' : ''}` : (providerUsage ? '套餐已用（手动）' : '本月流量');
  const recordedAt = server.providerTrafficRecordedAt ? new Date(server.providerTrafficRecordedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '未知';
  const source = fromKiwi
    ? `KiwiVM 自动同步，最近成功 ${localTime(server.providerSyncedAt)}${server.providerSyncError ? `；当前错误：${server.providerSyncError}` : ''}`
    : (providerUsage ? `服务商用量快照，录入时间 ${recordedAt}；手动校准，不叠加 Xray 流量` : '本月已记录流量');
  const ring = hasQuota ? `<span class="quota-ring" role="img" aria-label="${fromKiwi ? 'KiwiVM 套餐已用' : (providerUsage ? '服务商已用（手动记录）' : '本月已使用')} ${percentLabel}"><svg viewBox="0 0 42 42" aria-hidden="true"><circle class="quota-track" cx="21" cy="21" r="17"/><circle class="quota-value" cx="21" cy="21" r="17" pathLength="100" stroke-dasharray="100" stroke-dashoffset="${100-ringPercent}"/></svg><b>${percentLabel}</b></span>` : '';
  return `<span class="quota-usage"><span class="quota-copy" title="${escapeHtml(source)}：${usedLabel} ${usedUnit} / 套餐额度 ${quotaLabel}"><small>${label}</small><span class="quota-values"><strong>${usedLabel}<em>${usedUnit}</em></strong><span class="quota-total">/ ${quotaLabel}</span></span></span>${ring}</span>`;
}

function filteredServers() {
  const query = $('#serverSearch').value.trim().toLowerCase();
  const ssh = $('#sshStatus').value;
  const expires = $('#expiryStatus').value;
  return state.servers.filter(server => (!query || `${server.name} ${server.ipv4}`.toLowerCase().includes(query)) && (ssh === 'all' || server.sshCheckStatus === ssh) && (expires === 'all' || expiry(server).type === expires));
}

function renderServers() {
  const servers = filteredServers();
  $('#serverCount').textContent = `${servers.length} / ${state.servers.length} 台`;
  $('#serverEmpty').hidden = servers.length > 0;
  $('#serverGrid').hidden = servers.length === 0;
  $('#serverGrid').innerHTML = servers.map(server => {
    const exp = expiry(server), [statusLabel, statusClass] = statusMeta[server.sshCheckStatus] || statusMeta.untested;
    const official = server.officialUrl ? `<a class="vps-official" href="${escapeHtml(server.officialUrl)}" target="_blank" rel="noopener noreferrer">服务商官网 ${icons.arrow}</a>` : '<span class="vps-official unavailable">官方链接未填写</span>';
    return `<article class="vps-card" data-id="${server.id}">
      <div class="vps-card-top">
        <div class="vps-identity"><span class="vps-icon">${icons.server}</span><div><h3 title="${escapeHtml(server.name)}">${escapeHtml(server.name)}</h3><span class="ssh-state ${statusClass}"><i></i>${statusLabel}</span></div></div>
        <div class="vps-card-actions"><button class="button ssh-test" data-action="test" aria-label="测试 ${escapeHtml(server.name)} 的 SSH" ${server.sshCheckStatus === 'checking' ? 'disabled' : ''}><svg viewBox="0 0 24 24"><path d="M8 9 4 12l4 3M12 16h5"/><rect x="3" y="4" width="18" height="16" rx="2"/></svg><span>${server.sshCheckStatus === 'checking' ? '检测中…' : '测试 SSH'}</span></button><details class="card-menu"><summary class="icon-button" aria-label="更多操作">${icons.dots}</summary><div><button data-action="details">查看详情</button><button data-action="edit">编辑资料</button><button data-action="kiwi">配置 KiwiVM</button>${server.bandwidthProvider === 'kiwivm' ? `<button data-action="sync" ${server.providerSyncStatus === 'syncing' ? 'disabled' : ''}>${server.providerSyncStatus === 'syncing' ? '正在同步…' : '立即同步流量'}</button>` : ''}<button data-action="calibrate">手动校准流量</button></div></details></div>
      </div>
      ${server.sshCheckError ? `<p class="ssh-error" title="${escapeHtml(server.sshCheckError)}">${escapeHtml(server.sshCheckError)}</p>` : ''}
      <div class="vps-specs"><span><small>内存</small><b>${valueOr(server.memoryGb, ' GB')}</b></span><span><small>系统盘</small><b>${valueOr(server.systemDiskGb, ' GB')}</b></span><span class="quota-spec">${quotaUsage(server)}</span></div>
      <div class="vps-network"><span><small>IPv4</small><b class="mono">${escapeHtml(server.ipv4)}</b><button class="copy-button" data-action="copy" aria-label="复制 IPv4" title="复制 IPv4">${icons.copy}</button></span><span><small>SSH 端口</small><b class="mono">${server.sshPort}</b></span><a class="vps-device-link" href="/nodes.html?serverId=${encodeURIComponent(server.id)}" aria-label="管理 ${escapeHtml(server.name)} 的节点">${icons.devices}<span>管理节点</span>${icons.arrow}</a></div>
      <footer class="vps-card-foot"><div class="expiry ${exp.type}"><b>${escapeHtml(exp.label)}</b><small>${escapeHtml(exp.detail)}</small></div>${official}</footer>
    </article>`;
  }).join('');
}

async function loadServers({ quiet = false } = {}) {
  try {
    const { items } = await api('/api/servers');
    state.servers = items;
    renderServers();
    if (!quiet) toast('VPS 数据已刷新');
  } catch (error) { toast(error.message, 'error'); }
}

function openServerDialog(server = null) {
  state.editingId = server?.id || null;
  $('#serverForm').reset();
  $('#serverFormError').textContent = '';
  $('#serverDialogTitle').textContent = server ? '编辑 VPS' : '新增 VPS';
  $('#serverDialogSubtitle').textContent = server ? '修改资料不会自动安装或更改 Xray。' : '资料保存后可独立进行 SSH 检测。';
  $('#saveServer').textContent = server ? '保存修改' : '保存 VPS';
  $('#serverKey').required = !server;
  $('#keyRequired').hidden = Boolean(server);
  $('#keyHelp').textContent = server ? `当前：${server.sshKeyOriginalName || server.sshKeyRef || '已保存私钥'}。不选择文件则保持不变。` : '仅支持无密码私钥，最大 64 KiB。服务器只保存受控目录中的相对路径。';
  if (server) {
    $('#serverName').value = server.name || ''; $('#serverIpv4').value = server.ipv4 || ''; $('#serverPort').value = server.sshPort || 22; $('#serverUser').value = server.sshUser || 'root';
    $('#serverExpires').value = server.expiresOn || ''; $('#serverMemory').value = server.memoryGb ?? ''; $('#serverDisk').value = server.systemDiskGb ?? ''; $('#serverQuota').value = server.trafficQuotaGb ?? ''; $('#serverUrl').value = server.officialUrl || '';
  } else { $('#serverPort').value = 22; $('#serverUser').value = 'root'; }
  $('#serverDialog').showModal();
  requestAnimationFrame(() => $('#serverName').focus());
}

async function saveServer(event) {
  event.preventDefault();
  const button = $('#saveServer'); button.disabled = true; button.textContent = state.editingId ? '正在保存…' : '正在创建…'; $('#serverFormError').textContent = '';
  try {
    const data = new FormData($('#serverForm'));
    const url = state.editingId ? `/api/servers/${state.editingId}` : '/api/servers';
    await api(url, { method: state.editingId ? 'PATCH' : 'POST', body: data });
    $('#serverDialog').close(); await loadServers({ quiet: true }); toast(state.editingId ? 'VPS 资料已更新' : 'VPS 已添加');
  } catch (error) { $('#serverFormError').textContent = error.message; }
  finally { button.disabled = false; button.textContent = state.editingId ? '保存修改' : '保存 VPS'; }
}

async function copyText(text, message) {
  try { await navigator.clipboard.writeText(text); }
  catch { const input = document.createElement('textarea'); input.value = text; document.body.append(input); input.select(); document.execCommand('copy'); input.remove(); }
  toast(message);
}

function openUsageDialog(server) {
  state.usageServer = server;
  $('#usageForm').reset();
  $('#usageFormError').textContent = '';
  $('#usageGb').removeAttribute('aria-invalid');
  $('#usageServer').textContent = `${server.name} · ${server.ipv4}`;
  $('#usageCurrent').textContent = server.providerTrafficUsedGb == null ? '尚未校准' : `${Number(server.providerTrafficUsedGb).toFixed(2)} GB`;
  $('#usageQuota').textContent = valueOr(server.trafficQuotaGb, ' GB');
  $('#usageRecordedAt').textContent = server.providerTrafficRecordedAt
    ? `${server.providerUsageSource === 'kiwivm' ? 'KiwiVM 最近记录' : '上次校准'}：${new Date(server.providerTrafficRecordedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京时间）`
    : '尚无套餐用量记录，当前卡片显示 Xray 本月记录流量。';
  $('#usageGb').value = server.providerTrafficUsedGb ?? '';
  updateUsagePreview();
  $('#usageDialog').showModal();
  $('#usageGb').focus();
  $('#usageGb').select();
}

function updateUsagePreview() {
  const input = $('#usageGb'), quota = Number(state.usageServer?.trafficQuotaGb);
  $('#usageFormError').textContent = '';
  input.removeAttribute('aria-invalid');
  if (!input.value || !input.validity.valid) { $('#usagePreview').textContent = ''; return; }
  if (!(quota > 0)) { $('#usagePreview').textContent = '未设置套餐额度，保存后暂不计算占比。'; return; }
  const percent = Number(input.value) / quota * 100;
  $('#usagePreview').textContent = `校准后占比：${percent.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}%${percent > 100 ? '，已超出套餐额度，仍可按实际用量保存。' : ''}`;
}

async function saveUsage(event) {
  event.preventDefault();
  if (state.usageSaving || !state.usageServer) return;
  const input = $('#usageGb'), usedGb = input.value.trim(), id = state.usageServer.id;
  if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(usedGb)) {
    $('#usageFormError').textContent = '请输入不小于 0 的已用流量，最多两位小数。';
    input.setAttribute('aria-invalid', 'true'); input.focus(); return;
  }
  state.usageSaving = true;
  $('#usageFormError').textContent = '';
  $('#usageForm').setAttribute('aria-busy', 'true');
  $$('#usageDialog button, #usageGb').forEach(element => { element.disabled = true; });
  $('#saveUsage').textContent = '正在保存…';
  try {
    const { server } = await api(`/api/servers/${id}/traffic-usage`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ usedGb }), signal: AbortSignal.timeout(15000)
    });
    state.servers = state.servers.map(item => item.id === id ? server : item);
    renderServers();
    $('#usageDialog').close();
    toast(`已校准为 ${Number(server.providerTrafficUsedGb).toFixed(2)} GB`);
  } catch (error) {
    $('#usageFormError').textContent = error.status && error.status < 500
      ? error.message
      : '未能确认保存结果，请关闭弹窗并刷新列表核对后重试。';
  } finally {
    state.usageSaving = false;
    $('#usageForm').removeAttribute('aria-busy');
    $$('#usageDialog button, #usageGb').forEach(element => { element.disabled = false; });
    $('#saveUsage').textContent = '保存校准';
  }
}

function providerStatusText(server) {
  if (server.bandwidthProvider !== 'kiwivm') return '尚未启用 KiwiVM 自动同步';
  if (server.providerSyncStatus === 'syncing') return '正在同步，请稍候…';
  if (server.providerSyncStatus === 'error') return `同步异常：${server.providerSyncError || '未知错误'}`;
  return `同步正常 · 最近成功 ${localTime(server.providerSyncedAt)}（北京时间）`;
}

function openKiwiDialog(server) {
  state.kiwiServer = server;
  state.kiwiRemoveArmed = false;
  $('#kiwiForm').reset();
  $('#kiwiFormError').textContent = '';
  $('#kiwiServer').textContent = `${server.name} · ${server.ipv4}`;
  $('#kiwiVeid').value = server.kiwiVmVeid || '';
  $('#kiwiApiKey').required = !server.hasKiwiVmApiKey;
  $('#kiwiKeyRequired').hidden = Boolean(server.hasKiwiVmApiKey);
  $('#kiwiKeyHelp').textContent = server.hasKiwiVmApiKey ? 'API Key 已保存；留空表示继续使用原密钥。' : '首次配置必填，可从 KiwiVM 控制台 API 页面获取。';
  $('#kiwiSummary').hidden = false;
  $('#kiwiSummary').className = `provider-summary ${server.providerSyncStatus === 'error' ? 'error' : ''}`;
  $('#kiwiSummary').textContent = providerStatusText(server);
  $('#removeKiwi').hidden = server.bandwidthProvider !== 'kiwivm';
  $('#removeKiwi').textContent = '停用自动同步';
  $('#kiwiDialog').showModal();
  requestAnimationFrame(() => (server.kiwiVmVeid ? $('#kiwiApiKey') : $('#kiwiVeid')).focus());
}

async function saveKiwi(event) {
  event.preventDefault();
  if (state.kiwiSaving || !state.kiwiServer) return;
  const veid = $('#kiwiVeid').value.trim(), apiKey = $('#kiwiApiKey').value.trim(), id = state.kiwiServer.id;
  if (!/^\d{1,20}$/.test(veid)) { $('#kiwiFormError').textContent = 'VEID 必须是 1–20 位数字。'; $('#kiwiVeid').focus(); return; }
  if (!state.kiwiServer.hasKiwiVmApiKey && !apiKey) { $('#kiwiFormError').textContent = '首次配置必须填写 API Key。'; $('#kiwiApiKey').focus(); return; }
  state.kiwiSaving = true;
  $('#kiwiFormError').textContent = '';
  $('#kiwiForm').setAttribute('aria-busy', 'true');
  $$('#kiwiDialog input, #kiwiDialog button').forEach(element => { element.disabled = true; });
  $('#saveKiwi').textContent = '正在验证并同步…';
  try {
    const { server } = await api(`/api/servers/${id}/kiwivm`, { method: 'PUT', headers: {'content-type':'application/json'}, body: JSON.stringify({ veid, apiKey }), signal: AbortSignal.timeout(20000) });
    state.servers = state.servers.map(item => item.id === id ? server : item);
    renderServers(); $('#kiwiDialog').close(); toast('KiwiVM 已连接，套餐流量已更新');
  } catch (error) { $('#kiwiFormError').textContent = error.message; }
  finally {
    state.kiwiSaving = false; $('#kiwiForm').removeAttribute('aria-busy');
    $$('#kiwiDialog input, #kiwiDialog button').forEach(element => { element.disabled = false; });
    $('#saveKiwi').textContent = '保存并同步';
  }
}

async function syncKiwi(server) {
  server.providerSyncStatus = 'syncing'; renderServers();
  try {
    const { server: updated } = await api(`/api/servers/${server.id}/sync-bandwidth`, { method:'POST', headers:{'content-type':'application/json'}, body:'{}', signal:AbortSignal.timeout(20000) });
    state.servers = state.servers.map(item => item.id === server.id ? updated : item); renderServers(); toast('KiwiVM 套餐流量已更新');
  } catch (error) { await loadServers({quiet:true}); toast(error.message, 'error'); }
}

async function removeKiwi() {
  if (state.kiwiSaving || !state.kiwiServer) return;
  if (!state.kiwiRemoveArmed) {
    state.kiwiRemoveArmed = true; $('#removeKiwi').textContent = '再次点击确认停用';
    setTimeout(() => { if (!state.kiwiSaving) { state.kiwiRemoveArmed = false; $('#removeKiwi').textContent = '停用自动同步'; } }, 5000);
    return;
  }
  const id = state.kiwiServer.id; state.kiwiSaving = true;
  $$('#kiwiDialog input, #kiwiDialog button').forEach(element => { element.disabled = true; });
  try {
    const { server } = await api(`/api/servers/${id}/kiwivm`, {method:'DELETE', headers:{'content-type':'application/json'}, body:'{}', signal:AbortSignal.timeout(15000)});
    state.servers = state.servers.map(item => item.id === id ? server : item); renderServers(); $('#kiwiDialog').close(); toast('KiwiVM 自动同步已停用，已删除保存的 API Key');
  } catch (error) { $('#kiwiFormError').textContent = error.message; }
  finally { state.kiwiSaving = false; $$('#kiwiDialog input, #kiwiDialog button').forEach(element => { element.disabled = false; }); }
}

function showDetails(server) {
  const [statusLabel] = statusMeta[server.sshCheckStatus] || statusMeta.untested;
  $('#detailsTitle').textContent = server.name;
  $('#detailsSubtitle').textContent = `${server.ipv4}:${server.sshPort}`;
  $('#detailsBody').innerHTML = `<section class="detail-section"><h3>服务器资料</h3><div class="detail-grid"><div class="detail-item"><span>IPv4</span><b class="mono">${escapeHtml(server.ipv4)}</b></div><div class="detail-item"><span>SSH 端口</span><b>${server.sshPort}</b></div><div class="detail-item"><span>内存</span><b>${valueOr(server.memoryGb, ' GB')}</b></div><div class="detail-item"><span>系统盘</span><b>${valueOr(server.systemDiskGb, ' GB')}</b></div><div class="detail-item"><span>套餐额度</span><b>${valueOr(server.trafficQuotaGb, ' GB')}</b></div><div class="detail-item"><span>到期时间</span><b>${escapeHtml(server.expiresOn || '未填写')}</b></div></div></section>
    <section class="detail-section"><h3>套餐流量来源</h3><div class="detail-grid"><div class="detail-item"><span>更新方式</span><b>${server.bandwidthProvider === 'kiwivm' ? 'KiwiVM API 自动同步' : '手动校准'}</b></div><div class="detail-item"><span>同步状态</span><b>${escapeHtml(providerStatusText(server))}</b></div><div class="detail-item"><span>VEID</span><b class="mono">${escapeHtml(server.kiwiVmVeid || '未配置')}</b></div><div class="detail-item"><span>API Key</span><b>${server.hasKiwiVmApiKey ? '已安全保存（不显示）' : '未配置'}</b></div><div class="detail-item"><span>下次重置</span><b>${server.providerTrafficResetAt ? `${localTime(server.providerTrafficResetAt)}（北京时间）` : '未知'}</b></div><div class="detail-item"><span>计费倍率</span><b>${server.providerTrafficMultiplier ?? '未知'}</b></div></div></section>
    <section class="detail-section"><h3>SSH 身份</h3><div class="detail-grid"><div class="detail-item"><span>检测状态</span><b>${statusLabel}</b></div><div class="detail-item"><span>最近检测</span><b>${server.sshCheckedAt ? new Date(server.sshCheckedAt).toLocaleString('zh-CN', {hour12:false}) : '尚未检测'}</b></div><div class="detail-item"><span>SSH 用户名</span><b>${escapeHtml(server.sshUser)}</b></div><div class="detail-item"><span>私钥文件</span><b>${escapeHtml(server.sshKeyOriginalName || '未记录原文件名')}</b></div><div class="detail-item field-wide"><span>私钥相对路径</span><b class="mono">${escapeHtml(server.sshKeyRef || '未填写')}</b></div><div class="detail-item field-wide"><span>私钥指纹</span><b class="mono">${escapeHtml(server.sshKeyFingerprint || '未生成')}</b></div></div>${server.sshCheckError ? `<p class="details-error">${escapeHtml(server.sshCheckError)}</p>` : ''}</section>`;
  $('#serverDetails').showModal();
}

async function testSsh(server) {
  server.sshCheckStatus = 'checking'; server.sshCheckError = null; renderServers();
  try { await api(`/api/servers/${server.id}/test-ssh`, { method: 'POST', headers: {'content-type':'application/json'}, body: '{}' }); await loadServers({ quiet: true }); toast('SSH 连接检测成功'); }
  catch (error) {
    await loadServers({ quiet: true });
    if (error.payload?.code === 'HOST_KEY_TRUST_REQUIRED') {
      state.trust = { serverId: server.id, fingerprint: error.payload.fingerprint };
      $('#hostFingerprint').textContent = error.payload.fingerprint;
      $('#trustDialog').showModal(); requestAnimationFrame(() => $('#confirmTrust').focus());
    } else toast(error.message, 'error');
  }
}

async function trustHost() {
  if (!state.trust) return;
  const pending = state.trust; state.trust = null;
  try { await api(`/api/servers/${pending.serverId}/trust-host-key`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({fingerprint:pending.fingerprint}) }); await loadServers({quiet:true}); toast('主机指纹已信任，SSH 连接成功'); }
  catch (error) { await loadServers({quiet:true}); toast(error.message,'error'); }
}

$('#addServer').addEventListener('click', () => openServerDialog());
$('#emptyAdd').addEventListener('click', () => openServerDialog());
$('#serverForm').addEventListener('submit', saveServer);
$('#usageForm').addEventListener('submit', saveUsage);
$('#kiwiForm').addEventListener('submit', saveKiwi);
$('#removeKiwi').addEventListener('click', removeKiwi);
$('#usageGb').addEventListener('input', updateUsagePreview);
$('#usageDialog').addEventListener('cancel', event => { if (state.usageSaving) event.preventDefault(); });
$('#usageDialog').addEventListener('close', () => {
  const id = state.usageServer?.id;
  state.usageServer = null;
  if (id) $(`.vps-card[data-id="${id}"] .card-menu summary`)?.focus();
});
$('#kiwiDialog').addEventListener('cancel', event => { if (state.kiwiSaving) event.preventDefault(); });
$('#kiwiDialog').addEventListener('close', () => {
  const id = state.kiwiServer?.id;
  state.kiwiServer = null; state.kiwiRemoveArmed = false;
  if (id) $(`.vps-card[data-id="${id}"] .card-menu summary`)?.focus();
});
$('#refreshServers').addEventListener('click', () => loadServers());
$('#serverSearch').addEventListener('input', renderServers);
$('#sshStatus').addEventListener('change', renderServers);
$('#expiryStatus').addEventListener('change', renderServers);
$('#serverGrid').addEventListener('click', event => {
  const button = event.target.closest('[data-action]'); if (!button) return;
  const server = state.servers.find(item => item.id === button.closest('.vps-card').dataset.id); if (!server) return;
  button.closest('details')?.removeAttribute('open');
  if (button.dataset.action === 'test') testSsh(server);
  if (button.dataset.action === 'copy') copyText(server.ipv4, 'IPv4 已复制');
  if (button.dataset.action === 'edit') openServerDialog(server);
  if (button.dataset.action === 'details') showDetails(server);
  if (button.dataset.action === 'calibrate') openUsageDialog(server);
  if (button.dataset.action === 'kiwi') openKiwiDialog(server);
  if (button.dataset.action === 'sync') syncKiwi(server);
});
$('#trustDialog').addEventListener('close', () => { if ($('#trustDialog').returnValue === 'confirm') trustHost(); else state.trust = null; });
$$('[data-close]').forEach(button => button.addEventListener('click', () => document.getElementById(button.dataset.close).close()));
document.addEventListener('click', event => { if (!event.target.closest('.card-menu')) $$('.card-menu[open]').forEach(menu => menu.removeAttribute('open')); });

$('#serverGrid').innerHTML = '<div class="vps-skeleton"></div><div class="vps-skeleton"></div>';
mountAccountMenu().catch(error => toast(error.message, 'error'));
loadServers({ quiet: true });
