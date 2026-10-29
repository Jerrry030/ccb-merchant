import { el } from './dom.js';
import { api, collection } from './api.js';
import { date } from './format.js';
import { emptyState, panel, supportContact, notice } from './ui.js';
export async function accountsView() {
  const accounts = collection(await api('/api/me/accounts'),'accounts');
  if (!accounts.length) return panel('我的账号','管理员分配后，账号会自动出现在这里。',emptyState('还没有账号','注册只创建登录账户。分配完成前不需要充值，也不需要安装或连接设备。'+supportContact(),'layers'));
  return el('div',{class:'page-content'},el('a',{href:'/devices',class:'btn small',text:'查看全部设备'}),el('div',{class:'account-grid'},accounts.map(account=>accountCard(account))),el('p',{class:'inline-info',text:'\u6362\u8d26\u53f7\uff1a\u5728\u9879\u76ee\u76ee\u5f55\u8fd0\u884c ccb account\u3002\u989d\u5ea6\u7528\u5b8c\u4f1a\u5728\u7a97\u53e3\u91cd\u7f6e\u540e\u81ea\u52a8\u6062\u590d\uff0c\u4e0d\u4ece\u94b1\u5305\u6263\u8d39\u3002'}));
}
export function accountCard(account, inventory = false) {
  const windows = Array.isArray(account.quota?.windows) ? account.quota.windows : [];
  const limited = account.state === 'limited' || windows.some(item => Number(item.used_percent) >= 100);
  const surfaces = (account.surfaces || []).map(item => item === 'desktop' ? 'Desktop' : item === 'code' ? 'Claude Code' : item).join('\u3001') || 'Claude Code';
  return el('article',{class:limited ? 'account-card limited' : 'account-card'},
    el('div',{class:'account-top'},el('div',{},el('h2',{text:account.name || '\u672a\u547d\u540d\u8d26\u53f7'}),el('p',{text:`${account.plan || 'Claude'} \u00b7 ${surfaces}`})), limited ? el('span',{class:'limit-pill',text:'\u989d\u5ea6\u53d7\u9650'}) : null),
    account.quota?.status==='error'?notice('额度读取失败','下方若保留了额度窗口，只代表上次读取结果，请结合更新时间核对。','warn'):null,
    windows.length ? el('div',{class:'quota-list'},windows.map(item => quotaRow(item, limited))) : el('p',{class:'quota-empty',text:account.quota?.status === 'error' ? '\u989d\u5ea6\u6682\u65f6\u8bfb\u4e0d\u5230\u3002' : '\u4e0a\u6e38\u8fd8\u6ca1\u6709\u8fd4\u56de\u989d\u5ea6\uff0c\u4e0d\u4ee3\u8868\u5df2\u7ecf\u7528\u5b8c\u3002'}),
    account.quota?.updated_at ? el('p',{class:'quota-updated',text:'额度更新：'+date(account.quota.updated_at)+(Date.now()-Date.parse(account.quota.updated_at)>15*60000?' · 数据可能已过期':'')}) : el('p',{class:'quota-updated',text:'额度更新时间未知'}),
    limited ? el('p',{class:'quota-empty',text:'\u989d\u5ea6\u6682\u65f6\u7528\u5b8c\uff0c\u7a97\u53e3\u91cd\u7f6e\u540e\u81ea\u52a8\u6062\u590d\u3002'}) : null,
    el('p',{class:'inline-info',text:`${account.platform||'平台未提供'} · 有效期至 ${date(account.expires_at)} · 设备上限 1 台`}),
    inventory ? null : el('div',{class:'button-row'},['available','limited'].includes(account.state)?el('a',{class:'btn primary small',href:'/connect?account_id='+encodeURIComponent(account.id),text:'开始使用'}):el('span',{class:'badge',text:account.state==='expired'?'已到期，请联系管理员':'暂不可用，请联系管理员'}),account.device_name?el('a',{class:'btn small',href:'/devices?account_id='+encodeURIComponent(account.id),text:'更换设备'}):null),
    el('div',{class:'account-foot',text:account.device_name ? `${account.device_name} \u5728\u7528` : '\u6ca1\u6709\u8bbe\u5907\u5728\u7528'}));
}
function quotaRow(item, limited) {
  const percent = Number.isFinite(item.used_percent) ? Math.max(0, Math.min(100, item.used_percent)) : null;
  if(percent===null) return el('div',{class:'quota-row'},el('div',{class:'quota-label'},el('span',{text:item.label||item.key||'额度'}),el('strong',{text:'未知'})),el('p',{text:'上游未提供有效百分比，不代表已使用 0%。'}));
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

export function quotaSummary(quota) {
 const windows=Array.isArray(quota?.windows)?quota.windows:[];
 const status=quota?.status;
 return el('div',{class:'quota-summary'},status==='error'?el('span',{class:'badge warn',text:'额度读取失败'}):null,
  windows.length?windows.map(w=>el('div',{},el('span',{text:w.label||w.key||'额度'}),el('strong',{text:Number.isFinite(w.used_percent)?' 已用 '+Math.round(Math.max(0,Math.min(100,w.used_percent)))+'%':' 未知'}),w.resets_at?el('span',{class:'table-sub',text:'重置：'+date(w.resets_at)}):null)):el('span',{class:'muted',text:'额度未知'}),
  el('span',{class:'table-sub',text:quota?.updated_at?'更新：'+date(quota.updated_at)+(Date.now()-Date.parse(quota.updated_at)>15*60000?'（可能已过期）':''):'更新时间未知'}));
}
