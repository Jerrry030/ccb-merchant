import test from 'node:test';
import assert from 'node:assert/strict';
import { isRegistrationEmailSuffixAllowed, normalizeRegistrationEmailSuffixWhitelist } from '../../public/registration-policy.js';
import { fixture, stripeFixture, password } from './fixtures.js';

const credentials = { email: 'admin@example.test', password, display_name: 'Administrator' };
const mail = { host: 'smtp.example.test', port: 587, username: 'mailer', password: 'smtp-secret-value', from: 'noreply@example.test', from_name: '商户', use_tls: true };

test('email domain whitelist matches exact domains and wildcards only', () => {
  assert.deepEqual(normalizeRegistrationEmailSuffixWhitelist([' @QQ.com ', '*.edu.cn', 'not a domain', '@qq.com']), ['@qq.com', '*.edu.cn']);
  assert.equal(isRegistrationEmailSuffixAllowed('person@qq.com', ['@qq.com']), true);
  assert.equal(isRegistrationEmailSuffixAllowed('person@sub.qq.com', ['@qq.com']), false);
  assert.equal(isRegistrationEmailSuffixAllowed('person@cs.EDU.cn', ['*.edu.cn']), true);
  assert.equal(isRegistrationEmailSuffixAllowed('person@edu.cn', ['*.edu.cn']), true);
  assert.equal(isRegistrationEmailSuffixAllowed('person@example.test', []), true);
});

test('saved mail and stripe settings enable features without returning secrets', async t => {
  const deliveries = [];
  const stripe = stripeFixture();
  const f = await fixture(t, { withoutCore: true, mailer: { async send(address, kind, token) { deliveries.push({ address, kind, token }); } }, paymentTransport: stripe.transport });
  const admin = await f.request('POST', '/api/setup', { ...credentials, setup_token: f.setupToken });
  assert.equal((await f.request('PATCH', '/api/admin/settings', { registration_enabled: true }, admin)).data.features.registration, false);
  const savedMail = await f.request('PATCH', '/api/admin/settings', { mail }, admin);
  assert.equal(savedMail.status, 200);
  assert.equal(savedMail.data.mail.configured, true);
  assert.equal(savedMail.data.mail.password_configured, true);
  assert.equal(savedMail.data.mail.source, 'settings');
  assert.equal(savedMail.raw.includes('smtp-secret-value'), false);
  assert.equal(savedMail.data.features.password_reset, true);
  assert.equal(savedMail.data.features.registration, true);
  const stored = f.store.db.prepare("SELECT value FROM settings WHERE key='services'").get().value;
  assert.equal(stored.includes('smtp-secret-value'), true);
  const again = await f.request('PATCH', '/api/admin/settings', { mail: { ...mail, password: '' } }, admin);
  assert.equal(again.status, 200);
  assert.equal(f.store.db.prepare("SELECT value FROM settings WHERE key='services'").get().value.includes('smtp-secret-value'), true);
  const registered = await f.request('POST', '/api/auth/register', { email: 'new@example.test', password, display_name: 'New' });
  assert.equal(registered.status, 200);
  assert.equal(deliveries[0].address, 'new@example.test');
  const stripeSaved = await f.request('PATCH', '/api/admin/settings', { payment: { secret_key: 'sk_test_isolated_fixture', webhook_secret: 'whsec_test_fixture' } }, admin);
  assert.equal(stripeSaved.status, 200);
  assert.equal(stripeSaved.data.payment.configured, true);
  assert.equal(stripeSaved.data.payment.live, false);
  assert.equal(stripeSaved.raw.includes('sk_test_isolated_fixture'), false);
  assert.equal(stripeSaved.raw.includes('whsec_test_fixture'), false);
  const paid = await f.request('POST', '/api/me/payments', { amount_minor: 300 }, admin);
  assert.equal(paid.status, 201);
  assert.equal((await f.request('PATCH', '/api/admin/settings', { payment: { secret_key: 'sk_test_rotated_value', webhook_secret: 'whsec_rotated_value' } }, admin)).status, 409);
  assert.equal(f.store.db.prepare("SELECT value FROM settings WHERE key='services'").get().value.includes('whsec_test_fixture'), true);
  const audit = await f.request('GET', '/api/admin/audit', undefined, admin);
  assert.equal(audit.raw.includes('smtp-secret-value'), false);
  assert.equal(audit.raw.includes('sk_test_isolated_fixture'), false);
  await f.restart();
  assert.equal((await f.request('GET', '/api/admin/settings', undefined, admin)).data.mail.password_configured, true);
  assert.equal((await f.request('GET', '/api/public')).data.features.payment, true);
});

test('registration whitelist and domain quota follow the saved policy', async t => {
  const f = await fixture(t, { withoutCore: true, mailer: { async send() {} } });
  const admin = await f.request('POST', '/api/setup', { ...credentials, setup_token: f.setupToken });
  await f.request('PATCH', '/api/admin/settings', { mail, registration_enabled: true, email_suffix_whitelist: ['qq.com', '*.edu.cn'], email_domain_quota_enabled: false }, admin);
  assert.equal((await f.request('POST', '/api/auth/register', { email: 'one@gmail.com', password, display_name: 'One' })).data.error.code, 'email_suffix_not_allowed');
  assert.equal((await f.request('POST', '/api/auth/register', { email: 'one@qq.com', password, display_name: 'QQ' })).status, 200);
  assert.equal((await f.request('POST', '/api/auth/register', { email: 'two@sub.qq.com', password, display_name: 'Sub' })).data.error.code, 'email_suffix_not_allowed');
  assert.equal((await f.request('POST', '/api/auth/register', { email: 'student@cs.edu.cn', password, display_name: 'Student' })).status, 200);
  await f.request('PATCH', '/api/admin/settings', { email_domain_quota_enabled: true }, admin);
  assert.equal((await f.request('POST', '/api/auth/register', { email: 'first@gmail.com', password, display_name: 'First' })).status, 200);
  assert.equal((await f.request('POST', '/api/auth/register', { email: 'second@gmail.com', password, display_name: 'Second' })).data.error.code, 'email_domain_registration_limit');
  assert.equal((await f.request('POST', '/api/auth/register', { email: 'third@qq.com', password, display_name: 'Third' })).status, 200);
  const cleared = await f.request('PATCH', '/api/admin/settings', { mail: { host: '' } }, admin);
  assert.equal(cleared.data.mail.configured, false);
  assert.equal(cleared.data.features.registration, false);
});

test('turning off email verification allows registration before mail is configured', async t => {
  const f = await fixture(t, { withoutCore: true });
  const admin = await f.request('POST', '/api/setup', { ...credentials, setup_token: f.setupToken });
  const saved = await f.request('PATCH', '/api/admin/settings', { registration_enabled: true, email_verification_enabled: false }, admin);
  assert.equal(saved.data.features.registration, true);
  assert.equal(saved.data.features.email_verification, false);
  const registered = await f.request('POST', '/api/auth/register', { email: 'open@example.test', password, display_name: 'Open' });
  assert.deepEqual(registered.data, { status: 'created' });
  assert.equal((await f.request('POST', '/api/auth/login', { email: 'open@example.test', password })).status, 200);
});

test('environment mail and stripe cannot be overwritten from the browser', async t => {
  const f = await fixture(t, { withoutCore: true, env: { SMTP_HOST: 'smtp.example.invalid', SMTP_FROM: 'merchant@example.test', STRIPE_SECRET_KEY: 'sk_test_isolated_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_test_fixture' }, mailer: { async send() {} } });
  const admin = await f.request('POST', '/api/setup', { ...credentials, setup_token: f.setupToken });
  assert.equal((await f.request('PATCH', '/api/admin/settings', { mail }, admin)).status, 409);
  assert.equal((await f.request('PATCH', '/api/admin/settings', { payment: { secret_key: 'sk_test_other', webhook_secret: 'whsec_other' } }, admin)).status, 409);
  const settings = await f.request('GET', '/api/admin/settings', undefined, admin);
  assert.equal(settings.data.mail.source, 'environment');
  assert.equal(settings.data.mail.editable, false);
  assert.equal(settings.data.payment.source, 'environment');
  assert.equal(settings.raw.includes('whsec_test_fixture'), false);
});
