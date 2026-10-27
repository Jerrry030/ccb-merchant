import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyPaymentCatalog, parsePaymentCatalog, describePaymentCatalog } from '../../public/payment-catalog.js';
import { fixture, stripeFixture, password } from './fixtures.js';

const credentials = { email: 'admin@example.test', password, display_name: 'Administrator' };
const privateKey = 'catalog-private-key-0123456789';
const publicKey = 'catalog-public-key-0123456789';

function catalogInput(mutate) {
  const current = emptyPaymentCatalog();
  const body = { methods: {}, providers: {} };
  for (const [id, method] of Object.entries(current.methods)) body.methods[id] = { enabled: method.enabled, source: method.source };
  for (const [id, provider] of Object.entries(current.providers)) {
    body.providers[id] = { enabled: provider.enabled, clear_secrets: false };
    for (const [key, value] of Object.entries(provider)) if (key !== 'enabled') body.providers[id][key] = value;
  }
  mutate?.(body);
  return body;
}

test('visible payment methods require a source and complete credentials, and uncollectable channels stay hidden', () => {
  const missingSource = parsePaymentCatalog(null, catalogInput(body => { body.methods.alipay.enabled = true; }));
  assert.equal(missingSource.ok, false);
  assert.match(missingSource.message, /\u8bf7\u5148\u9009\u62e9\u652f\u4ed8\u6765\u6e90/);
  const badSource = parsePaymentCatalog(null, catalogInput(body => { body.methods.wxpay = { enabled: true, source: 'official_alipay' }; }));
  assert.equal(badSource.ok, false);
  const incomplete = parsePaymentCatalog(null, catalogInput(body => {
    body.methods.alipay = { enabled: true, source: 'official_alipay' };
    body.providers.alipay.enabled = true;
  }));
  assert.equal(incomplete.ok, false);
  assert.match(incomplete.message, /\u51ed\u636e/);
  const httpBase = catalogInput(body => { body.providers.easypay.api_base = 'http://pay.example.test'; });
  assert.equal(parsePaymentCatalog(null, httpBase).ok, false);
  const enabledClear = catalogInput(body => { body.providers.alipay.enabled = true; body.providers.alipay.clear_secrets = true; body.providers.alipay.app_id = '2021000000000001'; body.providers.alipay.private_key = privateKey; body.providers.alipay.public_key = publicKey; });
  assert.equal(parsePaymentCatalog(null, enabledClear).ok, false);
  const saved = parsePaymentCatalog(null, catalogInput(body => {
    body.methods.alipay = { enabled: true, source: 'official_alipay' };
    body.providers.alipay.enabled = true;
    body.providers.alipay.app_id = '2021000000000001';
    body.providers.alipay.private_key = privateKey;
    body.providers.alipay.public_key = publicKey;
  }));
  assert.equal(saved.ok, true);
  const described = describePaymentCatalog(saved.value);
  assert.equal(described.methods.find(method => method.id === 'alipay').offered, false);
  assert.equal(described.methods.find(method => method.id === 'alipay').reason, 'not_collectable');
  assert.equal(described.providers.find(provider => provider.id === 'alipay').fields.find(field => field.key === 'private_key').configured, true);
  assert.equal(JSON.stringify(described).includes(privateKey), false);
  const kept = parsePaymentCatalog(saved.value, catalogInput(body => {
    body.methods.alipay = { enabled: true, source: 'official_alipay' };
    body.providers.alipay.enabled = true;
    body.providers.alipay.app_id = '2021000000000001';
    body.providers.alipay.public_key = publicKey;
  }));
  assert.equal(kept.ok, true);
  assert.equal(kept.value.providers.alipay.private_key, privateKey);
  const spaced = catalogInput(body => { body.providers.alipay.private_key = '   '; });
  assert.equal(parsePaymentCatalog(saved.value, spaced).ok, false);
});

test('saved payment catalog does not echo secrets or enable checkout for channels that cannot collect', async t => {
  const f = await fixture(t, { withoutCore: true });
  const admin = await f.request('POST', '/api/setup', { ...credentials, setup_token: f.setupToken });
  const body = catalogInput(data => {
    data.methods.alipay = { enabled: true, source: 'easypay_alipay' };
    data.providers.easypay.enabled = true;
    data.providers.easypay.pid = '10001';
    data.providers.easypay.pkey = 'easypay-secret-key';
    data.providers.easypay.api_base = 'https://pay.example.test/api/';
  });
  const saved = await f.request('PATCH', '/api/admin/settings', { payment_catalog: body }, admin);
  assert.equal(saved.status, 200);
  assert.equal(saved.data.features.payment, false);
  assert.equal(saved.data.payment.catalog.methods.find(method => method.id === 'alipay').offered, false);
  assert.equal(saved.data.payment.catalog.methods.find(method => method.id === 'alipay').reason, 'not_collectable');
  assert.equal(saved.data.payment.catalog.providers.find(provider => provider.id === 'easypay').fields.find(field => field.key === 'api_base').value, 'https://pay.example.test/api');
  assert.equal(saved.raw.includes('easypay-secret-key'), false);
  const stored = f.store.db.prepare("SELECT value FROM settings WHERE key='services'").get().value;
  assert.equal(stored.includes('easypay-secret-key'), true);
  const again = await f.request('PATCH', '/api/admin/settings', { payment_catalog: catalogInput(data => {
    data.methods.alipay = { enabled: true, source: 'easypay_alipay' };
    data.providers.easypay.enabled = true;
    data.providers.easypay.pid = '10001';
    data.providers.easypay.api_base = 'https://pay.example.test/api';
  }) }, admin);
  assert.equal(again.status, 200);
  assert.equal(f.store.db.prepare("SELECT value FROM settings WHERE key='services'").get().value.includes('easypay-secret-key'), true);
  const cleared = await f.request('PATCH', '/api/admin/settings', { payment_catalog: catalogInput(data => {
    data.providers.easypay.clear_secrets = true;
  }) }, admin);
  assert.equal(cleared.status, 200);
  assert.equal(f.store.db.prepare("SELECT value FROM settings WHERE key='services'").get().value.includes('easypay-secret-key'), false);
  assert.equal(cleared.data.payment.catalog.providers.find(provider => provider.id === 'easypay').fields.find(field => field.key === 'pkey').configured, false);
  const rejected = await f.request('POST', '/api/me/rentals', { plan_id: 'plan-1', expected_revision: 1, payment_method: 'alipay', request_id: 'a'.repeat(16), platform: 'MacOS/arm64' }, admin);
  assert.equal(rejected.status, 400);
  assert.equal(rejected.data.error.code, 'invalid_purchase');
  assert.equal((await f.request('GET', '/api/public')).data.features.payment, false);
  const audit = await f.request('GET', '/api/admin/audit', undefined, admin);
  assert.equal(audit.raw.includes('easypay-secret-key'), false);
});

test('stripe environment lock and pending stripe orders do not block unrelated channel settings', async t => {
  const stripe = stripeFixture();
  const f = await fixture(t, { withoutCore: true, paymentTransport: stripe.transport, env: { STRIPE_SECRET_KEY: 'sk_test_isolated_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_test_fixture' } });
  const admin = await f.request('POST', '/api/setup', { ...credentials, setup_token: f.setupToken });
  assert.equal((await f.request('PATCH', '/api/admin/settings', { payment: { secret_key: 'sk_test_other', webhook_secret: 'whsec_other' } }, admin)).status, 409);
  const saved = await f.request('PATCH', '/api/admin/settings', { payment_catalog: catalogInput(data => { data.providers.wxpay.mch_id = '1900000001'; }) }, admin);
  assert.equal(saved.status, 200);
  assert.equal(saved.data.payment.source, 'environment');
  assert.equal(saved.data.payment.editable, false);
  assert.equal(saved.data.payment.catalog.providers.find(provider => provider.id === 'wxpay').fields.find(field => field.key === 'mch_id').value, '1900000001');
  assert.equal(saved.raw.includes('whsec_test_fixture'), false);
  const open = await fixture(t, { withoutCore: true, paymentTransport: stripe.transport });
  const openAdmin = await open.request('POST', '/api/setup', { ...credentials, setup_token: open.setupToken });
  const stripeSaved = await open.request('PATCH', '/api/admin/settings', { payment: { secret_key: 'sk_test_isolated_fixture', webhook_secret: 'whsec_test_fixture' } }, openAdmin);
  assert.equal(stripeSaved.status, 200);
  assert.equal((await open.request('POST', '/api/me/payments', { amount_minor: 300 }, openAdmin)).status, 201);
  const duringPayment = await open.request('PATCH', '/api/admin/settings', { payment_catalog: catalogInput(data => { data.providers.alipay.app_id = '2021000000000001'; }) }, openAdmin);
  assert.equal(duringPayment.status, 200);
  assert.equal((await open.request('PATCH', '/api/admin/settings', { payment: { secret_key: 'sk_test_rotated_value', webhook_secret: 'whsec_rotated_value' } }, openAdmin)).status, 409);
});
