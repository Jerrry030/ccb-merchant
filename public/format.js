export function date(value) { if (!value) return '—'; const d = new Date(value); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN',{hour12:false}); }
export function number(value) { return typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2}).format(value) : '—'; }
export function money(value, currency = 'CNY') { return Number.isSafeInteger(value) && currency === 'CNY' ? new Intl.NumberFormat('zh-CN',{style:'currency',currency:'CNY'}).format(value/100) : '—'; }
export function finite(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
export function formatTokens(value) {
  const n = finite(value); if (n === null) return '—';
  const abs = Math.abs(n);
  if (abs >= 1000000) return (n / 1000000).toFixed(2) + 'M';
  if (abs >= 1000) return (n / 1000).toFixed(1) + 'k';
  return new Intl.NumberFormat('zh-CN',{maximumFractionDigits:0}).format(n);
}
export function formatUSD(value) {
  const n = finite(value); if (n === null) return '—';
  const sign = n < 0 ? '-' : ''; const abs = Math.abs(n);
  if (abs === 0) return '$0';
  if (abs < 0.01) return sign + '$' + abs.toFixed(4);
  return sign + '$' + abs.toFixed(2);
}
export function localDay(value) {
  const d = new Date(value);
  if (!value || Number.isNaN(d.getTime())) return '';
  const pad = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}
export function formatDuration(value) {
  const n = finite(value); if (n === null) return '—';
  const whole = Math.round(n);
  if (whole < 1000) return whole + ' ms';
  if (whole < 10000) return (whole / 1000).toFixed(1) + ' s';
  return Math.round(whole / 1000) + ' s';
}
export function formatHit(usage) {
  if (!usage) return '—';
  const input = finite(usage.input_tokens), read = finite(usage.cache_read_input_tokens), write = finite(usage.cache_creation_input_tokens);
  if (input === null || read === null || write === null) return '—';
  const denom = input + read + write;
  return denom > 0 ? (read / denom * 100).toFixed(1) + '%' : '—';
}
export function tokenParts(usage) {
  const specs = [['输入',usage?.input_tokens,'var(--record-input)'],['输出',usage?.output_tokens,'var(--record-output)'],['缓存读',usage?.cache_read_input_tokens,'var(--record-read)'],['缓存写',usage?.cache_creation_input_tokens,'var(--record-write)']];
  const values = specs.map(([,value]) => finite(value));
  const total = values.every(value => value !== null) ? values.reduce((sum,value) => sum + value,0) : null;
  return {total,parts:specs.map(([key,,color],index) => ({key,value:values[index],color,percent:total ? values[index] / total * 100 : 0}))};
}
export function shown(value) {
  const text = value == null || value === '' ? '—' : String(value);
  return {text,className:text === '—' ? 'is-unknown' : ''};
}
export function exactTokens(value) {
  const n = finite(value);
  return n === null ? '—' : new Intl.NumberFormat('zh-CN',{maximumFractionDigits:0}).format(n);
}
export function cacheTokens(value) {
  const n = finite(value);
  if (n === null) return '—';
  if (Math.abs(n) >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1) + 'K';
  return exactTokens(n);
}
export function formatCost(value) {
  const n = finite(value);
  if (n === null) return null;
  return (n < 0 ? '-' : '') + '$' + Math.abs(n).toFixed(6);
}
