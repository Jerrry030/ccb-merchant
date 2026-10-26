import { resolve, isAbsolute, relative } from 'node:path';

export function loadConfig(env = process.env, root = process.cwd()) {
  const integer = (key, fallback, min, max) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${key}`);
    return value;
  };
  const port = integer('PORT', 8787, 1, 65535);
  const host = env.HOST || '127.0.0.1';
  const loopback = value => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(value);
  const origin = new URL(env.PUBLIC_ORIGIN || `http://localhost:${port}`);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error('PUBLIC_ORIGIN must be an origin');
  const remote = !loopback(host) || !loopback(origin.hostname);
  if (remote && (env.ALLOW_REMOTE !== 'true' || !env.PUBLIC_ORIGIN)) throw new Error('Network operation requires ALLOW_REMOTE=true and explicit PUBLIC_ORIGIN');
  if (!loopback(origin.hostname) && origin.protocol !== 'https:') throw new Error('Remote PUBLIC_ORIGIN requires HTTPS');
  let upstreamUrl = null;
  if (env.UPSTREAM_URL) {
    const url = new URL(env.UPSTREAM_URL);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('UPSTREAM_URL must be a direct provider origin');
    if (url.origin === origin.origin) throw new Error('UPSTREAM_URL must not point to this merchant');
    upstreamUrl = url.origin;
  }
  const upstreamKey = env.UPSTREAM_API_KEY || '';
  if (upstreamKey && !/^ccbm_[A-Za-z0-9_-]{16,}$/.test(upstreamKey)) throw new Error('UPSTREAM_API_KEY must be a merchant-scoped ccbm_ key');
  if (Boolean(upstreamUrl) !== Boolean(upstreamKey)) throw new Error('Set both UPSTREAM_URL and UPSTREAM_API_KEY, or neither');
  const publicDir = resolve(root, 'public');
  const dataDir = resolve(root, env.DATA_DIR || 'data');
  const insidePublic = relative(publicDir, dataDir);
  if (!insidePublic || (!insidePublic.startsWith('..') && !isAbsolute(insidePublic))) throw new Error('DATA_DIR must be outside public');
  const smtpKeys = ['SMTP_HOST', 'SMTP_FROM'];
  const mailConfigured = smtpKeys.every(key => Boolean(env[key]));
  if (smtpKeys.some(key => env[key]) && !mailConfigured) throw new Error('SMTP_HOST and SMTP_FROM must both be configured');
  if (Boolean(env.SMTP_USER) !== Boolean(env.SMTP_PASSWORD)) throw new Error('SMTP credentials must be configured together');
  if (env.SMTP_FROM && /[\r\n]/.test(env.SMTP_FROM)) throw new Error('Invalid SMTP_FROM');
  const paymentConfigured = Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET);
  if (Boolean(env.STRIPE_SECRET_KEY) !== Boolean(env.STRIPE_WEBHOOK_SECRET)) throw new Error('Stripe secret and webhook secret must both be configured');
  if (paymentConfigured && (!/^sk_(live|test)_/.test(env.STRIPE_SECRET_KEY) || !env.STRIPE_WEBHOOK_SECRET.startsWith('whsec_'))) throw new Error('Invalid Stripe server credentials');
  const smtpPort = integer('SMTP_PORT', 587, 1, 65535);
  return {
    host, port, publicOrigin: origin.origin, publicHost: origin.host, secureCookies: origin.protocol === 'https:',
    localOrigin: loopback(origin.hostname), publicDir, dataDir, upstreamUrl, upstreamKey,
    upstreamEnvironment: Boolean(upstreamUrl),
    upstreamAllowedOrigins: [...new Set([...(env.UPSTREAM_ALLOWED_ORIGINS||'').split(',').filter(Boolean).map(raw=>{const u=new URL(raw.trim());if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw new Error('Invalid UPSTREAM_ALLOWED_ORIGINS');return u.origin;}),...(upstreamUrl?[upstreamUrl]:[])])],
    upstreamTimeoutMs: integer('UPSTREAM_TIMEOUT_MS', 15000, 100, 120000),
    reconcileIntervalMs: integer('RECONCILE_INTERVAL_MS', 10000, 1000, 300000),
    runtimeMaxInFlight: integer('RUNTIME_MAX_IN_FLIGHT', 8, 1, 128),
    runtimeTimeoutMs: integer('RUNTIME_TIMEOUT_MS', 600000, 100, 3600000),
    runtimeBodyLimit: integer('RUNTIME_BODY_LIMIT', 33554432, 4096, 33554432),
    jsonBodyLimit: 65536, sessionMs: 12 * 60 * 60 * 1000,
    siteName: env.SITE_NAME || 'CCB Merchant',
    mail: mailConfigured ? {
      host: env.SMTP_HOST, port: smtpPort, secure: smtpPort === 465,
      requireTLS: true, from: env.SMTP_FROM,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
    } : null,
    stripe: paymentConfigured ? { secret: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET, live: env.STRIPE_SECRET_KEY.startsWith('sk_live_') } : null,
    paymentMin: integer('PAYMENT_MIN_MINOR', 100, 1, 1000000),
    paymentMax: integer('PAYMENT_MAX_MINOR', 1000000, 1, 100000000),
  };
}
