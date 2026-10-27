export const EMAIL_SUFFIX_WILDCARD_PREFIX = '*.';
const SPLIT = /[\s,，]+/;
const INVALID = /[^a-z0-9.-]/g;
const INVALID_TEST = /[^a-z0-9.-]/;
const DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function token(value, strict) {
  if (value.startsWith(EMAIL_SUFFIX_WILDCARD_PREFIX)) {
    const domain = value.slice(EMAIL_SUFFIX_WILDCARD_PREFIX.length);
    if (strict && (!domain || INVALID_TEST.test(domain))) return '';
    return `${EMAIL_SUFFIX_WILDCARD_PREFIX}${domain.replace(INVALID, '')}`;
  }
  if (value === '*') return strict ? '' : value;
  if (strict && INVALID_TEST.test(value)) return '';
  return value.replace(/[*]/g, '').replace(INVALID, '');
}

export function normalizeRegistrationEmailSuffixDomain(raw) {
  let value = String(raw || '').trim().toLowerCase().replace(/^@+/, '');
  return value ? token(value, false) : '';
}

export function isRegistrationEmailSuffixDomainValid(domain) {
  if (!domain) return false;
  if (domain.startsWith(EMAIL_SUFFIX_WILDCARD_PREFIX)) return DOMAIN.test(domain.slice(EMAIL_SUFFIX_WILDCARD_PREFIX.length));
  return !domain.includes('*') && DOMAIN.test(domain);
}

export function normalizeRegistrationEmailSuffixDomains(items) {
  const seen = new Set();
  const normalized = [];
  for (const item of items || []) {
    const domain = normalizeRegistrationEmailSuffixDomain(item);
    if (!isRegistrationEmailSuffixDomainValid(domain) || seen.has(domain)) continue;
    seen.add(domain);
    normalized.push(domain);
  }
  return normalized;
}

export function parseRegistrationEmailSuffixWhitelistInput(input) {
  const seen = new Set();
  const normalized = [];
  for (const part of String(input || '').split(SPLIT)) {
    const domain = String(part || '').trim().toLowerCase().replace(/^@+/, '');
    const strict = domain ? token(domain, true) : '';
    if (!isRegistrationEmailSuffixDomainValid(strict) || seen.has(strict)) continue;
    seen.add(strict);
    normalized.push(strict);
  }
  return normalized;
}

export function toCanonicalRegistrationEmailSuffix(domain) {
  return domain.startsWith(EMAIL_SUFFIX_WILDCARD_PREFIX) ? domain : `@${domain}`;
}

export function normalizeRegistrationEmailSuffixWhitelist(items) {
  return normalizeRegistrationEmailSuffixDomains(items).map(toCanonicalRegistrationEmailSuffix);
}

export function isRegistrationEmailSuffixAllowed(address, whitelist) {
  const normalized = normalizeRegistrationEmailSuffixWhitelist(whitelist);
  if (normalized.length === 0) return true;
  const raw = String(address || '').trim().toLowerCase();
  const at = raw.indexOf('@');
  if (at <= 0 || at >= raw.length - 1 || raw.indexOf('@', at + 1) !== -1) return false;
  const emailDomain = raw.slice(at + 1);
  const emailSuffix = `@${emailDomain}`;
  return normalized.some(allowed => {
    if (allowed.startsWith('@')) return allowed === emailSuffix;
    if (allowed.startsWith(EMAIL_SUFFIX_WILDCARD_PREFIX)) {
      const base = allowed.slice(EMAIL_SUFFIX_WILDCARD_PREFIX.length);
      return emailDomain === base || emailDomain.endsWith(`.${base}`);
    }
    return false;
  });
}
