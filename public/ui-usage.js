import { el } from './dom.js';
import { api, collection } from './api.js';
import { number, finite, formatTokens, formatUSD, formatDuration, tokenParts, shown } from './format.js';
import { field } from './ui-form.js';
import { render } from './app.js';
export function metricPair(label, value) {
  const item = shown(value);
  return el('div',{},el('dt',{text:label}),el('dd',{class:item.className,text:item.text}));
}
export function metricValue(value) {
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
export function recordStats(usage, label) {
  const known = !!usage;
  const parts = tokenParts(known ? usage : null);
  const errors = known ? finite(usage.errors) : null;
  return el('section',{class:'stat-strip','aria-label':'当前筛选范围的统计'},
    el('div',{class:'stat-cell'},el('span',{class:'k',text:'费用'}),metricValue(known ? formatUSD(usage.cost_usd) : null),el('span',{class:'s',text:`${label ? label + ' · ' : ''}按价格表估算，不从钱包扣费`})),
    el('div',{class:'stat-cell'},el('span',{class:'k',text:'请求'}),metricValue(known ? number(usage.requests) : null),el('span',{class:errors ? 's warn' : 's',text:`失败 ${errors === null ? '—' : number(errors)} 次`})),
    el('div',{class:'stat-cell'},el('span',{class:'k',text:'Token'}),metricValue(parts.total === null ? null : formatTokens(parts.total)),tokenBar(known ? usage : null),tokenLegend(known ? usage : null),finite(usage?.unknown_usage) ? el('span',{class:'s',text:`${number(usage.unknown_usage)} 次用量未知，未计入 Token`}) : null),
    el('div',{class:'stat-cell'},el('span',{class:'k',text:'平均耗时'}),metricValue(known ? formatDuration(usage.average_duration_ms) : null),el('span',{class:'s',text:`首 Token ${known && finite(usage.average_first_token_ms) !== null ? formatDuration(usage.average_first_token_ms) : '未记录'}`})));
}
const chartState = {range:'1d', metric:'requests', gran:'hour', mode:'bar', model:'', from:'', to:'', loaded:null};
const chartColorCount = 7; // Series use the --chart-1 … --chart-7 tokens.
export function chartWindow() {
  const now = new Date();
  if (chartState.range === 'custom') {
    if (!chartState.from || !chartState.to || chartState.from > chartState.to) return null;
    return {from:new Date(`${chartState.from}T00:00:00`), to:new Date(`${chartState.to}T23:59:59.999`)};
  }
  const ms = {'1d':86400000,'7d':7*86400000,'14d':14*86400000,'30d':30*86400000}[chartState.range] || 86400000;
  return {from:new Date(now.getTime() - ms), to:now};
}
export function chartScope() {
  if (chartState.range === 'custom') return chartState.from && chartState.to ? `${chartState.from} 至 ${chartState.to} · 按本机时区显示` : '选择自定义时间 · 按本机时区显示';
  return `最近 ${{'1d':'1 天','7d':'7 天','14d':'14 天','30d':'30 天'}[chartState.range] || '1 天'} · 按本机时区显示`;
}
export function chartRangeControl() {
  return el('div',{class:'seg',role:'group','aria-label':'时间范围'},[['1d','1天'],['7d','7天'],['14d','14天'],['30d','30天'],['custom','自定义']].map(([id,label]) => el('button',{type:'button',class:chartState.range === id ? 'on' : '','aria-pressed':chartState.range === id ? 'true' : 'false',text:label,onclick:() => { chartState.range = id; if (id !== 'custom') { chartState.gran = id === '1d' || id === '7d' ? 'hour' : 'day'; chartState.loaded = null; } render(); }})));
}
export function chartFilters(chart) {
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
export async function loadChartRows(from, to) {
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
export function usagePlot(chart) {
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
  const step = plotW / keys.length, barW = Math.max(2, Math.min(step * 0.5, 18)), radius = Math.min(4, barW / 2);
  const colors = seriesNames.map((_,index) => `var(--chart-${index % chartColorCount + 1})`);
  const shapes = [];
  if (chartState.mode === 'area') {
    let base = keys.map(() => y0 + plotH);
    series.forEach((values,index) => {
      const top = values.map((value,item) => base[item] - value / max * plotH);
      const points = [...top.map((y,item) => `${x0 + item * step + step / 2},${y}`), ...[...base].reverse().map((y,item) => `${x0 + (keys.length - 1 - item) * step + step / 2},${y}`)];
      shapes.push(svgEl('polygon',{points:points.join(' '),style:`fill:${colors[index]}`,'fill-opacity':'0.88'}));
      base = top;
    });
  } else {
    keys.forEach((_,index) => {
      let y = y0 + plotH;
      series.forEach((values,seriesIndex) => {
        const h = values[index] / max * plotH;
        y -= h;
        if (h > 0) shapes.push(svgEl('rect',{x:x0 + index * step + (step - barW) / 2,y,width:barW,height:Math.max(h,1),rx:radius,style:`fill:${colors[seriesIndex]}`}));
      });
    });
  }
  const labelStep = Math.max(1, Math.ceil(keys.length / 8));
  const spanDays = keys.length > 1 ? (keys[keys.length - 1] - keys[0]) / 86400000 : 0;
  const labels = keys.flatMap((key,index) => index % labelStep ? [] : [svgEl('text',{x:x0 + index * step + step / 2,y:height - 8,'text-anchor':'middle',class:'chart-label'},bucketText(key,gran,spanDays))]);
  const axis = [svgEl('line',{x1:x0,x2:x0 + plotW,y1:y0,y2:y0,class:'chart-grid'}),svgEl('line',{x1:x0,x2:x0 + plotW,y1:y0 + plotH / 2,y2:y0 + plotH / 2,class:'chart-grid'}),svgEl('text',{x:x0 - 8,y:y0 + 10,'text-anchor':'end',class:'chart-label'},metric === 'hit_rate' ? '100%' : formatTokens(max)),svgEl('text',{x:x0 - 8,y:y0 + plotH,'text-anchor':'end',class:'chart-label'},metric === 'hit_rate' ? '0%' : '0'),svgEl('line',{x1:x0,x2:x0 + plotW,y1:y0 + plotH,y2:y0 + plotH,class:'chart-axis'})];
  return el('div',{class:'usage-plot'},svgEl('svg',{viewBox:`0 0 ${width} ${height}`,role:'img','aria-label':chartScope()},axis,shapes,labels),el('div',{class:'chart-legend'},seriesNames.map((name,index) => el('span',{},el('i',{style:`background:${colors[index]}`}),name))));
}
