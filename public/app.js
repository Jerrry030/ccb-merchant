import { managementAllows } from './management-policy.js';
/* Standalone merchant client. Only /api on this origin; no stored credentials or demo data. */
import { el } from './dom.js';
import { app, state, adoptSession } from './state.js';
import { api } from './api.js';
import { authRoutes, customerSections, safeRoute, navigate, presentedRoute } from './router.js';
import { brand, shell } from './layout.js';
import { notice, emptyState, errorNotice } from './ui.js';
import { closeMetricPopover } from './ui-popover.js';
import { renderAuth } from './view-auth.js';
import { overviewView } from './view-home.js';
import { connectView } from './view-connect.js';
import { accountsView } from './view-accounts.js';
import { devicesView } from './view-devices.js';
import { usageView } from './view-usage.js';
import { rentalsView, ordersView } from './view-orders.js';
import { walletView } from './view-wallet.js';
import { profileView } from './view-profile.js';
import { operationsView } from './view-operations.js';
import { customersView } from './view-customers.js';
import { accessView } from './view-access.js';
import { inventoryView } from './view-inventory.js';
import { planAdminView } from './view-plans.js';
import { auditView } from './view-audit.js';
import { settingsView } from './view-settings.js';
export async function bootstrap() {
  app.replaceChildren(el('main',{id:'main',class:'boot'},el('div',{class:'spinner','aria-hidden':'true'}),el('p',{role:'status',text:'正在连接…'})));
  const query = new URLSearchParams(location.search);
  if (location.pathname === '/connect' && query.has('code')) { state.code = query.get('code').slice(0,128); history.replaceState({},'','/connect'); }
  if (['/verify','/reset'].includes(location.pathname) && query.has('token')) { state.token = query.get('token').slice(0,4096); history.replaceState({},'',location.pathname); }
  if (query.has('next')) state.returnTo = safeRoute(query.get('next'));
  try {
    state.public = await api('/api/public');
    if(/^#[0-9a-fA-F]{6}$/.test(state.public.site?.accent_color||''))document.documentElement.style.setProperty('--brand',state.public.site.accent_color);
    if (!state.public.site || !state.public.features || typeof state.public.setup_required !== 'boolean') throw new Error('站点配置不完整，无法安全初始化。');
    try { adoptSession(await api('/api/auth/session')); }
    catch (error) { if (error.status !== 401) throw error; state.user = null; state.csrf = null; }
    render();
  } catch (error) {
    app.replaceChildren(el('main',{id:'main',class:'boot'},brand(),notice('暂时无法连接',error.message,'error'),el('button',{class:'btn',type:'button',text:'重新连接',onclick:bootstrap})));
  }
}
export async function render() {
  closeMetricPopover();
  const ticket = ++state.view;
  state.scopedCustomer = null;
  if (location.pathname === '/admin/upstream') history.replaceState({}, '', '/admin/settings#upstream');
  const path = location.pathname;
  if (!state.public) return;
  if (!state.user) {
    if (!authRoutes.has(path)) { state.returnTo = safeRoute(path + location.search); navigate(state.public.setup_required ? '/setup' : '/login',true); return; }
    renderAuth(path); return;
  }
  if(state.user.must_change_password && path!=='/profile'){navigate('/profile',true);return;}
  if (authRoutes.has(path)) { navigate(state.returnTo || '/',true); return; }
  let content = null;
  try {
    const requestedCustomer = new URLSearchParams(location.search).get('user_id');
    let customer = null;
    if (state.user.role === 'admin' && requestedCustomer && Object.prototype.hasOwnProperty.call(customerSections, path)) {
      const data = await api('/api/admin/users/' + encodeURIComponent(requestedCustomer));
      if (ticket !== state.view) return;
      if (!data.user || data.user.id !== requestedCustomer) throw new Error('客户资料不完整。');
      customer = data.user;
      state.scopedCustomer = {ticket, user: customer};
    }
    const route = presentedRoute(path, customer);
    document.title = `${route.customer ? route.section + ' · ' : ''}${route.title} · ${state.public.site.name}`;
    content = shell(route);
    let result;
    if (route.admin && !managementAllows(state.user,'GET',path.replace('/admin/','/api/admin/'))) result = emptyState('没有管理权限','此页面仅供服务端确认的商户管理员访问。','shield',el('a',{class:'btn primary',href:'/',text:'返回首页'}));
    else if (!views[path]) result = emptyState('没有找到此页面','请使用侧栏导航。','info',el('a',{class:'btn',href:'/',text:'返回首页'}));
    else {
      result = await views[path]();
    }
    if (ticket !== state.view) return;
    content.replaceChildren(result); content.removeAttribute('aria-busy');
    document.getElementById('announcer').textContent = `${route.title}已加载`;
    const anchor = location.hash.replace(/^#/, '');
    if (anchor) document.getElementById(anchor)?.scrollIntoView({block:'start'});
  } catch (error) {
    if (ticket !== state.view) return;
    if (!content) content = shell(presentedRoute(path, null));
    content.removeAttribute('aria-busy'); content.replaceChildren(errorNotice(error),emptyState('数据暂不可用','当前未显示缓存或示例数据。请稍后重试，或联系管理员检查连接。','link',el('button',{class:'btn',type:'button',onclick:() => render(),text:'重试读取'})));
  }
}
const views = {'/admin/inventory':inventoryView,'/admin/access':accessView,'/orders':rentalsView,'/admin/plans':planAdminView,'/admin/rentals':rentalsView,'/admin/operations':operationsView,'/':overviewView,'/accounts':accountsView,'/devices':devicesView,'/admin/devices':devicesView,'/connect':connectView,'/usage':usageView,'/admin/customer-usage':usageView,'/wallet':walletView,'/profile':profileView,'/admin/customers':customersView,'/admin/orders':ordersView,'/admin/audit':auditView,'/admin/settings':settingsView};
bootstrap();
