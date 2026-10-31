import { el } from './dom.js';
import { app, state, adoptSession } from './state.js';
import { api } from './api.js';
import { navigate } from './router.js';
import { brand, themeButton } from './layout.js';
import { notice, supportContact, toast } from './ui.js';
import { CANCEL, field, confirmAction, bindForm } from './ui-form.js';
// Static illustration of the connection flow; never reads account, device or verification data.
function artwork() {
  const lines = [
    ['~/shop $','ccb login','cmd auth-terminal-desktop-only'],
    ['', '连接码由终端生成，在浏览器里输入并确认这台设备','dim auth-terminal-desktop-only'],
    ['✓','设备已确认 · MacBook Pro','ok auth-terminal-desktop-only'],
    ['~/shop $','ccb account','cmd'],
    ['●','Claude Max','account current'],
    ['○','Claude Pro','account auth-terminal-desktop-only'],
    ['~/shop $','ccb','cmd launch'],
    ['◆','已连接 Claude Max，正在启动 Claude Code','live auth-terminal-desktop-only'],
  ];
  return el('div',{class:'auth-terminal','aria-hidden':'true',title:'连接流程示意，非当前账号或设备状态'},
    el('div',{class:'auth-terminal-bar'},el('i'),el('i'),el('i'),el('span',{text:'~/shop — ccb'})),
    el('div',{class:'auth-terminal-body'},lines.map(([mark,text,kind]) => el('p',{class:kind},
      mark ? el('span',{class:'auth-terminal-marker',text:mark}) : null,
      kind.startsWith('account') ? el('span',{class:'auth-terminal-account-name',text}) : text,
      kind.startsWith('live') ? el('span',{class:'auth-terminal-cursor'}) : kind.includes('launch') ? el('span',{class:'auth-terminal-cursor auth-terminal-cursor-mobile'}) : null))));
}
function registrationPolicyNote() {
  const site = state.public?.site || {};
  const list = Array.isArray(site.registration_email_suffix_whitelist) ? site.registration_email_suffix_whitelist : [];
  if (!list.length) return null;
  const domains = list.join('、');
  const text = site.registration_email_domain_quota_enabled === true
    ? `这些域名不限注册数量：${domains}。其他域名每个最多注册一个账户。`
    : `仅允许这些邮箱域名：${domains}。`;
  return el('p',{class:'inline-info',text});
}
function resendVerificationForm() {
  const form = el('form',{class:'form-narrow'},field('电子邮箱','email',{type:'email',required:true,maxlength:254,autocomplete:'email',placeholder:'you@example.com'}),el('button',{class:'btn',type:'submit',text:'重新发送验证邮件'}));
  bindForm(form, values => api('/api/auth/resend-verification',{method:'POST',body:{email:values.get('email').trim()}}), (data, message) => {
    if (data.ok !== true) throw new Error('服务器尚未确认是否发送。');
    message.replaceChildren(notice('已提交','如果这个邮箱仍需验证，我们已重新发送 15 分钟内有效的 6 位验证码。已经可以登录的账户不会修改密码，也不会收到验证码。请检查垃圾邮件。','success'));
  });
  return el('div',{class:'resend-verification'},el('p',{class:'inline-info',text:'没收到邮件？填写邮箱即可重发，不需要密码。'}),form);
}
function authUnavailable(path) {
  if (path === '/setup') return '站点已完成初始化，请直接登录。';
  if (path === '/register') return (state.public.site?.registration_enabled === true ? '已允许自助注册，但邮箱验证需要先配置邮件服务。' : '站点当前未开放自助注册。') + supportContact();
  if (path === '/verify') return '邮箱验证尚未开启，或邮件服务还没配置。' + supportContact();
  return '邮件服务尚未配置，暂时不能找回或重置密码。' + supportContact();
}
function registerResultCopy(data) {
  if (data.status === 'verification_required') {
    const base = '请查看邮箱。新注册或尚未验证的账户会收到 15 分钟内有效的 6 位验证码，并使用你刚刚填写的密码。已经可以登录的账户不会被修改，请用原密码登录或找回密码。';
    return data.delivery === 'unconfirmed' ? base + '邮件服务器没有确认发出，请稍后用同一邮箱重新发送。' : base;
  }
  return '如果这是新账户，现在可以用刚刚设置的密码登录。权益仍需管理员分配。如果这个邮箱已经注册，本次不会覆盖原密码。';
}
export function renderAuth(path) {
  const features = state.public.features;
  const labels = {
    '/login':['欢迎回来','使用邮箱和密码登录。','登录'],
    '/setup':['初始化','使用本机的一次性初始化令牌创建管理员。令牌、上游密钥和管理员密码是三项不同凭证。','创建管理员'],
    '/register':['创建您的账户','注册只创建登录账户。资源需要管理员另行分配。','创建账户'],
    '/verify':['验证电子邮箱','输入邮件里的 6 位验证码。验证码 15 分钟内有效，最多可以尝试 5 次。','确认验证'],
    '/forgot':['找回您的密码','输入注册邮箱。可以重置的账户会收到重置邮件；尚未验证的账户会收到验证码。','发送重置邮件'],
    '/reset':['设置新密码','使用重置邮件中的令牌设置新密码。链接 30 分钟内有效。','重置密码'],
  };
  const [title,description,submitLabel] = labels[path];
  document.title = `${title} · ${state.public.site.name}`;
  const inner = el('div',{class:'auth-form'},el('h1',{text:title}),el('p',{class:'auth-description',text:description}));
  const disabled = (path === '/setup' && !state.public.setup_required) || (path === '/register' && features.registration !== true) || (path === '/verify' && features.email_verification !== true) || (['/forgot','/reset'].includes(path) && features.password_reset !== true);
  if (disabled) inner.append(notice('此功能当前不可用',authUnavailable(path),'warn'),el('div',{class:'auth-links'},el('a',{href:'/login',text:'返回登录'})));
  else {
    const form = el('form',{});
    const resendHost = el('div');
    if (path === '/setup') form.append(field('初始化令牌','setup_token',{type:'password',required:true,autocomplete:'off',hint:'仅在服务器终端或受保护文件中提供，不会保存在浏览器。'}));
    if (['/setup','/register'].includes(path)) form.append(field('显示名称','display_name',{required:true,maxlength:100,autocomplete:'name',placeholder:'您希望如何被称呼'}));
    if (['/login','/setup','/register','/forgot','/verify'].includes(path)) form.append(field('电子邮箱','email',{type:'email',required:true,autocomplete:'email',maxlength:254,placeholder:'you@example.com'}));
    if (path === '/register') { const note = registrationPolicyNote(); if (note) form.append(note); }
    if (path === '/verify') form.append(field('验证码','code',{required:true,inputmode:'numeric',autocomplete:'one-time-code',minlength:6,maxlength:6,pattern:'[0-9]{6}',placeholder:'6 位数字',spellcheck:'false',hint:'验证码 15 分钟内有效，连续输错 5 次后需要重新发送。'}));
    if (path === '/reset') form.append(field('重置令牌','token',{type:'password',required:true,autocomplete:'off',value:state.token,spellcheck:'false',hint:'重置链接 30 分钟内有效。令牌已从地址栏移除，请勿分享。'}));
    if (['/login','/setup','/register','/reset'].includes(path)) form.append(field(path === '/reset' ? '新密码' : '密码','password',{type:'password',required:true,autocomplete:path === '/login' ? 'current-password' : 'new-password',...(path === '/login' ? {} : {minlength:7}),maxlength:256,placeholder:path === '/login' ? '请输入您的密码' : '至少 7 个字符'}));
    if (['/setup','/register','/reset'].includes(path)) form.append(field('确认密码','confirmation',{type:'password',required:true,autocomplete:'new-password',minlength:7,maxlength:256}));
    form.append(el('button',{class:'btn primary',type:'submit',text:submitLabel}));
    bindForm(form,async values => {
      if (values.has('confirmation') && values.get('password') !== values.get('confirmation')) throw new Error('两次输入的密码不一致。');
      if (path === '/setup' && !await confirmAction('创建首位管理员','此操作将完成站点初始化。请确认邮箱、显示名称与密码已正确填写。','确认初始化')) return CANCEL;
      const payload = Object.fromEntries(values); delete payload.confirmation;
      const endpoint = {'/setup':'/api/setup','/login':'/api/auth/login','/register':'/api/auth/register','/verify':'/api/auth/verify','/forgot':'/api/auth/forgot-password','/reset':'/api/auth/reset-password'}[path];
      return api(endpoint,{method:'POST',body:payload});
    },(data,message) => {
      if (path === '/login' || path === '/setup') {
        adoptSession(data); if (path === '/setup') state.public.setup_required = false; const next = path==='/setup'?'/admin/settings#upstream':state.returnTo; state.returnTo = '/'; navigate(next,true);
      } else {
        if (path === '/register' && (!['created','verification_required'].includes(data.status) || (data.delivery && !['sent','unconfirmed','not_required'].includes(data.delivery)))) throw new Error('注册结果无法识别，请联系管理员确认。');
        if (path !== '/register' && data.ok !== true) throw new Error('服务器尚未确认操作完成，请联系管理员确认。');
        state.token = ''; form.querySelector('input[name=token]')?.setAttribute('value','');
        const input = form.querySelector('input[name=token]'); if (input) input.value = '';
        form.querySelector('button[type=submit]').textContent = '已提交';
        const messages = {'/register':registerResultCopy(data),'/verify':'邮箱已验证，请返回登录。','/forgot':'如果这个邮箱可以重置密码，你会收到 30 分钟内有效的重置邮件。如果账户还没完成验证，你会收到验证码，而不是重置链接。请同时检查垃圾邮件。','/reset':'密码已重置，请使用新密码登录。'};
        const done = path === '/register' && data.status === 'verification_required'
          ? el('div',{class:'auth-links'},el('a',{class:'btn small',href:'/verify',text:'输入验证码'}),el('a',{class:'btn small',href:'/login',text:'返回登录'}))
          : el('a',{class:'btn small',href:'/login',text:'返回登录'});
        message.replaceChildren(notice('请求已完成',messages[path],'success',done));
        if (path === '/register' && data.status === 'verification_required') resendHost.replaceChildren(resendVerificationForm());
      }
    });
    if (path === '/verify') {
      const resend = el('button',{class:'btn',type:'button',text:'重新发送验证码'});
      resend.addEventListener('click', async () => {
        resend.disabled = true;
        try {
          const data = await api('/api/auth/resend-verification',{method:'POST',body:{email:form.querySelector('input[name=email]').value.trim()}});
          if (data.ok !== true) throw new Error('服务器尚未确认是否发送。');
          toast('如果这个邮箱仍需验证，我们已重新发送 15 分钟内有效的验证码。请检查垃圾邮件。');
        } catch (error) { toast(error.message || '暂时无法发送验证码。'); }
        finally { resend.disabled = false; }
      });
      form.append(resend);
    }
    inner.append(form, resendHost);
    const links = el('div',{class:'auth-links'});
    if (path === '/login') {
      if (features.password_reset === true) links.append(el('a',{href:'/forgot',text:'忘记密码？'}));
      if (features.registration === true) links.append(el('a',{href:'/register',text:'创建账户 →'}));
      if (state.public.setup_required) links.append(el('a',{href:'/setup',text:'初始化站点 →'}));
    } else links.append(el('a',{href:'/login',text:'← 返回登录'}));
    inner.append(links);
  }
  const support = String(state.public?.site?.support_email || '').trim();
  if (support) inner.append(el('p',{class:'inline-info'},'需要帮助？',el('a',{href:`mailto:${support}`,text:support})));
  if (path === '/login' && state.returnTo.startsWith('/connect')) inner.append(notice('登录后继续开始使用','我们会在登录后返回开始使用页面。登录本身不会授权设备。'));
  app.replaceChildren(el('main',{class:'auth-page',id:'main'},el('aside',{class:'auth-art'},brand(),el('div',{class:'auth-art-copy'},el('h1',{},'独家防封，',el('br'),'用着不烧心。'),el('p',{text:'一键获取独享账号 · 畅用 Claude'})),artwork()),el('section',{class:'auth-form-side'},themeButton('auth-theme'),inner)));
}
