import { closeMetricPopover } from './ui-popover.js';
import { render } from './app.js';
export const authRoutes = new Set(['/login', '/setup', '/register', '/verify', '/forgot', '/reset']);
export const connectGuides = {
  idle: '安装 CCB、登录并确认设备，然后开始你的项目。',
  pairing: '核对设备信息并确认，然后回到终端继续。',
};
export const navigation = [
  { path:"/", nav:"home", title:"首页", icon:"overview", description:'查看账单与用量。参考费用只供核对，不会从钱包扣费。' },
  { path:"/connect", nav:"connect", title:"开始使用", icon:"terminal", description:connectGuides.idle },
  { path:"/accounts", nav:"accounts", title:"我的账号", icon:"layers", description:'查看已分配或订阅交付的账号、额度和正在使用的设备。' },
  { path:"/devices", nav:"devices", title:"我的设备", icon:"monitor", description:'每个账号最多绑定 1 台设备。换机请先撤销旧设备，再连接新设备。' },
  { path:"/usage", nav:"usage", title:"使用记录", icon:"chart", description:'查看请求与 Token。参考成本只供核对，不会从钱包扣费。' },
  { path:"/orders", nav:"billing", title:"我的订单", icon:"receipt", description:'核对套餐支付、开通、续期及退回余额。' },
  { path:"/wallet", nav:"billing", hidden:true, title:"充值/订阅", icon:"wallet", description:'充值人民币余额，或购买固定期限订阅。购买时选择一个登录平台，并查看是否有货。' },
  { path:"/profile", nav:"profile", title:"个人设置", icon:"user", description:'查看账户信息，维护您的登录安全。' },
  { path:"/admin/operations", nav:"operations", title:"待办", icon:"overview", admin:true, description:'处理新注册待分配、客户同步、支付核对和交付异常。' },
  { path:"/admin/customers", nav:"customers", title:"客户", icon:"users", admin:true, description:"管理站点客户。账号、设备、用量和订单在客户内部处理。" },
  { path:"/admin/access", nav:"customers", hidden:true, title:"API 接入", icon:"key", admin:true, description:'管理直接接入的客户、密钥和资源范围。' },
  { path:"/admin/inventory", nav:"inventory", title:"库存", icon:"layers", admin:true, description:'查看平台管理员分配的账号、有效期和客户分配状态。每个账号最多绑定 1 台设备。' },
  { path:"/admin/devices", nav:"admin-devices", title:"设备", icon:"monitor", admin:true, description:'汇总本站客户的设备、账号选择和授权状态。操作始终归属于对应客户。' },
  { path:"/admin/rentals", nav:"commerce", title:"订单", icon:"receipt", admin:true, description:"核对套餐、交付和支付。支付结果以服务端记录为准。" },
  { path:"/admin/plans", nav:"commerce", hidden:true, title:"套餐", icon:"layers", admin:true, description:'只为订阅分组设置有效期和金额。普通分组不在这里出售。' },
  { path:"/admin/orders", nav:"commerce", hidden:true, title:"支付", icon:"receipt", admin:true, description:'核对服务端记录的支付状态，不以回跳参数判定到账。' },
  { path:"/admin/audit", nav:"audit", title:"审计", icon:"shield", admin:true, description:'查看管理操作记录，追溯变更与授权。' },
  { path:"/admin/settings", nav:"settings", title:"设置", icon:"settings", admin:true, description:'管理公开信息、注册策略、上游连接，以及邮件和支付服务。' },
  { path:"/admin/upstream", nav:"settings", hidden:true, title:"上游接入", icon:"link", admin:true, description:'连接直接上级，核对账户与可用资源。' },
  { path:"/admin/customer-usage", nav:"customers", hidden:true, title:"客户使用记录", icon:"chart", admin:true, description:'在本站客户范围内查看用量和设备活动。' },
];
export function safeRoute(value) {
  try { const url = new URL(value,location.origin); return url.origin === location.origin && navigation.some(v => v.path === url.pathname) ? url.pathname + url.search : '/'; }
  catch { return '/'; }
}
export function navigate(path, replace = false) {
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
export const customerSections = {'/admin/customers':'概览','/admin/inventory':'账号','/admin/devices':'设备','/admin/customer-usage':'用量','/admin/rentals':'订单','/admin/orders':'订单','/admin/audit':'审计'};
export function customerPlace(user) {
  const params = new URLSearchParams(location.search);
  let detail = '/admin/customers?user_id=' + encodeURIComponent(user.id);
  if (location.pathname === '/admin/customers') detail = location.pathname + location.search;
  else if (params.get('return_to')) {
    try {
      const candidate = new URL(params.get('return_to'), location.origin);
      if (candidate.origin === location.origin && candidate.pathname === '/admin/customers' && candidate.searchParams.get('user_id') === user.id) detail = candidate.pathname + candidate.search;
    } catch { /* 无效返回地址不覆盖当前客户。 */ }
  }
  const list = new URL(detail, location.origin);
  list.searchParams.delete('user_id');
  list.searchParams.delete('return_to');
  return {detail, list: list.pathname + list.search, scope: new URLSearchParams({user_id: user.id, return_to: detail}).toString()};
}
export function presentedRoute(path, customer) {
  const spec = navigation.find(item => item.path === path) || {path, title:'页面不存在', description:'此地址不在导航中。', nav:'missing'};
  const section = customerSections[path];
  if (customer && section) return {...spec, nav:'customers', title: customer.display_name || '未命名客户', eyebrow: section, section, customer, crumb: section};
  let title = spec.title;
  let eyebrow = spec.admin ? '商户管理' : '我的账户';
  let crumb = spec.title;
  if (spec.nav === 'commerce') {
    title = '订单';
    eyebrow = {'/admin/plans':'套餐','/admin/rentals':'交付','/admin/orders':'支付'}[path] || '订单';
    crumb = '订单';
  } else if (path === '/admin/access') {
    title = '客户';
    eyebrow = 'API 客户';
    crumb = '客户';
  } else if (path === '/wallet') {
    title = '我的订单';
    eyebrow = '余额';
    crumb = '我的订单';
  } else if (path === '/orders') eyebrow = '订单';
  return {...spec, title, eyebrow, section:'', customer:null, crumb};
}
