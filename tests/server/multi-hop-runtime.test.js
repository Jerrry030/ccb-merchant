import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { fixture, password, upstreamKey } from './fixtures.js';
import { accessScopes } from '../../src/access.js';

// These are three real Merchant HTTP servers and SQLite stores. Only the final
// provider is synthetic: this exercises the existing runtime path, not account
// custody, recursive inventory allocation, or a real Core / upstream login.
async function multiHop(t, { streaming = false, limits = false, conditional = true } = {}) {
  const nodes = [];
  let rootClosed;
  const streamClosed = new Promise(resolve => { rootClosed = resolve; });
  let selected = null;
  let revision = 0;
  const provider = { conditional, selectionError: null };
  const expiry = new Date(Date.now() + 3600000).toISOString();
  const first = await fixture(t, {
    env: { UPSTREAM_TIMEOUT_MS: '5000', RUNTIME_HEADER_TIMEOUT_MS: '5000' },
    onCore: ({ req, res, url, body, json, state }) => {
      if (!url.pathname.startsWith('/bridge/v1/')) return false;
      assert.equal(req.headers['x-ccb-access-key'], upstreamKey);
      if(url.pathname==='/bridge/v1/code') {
        json({version:'0.1.0-bridge.1',os:'windows',arch:'amd64',size:12,sha256:createHash('sha256').update('PK-MULTIHOP!').digest('hex'),private_path:'/provider/private'});
      } else if(url.pathname==='/bridge/v1/code/download') {
        res.writeHead(200,{'Content-Type':'application/zip','Content-Length':'12'});res.end('PK-MULTIHOP!');
      } else if (url.pathname === '/bridge/v1/device/start') {
        json({ code: 'MULTIHOP123', verification_path: '/connect', expires_at: expiry, interval: 3 }, 201);
      } else if (url.pathname === '/bridge/v1/device/account') {
        assert.deepEqual(Object.keys(body).sort(),['expected_selection_version','grant_id']);
        if(body.expected_selection_version!==revision){json({code:'device_stale',error:'PRIVATE_REVISION_DIAGNOSTIC'},409);return true;}
        if(provider.selectionError){json({code:provider.selectionError,error:'PRIVATE_ACCOUNT_DIAGNOSTIC'},409);return true;}
        assert.ok(state.grants.some(grant=>grant.id===body.grant_id));
        if(selected!==body.grant_id)revision++;
        selected=body.grant_id;
        json({current_grant_id:selected,selection_version:revision});
      } else if (url.pathname === '/bridge/v1/device/status') {
        json({ id: 'provider-device', state: 'approved', owner_user_id: 'PRIVATE_PROVIDER_OWNER', owner_username: 'PRIVATE_PROVIDER_LOGIN', owner_display_name: 'PRIVATE_PROVIDER_DISPLAY', current_grant_id: selected, selection_version: revision, expires_at: expiry });
      } else if (url.pathname === '/bridge/v1/accounts') {
        json({accounts:state.grants.map(grant=>({id:grant.id,grant_id:grant.id,name:'PRIVATE_PROVIDER_ACCOUNT',account_lease_id:'PRIVATE_PROVIDER_LEASE',state:'available',expires_at:expiry})),current_grant_id:selected,selection_version:revision,...(provider.conditional===undefined?{}:{conditional_selection:provider.conditional})});
      } else if (url.pathname === '/bridge/v1/messages') {
        if(limits){
          const code=body.limit_code,headers={'Content-Type':'application/json','Retry-After':'60','X-Should-Retry':'false','Anthropic-Ratelimit-Unified-Secret':'PRIVATE'};
          if(code==='rate_limit_error')Object.assign(headers,{'Anthropic-Ratelimit-Unified-Status':'rejected','Anthropic-Ratelimit-Unified-Representative-Claim':'seven_day','Anthropic-Ratelimit-Unified-Reset':'1793548800'});
          res.writeHead(429,headers);res.end(JSON.stringify({type:'error',error:{type:'rate_limit_error',code,message:'PRIVATE_PROVIDER_DIAGNOSTIC'}}));return true;
        }
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
  const chosen = await leaf.f.request('POST', '/bridge/v1/device/account', { grant_id: granted.data.grant.id, expected_selection_version:0 }, native);
  assert.equal(chosen.status, 200, chosen.raw);
  assert.equal(chosen.data.current_grant_id, granted.data.grant.id);
  return { nodes, first, leaf, native, token, grant: granted.data.grant, customer: made.data.customer, streamClosed, provider };
}

test('runtime traverses C, B and A with per-hop keys and mapped identities, without a direct-provider bypass', { timeout: 20000 }, async t => {
  const chain = await multiHop(t);
  const { first, leaf, nodes, native, token, grant } = chain;
  const status = await leaf.f.request('GET', '/bridge/v1/device/status', undefined, native);
  assert.equal(status.status, 200, status.raw);
  assert.equal(Object.hasOwn(status.data, 'owner_username'), false, 'a downstream service receives no provider or intermediate login name');
  assert.equal(Object.hasOwn(status.data, 'owner_display_name'), false);
  assert.equal(status.raw.includes('PRIVATE_PROVIDER'), false);
  const list = await leaf.f.request('GET', '/bridge/v1/accounts', undefined, native);
  assert.equal(list.status, 200, list.raw);
  assert.equal(list.data.conditional_selection,true);
  assert.deepEqual(list.data.accounts.map(account => account.id), [grant.id]);
  assert.equal(list.data.current_grant_id, grant.id);
  assert.equal(list.data.accounts[0].name, leaf.resource.name);
  assert.equal(list.data.account_name, leaf.resource.name);
  assert.equal(list.raw.includes('PRIVATE_PROVIDER'), false);
  assert.equal(Object.hasOwn(list.data.accounts[0], 'account_lease_id'), false);

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

test('quota errors and retry controls survive three Merchant privacy boundaries without replay', { timeout:20000 },async t=>{
 const {first,leaf,nodes,native}=await multiHop(t,{limits:true});
 let attempts=0;
 for(const code of ['rate_limit_error','grant_usage_limit_exceeded','rate_limited','concurrency_limited']){
  const result=await leaf.f.request('POST','/bridge/v1/messages',{model:'synthetic',limit_code:code},native);
  assert.equal(result.status,429);assert.equal(result.data.type,'error');assert.equal(result.data.error.code,code);
  assert.equal(result.data.error.type,code==='grant_usage_limit_exceeded'?'rate_limit_error':code);
  assert.equal(result.headers.get('retry-after'),'60');assert.equal(result.headers.get('x-should-retry'),'false');
  assert.equal(result.headers.get('anthropic-ratelimit-unified-status'),code==='rate_limit_error'?'rejected':null);
  assert.equal(result.headers.get('anthropic-ratelimit-unified-secret'),null);assert.equal(result.raw.includes('PRIVATE'),false);
  attempts++;
  for(const node of nodes)assert.equal(node.received.filter(row=>row.path==='/bridge/v1/messages').length,attempts);
  assert.equal(first.state.requests.filter(row=>row.path==='/bridge/v1/messages').length,attempts);
 }
});

test('conditional selection capability, revisions and safe errors survive every Merchant hop without replay', { timeout:20000 }, async t => {
  const {first,leaf,nodes,native,grant,provider}=await multiHop(t);
  // Seed a second authorized mapping with no selection/binding history at any hop.
  let remoteB='provider-unused-b',remoteResource='provider-unused-resource';
  first.state.grants.push({...first.state.grants[0],id:remoteB,resource_id:remoteResource});
  for(const [index,node] of nodes.entries()){
    const resource=node.f.store.db.prepare('SELECT * FROM access_resources').get();
    const localResource='unused-resource-'+index;const resourceCopy={...resource,id:localResource,upstream_id:remoteResource};
    const resourceColumns=Object.keys(resourceCopy);
    node.f.store.db.prepare('INSERT INTO access_resources('+resourceColumns.join(',')+') VALUES('+resourceColumns.map(()=>'?').join(',')+')').run(...Object.values(resourceCopy));
    remoteResource=localResource;
    const row=node.f.store.db.prepare('SELECT * FROM access_grants').get();
    const localB='unused-b-'+index;const copy={...row,id:localB,upstream_id:remoteB,resource_id:localResource};
    const columns=Object.keys(copy);
    node.f.store.db.prepare('INSERT INTO access_grants('+columns.join(',')+') VALUES('+columns.map(()=>'?').join(',')+')').run(...Object.values(copy));
    remoteB=localB;
  }
  const unusedB=remoteB;
  const firstSelection=first.state.requests.find(row=>row.path==='/bridge/v1/device/account');
  assert.equal(firstSelection.body.expected_selection_version,0);
  const before=await leaf.f.request('GET','/bridge/v1/accounts',undefined,native);
  assert.equal(before.data.conditional_selection,true);
  assert.deepEqual(before.data.accounts.map(row=>row.id).sort(),[grant.id,unusedB].sort());
  assert.equal(before.data.accounts.find(row=>row.id===unusedB).quota,undefined,'unknown quota does not remove unused B');
  const revision=before.data.selection_version;
  const count=first.state.requests.filter(row=>row.path==='/bridge/v1/device/account').length;
  for(const body of [{grant_id:grant.id},{grant_id:grant.id,expected_selection_version:null},{grant_id:grant.id,expected_selection_version:-1},{grant_id:grant.id,expected_selection_version:0.5},{grant_id:grant.id,expected_selection_version:'1'}]){
    const invalid=await leaf.f.request('POST','/bridge/v1/device/account',body,native);assert.equal(invalid.status,400,invalid.raw);
  }
  assert.equal(first.state.requests.filter(row=>row.path==='/bridge/v1/device/account').length,count);
  const stale=await leaf.f.request('POST','/bridge/v1/device/account',{grant_id:unusedB,expected_selection_version:revision-1},native);
  assert.equal(stale.status,409);assert.equal(stale.data.error.code,'device_stale');assert.equal(stale.raw.includes('PRIVATE'),false);
  assert.equal(first.state.requests.filter(row=>row.path==='/bridge/v1/device/account').length,count+1);
  for(const code of ['account_unavailable','account_device_limit','grant_stale']){
    provider.selectionError=code;
    const rejected=await leaf.f.request('POST','/bridge/v1/device/account',{grant_id:unusedB,expected_selection_version:revision},native);
    assert.equal(rejected.status,409);assert.equal(rejected.data.error.code,code);assert.equal(rejected.raw.includes('PRIVATE'),false);
  }
  for(const node of nodes)assert.equal(node.received.filter(row=>row.path==='/bridge/v1/device/account').length,node===leaf?10:5);
  assert.equal(first.state.requests.filter(row=>row.path==='/bridge/v1/device/account').length,count+4);
  const after=await leaf.f.request('GET','/bridge/v1/accounts',undefined,native);assert.equal(after.data.selection_version,revision);assert.equal(after.data.current_grant_id,grant.id);
  provider.selectionError=null;
  const selected=await leaf.f.request('POST','/bridge/v1/device/account',{grant_id:unusedB,expected_selection_version:revision},native);
  assert.equal(selected.status,200,selected.raw);assert.equal(selected.data.current_grant_id,unusedB);assert.equal(selected.data.selection_version,revision+1);
  const written=first.state.requests.filter(row=>row.path==='/bridge/v1/device/account');assert.equal(written.length,count+5);assert.equal(written.at(-1).body.grant_id,'provider-unused-b');assert.equal(written.at(-1).body.expected_selection_version,revision);
  for(const unsupported of [false,undefined,'true']){
    provider.conditional=unsupported;
    const list=await leaf.f.request('GET','/bridge/v1/accounts',undefined,native);assert.notEqual(list.data.conditional_selection,true);
  }
});

test('Code packages cross three real Merchant boundaries without JSON rewriting of bytes',async t=>{
 const {leaf,native}=await multiHop(t);
 const metadata=await leaf.f.request('GET','/bridge/v1/code?os=windows&arch=amd64',undefined,native);
 assert.equal(metadata.status,200);assert.equal(metadata.data.version,'0.1.0-bridge.1');assert.equal(metadata.raw.includes('private'),false);
 const downloaded=await fetch(leaf.f.config.publicOrigin+'/bridge/v1/code/download?os=windows&arch=amd64&version=0.1.0-bridge.1',{headers:native.headers});
 assert.equal(downloaded.status,200);const bytes=Buffer.from(await downloaded.arrayBuffer());assert.equal(bytes.toString(),'PK-MULTIHOP!');assert.equal(createHash('sha256').update(bytes).digest('hex'),metadata.data.sha256);
});
