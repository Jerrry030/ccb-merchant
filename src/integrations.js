import { HttpError, fields, text, email } from './security.js';
import { isRegistrationEmailSuffixAllowed, isRegistrationEmailSuffixDomainValid, normalizeRegistrationEmailSuffixDomain, toCanonicalRegistrationEmailSuffix } from '../public/registration-policy.js';

const HOST = /^(?:localhost|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/;

function flag(value, name) {
  if (typeof value !== 'boolean') throw new HttpError(400, 'invalid_input', `${name} must be boolean.`);
  return value;
}

function ipv4(value) {
  const parts = value.split('.');
  return parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function hostName(value) {
  const host = text(value, 'smtp host', 253).toLowerCase();
  if (HOST.test(host) || ipv4(host)) return host;
  throw new HttpError(400, 'invalid_input', 'Invalid SMTP host.');
}

function secretText(value, name) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 500 || /[\u0000-\u001f\u007f]/.test(value)) throw new HttpError(400, 'invalid_input', `Invalid ${name}.`);
  return value;
}

export function readSite(store) {
  return JSON.parse(store.db.prepare("SELECT value FROM settings WHERE key='site'").get().value);
}

export function strictEmailSuffixWhitelist(items) {
  if (!Array.isArray(items) || items.length > 50 || items.some(item => typeof item !== 'string')) throw new HttpError(400, 'invalid_input', 'Invalid email domain whitelist.');
  const seen = new Set();
  const normalized = [];
  for (const item of items) {
    if (item.length > 253) throw new HttpError(400, 'invalid_input', 'Invalid email domain.');
    const domain = normalizeRegistrationEmailSuffixDomain(item);
    if (!isRegistrationEmailSuffixDomainValid(domain)) throw new HttpError(400, 'invalid_input', 'Invalid email domain.');
    const canonical = toCanonicalRegistrationEmailSuffix(domain);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    normalized.push(canonical);
  }
  return normalized;
}

export function registrationView(saved) {
  const whitelist = strictEmailSuffixWhitelist(Array.isArray(saved.email_suffix_whitelist) ? saved.email_suffix_whitelist : []);
  return {
    enabled: Boolean(saved.registration_enabled),
    email_verification_enabled: saved.email_verification_enabled !== false,
    email_domain_quota_enabled: saved.email_domain_quota_enabled === true,
    email_suffix_whitelist: whitelist,
  };
}

export function publicSettings(saved, mail, payment, upstreamUrl) {
  const registration = registrationView(saved);
  const mailOn = Boolean(mail);
  return {
    site: {
      name: saved.name, description: saved.description, support_email: saved.support_email, currency: 'CNY',
      logo_url: saved.logo_url || '', accent_color: saved.accent_color || '#7c5cff',
      registration_email_suffix_whitelist: registration.email_suffix_whitelist,
    },
    features: {
      registration: Boolean(saved.registration_enabled && (registration.email_verification_enabled ? mailOn : true)),
      email_verification: Boolean(registration.email_verification_enabled && mailOn),
      password_reset: mailOn,
      payment: payment.configured,
      recharge: payment.configured && payment.recharge_enabled,
      token_billing: false,
      term_rentals: Boolean(upstreamUrl),
    },
  };
}

function formatFrom(from, fromName) {
  if (!fromName) return from;
  return `"${fromName.replace(/["\\]/g, '')}" <${from}>`;
}

export function effectiveMail(config, store, draft) {
  if (config.mail) return { ...config.mail, source: 'environment' };
  const stored = draft === undefined ? JSON.parse(store.db.prepare("SELECT value FROM settings WHERE key='mail'").get().value).config : draft;
  if (!stored?.host || !stored.from || stored.enabled === false) return null;
  const port = stored.port;
  return {
    host: stored.host, port, secure: port === 465, requireTLS: stored.use_tls !== false && port !== 465,
    from: formatFrom(stored.from, stored.from_name || ''),
    auth: stored.user ? { user: stored.user, pass: stored.pass } : undefined,
    source: 'settings',
  };
}

export function describeMail(config, store) {
  const env = Boolean(config.mail);
  const mail = effectiveMail(config, store);
  const record = JSON.parse(store.db.prepare("SELECT value FROM settings WHERE key='mail'").get().value);
  const stored = record.config;
  return {
    revision: record.revision, enabled: env || stored?.enabled !== false,
    configured: Boolean(mail),
    source: env ? 'environment' : mail ? 'settings' : 'none',
    editable: !env,
    host: env ? config.mail.host : stored?.host || '',
    port: env ? config.mail.port : stored?.port || 587,
    username: env ? config.mail.auth?.user || '' : stored?.user || '',
    from: env ? config.mail.from : stored?.from || '',
    from_name: env ? '' : stored?.from_name || '',
    use_tls: env ? config.mail.requireTLS !== false || config.mail.secure === true : stored ? stored.use_tls !== false : true,
    password_configured: env ? Boolean(config.mail.auth?.pass) : Boolean(stored?.pass),
  };
}

export function applyMailUpdate(current, input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'invalid_input', 'Invalid mail configuration.');
  fields(input, ['enabled', 'host', 'port', 'username', 'password', 'from', 'from_name', 'use_tls'], input.host === '' ? ['host'] : ['host', 'port', 'from', 'use_tls']);
  if (input.host === '') return null;
  const host = hostName(input.host);
  const port = input.port;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new HttpError(400, 'invalid_input', 'Invalid SMTP port.');
  const from = email(input.from);
  const fromName = input.from_name === undefined || input.from_name === '' ? '' : text(input.from_name, 'from name', 80, 1);
  const useTls = flag(input.use_tls, 'use_tls');
  const username = input.username === undefined || input.username === '' ? '' : text(input.username, 'smtp username', 200);
  if (input.password !== undefined && typeof input.password !== 'string') throw new HttpError(400, 'invalid_input', 'Invalid SMTP password.');
  if (input.password && !username) throw new HttpError(400, 'invalid_input', 'SMTP password requires a username.');
  const retained = username && !input.password && current?.pass;
  if (retained && (host !== current.host || port !== current.port || username !== current.user || useTls !== (current.use_tls !== false))) throw new HttpError(400, 'mail_password_required', 'Enter the password again when changing the SMTP destination, user or TLS mode.');
  const password = username ? (input.password ? secretText(input.password, 'smtp password') : current?.pass || '') : '';
  if (username && !password) throw new HttpError(400, 'invalid_input', 'SMTP username and password must both be set, or neither.');
  return { enabled: input.enabled === undefined ? true : flag(input.enabled, 'enabled'), host, port, user: username, pass: password, from, from_name: fromName, use_tls: useTls };
}

export function assertCanRegister(store, address) {
  const registration = registrationView(readSite(store));
  const whitelist = registration.email_suffix_whitelist;
  if (whitelist.length === 0 || isRegistrationEmailSuffixAllowed(address, whitelist)) return;
  if (!registration.email_domain_quota_enabled) throw new HttpError(400, 'email_suffix_not_allowed', 'This email domain is not allowed for registration.');
  const domain = address.split('@')[1];
  const count = store.db.prepare("SELECT count(*) AS n FROM users WHERE lower(substr(email, instr(email, '@') + 1)) = ?").get(domain).n;
  if (count > 0) throw new HttpError(400, 'email_domain_registration_limit', 'This email domain cannot register another account.');
}