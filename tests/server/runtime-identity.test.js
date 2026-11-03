import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures.js';

const native = { native: true, headers: { Authorization: 'Bearer identity-device-fixture-123456789' } };

// A real Merchant HTTP boundary with synthetic provider identities and local users.
// Device membership is separate from both the account selection and all names.
async function identityFixture(t, options = {}) {
  const expires = new Date(Date.now() + 3600000).toISOString();
  const control = {
    device: { id: 'device-alice', name: 'Shared laptop', owner_user_id: 'PRIVATE_PROVIDER_OWNER', owner_username: 'PRIVATE_PROVIDER_USERNAME', owner_display_name: 'PRIVATE_PROVIDER_NAME', state: 'approved', expires_at: expires, current_grant_id: 'grant-a', account_name: 'PRIVATE_ACCOUNT_NAME', selection_version: 1 },
    memberships: new Map([['customer-alice', [{ id: 'device-alice', name: 'Different device label', state: 'approved', expires_at: expires }]], ['customer-bob', []]]),
    lookup: options.lookup,
  };
  const f = await fixture(t, { env: { UPSTREAM_TIMEOUT_MS: '5000', ...options.env }, onCore: async ({ req, url, json }) => {
    if (req.method === 'GET' && url.pathname === '/bridge/v1/device/status') { json(control.device); return true; }
    const match = url.pathname.match(/^\/access\/v1\/customers\/([^/]+)\/devices$/);
    if (req.method === 'GET' && match) {
      if (await control.lookup?.({ customer: match[1], url, json })) return true;
      json({ devices: control.memberships.get(match[1]) || [] }); return true;
    }
  } });
  const users = [];
  for (const name of ['alice', 'bob']) {
    const user = f.store.createUser({ email: name + '@example.test', display_name: name === 'alice' ? 'Alice display name' : 'Bob display name', password_hash: 'unused-test-hash', role: 'member', status: 'active' });
    f.store.db.prepare('UPDATE users SET core_customer_id=? WHERE id=?').run('customer-' + name, user.id);
    users.push(user);
  }
  return { f, control, users };
}

test('terminal status identifies the verified local login, not the provider, device, display name or selected account', async t => {
  const { f, users } = await identityFixture(t);
  const status = await f.request('GET', '/bridge/v1/device/status', undefined, native);
  assert.equal(status.status, 200, status.raw);
  assert.equal(status.data.owner_username, users[0].email);
  assert.match(status.data.owner_user_id, /^merchant_[a-f0-9]{64}$/);
  assert.equal(status.data.account_name, '账号（编号待核对）');
  for (const forbidden of ['PRIVATE_', users[1].email, users[0].display_name, 'owner_display_name']) assert.equal(status.raw.includes(forbidden), false, forbidden);
  const reads = f.state.requests.filter(r => /\/customers\/[^/]+\/devices(?:\?|$)/.test(r.path));
  assert.equal(reads.length, 2, 'both local customer memberships are checked');
  assert.ok(reads.every(r => r.method === 'GET' && r.headers.authorization !== native.headers.Authorization), 'membership reads use the server-side key, never the device bearer');
});

test('existing approved devices work without re-pairing, and a selected account change does not change the local username', async t => {
  const { f, control, users } = await identityFixture(t);
  const first = await f.request('GET', '/bridge/v1/device/status', undefined, native);
  assert.equal(first.data.owner_username, users[0].email);
  const count = f.state.requests.filter(r => r.path.includes('/customers/')).length;
  control.device.current_grant_id = 'grant-b'; control.device.selection_version++;
  const changed = await f.request('GET', '/bridge/v1/device/status', undefined, native);
  assert.equal(changed.data.owner_username, users[0].email);
  assert.equal(changed.data.owner_user_id, first.data.owner_user_id);
  assert.equal(f.state.requests.filter(r => r.path.includes('/customers/')).length, count, 'a proven owner is cached independently of account selection');
  await f.restart();
  const restarted = await f.request('GET', '/bridge/v1/device/status', undefined, native);
  assert.equal(restarted.data.owner_username, users[0].email);
  assert.ok(f.state.requests.every(r => r.method === 'GET'), 'no pairing, account change, or model request was sent');
});

test('local login changes refresh without caching email, while disabled and pending local users expose no username', async t => {
  const { f, control, users } = await identityFixture(t);
  assert.equal((await f.request('GET', '/bridge/v1/device/status', undefined, native)).data.owner_username, users[0].email);
  f.store.db.prepare('UPDATE users SET email=?,display_name=? WHERE id=?').run('renamed@example.test', 'Not the login', users[0].id);
  control.device.current_grant_id = '';
  const renamed = await f.request('GET', '/bridge/v1/device/status', undefined, native);
  assert.equal(renamed.data.owner_username, 'renamed@example.test');
  assert.equal(renamed.data.current_grant_id, '');
  f.store.db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(users[0].id);
  const disabled = await f.request('GET', '/bridge/v1/device/status', undefined, native);
  assert.equal(disabled.status, 200); assert.equal(Object.hasOwn(disabled.data, 'owner_username'), false);
  f.store.db.prepare("UPDATE users SET status='active',core_pending='{}' WHERE id=?").run(users[0].id);
  const pending = await f.request('GET', '/bridge/v1/device/status', undefined, native);
  assert.equal(pending.status, 200); assert.equal(Object.hasOwn(pending.data, 'owner_username'), false);
});

for (const kind of ['unmapped', 'duplicate-customers', 'duplicate-rows', 'other-customer-unavailable', 'incomplete-total', 'malformed-membership']) {
  test('no username is guessed from ' + kind + ' membership evidence', async t => {
    const { f, control } = await identityFixture(t);
    const rows = control.memberships.get('customer-alice');
    if (kind === 'unmapped') control.device.id = 'other-device-with-same-name';
    if (kind === 'duplicate-customers') control.memberships.set('customer-bob', rows);
    if (kind === 'duplicate-rows') rows.push({ ...rows[0] });
    if (kind === 'other-customer-unavailable') control.lookup = ({ customer, json }) => { if (customer === 'customer-bob') { json({ code: 'unavailable' }, 503); return true; } };
    if (kind === 'incomplete-total') control.lookup = ({ customer, json }) => { if (customer === 'customer-bob') { json({ devices: [], total: 1, next_cursor: '' }); return true; } };
    if (kind === 'malformed-membership') control.memberships.set('customer-bob', [{ name: 'Missing identity' }]);
    const status = await f.request('GET', '/bridge/v1/device/status', undefined, native);
    assert.equal(status.status, 200, status.raw);
    assert.equal(Object.hasOwn(status.data, 'owner_username'), false, status.raw);
    assert.equal(Object.hasOwn(status.data, 'owner_display_name'), false);
    assert.equal(status.raw.includes('PRIVATE_'), false);
    const count = f.state.requests.filter(r => r.path.includes('/customers/')).length;
    assert.equal((await f.request('GET', '/bridge/v1/device/status', undefined, native)).status, 200);
    assert.equal(f.state.requests.filter(r => r.path.includes('/customers/')).length, count, 'failed lookups are briefly cooled down, not endlessly replayed');
  });
}

test('only an approved, unexpired native owner triggers local membership reads', async t => {
  const { f, control } = await identityFixture(t);
  const original = { ...control.device };
  for (const patch of [{ state: 'pending' }, { state: 'revoked' }, { expires_at: '2000-01-01T00:00:00Z' }, { expires_at: 'invalid' }, { owner_user_id: null }, { id: '../wrong' }]) {
    control.device = { ...original, ...patch };
    const status = await f.request('GET', '/bridge/v1/device/status', undefined, native);
    assert.equal(status.status, 200, status.raw);
    assert.equal(Object.hasOwn(status.data, 'owner_username'), false);
  }
  assert.equal(f.state.requests.some(r => r.path.includes('/customers/')), false);
});

test('a different provider owner or device does not reuse a proven username', async t => {
  const { f, control, users } = await identityFixture(t);
  assert.equal((await f.request('GET', '/bridge/v1/device/status', undefined, native)).data.owner_username, users[0].email);
  control.device.owner_user_id = 'other-provider-owner';
  control.memberships.set('customer-bob', control.memberships.get('customer-alice'));
  assert.equal(Object.hasOwn((await f.request('GET', '/bridge/v1/device/status', undefined, native)).data, 'owner_username'), false);
  control.device.id = 'other-device';
  assert.equal(Object.hasOwn((await f.request('GET', '/bridge/v1/device/status', undefined, native)).data, 'owner_username'), false);
});

test('local user changes during membership retrieval discard the result', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const { f, control, users } = await identityFixture(t);
  control.lookup = async ({ customer }) => { if (customer === 'customer-alice') { entered(); await gate; } };
  const request = f.request('GET', '/bridge/v1/device/status', undefined, native);
  await started;
  f.store.db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(users[0].id);
  release();
  const status = await request;
  assert.equal(status.status, 200, status.raw);
  assert.equal(Object.hasOwn(status.data, 'owner_username'), false);
});

test('concurrent status reads share one bounded membership lookup', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const { f, control, users } = await identityFixture(t);
  control.lookup = async ({ customer }) => { if (customer === 'customer-alice') { entered(); await gate; } };
  const requests = [f.request('GET', '/bridge/v1/device/status', undefined, native), f.request('GET', '/bridge/v1/device/status', undefined, native)];
  await started;
  await new Promise(resolve => setTimeout(resolve, 30));
  release();
  for (const status of await Promise.all(requests)) assert.equal(status.data.owner_username, users[0].email);
  assert.equal(f.state.requests.filter(r => /\/customers\/[^/]+\/devices(?:\?|$)/.test(r.path)).length, 2);
});

test('identity lookup timeout does not replace a successful native status or replay writes', async t => {
  const { f, control } = await identityFixture(t, { env: { UPSTREAM_TIMEOUT_MS: '400' } });
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  control.lookup = async () => { await gate; };
  let status;
  try { status = await f.request('GET', '/bridge/v1/device/status', undefined, native); }
  finally { finish(); }
  assert.equal(status.status, 200, status.raw);
  assert.equal(status.data.state, 'approved');
  assert.equal(status.data.current_grant_id, 'grant-a');
  assert.equal(Object.hasOwn(status.data, 'owner_username'), false);
  assert.ok(f.state.requests.every(r => r.method === 'GET'));
});

test('membership discovery is bounded when the local customer inventory exceeds its budget', async t => {
  const { f } = await identityFixture(t);
  f.store.transaction(() => {
    for (let i = 0; i < 499; i++) {
      const user = f.store.createUser({ email: 'extra-' + i + '@example.test', display_name: 'Extra', password_hash: 'unused-test-hash', role: 'member', status: 'active' });
      f.store.db.prepare('UPDATE users SET core_customer_id=? WHERE id=?').run('extra-customer-' + i, user.id);
    }
  });
  const status = await f.request('GET', '/bridge/v1/device/status', undefined, native);
  assert.equal(status.status, 200, status.raw);
  assert.equal(Object.hasOwn(status.data, 'owner_username'), false);
  assert.equal(f.state.requests.some(r => r.path.includes('/customers/')), false);
});

test('the complete customer device pages, not just the first page, establish ownership', async t => {
  const { f, control, users } = await identityFixture(t);
  control.lookup = ({ customer, url, json }) => {
    if (customer !== 'customer-alice') return;
    if (!url.searchParams.has('cursor')) json({ devices: [], total: 1, next_cursor: 'next-page' });
    else json({ devices: control.memberships.get(customer), total: 1, next_cursor: '' });
    return true;
  };
  const status = await f.request('GET', '/bridge/v1/device/status', undefined, native);
  assert.equal(status.status, 200, status.raw); assert.equal(status.data.owner_username, users[0].email);
  assert.equal(f.state.requests.filter(r => r.path.includes('cursor=next-page')).length, 1);
});

test('too many observed devices remain unknown instead of accepting an early match', async t => {
  const { f, control } = await identityFixture(t);
  control.memberships.set('customer-bob', Array.from({ length: 10000 }, (_, i) => ({ id: 'other-' + i })));
  const status = await f.request('GET', '/bridge/v1/device/status', undefined, native);
  assert.equal(status.status, 200, status.raw); assert.equal(Object.hasOwn(status.data, 'owner_username'), false);
});

test('the installed CCB binary reads the Merchant local username through the real status contract', { skip: !process.env.CCB_RUNTIME_TEST_BINARY }, async t => {
  const { execFile } = await import('node:child_process');
  const { mkdir } = await import('node:fs/promises');
  const { join, isAbsolute } = await import('node:path');
  assert.ok(isAbsolute(process.env.CCB_RUNTIME_TEST_BINARY), 'the optional native test requires an explicit executable path');
  const { f, control, users } = await identityFixture(t);
  control.device.current_grant_id = 'grant-1';
  const home = join(f.root, 'isolated-ccb-home'); await mkdir(home);
  const token = 'b'.repeat(64);
  const report = await new Promise((resolve, reject) => execFile(process.env.CCB_RUNTIME_TEST_BINARY, ['status', '--json'], {
    cwd: home, windowsHide: true, timeout: 20000, encoding: 'utf8', maxBuffer: 1024 * 1024,
    env: { ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), HOME: home, USERPROFILE: home, CCB_HOME: home, CCB_GATEWAY_URL: f.config.publicOrigin, CCB_DEVICE_TOKEN: token },
  }, (error, stdout) => { if (error) reject(error); else resolve(JSON.parse(stdout)); }));
  assert.equal(report.device.owner_username, users[0].email);
  assert.equal(report.device.active, true);
  assert.match(report.device.owner_user_id, /^merchant_[a-f0-9]{64}$/);
  assert.equal(report.account.name, '账号（编号待核对）');
  assert.equal(JSON.stringify(report).includes('PRIVATE_'), false);
  assert.ok(f.state.requests.every(r => r.method === 'GET'), 'the installed CLI only performs isolated reads');
  assert.ok(f.state.requests.filter(r => r.path.startsWith('/bridge/')).every(r => r.headers.authorization === 'Bearer ' + token));
});

test('proofs expire, are bounded, and cannot cross a changed provider configuration', async t => {
  const { Devices } = await import('../../src/devices.js');
  const { f, control, users } = await identityFixture(t);
  const config = { upstreamUrl: 'https://provider.invalid', upstreamKey: 'synthetic-provider-key', upstreamTimeoutMs: 3000 };
  let calls = 0, matched = control.device.id;
  const core = { config, request: async (method, path) => {
    calls++; assert.equal(method, 'GET');
    const rows = path.includes('/customer-alice/') && matched ? [{ id: matched, state: 'approved', expires_at: control.device.expires_at }] : [];
    return { devices: rows, next_cursor: '', total: rows.length };
  } };
  const service = new Devices(f.store, core);
  assert.equal(await service.runtimeUsername(control.device, { ...config }), users[0].email);
  assert.equal(calls, 2);
  assert.equal(await service.runtimeUsername(control.device, { ...config }), users[0].email);
  assert.equal(calls, 2);
  for (const proof of service.runtimeOwners.values()) proof.until = Date.now() - 1;
  matched = null;
  assert.equal(await service.runtimeUsername(control.device, { ...config }), undefined);
  assert.equal(calls, 4, 'expired proof is rechecked, not silently reused');
  const previous = { ...config };
  config.upstreamKey = 'different-synthetic-key';
  assert.equal(await service.runtimeUsername(control.device, previous), undefined);
  assert.equal(calls, 4, 'stale provider context never triggers a query against the new provider');
  for (let i = 0; i < 260; i++) {
    matched = 'bounded-device-' + i;
    assert.equal(await service.runtimeUsername({ ...control.device, id: matched }, { ...config }), users[0].email);
  }
  assert.equal(service.runtimeOwners.size, 256);
  assert.ok([...service.runtimeOwners.values()].every(proof => !JSON.stringify(proof).includes('@')), 'the cache does not retain login emails');
});

test('cancelled and excess concurrent identity lookups never release a username or exceed admission', async t => {
  const { Devices } = await import('../../src/devices.js');
  const { f, control } = await identityFixture(t);
  const config = { upstreamUrl: 'https://provider.invalid', upstreamKey: 'synthetic-provider-key', upstreamTimeoutMs: 3000 };
  let calls = 0, cancelled = 0;
  const core = { config, request: async (_method, _path, _body, signal) => {
    calls++;
    await new Promise((_, reject) => signal.addEventListener('abort', () => { cancelled++; reject(new Error('cancelled')); }, { once: true }));
  } };
  const service = new Devices(f.store, core), controller = new AbortController();
  const first = service.runtimeUsername(control.device, config, controller.signal);
  const second = service.runtimeUsername({ ...control.device, id: 'second-device' }, config, controller.signal);
  assert.equal(await service.runtimeUsername({ ...control.device, id: 'third-device' }, config, controller.signal), undefined);
  assert.equal(calls, 4, 'two admitted lookups each read two customer scopes');
  controller.abort();
  assert.deepEqual(await Promise.all([first, second]), [undefined, undefined]);
  assert.equal(cancelled, 4);
  assert.equal(service.runtimeLookups.size, 0);
});
