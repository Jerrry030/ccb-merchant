import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,password} from './fixtures.js';

test('inventory is admin-only, exposes upstream-allocated accounts and never requests a purchase balance',async t=>{
 const f=await fixture(t);
 const admin=await f.request('POST','/api/setup',{setup_token:f.setupToken,email:'admin@example.test',password,display_name:'Owner'});
 await f.request('POST','/api/admin/users',{email:'member@example.test',password,display_name:'Member',role:'member'},admin);
 const member=await f.request('POST','/api/auth/login',{email:'member@example.test',password});
 assert.equal((await f.request('GET','/api/admin/inventory',undefined,member)).status,403);
 const view=await f.request('GET','/api/admin/inventory',undefined,admin);assert.equal(view.status,200,view.raw);assert.equal(view.data.accounts.length,5);assert.equal(view.data.device_limit,1);assert.ok(!view.raw.includes('LEAK'));assert.ok(!Object.hasOwn(view.data,'balance_minor'));
 for(const path of ['/api/admin/purchases','/api/admin/purchases/old/reconcile'])assert.equal((await f.request('POST',path,{},admin)).status,404);
 assert.equal((await f.request('GET','/api/admin/procurement',undefined,admin)).status,404);
 assert.equal(f.state.requests.some(r=>r.path.includes('/purchases')||r.path.endsWith('/balance')),false);
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM ledger').get().n,0);
 assert.equal(f.store.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='procurement_orders'").get(),undefined);
});

test('retired procurement history is preserved on reopen without being an active payment workflow',async t=>{
 const f=await fixture(t);const admin=await f.request('POST','/api/setup',{setup_token:f.setupToken,email:'admin@example.test',password,display_name:'Owner'});
 f.store.db.exec("CREATE TABLE procurement_orders(id TEXT PRIMARY KEY, receipt TEXT);INSERT INTO procurement_orders VALUES('old-order','retained historical receipt')");
 await f.restart();assert.equal(f.store.db.prepare('SELECT receipt FROM procurement_orders WHERE id=?').get('old-order').receipt,'retained historical receipt');
 assert.equal((await f.request('GET','/api/admin/inventory',undefined,admin)).status,200);
});

test('upstream quote refresh updates cost but never overwrites the local retail price or term',async t=>{
 let revision=1,cost=1000;
 const f=await fixture(t,{onCore:({url,json})=>{if(url.pathname==='/access/v1/resources'){json({resources:[{id:'resource-1',name:'Pool',kind:'subscription',status:'active',available:true,surfaces:['code'],plans:[{id:'source-plan',duration_days:90,amount_minor:cost,revision,status:'active'}],stock:[]}]});return true;}}});
 const admin=await f.request('POST','/api/setup',{setup_token:f.setupToken,email:'admin@example.test',password,display_name:'Owner'});
 let plans=await f.request('GET','/api/admin/plans',undefined,admin);assert.equal(plans.status,200,plans.raw);const plan=plans.data.plans[0];
 const edited=await f.request('PATCH',`/api/admin/plans/${plan.id}`,{name:'Local 7 days',description:'retail',duration_days:7,amount_minor:550,status:'active',expected_revision:plan.revision},admin);assert.equal(edited.status,200,edited.raw);
 revision=2;cost=1500;plans=await f.request('GET','/api/admin/plans',undefined,admin);assert.equal(plans.data.plans[0].amount_minor,550);assert.equal(plans.data.plans[0].duration_days,7);assert.equal(plans.data.plans[0].cost_minor,1500);assert.equal(plans.data.plans[0].revision,edited.data.plan.revision);
});

test('public scope is not retail stock until the operator has allocated accounts',async t=>{
 const f=await fixture(t,{inventory:[]});const admin=await f.request('POST','/api/setup',{setup_token:f.setupToken,email:'admin@example.test',password,display_name:'Owner'});
 const created=await f.request('POST','/api/admin/plans',{name:'Seven days',resource_id:'resource-1',description:'',duration_days:7,amount_minor:300,status:'active'},admin);assert.equal(created.status,201,created.raw);
 const list=await f.request('GET','/api/plans',undefined,admin);assert.equal(list.status,200,list.raw);assert.deepEqual(list.data.plans[0].platforms,[]);
});


test('manual subscription delivery synchronizes an unprovisioned customer, fences retries and supports reclaim/reassignment',async t=>{
 const f=await fixture(t),admin=await f.request('POST','/api/setup',{setup_token:f.setupToken,email:'admin@example.test',password,display_name:'Owner'});
 const member=await f.request('POST','/api/admin/users',{email:'buyer@example.test',password,display_name:'Buyer',role:'member'},admin),id=member.data.user.id;
 const login=await f.request('POST','/api/auth/login',{email:'buyer@example.test',password});
 assert.deepEqual((await f.request('GET','/api/me/accounts',undefined,login)).data.accounts,[]);
 const expires_at=new Date(Date.now()+86400000).toISOString(),body={user_id:id,resource_id:'resource-1',account_lease_id:'owned-1',expected_account_revision:1,expires_at};
 const before=f.store.wallet(id).balance_minor;
 const result=await f.request('POST','/api/admin/grants',body,admin);assert.equal(result.status,201,result.raw);assert.equal(f.state.customers.length,1);assert.equal(f.state.grants.length,1);assert.equal(result.data.grant.account_lease_id,'owned-1');
 assert.equal(f.store.wallet(id).balance_minor,before);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM rentals').get().n,0);
 const repeated=await f.request('POST','/api/admin/grants',body,admin);assert.equal(repeated.status,201,repeated.raw);assert.equal(repeated.data.grant.id,result.data.grant.id);assert.equal(f.state.grants.length,1);
 assert.equal((await f.request('POST','/api/admin/grants',{...body,expires_at:new Date(Date.now()+2*86400000).toISOString()},admin)).status,409);
 const inventory=await f.request('GET','/api/admin/inventory',undefined,admin),account=inventory.data.accounts.find(a=>a.id==='owned-1');assert.equal(account.customer_name,'Buyer');assert.equal(account.user_id,id);assert.equal(account.customer_expires_at,expires_at);assert.equal(account.grant_revision,1);
 const end=new Date(Date.now()+3*86400000).toISOString();const extended=await f.request('PATCH',`/api/admin/grants/${result.data.grant.id}`,{expected_revision:1,expires_at:end},admin);assert.equal(extended.status,200,extended.raw);
 const revoked=await f.request('PATCH',`/api/admin/grants/${result.data.grant.id}`,{expected_revision:extended.data.grant.revision,status:'revoked'},admin);assert.equal(revoked.status,200,revoked.raw);
 assert.equal((await f.request('POST','/api/admin/grants',body,admin)).status,409,'old intent cannot resurrect a revoked delivery');
 const next=await f.request('POST','/api/admin/users',{email:'next@example.test',password,display_name:'Next',role:'member'},admin);
 const assigned=await f.request('POST','/api/admin/grants',{...body,user_id:next.data.user.id,expected_account_revision:2},admin);assert.equal(assigned.status,201,assigned.raw);assert.notEqual(assigned.data.grant.id,result.data.grant.id);assert.equal(f.state.grants.length,2);
 assert.equal((await f.request('POST','/api/admin/grants',body,admin)).status,409);assert.equal(f.state.requests.some(r=>r.path.includes('/purchases')||r.path.endsWith('/balance')),false);
});

test('unknown manual delivery can be checked or replayed without a second grant',async t=>{
 let dropped=false;
 const f=await fixture(t,{afterGrant:({res})=>{if(!dropped){dropped=true;res.destroy();return true;}}}),admin=await f.request('POST','/api/setup',{setup_token:f.setupToken,email:'admin@example.test',password,display_name:'Owner'});
 const member=await f.request('POST','/api/admin/users',{email:'buyer@example.test',password,display_name:'Buyer',role:'member'},admin);
 const body={user_id:member.data.user.id,resource_id:'resource-1',account_lease_id:'owned-1',expected_account_revision:1,expires_at:new Date(Date.now()+86400000).toISOString()};
 const lost=await f.request('POST','/api/admin/grants',body,admin);assert.ok(lost.status>=500,lost.raw);assert.equal(f.state.grants.length,1);
 const inventory=await f.request('GET','/api/admin/inventory',undefined,admin);assert.equal(inventory.data.accounts[0].user_id,member.data.user.id);assert.equal(inventory.data.accounts[0].assigned,true);
 const retry=await f.request('POST','/api/admin/grants',body,admin);assert.equal(retry.status,201,retry.raw);assert.equal(f.state.grants.length,1);assert.equal(f.state.customers.length,1);
});

test('invalid inventory or inactive users never trigger automatic customer creation',async t=>{
 const f=await fixture(t),admin=await f.request('POST','/api/setup',{setup_token:f.setupToken,email:'admin@example.test',password,display_name:'Owner'});
 const member=await f.request('POST','/api/admin/users',{email:'buyer@example.test',password,display_name:'Buyer',role:'member'},admin);
 const body={user_id:member.data.user.id,resource_id:'resource-1',account_lease_id:'owned-1',expected_account_revision:1};
 assert.equal((await f.request('POST','/api/admin/grants',{...body,account_lease_id:'foreign'},admin)).status,409);
 assert.equal((await f.request('POST','/api/admin/grants',{...body,expires_at:new Date(Date.now()+400*86400000).toISOString()},admin)).status,400);
 assert.equal((await f.request('POST','/api/admin/grants',{...body,expected_account_revision:0},admin)).status,400);
 await f.request('PATCH',`/api/admin/users/${member.data.user.id}`,{status:'disabled'},admin);
 assert.equal((await f.request('POST','/api/admin/grants',body,admin)).status,409);assert.equal(f.state.customers.length,0);assert.equal(f.state.grants.length,0);
});

test('automatic identity registration rechecks admin privilege before delivering any account',async t=>{
 let dropAdmin=false,f;
 f=await fixture(t,{onCore:({req,url,json,state,body})=>{if(dropAdmin&&req.method==='POST'&&url.pathname==='/access/v1/customers'){const customer={id:'created-but-not-delivered',external_id:body.external_id,display_name:body.display_name,status:'active',revision:1};state.customers.push(customer);f.store.db.prepare("UPDATE users SET status='disabled' WHERE email='admin@example.test'").run();json({customer},201);return true;}}});
 const admin=await f.request('POST','/api/setup',{setup_token:f.setupToken,email:'admin@example.test',password,display_name:'Owner'});
 const member=await f.request('POST','/api/admin/users',{email:'buyer@example.test',password,display_name:'Buyer',role:'member'},admin);
 // Role demotion requires a second active administrator; leave the invariant intact.
 await f.request('POST','/api/admin/users',{email:'other-admin@example.test',password,display_name:'Other',role:'admin'},admin);
 // Change only the requesting administrator, not both administrators.
 dropAdmin=true;
 const result=await f.request('POST','/api/admin/grants',{user_id:member.data.user.id,resource_id:'resource-1',account_lease_id:'owned-1',expected_account_revision:1},admin);
 assert.ok([401,403].includes(result.status),result.raw);assert.equal(f.state.grants.length,0);
});
