import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, password } from './fixtures.js';

test('reclaimed resource plans leave the storefront and stock but remain in administrative history',async t=>{
 const source={id:'resource-1',name:'Subscription',kind:'subscription',status:'active',surfaces:['code'],expires_at:null,plans:[]};let removed=false,malformed=false;
 const f=await fixture(t,{onCore:({url,json})=>{
  if(url.pathname==='/access/v1/resources'){json({resources:malformed?null:removed?[]:[source]});return true;}
 }});
 const admin=await f.request('POST','/api/setup',{setup_token:f.setupToken,email:'owner@example.test',password,display_name:'Owner'});
 const created=await f.request('POST','/api/admin/plans',{name:'Retail plan',resource_id:'resource-1',duration_days:7,amount_minor:300,status:'active'},admin);
 assert.equal(created.status,201,created.raw);const plan=created.data.plan;
 assert.equal((await f.request('GET','/api/plans',undefined,admin)).data.plans[0].platforms[0].available,5);
 for(const condition of ['revoked','disabled','expired','removed']){
  source.status=['revoked','disabled'].includes(condition)?condition:'active';source.expires_at=condition==='expired'?new Date(Date.now()-86400000).toISOString():null;removed=condition==='removed';
  const storefront=await f.request('GET','/api/plans',undefined,admin);assert.equal(storefront.status,200,storefront.raw);assert.deepEqual(storefront.data.plans,[],condition);
  const history=await f.request('GET','/api/admin/plans',undefined,admin);assert.equal(history.status,200,history.raw);assert.equal(history.data.plans[0].id,plan.id);assert.deepEqual(history.data.plans[0].platforms,[],condition);
  const purchase=await f.request('POST','/api/me/rentals',{plan_id:plan.id,expected_revision:plan.revision,payment_method:'wallet',platform:'MacOS/arm64',request_id:randomUUID()},admin);
  assert.equal(purchase.status,409,purchase.raw);assert.equal(purchase.data.error.code,'supply_unavailable',condition);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM rentals').get().n,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM orders').get().n,0);
 }
 source.status='active';source.expires_at=null;removed=false;malformed=true;
 assert.equal((await f.request('GET','/api/plans',undefined,admin)).status,503,'unknown supply is not an empty catalog');
 malformed=false;
 assert.equal((await f.request('GET','/api/plans',undefined,admin)).data.plans[0].id,plan.id,'restored authorization reuses the retained plan');
 f.state.inventory[0].status='released';f.state.inventory[1].expires_at=new Date(Date.now()-86400000).toISOString();
 assert.equal((await f.request('GET','/api/plans',undefined,admin)).data.plans[0].platforms[0].available,3,'reclaimed or expired leases do not count as stock');
 assert.equal((await f.request('GET','/api/admin/inventory',undefined,admin)).data.accounts.length,5,'inventory history is preserved');
});
