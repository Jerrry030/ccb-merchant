/** Supported checkout methods and their server-side provider configuration. */

export const paymentMethods = {
  stripe: { title: 'Stripe 收银台', sources: [{ id: 'stripe_checkout', label: 'Stripe Checkout', provider: 'stripe' }] },
  airwallex: { title: 'Airwallex', sources: [{ id: 'airwallex_checkout', label: 'Airwallex', provider: 'airwallex' }] },
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
  stripe: {
    title: 'Stripe',
    fields: [
      { key: 'secret_key', label: '服务端密钥', sensitive: true, required: true, kind: 'stripe_key', hint: 'sk_test_ 为测试环境，sk_live_ 为正式环境。' },
      { key: 'webhook_secret', label: 'Webhook 签名密钥', sensitive: true, required: true, kind: 'stripe_webhook', hint: '使用该回调端点的 whsec_ 密钥；不是 API 密钥。' },
    ],
  },
  alipay: {
    title: '支付宝官方',

    fields: [
      { key: 'app_id', label: 'App ID', sensitive: false, required: true, kind: 'token' },
      { key: 'private_key', label: '应用私钥', sensitive: true, required: true, kind: 'pem' },
      { key: 'public_key', label: '支付宝公钥', sensitive: true, required: true, kind: 'pem', hint: '用于验证支付宝响应，必须填写支付宝公钥，不是应用公钥。' },
    ],
  },
  wxpay: {
    title: '微信官方',

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

    fields: [
      { key: 'api_base', label: 'API 基础地址', sensitive: false, required: true, kind: 'https', hint: '填写商户获配的 HTTPS API 地址，测试和生产环境必须与密钥一致。' },
      { key: 'org_id', label: '机构编号', sensitive: false, required: true, kind: 'token' },
      { key: 'mch_id', label: '商户号', sensitive: false, required: true, kind: 'token' },
      { key: 'terminal_ip', label: '终端 IP', sensitive: false, required: true, kind: 'ipv4' },
      { key: 'private_key', label: '商户私钥', sensitive: true, required: true, kind: 'pem', hint: '支持 PEM 或 Base64 的 PKCS#1 / PKCS#8 RSA 私钥。兼容随行付既有 1024 位商户密钥；新密钥建议使用 2048 位及以上。' },
      { key: 'public_key', label: '平台公钥', sensitive: true, required: true, kind: 'pem', hint: '填写随行付平台提供的 RSA 验签公钥，至少 2048 位；不是商户自身的公钥。' },
      { key: 'sign_type', label: '签名方式', sensitive: false, required: true, kind: 'enum', defaultValue: 'RSA', options: [{ value: 'RSA', label: 'RSA (SHA-1)' }, { value: 'RSA2', label: 'RSA2 (SHA-256)' }], hint: '默认 RSA。只有商户协议明确要求时选择 RSA2。' },
      { key: 'order_path', label: '下单接口路径', sensitive: false, required: true, kind: 'path', defaultValue: '/order/activePlusScan' },
      { key: 'query_path', label: '查单接口路径', sensitive: false, required: true, kind: 'path', defaultValue: '/query/tradeQuery' },
    ],
  },
  airwallex: {
    title: 'Airwallex',

    fields: [
      { key: 'client_id', label: 'Client ID', sensitive: false, required: true, kind: 'token' },
      { key: 'api_key', label: 'API Key', sensitive: true, required: true, kind: 'secret' },
      { key: 'webhook_secret', label: 'Webhook 密钥', sensitive: true, required: true, kind: 'secret' },
      { key: 'api_base', label: 'API 基础地址', sensitive: false, required: true, kind: 'https', defaultValue: 'https://api.airwallex.com/api/v1', hint: '必须和 API Key 所属环境一致。沙箱使用 https://api-demo.airwallex.com/api/v1。' },
      { key: 'country_code', label: '国家/地区代码', sensitive: false, required: true, kind: 'country', defaultValue: 'CN' },
      { key: 'currency', label: '支付币种', sensitive: false, required: true, kind: 'enum', defaultValue: 'CNY', options: currencies, hint: '本站按 CNY 结算，启用此渠道时请选择 CNY。' },
      { key: 'account_id', label: '账户 ID', sensitive: false, required: false, kind: 'token', hint: '不涉及多账户时可以不填。' },
    ],
  },
};

function fail(message) {
  const error = new Error(message);
  error.catalog = true;
  throw error;
}

function cleanPresented(field, value, label) {
  if (typeof value !== 'string') fail(`${label}无效。`);
  const trimmed = field.kind === 'pem' ? value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim() : value.trim();
  if (!trimmed) return field.defaultValue || '';
  if (field.kind === 'token') {
    if (!/^[\x21-\x7e]{1,200}$/.test(trimmed)) fail(`${label}无效。`);
    return trimmed;
  }
  if (field.kind === 'stripe_key' || field.kind === 'stripe_webhook') {
    const pattern = field.kind === 'stripe_key' ? /^sk_(test|live)_[A-Za-z0-9_]+$/ : /^whsec_[A-Za-z0-9_]+$/;
    if (!pattern.test(trimmed) || trimmed.length > 500) fail(`${label}格式无效。`);
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
    const value = normalizePaymentCatalog(current);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['methods', 'providers'].includes(key))) fail('支付配置包含无法识别的字段。');
    for (const [collection, definitions] of [['providers', paymentProviders], ['methods', paymentMethods]]) {
      if (input[collection] === undefined) continue;
      const changes = input[collection];
      if (!changes || typeof changes !== 'object' || Array.isArray(changes) || Object.keys(changes).some(id => !Object.hasOwn(definitions, id))) fail('支付渠道或方式无效。');
      for (const [id, raw] of Object.entries(changes)) {
        const definition = definitions[id];
        const allowed = collection === 'providers' ? ['enabled', 'clear_secrets', ...definition.fields.map(field => field.key)] : ['enabled', 'source'];
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !allowed.includes(key))) fail(definition.title + '包含无法识别的配置项。');
        const next = { ...value[collection][id] };
        if (raw.enabled !== undefined) {
          if (typeof raw.enabled !== 'boolean') fail(definition.title + '的开关必须是布尔值。');
          next.enabled = raw.enabled;
        }
        if (collection === 'providers') {
          if (raw.clear_secrets !== undefined && typeof raw.clear_secrets !== 'boolean') fail('清除密钥必须是布尔值。');
          if (raw.clear_secrets && next.enabled) fail('必须先停用渠道才能清除密钥。');
          for (const field of definition.fields) {
            if (raw[field.key] === undefined || (field.sensitive && raw[field.key] === '')) continue;
            if (field.sensitive && typeof raw[field.key] === 'string' && !raw[field.key].trim()) fail(field.label + '无效。');
            next[field.key] = cleanPresented(field, raw[field.key], definition.title + '的' + field.label);
          }
          if (raw.clear_secrets) for (const field of definition.fields) if (field.sensitive) next[field.key] = '';
          if (next.enabled && !fieldsReady(definition, next)) fail(definition.title + '已启用，请先填齐必填凭据。');
        } else if (raw.source !== undefined) {
          if (typeof raw.source !== 'string' || (raw.source && !definition.sources.some(source => source.id === raw.source))) fail(definition.title + '的支付来源无效。');
          next.source = raw.source;
        }
        if (collection === 'methods' && next.enabled && !next.source) fail(definition.title + '已启用，请先选择支付来源。');
        value[collection][id] = next;
      }
    }
    return { ok: true, value };
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
      else if (stored.enabled) reason = null;
      return {
        id, title: method.title, enabled: stored.enabled, source: stored.source, offered: reason === null, reason,
        sources: method.sources.map(item => ({ id: item.id, label: item.label, provider: item.provider, ready: providerReady(item.provider) })),
      };
    }),
    providers: Object.entries(paymentProviders).map(([id, provider]) => ({
      id, title: provider.title, enabled: catalog.providers[id].enabled, ready: providerReady(id),
      fields: provider.fields.map(field => ({
        key: field.key, label: field.label, kind: field.kind, sensitive: field.sensitive, required: field.required === true, hint: field.hint || '',
        options: field.options || null,
        ...(field.sensitive ? { configured: Boolean(catalog.providers[id][field.key]) } : { value: catalog.providers[id][field.key] || '' }),
      })),
    })),
  };
}
