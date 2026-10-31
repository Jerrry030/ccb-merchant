import { el } from './dom.js';
import { api, collection } from './api.js';
import { date } from './format.js';
import { emptyState, panel, supportContact } from './ui.js';
export async function accountsView() {
  const accounts = collection(await api('/api/me/accounts'),'accounts');
  if (!accounts.length) return panel('我的账号','管理员分配后，账号会自动出现在这里。',emptyState('还没有账号','注册只创建登录账户。分配完成前不需要充值，也不需要安装或连接设备。'+supportContact(),'layers'));
  return el('div',{class:'page-content'},el('a',{href:'/devices',class:'btn small',text:'查看全部设备'}),el('div',{class:'account-grid'},accounts.map(account=>accountCard(account))),el('p',{class:'inline-info',text:'\u6362\u8d26\u53f7\uff1a\u5728\u9879\u76ee\u76ee\u5f55\u8fd0\u884c ccb account\u3002\u989d\u5ea6\u7528\u5b8c\u4f1a\u5728\u7a97\u53e3\u91cd\u7f6e\u540e\u81ea\u52a8\u6062\u590d\uff0c\u4e0d\u4ece\u94b1\u5305\u6263\u8d39\u3002'}));
}
export function accountCard(account, inventory = false) {
  const windows = Array.isArray(account.quota?.windows) ? account.quota.windows : [];
  const limited = account.state === 'limited' || windows.some(item => Number.isFinite(item.used_percent) && item.used_percent >= 100);
  const surfaces = (account.surfaces || []).map(item => item === 'desktop' ? 'Desktop' : item === 'code' ? 'Claude Code' : item).join('\u3001') || 'Claude Code';
  return el('article',{class:limited ? 'account-card limited' : 'account-card'},
    el('div',{class:'account-top'},el('div',{},el('h2',{text:account.name || '\u672a\u547d\u540d\u8d26\u53f7'}),el('p',{text:`${account.plan || 'Claude'} \u00b7 ${surfaces}`})), limited ? el('span',{class:'limit-pill',text:'\u989d\u5ea6\u53d7\u9650'}) : null),
    quotaSummary(account.quota),
    limited ? el('p',{class:'quota-empty',text:'\u989d\u5ea6\u6682\u65f6\u7528\u5b8c\uff0c\u7a97\u53e3\u91cd\u7f6e\u540e\u81ea\u52a8\u6062\u590d\u3002'}) : null,
    el('p',{class:'inline-info',text:`${account.platform||'平台未提供'} · 有效期至 ${date(account.expires_at)} · 设备上限 1 台`}),
    inventory ? null : el('div',{class:'button-row'},['available','limited'].includes(account.state)?el('a',{class:'btn primary small',href:'/connect?account_id='+encodeURIComponent(account.id),text:'开始使用'}):el('span',{class:'badge',text:account.state==='expired'?'已到期，请联系管理员':'暂不可用，请联系管理员'}),account.device_name?el('a',{class:'btn small',href:'/devices?account_id='+encodeURIComponent(account.id),text:'更换设备'}):null),
    el('div',{class:'account-foot',text:account.device_name ? `${account.device_name} \u5728\u7528` : '\u6ca1\u6709\u8bbe\u5907\u5728\u7528'}));
}
export function quotaSummary(quota) {
 const windows=Array.isArray(quota?.windows)?quota.windows:[];
 return el('div',{class:'quota-summary'},quota?.status==='error'?el('div',{class:'quota-summary-error'},el('span',{class:'badge warn',text:'额度读取失败'}),windows.length?el('span',{class:'table-sub',text:'下方为上次读取结果，仅供参考，请刷新后重试。'}):null):null,
  windows.length?windows.map(window=>{
   const label=window.label||window.key||'额度';
   const percent=Number.isFinite(window.used_percent)&&window.used_percent>=0?Math.min(100,window.used_percent):null;
   const tone=percent>=100?'full':percent>=80?'near-limit':'';
   const used=percent===null?'未知':'已用 '+Math.round(percent)+'%';
   const track=percent===null?null:el('div',{class:'quota-track',role:'progressbar','aria-label':label+'额度已用','aria-valuemin':0,'aria-valuemax':100,'aria-valuenow':percent,'aria-valuetext':used+(tone==='full'?'，额度已用满':tone==='near-limit'?'，接近用满':'')},el('span',{'aria-hidden':'true'}));
   if(track)track.firstElementChild.style.width=percent+'%';
   return el('div',{class:'quota-summary-window'+(tone?' '+tone:'')},
    el('div',{class:'quota-summary-label'},el('span',{text:label}),el('strong',{text:used})),track,
    window.resets_at?el('span',{class:'table-sub',text:'重置：'+date(window.resets_at)}):null);
  }):el('span',{class:'muted',text:'额度未知'}));
}
