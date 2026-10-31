import { usageDetail } from './usage-detail.js';
import { el, icon } from './dom.js';
import { api, collection } from './api.js';
import { date, number, finite, localDay, formatDuration, exactTokens, cacheTokens, formatCost } from './format.js';
import { navigate } from './router.js';
import { statusBadge, notice, panel, table } from './ui.js';
import { field } from './ui-form.js';
import { metricInfo, detailPopover } from './ui-popover.js';
import { recordStats } from './ui-usage.js';
const usageRanges = [
  {id:'1h',label:'近 1 小时',ms:3600000},
  {id:'1d',label:'近 24 小时',ms:86400000},
  {id:'7d',label:'近 7 天',ms:7 * 86400000},
  {id:'30d',label:'近 30 天',ms:30 * 86400000},
  {id:'all',label:'全部时间'},
];
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
export async function usageView() {
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
  const staff=location.pathname==='/admin/customer-usage',userId=params.get('user_id'),view=params.get('view')==='sessions'?'sessions':'requests';
  if(staff&&!userId)throw new Error('请先选择客户。');
  for(const key of ['device_id','grant_id','model','result','session_id'])if(params.get(key))query.set(key,params.get(key));query.set('view',view);
  const data=await api((staff?`/api/admin/users/${encodeURIComponent(userId)}/usage`:'/api/me/usage')+'?'+query);
  const requests = collection(data,'requests'), usage = data.usage;
  const label = range === 'today' ? '今日' : range === 'custom' ? '自定义范围' : usageRanges.find(item => item.id === range)?.label;
  const form = el('form',{class:'filter-bar'},field('开始日期','from',{type:'date',value:localDay(from)}),field('结束日期','to',{type:'date',value:localDay(to)}),el('button',{class:'btn',type:'submit',text:'查询'}));
  form.addEventListener('submit',event => {
    event.preventDefault();
    const values = new FormData(form), start = values.get('from'), end = values.get('to');
    if (start && end && start > end) { document.getElementById('page-feedback').replaceChildren(notice('日期范围有误','开始日期不能晚于结束日期。','error')); return; }
    const next = new URLSearchParams(params);next.delete('offset');
    if (!start && !end) next.set('range','all');
    else {
      next.set('range','custom');
      if (start) next.set('from',new Date(`${start}T00:00:00`).toISOString());
      if (end) next.set('to',new Date(`${end}T23:59:59.999`).toISOString());
    }
    for(const key of ['device_id','grant_id','model','result','view']){const v=values.get(key);if(v)next.set(key,v);else next.delete(key);}navigate(location.pathname+'?'+next);
  });
  let accountChoices=[];
  try {const listed=await api(staff?'/api/admin/inventory':'/api/me/accounts');accountChoices=staff?collection(listed,'accounts').filter(a=>a.user_id===userId&&a.grant_id).map(a=>({value:a.grant_id,label:a.account_code||a.details?.name||a.grant_id})):collection(listed,'accounts').map(a=>({value:a.grant_id||a.id,label:a.name}));}catch{/* Usage remains readable when account metadata is unavailable. */}
  if(params.get('grant_id')&&!accountChoices.some(a=>a.value===params.get('grant_id')))accountChoices.push({value:params.get('grant_id'),label:'指定的历史授权'});
  form.append(field('账号','grant_id',{type:'select',value:params.get('grant_id')||'',choices:[{value:'',label:'全部账号'},...accountChoices]}));
  form.append(field('设备 ID','device_id',{value:params.get('device_id')||''}),field('模型','model',{value:params.get('model')||''}),field('结果','result',{type:'select',choices:[{value:'',label:'全部'},{value:'success',label:'成功'},{value:'error',label:'失败'}],value:params.get('result')||''}),field('查看方式','view',{type:'select',choices:[{value:'requests',label:'请求'},{value:'sessions',label:'会话'}],value:view}));
  const total = Number.isSafeInteger(data.total) ? data.total : null;
  const timeline=data.timeline,points=timeline?.points||[];
  const graph=timeline?panel('用量趋势',`${date(timeline.from)} — ${date(timeline.to)} · ${timeline.interval==='hour'?'按小时':'按天'} UTC · 完整筛选结果，不是本页采样。未知 Token 单独计数。`,el('div',{class:'usage-trend',role:'img','aria-label':'请求量时间趋势'},points.map(p=>el('div',{class:'usage-trend-bar',title:`${date(p.time)}：${p.requests} 请求，${p.errors} 失败，${p.unknown_usage} 未知用量`,style:`height:${Math.max(2,100*p.requests/Math.max(1,...points.map(v=>v.requests)))}%`})) )):(total>0?notice('趋势尚不可用','提供方尚未返回聚合时间序列，不能用当前页拼出完整趋势。'):null);
  const pageOf = nextOffset => {
    const next = new URLSearchParams(params);next.set('range',range);
    if (from) next.set('from',from);
    if (to) next.set('to',to);
    if (nextOffset > 0) next.set('offset',String(nextOffset));
    navigate(location.pathname+'?'+next);
  };
  const pager = el('div',{class:'pager'},el('span',{text:total === null ? '总数未提供' : `共 ${number(total)} 条 · 第 ${Math.floor(offset/20)+1} 页`}),el('button',{class:'btn small',disabled:offset === 0,type:'button',text:'上一页',onclick:() => pageOf(Math.max(0,offset-20))}),el('button',{class:'btn small',disabled:total === null || offset + 20 >= total,type:'button',text:'下一页',onclick:() => pageOf(offset+20)}));
  const seg = el('div',{class:'seg',role:'group','aria-label':'时间范围'},usageRanges.map(item => el('button',{type:'button',class:range === item.id ? 'on' : '','aria-pressed':range === item.id ? 'true' : 'false',text:item.label,onclick:() => { const next = new URLSearchParams(params);next.set('range',item.id);next.delete('offset'); if (item.ms) { const end = new Date(); next.set('to',end.toISOString()); next.set('from',new Date(end.getTime() - item.ms).toISOString()); } navigate(location.pathname+'?'+next); }})));
  return el('div',{class:'page-content usage-page'},
    recordStats(usage,label),graph,
    !usage ? notice('统计尚不可用','服务器尚未返回用量汇总。下方仅展示实际返回的请求记录。','warn') : null,
    panel('请求记录','模型调用和 Token 用量。参考费用不会从钱包扣费。',el('div',{},el('div',{class:'record-toolbar'},seg,form),view==='sessions'?table([{label:'会话',render:r=>r.session_id},{label:'模型',render:r=>r.model},{label:'请求 / 失败',render:r=>`${r.requests} / ${r.errors}`},{label:'最近活动',render:r=>date(r.last_time)}],data.sessions||[],'暂无会话','请选择其他范围。'):table([
      {label:'时间',render:row => date(row.time)},
      {label:'模型 / 状态',render:row => el('div',{class:'record-stack'},el('span',{class:'record-primary',text:row.model || '—'}),el('span',{class:'record-secondary'},statusBadge(row.status),row.stream ? ' 流式' : '',row.count_only ? ' 计数' : ''))},
      {label:'Token',render:requestTokens},
      {label:'参考费用',render:requestCost},
      {label:'总时长 / 首 Token',render:requestTiming},
    ],requests,'此区间暂无请求','换一个时间范围，或在获得权益并连接设备后开始使用。'),pager)));
}
