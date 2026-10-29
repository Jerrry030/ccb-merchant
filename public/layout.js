import { managementAllows, managementProfiles } from './management-policy.js';
import { el, icon } from './dom.js';
import { app, state } from './state.js';
import { api } from './api.js';
import { connectGuides, navigation, navigate, customerPlace } from './router.js';
import { badge, errorNotice } from './ui.js';
import { confirmAction } from './ui-form.js';
import { render } from './app.js';
export function brand() {
  const logo = state.public?.site?.logo_url;
  return el('a', {class:'brand',href:state.user ? '/' : '/login'}, el('span',{class:logo ? 'brand-mark brand-mark-custom' : 'brand-mark'},el('img',{src:logo || '/mark.svg',alt:'',width:34,height:34,referrerpolicy:'no-referrer',class:'brand-logo'})),
    el('span',{},el('span',{class:'brand-name',text:state.public?.site?.name || 'CCB'})));
}
export function themeButton(className = '') {
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
function sectionTabs(label, items) {
  return el('nav',{class:'section-tabs','aria-label':label}, items.map(([href, text, current]) => el('a',{href, text, 'aria-current': current ? 'page' : null})));
}
function routeTabs(route) {
  const path = location.pathname;
  if (route.customer) {
    const place = customerPlace(route.customer);
    const q = place.scope;
    const groups = [sectionTabs('客户业务', [
      [place.detail, '概览', path === '/admin/customers'],
      ['/admin/inventory?' + q, '账号', path === '/admin/inventory'],
      ['/admin/devices?' + q, '设备', path === '/admin/devices'],
      ['/admin/customer-usage?' + q, '用量', path === '/admin/customer-usage'],
      ['/admin/rentals?' + q, '订单', path === '/admin/rentals' || path === '/admin/orders'],
      ['/admin/audit?' + q, '审计', path === '/admin/audit'],
    ])];
    if (path === '/admin/rentals' || path === '/admin/orders') groups.push(sectionTabs('客户订单', [
      ['/admin/rentals?' + q, '交付', path === '/admin/rentals'],
      ['/admin/orders?' + q, '支付', path === '/admin/orders'],
    ]));
    return el('div',{class:'section-tab-groups'}, groups);
  }
  if (route.nav === 'commerce') return sectionTabs('订单分区', [
    ['/admin/plans', '套餐', path === '/admin/plans'],
    ['/admin/rentals', '交付', path === '/admin/rentals'],
    ['/admin/orders', '支付', path === '/admin/orders'],
  ]);
  if (route.nav === 'customers' && (path === '/admin/customers' || path === '/admin/access')) return sectionTabs('客户类型', [
    ['/admin/customers', '站点客户', path === '/admin/customers'],
    ['/admin/access', 'API 客户', path === '/admin/access'],
  ]);
  if (route.nav === 'billing') return sectionTabs('我的订单', [
    ['/orders', '订单', path === '/orders'],
    ['/wallet', '余额', path === '/wallet'],
  ]);
  return null;
}
function pageBreadcrumb(route) {
  const parts = [el('span',{text:state.public.site.name}), el('span',{'aria-hidden':'true',text:'/'})];
  if (route.customer) {
    const place = customerPlace(route.customer);
    parts.push(el('a',{href:place.list,text:'客户'}), el('span',{'aria-hidden':'true',text:'/'}), el('a',{href:place.detail,text:route.title}), el('span',{'aria-hidden':'true',text:'/'}), el('strong',{text:route.section}));
  } else parts.push(el('strong',{text:route.crumb || route.title}));
  return el('div',{class:'breadcrumb'}, parts);
}
function greeting(now = new Date()) {
  const hour = now.getHours();
  const part = hour < 5 ? '夜深了' : hour < 11 ? '早上好' : hour < 13 ? '中午好' : hour < 18 ? '下午好' : '晚上好';
  const day = new Intl.DateTimeFormat('zh-CN',{month:'long',day:'numeric',weekday:'long'}).format(now);
  return `${part}，${state.user.display_name || state.user.email} · ${day}`;
}
function pageHeading(route) {
  const lead = route.path === '/connect' ? el('p',{id:'connect-lead',text:state.code ? connectGuides.pairing : route.description})
    : route.customer ? (route.customer.email ? el('p',{text:route.customer.email}) : null)
    : route.description ? el('p',{text:route.description}) : null;
  return el('div',{class:'page-heading'}, el('div',{},
    el('span',{class:'eyebrow',text:route.path === '/' ? greeting() : route.eyebrow}),
    el('div',{class:'heading-title'}, el('h1',{text:route.title}), route.customer ? badge(route.customer.status) : null),
    lead), el('button',{class:'btn',type:'button',onclick:() => render()},icon('refresh'),'刷新'));
}
// Administrators get a sidebar and a breadcrumb top bar, collapsing into a drawer on narrow screens. Customers get a
// header with pill navigation; on phones the same navigation becomes a tab bar fixed to the bottom of the screen.
export function shell(route) {
  const admin = state.user.role === 'admin';
  const root = el('div',{class:admin ? 'shell' : 'shell site-shell'});
  const nav = el('nav',{class:admin ? null : 'site-nav','aria-label':'主导航'});
  const groups = [];
  if (admin) groups.push(['商户管理', navigation.filter(v => v.admin && !v.hidden && managementAllows(state.user,'GET',v.path.replace('/admin/','/api/admin/')))]);
  groups.push(['我的账户', navigation.filter(v => !v.admin && !v.hidden)]);
  for (const [name, items] of groups) {
    if (admin) nav.append(el('div',{class:'nav-group',text:name}));
    for (const item of items) nav.append(el('a',{class:'nav-link',href:item.path,'aria-current':route.nav === item.nav ? 'page' : null},icon(item.icon),el('span',{text:item.title})));
  }
  const logout = el('button',{class:'icon-button',type:'button','aria-label':'退出登录',onclick:async () => {
    if (!await confirmAction('退出登录','确定退出当前登录吗？','退出登录')) return;
    logout.disabled = true;
    try { await api('/api/auth/logout',{method:'POST'}); state.user = null; state.csrf = null; state.returnTo = '/'; state.code = ''; state.token = ''; navigate('/login',true); }
    catch (error) { document.getElementById('page-feedback')?.replaceChildren(errorNotice(error)); logout.disabled = false; }
  }},icon('logout'));
  const name = state.user.display_name || state.user.email || '?';
  const userCard = el('div',{class:'user-card'},el('span',{class:'avatar',title:name,text:name.slice(0,1).toUpperCase()}),el('div',{class:'user-info'},el('strong',{text:name}),el('small',{text:admin ? managementProfiles[state.user.management_profile||'owner'] : '工作空间成员'})),logout);
  const content = el('div',{class:'page-content',id:'page-content','aria-busy':'true'},el('div',{class:'loading',role:'status'},el('div',{class:'spinner','aria-hidden':'true'}),'正在读取最新数据…'));
  const main = el('main',{id:'main',class:'main',tabindex:'-1'},pageHeading(route),routeTabs(route),
    el('div',{id:'page-feedback'}),content,el('footer',{class:'page-footer'},el('span',{text:`${state.public.site.name}`}),el('span',{text:'用量可核对 · 密钥留在服务端'})));
  if (admin) {
    nav.addEventListener('click',event => { if (event.target.closest('a')) root.classList.remove('menu-open'); });
    const menu = el('button',{class:'icon-button mobile-menu',type:'button','aria-label':'打开导航','aria-controls':'sidebar','aria-expanded':'false',onclick:() => {
      const open = root.classList.toggle('menu-open'); menu.setAttribute('aria-expanded',String(open));
      if (open) nav.querySelector('a')?.focus();
    }},icon('menu'));
    const scrim = el('button',{class:'mobile-scrim',type:'button','aria-label':'关闭导航',onclick:() => { root.classList.remove('menu-open'); menu.setAttribute('aria-expanded','false'); menu.focus(); }});
    root.addEventListener('keydown',event => { if (event.key === 'Escape') { root.classList.remove('menu-open'); menu.setAttribute('aria-expanded','false'); menu.focus(); } });
    root.append(el('aside',{class:'sidebar',id:'sidebar'},brand(),nav,el('div',{class:'sidebar-foot'},userCard)),scrim,
      el('div',{class:'workspace'},el('header',{class:'topbar'},menu,pageBreadcrumb(route),el('div',{class:'top-actions'},themeButton(),badge(state.user.role))),main));
  } else root.append(el('header',{class:'site-header'},brand(),nav,el('div',{class:'top-actions'},themeButton(),userCard)),main);
  app.replaceChildren(root); return content;
}
