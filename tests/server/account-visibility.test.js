import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, password } from './fixtures.js';

// Current-ownership views must not expose historical cards. Administrative
// grant/inventory reads and usage/order history retain their audit records.
const views = [['/api/me/accounts','accounts'],['/api/me/grants','grants'],['/api/me/overview','grants'],['/api/me/devices','accounts']];

test('reclaim and reassignment remove account cards from every customer surface without deleting history',async t=>{
 const f=await fixture(t,{onCore:({req,url,state,json})=>{
  if(req.method==='GET'&&url.pathname.endsWith('/devices')){json({devices:[{id:'old-device',name:'Old laptop',state:'approved',current_grant_id:state.grants[0]?.id}]});return true;}
 }});
 const admin=await f.request('POST','/api/setup',{setup_token:f.setupToken,email:'owner@example.test',password,display_name:'Owner'});
 const user=(await f.request('POST','/api/admin/users',{email:'member@example.test',password,display_name:'Member',role:'member'},admin)).data.user;
 const member=await f.request('POST','/api/auth/login',{email:user.email,password});
 const expires_at=new Date(Date.now()+86400000).toISOString(),grants=[];
 for(const account_lease_id of ['owned-1','owned-2']){
  const assigned=await f.request('POST','/api/admin/grants',{user_id:user.id,resource_id:'resource-1',account_lease_id,expected_account_revision:1,expires_at},admin);
  assert.equal(assigned.status,201,assigned.raw);grants.push(assigned.data.grant);
 }
 assert.equal((await f.request('GET','/api/me/accounts',undefined,member)).data.accounts.length,2);
 const revoked=await f.request('PATCH','/api/admin/grants/'+grants[0].id,{expected_revision:1,status:'revoked'},admin);
 assert.equal(revoked.status,200,revoked.raw);
 // Core still supplies a historical card with quota and a future expiration.
 const historical=f.state.accounts.find(a=>a.id===grants[0].id);historical.state='unavailable';historical.plan='RECLAIMED_CARD_MUST_NOT_LEAK';
 for(const [path,field] of [...views,['/api/admin/users/'+user.id+'/devices','accounts']]){
  const response=await f.request('GET',path,undefined,path.startsWith('/api/admin/')?admin:member);
  assert.equal(response.status,200,response.raw);assert.deepEqual(response.data[field].map(a=>a.id),[grants[1].id],path);
  assert.equal(response.raw.includes('RECLAIMED_CARD_MUST_NOT_LEAK'),false,path);
 }
 const history=await f.request('GET','/api/admin/grants?user_id='+user.id,undefined,admin);
 assert.deepEqual(history.data.grants.map(g=>g.status),['revoked','active']);
 assert.equal((await f.request('GET','/api/admin/inventory',undefined,admin)).data.accounts.find(a=>a.id==='owned-1').assigned,false);
 const next=(await f.request('POST','/api/admin/users',{email:'next@example.test',password,display_name:'Next',role:'member'},admin)).data.user;
 const reassigned=await f.request('POST','/api/admin/grants',{user_id:next.id,resource_id:'resource-1',account_lease_id:'owned-1',expected_account_revision:2,expires_at},admin);
 assert.equal(reassigned.status,201,reassigned.raw);assert.notEqual(reassigned.data.grant.id,grants[0].id);
 const nextSession=await f.request('POST','/api/auth/login',{email:next.email,password});
 assert.deepEqual((await f.request('GET','/api/me/accounts',undefined,nextSession)).data.accounts.map(a=>a.id),[reassigned.data.grant.id]);
 for(const [path,field] of views)assert.deepEqual((await f.request('GET',path,undefined,member)).data[field].map(a=>a.id),[grants[1].id],path);
 assert.equal(f.state.grants.length,3,'historical grants are not deleted');
 const last=await f.request('PATCH','/api/admin/grants/'+grants[1].id,{expected_revision:1,status:'revoked'},admin);assert.equal(last.status,200,last.raw);
 for(const [path,field] of views)assert.deepEqual((await f.request('GET',path,undefined,member)).data[field],[],path);
});

test('visibility follows scoped current grants, not quota, availability or expiry, across upstream pages',async t=>{
 const f=await fixture(t,{onCore:({req,url,state,json})=>{
  if(req.method==='GET'&&url.pathname==='/access/v1/grants'){
   const second=url.searchParams.has('cursor');json({grants:second?state.grants.slice(2):state.grants.slice(0,2),limit:500,next_cursor:second?'':'next-grants-page'});return true;
  }
 }});
 const admin=await f.request('POST','/api/setup',{setup_token:f.setupToken,email:'owner@example.test',password,display_name:'Owner'});
 const provisioned=await f.request('POST','/api/admin/users/'+admin.data.user.id+'/provision',{},admin);assert.equal(provisioned.status,200,provisioned.raw);
 const customer_id=provisioned.data.customer.id;
 for(const [id,status,state] of [['revoked','revoked','available'],['revoked-unavailable','revoked','unavailable'],['ready','active','available'],['limited','active','limited'],['unavailable','active','unavailable'],['expired','active','expired']]){
  const expires_at=new Date(Date.now()+(id==='expired'?-1:1)*86400000).toISOString();
  f.state.grants.push({id,customer_id,status,expires_at,resource_id:'resource-1',account_lease_id:'lease-'+id});
  f.state.accounts.push({id,grant_id:id,customer_id,account_lease_id:'lease-'+id,state,expires_at,quota:{status:'unknown',windows:[]}});
 }
 f.state.grants.push({id:'foreign',customer_id:'other-customer',status:'active'},{id:'pending',customer_id,status:'active',pending:true},{id:'shared-group',customer_id,status:'active'});
 for(const id of ['foreign','pending','orphan'])f.state.accounts.push({id,customer_id,state:'available'});
 for(const [path,field] of views){
  const response=await f.request('GET',path,undefined,admin);assert.equal(response.status,200,response.raw);
  assert.deepEqual(response.data[field].map(a=>a.id),['ready','limited','unavailable','expired',...(field==='grants'?['shared-group']:[])],path);
 }
 assert.ok(f.state.requests.some(r=>r.path.includes('cursor=next-grants-page')));
});

test('unconfirmed grant reads fail closed instead of exposing stale account metadata or claiming no accounts',async t=>{
 let broken=false;
 const f=await fixture(t,{onCore:({url,json})=>{
  if(broken&&url.pathname==='/access/v1/grants'){json({error:{code:'unavailable'}},503);return true;}
 }});
 const admin=await f.request('POST','/api/setup',{setup_token:f.setupToken,email:'owner@example.test',password,display_name:'Owner'});
 const assigned=await f.request('POST','/api/admin/grants',{user_id:admin.data.user.id,resource_id:'resource-1',account_lease_id:'owned-1',expected_account_revision:1,expires_at:new Date(Date.now()+86400000).toISOString()},admin);
 assert.equal(assigned.status,201,assigned.raw);broken=true;
 for(const path of ['/api/me/accounts','/api/me/grants','/api/me/devices','/api/admin/users/'+admin.data.user.id+'/devices']){
  const response=await f.request('GET',path,undefined,admin);assert.equal(response.status,503,path);assert.equal('accounts' in response.data,false);
 }
 const overview=await f.request('GET','/api/me/overview',undefined,admin);assert.equal(overview.status,200,overview.raw);assert.ok(overview.data.pending.includes('grants_unavailable'));assert.deepEqual(overview.data.grants,[]);
 broken=false;assert.equal((await f.request('GET','/api/me/accounts',undefined,admin)).data.accounts.length,1);
});

test('malformed grant ownership or lifecycle metadata cannot turn a retained card into a visible account',async t=>{
 const f=await fixture(t,{onCore:({req,url,state,json})=>{if(req.method==='GET'&&url.pathname==='/access/v1/grants'){json({grants:state.grants});return true;}}}),admin=await f.request('POST','/api/setup',{setup_token:f.setupToken,email:'owner@example.test',password,display_name:'Owner'});
 const assigned=await f.request('POST','/api/admin/grants',{user_id:admin.data.user.id,resource_id:'resource-1',account_lease_id:'owned-1',expected_account_revision:1,expires_at:new Date(Date.now()+86400000).toISOString()},admin);
 assert.equal(assigned.status,201,assigned.raw);const grant=f.state.grants[0],original={...grant};
 for(const patch of [{status:undefined},{status:'unknown'},{customer_id:null},{id:123}]){
  Object.assign(grant,original,patch);
  for(const path of ['/api/me/accounts','/api/me/grants','/api/me/devices']){
   const response=await f.request('GET',path,undefined,admin);assert.equal(response.status,503,path);assert.equal('accounts' in response.data,false);
  }
  const overview=await f.request('GET','/api/me/overview',undefined,admin);assert.ok(overview.data.pending.includes('grants_unavailable'));
 }
 Object.assign(grant,original);assert.equal((await f.request('GET','/api/me/accounts',undefined,admin)).data.accounts.length,1);
});
