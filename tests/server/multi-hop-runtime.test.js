import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { fixture, password, upstreamKey } from './fixtures.js';
import { accessScopes } from '../../src/access.js';

// These are three real Merchant HTTP servers and SQLite stores. Only the final
// provider is synthetic: this exercises the existing runtime path, not account
// custody, recursive inventory allocation, or a real Core / upstream login.
async function multiHop(t, { streaming = false } = {}) {
  const nodes = [];
  let rootClosed;
  const streamClosed = new Promise(resolve => { rootClosed = resolve; });
  let selected = null;
  const expiry = new Date(Date.now() + 3600000).toISOString();
  const first = await fixture(t, {
    env: { UPSTREAM_TIMEOUT_MS: '5000', RUNTIME_HEADER_TIMEOUT_MS: '5000' },
    onCore: ({ req, res, url, body, json, state }) => {
      if (!url.pathname.startsWith('/bridge/v1/')) return false;
      assert.equal(req.headers['x-ccb-access-key'], upstreamKey);
      if (url.pathname === '/bridge/v1/device/start') {
        json({ code: 'MULTIHOP123', verification_path: '/connect', expires_at: expiry, interval: 3 }, 201);
      } else if (url.pathname === '/bridge/v1/device/account') {
        assert.ok(state.grants.some(grant => grant.id === body.grant_id));
        selected = body.grant_id;
        json({ current_grant_id: selected, selection_version: 1 });
      } else if (url.pathname === '/bridge/v1/device/status') {
        json({ id: 'provider-device', state: 'approved', current_grant_id: selected, selection_version: 1, expires_at: expiry });
      } else if (url.pathname === '/bridge/v1/accounts') {
        json({ accounts: state.grants.map(grant => ({ id: grant.id, grant_id: grant.id, name: 'Provider account', state: 'available', expires_at: expiry })), current_grant_id: selected, selection_version: 1 });
      } else if (url.pathname === '/bridge/v1/messages') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('event: message_start\ndata: {"id":"synthetic-message"}\n\n');
        if (streaming) res.once('close', rootClosed);
        else res.end('event: message_stop\ndata: {}\n\n');
      } else return false;
      return true;
    },
  });
  let sourceResource = 'resource-1';
  let upstream;
  for (const [index, name] of ['a', 'b', 'c'].entries()) {
    const f = index === 0 ? first : await fixture(t, {
      env: {
        UPSTREAM_URL: upstream.f.config.publicOrigin,
        UPSTREAM_API_KEY: upstream.key.token,
        UPSTREAM_TIMEOUT_MS: '5000',
        RUNTIME_HEADER_TIMEOUT_MS: '5000',
      },
    });
    const received = [];
    f.server.prependListener('request', req => {
      if (req.url.startsWith('/bridge/')) received.push({ method: req.method, path: req.url, headers: { ...req.headers } });
    });
    const admin = await f.request('POST', '/api/setup', {
      setup_token: f.setupToken, email: `${name}@merchant.example.test`, display_name: `Private ${name}`, password,
    });
    assert.equal(admin.status, 201, admin.raw);
    const created = await f.request('POST', '/api/admin/access-accounts', { slug: `child-of-${name}`, name: `Private child of ${name}` }, admin);
    assert.equal(created.status, 201, created.raw);
    const account = created.data.account;
    const offered = await f.request('POST', `/api/admin/access-accounts/${account.id}/resources`, { upstream_id: sourceResource, name: `Offer from ${name}`, expires_at: expiry }, admin);
    assert.equal(offered.status, 201, offered.raw);
    const issued = await f.request('POST', `/api/admin/access-accounts/${account.id}/keys`, { name: `Only ${name}'s direct child`, scopes: accessScopes }, admin);
    assert.equal(issued.status, 201, issued.raw);
    upstream = { f, admin, account, key: issued.data, resource: offered.data.resource, received };
    nodes.push(upstream);
    sourceResource = offered.data.resource.id;
  }
  const leaf = nodes.at(-1);
  const actor = { native: true, headers: { Authorization: `Bearer ${leaf.key.token}` } };
  const made = await leaf.f.request('POST', '/access/v1/customers', { external_id: 'terminal-owner', display_name: 'Private terminal owner' }, actor);
  assert.equal(made.status, 201, made.raw);
  const granted = await leaf.f.request('POST', '/access/v1/grants', { customer_id: made.data.customer.id, resource_id: leaf.resource.id, expires_at: expiry }, actor);
  assert.equal(granted.status, 201, granted.raw);
  const token = 'synthetic-multihop-device-token-123456';
  const native = { native: true, headers: { Authorization: `Bearer ${token}`, 'X-CCB-Access-Key': leaf.key.token } };
  const started = await leaf.f.request('POST', '/bridge/v1/device/start', { name: 'Private terminal device', platform: 'windows', token_hash: createHash('sha256').update(token).digest('hex') }, { native: true, headers: { 'X-CCB-Access-Key': leaf.key.token } });
  assert.equal(started.status, 201, started.raw);
  const approved = await leaf.f.request('POST', `/access/v1/customers/${made.data.customer.id}/devices/approve`, { code: started.data.code }, actor);
  assert.equal(approved.status, 200, approved.raw);
  const chosen = await leaf.f.request('POST', '/bridge/v1/device/account', { grant_id: granted.data.grant.id }, native);
  assert.equal(chosen.status, 200, chosen.raw);
  assert.equal(chosen.data.current_grant_id, granted.data.grant.id);
  return { nodes, first, leaf, native, token, grant: granted.data.grant, customer: made.data.customer, streamClosed };
}

test('runtime traverses C, B and A with per-hop keys and mapped identities, without a direct-provider bypass', { timeout: 20000 }, async t => {
  const chain = await multiHop(t);
  const { first, leaf, nodes, native, token, grant } = chain;
  const status = await leaf.f.request('GET', '/bridge/v1/device/status', undefined, native);
  assert.equal(status.status, 200, status.raw);
  const list = await leaf.f.request('GET', '/bridge/v1/accounts', undefined, native);
  assert.equal(list.status, 200, list.raw);
  assert.deepEqual(list.data.accounts.map(account => account.id), [grant.id]);
  assert.equal(list.data.current_grant_id, grant.id);

  const customerIds = new Set([first.state.customers[0].id]);
  const grantIds = new Set([first.state.grants[0].id]);
  const deviceIds = new Set(['provider-device']);
  let providerCustomer = first.state.customers[0].id;
  let providerGrant = first.state.grants[0].id;
  let providerDevice = 'provider-device';
  for (const { f } of nodes) {
    const customer = f.store.db.prepare('SELECT id,upstream_id FROM access_customers').get();
    const g = f.store.db.prepare('SELECT id,upstream_id FROM access_grants').get();
    const device = f.store.db.prepare('SELECT id,upstream_id FROM access_devices').get();
    assert.equal(customer.upstream_id, providerCustomer);
    assert.equal(g.upstream_id, providerGrant);
    assert.equal(device.upstream_id, providerDevice);
    providerCustomer = customer.id; providerGrant = g.id; providerDevice = device.id;
    customerIds.add(customer.id); grantIds.add(g.id); deviceIds.add(device.id);
  }
  assert.equal(customerIds.size, 4); assert.equal(grantIds.size, 4); assert.equal(deviceIds.size, 4);
  assert.ok(deviceIds.has(status.data.id)); assert.notEqual(status.data.id, 'provider-device');

  const payload = '{ "model" : "synthetic", "messages" : [{"role":"user","content":"private bytes"}], "stream":true }';
  const response = await leaf.f.request('POST', '/bridge/v1/messages', payload, { ...native, raw: true });
  assert.equal(response.status, 200, response.raw);
  assert.equal(response.raw, 'event: message_start\ndata: {"id":"synthetic-message"}\n\nevent: message_stop\ndata: {}\n\n');
  for (const node of nodes) {
    const requests = node.received.filter(row => row.path === '/bridge/v1/messages');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].headers['x-ccb-access-key'], node.key.token);
    assert.equal(requests[0].headers.authorization, `Bearer ${token}`);
    assert.equal(requests[0].headers['x-ccb-relay-keys'], undefined);
  }
  const rootRequests = first.state.requests.filter(row => row.path === '/bridge/v1/messages');
  assert.equal(rootRequests.length, 1);
  assert.equal(rootRequests[0].raw.toString(), payload);
  assert.equal(rootRequests[0].headers['x-ccb-access-key'], upstreamKey);
  assert.equal(rootRequests[0].headers.authorization, `Bearer ${token}`);
  assert.equal(rootRequests[0].headers['x-ccb-relay-keys'], undefined);
  for (const node of nodes) assert.equal(JSON.stringify(first.state.requests).includes(node.key.token), false);
  assert.equal(JSON.stringify(first.state.requests).includes('Private terminal owner'), false);
  assert.equal(JSON.stringify(first.state.requests).includes('Private terminal device'), false);
  for (const node of nodes.slice(1)) assert.equal(node.f.state.requests.length, 0, 'a child must use its configured direct provider, not its otherwise available synthetic provider');

  // The same terminal cannot skip its direct providers or reuse C's key at A.
  for (const headers of [{ Authorization: `Bearer ${token}` }, native.headers]) {
    const rejected = await nodes[0].f.request('POST', '/bridge/v1/messages', payload, { native: true, raw: true, headers });
    assert.equal(rejected.status, 401, rejected.raw);
  }
  assert.equal(first.state.requests.filter(row => row.path === '/bridge/v1/messages').length, 1);

  const revoked = await nodes[0].f.request('DELETE', `/api/admin/access-accounts/${nodes[0].account.id}/keys/${nodes[0].key.key.id}`, {}, nodes[0].admin);
  assert.equal(revoked.status, 200, revoked.raw);
  const stopped = await leaf.f.request('POST', '/bridge/v1/messages', payload, { ...native, raw: true });
  assert.ok([401, 403, 409, 503].includes(stopped.status), stopped.raw);
  assert.equal(first.state.requests.filter(row => row.path === '/bridge/v1/messages').length, 1, 'an ancestor rejection must never trigger a bypass or retry');
});

test('a middle-hop key revocation terminates an established stream through every upstream hop', { timeout: 20000 }, async t => {
  const { nodes, first, leaf, native, streamClosed } = await multiHop(t, { streaming: true });
  const body = JSON.stringify({ model: 'synthetic', messages: [], stream: true });
  let call;
  let started;
  const firstChunk = new Promise(resolve => { started = resolve; });
  const finished = new Promise(resolve => {
    call = httpRequest(leaf.f.config.publicOrigin, { method: 'POST', path: '/bridge/v1/messages', headers: { ...native.headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, agent: false }, response => {
      response.once('data', started);
      response.on('data', () => {});
      response.on('error', resolve);
      response.once('close', resolve);
    });
    call.on('error', resolve); call.end(body);
  });
  t.after(() => call.destroy());
  await firstChunk;
  const middle = nodes[1];
  const revoked = await middle.f.request('DELETE', `/api/admin/access-accounts/${middle.account.id}/keys/${middle.key.key.id}`, {}, middle.admin);
  assert.equal(revoked.status, 200, revoked.raw);
  await Promise.all([finished, streamClosed]);
  assert.equal(first.state.requests.filter(row => row.path === '/bridge/v1/messages').length, 1);
});

test('terminal disconnect cancels the stream at the final provider without replay', { timeout: 20000 }, async t => {
  const { first, leaf, native, streamClosed } = await multiHop(t, { streaming: true });
  const body = JSON.stringify({ model: 'synthetic', messages: [], stream: true });
  let call;
  await new Promise((resolve, reject) => {
    call = httpRequest(leaf.f.config.publicOrigin, { method: 'POST', path: '/bridge/v1/messages', headers: { ...native.headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, agent: false }, response => {
      response.once('data', () => { response.destroy(); call.destroy(); resolve(); });
      response.on('error', () => {});
    });
    call.on('error', reject); call.end(body);
  });
  t.after(() => call.destroy());
  await streamClosed;
  assert.equal(first.state.requests.filter(row => row.path === '/bridge/v1/messages').length, 1);
});


test('restarting a middle merchant preserves per-hop ownership mappings and does not re-create grants', { timeout: 20000 }, async t => {
  const { nodes, first, leaf, native, grant } = await multiHop(t);
  const middle = nodes[1];
  const before = {
    customers: middle.f.store.db.prepare('SELECT id,account_id,upstream_id FROM access_customers ORDER BY id').all(),
    grants: middle.f.store.db.prepare('SELECT id,account_id,customer_id,upstream_id FROM access_grants ORDER BY id').all(),
    devices: middle.f.store.db.prepare('SELECT id,account_id,customer_id,upstream_id,current_grant_id FROM access_devices ORDER BY id').all(),
  };
  const creates = first.state.requests.filter(row => row.method === 'POST' && ['/access/v1/customers', '/access/v1/grants'].includes(row.path)).length;
  await middle.f.restart();
  assert.deepEqual(middle.f.store.db.prepare('SELECT id,account_id,upstream_id FROM access_customers ORDER BY id').all(), before.customers);
  assert.deepEqual(middle.f.store.db.prepare('SELECT id,account_id,customer_id,upstream_id FROM access_grants ORDER BY id').all(), before.grants);
  assert.deepEqual(middle.f.store.db.prepare('SELECT id,account_id,customer_id,upstream_id,current_grant_id FROM access_devices ORDER BY id').all(), before.devices);
  const listed = await leaf.f.request('GET', '/bridge/v1/accounts', undefined, native);
  assert.equal(listed.status, 200, listed.raw);
  assert.deepEqual(listed.data.accounts.map(account => account.id), [grant.id]);
  assert.equal(listed.data.current_grant_id, grant.id);
  const result = await leaf.f.request('POST', '/bridge/v1/messages', { model: 'synthetic', messages: [], stream: true }, native);
  assert.equal(result.status, 200, result.raw);
  assert.equal(first.state.requests.filter(row => row.method === 'POST' && ['/access/v1/customers', '/access/v1/grants'].includes(row.path)).length, creates);
  assert.equal(first.state.requests.filter(row => row.path === '/bridge/v1/messages').length, 1);
});
