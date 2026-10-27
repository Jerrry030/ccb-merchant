import { validateProviderConfig } from './payment-providers.js';
import { HttpError, fields, text } from './security.js';
import { normalizePaymentCatalog, parsePaymentCatalog, describePaymentCatalog } from '../public/payment-catalog.js';

export function defaultPaymentSettings(config) {
  return {
    revision: 1, enabled: true, recharge_enabled: true,
    min_amount_minor: config.paymentMin ?? 100, max_amount_minor: config.paymentMax ?? 1000000,
    daily_limit_minor: 0, max_pending_orders: 5, order_timeout_minutes: 60,
    product_name: '账户充值', help_text: '', ...normalizePaymentCatalog(null),
  };
}

export function readPaymentSettings(config, store) {
  const value = JSON.parse(store.db.prepare("SELECT value FROM settings WHERE key='payment'").get().value);
  if (config.stripe) value.providers.stripe = { ...value.providers.stripe, secret_key: config.stripe.secret, webhook_secret: config.stripe.webhookSecret };
  return value;
}

export function describePayment(config, store) {
  const value = readPaymentSettings(config, store);
  const catalog = describePaymentCatalog(value);
  const available = value.enabled && catalog.methods.some(method => method.offered);
  const { methods, providers, ...rules } = value;
  return {
    ...rules, configured: Boolean(available), currency: 'CNY',
    methods: catalog.methods.map(method => ({ ...method, offered: value.enabled && method.offered, reason: !value.enabled ? 'payment_disabled' : method.reason })),
    providers: catalog.providers.map(provider => ({
      ...provider, editable: !(provider.id === 'stripe' && config.stripe),
      source: provider.id === 'stripe' && config.stripe ? 'environment' : 'settings',
      live: provider.id === 'stripe' && providers.stripe.secret_key ? providers.stripe.secret_key.startsWith('sk_live_') : null,
      webhook_url: config.publicOrigin + '/api/webhooks/' + provider.id,
    })),
  };
}

export function applyPaymentUpdate(config, store, input) {
  fields(input, ['expected_revision', 'enabled', 'recharge_enabled', 'min_amount_minor', 'max_amount_minor', 'daily_limit_minor', 'max_pending_orders', 'order_timeout_minutes', 'product_name', 'help_text', 'methods', 'providers'], ['expected_revision']);
  const current = readPaymentSettings(config, store);
  if (input.expected_revision !== current.revision) throw new HttpError(409, 'settings_changed', 'Configuration changed; reload before saving.');
  const next = { ...current };
  for (const key of ['enabled', 'recharge_enabled']) if (input[key] !== undefined) {
    if (typeof input[key] !== 'boolean') throw new HttpError(400, 'invalid_input', 'Invalid payment switch.');
    next[key] = input[key];
  }
  for (const [key, min, max] of [['min_amount_minor',1,100000000],['max_amount_minor',1,100000000],['daily_limit_minor',0,10000000000],['max_pending_orders',1,100],['order_timeout_minutes',30,1440]]) if (input[key] !== undefined) {
    if (!Number.isSafeInteger(input[key]) || input[key] < min || input[key] > max) throw new HttpError(400, 'invalid_input', 'Payment limit outside allowed range.');
    next[key] = input[key];
  }
  if (next.min_amount_minor > next.max_amount_minor || (next.daily_limit_minor && next.daily_limit_minor < next.min_amount_minor)) throw new HttpError(400, 'invalid_input', 'Payment amount limits conflict.');
  if (input.product_name !== undefined) next.product_name = text(input.product_name, 'product name', 80);
  if (input.help_text !== undefined) {
    if (typeof input.help_text !== 'string' || input.help_text.length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.help_text)) throw new HttpError(400, 'invalid_input', 'Invalid payment help.');
    next.help_text = input.help_text.replaceAll('\r\n', '\n').trim();
  }
  const stripeInput = input.providers?.stripe;
  if (config.stripe && stripeInput && Object.keys(stripeInput).some(key => key !== 'enabled')) throw new HttpError(409, 'integration_environment_managed', 'Stripe credentials are managed by the environment.');
  const parsed = parsePaymentCatalog(current, { ...(input.methods !== undefined ? { methods: input.methods } : {}), ...(input.providers !== undefined ? { providers: input.providers } : {}) });
  if (!parsed.ok) throw new HttpError(400, 'invalid_input', parsed.message);
  Object.assign(next, parsed.value);
  for(const [id,provider] of Object.entries(next.providers)) {
    if(provider.enabled)validateProviderConfig(id,provider);
    const {enabled:oldEnabled,...before}=current.providers[id],{enabled:newEnabled,...after}=provider;
    if(JSON.stringify(before)!==JSON.stringify(after)&&store.db.prepare("SELECT count(*) AS n FROM orders WHERE provider=? AND status IN ('creating','pending','unknown')").get(id).n)throw new HttpError(409,'payment_pending','Pending orders must finish before changing this provider configuration.');
  }
  // Environment credentials are effective-only, never copied into the settings database.
  if (config.stripe) {
    const stored = JSON.parse(store.db.prepare("SELECT value FROM settings WHERE key='payment'").get().value);
    next.providers.stripe = { ...stored.providers.stripe, enabled: next.providers.stripe.enabled };
  }
  next.revision++;
  return next;
}
