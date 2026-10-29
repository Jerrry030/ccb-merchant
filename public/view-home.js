import { el } from './dom.js';
import { state } from './state.js';
import { api, collection } from './api.js';
import { date, number, money, finite, formatTokens, formatUSD, formatDuration, formatHit, tokenParts, shown } from './format.js';
import { notice, supportContact } from './ui.js';
import { metricPair, metricValue, chartWindow, chartScope, chartRangeControl, chartFilters, loadChartRows, usagePlot } from './ui-usage.js';
import { commandBlock, loginCommand } from './view-connect.js';
function homePreview() {
  return {
    usage: {requests:128},
    wallet: {balance_minor:26800,currency:'CNY'},
  };
}
async function usageSummary(from, to) {
  try {
    const query = new URLSearchParams({limit:'1',from:from.toISOString(),to:to.toISOString()});
    const data = await api(`/api/me/usage?${query}`);
    return data.usage ?? null;
  } catch { return null; }
}
export async function overviewView() {
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
  if (!previewing && pending.has('customer_not_provisioned')) root.append(notice('下一步','登录账户已经可用，但还没有分配账号。分配完成后，再打开「开始使用」安装并连接设备。在此之前不需要运行安装命令。'+supportContact(),'warn',el('a',{class:'btn small',href:'/accounts',text:'查看我的账号'})));
  const otherPending = [...pending].filter(item => item !== 'customer_not_provisioned');
  if (!previewing && otherPending.length) root.append(notice('还有待完成的事项',otherPending.map(item => pendingLabels[item] || item).join(' · '),'warn'));
  const cumulativeCost = usageKnown ? formatUSD(usage.cost_usd) : null;
  const cumulativeRequests = usageKnown ? number(usage.requests) : null;
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
  const hit = formatHit(recent), hitRate = Number.parseFloat(hit);
  const ring = el('span',{class:'hit-ring','aria-hidden':'true'});
  if (Number.isFinite(hitRate)) ring.style.setProperty('--hit',String(hitRate)); else ring.hidden = true;
  const walletTile = el('section',{class:'card wallet-card','aria-label':'钱包余额'},
    el('div',{class:'wallet-card-top'},el('span',{class:'k',text:'钱包余额'}),el('span',{class:'wallet-currency',text:wallet?.currency || 'CNY'})),
    metricValue(money(wallet?.balance_minor,wallet?.currency)),
    el('div',{class:'wallet-card-foot'},el('span',{class:'s',text:'人民币余额，不按参考 USD 扣费'}),el('a',{class:'chip',href:'/wallet',text:'充值'})));
  const costTile = el('a',{class:'card metric-tile cost-tile',href:'/usage?range=today'},el('span',{class:'k',text:'今日参考费用 · USD'}),metricValue(today ? formatUSD(today.cost_usd) : null),
    el('span',{class:'s'},'累计 ',inline(cumulativeCost),' · 不从钱包扣费'));
  const requestTile = el('a',{class:'card metric-tile request-tile',href:'/usage?range=1d'},el('span',{class:'k',text:'近 24 小时请求'}),metricValue(recent ? number(recent.requests) : null),
    el('span',{class:recent && finite(recent.errors) ? 's warn' : 's'},`失败 ${recent ? number(recent.errors) : '—'} · 累计 `,inline(cumulativeRequests)));
  const cacheTile = el('a',{class:'card metric-tile cache-tile',href:'/usage?range=1d'},el('div',{},el('span',{class:'k',text:'缓存命中率'}),metricValue(hit),
    el('span',{class:'s',text:`近 24 小时 · 命中 ${recent ? formatTokens(recent.cache_read_input_tokens) : '—'}`})),ring);
  const qualityCard = el('section',{class:'card quality-card'},el('div',{class:'card-head'},el('div',{},el('h2',{text:'请求质量'}),el('p',{text:'失败、未知用量和耗时'}))),el('div',{class:'card-body'},el('dl',{class:'facts'},metricPair('失败请求',usageKnown ? number(usage.errors) : null),metricPair('未知用量',usageKnown ? number(usage.unknown_usage) : null),metricPair('平均耗时',usageKnown ? formatDuration(usage.average_duration_ms) : null),metricPair('首 Token',usageKnown ? (finite(usage.average_first_token_ms) === null ? '未记录' : formatDuration(usage.average_first_token_ms)) : null))));
  root.append(el('div',{class:'home-grid'},usageCard,walletTile,costTile,requestTile,cacheTile,qualityCard,accountsCard(grants,devices,pending,previewing),reliable && grants.length ? deviceTip() : null));
  return root;
}
// A summary value inside running text; unknown values keep the shared unknown marker.
function inline(value) {
  const item = shown(value);
  return el('span',{class:item.className || null,text:item.text});
}
function accountsCard(grants, devices, pending, previewing) {
  const head = el('div',{class:'card-head'},el('div',{},el('h2',{text:'我的账号'}),el('p',{text:'每个账号最多绑定 1 台设备'})),el('a',{class:'chip',href:'/accounts',text:'查看'}));
  let body;
  if (previewing || pending.has('customer_not_provisioned')) body = el('p',{class:'inline-info',text:'管理员分配账号后，会显示在这里。'});
  else if (pending.has('grants_unavailable') || pending.has('core_unavailable') || pending.has('customer_sync_pending')) body = el('p',{class:'inline-info',text:'账号数据暂不可用。'});
  else if (!grants.length) body = el('p',{class:'inline-info',text:'尚未分配账号。'});
  else body = el('ul',{class:'account-rows'},grants.slice(0,3).map(grant => {
    const device = devices.find(item => item.current_grant_id === grant.id);
    return el('li',{},el('span',{class:grant.status && grant.status !== 'active' ? 'status-dot off' : 'status-dot','aria-hidden':'true'}),
      el('div',{},el('strong',{text:grant.name || '未命名账号'}),el('span',{text:[device ? `${device.name || '未命名设备'} 在用` : '没有设备在用', grant.expires_at ? `${date(grant.expires_at)} 到期` : ''].filter(Boolean).join(' · ')})));
  }));
  return el('section',{class:'card accounts-card'},head,el('div',{class:'card-body'},body));
}
function deviceTip() {
  return el('section',{class:'card tip-card'},el('div',{class:'card-head'},el('div',{},el('h2',{text:'在另一台电脑上使用？'}),el('p',{text:'先在旧设备上撤销连接，再在新电脑运行登录命令。'}))),
    el('div',{class:'card-body'},commandBlock('登录命令',loginCommand())));
}
