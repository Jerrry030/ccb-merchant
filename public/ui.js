import { el, icon } from './dom.js';
import { state } from './state.js';
import { number } from './format.js';
import { safeRoute, navigate } from './router.js';
import { render, bootstrap } from './app.js';
export function toast(message) {
  document.querySelector('.toast')?.remove(); const node = el('div',{class:'toast',role:'status',text:message}); document.body.append(node);
  setTimeout(() => node.remove(),4500);
}
export function badge(status) {
  const map = {awaiting_payment:['待支付','warn'],queued:['待开通','warn'],review:['待核对','warn'],fulfilled:['已交付','good'],refund_pending:['退款核对中','warn'],archived:['已下架','warn'],ok:['已完成','good'],unknown:['待核实','warn'],creating:['创建中','warn'],delivery_unknown:['邮件待核实','warn'],active:['有效','good'],available:['可用','good'],connected:['已连接','good'],approved:['已授权','good'],paid:['已支付','good'],completed:['已完成','good'],succeeded:['已成功','good'],member:['成员','purple'],admin:['管理员','purple'],pending:['待处理','warn'],pending_verification:['待验证','warn'],unverified:['待验证','warn'],expired:['已过期','warn'],disabled:['已停用','bad'],revoked:['已撤销','bad'],failed:['失败','bad'],canceled:['已取消','warn'],cancelled:['已取消','warn'],created:['已创建','purple'],refunded:['已退回余额','warn']};
  const [label,color] = map[status] || [typeof status === 'string' ? status : '未知状态',''];
  return el('span',{class:`badge ${color}`},el('span',{class:'dot'}),label);
}
export function notice(title, text, tone = '', action) {
  return el('div',{class:`notice ${tone}`,role:tone === 'error' ? 'alert' : 'status'},icon(tone === 'success' ? 'check' : 'info'),el('div',{},el('strong',{text:title}),text ? el('p',{text}) : null,action));
}
export function emptyState(title, description, symbol = 'layers', action) {
  return el('div',{class:'empty-state'},el('span',{class:'empty-icon'},icon(symbol)),el('h3',{text:title}),el('p',{text:description}),action);
}
export function panel(title, description, body, action) {
  return el('section',{class:'card'},el('div',{class:'card-head'},el('div',{},title ? el('h2',{text:title}) : null,description ? el('p',{text:description}) : null),action),body);
}
export function table(columns, rows, empty = '目前没有记录', explanation = '服务器尚未返回任何记录；产生真实数据后将显示在这里。') {
  if (!rows.length) return emptyState(empty,explanation);
  const header = el('tr',{},columns.map(c => el('th',{scope:'col',text:c.label})));
  return el('div',{class:'table-wrap',tabindex:'0','aria-label':'数据表，可横向滚动'},el('table',{},el('thead',{},header),el('tbody',{},rows.map(row => el('tr',{},columns.map(c => el('td',{'data-label':c.label},c.render(row))))))));
}
export function errorNotice(error, refresh = () => render()) {
  if (error.uncertain) return notice('操作结果尚未确认','请先刷新列表或检查服务器状态，不要立即重复提交。关闭此提示不代表操作未执行。','warn',el('button',{class:'btn small',type:'button',onclick:refresh,text:'重新读取状态'}));
  if (/last.?admin|self.?disable/i.test(error.code || '')) return notice('需要保留可用的管理员','不能停用自己或移除最后一位管理员。请先确保其他管理员可正常登录。','error');
  if (error.code === 'not_provisioned' || error.code === 'core_sync_pending') return notice('账号暂不可用',error.message,'warn');
  if (error.code === 'invalid_csrf') return notice('请重新验证会话',error.message,'warn',el('button',{class:'btn small',type:'button',text:'重新验证会话',onclick:() => bootstrap()}));
  if (error.status === 409) return notice('状态冲突，未覆盖新版本',`${error.message} 请重新读取最新状态，再确认是否需要操作。`,'warn',el('button',{class:'btn small',type:'button',onclick:refresh,text:'刷新最新状态'}));
  if (error.status === 401 && state.user) return notice('登录已失效','请重新登录后继续；刚才的操作未被确认。','warn',el('button',{class:'btn small',type:'button',text:'重新登录',onclick:() => { state.returnTo = safeRoute(location.pathname + location.search); state.user = null; state.csrf = null; navigate('/login'); }}));
  return notice(error.status === 403 ? '没有执行权限' : '暂时无法完成',error.message,'error');
}
export function stat(label, value, note, symbol) {
  return el('section',{class:'card stat'},el('div',{class:'stat-top'},el('span',{text:label}),el('span',{class:'stat-icon'},icon(symbol))),el('p',{class:'stat-value',text:value}),el('p',{class:'stat-note',text:note}));
}
export function supportContact() {
  const address = String(state.public?.site?.support_email || '').trim();
  return address ? `请联系 ${address}。` : '请联系商户管理员。';
}
export function statusBadge(status) {
  const code = Number(status);
  if (!Number.isInteger(code)) return badge(String(status ?? '未知'));
  const tone = code >= 200 && code < 300 ? 'good' : code === 429 || code >= 500 ? 'bad' : code >= 400 ? 'warn' : '';
  const title = code === 429 ? '429 限流，计入失败' : code >= 500 ? '服务失败' : code >= 400 ? '请求未成功' : '成功';
  return el('span',{class:`badge ${tone}`.trim(),title},el('span',{class:'dot'}),String(code));
}
export function expiryIndicator(value, now=Date.now()) {
  const end=Date.parse(value);
  if(!Number.isFinite(end))return el('span',{class:'table-sub',text:'期限未提供'});
  const remaining=end-now;
  return el('span',{class:remaining<=7*86400000?'badge warn':'table-sub',text:remaining<=0?'已到期':remaining<86400000?'不足 1 天':String(Math.ceil(remaining/86400000))+' 天后到期'});
}
export function listPager(data, params, base, unit='条') {
  return el('div',{class:'pager'},el('span',{text:'共 '+number(data.total)+' '+unit+' · 第 '+(Math.floor(data.offset/data.limit)+1)+' 页'}),[-1,1].map(direction=>el('button',{class:'btn small',type:'button',text:direction<0?'上一页':'下一页',disabled:direction<0?data.offset===0:data.offset+data.limit>=data.total,onclick:()=>{const next=new URLSearchParams(params);next.set('offset',String(Math.max(0,data.offset+direction*data.limit)));navigate(base+'?'+next);}})));
}
