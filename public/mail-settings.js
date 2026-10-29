import { el } from './dom.js';
import { state } from './state.js';
import { api } from './api.js';
import { panel, notice, errorNotice } from './ui.js';
import { CANCEL, field, switchRow, confirmAction, bindForm } from './ui-form.js';

export function mailSettingsView(initial) {
  let mail = initial;
  let testing = false;
  const editable = mail.editable !== false;
  const status = el('span',{class:'badge',text:mail.configured ? '已启用' : '未启用'});
  const testResult = el('div',{'aria-live':'polite'});
  const form = el('form',{'aria-label':'邮件配置'},
    !editable ? notice('邮件由环境变量管理','配置项只读。可以测试服务器当前的连接和投递，但不能覆盖环境凭据。','warn') : null,
    switchRow('启用邮件服务','停用会保留凭据，同时关闭验证邮件和密码找回。','enabled',mail.enabled !== false),
    el('div',{class:'settings-field-grid'},
      field('SMTP 主机','host',{required:true,value:mail.host||'',placeholder:'smtp.example.com',autocomplete:'off'}),
      field('端口','port',{type:'number',required:true,min:1,max:65535,value:mail.port||587,hint:'465 使用隐式 TLS，587 通常使用 STARTTLS。'}),
      field('用户名','username',{value:mail.username||'',autocomplete:'off',hint:'匿名中继可不填；设置用户名后需要密码。'}),
      field('密码','password',{type:'password',autocomplete:'new-password',placeholder:mail.password_configured?'已配置，留空保持不变':'SMTP 密码',hint:'更换主机、端口、用户名或 TLS 模式时，请重新输入密码。'}),
      field('发件邮箱','from',{required:true,type:'email',value:mail.from||''}),
      field('发件人名称','from_name',{maxlength:80,value:mail.from_name||''})),
    switchRow('使用 TLS','465 始终加密；其他端口开启时要求 STARTTLS。关闭仅适用于可信中继。','use_tls',mail.use_tls !== false),
    editable ? el('div',{class:'button-row'},el('button',{class:'btn primary',type:'submit',text:'保存邮件配置'}),el('button',{class:'btn danger',type:'button',text:'清除邮件配置',onclick:async()=>{
      if(testing || form.dataset.busy === 'true') return;
      if(!await confirmAction('清除邮件配置','将删除网页保存的 SMTP 配置，验证邮件和密码找回会停止工作。','清除配置',true)) return;
      testing=true;
      const controls=[...form.querySelectorAll('input,button')].map(node=>[node,node.disabled]);
      controls.forEach(([node])=>node.disabled=true);
      try {
        const data=await api('/api/admin/mail',{method:'PATCH',body:{expected_revision:mail.revision,mail:{host:''}}});
        mail=data.mail; state.public.features=data.features;
        for(const name of ['host','username','password','from','from_name']) form.elements[name].value='';
        form.elements.port.value=mail.port;form.elements.use_tls.checked=mail.use_tls;form.elements.enabled.checked=mail.enabled;
        form.elements.password.placeholder='SMTP 密码';
        status.textContent='未启用'; testResult.replaceChildren();
        form.querySelector('.form-message').replaceChildren(notice('邮件配置已清除','可以重新填写并在保存前测试。','success'));
      } catch(error) { form.querySelector('.form-message').replaceChildren(errorNotice(error)); }
      finally { testing=false; controls.forEach(([node,disabled])=>node.disabled=disabled); }
    }})) : null);
  if(!editable) for(const control of form.querySelectorAll('input')) control.disabled=true;
  function draft(values) {
    return {enabled:values.get('enabled')==='on',host:values.get('host').trim(),port:Number(values.get('port')),username:values.get('username').trim(),password:values.get('password'),from:values.get('from').trim(),from_name:values.get('from_name').trim(),use_tls:values.get('use_tls')==='on'};
  }
  bindForm(form,async values=>{
    if(testing || !editable) return CANCEL;
    if(!await confirmAction('保存邮件配置','保存当前表单。留空的密码保留原值；测试不会自动保存。','确认保存')) return CANCEL;
    return api('/api/admin/mail',{method:'PATCH',body:{expected_revision:mail.revision,mail:draft(values)}});
  },(data,message)=>{
    mail=data.mail; state.public.features=data.features;
    form.elements.password.placeholder=mail.password_configured?'已配置，留空保持不变':'SMTP 密码';
    status.textContent=mail.configured?'已启用':'未启用';
    message.replaceChildren(notice('邮件配置已保存',mail.configured?'后续邮件投递将使用此配置。':'配置已保留，邮件投递处于停用状态。','success'));
  });
  const recipient = field('测试收件邮箱','recipient',{type:'email',placeholder:'you@example.com',value:state.user?.email||'',hint:'只向此地址发送一封测试邮件，不创建用户或注册令牌。'});
  const testPanel = el('div',{},notice('先测试，再保存','连接测试和试发邮件都使用当前表单，无需先保存。密码留空仅在 SMTP 目标不变时复用已保存密码。'),recipient,
    el('div',{class:'button-row'},...['connection','send'].map(mode=>el('button',{class:mode==='send'?'btn primary':'btn',type:'button',text:mode==='send'?'发送测试邮件':'测试连接',onclick:async()=>{
      if(testing || form.dataset.busy==='true') return;
      const input=recipient.querySelector('input');
      if(editable && !form.reportValidity()) return;
      if(mode==='send' && (!input.value.trim() || !input.reportValidity())) { input.focus(); if(!input.value.trim()) testResult.replaceChildren(notice('请填写测试收件邮箱','发送测试邮件需要一个收件地址。','warn')); return; }
      const body={...(editable?{mail:draft(new FormData(form))}:{}),...(mode==='send'?{recipient:input.value.trim()}:{})};
      const controls=[...form.querySelectorAll('input,button'),...testPanel.querySelectorAll('input,button')].map(node=>[node,node.disabled]);
      testing=true; controls.forEach(([node])=>node.disabled=true);
      testResult.replaceChildren(notice(mode==='send'?'正在发送测试邮件…':'正在测试连接…','使用本次表单快照，不会保存配置。'));
      try {
        await api('/api/admin/mail/test',{method:'POST',body});
        testResult.replaceChildren(notice(mode==='send'?'测试邮件已提交':'连接和认证通过',mode==='send'?'SMTP 已接受邮件，请检查收件箱和垃圾邮件；这不保证最终送达。':'连接测试不验证发件人是否获准投递。请继续试发邮件，然后保存配置。','success'));
      } catch(error) { testResult.replaceChildren(errorNotice(error)); }
      finally { testing=false; controls.forEach(([node,disabled])=>node.disabled=disabled); }
    }}))),testResult);
  form.addEventListener('input',()=>testResult.replaceChildren());
  return el('section',{id:'mail',class:'settings-section'},
    panel('邮件配置','SMTP 凭据只保存在服务端，不回显到页面。',el('div',{class:'card-body'},el('div',{class:'button-row'},el('strong',{text:'邮件状态'}),status),form)),
    panel('测试与诊断','独立验证连接、认证和测试投递。测试成功不等于配置已经保存。',el('div',{class:'card-body'},testPanel)));
}
