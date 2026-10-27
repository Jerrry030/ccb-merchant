import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
let passwordJobs = 0;
export class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export const digest = value => createHash('sha256').update(value).digest('hex');
export const randomToken = () => randomBytes(32).toString('base64url');
export function equalSecret(left, right) {
  return typeof left === 'string' && typeof right === 'string' && timingSafeEqual(Buffer.from(digest(left), 'hex'), Buffer.from(digest(right), 'hex'));
}
export async function passwordHash(password, encoded) {
  if (typeof password !== 'string' || Buffer.byteLength(password) > 1024 || (!encoded && [...password].length <= 6)) throw new HttpError(400, 'invalid_password', 'Password must be longer than 6 characters and at most 1024 bytes.');
  if (passwordJobs >= 4) throw new HttpError(429, 'busy', 'Authentication busy; try again later.');
  const parts = encoded?.split('$');
  const salt = parts ? parts[1] : randomBytes(16).toString('hex');
  if (parts && (parts.length !== 3 || parts[0] !== 'scrypt-v1' || !/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{64}$/.test(parts[2]))) return false;
  passwordJobs++;
  try {
    const key = await derive(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return parts ? timingSafeEqual(key, Buffer.from(parts[2], 'hex')) : `scrypt-v1$${salt}$${key.toString('hex')}`;
  } finally { passwordJobs--; }
}
export function fields(value, allowed, required = []) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => value[key] === undefined)) throw new HttpError(400, 'invalid_input', 'Unexpected or missing request fields.');
  return value;
}
export function text(value, name, max = 200, min = 1) {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new HttpError(400, 'invalid_input', `Invalid ${name}.`);
  return value.trim();
}
export function email(value) {
  const normalized = text(value, 'email', 254).toLowerCase();
  const [local, domain, extra] = normalized.split('@');
  if (extra !== undefined || !local || local.length > 64 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..') || !domain || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(domain)) throw new HttpError(400, 'invalid_input', 'Invalid email.');
  return normalized;
}
export function opaqueId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,150}$/.test(value)) throw new HttpError(400, 'invalid_input', 'Invalid identifier.');
  return encodeURIComponent(value);
}
export function expiry(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw new HttpError(400, 'invalid_input', 'Invalid expiry timestamp.');
  return value;
}
export async function readBody(req, limit, json = true) {
  if (req.headers['content-encoding']) throw new HttpError(415, 'unsupported_encoding', 'Compressed request bodies are not supported.');
  if (json && !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'content_type', 'Content-Type must be application/json.');
  if (Number(req.headers['content-length'] || 0) > limit) { req.resume(); throw new HttpError(413, 'body_too_large', 'Request body too large.'); }
  let size = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn:false })) {
    size += chunk.length;
    if (size > limit) { req.resume(); throw new HttpError(413, 'body_too_large', 'Request body too large.'); }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  if (!json) return body;
  try { return JSON.parse(body.toString('utf8')); } catch { throw new HttpError(400, 'invalid_json', 'Invalid JSON body.'); }
}
export function respond(res, status, data) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
export function requestBoundary(req, config, pathname) {
  const loopback = /^(?:127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress || '');
  const localHosts = [`localhost:${config.port}`, `127.0.0.1:${config.port}`, `[::1]:${config.port}`];
  const bootstrap = pathname === '/api/setup' && loopback && localHosts.includes(req.headers.host);
  const hostAllowed = req.headers.host === config.publicHost || (config.localOrigin && localHosts.includes(req.headers.host)) || bootstrap;
  if (!hostAllowed) throw new HttpError(421, 'invalid_host', 'Host is not configured for this server.');
  if (pathname === '/api/setup' && (!loopback || !localHosts.includes(req.headers.host))) throw new HttpError(403, 'local_setup_only', 'Setup is available only through a direct loopback connection.');
  if(pathname.startsWith('/access/v1/')) {
    if(req.headers.origin!==undefined||req.headers.cookie!==undefined||req.headers['sec-fetch-site'])throw new HttpError(403,'server_only','Merchant protocol is server-to-server only.');
    return;
  }
  if (pathname.startsWith('/bridge/')) {
    if (req.headers.origin !== undefined) throw new HttpError(403, 'native_only', 'Runtime endpoints are for native clients only.');
    return;
  }
  if (/^\/api\/webhooks\/(stripe|alipay|wxpay|easypay|suixingpay|airwallex)(?:\/[A-Za-z0-9_-]{1,100})?$/.test(pathname)) return;
  if (['GET', 'HEAD'].includes(req.method)) {
    if (pathname.startsWith('/api/') && req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'cross_site', 'Cross-site request rejected.');
    return;
  }
  const validOrigins = [config.publicOrigin];
  if (config.localOrigin || bootstrap) validOrigins.push(...localHosts.map(host => `http://${host}`));
  if (!validOrigins.includes(req.headers.origin) || req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'invalid_origin', 'A same-origin request is required.');
}




