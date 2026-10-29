import { el } from './dom.js';
import { state } from './state.js';
import { api } from './api.js';
import { navigate } from './router.js';
import { toast, badge, notice, panel, supportContact } from './ui.js';
import { CANCEL, field, confirmAction, bindForm } from './ui-form.js';
export async function profileView() {
  const user = state.user;
  const form = el('form',{class:'form-narrow'},field('当前密码','current_password',{type:'password',required:true,autocomplete:'current-password',maxlength:256}),field('新密码','new_password',{type:'password',required:true,minlength:7,maxlength:256,autocomplete:'new-password',hint:'至少 7 个字符，建议使用未在其他站点用过的密码。'}),field('确认新密码','confirmation',{type:'password',required:true,minlength:7,maxlength:256,autocomplete:'new-password'}),el('button',{class:'btn primary',type:'submit',text:'更新密码'}));
  bindForm(form,async values => {
    if (values.get('new_password') !== values.get('confirmation')) throw new Error('两次输入的新密码不一致。');
    if (!await confirmAction('更新登录密码','确认修改当前账户的密码？更新后请使用新密码重新登录。','更新密码')) return CANCEL;
    return api('/api/auth/password',{method:'PATCH',body:{current_password:values.get('current_password'),new_password:values.get('new_password')}});
  },(data,message) => { if (data.ok !== true) throw Object.assign(new Error('密码更新尚未确认。'),{uncertain:true}); state.user = null; state.csrf = null; state.returnTo = '/profile'; navigate('/login',true); toast('密码已更新，请使用新密码重新登录。'); });
  return el('div',{class:'equal-col'},panel('账户信息','身份由当前服务端会话确定',el('div',{class:'card-body'},el('div',{class:'identity-card'},el('span',{class:'avatar',text:(user.display_name || user.email).slice(0,1).toUpperCase()}),el('div',{},el('h2',{text:user.display_name}),el('p',{class:'muted',text:user.email}))),el('dl',{class:'detail-list'},el('dt',{text:'账户角色'}),el('dd',{},badge(user.role)),el('dt',{text:'账户状态'}),el('dd',{},badge(user.status)),el('dt',{text:'账号交付'}),el('dd',{},el('a',{href:'/accounts',text:'查看我的账号'}))),el('hr',{class:'form-divider'}),notice('需要修改账户资料？','显示名称和邮箱不能在这里修改。'+supportContact()))),panel('登录安全',user.must_change_password?'当前使用临时密码，请先设置自己的新密码，完成后重新登录。':'修改您的站点登录密码',el('div',{class:'card-body'},form)));
}
