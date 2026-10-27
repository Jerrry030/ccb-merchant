/** Token and reference-cost rows for a usage record. Never invents prices. */
function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonNegative(value) {
  const n = finiteNumber(value);
  return n !== null && n >= 0 ? n : null;
}

function cacheCreationTotal(write, five, hour) {
  if (write !== null) return write;
  if (five !== null && hour !== null) return five + hour;
  return null;
}

function cacheTokenRows(write, five, hour) {
  const rows = [];
  const fiveValue = five > 0 ? five : 0;
  const hourValue = hour > 0 ? hour : 0;
  const bothKnown = five !== null && hour !== null;
  if (bothKnown && (write === null || fiveValue + hourValue <= write)) {
    if (five > 0) rows.push({ label: '缓存创建', tokens: five, tag: '5m' });
    if (hour > 0) rows.push({ label: '缓存创建', tokens: hour, tag: '1h' });
    if (write !== null && write > fiveValue + hourValue) rows.push({ label: '缓存创建', tokens: write - fiveValue - hourValue });
    return rows;
  }
  if (write > 0) rows.push({ label: '缓存创建', tokens: write });
  else if (five > 0) rows.push({ label: '缓存创建', tokens: five, tag: '5m' });
  else if (hour > 0) rows.push({ label: '缓存创建', tokens: hour, tag: '1h' });
  return rows;
}

export function usageDetail(row) {
  const usage = row?.usage && typeof row.usage === 'object' ? row.usage : {};
  const input = nonNegative(usage.input_tokens);
  const output = nonNegative(usage.output_tokens);
  const read = nonNegative(usage.cache_read_input_tokens);
  const write = nonNegative(usage.cache_creation_input_tokens);
  const five = nonNegative(usage.cache_creation_5m);
  const hour = nonNegative(usage.cache_creation_1h);
  const tokens = [];
  if (input > 0) tokens.push({ label: '输入 Token', tokens: input });
  if (output > 0) tokens.push({ label: '输出 Token', tokens: output });
  tokens.push(...cacheTokenRows(write, five, hour));
  if (read > 0) tokens.push({ label: '缓存读取 Token', tokens: read });
  const creation = cacheCreationTotal(write, five, hour);
  const parts = [input, output, read, creation];
  const totalTokens = parts.every(value => value !== null) ? parts.reduce((sum, value) => sum + value, 0) : null;
  const cost = finiteNumber(row?.cost_usd);
  return { tokens, totalTokens, cost };
}
