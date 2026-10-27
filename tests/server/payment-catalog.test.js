import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePaymentCatalog, parsePaymentCatalog, describePaymentCatalog } from '../../public/payment-catalog.js';
import { fixture, stripeFixture, password } from './fixtures.js';

const credentials = { email: 'admin@example.test', password, display_name: 'Administrator' };
const privateKey = 'catalog-private-key-0123456789';
const publicKey = 'catalog-public-key-0123456789';

function catalogInput(mutate) {
  const current = normalizePaymentCatalog(null);
  const body = { methods: {}, providers: {} };
  for (const [id, method] of Object.entries(current.methods)) body.methods[id] = { enabled: method.enabled, source: method.source };
  for (const [id, provider] of Object.entries(current.providers)) {
    body.providers[id] = { enabled: provider.enabled, clear_secrets: false };
    for (const [key, value] of Object.entries(provider)) if (key !== 'enabled') body.providers[id][key] = value;
  }
  mutate?.(body);
  return body;
}

test('visible payment methods require a source and complete credentials, and ready channels are offered', () => {
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
  assert.equal(described.methods.find(method => method.id === 'alipay').offered, true);
  assert.equal(described.methods.find(method => method.id === 'alipay').reason, null);
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

test('saved payment catalog offers enabled adapters without echoing secrets', async t => {
  const f = await fixture(t, { withoutCore: true });
  const admin = await f.request('POST', '/api/setup', { ...credentials, setup_token: f.setupToken });
  const body = catalogInput(data => {
    data.methods.alipay = { enabled: true, source: 'easypay_alipay' };
    data.providers.easypay.enabled = true;
    data.providers.easypay.pid = '10001';
    data.providers.easypay.pkey = 'easypay-secret-key';
    data.providers.easypay.api_base = 'https://pay.example.test/api/';
  });
  const saved = await f.request('PATCH', '/api/admin/payment', { expected_revision:1, ...body }, admin);
  assert.equal(saved.status, 200);
  assert.equal(saved.data.features.payment, true);
  assert.equal(saved.data.payment.methods.find(method => method.id === 'alipay').offered, true);
  assert.equal(saved.data.payment.methods.find(method => method.id === 'alipay').reason, null);
  assert.equal(saved.data.payment.providers.find(provider => provider.id === 'easypay').fields.find(field => field.key === 'api_base').value, 'https://pay.example.test/api');
  assert.equal(saved.raw.includes('easypay-secret-key'), false);
  const stored = f.store.db.prepare("SELECT value FROM settings WHERE key='payment'").get().value;
  assert.equal(stored.includes('easypay-secret-key'), true);
  const again = await f.request('PATCH', '/api/admin/payment', { expected_revision:2, ...catalogInput(data => {
    data.methods.alipay = { enabled: true, source: 'easypay_alipay' };
    data.providers.easypay.enabled = true;
    data.providers.easypay.pid = '10001';
    data.providers.easypay.api_base = 'https://pay.example.test/api';
  }) }, admin);
  assert.equal(again.status, 200);
  assert.equal(f.store.db.prepare("SELECT value FROM settings WHERE key='payment'").get().value.includes('easypay-secret-key'), true);
  const cleared = await f.request('PATCH', '/api/admin/payment', { expected_revision:3, ...catalogInput(data => {
    data.providers.easypay.clear_secrets = true;
  }) }, admin);
  assert.equal(cleared.status, 200);
  assert.equal(f.store.db.prepare("SELECT value FROM settings WHERE key='payment'").get().value.includes('easypay-secret-key'), false);
  assert.equal(cleared.data.payment.providers.find(provider => provider.id === 'easypay').fields.find(field => field.key === 'pkey').configured, false);
  const rejected = await f.request('POST', '/api/me/payments', {amount_minor:300,payment_method:'unsupported'},admin);
  assert.equal(rejected.status,503);
  assert.equal((await f.request('GET', '/api/public')).data.features.payment, false);
  const audit = await f.request('GET', '/api/admin/audit', undefined, admin);
  assert.equal(audit.raw.includes('easypay-secret-key'), false);
});

test('stripe environment lock and pending orders do not block unrelated channel settings', async t => {
  const stripe=stripeFixture();
  const f=await fixture(t,{withoutCore:true,paymentTransport:stripe.transport,env:{STRIPE_SECRET_KEY:'sk_test_isolated_fixture',STRIPE_WEBHOOK_SECRET:'whsec_test_fixture'}});
  const admin=await f.request('POST','/api/setup',{...credentials,setup_token:f.setupToken});
  assert.equal((await f.request('PATCH','/api/admin/payment',{expected_revision:1,providers:{stripe:{secret_key:'sk_test_other',webhook_secret:'whsec_other'}}},admin)).status,409);
  const saved=await f.request('PATCH','/api/admin/payment',{expected_revision:1,providers:{wxpay:{mch_id:'1900000001'}}},admin);
  assert.equal(saved.status,200);
  assert.equal(saved.data.payment.providers.find(p=>p.id==='stripe').source,'environment');
  assert.equal(saved.data.payment.providers.find(p=>p.id==='stripe').editable,false);
  assert.equal(saved.data.payment.providers.find(p=>p.id==='wxpay').fields.find(field=>field.key==='mch_id').value,'1900000001');
  assert.equal(saved.raw.includes('whsec_test_fixture'),false);
  assert.equal(f.store.db.prepare("SELECT value FROM settings WHERE key='payment'").get().value.includes('whsec_test_fixture'),false);
  const open=await fixture(t,{withoutCore:true,paymentTransport:stripe.transport});
  const owner=await open.request('POST','/api/setup',{...credentials,setup_token:open.setupToken});
  const configured=await open.request('PATCH','/api/admin/payment',{expected_revision:1,methods:{stripe:{enabled:true,source:'stripe_checkout'}},providers:{stripe:{enabled:true,secret_key:'sk_test_isolated_fixture',webhook_secret:'whsec_test_fixture'}}},owner);
  assert.equal(configured.status,200);
  assert.equal((await open.request('POST','/api/me/payments',{amount_minor:300},owner)).status,201);
  assert.equal((await open.request('PATCH','/api/admin/payment',{expected_revision:2,providers:{alipay:{app_id:'2021000000000001'}}},owner)).status,200);
  assert.equal((await open.request('PATCH','/api/admin/payment',{expected_revision:3,providers:{stripe:{secret_key:'sk_test_rotated_value',webhook_secret:'whsec_rotated_value'}}},owner)).status,409);
});
