/** Merchant payment-method catalog. Credentials can be saved for every channel.
 *  Only a provider marked collectable may be offered at checkout. None of the
 *  channels in this catalog collect money yet; Stripe remains a separate collector.
 */

export const paymentMethods = {
  alipay: {
    title: '支付宝',
    sources: [
      { id: 'official_alipay', label: '支付宝官方', provider: 'alipay' },
      { id: 'easypay_alipay', label: '易支付支付宝', provider: 'easypay' },
      { id: 'suixingpay_alipay', label: '随行付支付宝', provider: 'suixingpay' },
    ],
  },
  wxpay: {
    title: '微信支付',
    sources: [
      { id: 'official_wxpay', label: '微信官方', provider: 'wxpay' },
      { id: 'easypay_wxpay', label: '易支付微信', provider: 'easypay' },
      { id: 'suixingpay_wxpay', label: '随行付微信', provider: 'suixingpay' },
    ],
  },
};

const currencies = ['CNY', 'HKD', 'USD', 'EUR', 'GBP', 'AUD', 'CAD', 'SGD', 'JPY', 'KRW', 'NZD'].map(value => ({ value, label: value }));

export const paymentProviders = {
  alipay: {
    title: '支付宝官方',
    collectable: false,
    fields: [
      { key: 'app_id', label: 'App ID', sensitive: false, required: true, kind: 'token' },
      { key: 'private_key', label: '应用私钥', sensitive: true, required: true, kind: 'pem' },
      { key: 'public_key', label: '公钥', sensitive: true, required: true, kind: 'pem', hint: '填写开放平台应用公钥，或平台给出的验签公钥。' },
    ],
  },
  wxpay: {
    title: '微信官方',
    collectable: false,
    fields: [
      { key: 'app_id', label: 'App ID', sensitive: false, required: true, kind: 'token' },
      { key: 'mch_id', label: '商户号', sensitive: false, required: true, kind: 'token' },
      { key: 'private_key', label: '私钥', sensitive: true, required: true, kind: 'pem' },
      { key: 'api_v3_key', label: 'API v3 密钥', sensitive: true, required: true, kind: 'secret' },
      { key: 'cert_serial', label: '证书序列号', sensitive: false, required: true, kind: 'token' },
      { key: 'public_key', label: '公钥', sensitive: true, required: true, kind: 'pem' },
      { key: 'public_key_id', label: '公钥 ID', sensitive: false, required: true, kind: 'token' },
    ],
  },
  easypay: {
    title: '易支付',
    collectable: false,
    fields: [
      { key: 'pid', label: 'PID', sensitive: false, required: true, kind: 'token' },
      { key: 'pkey', label: 'PKey', sensitive: true, required: true, kind: 'secret' },
      { key: 'api_base', label: 'API 基础地址', sensitive: false, required: true, kind: 'https' },
      { key: 'cid_alipay', label: '支付宝渠道 ID', sensitive: false, required: false, kind: 'token' },
      { key: 'cid_wxpay', label: '微信渠道 ID', sensitive: false, required: false, kind: 'token' },
    ],
  },
  suixingpay: {
    title: '随行付',
    collectable: false,
    fields: [
      { key: 'api_base', label: 'API 基础地址', sensitive: false, required: true, kind: 'https', hint: '填写商户获配的 HTTPS API 地址，测试和生产环境必须与密钥一致。' },
      { key: 'org_id', label: '机构编号', sensitive: false, required: true, kind: 'token' },
      { key: 'mch_id', label: '商户号', sensitive: false, required: true, kind: 'token' },
      { key: 'terminal_ip', label: '终端 IP', sensitive: false, required: true, kind: 'ipv4' },
      { key: 'private_key', label: '商户私钥', sensitive: true, required: true, kind: 'pem' },
      { key: 'public_key', label: '平台公钥', sensitive: true, required: true, kind: 'pem' },
      { key: 'sign_type', label: '签名方式', sensitive: false, required: true, kind: 'enum', defaultValue: 'RSA', options: [{ value: 'RSA', label: 'RSA (SHA-1)' }, { value: 'RSA2', label: 'RSA2 (SHA-256)' }], hint: '默认 RSA。只有商户协议明确要求时选择 RSA2。' },
      { key: 'order_path', label: '下单接口路径', sensitive: false, required: true, kind: 'path', defaultValue: '/order/activePlusScan' },
      { key: 'query_path', label: '查单接口路径', sensitive: false, required: true, kind: 'path', defaultValue: '/query/tradeQuery' },
    ],
  },
  airwallex: {
    title: 'Airwallex',
    collectable: false,
    fields: [
      { key: 'client_id', label: 'Client ID', sensitive: false, required: true, kind: 'token' },
      { key: 'api_key', label: 'API Key', sensitive: true, required: true, kind: 'secret' },
      { key: 'webhook_secret', label: 'Webhook 密钥', sensitive: true, required: true, kind: 'secret' },
      { key: 'api_base', label: 'API 基础地址', sensitive: false, required: true, kind: 'https', defaultValue: 'https://api.airwallex.com/api/v1', hint: '必须和 API Key 所属环境一致。沙箱使用 https://api-demo.airwallex.com/api/v1。' },
      { key: 'country_code', label: '国家/地区代码', sensitive: false, required: true, kind: 'country', defaultValue: 'CN' },
      { key: 'currency', label: '支付币种', sensitive: false, required: true, kind: 'enum', defaultValue: 'CNY', options: currencies, hint: '这里只保存渠道配置。本站订单结算币种仍是 CNY。' },
      { key: 'account_id', label: '账户 ID', sensitive: false, required: false, kind: 'token', hint: '不涉及多账户时可以不填。' },
    ],
  },
};

function fail(message) {
  const error = new Error(message);
  error.catalog = true;
  throw error;
}

function sameKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => actual.includes(key));
}

function cleanPresented(field, value, label) {
  if (typeof value !== 'string') fail(`${label}无效。`);
  const trimmed = field.kind === 'pem' ? value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim() : value.trim();
  if (!trimmed) return field.defaultValue || '';
  if (field.kind === 'token') {
    if (!/^[\x21-\x7e]{1,200}$/.test(trimmed)) fail(`${label}无效。`);
    return trimmed;
  }
  if (field.kind === 'secret') {
    if (!/^[\x21-\x7e]{8,500}$/.test(trimmed)) fail(`${label}无效。`);
    return trimmed;
  }
  if (field.kind === 'pem') {
    if (trimmed.length < 16 || trimmed.length > 8000 || /[^\n\x20-\x7e]/.test(trimmed)) fail(`${label}无效。`);
    return trimmed;
  }
  if (field.kind === 'https') {
    let url;
    try { url = new URL(trimmed); } catch { fail(`${label}必须是 HTTPS 地址。`); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) fail(`${label}必须是不含账号和查询参数的 HTTPS 地址。`);
    const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
    const stored = `${url.origin}${path}`;
    if (stored.length > 300) fail(`${label}过长。`);
    return stored;
  }
  if (field.kind === 'ipv4') {
    const parts = trimmed.split('.');
    if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) fail(`${label}必须是 IPv4 地址。`);
    return trimmed;
  }
  if (field.kind === 'country') {
    if (!/^[A-Z]{2}$/.test(trimmed)) fail(`${label}必须是两位大写国家或地区代码。`);
    return trimmed;
  }
  if (field.kind === 'path') {
    if (!/^\/[A-Za-z0-9._~/-]{1,120}$/.test(trimmed) || trimmed.includes('//')) fail(`${label}必须是以 / 开头的接口路径。`);
    return trimmed;
  }
  if (field.kind === 'enum') {
    if (!field.options?.some(option => option.value === trimmed)) fail(`${label}不在可选范围内。`);
    return trimmed;
  }
  fail(`${label}无效。`);
}

function fieldsReady(provider, stored) {
  return provider.fields.every(field => !field.required || stored[field.key]);
}

export function emptyPaymentCatalog() {
  return normalizePaymentCatalog(null);
}

export function normalizePaymentCatalog(value) {
  const methods = {};
  for (const [id, method] of Object.entries(paymentMethods)) {
    const stored = value?.methods?.[id];
    const source = method.sources.some(item => item.id === stored?.source) ? stored.source : '';
    methods[id] = { enabled: stored?.enabled === true, source };
  }
  const providers = {};
  for (const [id, provider] of Object.entries(paymentProviders)) {
    const stored = value?.providers?.[id];
    const next = { enabled: stored?.enabled === true };
    for (const field of provider.fields) {
      let accepted = '';
      if (typeof stored?.[field.key] === 'string' && stored[field.key]) {
        try { accepted = cleanPresented(field, stored[field.key], field.label); } catch { accepted = ''; }
      }
      next[field.key] = accepted || field.defaultValue || '';
    }
    providers[id] = next;
  }
  return { methods, providers };
}

export function parsePaymentCatalog(current, input) {
  try {
    const stored = normalizePaymentCatalog(current);
    if (!sameKeys(input, ['methods', 'providers'])) fail('支付方式配置不完整。');
    if (!sameKeys(input.methods, Object.keys(paymentMethods))) fail('支付方式配置不完整。');
    if (!sameKeys(input.providers, Object.keys(paymentProviders))) fail('支付渠道配置不完整。');
    const methods = {};
    const providers = {};
    for (const [id, provider] of Object.entries(paymentProviders)) {
      const raw = input.providers[id];
      const allowed = ['enabled', 'clear_secrets', ...provider.fields.map(field => field.key)];
      if (!sameKeys(raw, allowed)) fail(`${provider.title}包含无法识别的配置项。`);
      if (typeof raw.enabled !== 'boolean' || typeof raw.clear_secrets !== 'boolean') fail(`${provider.title}的开关必须是布尔值。`);
      if (raw.enabled && raw.clear_secrets) fail(`不能在启用${provider.title}时清除密钥。`);
      const next = { enabled: raw.enabled };
      for (const field of provider.fields) {
        const label = `${provider.title}的${field.label}`;
        if (field.sensitive) {
          const incoming = raw[field.key];
          if (typeof incoming !== 'string') fail(`${label}无效。`);
          if (incoming.trim() === '') {
            if (incoming !== '') fail(`${label}无效。`);
            next[field.key] = stored.providers[id][field.key] || '';
          } else next[field.key] = cleanPresented(field, incoming, label);
        } else next[field.key] = cleanPresented(field, raw[field.key], label);
      }
      if (raw.clear_secrets) for (const field of provider.fields) if (field.sensitive) next[field.key] = '';
      if (next.enabled && !fieldsReady(provider, next)) fail(`${provider.title}已启用，请先填齐必填凭据。`);
      providers[id] = next;
    }
    for (const [id, method] of Object.entries(paymentMethods)) {
      const raw = input.methods[id];
      if (!sameKeys(raw, ['enabled', 'source'])) fail(`${method.title}配置不完整。`);
      if (typeof raw.enabled !== 'boolean' || typeof raw.source !== 'string') fail(`${method.title}配置无效。`);
      const source = raw.source.trim();
      const selected = method.sources.find(item => item.id === source);
      if (source && !selected) fail(`${method.title}的支付来源无效。`);
      if (raw.enabled && !selected) fail(`${method.title}已启用，请先选择支付来源。`);
      if (raw.enabled) {
        const provider = paymentProviders[selected.provider];
        if (!providers[selected.provider].enabled || !fieldsReady(provider, providers[selected.provider])) fail(`${method.title}所选来源尚未启用或凭据不完整。`);
      }
      methods[id] = { enabled: raw.enabled, source: selected ? selected.id : '' };
    }
    return { ok: true, value: { methods, providers } };
  } catch (error) {
    if (error?.catalog) return { ok: false, message: error.message };
    throw error;
  }
}

export function describePaymentCatalog(value) {
  const catalog = normalizePaymentCatalog(value);
  const providerReady = id => catalog.providers[id].enabled && fieldsReady(paymentProviders[id], catalog.providers[id]);
  return {
    methods: Object.entries(paymentMethods).map(([id, method]) => {
      const stored = catalog.methods[id];
      const selected = method.sources.find(item => item.id === stored.source) || null;
      const ready = Boolean(selected && providerReady(selected.provider));
      let reason = 'disabled';
      if (stored.enabled && !selected) reason = 'source_missing';
      else if (stored.enabled && !ready) reason = 'credentials_missing';
      else if (stored.enabled && !paymentProviders[selected.provider].collectable) reason = 'not_collectable';
      else if (stored.enabled) reason = null;
      return {
        id, title: method.title, enabled: stored.enabled, source: stored.source, offered: reason === null, reason,
        sources: method.sources.map(item => ({ id: item.id, label: item.label, provider: item.provider, collectable: paymentProviders[item.provider].collectable, ready: providerReady(item.provider) })),
      };
    }),
    providers: Object.entries(paymentProviders).map(([id, provider]) => ({
      id, title: provider.title, enabled: catalog.providers[id].enabled, collectable: provider.collectable, ready: providerReady(id),
      fields: provider.fields.map(field => ({
        key: field.key, label: field.label, sensitive: field.sensitive, required: field.required === true, hint: field.hint || '',
        options: field.options || null,
        ...(field.sensitive ? { configured: Boolean(catalog.providers[id][field.key]) } : { value: catalog.providers[id][field.key] || '' }),
      })),
    })),
  };
}
