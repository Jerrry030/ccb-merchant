/* Standalone merchant client. Only /api on this origin; no stored credentials or demo data. */
const app = document.getElementById('app');
const state = { public: null, user: null, csrf: null, returnTo: '/', code: '', token: '', view: 0 };
const CANCEL = Symbol('cancel');
const authRoutes = new Set(['/login', '/setup', '/register', '/verify', '/forgot', '/reset']);
const navigation = [
  { path: '/', title: '工作概览', icon: 'overview', description: '您的权益、设备与使用情况，一目了然。' },
  { path: '/plans', title:'套餐与续期', icon:'layers', description:'按期限购买 Code 使用权，价格在下单时锁定。' },
  { path: '/orders', title:'我的订单', icon:'receipt', description:'核对套餐支付、开通、续期及退回余额。' },
  { path: '/rights', title: '我的权益', icon: 'layers', description: '查看商户已为您分配的 Code 资源与有效期。' },
  { path: '/devices', title: '设备管理', icon: 'monitor', description: '查看、核对和撤销已连接的 CCB 客户端。' },
  { path: '/usage', title: '用量明细', icon: 'chart', description: '查看请求与 Token。参考成本只供核对，不会从钱包扣费。' },
  { path: '/wallet', title: '我的钱包', icon: 'wallet', description: '查看人民币余额、支付订单和资金记录。与参考用量成本分开。' },
  { path: '/profile', title: '个人设置', icon: 'user', description: '查看账户信息，维护您的登录安全。' },
  { path:'/admin/upstream',title:'上游接入',icon:'link',admin:true,hidden:true,description:'连接直接上级，核对本站账户与可用资源。' },
  { path:'/admin/access',title:'API 接入',icon:'key',admin:true,description:'管理直接接入本站的客户、密钥和资源范围。' },
  { path: '/admin/customers', title: '客户管理', icon: 'users', admin: true, description: '管理本站成员，并为需要使用资源的成员开通上游客户。' },
  { path: '/admin/resources', title: '资源与授权', icon: 'grid', admin: true, description: '查看可分配资源，管理每位客户的访问权益。' },
  { path:'/admin/plans',title:'套餐管理',icon:'layers',admin:true,description:'选择已分配的 Code 供给，设置明确的租期和销售价。' },
  { path:'/admin/rentals',title:'销售与交付',icon:'receipt',admin:true,description:'核对销售订单和交付结果，处理尚未交付的订单。' },
  { path:'/admin/operations',title:'运营待办',icon:'overview',admin:true,description:'处理客户同步、支付核对和交付异常。' },
  { path: '/admin/orders', title: '支付订单', icon: 'receipt', admin: true, description: '核对服务端记录的支付状态，不以回跳参数判定到账。' },
  { path: '/admin/audit', title: '审计日志', icon: 'shield', admin: true, description: '查看管理操作记录，追溯变更与授权。' },
  { path: '/admin/settings', title: '站点设置', icon: 'settings', admin: true, description: '管理公开信息、注册和上游连接，并查看邮件与支付的配置状态。' },
  { path: '/connect', title: '连接设备', icon: 'link', hidden: true, description: '核对 CCB 客户端的连接请求，仅授权您正在使用的设备。' },
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
  menu: ['M4 6h16M4 12h16M4 18h16'],
  close: ['m6 6 12 12M6 18 18 6'],
  check: ['m5 12 4 4L19 6'],
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
      const messages = {upstream_target_blocked:'此上游目标被服务器网络策略拒绝。私网或 HTTP 地址需由部署者设置 UPSTREAM_ALLOWED_ORIGINS。',upstream_identity_mismatch:'已有业务数据绑定了另一个上游身份，不能在这里直接切换。',upstream_protocol_mismatch:'上游协议不兼容或接入账户已失效。',upstream_verification_failed:'上游未能验证本站凭据，请检查地址、密钥及上级状态。',upstream_changed:'接入配置已变化，请刷新后重新核对。',upstream_environment_managed:'本站上游由服务端环境配置管理，网页不能覆盖。',insufficient_balance:'钱包余额不足，请先充值或选择在线支付。',plan_changed:'套餐价格或状态已更新，请刷新并重新确认。',plan_conflict:'套餐版本已变化，请刷新后再编辑。',supply_unavailable:'供给不可用或期限不足，暂时无法购买此套餐。',purchase_pending:'此资源已有待完成订单，请先在我的订单中核对。',purchase_conflict:'该请求编号已用于另一笔购买，请核对已有订单。',customer_not_ready:'客户正在停用或同步中，暂时不能开通使用权。',order_state:'订单状态已变化，请刷新核对；已交付订单不能在这里自动退款。',payment_amount_unavailable:'此价格超出当前在线支付范围，请使用余额或联系商户。',payment_outcome_unknown:'支付结果尚未确认，请查看已有订单，勿重复付款。',invalid_credentials:'邮箱或密码不正确，或此账户暂不可用。',invalid_csrf:'会话安全令牌已失效，请重新验证会话。',core_not_configured:'上游连接尚未配置，请联系管理员。',core_unavailable:'上游服务暂不可用，请稍后重试。',core_unavailable:'上游服务暂不可用，请稍后重试。',payment_disabled:'支付服务尚未配置，当前无法创建订单。',mail_disabled:'邮件服务尚未配置，当前无法验证邮箱或重置密码。',registration_disabled:'站点当前未开放自助注册。',invalid_password:'密码不符合要求，或当前密码不正确。',not_provisioned:'账户尚未开通上游客户，请联系管理员。',core_sync_pending:'客户信息尚未与上游同步完成，请联系管理员核对。',invalid_code:'连接码无效或已过期，请在客户端重新发起连接。',not_copyable:'这把密钥创建时未保留原文，请撤销后重新签发。',admin_required:'此操作需要商户管理员权限。',account_changed:'账户已发生变化，请重新登录。',rate_limited:'请求过于频繁，请稍后再试。'};
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
function usd(value) { return typeof value === 'number' && Number.isFinite(value) ? `$${value.toFixed(4)}` : '未提供'; }
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
  if (error.code === 'not_provisioned' || error.code === 'core_sync_pending') return notice('账户开通尚未完成',error.message,'warn');
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
  const nav = el('nav',{'aria-label':'主导航'},el('div',{class:'nav-group',text:'工作空间'}));
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
    el('div',{class:'side-note'},el('strong',{},icon('shield'),' 安全连接 · 独立工作台'),'您的身份与权益由本站验证。上游密钥只保存在服务端。'),
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
    el('main',{id:'main',class:'main',tabindex:'-1'},el('div',{class:'page-heading'},el('div',{},el('span',{class:'eyebrow',text:route.admin ? '商户管理' : '工作空间'}),el('h1',{text:route.title}),el('p',{text:route.description})),el('button',{class:'btn',type:'button',onclick:() => render()},icon('refresh'),'刷新')),
      el('div',{id:'page-feedback'}),content,el('footer',{class:'page-footer'},el('span',{text:`${state.public.site.name} · 独立商户工作台`}),el('span',{text:'用量可核对 · 密钥留在服务端'})))));
  app.replaceChildren(root); return content;
}
async function render() {
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
    if (route.admin && state.user.role !== 'admin') result = emptyState('没有管理权限','此页面仅供服务端确认的商户管理员访问。','shield',el('a',{class:'btn primary',href:'/',text:'返回工作概览'}));
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
  if (path === '/login' && state.returnTo.startsWith('/connect')) inner.append(notice('登录后继续连接设备','我们会在登录后返回设备确认页面。登录本身不会授权设备。'));
  inner.append(el('p',{class:'auth-footer',text:'会话由服务端验证 · 上游密钥不会出现在此页'}));
  app.replaceChildren(el('main',{class:'auth-page',id:'main'},el('aside',{class:'auth-art'},brand(),el('div',{class:'auth-art-copy'},el('span',{class:'eyebrow',text:'独立工作台'}),el('h1',{},'管理权益、设备与用量。'),el('p',{text:state.public.site.description || '集中查看 Code 权益、已连接的设备和用量。'}),artwork()),el('p',{class:'auth-bottom',text:'由本站独立提供服务'})),el('section',{class:'auth-form-side'},themeButton('auth-theme'),inner)));
}

async function overviewView() {
  const data = await api('/api/me/overview'); const grants = collection(data,'grants'); const devices = collection(data,'devices');
  const configured = data.connection?.configured === true; const available = data.connection?.available === true;
  const active = grants.filter(g => g.status === 'active' && (!g.expires_at || new Date(g.expires_at).getTime() > Date.now()));
  const hero = el('section',{class:'hero'},el('div',{class:'hero-copy'},el('span',{class:'eyebrow',text:'工作概览'}),el('h2',{text:'查看权益、连接设备、核对用量。'}),el('p',{text:'在这里查看已分配的资源和有效期，并连接您自己的 CCB 客户端。'}),el('a',{class:'btn',href:'/connect'},icon('plus'),'连接新设备',icon('arrow'))),artwork());
  const root = el('div',{class:'page-content'},hero);
  if (!configured || !available) root.append(notice(configured ? '上游连接暂不可用' : '工作空间尚未连接上游服务',configured ? '当前无法确认上游资源的实时状态；请稍后重试或联系管理员。' : '请联系管理员完成服务端连接配置。权益、设备与用量不会用示例数据替代。','warn'));
  const pending = new Set(Array.isArray(data.pending) ? data.pending : []);
  const pendingLabels = {customer_not_provisioned:'上游账户尚未开通',customer_sync_pending:'客户信息同步待确认',grants_unavailable:'权益数据暂不可用',devices_unavailable:'设备数据暂不可用',usage_unavailable:'用量统计暂不可用',core_unavailable:'上游连接暂不可用'};
  if (pending.size) root.append(notice('还有待完成的事项',[...pending].map(item => pendingLabels[item] || item).join(' · '),'warn'));
  const reliable = configured && available && !pending.has('customer_not_provisioned') && !pending.has('customer_sync_pending');
  const grantsReady = reliable && !pending.has('grants_unavailable');
  const devicesReady = reliable && !pending.has('devices_unavailable');
  root.append(el('div',{class:'stats-grid'},stat('可用权益',grantsReady ? number(active.length) : '—',grantsReady ? '当前有效的 Code 资源' : '等待上游连接确认','layers'),stat('已连接设备',devicesReady ? number(devices.length) : '—','仅显示服务端已记录的设备','monitor'),stat('累计请求',number(data.usage?.requests),'服务端返回的统计范围','chart'),stat('钱包余额',money(data.wallet?.balance_minor,data.wallet?.currency),'人民币余额 · 不按参考 USD 扣费','wallet')));
  const grantContent = grants.length ? el('div',{class:'card-body'},el('ul',{class:'section-list'},grants.slice(0,4).map(g => el('li',{},el('span',{class:'stat-icon'},icon('code')),el('div',{class:'list-copy'},el('strong',{text:g.name || 'Code 资源'}),el('p',{text:g.expires_at ? `有效期至 ${date(g.expires_at)}` : '未设置到期时间'})),badge(g.status)))))
    : emptyState(grantsReady ? '还没有可用权益' : '等待资源连接',grantsReady ? '联系商户管理员为您开通资源。获得授权后，即可开始连接设备。' : '上游连接恢复或配置完成后，才能确认您的权益。','layers');
  const guide = el('div',{class:'card-body'},el('ul',{class:'section-list'},[
    ['01','确认我的权益','先确认已获授权的资源与有效期。','/rights'],['02','连接 CCB 客户端','从客户端取得连接码，在本站核对设备。','/connect'],['03','查看用量','请求与参考成本都可以查看，参考成本不会从钱包扣费。','/usage'],
  ].map(([n,title,text,href]) => el('li',{},el('span',{class:'step-num',text:n}),el('div',{class:'list-copy'},el('strong',{text:title}),el('p',{text})),el('a',{href,'aria-label':title},icon('arrow'))))),el('p',{class:'inline-info',text:'本站仅支持已授权的 Code 通道；其他产品不可据此推定可用。'}));
  root.append(el('div',{class:'two-col'},panel('我的资源','仅展示管理员已授予的访问权益',grantContent,el('a',{href:'/rights',class:'muted',text:'查看全部 →'})),panel('开始使用','先确认权益，再连接设备。',guide)));
  return root;
}
async function rightsView() {
  const grants = collection(await api('/api/me/grants'),'grants');
  if (!grants.length) return panel('我的授权资源','所有权益以服务器状态为准',emptyState('尚未分配权益','可在「套餐与续期」购买使用权，或联系管理员分配。充值本身不代表已经购买套餐。','layers'));
  return el('div',{class:'page-content'},notice('以实际使用权为准','购买订单完成交付后才会开通或续期；请求仍受当前授权、期限和设备状态约束。'),el('div',{class:'resource-grid'},grants.map(g => el('article',{class:'card resource-card'},
    el('div',{class:'resource-title'},el('span',{class:'brand-mark'},icon('code')),el('div',{},el('h3',{text:g.name || 'Code 资源'}),badge(g.expires_at&&Date.parse(g.expires_at)<=Date.now()?'expired':g.status))),
    el('dl',{class:'detail-list'},el('dt',{text:'产品通道'}),el('dd',{text:Array.isArray(g.surfaces) ? g.surfaces.join(' · ') : '—'}),el('dt',{text:'有效期至'}),el('dd',{text:g.expires_at ? date(g.expires_at) : '未设置到期时间'}),el('dt',{text:'最近更新'}),el('dd',{text:date(g.updated_at)})),
    el('hr',{class:'form-divider'}),el('a',{class:'btn',href:'/connect',text:'前往设备确认 →'})))));
}
async function devicesView() {
  const devices = collection(await api('/api/me/devices'),'devices');
  return el('div',{class:'page-content'},notice('只授权您自己的设备','撤销后，该设备的新执行请求将被拒绝；已经受理的执行可能按既有策略完成。'),panel('连接的设备','从 CCB 客户端获取连接码后，在本站确认设备',table([
    {label:'设备',render:d => el('div',{},el('strong',{text:d.name || '未命名设备'}),el('span',{class:'table-sub',text:d.platform || '未知平台'}))},
    {label:'状态',render:d => badge(d.state)}, {label:'最近活动',render:d => date(d.last_seen)}, {label:'到期时间',render:d => date(d.expires_at)},
    {label:'操作',render:d => actionButton('撤销连接',async () => await confirmAction('撤销设备连接',`确认撤销「${d.name || '此设备'}」？此操作会阻止新的执行请求。`,'撤销连接',true) ? api(`/api/me/devices/${encodeURIComponent(d.id)}`,{method:'DELETE'}) : CANCEL,{danger:true})},
  ],devices,'还没有连接设备','在 CCB 客户端发起连接，并使用连接码确认。不会自动授权任何设备。'),el('a',{class:'btn primary',href:'/connect'},icon('plus'),'连接设备')));
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
  return el('div',{class:'equal-col'},panel('连接到您的工作空间','当前登录账户决定可使用的权益',el('div',{class:'card-body'},form,preview)),panel('确认之前，请检查',null,el('div',{class:'card-body'},el('ul',{class:'section-list'},[
    ['01','请求是您本人发起的','不要批准别人发送的连接码。'],['02','客户端指向当前商户','客户端应连接当前商户的公开地址，而不是其他商户或平台后台。'],['03','账户有可用权益','没有有效授权时，设备确认不会绕过资源限制。'],
  ].map(([n,title,text]) => el('li',{},el('span',{class:'step-num',text:n}),el('div',{class:'list-copy'},el('strong',{text:title}),el('p',{text}))))),notice('无需粘贴 API 密钥','连接设备不需要提供上游账号、商户密钥或管理员凭据。'))));
}
async function usageView() {
  const params = new URLSearchParams(location.search); const requestedOffset = Number(params.get('offset')); const query = new URLSearchParams({limit:'20',offset:String(Number.isSafeInteger(requestedOffset) && requestedOffset >= 0 ? requestedOffset : 0)});
  for (const key of ['from','to']) if (params.has(key)) query.set(key,params.get(key));
  const data = await api(`/api/me/usage?${query}`); const requests = collection(data,'requests'); const usage = data.usage;
  const form = el('form',{class:'filter-bar'},field('开始日期','from',{type:'date',value:(params.get('from') || '').slice(0,10)}),field('结束日期','to',{type:'date',value:(params.get('to') || '').slice(0,10)}),el('button',{class:'btn',type:'submit',text:'查询'}));
  form.addEventListener('submit',event => { event.preventDefault(); const values = new FormData(form); const from = values.get('from'), to = values.get('to');
    if (from && to && from > to) { document.getElementById('page-feedback').replaceChildren(notice('日期范围有误','开始日期不能晚于结束日期。','error')); return; }
    const next = new URLSearchParams(); if (from) next.set('from',new Date(`${from}T00:00:00`).toISOString()); if (to) next.set('to',new Date(`${to}T23:59:59.999`).toISOString()); navigate(`/usage?${next}`);
  });
  const offset = Number(query.get('offset')); const total = Number.isSafeInteger(data.total) ? data.total : null;
  const pager = el('div',{class:'pager'},el('span',{text:total === null ? '总数未提供' : `共 ${number(total)} 条 · 第 ${Math.floor(offset/20)+1} 页`}),el('button',{class:'btn small',disabled:offset === 0,type:'button',text:'上一页',onclick:() => { query.set('offset',Math.max(0,offset-20)); navigate(`/usage?${query}`); }}),el('button',{class:'btn small',disabled:total === null || offset + 20 >= total,type:'button',text:'下一页',onclick:() => { query.set('offset',offset+20); navigate(`/usage?${query}`); }}));
  return el('div',{class:'page-content'},notice('参考成本（USD），不是实际扣费','参考 USD 仅用于理解上游用量，不是您的零售价格，不会据此扣减钱包。未返回成本或不完整的用量将保留为未知。'),
    el('div',{class:'stats-grid'},stat('请求次数',number(usage?.requests),'当前查询区间','chart'),stat('输入 / 输出 Token',`${number(usage?.input_tokens)} / ${number(usage?.output_tokens)}`,'不包含缓存 Token','code'),stat('参考成本 · USD',usd(usage?.cost_usd),'仅供核对，不会从钱包扣费','receipt'),stat('未知用量请求',number(usage?.unknown_usage),'用量缺失不视为零成本','info')),
    !usage ? notice('统计尚不可用','服务器尚未返回用量汇总。下方仅展示实际返回的请求记录。','warn') : null,
    panel('请求记录','仅显示必要的运行元数据，不展示提示词或请求正文',el('div',{},form,table([
      {label:'时间 / 模型',render:r => el('div',{},el('span',{text:date(r.time)}),el('span',{class:'table-sub',text:r.model || '未提供模型'}))},
      {label:'状态',render:r => badge(String(r.status ?? '未知'))},
      {label:'输入 / 输出',render:r => `${number(r.usage?.input_tokens)} / ${number(r.usage?.output_tokens)}`},
      {label:'耗时',render:r => typeof r.duration_ms === 'number' ? `${number(r.duration_ms)} ms` : '—'},
      {label:'参考 USD',render:r => el('div',{},usd(r.cost_usd),r.usage_complete !== true ? el('span',{class:'table-sub',text:'用量未完整确认'}) : null)},
    ],requests,'此区间暂无请求','换一个时间范围，或在获得权益并连接设备后开始使用。'),pager)));
}
function orderTable(orders, showCustomer = false) {
  return table([...(showCustomer ? [{label:'客户标识',render:o => el('span',{class:'mono',text:o.user_id || '未提供'})}] : []),{label:'订单编号',render:o => el('span',{class:'mono',text:o.id})},{label:'用途',render:o=>o.rental_id?'套餐支付':'余额充值'},{label:'金额',render:o => money(o.amount_minor,o.currency)},{label:'支付状态',render:o => badge(o.status)},{label:'创建时间',render:o => date(o.created_at)},{label:'操作',render:o=>['creating','pending','unknown'].includes(o.status)?actionButton('核对支付',()=>api(`/api/${showCustomer?'admin':'me'}/payments/${encodeURIComponent(o.id)}/reconcile`,{method:'POST',body:{}})):'—'}],orders,'暂无支付订单','只有服务器创建的真实支付订单才会出现在这里。');
}
async function walletView() {
  const data = await api('/api/me/wallet'); const ledger = collection(data,'ledger'); const orders = collection(data,'orders');
  const enabled = state.public.features.payment === true; const result = el('div',{});
  const form = el('form',{},field('充值金额（人民币元）','amount',{required:true,type:'number',min:'0.01',step:'0.01',inputmode:'decimal',placeholder:'0.00',disabled:!enabled,hint:'实际支付金额以 Stripe 收银台及服务器订单为准。'}),el('button',{class:'btn primary',type:'submit',disabled:!enabled},icon('wallet'),enabled ? '创建 Stripe 支付订单' : '在线支付未启用'));
  bindForm(form,async values => {
    if (state.public.features.payment !== true) throw new Error('当前未启用在线支付。');
    const amount = values.get('amount').trim(); if (!/^\d+(\.\d{1,2})?$/.test(amount)) throw new Error('请输入最多两位小数的有效金额。');
    const [whole,fraction = ''] = amount.split('.'); const minor = Number(whole)*100 + Number(fraction.padEnd(2,'0'));
    if (!Number.isSafeInteger(minor) || minor < 1) throw new Error('金额超出可处理范围。');
    if (!await confirmAction('创建真实支付订单',`确认创建 ${money(minor)} 的 Stripe 支付订单？接下来会提供支付链接，不会在此页面自动扣款。`,'创建订单')) return CANCEL;
    return api('/api/me/payments',{method:'POST',body:{amount_minor:minor}});
  },(payment,message) => {
    if (!payment.order?.id) throw Object.assign(new Error('订单创建结果不完整，请先刷新核对。'),{uncertain:true});
    let url; try { url = new URL(payment.checkout_url); } catch { /* Invalid URLs stay inert. */ }
    if (!url || !['http:','https:'].includes(url.protocol) || url.origin !== 'https://checkout.stripe.com' || url.username || url.password || /[\u0000-\u0020\u007f]/.test(payment.checkout_url) || typeof payment.checkout_url !== 'string') {
      message.replaceChildren(notice('订单已记录，但支付链接不可安全使用',`订单 ${payment.order.id}。请联系管理员核对链接，不要重复创建订单。`,'warn')); return;
    }
    result.replaceChildren(notice('支付订单已创建，尚不代表已付款',`订单 ${payment.order.id} · ${money(payment.order.amount_minor,payment.order.currency)}。仅以服务器确认的状态为准。`),el('p',{class:'inline-info',text:`将前往外部收银台：${url.origin}`}),
      el('div',{class:'button-row'},el('a',{class:'btn primary checkout-link',href:url.href,target:'_blank',rel:'noopener noreferrer',referrerpolicy:'no-referrer',text:'打开 Stripe 收银台 ↗'}),el('button',{class:'btn',type:'button',text:'查询订单状态',onclick:() => navigate(`/wallet?order=${encodeURIComponent(payment.order.id)}`)})));
  });
  const root = el('div',{class:'page-content'},notice('钱包余额与参考用量分开记录','本页仅展示人民币余额、账本与支付订单。参考 USD 不是零售费用；本工作台不提供手动充值入口。'),
    el('div',{class:'equal-col'},panel('账户余额','以服务器账本为准',el('div',{class:'card-body'},el('div',{class:'balance-card'},el('p',{text:'可用余额 · CNY'}),el('div',{class:'amount',text:money(data.wallet?.balance_minor,data.wallet?.currency)}),el('p',{text:'余额不等于资源授权，请在「我的权益」查看使用资格。'})))),
      panel('在线充值','通过已配置的 Stripe Checkout 完成支付',el('div',{class:'card-body'},!enabled ? notice('支付服务尚未配置','暂时无法发起在线支付。请联系管理员；不会创建虚拟订单或显示模拟到账。','warn') : null,el('br'),form,result))));
  const orderId = new URLSearchParams(location.search).get('order');
  if (orderId) {
    try { const payment = await api(`/api/me/payments/${encodeURIComponent(orderId)}`); if (!payment.order) throw new Error('订单信息缺失。'); root.prepend(panel('返回后的订单核对','回跳网址中的成功参数不会改变余额或订单状态',orderTable([payment.order]))); }
    catch (error) { root.prepend(errorNotice(error)); }
  }
  root.append(panel('最近支付订单','完成付款后，请刷新以获取服务端确认状态',orderTable(orders)),panel('资金记录','所有金额使用人民币最小单位换算显示',table([
    {label:'记录时间',render:r => date(r.created_at)}, {label:'类型',render:r => ({stripe_credit:'Stripe 支付入账',rental_debit:'套餐购买扣款',rental_refund:'未交付退回余额'}[r.kind] || r.kind || '未提供')},
    {label:'变动金额',render:r => money(r.amount_minor,r.currency || data.wallet?.currency)}, {label:'关联订单',render:r => el('span',{class:'mono',text:r.rental_id || r.order_id || '—'})},
  ],ledger,'暂无资金记录','没有发生过服务器确认的资金变动。'))); return root;
}
async function profileView() {
  const user = state.user;
  const form = el('form',{class:'form-narrow'},field('当前密码','current_password',{type:'password',required:true,autocomplete:'current-password',maxlength:256}),field('新密码','new_password',{type:'password',required:true,minlength:7,maxlength:256,autocomplete:'new-password',hint:'至少 7 个字符，建议使用未在其他站点用过的密码。'}),field('确认新密码','confirmation',{type:'password',required:true,minlength:7,maxlength:256,autocomplete:'new-password'}),el('button',{class:'btn primary',type:'submit',text:'更新密码'}));
  bindForm(form,async values => {
    if (values.get('new_password') !== values.get('confirmation')) throw new Error('两次输入的新密码不一致。');
    if (!await confirmAction('更新登录密码','确认修改当前账户的密码？更新后请使用新密码重新登录。','更新密码')) return CANCEL;
    return api('/api/auth/password',{method:'PATCH',body:{current_password:values.get('current_password'),new_password:values.get('new_password')}});
  },(data,message) => { if (data.ok !== true) throw Object.assign(new Error('密码更新尚未确认。'),{uncertain:true}); state.user = null; state.csrf = null; state.returnTo = '/profile'; navigate('/login',true); toast('密码已更新，请使用新密码重新登录。'); });
  return el('div',{class:'equal-col'},panel('账户信息','身份由当前服务端会话确定',el('div',{class:'card-body'},el('div',{class:'identity-card'},el('span',{class:'avatar',text:(user.display_name || user.email).slice(0,1).toUpperCase()}),el('div',{},el('h2',{text:user.display_name}),el('p',{class:'muted',text:user.email}))),el('dl',{class:'detail-list'},el('dt',{text:'账户角色'}),el('dd',{},badge(user.role)),el('dt',{text:'账户状态'}),el('dd',{},badge(user.status)),el('dt',{text:'上游账户'}),el('dd',{text:user.core_customer_id ? '已开通' : '尚未开通'})),el('hr',{class:'form-divider'}),notice('需要修改账户资料？','请联系商户管理员。账户身份不可在浏览器中手动切换。'))),panel('登录安全','修改您的站点登录密码',el('div',{class:'card-body'},form)));
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
    if (!await confirmAction(create ? '确认创建客户' : '确认修改客户',`将${create ? '创建' : '更新'}「${payload.display_name}」的站点账户，角色为${payload.role === 'admin' ? '管理员' : '成员'}。创建账户不会自动分配上游资源。`,'确认保存')) return CANCEL;
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
  return el('div',{class:'page-content'},search,pager,notice('本站账户与上游客户分开开通','先创建本站账户，再开通上游客户。开通使用稳定的本站用户编号，不会把上游凭据交给客户。'),panel('客户账户',`${number(users.length)} 个站点账户`,table([
    {label:'客户',render:u => el('div',{},el('strong',{text:u.display_name || '未命名客户'}),el('span',{class:'table-sub',text:u.email}))},
    {label:'角色 / 状态',render:u => el('div',{class:'button-row'},badge(u.role),badge(u.status))},
    {label:'上游客户',render:u => el('span',{class:`badge ${u.core_customer_id ? 'good' : 'warn'}`,text:u.core_customer_id ? '已开通' : '待开通'})},
    {label:'创建时间',render:u => date(u.created_at)},
    {label:'操作',render:u => el('div',{class:'table-actions'},el('button',{class:'btn small',type:'button',text:'编辑',onclick:() => customerEditor(u)}),u.core_customer_id ? el('a',{class:'btn small',href:`/admin/resources?user_id=${encodeURIComponent(u.id)}`,text:'管理授权'})
      : actionButton('开通映射',async () => await confirmAction('开通上游客户',`将为「${u.display_name || u.email}」建立不可随意更换的上游客户关联。开通后不会自动分配资源。`,'确认开通') ? api(`/api/admin/users/${encodeURIComponent(u.id)}/provision`,{method:'POST'}) : CANCEL))},
  ],users,'暂无客户账户','创建客户后，可以开通映射并分配资源。'),el('button',{class:'btn primary',type:'button',onclick:() => customerEditor()},icon('plus'),'创建客户')));
}
function grantEditor(user, resources, grant) {
  const form = el('form',{});
  form.append(notice('授权对象',user.display_name || user.email));
  if (!grant) form.append(field('分配资源','resource_id',{type:'select',required:true,choices:[{value:'',label:'请选择可用资源'},...resources.filter(r => r.status === 'active' && r.available !== false).map(r => ({value:r.id,label:r.name}))]}));
  let expiry = '';
  if (grant?.expires_at) { const d = new Date(grant.expires_at); if (!Number.isNaN(d.getTime())) expiry = new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16); }
  form.append(field('授权到期时间','expires_at',{type:'datetime-local',value:expiry,hint:'使用您的本地时区。留空表示不设置额外到期时间；资源自身有效期仍然生效。'}));
  if (grant) form.append(el('p',{class:'inline-info',text:`本次变更基于授权版本 ${grant.revision}。若服务器版本已更新，将拒绝覆盖。`}));
  form.append(el('button',{class:'btn primary',type:'submit',text:grant ? '保存有效期' : '分配资源'}));
  const dialog = editorDialog(grant ? '调整授权有效期' : '分配资源',form);
  bindForm(form,async values => {
    const local = values.get('expires_at'); let expires_at = null;
    if (local) { const d = new Date(local); if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) throw new Error('请选择未来的有效到期时间。'); expires_at = d.toISOString(); }
    if (grant && !Number.isInteger(grant.revision)) throw new Error('授权缺少有效版本，请重新读取。');
    if (!await confirmAction('确认授权变更',`为「${user.display_name || user.email}」${grant ? '更新授权有效期' : '分配所选资源'}。服务器会校验资源范围、产品与有效期。`,'确认授权')) return CANCEL;
    return api(grant ? `/api/admin/grants/${encodeURIComponent(grant.id)}` : '/api/admin/grants',{method:grant ? 'PATCH' : 'POST',body:grant ? {expected_revision:grant.revision,expires_at} : {user_id:user.id,resource_id:values.get('resource_id'),expires_at}});
  },data => { if (!data.grant) throw Object.assign(new Error('服务器尚未确认授权变更。'),{uncertain:true}); dialog.close(); toast('授权变更已保存'); render(); });
}
async function resourcesView() {
  const [resourceData,userData] = await Promise.all([api('/api/admin/resources'),api('/api/admin/users')]);
  const resources = collection(resourceData,'resources'), users = collection(userData,'users');
  const selected = new URLSearchParams(location.search).get('user_id');if(selected&&!users.some(u=>u.id===selected)){const chosen=await api('/api/admin/users/'+encodeURIComponent(selected));users.push(chosen.user);} const user = users.find(u => u.id === selected);
  const picker = field('选择客户，管理其授权','user_id',{type:'select',value:user?.id || '',choices:[{value:'',label:'请选择已开通映射的客户'},...users.filter(u => u.core_customer_id).map(u => ({value:u.id,label:`${u.display_name || u.email} · ${u.email}`}))]});
  picker.querySelector('select').addEventListener('change',event => navigate(event.target.value ? `/admin/resources?user_id=${encodeURIComponent(event.target.value)}` : '/admin/resources'));
  const grantBody = el('div',{},el('div',{class:'card-body'},picker));
  if (user?.core_customer_id) {
    const grants = collection(await api(`/api/admin/grants?user_id=${encodeURIComponent(user.id)}`),'grants');
    grantBody.append(table([
      {label:'资源',render:g => g.name || 'Code 资源'}, {label:'状态',render:g => badge(g.status)}, {label:'有效期至',render:g => g.expires_at ? date(g.expires_at) : '无额外到期时间'},
      {label:'版本',render:g => number(g.revision)},
      {label:'操作',render:g => el('div',{class:'table-actions'},el('button',{class:'btn small',type:'button',disabled:!Number.isInteger(g.revision),text:'有效期',onclick:() => grantEditor(user,resources,g)}),actionButton(g.status === 'active' ? '撤销授权' : '恢复授权',async () => {
        const revoke = g.status === 'active';
        if (!Number.isInteger(g.revision)) throw new Error('授权版本缺失，请重新读取。');
        if (!await confirmAction(revoke ? '撤销资源授权' : '恢复资源授权',`确认${revoke ? '撤销' : '恢复'}「${user.display_name || user.email}」的「${g.name || '此资源'}」？版本 ${g.revision}。${revoke ? '新的执行会被拒绝，已受理的执行可能完成。' : '服务器将重新检查资源状态与有效期。'}`,revoke ? '撤销授权' : '恢复授权',revoke)) return CANCEL;
        return api(`/api/admin/grants/${encodeURIComponent(g.id)}`,{method:'PATCH',body:{expected_revision:g.revision,status:revoke ? 'revoked' : 'active'}});
      },{danger:g.status === 'active',disabled:!Number.isInteger(g.revision)}))},
    ],grants,'此客户尚未获得资源授权','从上方可用资源中选择并分配。'));
  } else grantBody.append(emptyState('选择一位客户','只列出已开通上游客户的本站账户。请先在客户管理中完成开通。','users'));
  return el('div',{class:'page-content'},notice('资源由上游提供','本站只能分配当前商户拥有的资源。授权范围、期限与版本以上游校验为准；不会覆盖冲突的新版本。'),
    panel('商户资源','仅支持 Code 产品通道',table([
      {label:'资源名称',render:r => el('div',{},el('strong',{text:r.name}),el('span',{class:'table-sub',text:Array.isArray(r.surfaces) ? r.surfaces.join(' · ') : '—'}))},
      {label:'状态',render:r => badge(r.available === false ? 'disabled' : r.status)}, 
      {label:'有效期至',render:r => r.expires_at ? date(r.expires_at) : '未设置到期时间'}, {label:'版本',render:r => number(r.revision)},
    ],resources,'尚无可分配资源','请联系平台管理员配置此商户的资源，本站不能创建上游资源。')),
    panel('客户授权','变更时携带读取到的授权版本',grantBody,el('button',{class:'btn primary',type:'button',disabled:!user?.core_customer_id || !resources.some(r => r.status === 'active' && r.available !== false),onclick:() => grantEditor(user,resources)},icon('plus'),'分配资源')));
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
  return el('div',{class:'page-content'},state.public.features.payment !== true ? notice('在线支付未启用','此处仍可查看已有真实订单，但不会模拟收款或提供手工入账。','warn') : notice('订单状态以服务端为准','支付回跳、刷新页面或打开收银台均不能证明支付成功。'),panel('支付订单',`${number(orders.length)} 条服务器记录`,orderTable(orders,true)));
}
async function auditView() {
  const events = collection(await api('/api/admin/audit'),'events');
  return panel('操作审计','只展示结构化操作信息，不输出敏感请求内容',table([
    {label:'时间',render:e => date(e.created_at)}, {label:'操作',render:e => e.action || '未提供'},
    {label:'操作者',render:e => el('span',{class:'mono',text:e.actor_id || '系统'})},
    {label:'目标',render:e => el('span',{class:'mono',text:e.subject_id || '—'})}, {label:'结果',render:e => e.outcome ? badge(e.outcome) : '结果未提供'},
  ],events,'暂无审计记录','管理操作产生后，服务器记录将展示在此处。'));
}
async function settingsView() {
  const [settings, connection, operations] = await Promise.all([api('/api/admin/settings'), api('/api/admin/connection'), api('/api/admin/operations')]);
  const ready = operations.readiness;
  const form = el('form',{},
    field('站点名称','name',{required:true,maxlength:100,value:settings.site?.name}),
    field('站点简介','description',{type:'textarea',maxlength:500,value:settings.site?.description}),
    field('Logo 地址（HTTPS，可选）','logo_url',{type:'url',value:settings.site?.logo_url || ''}),
    field('品牌主色','accent_color',{type:'color',value:settings.site?.accent_color || '#7c5cff'}),
    field('支持邮箱','support_email',{type:'email',maxlength:254,value:settings.site?.support_email || ''}),
    el('h3',{text:'成员注册'}),
    el('p',{class:'inline-info',text:'关闭后不能自助注册。邮箱验证和密码找回随邮件服务开启，不能在这里单独打开。'}),
    el('label',{class:'check-label'},el('input',{type:'checkbox',name:'registration_enabled',checked:settings.features?.registration === true}),'允许用户自助注册'),
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
      output.replaceChildren(notice(data.saved ? '上游连接已保存' : '连接验证通过，尚未保存',`${current.merchant.name} · 直接接入账户 · 协议 v${current.protocol_version}`,'success'),el('p',{class:'inline-info',text:`已授权权限：${current.scopes.join(' · ')}`}),el('a',{href:'/admin/resources',class:'btn',text:'查看可用供给 →'}));
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
  const services = el('div',{id:'services',class:'settings-section'},panel('邮件、支付与访问','这些项目在服务端环境中配置。这里只表示是否已填写，不表示渠道已经可用，也不能在浏览器里修改密钥。',el('div',{class:'card-body'},
    [['上游连接',ready.core_configured],['邮件服务',ready.mail_configured],['在线支付',ready.payment_configured],['公开 HTTPS',ready.https]].map(([label,ok]) => el('p',{},label,'：',badge(ok ? 'active' : 'pending'))),
    el('dl',{class:'detail-list'},
      el('dt',{text:'邮箱验证'}),el('dd',{text:settings.features?.email_verification === true ? '已启用' : '未启用'}),
      el('dt',{text:'密码找回'}),el('dd',{text:settings.features?.password_reset === true ? '已启用' : '未启用'}),
      el('dt',{text:'钱包扣费'}),el('dd',{text:'按充值与套餐结算，不按 Token 扣余额'})),
    el('p',{class:'inline-info',text:`数据库版本 ${ready.schema_version} · 同时转发上限 ${ready.runtime_limit}`}),
    notice('密钥不经过浏览器','上游密钥通过环境变量或上方的接入配置加密保存在服务端。邮件与 Stripe 密钥只存在于服务端环境。可选 Logo 会由浏览器向您填写的 HTTPS 地址请求图片。'))));
  return el('div',{class:'settings-stack'},
    notice('站点配置集中在本页','可修改公开信息和上游连接。邮件、支付与公开地址只显示服务端环境的配置状态。登录密码在个人设置，套餐价格在套餐管理。'),
    el('nav',{class:'settings-index','aria-label':'设置分区'},el('a',{href:'#public',text:'公开信息'}),el('a',{href:'#upstream',text:'上游连接'}),el('a',{href:'#services',text:'邮件与支付'})),
    el('section',{id:'public',class:'settings-section'},panel('公开站点信息','名称、简介、标识和注册开关会显示在登录页与工作台。',el('div',{class:'card-body'},form))),
    upstream,
    services);
}


function purchaseDialog(plan) {
 const requestId=crypto.randomUUID();
 const form=el('form',{},notice('确认购买',`${plan.name} · ${plan.duration_days} 天 · ${money(plan.amount_minor)}。有效使用权从原到期时间续期，已过期的从本次开通起算。按 24 小时计一天，不自动续费。`),
  field('支付方式','payment_method',{type:'select',choices:[{value:'wallet',label:'钱包余额'},...(state.public.features.payment?[{value:'stripe',label:'Stripe 在线支付'}]:[])],value:'wallet'}),
  el('button',{type:'submit',class:'btn primary',text:'确认下单'}),el('a',{href:'/orders',class:'btn',text:'查看已有订单'}));
 const dialog=editorDialog('购买或续期套餐',form);
 bindForm(form,async values=>{
  if(!await confirmAction('确认购买套餐',`${plan.name}，${plan.duration_days} 天，${money(plan.amount_minor)}。余额支付会立即扣款；在线支付将在收银台确认。`,'确认购买'))return CANCEL;
  return api('/api/me/rentals',{method:'POST',body:{plan_id:plan.id,expected_revision:plan.revision,payment_method:values.get('payment_method'),request_id:requestId}});
 },data=>{
  if(!data.rental?.id)throw Object.assign(new Error('订单结果未知，请前往订单核对。'),{uncertain:true});
  const result=el('div',{class:'card-body'},badge(data.rental.status),el('p',{class:'mono',text:data.rental.id}),notice('订单已记录','支付成功不等于交付完成。交付异常会进入待办；未交付订单可由管理员核对后退回余额。'),el('a',{class:'btn',href:'/orders',text:'查看订单与交付'}));
  if(data.checkout_url){const url=new URL(data.checkout_url);if(url.origin==='https://checkout.stripe.com'&&!url.username&&!url.password)result.append(el('a',{class:'btn primary',href:url.href,target:'_blank',rel:'noopener noreferrer',referrerpolicy:'no-referrer',text:'打开 Stripe 收银台 ↗'}));}
  form.replaceWith(result);
 });
 return dialog;
}
async function plansView() {
 const data=await api('/api/plans'),plans=collection(data,'plans');
 if(!plans.length)return emptyState('暂无在售套餐','商户发布套餐后可在这里购买或续期。不会用示例价格替代真实销售价。','layers');
 return el('div',{class:'page-content'},notice('按期限租用 · 不按 Token 扣费','套餐价格以服务器下单快照为准。续期不能超过供给期限；资源可用性由上游最终校验。'),el('div',{class:'resource-grid'},plans.map(p=>el('article',{class:'card resource-card'},el('span',{class:'eyebrow',text:'CODE · 固定期限'}),el('h2',{text:p.name}),el('p',{class:'muted',text:p.description}),el('h2',{text:money(p.amount_minor)}),el('p',{text:`${p.duration_days} 天 / 版本 ${p.revision}`}),el('button',{class:'btn primary',text:'购买 / 续期',onclick:()=>purchaseDialog(p)})))));
}
function planEditor(plan,resources) {
 const form=el('form',{},field('套餐名称','name',{required:true,maxlength:100,value:plan?.name||''}),field('套餐说明','description',{type:'textarea',maxlength:1000,value:plan?.description||''}),
 field('供给资源','resource_id',{type:'select',choices:resources.map(r=>({value:r.id,label:r.name})),value:plan?.resource_id||resources[0]?.id,disabled:Boolean(plan)}),
 field('租期（天，每天 24 小时）','duration_days',{type:'number',required:true,min:1,max:366,step:1,value:plan?.duration_days||30}),
 field('销售价（人民币元）','price',{type:'number',required:true,min:0.01,step:0.01,value:plan?String(plan.amount_minor/100):''}),
 field('上架状态','status',{type:'select',choices:[{value:'active',label:'上架'},{value:'archived',label:'下架'}],value:plan?.status||'archived'}),el('button',{class:'btn primary',type:'submit',text:'保存套餐'}));
 const dialog=editorDialog(plan?'编辑套餐':'创建套餐',form);
 bindForm(form,async values=>{
  const price=values.get('price');if(!/^\d+(\.\d{1,2})?$/.test(price))throw new Error('价格最多支持两位小数。');
  const [whole,fraction='']=price.split('.'),amount=Number(whole)*100+Number(fraction.padEnd(2,'0'));
  const body={name:values.get('name').trim(),description:values.get('description').trim(),duration_days:Number(values.get('duration_days')),amount_minor:amount,status:values.get('status'),...(plan?{expected_revision:plan.revision}:{resource_id:values.get('resource_id')})};
  if(!await confirmAction('保存套餐',`销售价 ${money(amount)}，租期 ${body.duration_days} 天。已有订单保留原价格及租期，不随本次编辑变化。`,'确认保存'))return CANCEL;
  return api(plan?`/api/admin/plans/${encodeURIComponent(plan.id)}`:'/api/admin/plans',{method:plan?'PATCH':'POST',body});
 },()=>{dialog.close();render();});
}
async function planAdminView() {
 const [p,r]=await Promise.all([api('/api/admin/plans'),api('/api/admin/resources')]),plans=collection(p,'plans'),resources=collection(r,'resources');
 return panel('销售套餐','下架不影响已支付订单；每笔订单保存独立价格与租期快照。',table([{label:'套餐',render:p=>p.name},{label:'销售价',render:p=>money(p.amount_minor)},{label:'租期',render:p=>`${p.duration_days} 天`},{label:'状态',render:p=>badge(p.status)},{label:'版本',render:p=>p.revision},{label:'操作',render:p=>el('button',{class:'btn small',text:'编辑',onclick:()=>planEditor(p,resources)})}],plans,'尚未配置套餐','先确认上游已分配 Code 供给，再创建销售套餐。'),el('button',{class:'btn primary',text:'创建套餐',disabled:!resources.length,onclick:()=>planEditor(null,resources)}));
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
  if(o.checkout_url){let u;try{u=new URL(o.checkout_url);}catch{}if(u?.origin==='https://checkout.stripe.com'&&!u.username&&!u.password)actions.append(el('a',{class:'btn small',href:u.href,target:'_blank',rel:'noopener noreferrer',text:'继续支付'}));}
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
 return el('div',{class:'page-content'},notice('支付、交付和退款分别核对','已交付表示上游曾确认使用权，并不保证它当前未被撤销；实时状态请查看我的权益。未交付退款仅退回本站余额。'),filters,panel('套餐订单','价格、租期和购买身份以下单快照为准。',rentalTable,exportButton),pager);
}
async function operationsView() {
 const data=await api('/api/admin/operations');
 const tasks=collection(data,'pending_customers');
 return el('div',{class:'page-content'},notice('后台自动核对已启用',`客户同步和已知支付会话会定期核对，订单交付最多自动尝试 ${data.worker.max_attempts} 次，之后保留待人工处理。不会重新创建不确定的支付订单。`),
 el('div',{class:'stats-grid'},stat('待同步客户',number(tasks.length),'本页最多列出 100 个','users'),stat('待确认支付',number(data.payments_pending),'包括结果未知的订单','wallet'),stat('待核对交付',number(data.rentals.filter(r=>['review','refund_pending'].includes(r.status)).reduce((n,r)=>n+r.count,0)),'可在销售与交付处理','receipt')),
 panel('客户同步待办','停用尚未确认时，本站会暂停该客户的新运行请求，直到上游确认。',table([{label:'客户',render:u=>u.display_name},{label:'状态',render:u=>badge(u.status)},{label:'提示',render:u=>u.sync_error||'等待同步'},{label:'操作',render:u=>actionButton('重新核对',()=>api(`/api/admin/users/${encodeURIComponent(u.id)}${u.core_customer_id?'':'/provision'}`,{method:u.core_customer_id?'PATCH':'POST',body:{}}))}],tasks,'没有待同步客户','当前没有持久化客户同步待办。')),
 el('p',{class:'inline-info'},'邮件、支付和公开地址是否已配置，请在',el('a',{href:'/admin/settings#services',text:'站点设置'}),'中查看。'),el('a',{class:'btn',href:'/admin/rentals?status=review',text:'处理交付待办 →'}));
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
 root.append(notice('只管理直接接入的客户','客户使用本站签发的密钥。本站请求上游时只用自己的凭据，不转发客户密钥，也不管理客户自己的下级。'),panel('API 客户','一个接入账户可以有多把密钥；数据和资源属于账户，不属于单把密钥。',table([{label:'客户',render:a=>el('div',{},el('strong',{text:a.name}),el('p',{class:'mono muted',text:a.slug}))},{label:'站点',render:a=>el('span',{class:'mono',text:a.public_origin})},{label:'状态',render:a=>badge(a.status)},{label:'操作',render:a=>el('div',{class:'button-row'},el('button',{class:'btn small',text:'编辑',onclick:()=>accessEditor(a)}),el('a',{class:'btn small',href:`/admin/access?account=${encodeURIComponent(a.id)}`,text:'资源与密钥'}))}],accounts,'暂无 API 客户','先创建本站接入账户，再分配资源和签发密钥。'),el('button',{class:'btn primary',text:'创建 API 客户',onclick:()=>accessEditor(null)})));
 const selected=accounts.find(a=>a.id===new URLSearchParams(location.search).get('account'));
 if(selected){
  const [r,k,own]=await Promise.all([api(`/api/admin/access-accounts/${selected.id}/resources`),api(`/api/admin/access-accounts/${selected.id}/keys`),api('/api/admin/resources')]),resources=collection(r,'resources'),keys=collection(k,'keys'),sources=collection(own,'resources');
  root.append(panel(`${selected.name} · 资源范围`,'分配仅限本站拥有的资源范围和期限，不设置客户人数配额。',table([{label:'资源',render:r=>r.name},{label:'期限',render:r=>r.expires_at?date(r.expires_at):'无固定期限'},{label:'状态',render:r=>badge(r.available?'active':'disabled')},{label:'操作',render:r=>el('button',{class:'btn small',text:'编辑范围',onclick:()=>accessResourceEditor(selected,sources,r)})}],resources),el('button',{class:'btn',text:'分配资源',disabled:!sources.length,onclick:()=>accessResourceEditor(selected,sources)})));
  root.append(panel(`${selected.name} · 本站密钥`,'交付本站公开地址和这里生成的密钥，绝不交付本站的上游密钥。',table([{label:'密钥',render:k=>k.name},{label:'前缀',render:k=>k.prefix+'…'},{label:'权限',render:k=>k.scopes.join(' · ')},{label:'期限',render:k=>date(k.expires_at)},{label:'状态',render:k=>badge(k.revoked_at?'revoked':k.expires_at&&Date.parse(k.expires_at)<Date.now()?'expired':'active')},{label:'操作',render:k=>el('div',{class:'table-actions'},k.copyable?actionButton('查看',async()=>{const data=await api(`/api/admin/access-accounts/${selected.id}/keys/${k.id}/copy`,{method:'POST',body:{}});showSecret({key:k,token:data.token});return CANCEL;}):el('span',{class:'muted',text:k.revoked_at?'':'不可再查看'}),actionButton('撤销',async()=>{if(!await confirmAction('撤销这把接入密钥','仅撤销这把密钥，并清除可再次查看的原文。同一接入账户的其他有效密钥和已有数据不变。','确认撤销',true))return CANCEL;return api(`/api/admin/access-accounts/${selected.id}/keys/${k.id}`,{method:'DELETE',body:{}});},{danger:true,disabled:Boolean(k.revoked_at)}))}],keys),el('button',{class:'btn',text:'签发接入密钥',onclick:()=>accessKeyEditor(selected)})));
 }
 return root;
}
const views = {'/admin/access':accessView,'/plans':plansView,'/orders':rentalsView,'/admin/plans':planAdminView,'/admin/rentals':rentalsView,'/admin/operations':operationsView,'/':overviewView,'/rights':rightsView,'/devices':devicesView,'/connect':connectView,'/usage':usageView,'/wallet':walletView,'/profile':profileView,'/admin/customers':customersView,'/admin/resources':resourcesView,'/admin/orders':ordersView,'/admin/audit':auditView,'/admin/settings':settingsView};
bootstrap();
