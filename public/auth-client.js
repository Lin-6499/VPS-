let sessionPromise;
function loginLocation(){const next=location.pathname+location.search;return `/login.html?next=${encodeURIComponent(next)}`;}
async function loadSession(force=false){
  if(force||!sessionPromise)sessionPromise=fetch('/api/auth/session',{cache:'no-store'}).then(async response=>{if(response.status===401){location.replace(loginLocation());throw new Error('登录已失效');}if(!response.ok)throw new Error('无法验证登录状态');return response.json();});
  return sessionPromise;
}
export async function authFetch(url,options={}){
  const session=await loadSession(),method=String(options.method||'GET').toUpperCase(),headers={...(options.headers||{})};
  if(!['GET','HEAD'].includes(method))headers['x-csrf-token']=session.csrfToken;
  const response=await fetch(url,{...options,headers});
  if(response.status===401){sessionPromise=null;location.replace(loginLocation());throw new Error('登录已失效');}
  return response;
}
function dialogMarkup(){return `<dialog id="accountDialog" class="account-dialog" aria-labelledby="accountDialogTitle"><form id="passwordForm"><header><div><h2 id="accountDialogTitle">账户与安全</h2><p id="accountDialogSubtitle"></p></div><button type="button" class="icon-button" data-account-close aria-label="关闭"><svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header><div class="dialog-body"><section class="account-section"><h3>修改密码</h3><label class="field">当前密码<input id="currentPassword" type="password" autocomplete="current-password" required></label><label class="field">新密码<input id="newPassword" type="password" autocomplete="new-password" minlength="12" maxlength="128" required><small>至少 12 个字符。</small></label><label class="field">确认新密码<input id="confirmPassword" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label><p class="form-error" id="accountError" role="alert"></p><button class="button primary">更新密码</button></section><section class="account-section"><div class="account-section-head"><div><h3>最近安全记录</h3><p>登录、退出和账户安全操作。</p></div><button type="button" class="button subtle" id="revokeOthers">注销其他会话</button></div><div class="audit-list" id="auditList"><p>正在读取…</p></div></section></div><footer><button type="button" class="button" data-account-close>完成</button></footer></form></dialog>`;}
function auditLabel(event){return {login:'登录',logout:'退出登录',password_change:'修改密码',session_revoke:'注销其他会话'}[event]||event;}
async function openAccount(session){
  const dialog=document.querySelector('#accountDialog');document.querySelector('#accountDialogSubtitle').textContent=`管理员：${session.user.username}`;dialog.showModal();
  const list=document.querySelector('#auditList');list.innerHTML='<p>正在读取…</p>';try{const response=await authFetch('/api/auth/audit?limit=20');const data=await response.json();list.replaceChildren();
    for(const item of data.items){const row=document.createElement('div');row.className='audit-item';const main=document.createElement('div'),title=document.createElement('b'),meta=document.createElement('small');title.textContent=`${auditLabel(item.eventType)} · ${item.success?'成功':'失败'}`;meta.textContent=`${new Date(`${item.createdAt}Z`).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})} · ${item.ipAddress||'未知来源'}`;main.append(title,meta);row.append(main);list.append(row);}if(!data.items.length)list.innerHTML='<p>暂无安全记录</p>';
  }catch(reason){list.innerHTML='<p>安全记录读取失败</p>';}
}
export async function mountAccountMenu(){
  const session=await loadSession(),head=document.querySelector('.page-head');if(!head)return;
  const details=document.createElement('details');details.className='account-control';details.innerHTML='<summary aria-label="打开账户菜单"><span class="account-avatar">A</span><span class="account-name"></span><svg viewBox="0 0 24 24"><path d="m7 9 5 5 5-5"/></svg></summary><div><button type="button" data-account>账户与安全</button><button type="button" data-logout>退出登录</button></div>';details.querySelector('.account-name').textContent=session.user.username;details.querySelector('.account-avatar').textContent=session.user.username.slice(0,1).toUpperCase();
  let actions=head.querySelector('.head-actions');if(!actions){actions=document.createElement('div');actions.className='head-actions';[...head.children].slice(1).forEach(child=>actions.append(child));head.append(actions);}actions.append(details);
  document.body.insertAdjacentHTML('beforeend',dialogMarkup());
  details.querySelector('[data-account]').addEventListener('click',()=>{details.open=false;openAccount(session);});
  details.querySelector('[data-logout]').addEventListener('click',async()=>{await authFetch('/api/auth/logout',{method:'POST'});location.replace('/login.html');});
  document.querySelectorAll('[data-account-close]').forEach(control=>control.addEventListener('click',()=>document.querySelector('#accountDialog').close()));
  document.querySelector('#revokeOthers').addEventListener('click',async event=>{event.currentTarget.disabled=true;try{const response=await authFetch('/api/auth/logout-all',{method:'POST'}),data=await response.json();event.currentTarget.textContent=`已注销 ${data.revoked} 个会话`;}finally{event.currentTarget.disabled=false;}});
  document.querySelector('#passwordForm').addEventListener('submit',async event=>{event.preventDefault();const current=document.querySelector('#currentPassword').value,next=document.querySelector('#newPassword').value,confirm=document.querySelector('#confirmPassword').value,problem=document.querySelector('#accountError');problem.textContent='';if(next!==confirm){problem.textContent='两次输入的新密码不一致';return;}const submit=event.submitter;submit.disabled=true;try{const response=await authFetch('/api/auth/change-password',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({currentPassword:current,newPassword:next})}),data=await response.json();if(!response.ok)throw new Error(data.error||'密码更新失败');session.csrfToken=data.csrfToken;sessionPromise=Promise.resolve({...session,csrfToken:data.csrfToken,expiresAt:data.expiresAt});event.currentTarget.reset();problem.classList.add('success');problem.textContent='密码已更新，其他会话已注销。';openAccount(session);}catch(reason){problem.classList.remove('success');problem.textContent=reason.message;}finally{submit.disabled=false;}});
}
