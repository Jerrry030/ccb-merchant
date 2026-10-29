import { normalizeRegistrationEmailSuffixDomain, isRegistrationEmailSuffixDomainValid, parseRegistrationEmailSuffixWhitelistInput } from './registration-policy.js';
import { mailSettingsView } from './mail-settings.js';
import { paymentSettingsView } from './payment-settings.js';
import { el, icon } from './dom.js';
import { state } from './state.js';
import { api } from './api.js';
import { badge, notice, panel } from './ui.js';
import { CANCEL, field, switchRow, confirmAction, bindForm } from './ui-form.js';
function emailSuffixEditor(initial) {
  let tags = [];
  const seen = new Set();
  for (const item of initial || []) {
    const domain = normalizeRegistrationEmailSuffixDomain(item);
    if (!isRegistrationEmailSuffixDomainValid(domain) || seen.has(domain)) continue;
    seen.add(domain); tags.push(domain);
  }
  const box = el('div',{class:'tag-box'});
  const input = el('input',{type:'text',autocomplete:'off',spellcheck:'false',placeholder:'@example.com, *.edu.cn','aria-label':'添加邮箱域名'});
  const paint = () => box.replaceChildren(...tags.map(tag => el('span',{class:'tag'},el('span',{text:tag}),el('button',{type:'button','aria-label':'移除 ' + tag,text:'×',onclick:() => { tags = tags.filter(item => item !== tag); paint(); }}))), input);
  const add = raw => {
    const domain = normalizeRegistrationEmailSuffixDomain(raw);
    if (!isRegistrationEmailSuffixDomainValid(domain) || tags.includes(domain)) return;
    tags = [...tags, domain];
  };
  input.addEventListener('input',() => { input.value = normalizeRegistrationEmailSuffixDomain(input.value); });
  input.addEventListener('keydown',event => {
    if (event.isComposing) return;
    if ([' ','Enter','Tab',',','，'].includes(event.key)) { event.preventDefault(); add(input.value); input.value = ''; paint(); return; }
    if (event.key === 'Backspace' && !input.value && tags.length) { tags.pop(); paint(); }
  });
  input.addEventListener('paste',event => {
    const text = event.clipboardData?.getData('text') || '';
    if (!text.trim()) return;
    event.preventDefault();
    for (const token of parseRegistrationEmailSuffixWhitelistInput(text)) add(token);
    input.value = ''; paint();
  });
  input.addEventListener('blur',() => { if (input.value) { add(input.value); input.value = ''; paint(); } });
  paint();
  return {node:box, value:() => tags.map(tag => tag.startsWith('*.') ? tag : '@' + tag)};
}
export async function settingsView() {
  const [settings, connection, mailData, paymentData] = await Promise.all([api('/api/admin/settings'), api('/api/admin/connection'), api('/api/admin/mail'), api('/api/admin/payment')]);
  const form = el('form',{},
    field('站点名称','name',{required:true,maxlength:100,value:settings.site?.name}),
    field('站点简介','description',{type:'textarea',maxlength:500,value:settings.site?.description}),
    field('Logo 地址（HTTPS，可选）','logo_url',{type:'url',value:settings.site?.logo_url || ''}),
    field('品牌主色','accent_color',{type:'color',value:settings.site?.accent_color || '#7c5cff'}),
    field('支持邮箱','support_email',{type:'email',maxlength:254,value:settings.site?.support_email || '',hint:'对外联系邮箱。注册允许哪些域名，在下方的邮箱域名白名单中设置。'}),
    switchRow('允许用户自助注册','关闭后不能自助注册。邮箱验证开启时，还需要先配好邮件服务。','registration_enabled',settings.registration?.enabled ?? settings.features?.registration === true),
    el('button',{class:'btn primary',type:'submit',text:'保存公开设置'}));
  bindForm(form,async values => {
    if (!await confirmAction('保存站点公开设置','将修改展示信息与注册开关。不会修改上游密钥、邮件或支付凭据。','确认保存')) return CANCEL;
    return api('/api/admin/settings',{method:'PATCH',body:{name:values.get('name').trim(),description:values.get('description').trim(),support_email:values.get('support_email').trim(),logo_url:values.get('logo_url').trim(),accent_color:values.get('accent_color'),registration_enabled:values.get('registration_enabled') === 'on'}});
  },(data,message) => {
    if (!data.site || !data.features) throw Object.assign(new Error('站点设置更新结果不完整。'),{uncertain:true});
    state.public.site = data.site; state.public.features = data.features;
    if (/^#[0-9a-fA-F]{6}$/.test(data.site.accent_color || '')) document.documentElement.style.setProperty('--brand',data.site.accent_color);
    document.querySelectorAll('.brand-name').forEach(node => node.textContent = data.site.name);
    message.replaceChildren(notice('公开设置已保存','展示信息和注册开关已由服务器确认。','success'));
  });
  const upstream = el('div',{id:'upstream',class:'settings-section'});
  upstream.append(notice('使用直接上级签发的密钥','初始化令牌只用于创建管理员。不要填写平台管理员密钥，也不要填写上级自己的接入密钥。','warn'));
  upstream.append(panel('上游接入','地址和权限来自服务端，密钥原文不会返回。',el('div',{class:'card-body'},
    el('div',{class:'connection-box'},el('div',{class:'button-row'},icon('link'),el('strong',{text:'上游服务连接'}),el('span',{class:`badge ${connection.available === true ? 'good' : 'warn'}`,text:connection.configured === true ? (connection.available === true ? '已连接' : '已配置 · 暂不可用') : '未配置'}))),
    connection.error ? notice('上游暂不可用',`请核对接地址、密钥和允许的来源。服务端状态：${connection.error}`,'warn') : null,
    el('dl',{class:'detail-list'},
      el('dt',{text:'公开地址'}),el('dd',{class:'mono',text:connection.public_origin || location.origin}),
      el('dt',{text:'上游地址'}),el('dd',{'data-upstream-summary':'url',class:'mono',text:connection.upstream_url || '未配置'}),
      el('dt',{text:'上游用户'}),el('dd',{'data-upstream-summary':'name',text:connection.user?.name || '尚未核实'}),
      el('dt',{text:'连接状态'}),el('dd',{'data-upstream-summary':'status'},badge(connection.available ? 'active' : 'pending'))),
    el('p',{class:'inline-info',text:'公开地址由服务端的 PUBLIC_ORIGIN 决定，上级不登记或限制域名。更换后请同步邮件和支付配置并重启。'}),
    el('h3',{text:'已声明的权限'}),
    el('p',{class:'inline-info mono',text:Array.isArray(connection.scopes) && connection.scopes.length ? connection.scopes.join(' · ') : '尚未获取权限信息'}))));
  if (connection.environment_managed) upstream.append(notice('上游由环境配置管理','请修改服务端 UPSTREAM_URL 与 UPSTREAM_API_KEY 后重启。此页不会覆盖环境配置，也不会回显密钥。','warn'));
  else {
    let revision = connection.revision;
    const output = el('div',{});
    const upstreamForm = el('form',{},
      field('上游服务地址','url',{required:true,type:'url',value:connection.upstream_url || '',placeholder:'https://your-provider.example',hint:'只填写协议、域名和可选端口。私网或 HTTP 地址需由部署者在 UPSTREAM_ALLOWED_ORIGINS 中明确允许。'}),
      field('上游接入密钥','api_key',{required:true,type:'password',autocomplete:'off',spellcheck:'false',placeholder:'ccbk_…',hint:'由直接上级单独签发。不会写入浏览器存储。'}),
      field('接入操作','action',{type:'select',choices:[{value:'verify',label:'仅验证，不保存'},{value:'save',label:'验证并保存'}],value:'verify'}),
      el('button',{type:'submit',class:'btn primary',text:'执行接入检查'}));
    bindForm(upstreamForm,async values => {
      const body = {action:values.get('action'),url:values.get('url').trim(),api_key:values.get('api_key').trim(),expected_revision:revision};
      if (body.action === 'save' && !await confirmAction('保存上游连接','将先验证上游身份、协议版本和权限，再把密钥加密保存在服务端。已有业务数据不能改绑到另一个上游身份。','确认保存')) return CANCEL;
      return api('/api/admin/upstream',{method:'POST',body});
    },data => {
      revision = data.revision;
      const current = data.connection;
      output.replaceChildren(notice(data.saved ? '上游连接已保存' : '连接验证通过，尚未保存',`${current.user.name} · 直接接入账户`,'success'),el('p',{class:'inline-info',text:`已授权权限：${current.scopes.join(' · ')}`}),el('a',{href:'/admin/inventory',class:'btn',text:'查看账号库存 →'}));
      if (data.saved) {
        state.public.features.term_rentals = true;
        upstreamForm.querySelector('[name=api_key]').value = '';
        upstream.querySelector('[data-upstream-summary=url]').textContent = new URL(upstreamForm.querySelector('[name=url]').value).origin;
        upstream.querySelector('[data-upstream-summary=name]').textContent = current.user.name;
        upstream.querySelector('[data-upstream-summary=status]').replaceChildren(badge('active'));
      }
    });
    upstream.append(panel('上游接入配置','先验证身份与权限，再保存。网络拒绝或验证失败不会替换当前配置。',el('div',{class:'card-body'},upstreamForm,output)));
  }
  upstream.append(el('a',{href:'/',class:'btn',text:'稍后配置，返回首页'}));
  const suffixes = emailSuffixEditor(settings.registration?.email_suffix_whitelist || settings.site?.registration_email_suffix_whitelist || []);
  const registrationForm = el('form',{},
    el('p',{class:'field-title',text:'邮箱域名白名单'}),
    el('p',{class:'inline-info',text:'仅允许使用指定域名的邮箱注册账号；留空则不限制（例如 @qq.com, @gmail.com, *.edu.cn）'}),
    suffixes.node,
    el('p',{class:'inline-info',text:'留空则不限制。使用 *.edu.cn 可匹配 edu.cn 及其子域名。按回车、逗号或失焦加入，退格可删除最后一项。'}),
    switchRow('邮箱验证','新用户注册时需要验证邮箱。关闭后，开放注册不必先配置邮件服务；密码找回仍需要邮件服务。','email_verification_enabled',settings.registration?.email_verification_enabled !== false),
    switchRow('非白名单域名限量注册','开启后，白名单非空时，其他域名各限注册一个账户；关闭时非白名单域名直接拒绝。白名单为空时本开关无效果。','email_domain_quota_enabled',settings.registration?.email_domain_quota_enabled === true),
    el('button',{class:'btn primary',type:'submit',text:'保存注册设置'}));
  bindForm(registrationForm,async values => {
    if (!await confirmAction('保存注册设置','将更新邮箱域名白名单、邮箱验证和限量注册。不会修改邮件或支付凭据。','确认保存')) return CANCEL;
    return api('/api/admin/settings',{method:'PATCH',body:{email_suffix_whitelist:suffixes.value(),email_verification_enabled:values.get('email_verification_enabled')==='on',email_domain_quota_enabled:values.get('email_domain_quota_enabled')==='on'}});
  },(data,message) => {
    if (!data.registration || !data.features) throw Object.assign(new Error('注册设置更新结果不完整。'),{uncertain:true});
    state.public.features = data.features; if (data.site) state.public.site = data.site;
    message.replaceChildren(notice('注册设置已保存','白名单和验证开关已由服务器确认。','success'));
  });
  const registration = el('div',{id:'registration',class:'settings-section'},panel('注册设置','控制用户注册和验证',el('div',{class:'card-body'},registrationForm)));
  const mailPage = mailSettingsView(mailData.mail);
  const paymentPage = paymentSettingsView(paymentData.payment);
  const pages = [
    ['public','公开信息',el('section',{id:'public',class:'settings-section'},panel('公开站点信息','名称、简介、标识和注册开关会显示在登录页和各页面。',el('div',{class:'card-body'},form)))],
    ['registration','注册设置',registration],
    ['upstream','上游连接',upstream],
    ['mail','邮件配置',mailPage],
    ['payment','支付配置',paymentPage],
  ];
  const selected = new Set(pages.map(([id]) => id)).has(location.hash.slice(1)) ? location.hash.slice(1) : 'public';
  const tabs = {};
  const showPage = id => {
    for (const [key,,page] of pages) page.hidden = key !== id;
    for (const [key,tab] of Object.entries(tabs)) { tab.classList.toggle('active', key === id); tab.setAttribute('aria-selected', key === id ? 'true' : 'false'); }
    const next = location.pathname + location.search + '#' + id;
    if (location.pathname + location.search + location.hash !== next) history.replaceState({}, '', next);
  };
  const index = el('div',{class:'settings-index',role:'tablist','aria-label':'设置分区'},pages.map(([id,label]) => {
    const tab = el('button',{type:'button',role:'tab','aria-controls':id,'aria-selected':id === selected ? 'true' : 'false',class:id === selected ? 'active' : '',onclick:() => showPage(id)},label);
    tabs[id] = tab; return tab;
  }));
  showPage(selected);
  return el('div',{class:'settings-stack'},index,...pages.map(([, ,page]) => page));
}
