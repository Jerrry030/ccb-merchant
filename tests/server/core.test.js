import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, password, upstreamKey, now } from './fixtures.js';

const adminInput={email:'admin@example.test',display_name:'Admin',password};
const memberInput={email:'member@example.test',display_name:'Member',password,role:'member'};

test('a core 5xx after a committed write is unknown, not a definite rejection',async t=>{
  let failWrite=true;
  const f=await fixture(t,{onCore:async({req,url,body,state,json})=>{
    if(url.pathname==='/access/v1/grants' && req.method==='POST' && failWrite) {
      state.grants.push({id:'grant-after-500',customer_id:body.customer_id,resource_id:body.resource_id,name:'Code',status:'active',surfaces:['code'],expires_at:null,revision:1,updated_at:now});
      json({error:{message:'PRIVATE_UPSTREAM_DETAIL'}},500);return true;
    }
    if(url.pathname==='/access/v1/resources') {json({error:{}},503);return true;}
  }});
  const admin=await f.request('POST','/api/setup',{...adminInput,setup_token:f.setupToken});
  const created=await f.request('POST','/api/admin/users',memberInput,admin), id=created.data.user.id;
  assert.equal((await f.request('POST',`/api/admin/users/${id}/provision`,undefined,admin)).status,200);
  const result=await f.request('POST','/api/admin/grants',{user_id:id,resource_id:'resource-1'},admin);
  assert.equal(result.status,503);assert.equal(result.data.error.code,'core_outcome_unknown');
  assert.equal(result.raw.includes('PRIVATE_UPSTREAM_DETAIL'),false);
  assert.equal(f.state.requests.filter(r=>r.method==='POST'&&r.path==='/access/v1/grants').length,1);
  const read=await f.request('GET','/api/admin/resources',undefined,admin);
  assert.equal(read.status,503);assert.equal(read.data.error.code,'core_unavailable');
  const list=await f.request('GET',`/api/admin/grants?user_id=${id}`,undefined,admin);
  assert.equal(list.data.grants[0].id,'grant-after-500');
  failWrite=false;
  assert.equal((await f.request('POST','/api/admin/grants',{user_id:id,resource_id:'resource-1'},admin)).data.grant.id,'grant-after-500');
  assert.equal(f.state.grants.length,1);
});

test('provisioning rechecks administrator identity after awaited core operations',async t=>{
  for(const phase of ['read','create']) await t.test(phase,async t=>{
    let pause=false, entered, release;
    const waiting=new Promise(resolve=>{entered=resolve;});
    const gate=new Promise(resolve=>{release=resolve;});
    const f=await fixture(t,{env:{UPSTREAM_TIMEOUT_MS:'10000'},onCore:async({req,url,body,state,json})=>{
      if(!pause || url.pathname!=='/access/v1/customers') return false;
      if(phase==='read' && req.method==='GET') {entered();await gate;return false;}
      if(phase==='create' && req.method==='POST') {
        const customer={id:'customer-committed',external_id:body.external_id,display_name:body.display_name,status:'active',revision:1,created_at:now};
        state.customers.push(customer);entered();await gate;json({customer},201);return true;
      }
    }});
    const admin=await f.request('POST','/api/setup',{...adminInput,setup_token:f.setupToken});
    await f.request('POST','/api/admin/users',{email:'second-admin@example.test',display_name:'Second admin',password,role:'admin'},admin);
    const second=await f.request('POST','/api/auth/login',{email:'second-admin@example.test',password});
    const created=await f.request('POST','/api/admin/users',memberInput,admin), id=created.data.user.id;
    pause=true;
    const pending=f.request('POST',`/api/admin/users/${id}/provision`,undefined,admin);
    await waiting;
    try {
      assert.equal((await f.request('PATCH',`/api/admin/users/${admin.data.user.id}`,{...({role:'member'}),expected_revision:f.store.db.prepare('SELECT revision FROM users WHERE id=?').get((`/api/admin/users/${admin.data.user.id}`).split('/').at(-1))?.revision},second)).status,200);
    } finally {release();}
    const result=await pending;
    assert.equal(result.status,401);
    assert.equal(f.store.db.prepare('SELECT core_customer_id FROM users WHERE id=?').get(id).core_customer_id,null);
    assert.equal(f.state.customers.length,phase==='read'?0:1);
    pause=false;
    assert.equal((await f.request('POST',`/api/admin/users/${id}/provision`,undefined,second)).status,200);
    assert.equal(f.state.customers.length,1,'the active administrator reconciles rather than creating a duplicate');
  });
});

test('provisioning is immutable/idempotent; core resources, usage, grants are filtered',async t=>{
  const f=await fixture(t), admin=await f.request('POST','/api/setup',{...adminInput,setup_token:f.setupToken});
  const member=await f.request('POST','/api/admin/users',memberInput,admin), id=member.data.user.id;
  assert.equal((await f.request('PATCH',`/api/admin/users/${id}`,{...({core_customer_id:'foreign'}),expected_revision:f.store.db.prepare('SELECT revision FROM users WHERE id=?').get((`/api/admin/users/${id}`).split('/').at(-1))?.revision},admin)).status,400);
  const provision=await f.request('POST',`/api/admin/users/${id}/provision`,undefined,admin);
  assert.equal(provision.status,200);assert.equal(provision.data.customer.external_id,id);assert.equal(provision.raw.includes('LEAK'),false);
  const again=await f.request('POST',`/api/admin/users/${id}/provision`,undefined,admin);
  assert.equal(again.data.customer.id,provision.data.customer.id);
  assert.equal(f.state.requests.filter(r=>r.method==='POST'&&r.path==='/access/v1/customers').length,1);
  assert.throws(()=>f.store.db.prepare('UPDATE users SET core_customer_id=? WHERE id=?').run('other',id),/immutable_customer/);
  const login=await f.request('POST','/api/auth/login',{email:memberInput.email,password});
  const grant=await f.request('POST','/api/admin/grants',{user_id:id,resource_id:'resource-1'},admin);
  assert.equal(grant.status,201);assert.equal(grant.raw.includes('LEAK'),false);
  assert.equal((await f.request('POST','/api/admin/grants',{user_id:id,resource_id:'resource-1'},admin)).data.grant.id,grant.data.grant.id);
  assert.equal(f.state.grants.length,1);
  for(const path of ['/api/admin/connection','/api/admin/resources','/api/admin/grants','/api/admin/settings']) {
    const response=await f.request('GET',path,undefined,admin);assert.equal(response.status,200,path);assert.equal(response.raw.includes('LEAK'),false);assert.equal(response.raw.includes(upstreamKey),false);
  }
  for(const path of ['/api/me/overview','/api/me/grants','/api/me/devices','/api/me/usage?limit=10&offset=0']) {
    const response=await f.request('GET',path,undefined,login);assert.equal(response.status,200,path);assert.equal(response.raw.includes('LEAK'),false);
  }
  const usage=await f.request('GET','/api/me/usage',undefined,login);
  assert.equal(usage.data.usage.cost_usd,4.2);assert.equal(usage.data.requests[0].usage.input_tokens,30);
  assert.equal(usage.data.requests[0].id,'123');assert.equal(usage.data.requests[0].usage.cache_creation_5m,7);assert.equal(usage.data.requests[0].usage.cache_creation_1h,11);
  assert.equal((await f.request('GET','/api/me/wallet',undefined,login)).data.wallet.balance_minor,0,'reference USD must not debit a wallet');
  assert.equal((await f.request('GET','/api/me/usage?limit=1000',undefined,login)).status,400);
  const preview=await f.request('POST','/api/me/devices/preview',{code:'ABC123'},login);assert.equal(preview.status,200);assert.equal(preview.raw.includes('LEAK'),false);
  assert.equal((await f.request('POST','/api/me/devices/approve',{code:'ABC123'},login)).status,200);
  assert.equal((await f.request('DELETE','/api/me/devices/device-1',undefined,login)).status,200);
  assert.equal((await f.request('PATCH',`/api/admin/grants/${grant.data.grant.id}`,{expected_revision:99,status:'revoked'},admin)).data.error.code,'core_conflict');
  assert.equal((await f.request('PATCH',`/api/admin/grants/${grant.data.grant.id}`,{expected_revision:1,status:'revoked'},admin)).data.grant.status,'revoked');
  assert.equal((await f.request('GET','/api/admin/keys',undefined,admin)).status,404);
  for(const request of f.state.requests.filter(r=>r.path.startsWith('/access/'))) {assert.equal(request.headers.authorization,`Bearer ${upstreamKey}`);assert.equal(request.headers.cookie,undefined);}
});

test('customer creation lost response is not blindly retried; external_id reconciles after process restart',async t=>{
  let lose=true;
  const f=await fixture(t,{onCore:async({req,res,url,body,state})=>{
    if(lose&&req.method==='POST'&&url.pathname==='/access/v1/customers') {
      state.customers.push({id:'customer-lost',external_id:body.external_id,display_name:body.display_name,status:'active',revision:1,created_at:now});res.destroy();return true;
    }
  }});
  const admin=await f.request('POST','/api/setup',{...adminInput,setup_token:f.setupToken});
  const member=await f.request('POST','/api/admin/users',memberInput,admin), id=member.data.user.id;
  const lost=await f.request('POST',`/api/admin/users/${id}/provision`,undefined,admin);
  assert.equal(lost.status,503);assert.equal(lost.data.error.code,'core_outcome_unknown');
  assert.equal(f.state.requests.filter(r=>r.method==='POST'&&r.path==='/access/v1/customers').length,1);
  assert.equal(f.store.db.prepare('SELECT core_customer_id FROM users WHERE id=?').get(id).core_customer_id,null);
  lose=false; await f.restart();
  const reconcile=await f.request('POST',`/api/admin/users/${id}/provision`,undefined,admin);
  assert.equal(reconcile.status,200);assert.equal(reconcile.data.user.core_customer_id,'customer-lost');
  assert.equal(f.state.requests.filter(r=>r.method==='POST'&&r.path==='/access/v1/customers').length,1);
});

test('suspension immediately revokes local sessions and gates new runtime until core alignment; re-enable waits for core',async t=>{
  let failPatch=false;
  const f=await fixture(t,{onCore:async({req,res,url})=>{if(failPatch&&req.method==='PATCH'&&url.pathname.startsWith('/access/v1/customers/')){res.destroy();return true;}}});
  const admin=await f.request('POST','/api/setup',{...adminInput,setup_token:f.setupToken});
  const member=await f.request('POST','/api/admin/users',memberInput,admin), id=member.data.user.id;
  await f.request('POST',`/api/admin/users/${id}/provision`,undefined,admin);
  const session=await f.request('POST','/api/auth/login',{email:memberInput.email,password});
  failPatch=true;
  const disabled=await f.request('PATCH',`/api/admin/users/${id}`,{...({status:'disabled'}),expected_revision:f.store.db.prepare('SELECT revision FROM users WHERE id=?').get((`/api/admin/users/${id}`).split('/').at(-1))?.revision},admin);
  assert.equal(disabled.status,503);assert.equal(f.store.db.prepare('SELECT status FROM users WHERE id=?').get(id).status,'disabled');
  assert.equal((await f.request('GET','/api/auth/session',undefined,session)).status,401);
  const before=f.state.requests.length;
  const blocked=await f.request('GET','/bridge/v1/device/status',undefined,{headers:{Authorization:'Bearer original-device-token-fixture'}});
  assert.equal(blocked.data.error.code,'suspension_sync_pending');assert.equal(f.state.requests.length,before);
  await f.restart();
  assert.equal((await f.request('GET','/bridge/v1/device/status',undefined,{headers:{Authorization:'Bearer original-device-token-fixture'}})).status,503);
  failPatch=false;
  const confirmed=await f.request('PATCH',`/api/admin/users/${id}`,{...({status:'disabled'}),expected_revision:f.store.db.prepare('SELECT revision FROM users WHERE id=?').get((`/api/admin/users/${id}`).split('/').at(-1))?.revision},admin);
  assert.equal(confirmed.status,200);assert.equal(f.state.customers[0].status,'disabled');
  assert.equal(f.store.db.prepare('SELECT core_pending FROM users WHERE id=?').get(id).core_pending,null);
  failPatch=true;
  assert.equal((await f.request('PATCH',`/api/admin/users/${id}`,{...({status:'active'}),expected_revision:f.store.db.prepare('SELECT revision FROM users WHERE id=?').get((`/api/admin/users/${id}`).split('/').at(-1))?.revision},admin)).status,503);
  assert.equal((await f.request('POST','/api/auth/login',{email:memberInput.email,password})).status,401);
  failPatch=false;
  assert.equal((await f.request('PATCH',`/api/admin/users/${id}`,{...({status:'active'}),expected_revision:f.store.db.prepare('SELECT revision FROM users WHERE id=?').get((`/api/admin/users/${id}`).split('/').at(-1))?.revision},admin)).status,200);
  assert.equal((await f.request('POST','/api/auth/login',{email:memberInput.email,password})).status,200);
});

test('committed suspension with lost response reconciles by GET without a second write',async t=>{
  let lose=false;
  const f=await fixture(t,{onCore:async({req,res,url,state,body})=>{
    if(lose&&req.method==='PATCH'&&url.pathname.startsWith('/access/v1/customers/')) {
      state.customers[0].status=body.status;state.customers[0].revision++;res.destroy();return true;
    }
  }});
  const admin=await f.request('POST','/api/setup',{...adminInput,setup_token:f.setupToken});
  const member=await f.request('POST','/api/admin/users',memberInput,admin), id=member.data.user.id;
  await f.request('POST',`/api/admin/users/${id}/provision`,undefined,admin);lose=true;
  assert.equal((await f.request('PATCH',`/api/admin/users/${id}`,{...({status:'disabled'}),expected_revision:f.store.db.prepare('SELECT revision FROM users WHERE id=?').get((`/api/admin/users/${id}`).split('/').at(-1))?.revision},admin)).status,503);
  assert.equal((await f.request('PATCH',`/api/admin/users/${id}`,{...({status:'disabled'}),expected_revision:f.store.db.prepare('SELECT revision FROM users WHERE id=?').get((`/api/admin/users/${id}`).split('/').at(-1))?.revision},admin)).status,200);
  assert.equal(f.state.requests.filter(r=>r.method==='PATCH').length,1);
});

test('core errors and redirects never expose secrets or leak the server credential to another origin',async t=>{
  let redirected=false,deny=true;
  const f=await fixture(t,{onCore:async({url,res,json})=>{
    if(deny&&url.pathname==='/access/v1/resources') {json({error:{code:'sql',message:'LEAK DB_PASSWORD and upstream@mail.test'}},503);return true;}
    if(url.pathname==='/access/v1/resources') {res.writeHead(302,{Location:'/credential-capture'});res.end();return true;}
    if(url.pathname==='/credential-capture') {redirected=true;json({keys:[]});return true;}
  }});
  const admin=await f.request('POST','/api/setup',{...adminInput,setup_token:f.setupToken});
  const errors=await f.request('GET','/api/admin/resources',undefined,admin);
  assert.equal(errors.status,503);assert.equal(errors.raw.includes('LEAK'),false);deny=false;
  assert.equal((await f.request('GET','/api/admin/resources',undefined,admin)).status,503);assert.equal(redirected,false);
});

test('grant write lost after commit is surfaced as unknown and safely discoverable by customer/resource',async t=>{
  let lose=true;
  const f=await fixture(t,{onCore:async({req,res,url,body,state})=>{
    if(lose&&req.method==='POST'&&url.pathname==='/access/v1/grants') {
      state.grants.push({id:'grant-lost',customer_id:body.customer_id,resource_id:body.resource_id,name:'Code',surfaces:['code'],status:'active',expires_at:null,revision:1,updated_at:now});res.destroy();return true;
    }
  }});
  const admin=await f.request('POST','/api/setup',{...adminInput,setup_token:f.setupToken});
  const member=await f.request('POST','/api/admin/users',memberInput,admin), id=member.data.user.id;
  await f.request('POST',`/api/admin/users/${id}/provision`,undefined,admin);
  const grant=await f.request('POST','/api/admin/grants',{user_id:id,resource_id:'resource-1'},admin);
  assert.equal(grant.status,503);assert.equal(grant.data.error.code,'core_outcome_unknown');
  assert.equal(f.state.requests.filter(r=>r.method==='POST'&&r.path==='/access/v1/grants').length,1);
  const list=await f.request('GET',`/api/admin/grants?user_id=${id}`,undefined,admin);
  assert.equal(list.data.grants.length,1);assert.equal(list.data.grants[0].id,'grant-lost');
  lose=false;
  assert.equal((await f.request('POST','/api/admin/grants',{user_id:id,resource_id:'resource-1'},admin)).data.grant.id,'grant-lost');
  assert.equal(f.state.grants.length,1);
});


test('usage IDs preserve int64 decimal identity and cache duration facts, rejecting invalid numeric IDs',async t=>{
  let rawId='9223372036854775807';
  const f=await fixture(t,{onCore:async({url,res})=>{
    if(url.pathname.endsWith('/usage')) {
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(`{"usage":{"requests":1,"cost_usd":null},"requests":[{"id":${rawId},"time":"${now}","usage":{"input_tokens":1,"cache_creation_5m":13,"cache_creation_1h":17,"raw":"LEAK"},"cost_usd":null}],"total":1,"limit":200,"next_cursor":""}`);
      return true;
    }
  }});
  const admin=await f.request('POST','/api/setup',{...adminInput,setup_token:f.setupToken});
  await f.request('POST',`/api/admin/users/${admin.data.user.id}/provision`,undefined,admin);
  const large=await f.request('GET','/api/me/usage',undefined,admin);
  assert.equal(large.status,200);assert.equal(large.data.requests[0].id,'9223372036854775807');
  assert.equal(large.data.requests[0].usage.cache_creation_5m,13);assert.equal(large.data.requests[0].usage.cache_creation_1h,17);
  assert.equal(large.raw.includes('LEAK'),false);
  rawId='42';assert.equal((await f.request('GET','/api/me/usage',undefined,admin)).data.requests[0].id,'42');
  rawId='1.25';assert.equal((await f.request('GET','/api/me/usage',undefined,admin)).status,503);
  rawId='null';assert.equal((await f.request('GET','/api/me/usage',undefined,admin)).status,503);
});
