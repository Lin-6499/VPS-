const form=document.querySelector('#loginForm'),username=document.querySelector('#username'),password=document.querySelector('#password');
const error=document.querySelector('#loginError'),button=document.querySelector('#loginButton'),toggle=document.querySelector('#togglePassword'),caps=document.querySelector('#capsNotice');
function destination(){const value=new URLSearchParams(location.search).get('next')||'/';return value.startsWith('/')&&!value.startsWith('//')?value:'/';}
toggle.addEventListener('click',()=>{const visible=password.type==='text';password.type=visible?'password':'text';toggle.textContent=visible?'显示':'隐藏';toggle.setAttribute('aria-label',visible?'显示密码':'隐藏密码');password.focus();});
password.addEventListener('keyup',event=>{caps.hidden=!event.getModifierState('CapsLock');});
form.addEventListener('submit',async event=>{event.preventDefault();error.textContent='';button.disabled=true;button.textContent='正在验证…';try{
  const response=await fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:username.value,password:password.value,remember:document.querySelector('#remember').checked})});
  const payload=await response.json();if(!response.ok)throw new Error(payload.error||'登录失败');location.replace(destination());
}catch(reason){error.textContent=reason.message;}finally{button.disabled=false;button.textContent='登录';}});
