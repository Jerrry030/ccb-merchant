import { paymentCheckout } from './payment-checkout.js';
import { normalizeRegistrationEmailSuffixDomain, isRegistrationEmailSuffixDomainValid, parseRegistrationEmailSuffixWhitelistInput } from './registration-policy.js';
import { mailSettingsView } from './mail-settings.js';
import { paymentSettingsView } from './payment-settings.js';
import { usageDetail } from './usage-detail.js';
/* Standalone merchant client. Only /api on this origin; no stored credentials or demo data. */
const app = document.getElementById('app');
const state = { public: null, user: null, csrf: null, returnTo: '/', code: '', token: '', view: 0 };
const CANCEL = Symbol('cancel');
const authRoutes = new Set(['/login', '/setup', '/register', '/verify', '/forgot', '/reset']);
const navigation = [
  { path: '/', title: '首页', icon: 'overview', description: '查看账单与用量。参考费用只供核对，不会从钱包扣费。' },
  { path: '/connect',hidden:true, title: '开始使用', icon: 'terminal', description: '安装 CCB、登录本站并确认设备，然后在项目目录开始工作。' },
  { path: '/accounts', title: '我的账号', icon: 'layers', description: '查看已分配或订阅交付的账号、额度和正在使用的设备。' },
  { path: '/devices',hidden:true, title: '我的设备', icon: 'monitor', description: '每个账号最多绑定 1 台设备。换机请先撤销旧设备，再连接新设备。' },
  { path: '/usage', title: '使用记录', icon: 'chart', description: '查看请求与 Token。参考成本只供核对，不会从钱包扣费。' },
  { path: '/wallet',hidden:true, title: '充值/订阅', icon: 'wallet', description: '充值人民币余额，或购买固定期限订阅。购买时选择一个登录平台，并查看是否有货。' },
  { path: '/profile', title: '个人设置', icon: 'user', description: '查看账户信息，维护您的登录安全。' },
  { path: '/orders', title:'我的订单', icon:'receipt', description:'核对套餐支付、开通、续期及退回余额。' },
  { path:'/admin/upstream',title:'上游接入',icon:'link',admin:true,hidden:true,description:'连接直接上级，核对本站账户与可用资源。' },
  { path:'/admin/access',hidden:true,title:'API 接入',icon:'key',admin:true,description:'管理直接接入本站的客户、密钥和资源范围。' },
  { path: '/admin/customers', title: '客户管理', icon: 'users', admin: true, description: '管理客户资料，在账号库存中为客户分配账号。' },
  { path:'/admin/inventory',title:'账号库存',icon:'layers',admin:true,description:'查看平台管理员分配的账号、有效期和客户分配状态。每个账号最多绑定 1 台设备。' },
  { path:'/admin/plans',hidden:true,title:'套餐管理',icon:'layers',admin:true,description:'只为订阅分组设置有效期和金额。普通分组不在这里出售。' },
  { path:'/admin/rentals',hidden:true,title:'销售与交付',icon:'receipt',admin:true,description:'核对销售订单和交付结果，处理尚未交付的订单。' },
  { path:'/admin/operations',title:'运营待办',icon:'overview',admin:true,description:'处理客户同步、支付核对和交付异常。' },
  { path: '/admin/orders',hidden:true, title: '支付订单', icon: 'receipt', admin: true, description: '核对服务端记录的支付状态，不以回跳参数判定到账。' },
  { path: '/admin/audit', title: '审计日志', icon: 'shield', admin: true, description: '查看管理操作记录，追溯变更与授权。' },
  { path: '/admin/settings', title: '站点设置', icon: 'settings', admin: true, description: '管理公开信息、注册策略、上游连接，以及邮件和支付服务。' },
];
const paths = {
  overview: ['M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z'],
  layers: ['m12 3 10 5-10 5L2 8l10-5Z', 'm2 12 10 5 10-5M2 16l10 5 10-5'],
  monitor: ['M3 4h18v13H3zM8 21h8M12 17v4'],
  chart: ['M4 3v18h17M9 16v-5M14 16V7M19 16V4'],
  wallet: ['M20 8V5a2 2 0 0 0-2-2H5a3 3 0 0 0 0 6h16v11H5a3 3 0 0 1-3-3V6M21 12h-6v5h6M17 14.5h.1'],
  user: ['M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a8 8 0 0 1 16 0v2'],
  users: ['M15 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM3 21v-2a8 8 0 0 1 15-3M18 3a4 4 0 0 1 0 8M21 21v-3a6 6 0 0 0-3-5'],
  grid: ['M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z'],
  key: ['M14 3a7 7 0 0 0-6 10L2 19v3h4v-3h3v-3l2-2a7 7 0 1 0 3-11ZM16 7h.1'],
  receipt: ['m5 2 3 2 4-2 4 2 3-2v20l-3-2-4 2-4-2-3 2V2ZM9 8h6M9 12h6M9 16h3'],
  shield: ['m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6l9-4Z', 'm8 12 3 3 5-6'],
  settings: ['M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1 1-3Z', 'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z'],
  link: ['m10 13 4-4M8 15l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M16 9l2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0'],
  arrow: ['M5 12h14m-5-5 5 5-5 5'],
  plus: ['M12 5v14M5 12h14'],
  moon: ['M21 13a9 9 0 0 1-10-10 9 9 0 1 0 10 10Z'],
  sun: ['M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM12 2v2M12 20v2M2 12h2M20 12h2M5 5l1 1M18 18l1 1M5 19l1-1M18 6l1-1'],
  logout: ['M9 4H3v16h6M13 7l5 5-5 5M8 12h13'],
  refresh: ['M20 8a8 8 0 0 0-14-3L3 8M3 3v5h5M4 16a8 8 0 0 0 14 3l3-3M16 16h5v5'],
  info: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 11v6M12 7h.1'],
  clock: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 7v5l3 2'],
  code: ['m8 5-7 7 7 7M16 5l7 7-7 7M14 3l-4 18'],
  terminal: ['M4 5h16v14H4z','m7 9 3 3-3 3','M13 15h5'],
  menu: ['M4 6h16M4 12h16M4 18h16'],
  close: ['m6 6 12 12M6 18 18 6'],
  check: ['m5 12 4 4L19 6'],
  down: ['M12 4v16M6 14l6 6 6-6'],
  up: ['M12 20V4M6 10l6-6 6 6'],
  cache: ['M4 7h16M4 7a2 2 0 0 1 0-4h16a2 2 0 0 1 0 4M4 7v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7M9 12h6'],
  edit: ['M12 20h8M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z'],
};

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (['value', 'checked', 'disabled', 'required', 'readOnly'].includes(key)) node[key] = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child != null && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'icon'); svg.setAttribute('aria-hidden', 'true');
  for (const d of paths[name] || paths.info) {
    const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', d); svg.append(path);
  }
  return svg;
}
function artwork() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 270 190'); svg.setAttribute('class', 'hero-art'); svg.setAttribute('aria-hidden', 'true');
  for (const [tag, attrs, text] of [
    ['ellipse', {cx:140,cy:100,rx:117,ry:71,transform:'rotate(-18 140 100)',class:'orbit'}],
    ['ellipse', {cx:140,cy:100,rx:88,ry:91,transform:'rotate(45 140 100)',class:'orbit'}],
    ['rect', {x:54,y:35,width:155,height:114,rx:14,transform:'rotate(-7 130 100)',class:'terminal'}],
    ['path', {d:'M65 63 201 47',class:'orbit'}],
    ['circle', {cx:69,cy:50,r:3,class:'spark'}], ['circle', {cx:79,cy:49,r:3,class:'spark'}],
    ['text', {x:99,y:109,transform:'rotate(-7 130 100)'}, '</>'],
    ['path', {d:'m83 127 34-4m10-1 45-5',class:'code-line'}],
    ['rect', {x:192,y:114,width:48,height:48,rx:13,transform:'rotate(12 216 138)',class:'tile'}],
    ['path', {d:'m207 138 6 6 13-15',fill:'none',stroke:'#9470d1','stroke-width':3,'stroke-linecap':'round','stroke-linejoin':'round'}],
    ['circle', {cx:32,cy:118,r:7,class:'spark'}], ['circle', {cx:221,cy:35,r:5,class:'spark'}],
    ['path', {d:'M44 37v10m-5-5h10M167 166v10m-5-5h10',stroke:'#b59bd9','stroke-width':2}],
  ]) {
    const part = document.createElementNS(svg.namespaceURI, tag);
    Object.entries(attrs).forEach(([k,v]) => part.setAttribute(k, v)); if (text) part.textContent = text; svg.append(part);
  }
  return svg;
}
function brand() {
  return el('a', {class:'brand',href:state.user ? '/' : '/login'}, el('span',{class:'brand-mark'},state.public?.site?.logo_url ? el('img',{src:state.public.site.logo_url,alt:'',referrerpolicy:'no-referrer',class:'brand-logo'}) : icon('code')),
    el('span',{},el('span',{class:'brand-name',text:state.public?.site?.name || 'CCB 工作台'}),el('span',{class:'brand-caption',text:'商户工作台'})));
}
function themeButton(className = '') {
  const button = el('button',{class:`icon-button ${className}`,type:'button',onclick:() => {
    const dark = document.documentElement.dataset.theme !== 'dark';
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    try { localStorage.setItem('ccb-theme',dark ? 'dark' : 'light'); } catch { /* Private mode may deny preference storage. */ }
    button.replaceChildren(icon(dark ? 'sun' : 'moon')); button.setAttribute('aria-label',dark ? '切换浅色主题' : '切换深色主题');
  }});
  const dark = document.documentElement.dataset.theme === 'dark';
  button.setAttribute('aria-label',dark ? '切换浅色主题' : '切换深色主题'); button.append(icon(dark ? 'sun' : 'moon')); return button;
}
try { document.documentElement.dataset.theme = localStorage.getItem('ccb-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); }
catch { document.documentElement.dataset.theme = 'light'; }

async function api(path, {method = 'GET', body} = {}) {
  const url = new URL(path, location.origin);
  if (url.origin !== location.origin || !url.pathname.startsWith('/api/') || url.username || url.password) throw new Error('仅允许访问本站 API。');
  const write = method !== 'GET';
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(),20000);
  let response;
  try {
    response = await fetch(url.pathname + url.search, {method,credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal,
      headers:{Accept:'application/json',...(body !== undefined ? {'Content-Type':'application/json'} : {}),...(write && state.csrf ? {'X-CSRF-Token':state.csrf} : {})},
      ...(body !== undefined ? {body:JSON.stringify(body)} : {})});
    let data;
    try { data = await response.json(); }
    catch { throw Object.assign(new Error(write ? '服务器未返回可确认的结果。' : '服务器响应格式异常。'),{uncertain:write,status:response.status}); }
    if (!response.ok) {
      const code = data.error?.code;
      const messages = {upstream_target_blocked:'此上游目标被服务器网络策略拒绝。私网或 HTTP 地址需由部署者设置 UPSTREAM_ALLOWED_ORIGINS。',upstream_identity_mismatch:'已有业务数据绑定了另一个上游身份，不能在这里直接切换。',upstream_protocol_mismatch:'上游协议不兼容或接入账户已失效。',upstream_verification_failed:'上游未能验证本站凭据，请检查地址、密钥及上级状态。',upstream_changed:'接入配置已变化，请刷新后重新核对。',upstream_environment_managed:'本站上游由服务端环境配置管理，网页不能覆盖。',insufficient_balance:'钱包余额不足，请先充值或选择在线支付。',plan_changed:'套餐价格或状态已更新，请刷新并重新确认。',plan_conflict:'套餐版本已变化，请刷新后再编辑。',supply_unavailable:'供给不可用或期限不足，暂时无法购买此套餐。',purchase_pending:'此资源已有待完成订单，请先在我的订单中核对。',purchase_conflict:'该请求编号已用于另一笔购买，请核对已有订单。',customer_not_ready:'请选择状态正常、没有待确认变更的客户。',order_state:'订单状态已变化，请刷新核对；已交付订单不能在这里自动退款。',payment_amount_unavailable:'此价格超出当前在线支付范围，请使用余额或联系商户。',payment_outcome_unknown:'支付结果尚未确认，请查看已有订单，勿重复付款。',invalid_credentials:'邮箱或密码不正确，或此账户暂不可用。',invalid_csrf:'会话安全令牌已失效，请重新验证会话。',core_not_configured:'上游连接尚未配置，请联系管理员。',core_unavailable:'上游服务暂不可用，请稍后重试。',core_unavailable:'上游服务暂不可用，请稍后重试。',payment_disabled:'支付服务尚未配置或已停用，当前无法创建订单。',invalid_payment_method:'请选择当前可用的支付方式。',invalid_provider_config:'渠道参数或密钥格式无效，请检查必填字段、RSA 密钥和结算币种。',mail_disabled:'邮件服务尚未配置，当前无法验证邮箱或重置密码。',registration_disabled:'站点当前未开放自助注册。',email_suffix_not_allowed:'该邮箱域名不在允许注册范围内。',email_domain_registration_limit:'该邮箱域名不能再注册新账户。',integration_environment_managed:'这项服务由服务器环境配置管理，不能在页面里覆盖。',mail_unavailable:'邮件服务器拒绝了连接或认证。请核对主机、端口和凭据。',payment_pending:'仍有未完成的支付订单，暂不能更换支付凭据。',payment_pending_limit:'待支付订单数量已达上限，请先完成或核对已有订单。',payment_daily_limit:'今日支付额度已达上限，未确认订单也占用额度。',settings_changed:'配置已被其他操作更新，请刷新后重新确认。',mail_password_required:'修改 SMTP 主机、端口、用户名或 TLS 模式后，请重新输入密码。',mail_auth_failed:'SMTP 认证失败，请检查用户名、密码或邮箱授权码。',mail_timeout:'SMTP 连接超时，请检查主机、端口和服务器网络。',mail_tls_failed:'SMTP 加密连接失败，请检查 TLS 模式和证书。',mail_recipient_rejected:'SMTP 拒绝了测试收件人，请检查地址和中继权限。',payment_verification_unavailable:'支付服务无法验证，请检查密钥、环境和网络。',invalid_password:'密码不符合要求，或当前密码不正确。',not_provisioned:'尚未分配账号，请联系管理员。',core_sync_pending:'客户信息尚未与上游同步完成，请联系管理员核对。',invalid_code:'连接码无效或已过期，请在客户端重新发起连接。',not_copyable:'这把密钥创建时未保留原文，请撤销后重新签发。',admin_required:'此操作需要商户管理员权限。',account_changed:'账号状态已变化，请刷新后重新核对。',account_unavailable:'账号暂不可用，请刷新库存或联系平台管理员。',account_assigned:'该账号已分配，请先收回原客户授权。',invalid_expiry:'客户到期时间不能超过账号到期时间。',customer_not_ready:'请选择状态正常、没有待确认变更的客户。',user_busy:'客户变更正在处理中，请稍后核对。',rate_limited:'请求过于频繁，请稍后再试。'};
      const rejected = ['core_not_configured','payment_disabled','mail_disabled','registration_disabled'].includes(code);
      throw Object.assign(new Error(messages[code] || (typeof data.error?.message === 'string' ? data.error.message : '请求未完成，请稍后再试。')),
        {status:response.status,code,uncertain:write && !rejected && (response.status >= 500 || /unknown|uncertain|timeout/i.test(code || ''))});
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw Object.assign(new Error('服务器响应格式异常。'),{uncertain:write});
    if (write) {
      const expectsOk = method === 'DELETE' || ['/api/auth/logout','/api/auth/verify','/api/auth/forgot-password','/api/auth/reset-password','/api/auth/password','/api/me/devices/approve'].includes(url.pathname);
      if (expectsOk && data.ok !== true) throw Object.assign(new Error('服务器未明确确认操作成功。'),{uncertain:true});
      const required = [];
      if (['/api/setup','/api/auth/login'].includes(url.pathname)) required.push('user','csrf_token');
      else if (url.pathname.startsWith('/api/admin/users')) { required.push('user'); if (url.pathname.endsWith('/provision')) required.push('customer'); }
      else if (url.pathname.startsWith('/api/admin/grants')) required.push('grant');
      else if(/\/keys\/[^/]+\/copy$/.test(url.pathname)) required.push('token');
      else if(method!=='DELETE'&&url.pathname.startsWith('/api/admin/access-accounts')){if(/\/keys$/.test(url.pathname))required.push('key','token');else if(url.pathname.includes('/resources'))required.push('resource');else required.push('account');}
      else if (url.pathname === '/api/admin/settings') required.push('site','features');
      else if (url.pathname === '/api/me/payments' || /\/payments\/[^/]+\/reconcile$/.test(url.pathname)) required.push('order');
      else if (url.pathname === '/api/admin/upstream') required.push('connection','revision');
      else if (url.pathname.startsWith('/api/admin/plans')) required.push('plan');
      else if (url.pathname === '/api/me/rentals' || url.pathname.startsWith('/api/admin/rentals/')) required.push('rental');
      else if (url.pathname === '/api/me/devices/preview') required.push('device');
      if (required.some(key => data[key] == null || data[key] === '')) throw Object.assign(new Error('服务器返回的操作凭据不完整，请先重新读取状态。'),{uncertain:true});
    }
    return data;
  } catch (error) {
    if (!response) throw Object.assign(new Error(write ? '连接中断或超时，操作可能已被服务器接收。' : '暂时无法连接本站服务，请检查网络后重试。'),{uncertain:write});
    throw error;
  } finally { clearTimeout(timer); }
}
function collection(data, key) {
  if (!Array.isArray(data?.[key])) throw new Error('响应缺少列表数据，请刷新或联系管理员。');
  return data[key];
}
function adoptSession(data) {
  if (!data.user || !['admin','member'].includes(data.user.role) || typeof data.csrf_token !== 'string' || !data.csrf_token) throw new Error('登录响应不完整，请重新登录。');
  state.user = data.user; state.csrf = data.csrf_token;
}
function safeRoute(value) {
  try { const url = new URL(value,location.origin); return url.origin === location.origin && navigation.some(v => v.path === url.pathname) ? url.pathname + url.search : '/'; }
  catch { return '/'; }
}
function navigate(path, replace = false) {
  closeMetricPopover();
  for (const dialog of document.querySelectorAll('dialog')) { if (dialog.open) dialog.close(); dialog.remove(); }
  const url = new URL(path,location.origin); if (url.origin !== location.origin) return;
  history[replace ? 'replaceState' : 'pushState']({},'',url.pathname + url.search + url.hash); render();
}
document.addEventListener('click', event => {
  const anchor = event.target.closest('a');
  if (!anchor || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || anchor.target || anchor.hasAttribute('download')) return;
  const url = new URL(anchor.href,location.origin);
  if (url.origin === location.origin && !url.hash && (navigation.some(v => v.path === url.pathname) || authRoutes.has(url.pathname))) { event.preventDefault(); navigate(url.pathname + url.search); }
});
addEventListener('popstate',() => render());
function toast(message) {
  document.querySelector('.toast')?.remove(); const node = el('div',{class:'toast',role:'status',text:message}); document.body.append(node);
  setTimeout(() => node.remove(),4500);
}
function badge(status) {
  const map = {awaiting_payment:['待支付','warn'],queued:['待开通','warn'],review:['待核对','warn'],fulfilled:['已交付','good'],refund_pending:['退款核对中','warn'],archived:['已下架','warn'],ok:['已完成','good'],unknown:['待核实','warn'],creating:['创建中','warn'],delivery_unknown:['邮件待核实','warn'],active:['有效','good'],available:['可用','good'],connected:['已连接','good'],approved:['已授权','good'],paid:['已支付','good'],completed:['已完成','good'],succeeded:['已成功','good'],member:['成员','purple'],admin:['管理员','purple'],pending:['待处理','warn'],pending_verification:['待验证','warn'],unverified:['待验证','warn'],expired:['已过期','warn'],disabled:['已停用','bad'],revoked:['已撤销','bad'],failed:['失败','bad'],canceled:['已取消','warn'],cancelled:['已取消','warn'],created:['已创建','purple'],refunded:['已退回余额','warn']};
  const [label,color] = map[status] || [typeof status === 'string' ? status : '未知状态',''];
  return el('span',{class:`badge ${color}`},el('span',{class:'dot'}),label);
}
function date(value) { if (!value) return '—'; const d = new Date(value); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN',{hour12:false}); }
function number(value) { return typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2}).format(value) : '—'; }
function money(value, currency = 'CNY') { return Number.isSafeInteger(value) && currency === 'CNY' ? new Intl.NumberFormat('zh-CN',{style:'currency',currency:'CNY'}).format(value/100) : '—'; }
function notice(title, text, tone = '', action) {
  return el('div',{class:`notice ${tone}`,role:tone === 'error' ? 'alert' : 'status'},icon(tone === 'success' ? 'check' : 'info'),el('div',{},el('strong',{text:title}),text ? el('p',{text}) : null,action));
}
function emptyState(title, description, symbol = 'layers', action) {
  return el('div',{class:'empty-state'},el('span',{class:'empty-icon'},icon(symbol)),el('h3',{text:title}),el('p',{text:description}),action);
}
function panel(title, description, body, action) {
  return el('section',{class:'card'},el('div',{class:'card-head'},el('div',{},el('h2',{text:title}),description ? el('p',{text:description}) : null),action),body);
}
function table(columns, rows, empty = '目前没有记录', explanation = '服务器尚未返回任何记录；产生真实数据后将显示在这里。') {
  if (!rows.length) return emptyState(empty,explanation);
  const header = el('tr',{},columns.map(c => el('th',{scope:'col',text:c.label})));
  return el('div',{class:'table-wrap',tabindex:'0','aria-label':'数据表，可横向滚动'},el('table',{},el('thead',{},header),el('tbody',{},rows.map(row => el('tr',{},columns.map(c => el('td',{'data-label':c.label},c.render(row))))))));
}
let fieldSequence = 0;
function field(label, name, options = {}) {
  const {type = 'text',hint,value,choices,...props} = options;
  const control = type === 'select' ? el('select',{name,...props},(choices || []).map(c => el('option',{value:c.value,text:c.label,disabled:c.disabled})))
    : el(type === 'textarea' ? 'textarea' : 'input',{name,...(type === 'textarea' ? {} : {type}),...props});
  if (value != null) control.value = value;
  const id = `field-${++fieldSequence}`;
  control.id = id; control.setAttribute('aria-labelledby',`${id}-label`);
  if (hint) control.setAttribute('aria-describedby',`${id}-hint`);
  return el('label',{class:'field',for:id},el('span',{id:`${id}-label`,text:label}),control,hint ? el('small',{id:`${id}-hint`,text:hint}) : null);
}
function errorNotice(error, refresh = () => render()) {
  if (error.uncertain) return notice('操作结果尚未确认','请先刷新列表或检查服务器状态，不要立即重复提交。关闭此提示不代表操作未执行。','warn',el('button',{class:'btn small',type:'button',onclick:refresh,text:'重新读取状态'}));
  if (/last.?admin|self.?disable/i.test(error.code || '')) return notice('需要保留可用的管理员','不能停用自己或移除最后一位管理员。请先确保其他管理员可正常登录。','error');
  if (error.code === 'not_provisioned' || error.code === 'core_sync_pending') return notice('账号暂不可用',error.message,'warn');
  if (error.code === 'invalid_csrf') return notice('请重新验证会话',error.message,'warn',el('button',{class:'btn small',type:'button',text:'重新验证会话',onclick:() => bootstrap()}));
  if (error.status === 409) return notice('状态冲突，未覆盖新版本',`${error.message} 请重新读取最新状态，再确认是否需要操作。`,'warn',el('button',{class:'btn small',type:'button',onclick:refresh,text:'刷新最新状态'}));
  if (error.status === 401 && state.user) return notice('登录已失效','请重新登录后继续；刚才的操作未被确认。','warn',el('button',{class:'btn small',type:'button',text:'重新登录',onclick:() => { state.returnTo = safeRoute(location.pathname + location.search); state.user = null; state.csrf = null; navigate('/login'); }}));
  return notice(error.status === 403 ? '没有执行权限' : '暂时无法完成',error.message,'error');
}
function confirmAction(title, description, label = '确认操作', danger = false) {
  return new Promise(resolve => {
    const previous = document.activeElement;
    const dialog = el('dialog',{class:'dialog','aria-labelledby':'confirm-title'},
      el('div',{class:'dialog-head'},el('h2',{id:'confirm-title',text:title})),el('p',{text:description}));
    const cancel = el('button',{class:'btn',type:'button',text:'取消',onclick:() => dialog.close('cancel')});
    dialog.append(el('div',{class:'dialog-actions'},cancel,el('button',{class:`btn ${danger ? 'danger' : 'primary'}`,type:'button',text:label,onclick:() => dialog.close('confirm')})));
    dialog.addEventListener('close',() => { const confirmed = dialog.returnValue === 'confirm'; dialog.remove(); if (previous?.isConnected) previous.focus(); resolve(confirmed); },{once:true});
    document.body.append(dialog); dialog.showModal(); cancel.focus();
  });
}
function bindForm(form, handler, success) {
  const message = el('div',{class:'form-message'}); form.prepend(message);
  form.addEventListener('submit',async event => {
    event.preventDefault(); if (form.dataset.busy === 'true') return;
    const values = new FormData(form); const controls = [...form.querySelectorAll('button,input,select,textarea')].map(node => [node,node.disabled]);
    form.dataset.busy = 'true'; form.setAttribute('aria-busy','true'); controls.forEach(([node]) => node.disabled = true); message.replaceChildren();
    let uncertain = false;
    try {
      const result = await handler(values);
      if (result !== CANCEL && form.isConnected) {
        form.querySelectorAll('input[type=password]').forEach(node => node.value = '');
        await success?.(result,message);
      }
    } catch (error) {
      uncertain = Boolean(error.uncertain); message.replaceChildren(errorNotice(error)); message.scrollIntoView({block:'nearest'});
    } finally {
      form.dataset.busy = 'false'; form.removeAttribute('aria-busy'); controls.forEach(([node,disabled]) => node.disabled = disabled || (uncertain && node.type === 'submit'));
    }
  });
}
function actionButton(label, handler, {danger = false, disabled = false, onSuccess} = {}) {
  const button = el('button',{type:'button',class:`btn small ${danger ? 'danger' : ''}`,text:label,disabled,onclick:async () => {
    button.disabled = true;
    try { const result = await handler(); if (result !== CANCEL) { toast('操作已由服务器确认'); if (onSuccess) await onSuccess(result); else render(); } }
    catch (error) {
      const host = document.getElementById('page-feedback'); host?.replaceChildren(errorNotice(error)); host?.scrollIntoView({block:'nearest'});
      if (error.uncertain) return;
    }
    button.disabled = disabled;
  }}); return button;
}
function stat(label, value, note, symbol) {
  return el('section',{class:'card stat'},el('div',{class:'stat-top'},el('span',{text:label}),el('span',{class:'stat-icon'},icon(symbol))),el('p',{class:'stat-value',text:value}),el('p',{class:'stat-note',text:note}));
}

async function bootstrap() {
  app.replaceChildren(el('main',{id:'main',class:'boot'},el('div',{class:'spinner','aria-hidden':'true'}),el('p',{role:'status',text:'正在连接工作台…'})));
  const query = new URLSearchParams(location.search);
  if (location.pathname === '/connect' && query.has('code')) { state.code = query.get('code').slice(0,128); history.replaceState({},'','/connect'); }
  if (['/verify','/reset'].includes(location.pathname) && query.has('token')) { state.token = query.get('token').slice(0,4096); history.replaceState({},'',location.pathname); }
  if (query.has('next')) state.returnTo = safeRoute(query.get('next'));
  try {
    state.public = await api('/api/public');
    if(/^#[0-9a-fA-F]{6}$/.test(state.public.site?.accent_color||''))document.documentElement.style.setProperty('--primary',state.public.site.accent_color);
    if (!state.public.site || !state.public.features || typeof state.public.setup_required !== 'boolean') throw new Error('站点配置不完整，无法安全初始化。');
    try { adoptSession(await api('/api/auth/session')); }
    catch (error) { if (error.status !== 401) throw error; state.user = null; state.csrf = null; }
    render();
  } catch (error) {
    app.replaceChildren(el('main',{id:'main',class:'boot'},brand(),notice('工作台暂时不可用',error.message,'error'),el('button',{class:'btn',type:'button',text:'重新连接',onclick:bootstrap})));
  }
}
function shell(route) {
  const root = el('div',{class:'shell'});
  const nav = el('nav',{'aria-label':'主导航'});
  for (const item of navigation.filter(v => !v.hidden && !v.admin)) nav.append(el('a',{class:'nav-link',href:item.path,'aria-current':route.path === item.path ? 'page' : null},icon(item.icon),item.title));
  if (state.user.role === 'admin') {
    nav.append(el('div',{class:'nav-group',text:'商户管理'}));
    for (const item of navigation.filter(v => v.admin && !v.hidden)) nav.append(el('a',{class:'nav-link',href:item.path,'aria-current':route.path === item.path ? 'page' : null},icon(item.icon),item.title));
  }
  nav.addEventListener('click',event => { if (event.target.closest('a')) root.classList.remove('menu-open'); });
  const logout = el('button',{class:'icon-button',type:'button','aria-label':'退出登录',onclick:async () => {
    if (!await confirmAction('退出登录','确定退出当前工作台会话吗？','退出登录')) return;
    logout.disabled = true;
    try { await api('/api/auth/logout',{method:'POST'}); state.user = null; state.csrf = null; state.returnTo = '/'; state.code = ''; state.token = ''; navigate('/login',true); }
    catch (error) { document.getElementById('page-feedback')?.replaceChildren(errorNotice(error)); logout.disabled = false; }
  }},icon('logout'));
  root.append(el('aside',{class:'sidebar',id:'sidebar'},brand(),nav,el('div',{class:'sidebar-foot'},
    el('div',{class:'user-card'},el('span',{class:'avatar',text:(state.user.display_name || state.user.email || '?').slice(0,1).toUpperCase()}),el('div',{class:'user-info'},el('strong',{text:state.user.display_name || state.user.email}),el('small',{text:state.user.role === 'admin' ? '商户管理员' : '工作空间成员'})),logout))));
  const menu = el('button',{class:'icon-button mobile-menu',type:'button','aria-label':'打开导航','aria-controls':'sidebar','aria-expanded':'false',onclick:() => {
    const open = root.classList.toggle('menu-open'); menu.setAttribute('aria-expanded',String(open));
    if (open) nav.querySelector('a')?.focus();
  }},icon('menu'));
  root.append(el('button',{class:'mobile-scrim',type:'button','aria-label':'关闭导航',onclick:() => { root.classList.remove('menu-open'); menu.setAttribute('aria-expanded','false'); menu.focus(); }}));
  root.addEventListener('keydown',event => { if (event.key === 'Escape') { root.classList.remove('menu-open'); menu.setAttribute('aria-expanded','false'); menu.focus(); } });
  const content = el('div',{class:'page-content',id:'page-content','aria-busy':'true'},el('div',{class:'loading',role:'status'},el('div',{class:'spinner','aria-hidden':'true'}),'正在读取最新数据…'));
  root.append(el('div',{class:'workspace'},el('header',{class:'topbar'},menu,
    el('div',{class:'breadcrumb'},el('span',{text:'工作台'}),el('span',{'aria-hidden':'true',text:'/'}),el('strong',{text:route.title})),
    el('div',{class:'top-actions'},el('span',{class:'top-label',text:'本站独立运营'}),themeButton(),badge(state.user.role))),
    el('main',{id:'main',class:'main',tabindex:'-1'},el('div',{class:'page-heading'},el('div',{},el('span',{class:'eyebrow',text:route.admin ? '商户管理' : '工作空间'}),el('h1',{text:route.title})),el('button',{class:'btn',type:'button',onclick:() => render()},icon('refresh'),'刷新')),
      el('div',{id:'page-feedback'}),content,el('footer',{class:'page-footer'},el('span',{text:`${state.public.site.name} · 独立商户工作台`}),el('span',{text:'用量可核对 · 密钥留在服务端'})))));
  app.replaceChildren(root); return content;
}
async function render() {
  closeMetricPopover();
  const ticket = ++state.view;
  if (location.pathname === '/admin/upstream') history.replaceState({}, '', '/admin/settings#upstream');
  const path = location.pathname;
  if (!state.public) return;
  if (!state.user) {
    if (!authRoutes.has(path)) { state.returnTo = safeRoute(path + location.search); navigate(state.public.setup_required ? '/setup' : '/login',true); return; }
    renderAuth(path); return;
  }
  if (authRoutes.has(path)) { navigate(state.returnTo || '/',true); return; }
  const route = navigation.find(item => item.path === path) || {path,title:'页面不存在',description:'此地址不在工作台导航中。'};
  document.title = `${route.title} · ${state.public.site.name}`;
  const content = shell(route);
  try {
    let result;
    if (route.admin && state.user.role !== 'admin') result = emptyState('没有管理权限','此页面仅供服务端确认的商户管理员访问。','shield',el('a',{class:'btn primary',href:'/',text:'返回首页'}));
    else if (!views[path]) result = emptyState('没有找到此页面','请使用侧栏导航访问工作台。','info',el('a',{class:'btn',href:'/',text:'返回首页'}));
    else result = await views[path]();
    if (ticket !== state.view) return;
    content.replaceChildren(result); content.removeAttribute('aria-busy');
    document.getElementById('announcer').textContent = `${route.title}已加载`;
    const anchor = location.hash.replace(/^#/, '');
    if (anchor) document.getElementById(anchor)?.scrollIntoView({block:'start'});
  } catch (error) {
    if (ticket !== state.view) return;
    content.removeAttribute('aria-busy'); content.replaceChildren(errorNotice(error),emptyState('数据暂不可用','当前未显示缓存或示例数据。请稍后重试，或联系管理员检查连接。','link',el('button',{class:'btn',type:'button',onclick:() => render(),text:'重试读取'})));
  }
}

function renderAuth(path) {
  const features = state.public.features;
  const labels = {
    '/login':['欢迎回来','使用本站账户登录。','登录工作台'],
    '/setup':['初始化工作台','使用本机的一次性初始化令牌创建管理员。令牌、上游密钥和管理员密码是三项不同凭证。','创建管理员'],
    '/register':['创建您的账户','注册只创建本站账户。资源需要管理员另行分配。','创建账户'],
    '/verify':['验证电子邮箱','提交邮件中的验证令牌，完成账户验证。','确认验证'],
    '/forgot':['找回您的密码','输入注册邮箱。如果账户符合条件，我们会发送重置邮件。','发送重置邮件'],
    '/reset':['设置新密码','使用重置邮件中的令牌，为账户设置一个新密码。','重置密码'],
  };
  const [title,description,submitLabel] = labels[path];
  document.title = `${title} · ${state.public.site.name}`;
  const inner = el('div',{class:'auth-form'},el('span',{class:'eyebrow',text:'本站账户'}),el('h1',{text:title}),el('p',{class:'auth-description',text:description}));
  const disabled = (path === '/setup' && !state.public.setup_required) || (path === '/register' && features.registration !== true) || (path === '/verify' && features.email_verification !== true) || (['/forgot','/reset'].includes(path) && features.password_reset !== true);
  if (disabled) inner.append(notice('此功能当前不可用',path === '/setup' ? '站点已完成初始化，请直接登录。' : '管理员尚未启用此功能或相关服务尚未配置。','warn'),el('div',{class:'auth-links'},el('a',{href:'/login',text:'返回登录'})));
  else {
    const form = el('form',{});
    if (path === '/setup') form.append(field('初始化令牌','setup_token',{type:'password',required:true,autocomplete:'off',hint:'仅在服务器终端或受保护文件中提供，不会保存在浏览器。'}));
    if (['/setup','/register'].includes(path)) form.append(field('显示名称','display_name',{required:true,maxlength:100,autocomplete:'name',placeholder:'您希望如何被称呼'}));
    if (['/login','/setup','/register','/forgot'].includes(path)) form.append(field('电子邮箱','email',{type:'email',required:true,autocomplete:'email',maxlength:254,placeholder:'you@example.com'}));
    if (path === '/register' && Array.isArray(state.public.site?.registration_email_suffix_whitelist) && state.public.site.registration_email_suffix_whitelist.length) form.append(el('p',{class:'inline-info',text:'仅允许这些邮箱域名：' + state.public.site.registration_email_suffix_whitelist.slice(0,5).join('、') + (state.public.site.registration_email_suffix_whitelist.length > 5 ? ' 等' : '')}));
    if (['/verify','/reset'].includes(path)) form.append(field(path === '/verify' ? '验证令牌' : '重置令牌','token',{type:'password',required:true,autocomplete:'off',value:state.token,spellcheck:'false',hint:'邮件链接中的令牌已从地址栏移除，请勿分享。'}));
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
        if (path === '/register' && !['created','verification_required'].includes(data.status)) throw new Error('注册结果无法识别，请联系管理员确认。');
        if (path !== '/register' && data.ok !== true) throw new Error('服务器尚未确认操作完成，请联系管理员确认。');
        state.token = ''; form.querySelector('input[name=token]')?.setAttribute('value','');
        const input = form.querySelector('input[name=token]'); if (input) input.value = '';
        form.querySelector('button[type=submit]').textContent = '已提交';
        const messages = {'/register':data.status === 'verification_required' ? '请前往邮箱完成验证，然后返回登录。' : '账户已创建，请登录。权益仍需由管理员分配。','/verify':'邮箱已验证，请返回登录。','/forgot':'如果账户符合条件，您将收到重置邮件。请同时检查垃圾邮件。','/reset':'密码已重置，请使用新密码登录。'};
        message.replaceChildren(notice('请求已完成',messages[path],'success',el('a',{class:'btn small',href:'/login',text:'返回登录'})));
      }
    });
    inner.append(form);
    const links = el('div',{class:'auth-links'});
    if (path === '/login') {
      if (features.password_reset === true) links.append(el('a',{href:'/forgot',text:'忘记密码？'}));
      if (features.registration === true) links.append(el('a',{href:'/register',text:'创建账户 →'}));
      if (state.public.setup_required) links.append(el('a',{href:'/setup',text:'初始化站点 →'}));
    } else links.append(el('a',{href:'/login',text:'← 返回登录'}));
    inner.append(links);
  }
  if (path === '/login' && state.returnTo.startsWith('/connect')) inner.append(notice('登录后继续开始使用','我们会在登录后返回开始使用页面。登录本身不会授权设备。'));
  inner.append(el('p',{class:'auth-footer',text:'会话由服务端验证 · 上游密钥不会出现在此页'}));
  app.replaceChildren(el('main',{class:'auth-page',id:'main'},el('aside',{class:'auth-art'},brand(),el('div',{class:'auth-art-copy'},el('span',{class:'eyebrow',text:'独立工作台'}),el('h1',{},'管理权益、设备与用量。'),el('p',{text:state.public.site.description || '集中查看 Code 权益、已连接的设备和用量。'}),artwork()),el('p',{class:'auth-bottom',text:'由本站独立提供服务'})),el('section',{class:'auth-form-side'},themeButton('auth-theme'),inner)));
}

function homePreview() {
  return {
    usage: {requests:128},
    wallet: {balance_minor:26800,currency:'CNY'},
  };
}
function finite(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function formatTokens(value) {
  const n = finite(value); if (n === null) return '—';
  const abs = Math.abs(n);
  if (abs >= 1000000) return (n / 1000000).toFixed(2) + 'M';
  if (abs >= 1000) return (n / 1000).toFixed(1) + 'k';
  return new Intl.NumberFormat('zh-CN',{maximumFractionDigits:0}).format(n);
}
function formatUSD(value) {
  const n = finite(value); if (n === null) return '—';
  const sign = n < 0 ? '-' : ''; const abs = Math.abs(n);
  if (abs === 0) return '$0';
  if (abs < 0.01) return sign + '$' + abs.toFixed(4);
  return sign + '$' + abs.toFixed(2);
}
function localDay(value) {
  const d = new Date(value);
  if (!value || Number.isNaN(d.getTime())) return '';
  const pad = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}
function formatDuration(value) {
  const n = finite(value); if (n === null) return '—';
  const whole = Math.round(n);
  if (whole < 1000) return whole + ' ms';
  if (whole < 10000) return (whole / 1000).toFixed(1) + ' s';
  return Math.round(whole / 1000) + ' s';
}
function formatHit(usage) {
  if (!usage) return '—';
  const input = finite(usage.input_tokens), read = finite(usage.cache_read_input_tokens), write = finite(usage.cache_creation_input_tokens);
  if (input === null || read === null || write === null) return '—';
  const denom = input + read + write;
  return denom > 0 ? (read / denom * 100).toFixed(1) + '%' : '—';
}
function tokenParts(usage) {
  const specs = [['输入',usage?.input_tokens,'var(--record-input)'],['输出',usage?.output_tokens,'var(--record-output)'],['缓存读',usage?.cache_read_input_tokens,'var(--record-read)'],['缓存写',usage?.cache_creation_input_tokens,'var(--record-write)']];
  const values = specs.map(([,value]) => finite(value));
  const total = values.every(value => value !== null) ? values.reduce((sum,value) => sum + value,0) : null;
  return {total,parts:specs.map(([key,,color],index) => ({key,value:values[index],color,percent:total ? values[index] / total * 100 : 0}))};
}
function shown(value) {
  const text = value == null || value === '' ? '—' : String(value);
  return {text,className:text === '—' ? 'is-unknown' : ''};
}
function metricPair(label, value) {
  const item = shown(value);
  return el('div',{},el('dt',{text:label}),el('dd',{class:item.className,text:item.text}));
}
function metricValue(value) {
  const item = shown(value);
  return el('span',{class:`v ${item.className}`.trim(),text:item.text});
}
function tokenBar(usage) {
  const {total,parts} = tokenParts(usage);
  if (!total) return null;
  return el('div',{class:'token-bar',role:'img','aria-label':parts.map(part => `${part.key} ${formatTokens(part.value)}`).join('，')},parts.map(part => el('i',{style:`width:${part.percent}%;background:${part.color}`})));
}
function tokenLegend(usage) {
  return el('span',{class:'s token-parts'},tokenParts(usage).parts.map(part => el('span',{},el('i',{style:`background:${part.color}`}),`${part.key} ${part.value === null ? '—' : formatTokens(part.value)}`)));
}
function recordStats(usage, label) {
  const known = !!usage;
  const parts = tokenParts(known ? usage : null);
  const errors = known ? finite(usage.errors) : null;
  return el('section',{class:'stat-strip','aria-label':'当前筛选范围的统计'},
    el('div',{class:'stat-cell'},el('span',{class:'k',text:'费用'}),metricValue(known ? formatUSD(usage.cost_usd) : null),el('span',{class:'s',text:`${label ? label + ' · ' : ''}按价格表估算，不从钱包扣费`})),
    el('div',{class:'stat-cell'},el('span',{class:'k',text:'请求'}),metricValue(known ? number(usage.requests) : null),el('span',{class:errors ? 's warn' : 's',text:`失败 ${errors === null ? '—' : number(errors)} 次`})),
    el('div',{class:'stat-cell'},el('span',{class:'k',text:'Token'}),metricValue(parts.total === null ? null : formatTokens(parts.total)),tokenBar(known ? usage : null),tokenLegend(known ? usage : null),finite(usage?.unknown_usage) ? el('span',{class:'s',text:`${number(usage.unknown_usage)} 次用量未知，未计入 Token`}) : null),
    el('div',{class:'stat-cell'},el('span',{class:'k',text:'平均耗时'}),metricValue(known ? formatDuration(usage.average_duration_ms) : null),el('span',{class:'s',text:`首 Token ${known && finite(usage.average_first_token_ms) !== null ? formatDuration(usage.average_first_token_ms) : '未记录'}`})));
}
async function usageSummary(from, to) {
  try {
    const query = new URLSearchParams({limit:'1',from:from.toISOString(),to:to.toISOString()});
    const data = await api(`/api/me/usage?${query}`);
    return data.usage ?? null;
  } catch { return null; }
}
const chartState = {range:'1d', metric:'requests', gran:'hour', mode:'bar', model:'', from:'', to:'', loaded:null};
const chartColors = ['#7856e8','#7d8798','#c4a15a','#2a9d8f','#d4766a','#3d5a80','#81b29a'];
function chartWindow() {
  const now = new Date();
  if (chartState.range === 'custom') {
    if (!chartState.from || !chartState.to || chartState.from > chartState.to) return null;
    return {from:new Date(`${chartState.from}T00:00:00`), to:new Date(`${chartState.to}T23:59:59.999`)};
  }
  const ms = {'1d':86400000,'7d':7*86400000,'14d':14*86400000,'30d':30*86400000}[chartState.range] || 86400000;
  return {from:new Date(now.getTime() - ms), to:now};
}
function chartScope() {
  if (chartState.range === 'custom') return chartState.from && chartState.to ? `${chartState.from} 至 ${chartState.to} · 按本机时区显示` : '选择自定义时间 · 按本机时区显示';
  return `最近 ${{'1d':'1 天','7d':'7 天','14d':'14 天','30d':'30 天'}[chartState.range] || '1 天'} · 按本机时区显示`;
}
function chartRangeControl() {
  return el('div',{class:'seg',role:'group','aria-label':'时间范围'},[['1d','1天'],['7d','7天'],['14d','14天'],['30d','30天'],['custom','自定义']].map(([id,label]) => el('button',{type:'button',class:chartState.range === id ? 'on' : '','aria-pressed':chartState.range === id ? 'true' : 'false',text:label,onclick:() => { chartState.range = id; if (id !== 'custom') { chartState.gran = id === '1d' || id === '7d' ? 'hour' : 'day'; chartState.loaded = null; } render(); }})));
}
function chartFilters(chart) {
  const models = [...new Set((chart?.rows || []).map(row => row.model || '未提供模型'))];
  const modelSelect = el('select',{'aria-label':'筛选模型',onchange:event => { chartState.model = event.target.value; render(); }},el('option',{value:'',text:'全部模型'}),models.map(name => el('option',{value:name,text:name})));
  modelSelect.value = models.includes(chartState.model) ? chartState.model : '';
  const metricSelect = el('select',{'aria-label':'图表指标',onchange:event => { chartState.metric = event.target.value; render(); }},[['requests','请求数'],['input','输入'],['cache_read','缓存命中'],['cache_write','缓存写入'],['output','输出'],['tokens','综合 token'],['hit_rate','缓存命中率']].map(([id,label]) => el('option',{value:id,text:label})));
  metricSelect.value = chartState.metric;
  const granSelect = el('select',{'aria-label':'统计粒度',onchange:event => { chartState.gran = event.target.value; render(); }},[['hour','小时'],['day','天'],['week','周']].map(([id,label]) => el('option',{value:id,text:label})));
  granSelect.value = chartState.gran;
  const modes = el('div',{class:'seg modes',role:'group','aria-label':'图表类型'},[['bar','柱状'],['area','面积']].map(([id,label]) => el('button',{type:'button',class:chartState.mode === id ? 'on' : '','aria-pressed':chartState.mode === id ? 'true' : 'false',text:label,onclick:() => { chartState.mode = id; render(); }})));
  const custom = chartState.range === 'custom' ? el('div',{class:'chart-custom'},field('开始日期','chart_from',{type:'date',value:chartState.from,onchange:event => { chartState.from = event.target.value; chartState.loaded = null; render(); }}),field('结束日期','chart_to',{type:'date',value:chartState.to,onchange:event => { chartState.to = event.target.value; chartState.loaded = null; render(); }})) : null;
  return el('div',{class:'chart-filters'},modelSelect,metricSelect,granSelect,modes,custom);
}
async function loadChartRows(from, to) {
  const key = `${from.toISOString()}|${to.toISOString()}`;
  if (chartState.loaded?.key === key) return chartState.loaded;
  const rows = [];
  let offset = 0, total = 0, summary = null;
  do {
    const query = new URLSearchParams({limit:'100',offset:String(offset),from:from.toISOString(),to:to.toISOString()});
    const data = await api(`/api/me/usage?${query}`);
    summary = data.usage ?? summary;
    total = Number.isSafeInteger(data.total) ? data.total : rows.length;
    const page = collection(data,'requests');
    rows.push(...page);
    offset += page.length;
    if (!page.length) break;
  } while (rows.length < total && rows.length < 800);
  chartState.loaded = {key,rows,summary,total,truncated:rows.length < total};
  return chartState.loaded;
}
function bucketStart(value, gran) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  if (gran === 'week') { const day = (date.getDay() + 6) % 7; date.setDate(date.getDate() - day); date.setHours(0,0,0,0); }
  else if (gran === 'day') date.setHours(0,0,0,0);
  else date.setMinutes(0,0,0);
  return date.getTime();
}
function bucketText(value, gran, spanDays) {
  const date = new Date(value);
  const pad = n => String(n).padStart(2,'0');
  if (gran === 'hour' && spanDays <= 1) return `${pad(date.getHours())}:00`;
  if (gran === 'hour') return `${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:00`;
  return `${pad(date.getMonth()+1)}-${pad(date.getDate())}`;
}
function rowMetric(row, metric) {
  const usage = row.usage || {};
  const input = finite(usage.input_tokens) || 0, output = finite(usage.output_tokens) || 0, read = finite(usage.cache_read_input_tokens) || 0, write = finite(usage.cache_creation_input_tokens) || 0;
  if (metric === 'input') return input;
  if (metric === 'output') return output;
  if (metric === 'cache_read') return read;
  if (metric === 'cache_write') return write;
  if (metric === 'tokens') return input + output + read + write;
  return 1;
}
function svgEl(tag, props = {}, ...children) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key,value] of Object.entries(props)) if (value != null && value !== false) node.setAttribute(key, value === true ? '' : String(value));
  for (const child of children.flat(Infinity)) if (child != null && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}
function usagePlot(chart) {
  const rows = (chart?.rows || []).filter(row => !chartState.model || (row.model || '未提供模型') === chartState.model);
  if (!rows.length) return null;
  const metric = chartState.metric, gran = chartState.gran, buckets = new Map(), names = [];
  for (const row of rows) {
    const start = bucketStart(row.time, gran);
    if (start == null) continue;
    const name = row.model || '未提供模型';
    if (!names.includes(name)) names.push(name);
    if (!buckets.has(start)) buckets.set(start, new Map());
    const slot = buckets.get(start);
    if (metric === 'hit_rate') {
      const acc = slot.get('__rate') || {read:0,denom:0};
      const usage = row.usage || {};
      const input = finite(usage.input_tokens) || 0, read = finite(usage.cache_read_input_tokens) || 0, write = finite(usage.cache_creation_input_tokens) || 0;
      acc.read += read; acc.denom += input + read + write;
      slot.set('__rate', acc);
    } else slot.set(name,(slot.get(name) || 0) + rowMetric(row, metric));
  }
  const keys = [...buckets.keys()].sort((a,b) => a - b);
  if (!keys.length) return null;
  const seriesNames = metric === 'hit_rate' ? ['命中率'] : names;
  const series = seriesNames.map(name => keys.map(key => {
    const slot = buckets.get(key);
    if (metric === 'hit_rate') { const acc = slot.get('__rate'); return acc?.denom ? acc.read / acc.denom * 100 : 0; }
    return slot.get(name) || 0;
  }));
  const totals = keys.map((_,index) => series.reduce((sum,item) => sum + item[index],0));
  const max = Math.max(metric === 'hit_rate' ? 100 : 1, ...totals);
  const width = 760, height = 230, x0 = 46, y0 = 16, plotW = 690, plotH = 168;
  const step = plotW / keys.length, barW = Math.max(2, step * 0.62);
  const colors = seriesNames.map((_,index) => chartColors[index % chartColors.length]);
  const shapes = [];
  if (chartState.mode === 'area') {
    let base = keys.map(() => y0 + plotH);
    series.forEach((values,index) => {
      const top = values.map((value,item) => base[item] - value / max * plotH);
      const points = [...top.map((y,item) => `${x0 + item * step + step / 2},${y}`), ...[...base].reverse().map((y,item) => `${x0 + (keys.length - 1 - item) * step + step / 2},${y}`)];
      shapes.push(svgEl('polygon',{points:points.join(' '),fill:colors[index],'fill-opacity':'0.88'}));
      base = top;
    });
  } else {
    keys.forEach((_,index) => {
      let y = y0 + plotH;
      series.forEach((values,seriesIndex) => {
        const h = values[index] / max * plotH;
        y -= h;
        if (h > 0) shapes.push(svgEl('rect',{x:x0 + index * step + (step - barW) / 2,y,width:barW,height:Math.max(h,1),rx:2,fill:colors[seriesIndex]}));
      });
    });
  }
  const labelStep = Math.max(1, Math.ceil(keys.length / 8));
  const spanDays = keys.length > 1 ? (keys[keys.length - 1] - keys[0]) / 86400000 : 0;
  const labels = keys.flatMap((key,index) => index % labelStep ? [] : [svgEl('text',{x:x0 + index * step + step / 2,y:height - 8,'text-anchor':'middle',class:'chart-label'},bucketText(key,gran,spanDays))]);
  const axis = [svgEl('text',{x:x0 - 8,y:y0 + 10,'text-anchor':'end',class:'chart-label'},metric === 'hit_rate' ? '100%' : formatTokens(max)),svgEl('text',{x:x0 - 8,y:y0 + plotH,'text-anchor':'end',class:'chart-label'},metric === 'hit_rate' ? '0%' : '0'),svgEl('line',{x1:x0,x2:x0 + plotW,y1:y0 + plotH,y2:y0 + plotH,class:'chart-axis'})];
  return el('div',{class:'usage-plot'},svgEl('svg',{viewBox:`0 0 ${width} ${height}`,role:'img','aria-label':chartScope()},axis,shapes,labels),el('div',{class:'chart-legend'},seriesNames.map((name,index) => el('span',{},el('i',{style:`background:${colors[index]}`}),name))));
}

async function overviewView() {
  const data = await api('/api/me/overview');
  const grants = collection(data,'grants'), devices = collection(data,'devices');
  let usage = data.usage, wallet = data.wallet;
  const previewing = state.public.features.home_preview === true && !grants.length && !devices.length && usage == null && !(wallet?.balance_minor > 0);
  if (previewing) ({usage,wallet} = homePreview());
  const configured = data.connection?.configured === true, available = data.connection?.available === true;
  const pending = new Set(Array.isArray(data.pending) ? data.pending : []);
  const pendingLabels = {customer_not_provisioned:'尚未分配账号，请联系管理员',customer_sync_pending:'客户信息同步待确认',grants_unavailable:'权益数据暂不可用',devices_unavailable:'设备数据暂不可用',usage_unavailable:'用量统计暂不可用',core_unavailable:'上游连接暂不可用',runtime_suspension_sync_pending:'停用状态仍在同步'};
  const reliable = configured && available && !pending.has('customer_not_provisioned') && !pending.has('customer_sync_pending');
  const usageKnown = previewing || (reliable && !pending.has('usage_unavailable') && usage != null);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(),now.getMonth(),now.getDate());
  const dayAgo = new Date(now.getTime() - 86400000);
  let today = null, recent = null;
  if (!previewing && reliable && !pending.has('usage_unavailable')) [today,recent] = await Promise.all([usageSummary(todayStart,now),usageSummary(dayAgo,now)]);
  const root = el('div',{class:'page-content overview-page'});
  if (previewing) root.append(notice('预览数据','这一组用量和余额只用来看首页效果，不是当前账户的真实记录。','warn'));
  else if (!configured || !available) root.append(notice(configured ? '上游连接暂不可用' : '工作空间尚未连接上游服务',configured ? '当前无法确认用量的实时状态；请稍后重试或联系管理员。' : '请联系管理员完成服务端连接配置。账单与用量不会用示例数据替代。','warn'));
  if (!previewing && pending.size) root.append(notice('还有待完成的事项',[...pending].map(item => pendingLabels[item] || item).join(' · '),'warn'));
  const cumulativeCost = usageKnown ? formatUSD(usage.cost_usd) : null;
  const cumulativeRequests = usageKnown ? number(usage.requests) : null;
  root.append(el('section',{class:'stat-strip','aria-label':'账单与用量'},
    el('a',{class:'stat-cell',href:'/usage?range=today'},el('span',{class:'k',text:'今日参考费用 · USD'}),metricValue(today ? formatUSD(today.cost_usd) : null),el('span',{class:'s',text:`累计 ${cumulativeCost || '—'} · 不从钱包扣费`})),
    el('a',{class:'stat-cell',href:'/usage?range=1d'},el('span',{class:'k',text:'近 24 小时请求'}),metricValue(recent ? number(recent.requests) : null),el('span',{class:recent && finite(recent.errors) ? 's warn' : 's',text:`失败 ${recent ? number(recent.errors) : '—'} · 累计 ${cumulativeRequests || '—'}`})),
    el('a',{class:'stat-cell',href:'/usage?range=1d'},el('span',{class:'k',text:'缓存命中率'}),metricValue(formatHit(recent)),el('span',{class:'s',text:`近 24 小时 · 命中 ${recent ? formatTokens(recent.cache_read_input_tokens) : '—'}`})),
    el('a',{class:'stat-cell',href:'/wallet'},el('span',{class:'k',text:'钱包余额'}),metricValue(money(wallet?.balance_minor,wallet?.currency)),el('span',{class:'s',text:'人民币余额 · 不按参考 USD 扣费'}))));
  const bounds = chartWindow();
  let chart = null;
  if (!previewing && reliable && !pending.has('usage_unavailable') && bounds) {
    try { chart = await loadChartRows(bounds.from, bounds.to); }
    catch (error) { chart = {error: error.message || '用量图表读取失败'}; }
  }
  const figureUsage = chart?.summary || (usageKnown ? usage : null);
  const figureKnown = !!figureUsage;
  const parts = tokenParts(figureKnown ? figureUsage : null);
  const usageCard = el('section',{class:'card usage-chart-card'},
    el('div',{class:'card-head'},el('div',{},el('h2',{text:'用量'}),el('p',{text:previewing ? '预览汇总，不是当前账户记录' : chartScope()})), figureKnown && !previewing ? chartRangeControl() : null),
    el('div',{class:'card-body'},
      figureKnown && !previewing ? chartFilters(chart) : null,
      el('dl',{class:'figures'},metricPair('请求',figureKnown ? number(figureUsage.requests) : null),metricPair('输入',figureKnown ? formatTokens(figureUsage.input_tokens) : null),metricPair('缓存命中',figureKnown ? formatTokens(figureUsage.cache_read_input_tokens) : null),metricPair('缓存写入',figureKnown ? formatTokens(figureUsage.cache_creation_input_tokens) : null),metricPair('输出',figureKnown ? formatTokens(figureUsage.output_tokens) : null),metricPair('综合 Token',parts.total === null ? null : formatTokens(parts.total))),
      chart?.error ? el('p',{class:'inline-info',text:chart.error}) : null,
      figureKnown && !previewing ? usagePlot(chart) : null,
      chart?.truncated ? el('p',{class:'inline-info',text:`图表基于已读取的 ${number(chart.rows.length)} / ${number(chart.total)} 条请求。上方数字仍是该范围的服务端汇总。`}) : null,
      !figureKnown ? el('p',{class:'inline-info',text:'用量汇总尚未返回。缺失项保持未知，不会显示为 0。'}) : (finite(figureUsage.requests) === 0 ? el('p',{class:'inline-info',text:'这个范围没有请求，试试调整时间或模型筛选。'}) : null)));
  const billCard = el('section',{class:'card'},el('div',{class:'card-head'},el('div',{},el('h2',{text:'账单'}),el('p',{text:'钱包与参考费用分开计算'})),el('a',{href:'/wallet',class:'muted',text:'钱包 →'})),el('div',{class:'card-body'},el('dl',{class:'facts'},metricPair('钱包余额',money(wallet?.balance_minor,wallet?.currency)),metricPair('累计参考费用',cumulativeCost),metricPair('今日参考费用',today ? formatUSD(today.cost_usd) : null)),el('p',{class:'inline-info',text:'参考费用按价格表估算，不会从人民币钱包扣费。'})));
  const qualityCard = el('section',{class:'card'},el('div',{class:'card-head'},el('div',{},el('h2',{text:'请求质量'}),el('p',{text:'失败、未知用量和耗时'}))),el('div',{class:'card-body'},el('dl',{class:'facts'},metricPair('失败请求',usageKnown ? number(usage.errors) : null),metricPair('未知用量',usageKnown ? number(usage.unknown_usage) : null),metricPair('平均耗时',usageKnown ? formatDuration(usage.average_duration_ms) : null),metricPair('首 Token',usageKnown ? (finite(usage.average_first_token_ms) === null ? '未记录' : formatDuration(usage.average_first_token_ms)) : null))));
  root.append(el('div',{class:'usage-board'},usageCard,el('div',{class:'usage-rail'},billCard,qualityCard)));
  return root;
}
function inventoryStatus(account) {
 if(account.status==='expired'||Date.parse(account.expires_at)<=Date.now())return '已到期';
 if(account.status!=='active'||!account.details||!['available','limited'].includes(account.details.state))return '不可用';
 return account.assigned?'已分配':'可分配';
}
async function inventoryView() {
 const data=await api('/api/admin/inventory'),accounts=collection(data,'accounts');
 const customerId=new URLSearchParams(location.search).get('user_id');
 const shown=customerId?accounts.filter(a=>a.user_id===customerId):accounts;
 const inventory=table([
  {label:'账号',render:a=>el('div',{},el('strong',{text:a.details?.name||a.id}),el('span',{class:'table-sub',text:a.platform}))},
  {label:'规格',render:a=>a.details?.plan||'Claude'},
  {label:'账号到期',render:a=>date(a.expires_at)},
  {label:'状态',render:a=>el('div',{},el('span',{class:'badge',text:inventoryStatus(a)}),inventoryStatus(a)==='不可用'?el('span',{class:'table-sub',text:a.status!=='active'?'账号已释放':'上游状态未就绪，请联系平台管理员'}):null)},
  {label:'使用客户',render:a=>a.assigned?el('div',{},el('strong',{text:a.customer_name||'已分配客户'}),el('span',{class:'table-sub',text:a.customer_email||''}),el('span',{class:'table-sub',text:'客户到期：'+date(a.customer_expires_at)})):'—'},
  {label:'设备',render:a=>a.details?.device_name||'未绑定'},
  {label:'操作',render:a=>el('div',{class:'button-row'},
   el('button',{class:'btn small',text:'账号详情',onclick:()=>editorDialog('账号详情',accountCard({...a.details,id:a.id,platform:a.platform,expires_at:a.expires_at,device_limit:1},true))}),
   !a.assigned?el('button',{class:'btn small',text:'分配客户',disabled:inventoryStatus(a)!=='可分配',onclick:()=>assignInventoryAccount(a)}):[
    el('button',{class:'btn small',text:'延长客户有效期',disabled:a.status!=='active'||!a.grant_revision||Date.parse(a.customer_expires_at)>=Date.parse(a.expires_at),onclick:()=>extendCustomerAccount(a)}),
    actionButton('收回账号',async()=>await confirmAction('收回账号',`收回「${a.details?.name||'此账号'}」对「${a.customer_name||'当前客户'}」的授权。原客户和设备将不能继续使用，确认成功后才可重新分配。`,'确认收回',true)?api('/api/admin/grants/'+encodeURIComponent(a.grant_id),{method:'PATCH',body:{expected_revision:a.grant_revision,status:'revoked'}}):CANCEL,{danger:true,disabled:!a.grant_id||!a.grant_revision})])}
 ],shown,'暂无账号',customerId?'这位客户尚未获得账号，请返回全部库存选择可分配账号。':'请联系平台管理员分配账号。账号进入库存后，直接选择客户即可交付。');
 inventory.classList.add('rental-table');
 return el('div',{class:'page-content inventory-page'},customerId?el('a',{href:'/admin/inventory',class:'btn',text:'查看全部库存'}):null,
  el('div',{class:'stats-grid'},stat('可分配',number(accounts.filter(a=>inventoryStatus(a)==='可分配').length),'选择账号后分配客户','layers'),stat('已分配',number(accounts.filter(a=>a.assigned).length),'一份账号交付给一位客户','users')),
  panel('账号库存','选账号 → 选客户 → 确认分配。每个账号最多绑定 1 台设备。',inventory));
}
async function assignInventoryAccount(account){
 try {
  let users=collection(await api('/api/admin/users?limit=200'),'users').filter(u=>u.status==='active'),pending=null,busy=false,searchVersion=0;
  const feedback=el('div',{class:'form-message'}),search=field('搜索客户','search',{placeholder:'姓名或邮箱'});
  const picker=field('客户','user_id',{type:'select',required:true,choices:[{value:'',label:'请选择客户'},...users.map(u=>({value:u.id,label:`${u.display_name||u.email} · ${u.email}`}))]});
  const expires=field('客户到期时间','expires_at',{type:'datetime-local',hint:'留空沿用账号到期时间；只能缩短，不能超过上游期限。'});
  const submit=el('button',{class:'btn primary',type:'submit',text:'确认分配'});
  const reconcile=el('button',{class:'btn',type:'button',text:'核对分配结果',hidden:true});
  const form=el('form',{},notice(account.details?.name||'账号分配',`${account.platform} · 到期 ${date(account.expires_at)} · 单设备`),feedback,search,picker,expires,el('div',{class:'button-row'},submit,reconcile));
  const dialog=editorDialog('分配客户',form);
  search.querySelector('input').addEventListener('input',async event=>{
   const version=++searchVersion;
   try{const data=await api('/api/admin/users?limit=200&q='+encodeURIComponent(event.target.value));if(version!==searchVersion||!form.isConnected||pending)return;users=collection(data,'users').filter(u=>u.status==='active');picker.querySelector('select').replaceChildren(el('option',{value:'',text:'请选择客户'}),...users.map(u=>el('option',{value:u.id,text:`${u.display_name||u.email} · ${u.email}`})));}catch(error){if(version===searchVersion&&form.isConnected)feedback.replaceChildren(errorNotice(error));}
  });
  async function deliver(checkOnly){
   if(busy)return;
   if(!pending){
    const values=new FormData(form),selected=users.find(u=>u.id===values.get('user_id'));if(!selected)return;
    const stamp=values.get('expires_at')?Date.parse(values.get('expires_at')):Date.parse(account.expires_at);
    const end=Number.isFinite(stamp)?new Date(stamp).toISOString():null;
    if(!end||Date.parse(end)<=Date.now()||Date.parse(end)>Date.parse(account.expires_at)){feedback.replaceChildren(notice('到期时间不正确','请选择未来时间，且不能超过账号到期时间。','warn'));return;}
    pending={user_id:selected.id,resource_id:account.resource_id,account_lease_id:account.id,expected_account_revision:account.revision,expires_at:end};
   }
   busy=true;form.dataset.busy='true';form.querySelectorAll('input,select,button').forEach(n=>n.disabled=true);feedback.replaceChildren();
   try{
    if(checkOnly){
     const data=await api('/api/admin/inventory'),a=collection(data,'accounts').find(a=>a.id===account.id);
     if(!a||a.revision!==pending.expected_account_revision+1||!a.assigned||a.user_id!==pending.user_id||Date.parse(a.customer_expires_at)!==Date.parse(pending.expires_at)){
      feedback.replaceChildren(notice('尚未确认交付','可以按原信息重试；系统会核对同一账号版本，不会重复交付。若账号已变化，请关闭后刷新库存。','warn'));return;
     }
    }else await api('/api/admin/grants',{method:'POST',body:pending});
    if(!dialog.isConnected)return;dialog.close();toast('账号已分配给客户');await render();
   }catch(error){if(form.isConnected)feedback.replaceChildren(errorNotice(error,()=>deliver(true)));}
   finally{busy=false;form.dataset.busy='false';submit.disabled=false;submit.textContent='重试原分配';reconcile.hidden=false;reconcile.disabled=false;}
  }
  form.addEventListener('submit',event=>{event.preventDefault();void deliver(false);});reconcile.addEventListener('click',()=>deliver(true));
  dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
  dialog.querySelector('[aria-label="关闭对话框"]').addEventListener('click',event=>{if(busy){event.preventDefault();event.stopImmediatePropagation();}},true);
 }catch(error){document.getElementById('page-feedback')?.replaceChildren(errorNotice(error));}
}
function extendCustomerAccount(account){
 const form=el('form',{},notice(account.details?.name||'账号',`当前客户到期 ${date(account.customer_expires_at)}；最多可延长至 ${date(account.expires_at)}。`),field('新的客户到期时间','expires_at',{type:'datetime-local',required:true}),el('button',{class:'btn primary',type:'submit',text:'确认延长'}));
 const dialog=editorDialog('延长客户有效期',form);
 bindForm(form,values=>{const end=new Date(values.get('expires_at')).toISOString();if(Date.parse(end)<=Math.max(Date.now(),Date.parse(account.customer_expires_at))||Date.parse(end)>Date.parse(account.expires_at))throw new Error('新的到期时间必须晚于原期限，且不能超过账号到期时间。');return api('/api/admin/grants/'+encodeURIComponent(account.grant_id),{method:'PATCH',body:{expected_revision:account.grant_revision,expires_at:end}});},()=>{dialog.close();render();});
}
async function accountsView() {
  const accounts = collection(await api('/api/me/accounts'),'accounts');
  if (!accounts.length) return panel('我的账号','管理员分配后，账号会自动出现在这里。',emptyState('还没有账号','请联系管理员分配账号，无需充值或另行开通。','layers'));
  return el('div',{class:'page-content'},el('a',{href:'/devices',class:'btn small',text:'查看全部设备'}),el('div',{class:'account-grid'},accounts.map(account=>accountCard(account))),el('p',{class:'inline-info',text:'\u6362\u8d26\u53f7\uff1a\u5728\u9879\u76ee\u76ee\u5f55\u8fd0\u884c ccb account\u3002\u989d\u5ea6\u7528\u5b8c\u4f1a\u5728\u7a97\u53e3\u91cd\u7f6e\u540e\u81ea\u52a8\u6062\u590d\uff0c\u4e0d\u4ece\u94b1\u5305\u6263\u8d39\u3002'}));
}
function accountCard(account, inventory = false) {
  const windows = Array.isArray(account.quota?.windows) ? account.quota.windows : [];
  const limited = account.state === 'limited' || windows.some(item => Number(item.used_percent) >= 100);
  const surfaces = (account.surfaces || []).map(item => item === 'desktop' ? 'Desktop' : item === 'code' ? 'Claude Code' : item).join('\u3001') || 'Claude Code';
  return el('article',{class:limited ? 'account-card limited' : 'account-card'},
    el('div',{class:'account-top'},el('div',{},el('h2',{text:account.name || '\u672a\u547d\u540d\u8d26\u53f7'}),el('p',{text:`${account.plan || 'Claude'} \u00b7 ${surfaces}`})), limited ? el('span',{class:'limit-pill',text:'\u989d\u5ea6\u53d7\u9650'}) : null),
    windows.length ? el('div',{class:'quota-list'},windows.slice(0,2).map(item => quotaRow(item, limited))) : el('p',{class:'quota-empty',text:account.quota?.status === 'error' ? '\u989d\u5ea6\u6682\u65f6\u8bfb\u4e0d\u5230\u3002' : '\u4e0a\u6e38\u8fd8\u6ca1\u6709\u8fd4\u56de\u989d\u5ea6\uff0c\u4e0d\u4ee3\u8868\u5df2\u7ecf\u7528\u5b8c\u3002'}),
    limited ? el('p',{class:'quota-empty',text:'\u989d\u5ea6\u6682\u65f6\u7528\u5b8c\uff0c\u7a97\u53e3\u91cd\u7f6e\u540e\u81ea\u52a8\u6062\u590d\u3002'}) : null,
    el('p',{class:'inline-info',text:`${account.platform||'平台未提供'} · 有效期至 ${date(account.expires_at)} · 设备上限 1 台`}),
    inventory ? null : el('div',{class:'button-row'},['available','limited'].includes(account.state)?el('a',{class:'btn primary small',href:'/connect',text:'开始使用'}):el('span',{class:'badge',text:account.state==='expired'?'已到期，请联系管理员':'暂不可用，请联系管理员'}),account.device_name?el('a',{class:'btn small',href:'/devices?account_id='+encodeURIComponent(account.id),text:'更换设备'}):null),
    el('div',{class:'account-foot',text:account.device_name ? `${account.device_name} \u5728\u7528` : '\u6ca1\u6709\u8bbe\u5907\u5728\u7528'}));
}
function quotaRow(item, limited) {
  const percent = Number.isFinite(item.used_percent) ? Math.max(0, Math.min(100, item.used_percent)) : 0;
  const full = percent >= 100;
  return el('div',{class:'quota-row'},el('div',{class:'quota-label'},el('span',{text:item.label || item.key || '\u989d\u5ea6'}),el('strong',{class:full ? 'full' : '',text:`${Math.round(percent)}%`})),el('div',{class:'quota-track'},el('span',{class:full ? 'full' : '',style:`width:${percent}%`})),el('p',{text:resetLabel(item, limited || full)}));
}
function resetLabel(item, recover) {
  const at = Date.parse(item.resets_at || '');
  if (!Number.isFinite(at)) return '\u91cd\u7f6e\u65f6\u95f4\u672a\u77e5';
  const mins = Math.round((at - Date.now()) / 60000);
  if (mins <= 0) return recover ? '\u5373\u5c06\u6062\u590d' : '\u5373\u5c06\u91cd\u7f6e';
  if (mins < 60) return recover ? `${mins} \u5206\u949f\u540e\u6062\u590d` : `${mins} \u5206\u949f\u540e\u91cd\u7f6e`;
  const hours = Math.floor(mins / 60), rem = mins % 60;
  if (hours < 48) { const text = rem ? `${hours} \u5c0f\u65f6 ${rem} \u5206` : `${hours} \u5c0f\u65f6`; return recover ? `${text}\u540e\u6062\u590d` : `${text}\u540e\u91cd\u7f6e`; }
  const d = new Date(at), hh = String(d.getHours()).padStart(2,'0'), mm = String(d.getMinutes()).padStart(2,'0');
  return `\u5468${'\u65e5\u4e00\u4e8c\u4e09\u56db\u4e94\u516d'[d.getDay()]} ${hh}:${mm} \u91cd\u7f6e`;
}
async function devicesView() {
  const accountId=new URLSearchParams(location.search).get('account_id');
  const devices = collection(await api('/api/me/devices'),'devices').filter(d=>!accountId||d.current_grant_id===accountId);
  return el('div',{class:'page-content'},panel(accountId?'更换设备':'连接的设备',accountId?'先撤销旧设备连接，确认成功后再连接新设备。不会自动抢占或踢掉旧设备。':'从 CCB 客户端获取连接码后，在本站确认设备',table([
    {label:'设备',render:d => el('div',{},el('strong',{text:d.name || '未命名设备'}),el('span',{class:'table-sub',text:d.platform || '未知平台'}))},
    {label:'状态',render:d => badge(d.state)}, {label:'最近活动',render:d => date(d.last_seen)}, {label:'到期时间',render:d => date(d.expires_at)},
    {label:'操作',render:d => actionButton('撤销连接',async () => await confirmAction('撤销设备连接',`确认撤销「${d.name || '此设备'}」？此操作会阻止新的执行请求。`,'撤销连接',true) ? api(`/api/me/devices/${encodeURIComponent(d.id)}`,{method:'DELETE'}) : CANCEL,{danger:true})},
  ],devices,'还没有连接设备','在 CCB 客户端发起连接，并使用连接码确认。不会自动授权任何设备。'),el('a',{class:'btn primary',href:'/connect'},icon('terminal'),'开始使用')));
}
async function connectView() {
  const query = new URLSearchParams(location.search);
  if (query.has('code')) { state.code = query.get('code').slice(0,128); history.replaceState({},'','/connect'); }
  const preview = el('div',{}); let currentPreview = null;
  const form = el('form',{class:'form-narrow'},field('CCB 连接码','code',{required:true,maxlength:128,value:state.code,class:'code-input',autocomplete:'off',spellcheck:'false',placeholder:'输入客户端显示的连接码',hint:'先查看设备信息，再单独确认授权；不会因打开链接而自动批准。'}),el('button',{class:'btn primary',type:'submit'},icon('monitor'),'查看设备信息'));
  form.querySelector('input').addEventListener('input',() => { currentPreview = null; preview.replaceChildren(); state.code = ''; });
  bindForm(form,async values => {
    preview.replaceChildren(); currentPreview = null;
    state.code = values.get('code').trim(); if (!state.code) throw new Error('请输入连接码。');
    return api('/api/me/devices/preview',{method:'POST',body:{code:state.code}});
  },data => {
    if (!data.device || typeof data.device !== 'object') throw new Error('服务器没有返回可核对的设备信息。');
    currentPreview = {device:data.device,code:state.code}; const {device,code} = currentPreview;
    const expires = new Date(device.expires_at).getTime(); const valid = Number.isFinite(expires) && expires > Date.now();
    const approve = actionButton(device.renewal ? '确认续期此设备' : '确认授权此设备',async () => {
      if (!currentPreview || currentPreview.code !== code || new Date(device.expires_at).getTime() <= Date.now()) throw new Error('预览已失效，请重新读取设备信息。');
      if (!await confirmAction('确认设备授权',`请确认「${device.name || '未命名设备'}」（${device.platform || '未知平台'}）由您本人发起。不要批准陌生人的连接码。`,'确认授权')) return CANCEL;
      const result = await api('/api/me/devices/approve',{method:'POST',body:{code}}); if (result.ok !== true) throw Object.assign(new Error('未收到授权确认。'),{uncertain:true}); return result;
    },{disabled:!valid,onSuccess:() => { state.code = ''; currentPreview = null; navigate('/devices'); }});
    preview.replaceChildren(el('hr',{class:'form-divider'}),el('div',{class:'connection-box'},el('h2',{text:'请核对连接请求'}),el('dl',{class:'detail-list'},el('dt',{text:'设备名称'}),el('dd',{text:device.name || '未命名设备'}),el('dt',{text:'运行平台'}),el('dd',{text:device.platform || '未提供'}),el('dt',{text:'确认有效期'}),el('dd',{text:date(device.expires_at)}),el('dt',{text:'请求类型'}),el('dd',{text:device.renewal ? '设备续期' : '新设备连接'}))),valid ? approve : notice('连接码不可确认','连接码已过期或有效期不可验证，请在客户端重新发起连接。','warn'));
  });
  const checks = el('div',{class:'confirm-checks'},el('h3',{text:'确认之前，请检查'}),el('ul',{class:'section-list'},[
    ['01','请求是您本人发起的','不要批准别人发送的连接码。'],['02','客户端指向当前商户','客户端应连接当前商户的公开地址，而不是其他商户或平台后台。'],['03','账户有可用权益','没有有效授权时，设备确认不会绕过资源限制。'],
  ].map(([n,title,text]) => el('li',{},el('span',{class:'step-num',text:n}),el('div',{class:'list-copy'},el('strong',{text:title}),el('p',{text}))))),notice('无需粘贴 API 密钥','连接设备不需要提供上游账号、商户密钥或管理员凭据。'));
  const approval = panel('确认终端设备码','当前登录账户决定可使用的权益。先核对设备，再单独确认。',el('div',{class:'card-body'},form,preview,checks));
  const steps = el('ol',{class:'connection-steps'},
    el('li',{},el('h3',{text:'安装 ccb'}),el('p',{text:'需要 Node.js 18 或更新版本。Windows、macOS 和 Linux 使用同一条命令。'}),commandBlock('安装命令','npm install -g @rimuruchan/ccb'),el('p',{class:'instruction-note'},'首次启动时 ccb 会下载官方 Claude Code；电脑上已有 ',el('code',{text:'claude'}),' 时直接使用。以后用同一条命令更新。')),
    el('li',{},el('h3',{text:'登录这台电脑'}),el('p',{text:'在需要接入的电脑上运行登录命令。浏览器会打开本页，让你确认设备。'}),commandBlock('登录命令',loginCommand()),el('p',{class:'instruction-note',text:'浏览器没有自动打开时，在本页「确认终端设备码」中输入终端显示的连接码。'})),
    el('li',{},el('h3',{text:'选择账号，开始项目'}),el('p',{},'在项目目录运行 ccb。还没选账号时会列出账号供你选择，之后用 ',el('code',{text:'ccb account'}),' 切换。'),commandBlock('启动命令','ccb')));
  const reference = el('dl',{class:'connection-reference','aria-label':'常用命令'});
  for (const [name, command] of [['继续上次会话','ccb -c'],['切换账号','ccb account'],['检查连接','ccb status'],['设备续期','ccb login --renew'],['更新 Claude Code','ccb update']]) reference.append(el('div',{},el('dt',{text:name}),el('dd',{},el('code',{text:command}))));
  const guide = panel('安装与登录','安装客户端、登录本站、确认设备，然后在项目目录开始。',el('div',{class:'card-body'},steps,reference));
  const pairing = Boolean(state.code);
  return el('div',{class:pairing ? 'connect-layout confirmation-first' : 'connect-layout'},...(pairing ? [approval, guide] : [guide, approval]));
}

function loginCommand() {
  try {
    const address = new URL(String(state.public?.site?.public_origin || ''));
    if (!['http:','https:'].includes(address.protocol) || address.username || address.password || address.search || address.hash || address.pathname !== '/') return 'ccb login --gateway';
    return `ccb login --gateway ${address.origin}`;
  } catch { return 'ccb login --gateway'; }
}
function commandBlock(label, command) {
  const code = el('code',{text:command});
  const status = el('span',{class:'sr-only',role:'status'});
  const button = el('button',{class:'btn small command-copy',type:'button','aria-label':`复制${label}`,text:'复制'});
  let timer = 0;
  const block = el('div',{class:'command-block'},el('div',{class:'command-label',text:label}),el('div',{class:'command-line'},el('pre',{},code),button),status);

  button.addEventListener('click', async () => {
    const value = code.textContent;
    button.disabled = true;
    let copied = false;
    try { await navigator.clipboard.writeText(value); copied = true; }
    catch { copied = false; }
    button.disabled = false;
    if (!copied) {
      status.textContent = '无法访问剪贴板，已选中命令，请手动复制。';
      const selection = getSelection(); const range = document.createRange();
      range.selectNodeContents(code); selection.removeAllRanges(); selection.addRange(range);
      return;
    }
    button.textContent = '已复制';
    status.textContent = '命令已复制';
    clearTimeout(timer);
    timer = setTimeout(() => { button.textContent = '复制'; status.textContent = ''; }, 1800);
  });
  return block;
}

const usageRanges = [
  {id:'1h',label:'近 1 小时',ms:3600000},
  {id:'1d',label:'近 24 小时',ms:86400000},
  {id:'7d',label:'近 7 天',ms:7 * 86400000},
  {id:'30d',label:'近 30 天',ms:30 * 86400000},
  {id:'all',label:'全部时间'},
];
function statusBadge(status) {
  const code = Number(status);
  if (!Number.isInteger(code)) return badge(String(status ?? '未知'));
  const tone = code >= 200 && code < 300 ? 'good' : code === 429 || code >= 500 ? 'bad' : code >= 400 ? 'warn' : '';
  const title = code === 429 ? '429 限流，计入失败' : code >= 500 ? '服务失败' : code >= 400 ? '请求未成功' : '成功';
  return el('span',{class:`badge ${tone}`.trim(),title},el('span',{class:'dot'}),String(code));
}
function exactTokens(value) {
  const n = finite(value);
  return n === null ? '—' : new Intl.NumberFormat('zh-CN',{maximumFractionDigits:0}).format(n);
}
function cacheTokens(value) {
  const n = finite(value);
  if (n === null) return '—';
  if (Math.abs(n) >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1) + 'K';
  return exactTokens(n);
}
function formatCost(value) {
  const n = finite(value);
  if (n === null) return null;
  return (n < 0 ? '-' : '') + '$' + Math.abs(n).toFixed(6);
}
let metricPopover = null;
function closeMetricPopover() {
  if (!metricPopover) return;
  metricPopover.button.setAttribute('aria-expanded','false');
  metricPopover.panel.remove();
  metricPopover = null;
}
function placeMetricPopover(button, panel) {
  const margin = 8;
  const rect = button.getBoundingClientRect();
  const width = panel.offsetWidth;
  const height = panel.offsetHeight;
  let left = rect.right + 10;
  if (left + width > innerWidth - margin) left = Math.max(margin, rect.left - width - 10);
  let top = rect.top + rect.height / 2 - height / 2;
  top = Math.max(margin, Math.min(top, innerHeight - height - margin));
  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
}
function openMetricPopover(button, panel) {
  if (metricPopover?.button === button && metricPopover.panel.isConnected) return;
  closeMetricPopover();
  document.body.append(panel);
  placeMetricPopover(button, panel);
  button.setAttribute('aria-expanded','true');
  metricPopover = {button, panel, pinned:false};
}
function metricInfo(label, build) {
  const button = el('button',{type:'button',class:'metric-info','aria-label':label,'aria-expanded':'false','aria-haspopup':'dialog'},icon('info'));
  const show = () => openMetricPopover(button, build());
  button.addEventListener('mouseenter', show);
  button.addEventListener('focus', show);
  button.addEventListener('mouseleave', () => { if (metricPopover?.button === button && !metricPopover.pinned && document.activeElement !== button) closeMetricPopover(); });
  button.addEventListener('blur', () => { if (metricPopover?.button === button && !metricPopover.pinned) closeMetricPopover(); });
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    if (metricPopover?.button === button && metricPopover.pinned) closeMetricPopover();
    else { show(); if (metricPopover?.button === button) metricPopover.pinned = true; }
  });
  return button;
}
document.addEventListener('click', event => { if (metricPopover?.pinned && !metricPopover.button.contains(event.target)) closeMetricPopover(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMetricPopover(); });
addEventListener('scroll', () => closeMetricPopover(), true);
addEventListener('resize', () => { if (metricPopover) placeMetricPopover(metricPopover.button, metricPopover.panel); });
function detailRow(row) {
  return el('div',{class:`metric-popover-row${row.total ? ' total' : ''}`},
    el('span',{},row.label, row.tag ? el('span',{class:`token-tag${row.tag === '1h' ? ' hour' : ''}`,text:row.tag}) : null),
    el('strong',{text:row.value}));
}
function detailPopover(title, rows, note, extraClass) {
  return el('div',{class:`metric-popover${extraClass ? ' ' + extraClass : ''}`,role:'dialog','aria-label':title},
    el('p',{class:'metric-popover-title',text:title}),
    el('div',{class:'metric-popover-list'},rows.map(detailRow)),
    note ? el('p',{class:'metric-popover-note',text:note}) : null);
}
function tokenPopoverRows(detail) {
  const rows = detail.tokens.map(item => ({label:item.label, value:exactTokens(item.tokens), tag:item.tag}));
  if (detail.totalTokens !== null) rows.push({label:'总 Token', value:exactTokens(detail.totalTokens), total:true});
  return rows;
}
function requestTokens(row) {
  if (row.usage_complete === false || !row.usage) return el('div',{class:'record-stack'},el('span',{text:'未知'}),el('span',{class:'record-secondary',text:row.count_only ? '仅计数，用量未完整记录' : '用量未完整记录，不计为零'}));
  const usage = row.usage;
  const detail = usageDetail(row);
  const cache = el('div',{class:'token-line'});
  if ((finite(usage.cache_read_input_tokens) || 0) > 0) cache.append(el('span',{class:'tok-read',title:'缓存读取'},icon('cache'),cacheTokens(usage.cache_read_input_tokens)));
  if ((finite(usage.cache_creation_input_tokens) || 0) > 0) cache.append(el('span',{class:'tok-write',title:'缓存写入'},icon('edit'),cacheTokens(usage.cache_creation_input_tokens),(finite(usage.cache_creation_1h) || 0) > 0 ? el('span',{class:'token-tag',text:'1h'}) : null));
  const note = detail.totalTokens === null ? 'Token 记录不完整，无法计算合计。' : '';
  return el('div',{class:'token-cell'},el('div',{},
    el('div',{class:'token-line'},el('span',{class:'tok-in',title:'输入'},icon('down'),exactTokens(usage.input_tokens)),el('span',{class:'tok-out',title:'输出'},icon('up'),exactTokens(usage.output_tokens))),
    cache.childNodes.length ? cache : null),
    metricInfo('查看 Token 明细', () => detailPopover('Token 明细', tokenPopoverRows(detail), note)));
}
function requestCost(row) {
  if (row.count_only) return el('span',{class:'cost-note',text:'不计费'});
  const cost = formatCost(row.cost_usd);
  if (!cost) return el('span',{class:'is-unknown',text:'—'});
  const detail = usageDetail(row);
  const rows = detail.tokens.map(item => ({label:item.label, value:exactTokens(item.tokens), tag:item.tag}));
  if (detail.totalTokens !== null) rows.push({label:'总 Token', value:exactTokens(detail.totalTokens)});
  rows.push({label:'参考费用', value:cost, total:true});
  return el('div',{class:'cost-cell'},el('span',{class:'cost-value',text:cost}),metricInfo('查看参考费用明细', () => detailPopover('参考费用明细', rows, '', 'cost-popover')),row.usage_complete !== true ? el('span',{class:'record-secondary',text:'用量未完整确认'}) : null);
}
function requestTiming(row) {
  const first = row.count_only || row.stream !== true ? '不适用' : (finite(row.first_token_ms) === null ? '未记录' : formatDuration(row.first_token_ms));
  return el('div',{class:'record-stack'},el('span',{class:'record-primary',text:formatDuration(row.duration_ms)}),el('span',{class:'record-secondary',text:`首 Token ${first}`}));
}
async function usageView() {
  const params = new URLSearchParams(location.search);
  const requestedOffset = Number(params.get('offset'));
  const offset = Number.isSafeInteger(requestedOffset) && requestedOffset >= 0 ? requestedOffset : 0;
  const requested = params.get('range');
  const hasBounds = params.has('from') || params.has('to');
  const range = requested === 'today' || usageRanges.some(item => item.id === requested) ? requested : (hasBounds || requested === 'custom' ? 'custom' : '1d');
  let from = params.get('from') || '', to = params.get('to') || '';
  if (range === 'today') {
    const start = new Date(); start.setHours(0,0,0,0);
    from = start.toISOString(); to = new Date().toISOString();
  } else if (range !== 'all' && range !== 'custom' && !hasBounds) {
    const spec = usageRanges.find(item => item.id === range);
    const end = new Date();
    to = end.toISOString();
    from = new Date(end.getTime() - spec.ms).toISOString();
  } else if (range === 'all') { from = ''; to = ''; }
  const query = new URLSearchParams({limit:'20',offset:String(offset)});
  if (from) query.set('from',from);
  if (to) query.set('to',to);
  const data = await api(`/api/me/usage?${query}`);
  const requests = collection(data,'requests'), usage = data.usage;
  const label = range === 'today' ? '今日' : range === 'custom' ? '自定义范围' : usageRanges.find(item => item.id === range)?.label;
  const form = el('form',{class:'filter-bar'},field('开始日期','from',{type:'date',value:localDay(from)}),field('结束日期','to',{type:'date',value:localDay(to)}),el('button',{class:'btn',type:'submit',text:'查询'}));
  form.addEventListener('submit',event => {
    event.preventDefault();
    const values = new FormData(form), start = values.get('from'), end = values.get('to');
    if (start && end && start > end) { document.getElementById('page-feedback').replaceChildren(notice('日期范围有误','开始日期不能晚于结束日期。','error')); return; }
    const next = new URLSearchParams();
    if (!start && !end) next.set('range','all');
    else {
      next.set('range','custom');
      if (start) next.set('from',new Date(`${start}T00:00:00`).toISOString());
      if (end) next.set('to',new Date(`${end}T23:59:59.999`).toISOString());
    }
    navigate(`/usage?${next}`);
  });
  const total = Number.isSafeInteger(data.total) ? data.total : null;
  const pageOf = nextOffset => {
    const next = new URLSearchParams({range});
    if (from) next.set('from',from);
    if (to) next.set('to',to);
    if (nextOffset > 0) next.set('offset',String(nextOffset));
    navigate(`/usage?${next}`);
  };
  const pager = el('div',{class:'pager'},el('span',{text:total === null ? '总数未提供' : `共 ${number(total)} 条 · 第 ${Math.floor(offset/20)+1} 页`}),el('button',{class:'btn small',disabled:offset === 0,type:'button',text:'上一页',onclick:() => pageOf(Math.max(0,offset-20))}),el('button',{class:'btn small',disabled:total === null || offset + 20 >= total,type:'button',text:'下一页',onclick:() => pageOf(offset+20)}));
  const seg = el('div',{class:'seg',role:'group','aria-label':'时间范围'},usageRanges.map(item => el('button',{type:'button',class:range === item.id ? 'on' : '','aria-pressed':range === item.id ? 'true' : 'false',text:item.label,onclick:() => { const next = new URLSearchParams({range:item.id}); if (item.ms) { const end = new Date(); next.set('to',end.toISOString()); next.set('from',new Date(end.getTime() - item.ms).toISOString()); } navigate(`/usage?${next}`); }})));
  return el('div',{class:'page-content usage-page'},
    recordStats(usage,label),
    !usage ? notice('统计尚不可用','服务器尚未返回用量汇总。下方仅展示实际返回的请求记录。','warn') : null,
    panel('请求记录','模型调用和 Token 用量。参考费用不会从钱包扣费。',el('div',{},el('div',{class:'record-toolbar'},seg,form),table([
      {label:'时间',render:row => date(row.time)},
      {label:'模型 / 状态',render:row => el('div',{class:'record-stack'},el('span',{class:'record-primary',text:row.model || '—'}),el('span',{class:'record-secondary'},statusBadge(row.status),row.stream ? ' 流式' : '',row.count_only ? ' 计数' : ''))},
      {label:'Token',render:requestTokens},
      {label:'参考费用',render:requestCost},
      {label:'总时长 / 首 Token',render:requestTiming},
    ],requests,'此区间暂无请求','换一个时间范围，或在获得权益并连接设备后开始使用。'),pager)));
}
function orderTable(orders, showCustomer = false) {
  return table([...(showCustomer ? [{label:'客户标识',render:o => el('span',{class:'mono',text:o.user_id || '未提供'})}] : []),{label:'订单编号',render:o => el('span',{class:'mono',text:o.id})},{label:'支付方式',render:o=>({stripe:'Stripe',alipay:'支付宝',wxpay:'微信支付',airwallex:'Airwallex'}[o.payment_method]||'Stripe')},{label:'用途',render:o=>o.rental_id?'套餐支付':'余额充值'},{label:'金额',render:o => money(o.amount_minor,o.currency)},{label:'支付状态',render:o => badge(o.status)},{label:'创建时间',render:o => date(o.created_at)},{label:'操作',render:o=>['creating','pending','unknown'].includes(o.status)?el('div',{class:'button-row'},actionButton('核对支付',()=>api(`/api/${showCustomer?'admin':'me'}/payments/${encodeURIComponent(o.id)}/reconcile`,{method:'POST',body:{}})),showCustomer?null:el('a',{class:'btn small',href:'/wallet?order='+encodeURIComponent(o.id),text:'继续支付'})):'—'}],orders,'暂无支付订单','只有服务器创建的真实支付订单才会出现在这里。');
}
async function walletView() {
  const [data, catalog] = await Promise.all([api('/api/me/wallet'), api('/api/plans'+(new URLSearchParams(location.search).get('renew_grant_id')?'?renew_grant_id='+encodeURIComponent(new URLSearchParams(location.search).get('renew_grant_id')):'')).catch(error=>({plans:[],catalogError:error.message}))]);
  const plans = collection(catalog,'plans');
  const enabled = state.public.features.payment === true && state.public.features.recharge !== false;
  const result = el('div',{});
  const balanceValue=el('div',{class:'amount',text:money(data.wallet?.balance_minor,data.wallet?.currency)});
  const history=el('div',{class:'wallet-history'});
  function paintWallet(snapshot) {
    balanceValue.textContent=money(snapshot.wallet?.balance_minor,snapshot.wallet?.currency);
    history.replaceChildren(
      panel('最近支付订单','以服务端确认状态为准',orderTable(collection(snapshot,'orders'))),
      panel('资金记录','所有金额使用人民币最小单位换算显示',table([
        {label:'记录时间',render:r=>date(r.created_at)},
        {label:'类型',render:r=>({stripe_credit:'Stripe 支付入账',payment_credit:'在线支付入账',rental_debit:'套餐购买扣款',rental_refund:'未交付退回余额'}[r.kind]||r.kind||'未提供')},
        {label:'变动金额',render:r=>money(r.amount_minor,r.currency||snapshot.wallet?.currency)},
        {label:'关联订单',render:r=>el('span',{class:'mono',text:r.rental_id||r.order_id||'—'})},
      ],collection(snapshot,'ledger'),'暂无资金记录','没有发生过服务器确认的资金变动。')));
  }
  async function refreshWallet(){try{paintWallet(await api('/api/me/wallet'));}catch{balanceValue.textContent='—';}}

  const presets = ['50','100','200','500'];
  const form = el('form',{class:'recharge-form'},
    field('支付方式','payment_method',{type:'select',required:true,disabled:!enabled,choices:(state.public.payment?.methods||[]).map(method=>({value:method.id,label:method.title}))}),
    field('充值金额（人民币元）','amount',{required:true,type:'number',min:String((state.public.payment?.min_amount_minor || 1)/100),max:state.public.payment?.max_amount_minor?String(state.public.payment.max_amount_minor/100):undefined,step:'0.01',inputmode:'decimal',placeholder:'0.00',disabled:!enabled,hint:'实际支付金额以支付平台和服务器订单为准。'}),
    el('div',{class:'amount-choices'}, presets.map(amount => el('button',{type:'button',class:'amount-choice','data-amount':amount,disabled:!enabled,text:`¥${amount}`,onclick() {
      const input = form.querySelector('input[name=amount]');
      if (!input || input.disabled) return;
      input.value = amount;
      input.dispatchEvent(new Event('input',{bubbles:true}));
      input.focus();
    }}))),
    el('button',{class:'btn primary',type:'submit',disabled:!enabled},icon('wallet'),enabled ? '创建支付订单' : '在线支付未启用'));
  form.querySelector('input[name=amount]')?.addEventListener('input', event => {
    for (const chip of form.querySelectorAll('.amount-choice')) chip.classList.toggle('on', chip.dataset.amount === event.currentTarget.value);
  });
  bindForm(form,async values => {
    if (!enabled) throw new Error('当前未启用余额充值。');
    const amount = values.get('amount').trim(); if (!/^\d+(\.\d{1,2})?$/.test(amount)) throw new Error('请输入最多两位小数的有效金额。');
    const [whole,fraction = ''] = amount.split('.'); const minor = Number(whole)*100 + Number(fraction.padEnd(2,'0'));
    if (!Number.isSafeInteger(minor) || minor < 1) throw new Error('金额超出可处理范围。');
    if (!await confirmAction('创建真实支付订单',`确认创建 ${money(minor)} 的支付订单？接下来会提供二维码或收银台，不会在此页面自动扣款。`,'创建订单')) return CANCEL;
    return api('/api/me/payments',{method:'POST',body:{amount_minor:minor,payment_method:values.get('payment_method')}});
  },async (payment,message) => {
    if (!payment.order?.id) throw Object.assign(new Error('订单创建结果不完整，请先刷新核对。'),{uncertain:true});
    result.replaceChildren(paymentCheckout(payment,{el,notice,errorNotice,api,onSettled:refreshWallet}));
    await refreshWallet();
  });
  const root = el('div',{class:'page-content wallet-page'},
    el('div',{class:'wallet-top'},
      panel('账户余额','以服务器账本为准',el('div',{class:'card-body'},el('div',{class:'balance-card'},el('p',{text:'可用余额 · CNY'}),balanceValue,el('p',{text:'余额不等于账号。购买并交付后，请在「我的账号」查看。'})))),
      panel('在线充值','选择已配置的支付方式，扫码或前往收银台',el('div',{class:'card-body'},!enabled ? notice('支付服务尚未配置','暂时无法发起在线支付。请联系管理员；不会创建虚拟订单或显示模拟到账。','warn') : null,state.public.payment?.help_text?notice('支付帮助',state.public.payment.help_text):null,form,result))));
  const orderId = new URLSearchParams(location.search).get('order');
  if (orderId) {
    try { const payment = await api(`/api/me/payments/${encodeURIComponent(orderId)}`); if (!payment.order) throw new Error('订单信息缺失。'); root.prepend(panel('返回后的订单核对','回跳网址中的成功参数不会改变余额或订单状态',el('div',{},orderTable([payment.order]),paymentCheckout(payment,{el,notice,errorNotice,api})))); }
    catch (error) { root.prepend(errorNotice(error)); }
  }
  paintWallet(data);
  root.append(catalog.catalogError?notice('订阅目录暂不可用',catalog.catalogError,'warn'):subscriptionPanel(plans),history);
  return root;
}
async function profileView() {
  const user = state.user;
  const form = el('form',{class:'form-narrow'},field('当前密码','current_password',{type:'password',required:true,autocomplete:'current-password',maxlength:256}),field('新密码','new_password',{type:'password',required:true,minlength:7,maxlength:256,autocomplete:'new-password',hint:'至少 7 个字符，建议使用未在其他站点用过的密码。'}),field('确认新密码','confirmation',{type:'password',required:true,minlength:7,maxlength:256,autocomplete:'new-password'}),el('button',{class:'btn primary',type:'submit',text:'更新密码'}));
  bindForm(form,async values => {
    if (values.get('new_password') !== values.get('confirmation')) throw new Error('两次输入的新密码不一致。');
    if (!await confirmAction('更新登录密码','确认修改当前账户的密码？更新后请使用新密码重新登录。','更新密码')) return CANCEL;
    return api('/api/auth/password',{method:'PATCH',body:{current_password:values.get('current_password'),new_password:values.get('new_password')}});
  },(data,message) => { if (data.ok !== true) throw Object.assign(new Error('密码更新尚未确认。'),{uncertain:true}); state.user = null; state.csrf = null; state.returnTo = '/profile'; navigate('/login',true); toast('密码已更新，请使用新密码重新登录。'); });
  return el('div',{class:'equal-col'},panel('账户信息','身份由当前服务端会话确定',el('div',{class:'card-body'},el('div',{class:'identity-card'},el('span',{class:'avatar',text:(user.display_name || user.email).slice(0,1).toUpperCase()}),el('div',{},el('h2',{text:user.display_name}),el('p',{class:'muted',text:user.email}))),el('dl',{class:'detail-list'},el('dt',{text:'账户角色'}),el('dd',{},badge(user.role)),el('dt',{text:'账户状态'}),el('dd',{},badge(user.status)),el('dt',{text:'账号交付'}),el('dd',{},el('a',{href:'/accounts',text:'查看我的账号'}))),el('hr',{class:'form-divider'}),notice('需要修改账户资料？','请联系商户管理员。账户身份不可在浏览器中手动切换。'))),panel('登录安全','修改您的站点登录密码',el('div',{class:'card-body'},form)));
}

function editorDialog(title, form) {
  const previous = document.activeElement;
  const dialog = el('dialog',{class:'dialog','aria-label':title});
  dialog.append(el('div',{class:'dialog-head'},el('h2',{text:title}),el('button',{class:'icon-button',type:'button','aria-label':'关闭对话框',onclick:() => dialog.close()},icon('close'))),form);
  dialog.addEventListener('close',() => { form.querySelectorAll('input[type=password]').forEach(n => n.value = ''); dialog.remove(); if (previous?.isConnected) previous.focus(); },{once:true});
  document.body.append(dialog); dialog.showModal(); return dialog;
}
function customerEditor(user) {
  const create = !user; const form = el('form',{});
  if (create) form.append(field('电子邮箱','email',{type:'email',required:true,maxlength:254,autocomplete:'off'}),field('初始密码','password',{type:'password',required:true,minlength:7,maxlength:256,autocomplete:'new-password',hint:'请通过安全渠道交付；保存后不会显示。'}));
  form.append(field('显示名称','display_name',{required:true,maxlength:100,value:user?.display_name || ''}),field('账户角色','role',{type:'select',choices:[{value:'member',label:'成员'},{value:'admin',label:'管理员'}],value:user?.role || 'member'}));
  if (!create) form.append(field('账户状态','status',{type:'select',choices:[{value:'active',label:'正常'},{value:'disabled',label:'停用'}],value:user.status,disabled:user.id === state.user.id,hint:user.id === state.user.id ? '不能停用当前登录的管理员。' : '停用会影响该账户的站点访问。'}));
  form.append(el('button',{class:'btn primary',type:'submit',text:create ? '创建客户账户' : '保存客户信息'}));
  const dialog = editorDialog(create ? '创建客户账户' : `编辑 ${user.display_name || user.email}`,form);
  bindForm(form,async values => {
    const payload = Object.fromEntries(values);
    if (!await confirmAction(create ? '确认创建客户' : '确认修改客户',`将${create ? '创建' : '更新'}「${payload.display_name}」的站点账户，角色为${payload.role === 'admin' ? '管理员' : '成员'}。创建客户后，在账号库存中分配账号。`,'确认保存')) return CANCEL;
    return api(create ? '/api/admin/users' : `/api/admin/users/${encodeURIComponent(user.id)}`,{method:create ? 'POST' : 'PATCH',body:payload});
  },async data => {
    if (!data.user) throw Object.assign(new Error('未收到客户变更确认。'),{uncertain:true});
    dialog.close(); toast('客户信息已保存');
    if (user?.id === state.user.id) {
      try { adoptSession(await api('/api/auth/session')); }
      catch { state.user = null; state.csrf = null; state.returnTo = '/'; navigate('/login',true); return; }
    }
    render();
  });
}
async function customersView() {
  const params=new URLSearchParams(location.search),offset=Math.max(0,Number(params.get('offset'))||0),query=new URLSearchParams({limit:'50',offset:String(offset),q:params.get('q')||''});
  const data=await api(`/api/admin/users?${query}`),users=collection(data,'users');
  const search=el('form',{class:'button-row'},el('input',{name:'q',value:query.get('q'),placeholder:'搜索客户邮箱或名称','aria-label':'搜索客户'}),el('button',{class:'btn',type:'submit',text:'搜索'}));search.addEventListener('submit',event=>{event.preventDefault();navigate('/admin/customers?q='+encodeURIComponent(new FormData(search).get('q')));});
  const pager=el('div',{class:'pager'},el('span',{text:`共 ${data.total} 位客户 · 本页 ${users.length} 位`}),...[-50,50].map(delta=>el('button',{class:'btn small',text:delta<0?'上一页':'下一页',disabled:delta<0?offset===0:offset+users.length>=data.total,onclick:()=>{query.set('offset',String(Math.max(0,offset+delta)));navigate(`/admin/customers?${query}`);}})));
  return el('div',{class:'page-content'},search,pager,panel('客户账户',`${number(users.length)} 个站点账户`,table([
    {label:'客户',render:u => el('div',{},el('strong',{text:u.display_name || '未命名客户'}),el('span',{class:'table-sub',text:u.email}))},
    {label:'角色 / 状态',render:u => el('div',{class:'button-row'},badge(u.role),badge(u.status))},
    {label:'创建时间',render:u => date(u.created_at)},
    {label:'操作',render:u => el('div',{class:'table-actions'},el('button',{class:'btn small',type:'button',text:'编辑',onclick:()=>customerEditor(u)}),el('a',{class:'btn small',href:`/admin/inventory?user_id=${encodeURIComponent(u.id)}`,text:'查看账号'}))},
  ],users,'暂无客户账户','创建客户后，在账号库存选择账号并分配给客户。'),el('button',{class:'btn primary',type:'button',onclick:() => customerEditor()},icon('plus'),'创建客户')));
}
function showSecret(data) {
  const secret = el('code',{class:'secret',text:data.token});
  const dialog = el('dialog',{class:'dialog','aria-label':'接入密钥'});
  const discard = () => { secret.textContent = ''; data.token = ''; if (dialog.open) dialog.close(); dialog.remove(); };
  dialog.append(el('div',{class:'dialog-head'},el('h2',{text:'接入密钥'})),notice('关闭后仍可再次查看','撤销前可以在密钥列表中打开原文。撤销后会删除原文，无法恢复。不要放入客户端代码、截图或公开文档。','warn'),secret,el('p',{text:'密钥名称：' + (data.key?.name || '未命名') + '。列表不直接展示原文。'}),el('div',{class:'dialog-actions'},el('button',{class:'btn primary',type:'button',text:'关闭',onclick:discard})));
  dialog.addEventListener('cancel',event => { event.preventDefault(); discard(); });
  dialog.addEventListener('close',discard,{once:true});
  document.body.append(dialog); dialog.showModal();
}

async function ordersView() {
  const orders = collection(await api('/api/admin/orders'),'orders');
  return el('div',{class:'page-content'},state.public.features.payment !== true ? notice('在线支付未启用','此处仍可查看已有真实订单，但不会模拟收款或提供手工入账。','warn') : null,panel('支付订单',`${number(orders.length)} 条服务器记录`,orderTable(orders,true)));
}
async function auditView() {
  const events = collection(await api('/api/admin/audit'),'events');
  return panel('操作审计','只展示结构化操作信息，不输出敏感请求内容',table([
    {label:'时间',render:e => date(e.created_at)}, {label:'操作',render:e => e.action || '未提供'},
    {label:'操作者',render:e => el('span',{class:'mono',text:e.actor_id || '系统'})},
    {label:'目标',render:e => el('span',{class:'mono',text:e.subject_id || '—'})}, {label:'结果',render:e => e.outcome ? badge(e.outcome) : '结果未提供'},
  ],events,'暂无审计记录','管理操作产生后，服务器记录将展示在此处。'));
}

function switchRow(title, hint, name, checked) {
  return el('div',{class:'switch-row'},el('div',{},el('strong',{text:title}),el('p',{text:hint})),el('label',{class:'switch'},el('input',{type:'checkbox',name,'aria-label':title,checked:checked===true}),el('span')));
}
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


async function settingsView() {
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
    if (!await confirmAction('保存站点公开设置','将修改本站展示信息与注册开关。不会修改上游密钥、邮件或支付凭据。','确认保存')) return CANCEL;
    return api('/api/admin/settings',{method:'PATCH',body:{name:values.get('name').trim(),description:values.get('description').trim(),support_email:values.get('support_email').trim(),logo_url:values.get('logo_url').trim(),accent_color:values.get('accent_color'),registration_enabled:values.get('registration_enabled') === 'on'}});
  },(data,message) => {
    if (!data.site || !data.features) throw Object.assign(new Error('站点设置更新结果不完整。'),{uncertain:true});
    state.public.site = data.site; state.public.features = data.features;
    if (/^#[0-9a-fA-F]{6}$/.test(data.site.accent_color || '')) document.documentElement.style.setProperty('--primary',data.site.accent_color);
    document.querySelectorAll('.brand-name').forEach(node => node.textContent = data.site.name);
    message.replaceChildren(notice('公开设置已保存','展示信息和注册开关已由服务器确认。','success'));
  });
  const upstream = el('div',{id:'upstream',class:'settings-section'});
  upstream.append(notice('使用直接上级发给本站的密钥','初始化令牌只用于创建管理员。不要填写平台管理员密钥，也不要填写上级自己的接入密钥。','warn'));
  upstream.append(panel('上游接入','地址和权限来自本站服务端，密钥原文不会返回。',el('div',{class:'card-body'},
    el('div',{class:'connection-box'},el('div',{class:'button-row'},icon('link'),el('strong',{text:'上游服务连接'}),el('span',{class:`badge ${connection.available === true ? 'good' : 'warn'}`,text:connection.configured === true ? (connection.available === true ? '已连接' : '已配置 · 暂不可用') : '未配置'}))),
    connection.error ? notice('上游暂不可用',`请核对接地址、密钥和允许的来源。服务端状态：${connection.error}`,'warn') : null,
    el('dl',{class:'detail-list'},
      el('dt',{text:'本站公开地址'}),el('dd',{class:'mono',text:connection.public_origin || location.origin}),
      el('dt',{text:'上游地址'}),el('dd',{'data-upstream-summary':'url',class:'mono',text:connection.upstream_url || '未配置'}),
      el('dt',{text:'商户身份'}),el('dd',{'data-upstream-summary':'name',text:connection.merchant?.name || '尚未核实'}),
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
      field('上游商户密钥','api_key',{required:true,type:'password',autocomplete:'off',spellcheck:'false',placeholder:'ccbm_…',hint:'由直接上级单独签发给本站。不会写入浏览器存储。'}),
      field('接入操作','action',{type:'select',choices:[{value:'verify',label:'仅验证，不保存'},{value:'save',label:'验证并保存'}],value:'verify'}),
      el('button',{type:'submit',class:'btn primary',text:'执行接入检查'}));
    bindForm(upstreamForm,async values => {
      const body = {action:values.get('action'),url:values.get('url').trim(),api_key:values.get('api_key').trim(),expected_revision:revision};
      if (body.action === 'save' && !await confirmAction('保存上游连接','将先验证上游身份、协议版本和权限，再把密钥加密保存在服务端。已有业务数据不能改绑到另一个上游身份。','确认保存')) return CANCEL;
      return api('/api/admin/upstream',{method:'POST',body});
    },data => {
      revision = data.revision;
      const current = data.connection;
      output.replaceChildren(notice(data.saved ? '上游连接已保存' : '连接验证通过，尚未保存',`${current.merchant.name} · 直接接入账户 · 协议 v${current.protocol_version}`,'success'),el('p',{class:'inline-info',text:`已授权权限：${current.scopes.join(' · ')}`}),el('a',{href:'/admin/inventory',class:'btn',text:'查看账号库存 →'}));
      if (data.saved) {
        state.public.features.term_rentals = true;
        upstreamForm.querySelector('[name=api_key]').value = '';
        upstream.querySelector('[data-upstream-summary=url]').textContent = new URL(upstreamForm.querySelector('[name=url]').value).origin;
        upstream.querySelector('[data-upstream-summary=name]').textContent = current.merchant.name;
        upstream.querySelector('[data-upstream-summary=status]').replaceChildren(badge('active'));
      }
    });
    upstream.append(panel('上游接入配置','先验证身份与权限，再保存。网络拒绝或验证失败不会替换当前配置。',el('div',{class:'card-body'},upstreamForm,output)));
  }
  upstream.append(el('a',{href:'/',class:'btn',text:'稍后配置，返回工作台'}));
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
  const settingsUI = {el,field,switchRow,panel,notice,errorNotice,bindForm,confirmAction,api,state,CANCEL};
  const mailPage = mailSettingsView(settingsUI, mailData.mail);
  const paymentPage = paymentSettingsView(settingsUI, paymentData.payment);
  const pages = [
    ['public','公开信息',el('section',{id:'public',class:'settings-section'},panel('公开站点信息','名称、简介、标识和注册开关会显示在登录页与工作台。',el('div',{class:'card-body'},form)))],
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


function purchaseDialog(plan) {
 const requestId=crypto.randomUUID();
 const platforms=Array.isArray(plan.platforms)?plan.platforms:[];
 const form=el('form',{},notice('\u786e\u8ba4\u8ba2\u9605',`${plan.name} \u00b7 ${plan.duration_days} \u5929 \u00b7 ${money(plan.amount_minor)}\u3002\u6309 24 \u5c0f\u65f6\u8ba1\u4e00\u5929\uff0c\u4e0d\u81ea\u52a8\u7eed\u8d39\u3002\u8bf7\u5355\u9009\u4e00\u4e2a\u767b\u5f55\u5e73\u53f0\uff0c\u6709\u8d27\u624d\u80fd\u4e0b\u5355\u3002`),
  field('\u767b\u5f55\u5e73\u53f0','platform',{type:'select',required:true,choices:platforms.map(item=>({value:item.platform,label:`${item.label||item.platform} \u00b7 ${item.available>0?`\u6709\u8d27 ${item.available}`:'\u65e0\u8d27'}`})),value:platforms.find(item=>item.available>0)?.platform||''}),
  field('支付方式','payment_method',{type:'select',choices:[{value:'wallet',label:'钱包余额'},...(state.public.payment?.methods||[]).map(method=>({value:method.id,label:method.title}))],value:'wallet'}),
  el('button',{type:'submit',class:'btn primary',text:'\u786e\u8ba4\u4e0b\u5355',disabled:!platforms.some(item=>item.available>0)}),el('a',{href:'/orders',class:'btn',text:'\u67e5\u770b\u5df2\u6709\u8ba2\u5355'}));
 const dialog=editorDialog('\u8d2d\u4e70\u8ba2\u9605',form);
 bindForm(form,async values=>{
  const platform=values.get('platform');
  const slot=platforms.find(item=>item.platform===platform);
  if(!slot||slot.available<1) throw new Error('\u8fd9\u4e2a\u5e73\u53f0\u5f53\u524d\u65e0\u8d27\uff0c\u8bf7\u6539\u9009\u5176\u4ed6\u5e73\u53f0\u3002');
  if(!await confirmAction('\u786e\u8ba4\u8d2d\u4e70\u8ba2\u9605',`${plan.name}\uff0c${plan.duration_days} \u5929\uff0c${money(plan.amount_minor)}\uff0c\u5e73\u53f0 ${slot.label||platform}\u3002\u4f59\u989d\u652f\u4ed8\u4f1a\u7acb\u5373\u6263\u6b3e\u3002`,'\u786e\u8ba4\u8d2d\u4e70'))return CANCEL;
  return api('/api/me/rentals',{method:'POST',body:{plan_id:plan.id,expected_revision:plan.revision,payment_method:values.get('payment_method'),platform,request_id:requestId,renew_grant_id:plan.renew_grant_id||''}});
 },data=>{
  if(!data.rental?.id)throw Object.assign(new Error('\u8ba2\u5355\u7ed3\u679c\u672a\u77e5\uff0c\u8bf7\u524d\u5f80\u8ba2\u5355\u6838\u5bf9\u3002'),{uncertain:true});
  const result=el('div',{class:'card-body'},badge(data.rental.status),el('p',{class:'mono',text:data.rental.id}),notice('\u8ba2\u5355\u5df2\u8bb0\u5f55','\u652f\u4ed8\u6210\u529f\u4e0d\u7b49\u4e8e\u4ea4\u4ed8\u5b8c\u6210\u3002\u4ea4\u4ed8\u540e\u8d26\u53f7\u4f1a\u8fdb\u5165\u6211\u7684\u8d26\u53f7\u3002'),el('a',{class:'btn',href:'/accounts',text:'\u67e5\u770b\u6211\u7684\u8d26\u53f7'}),el('a',{class:'btn',href:'/orders',text:'\u67e5\u770b\u8ba2\u5355'}));
  if(data.payment)result.append(paymentCheckout(data.payment,{el,notice,errorNotice,api}));
  form.replaceWith(result);
 });
 return dialog;
}
function planCard(plan) {
  const platforms = Array.isArray(plan.platforms) ? plan.platforms : [];
  const available = platforms.some(item => item.available > 0);
  const facts = [`${plan.duration_days} 天`, '不自动续费'];
  if (Number.isSafeInteger(plan.device_limit) && plan.device_limit > 0) facts.splice(1, 0, `${plan.device_limit} 台设备`);
  return el('article',{class:'plan-card'},
    el('div',{class:'plan-top'},el('span',{class:'eyebrow',text:'订阅'}),el('span',{class:`badge ${available ? 'good' : 'warn'}`},el('span',{class:'dot'}),available ? '有货' : '无货')),
    el('h2',{text:plan.name || '未命名套餐'}),
    plan.description ? el('p',{class:'plan-copy',text:plan.description}) : null,
    el('p',{class:'plan-price',text:money(plan.amount_minor, plan.currency)}),
    el('p',{class:'plan-meta',text:facts.join(' · ')}),
    platforms.length ? el('ul',{class:'platform-pills'},platforms.map(item => el('li',{class:item.available > 0 ? 'in' : 'out'},el('span',{text:item.label || item.platform}),el('strong',{text:item.available > 0 ? String(item.available) : '无货'})))) : null,
    el('button',{class:'btn primary',type:'button',text:'购买',disabled:!available,onclick:() => purchaseDialog(plan)}));
}
function subscriptionPanel(plans) {
  if (!plans.length) return panel('订阅套餐','只显示订阅分组的在售套餐。',emptyState('暂无在售套餐','商户为订阅分组设置有效期和金额后，可以在这里购买。','layers'));
  return panel('订阅套餐','选择一个登录平台。有货数量随下单变化，以服务器当时核对的库存为准。',el('div',{class:'card-body'},el('div',{class:'plan-grid'},plans.map(planCard))));
}

function planEditor(plan,resources) {
 const choices=resources.filter(resource=>resource.kind==='subscription'&&resource.status==='active'&&resource.available!==false);
 const form=el('form',{},field('\u8ba2\u9605\u5206\u7ec4','resource_id',{type:'select',choices:(choices.length?choices:resources).map(resource=>({value:resource.id,label:resource.name})),value:plan?.resource_id||choices[0]?.id,disabled:Boolean(plan)||!choices.length}),
  field('\u6709\u6548\u671f\uff08\u5929\uff0c\u6bcf\u5929 24 \u5c0f\u65f6\uff09','duration_days',{type:'number',required:true,min:1,max:366,step:1,value:plan?.duration_days||30}),
  field('\u5957\u9910\u91d1\u989d\uff08\u4eba\u6c11\u5e01\u5143\uff09','price',{type:'number',required:true,min:0.01,step:0.01,value:plan?String(plan.amount_minor/100):''}),
  field('\u4e0a\u67b6\u72b6\u6001','status',{type:'select',choices:[{value:'active',label:'\u4e0a\u67b6'},{value:'archived',label:'\u4e0b\u67b6'}],value:plan?.status||'archived'}),el('button',{class:'btn primary',type:'submit',text:'\u4fdd\u5b58\u5957\u9910'}));
 const dialog=editorDialog(plan?'\u7f16\u8f91\u5957\u9910':'\u521b\u5efa\u5957\u9910',form);
 bindForm(form,async values=>{
  const price=values.get('price');if(!/^\d+(\.\d{1,2})?$/.test(price))throw new Error('\u4ef7\u683c\u6700\u591a\u652f\u6301\u4e24\u4f4d\u5c0f\u6570\u3002');
  const [whole,fraction='']=price.split('.'),amount=Number(whole)*100+Number(fraction.padEnd(2,'0'));
  const duration=Number(values.get('duration_days'));
  const body={name:`${duration} \u5929`,description:'',duration_days:duration,amount_minor:amount,status:values.get('status'),...(plan?{expected_revision:plan.revision}:{resource_id:values.get('resource_id')})};
  if(!await confirmAction('\u4fdd\u5b58\u5957\u9910',`\u9500\u552e\u4ef7 ${money(amount)}\uff0c\u79df\u671f ${duration} \u5929\u3002\u5df2\u6709\u8ba2\u5355\u4fdd\u7559\u539f\u4ef7\u683c\u53ca\u79df\u671f\u3002`,'\u786e\u8ba4\u4fdd\u5b58'))return CANCEL;
  return api(plan?`/api/admin/plans/${encodeURIComponent(plan.id)}`:'/api/admin/plans',{method:plan?'PATCH':'POST',body});
 },()=>{dialog.close();render();});
}
async function planAdminView() {
 const [p,r]=await Promise.all([api('/api/admin/plans'),api('/api/admin/resources')]),plans=collection(p,'plans'),resources=collection(r,'resources');
 const groups=resources.filter(resource=>resource.kind==='subscription');
 return panel('\u8ba2\u9605\u5957\u9910','\u53ea\u586b\u6709\u6548\u671f\u548c\u91d1\u989d\u3002\u5957\u9910\u6302\u5728\u8ba2\u9605\u5206\u7ec4\u4e0a\uff0c\u4e0d\u6309\u5355\u4e2a\u8d26\u53f7\u5efa\u4ef7\u3002',table([{label:'\u5957\u9910',render:plan=>plan.name},{label:'供货参考价',render:plan=>money(plan.cost_minor)},{label:'销售价',render:plan=>money(plan.amount_minor)},{label:'\u79df\u671f',render:plan=>`${plan.duration_days} \u5929`},{label:'\u72b6\u6001',render:plan=>badge(plan.status)},{label:'\u7248\u672c',render:plan=>plan.revision},{label:'\u64cd\u4f5c',render:plan=>el('button',{class:'btn small',text:'\u7f16\u8f91',onclick:()=>planEditor(plan,resources)})}],plans,'\u5c1a\u672a\u914d\u7f6e\u5957\u9910','\u5148\u5728\u4e0a\u6e38\u628a\u5206\u7ec4\u8bbe\u4e3a\u8ba2\u9605\u5206\u7ec4\u5e76\u5206\u914d\u7ed9\u672c\u7ad9\uff0c\u518d\u586b\u6709\u6548\u671f\u548c\u91d1\u989d\u3002'),el('button',{class:'btn primary',text:'\u521b\u5efa\u5957\u9910',disabled:!groups.length,onclick:()=>planEditor(null,resources)}));
}
async function rentalsView() {
 const admin=location.pathname==='/admin/rentals',base=admin?'/admin/rentals':'/orders',endpoint=admin?'/api/admin/rentals':'/api/me/rentals';
 const query=new URLSearchParams(location.search);query.delete('order');query.set('limit','30');
 const data=await api(`${endpoint}?${query}`),rows=collection(data,'rentals'),offset=Number(data.offset||0);
 const filters=el('form',{class:'button-row'},field('订单或套餐','q',{value:query.get('q')||''}),field('交付状态','status',{type:'select',choices:[{value:'',label:'全部'},...['awaiting_payment','queued','review','fulfilled','refund_pending','refunded','cancelled'].map(value=>({value,label:{awaiting_payment:'待支付',queued:'待开通',review:'待核对',fulfilled:'已交付',refund_pending:'退款核对中',refunded:'已退回余额',cancelled:'已取消'}[value]}))],value:query.get('status')||''}),el('button',{class:'btn',type:'submit',text:'筛选'}));
 filters.addEventListener('submit',event=>{event.preventDefault();const v=new FormData(filters);navigate(`${base}?${new URLSearchParams({q:v.get('q'),status:v.get('status')})}`);});
 const columns=[{label:'订单 / 套餐',render:o=>el('div',{},el('strong',{text:o.name}),el('p',{class:'mono muted',text:o.id}))},...(admin?[{label:'客户',render:o=>el('span',{class:'mono',text:o.user_id})}]:[]),{label:'价格 / 租期',render:o=>`${money(o.amount_minor)} / ${o.duration_days} 天`},{label:'交付状态',render:o=>el('div',{},badge(o.status),o.last_error?el('p',{class:'muted',text:o.last_error}):null)},{label:'已交付期限',render:o=>date(o.expires_at)},{label:'操作',render:o=>{
  const actions=el('div',{class:'button-row'});
  if(o.payment_order_id&&o.payment_status!=='paid')actions.append(actionButton('核对支付',()=>api(`/api/${admin?'admin':'me'}/payments/${encodeURIComponent(o.payment_order_id)}/reconcile`,{method:'POST',body:{}})));
  if(!admin&&o.payment_order_id&&o.status==='awaiting_payment')actions.append(el('a',{class:'btn small',href:'/wallet?order='+encodeURIComponent(o.payment_order_id),text:'继续支付'}));
  if(admin&&['queued','review','refund_pending'].includes(o.status))for(const action of (o.status==='refund_pending'?['refund']:['retry','refund']))actions.append(actionButton(action==='retry'?'重新核对':'退回余额',async()=>{
   if(!await confirmAction(action==='retry'?'重新核对订单':'退回未交付款项',action==='retry'?'将按原订单编号核对上游回执，不重复增加租期。':'仅在上游确认没有交付后，将订单全额退回本站余额，不是支付渠道原路退款。','确认执行',action==='refund'))return CANCEL;
   return api(`/api/admin/rentals/${encodeURIComponent(o.id)}/resolve`,{method:'POST',body:{action,expected_revision:o.revision}});
  },{danger:action==='refund'}));
  return actions;
 }}];
 const exportButton=el('button',{class:'btn small',text:'导出本页 CSV',onclick:()=>{
  const cell=v=>`"${String(v??'').replace(/^[=+@\-\t\r]/,"' $&").replaceAll('"','""')}"`;
  const csv='\uFEFF'+[['订单','套餐','金额分','币种','天数','状态','到期时间'],...rows.map(r=>[r.id,r.name,r.amount_minor,r.currency,r.duration_days,r.status,r.expires_at])].map(r=>r.map(cell).join(',')).join('\r\n');
  const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));const link=el('a',{href:url,download:'rental-orders.csv'});link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }});
 const pager=el('div',{class:'button-row'},el('span',{class:'muted',text:`共 ${data.total} 笔 · 本页 ${rows.length} 笔`}),...[-30,30].map(delta=>el('button',{class:'btn small',text:delta<0?'上一页':'下一页',disabled:delta<0?offset===0:offset+rows.length>=data.total,onclick:()=>{query.set('offset',String(Math.max(0,offset+delta)));navigate(`${base}?${query}`);}})));
 const rentalTable=table(columns,rows);rentalTable.classList.add('rental-table');
 return el('div',{class:'page-content'},filters,panel('套餐订单','价格、租期和购买身份以下单快照为准。',rentalTable,exportButton),pager);
}
async function operationsView() {
 const data=await api('/api/admin/operations');
 const tasks=collection(data,'pending_customers');
 return el('div',{class:'page-content'},
 el('div',{class:'stats-grid'},stat('待同步客户',number(tasks.length),'本页最多列出 100 个','users'),stat('待确认支付',number(data.payments_pending),'包括结果未知的订单','wallet'),stat('待核对交付',number(data.rentals.filter(r=>['review','refund_pending'].includes(r.status)).reduce((n,r)=>n+r.count,0)),'可在销售与交付处理','receipt')),
 panel('客户同步待办','停用尚未确认时，本站会暂停该客户的新运行请求，直到上游确认。',table([{label:'客户',render:u=>u.display_name},{label:'状态',render:u=>badge(u.status)},{label:'提示',render:u=>u.sync_error||'等待同步'},{label:'操作',render:u=>actionButton('重新核对',()=>api(`/api/admin/users/${encodeURIComponent(u.id)}${u.core_customer_id?'':'/provision'}`,{method:u.core_customer_id?'PATCH':'POST',body:{}}))}],tasks,'没有待同步客户','当前没有持久化客户同步待办。')),
 el('p',{class:'inline-info'},'邮件、支付和公开地址是否已配置，请在',el('a',{href:'/admin/settings#payment',text:'站点设置'}),'中查看。'),el('a',{class:'btn',href:'/admin/rentals?status=review',text:'处理交付待办 →'}));
}


function accessEditor(account) {
 const form=el('form',{},field('接入标识','slug',{required:true,maxlength:48,value:account?.slug||'',disabled:Boolean(account)}),field('客户名称','name',{required:true,maxlength:100,value:account?.name||''}),...(account?[field('接入状态','status',{type:'select',choices:[{value:'active',label:'正常'},{value:'disabled',label:'停用本站访问'}],value:account.status})]:[]),el('button',{type:'submit',class:'btn primary',text:'保存接入账户'}));
 const dialog=editorDialog(account?'编辑 API 客户':'创建 API 客户',form);
 bindForm(form,async v=>{
  const body={name:v.get('name').trim(),...(account?{expected_revision:account.revision,status:v.get('status')}:{slug:v.get('slug').trim()})};
  if(!await confirmAction('保存本站接入账户','只在本站创建或更新直接 API 客户。不会向上游登记该客户的站点或它的下级。','确认保存'))return CANCEL;
  return api(account?`/api/admin/access-accounts/${account.id}`:'/api/admin/access-accounts',{method:account?'PATCH':'POST',body});
 },data=>{if(!data.account?.id)throw Object.assign(new Error('结果未知，请刷新账户列表。'),{uncertain:true});dialog.close();render();});
}
function accessResourceEditor(account,sources,resource) {
 const form=el('form',{},field('本站上游资源','upstream_id',{type:'select',required:true,choices:sources.map(r=>({value:r.id,label:r.name})),value:resource?.upstream_id||sources[0]?.id,disabled:Boolean(resource)}),field('客户可见资源名称','name',{required:true,maxlength:100,value:resource?.name||''}),field('到期时间','expires_at',{type:'datetime-local',hint:'新建留空沿用上游期限；编辑留空保留原期限。'}),...(resource?[field('资源状态','status',{type:'select',choices:[{value:'active',label:'启用访问'},{value:'disabled',label:'停用访问'}],value:resource.status})]:[]),notice('仅本站管理的分配','仅授予本站可用的资源范围与期限，不设置客户人数配额。客户可以自行经营域名和下级，本站不登记其组织关系。'),el('button',{type:'submit',class:'btn primary',text:'保存资源范围'}));
 const dialog=editorDialog('分配 API 资源范围',form);
 bindForm(form,async v=>{
  const body={name:v.get('name').trim(),...(resource?{expected_revision:resource.revision,status:v.get('status')}:{upstream_id:v.get('upstream_id')})};if(v.get('expires_at'))body.expires_at=new Date(v.get('expires_at')).toISOString();
  if(!await confirmAction('确认资源分配','为该接入账户授予所选资源及有效期，不限制客户数量。','确认保存'))return CANCEL;
  return api(`/api/admin/access-accounts/${account.id}/resources${resource?'/'+resource.id:''}`,{method:resource?'PATCH':'POST',body});
 },data=>{if(!data.resource?.id)throw Object.assign(new Error('资源状态未知，请刷新。'),{uncertain:true});dialog.close();render();});
}
function accessKeyEditor(account) {
 const allowed=['resources.read','customers.read','customers.write','grants.read','grants.write','devices.read','devices.write','usage.read','runtime'];
 const form=el('form',{},field('密钥名称','name',{required:true,maxlength:80,placeholder:'生产接入 / 轮换密钥'}),el('fieldset',{},el('legend',{text:'允许的接口权限'}),el('div',{class:'scope-grid'},allowed.map(scope=>el('label',{class:'check-label'},el('input',{type:'checkbox',name:'scopes',value:scope,checked:true}),scope)))),field('密钥到期时间','expires_at',{type:'datetime-local'}),notice('密钥与接入账户分离','本站独立生成密钥，撤销前可以再次查看。轮换同一账户的密钥不改变它的数据与资源，也不修改它在自己平台签发的密钥。'),el('button',{type:'submit',class:'btn primary',text:'签发接入密钥'}));
 const dialog=editorDialog('签发本站 API 密钥',form);
 bindForm(form,async v=>{
  const body={name:v.get('name').trim(),scopes:v.getAll('scopes')};if(!body.scopes.length)throw new Error('至少选择一项权限。');if(v.get('expires_at'))body.expires_at=new Date(v.get('expires_at')).toISOString();
  if(!await confirmAction('签发接入密钥',`这把密钥只供 ${account.name} 访问本站。撤销前可以再次查看，撤销后无法恢复。`,'确认签发'))return CANCEL;
  return api(`/api/admin/access-accounts/${account.id}/keys`,{method:'POST',body});
 },data=>{if(!data.key?.id||!data.token)throw Object.assign(new Error('发钥结果未知，请刷新核对。'),{uncertain:true});dialog.close();showSecret(data);});
}
async function accessView() {
 const params=new URLSearchParams(location.search),offset=Math.max(0,Number(params.get('offset'))||0),query=new URLSearchParams({limit:'50',offset:String(offset),q:params.get('q')||''});
 const data=await api(`/api/admin/access-accounts?${query}`),accounts=collection(data,'accounts'),root=el('div',{class:'page-content api-access-page'});
 const search=el('form',{class:'button-row'},el('input',{name:'q',value:query.get('q'),placeholder:'搜索 API 客户','aria-label':'搜索 API 客户'}),el('button',{class:'btn',type:'submit',text:'搜索'}));search.addEventListener('submit',event=>{event.preventDefault();navigate('/admin/access?q='+encodeURIComponent(new FormData(search).get('q')));});
 root.append(search,el('div',{class:'pager'},el('span',{text:`共 ${data.total} 个接入账户`}),...[-50,50].map(delta=>el('button',{class:'btn small',text:delta<0?'上一页':'下一页',disabled:delta<0?offset===0:offset+accounts.length>=data.total,onclick:()=>{query.set('offset',String(Math.max(0,offset+delta)));navigate(`/admin/access?${query}`);}}))));
 const selectedID=params.get('account');if(selectedID&&!accounts.some(a=>a.id===selectedID)){const chosen=await api('/api/admin/access-accounts/'+encodeURIComponent(selectedID));accounts.push(chosen.account);}
 root.append(panel('API 客户','一个接入账户可以有多把密钥；数据和资源属于账户，不属于单把密钥。',table([{label:'客户',render:a=>el('div',{},el('strong',{text:a.name}),el('p',{class:'mono muted',text:a.slug}))},{label:'站点',render:a=>el('span',{class:'mono',text:a.public_origin})},{label:'状态',render:a=>badge(a.status)},{label:'操作',render:a=>el('div',{class:'button-row'},el('button',{class:'btn small',text:'编辑',onclick:()=>accessEditor(a)}),el('a',{class:'btn small',href:`/admin/access?account=${encodeURIComponent(a.id)}`,text:'资源与密钥'}))}],accounts,'暂无 API 客户','先创建本站接入账户，再分配资源和签发密钥。'),el('button',{class:'btn primary',text:'创建 API 客户',onclick:()=>accessEditor(null)})));
 const selected=accounts.find(a=>a.id===new URLSearchParams(location.search).get('account'));
 if(selected){
  const [r,k,own]=await Promise.all([api(`/api/admin/access-accounts/${selected.id}/resources`),api(`/api/admin/access-accounts/${selected.id}/keys`),api('/api/admin/resources')]),resources=collection(r,'resources'),keys=collection(k,'keys'),sources=collection(own,'resources');
  root.append(panel(`${selected.name} · 资源范围`,'分配仅限本站拥有的资源范围和期限，不设置客户人数配额。',table([{label:'资源',render:r=>r.name},{label:'期限',render:r=>r.expires_at?date(r.expires_at):'无固定期限'},{label:'状态',render:r=>badge(r.available?'active':'disabled')},{label:'操作',render:r=>el('button',{class:'btn small',text:'编辑范围',onclick:()=>accessResourceEditor(selected,sources,r)})}],resources),el('button',{class:'btn',text:'分配资源',disabled:!sources.length,onclick:()=>accessResourceEditor(selected,sources)})));
  root.append(panel(`${selected.name} · 本站密钥`,'交付本站公开地址和这里生成的密钥，绝不交付本站的上游密钥。',table([{label:'密钥',render:k=>k.name},{label:'前缀',render:k=>k.prefix+'…'},{label:'权限',render:k=>k.scopes.join(' · ')},{label:'期限',render:k=>date(k.expires_at)},{label:'状态',render:k=>badge(k.revoked_at?'revoked':k.expires_at&&Date.parse(k.expires_at)<Date.now()?'expired':'active')},{label:'操作',render:k=>el('div',{class:'table-actions'},k.copyable?actionButton('查看',async()=>{const data=await api(`/api/admin/access-accounts/${selected.id}/keys/${k.id}/copy`,{method:'POST',body:{}});showSecret({key:k,token:data.token});return CANCEL;}):el('span',{class:'muted',text:k.revoked_at?'':'不可再查看'}),actionButton('撤销',async()=>{if(!await confirmAction('撤销这把接入密钥','仅撤销这把密钥，并清除可再次查看的原文。同一接入账户的其他有效密钥和已有数据不变。','确认撤销',true))return CANCEL;return api(`/api/admin/access-accounts/${selected.id}/keys/${k.id}`,{method:'DELETE',body:{}});},{danger:true,disabled:Boolean(k.revoked_at)}))}],keys),el('button',{class:'btn',text:'签发接入密钥',onclick:()=>accessKeyEditor(selected)})));
 }
 return root;
}
const views = {'/admin/inventory':inventoryView,'/admin/access':accessView,'/orders':rentalsView,'/admin/plans':planAdminView,'/admin/rentals':rentalsView,'/admin/operations':operationsView,'/':overviewView,'/accounts':accountsView,'/devices':devicesView,'/connect':connectView,'/usage':usageView,'/wallet':walletView,'/profile':profileView,'/admin/customers':customersView,'/admin/orders':ordersView,'/admin/audit':auditView,'/admin/settings':settingsView};
bootstrap();
