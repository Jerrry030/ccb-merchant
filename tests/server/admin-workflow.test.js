import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,password } from './fixtures.js';
import { seedAdminWorkflow } from './admin-workflow-fixture.js';
import { selectInventory } from '../../public/inventory-status.js';
import { renewalExpiry,localDateTime } from '../../public/admin-workflow.js';

test('operations counts match filtered delivery/payment pages and customer scoping cannot escape',async t=>{
  const f=await fixture(t),admin=await f.request('POST','/api/setup',{setup_token:f.setupToken,email:'admin@example.test',password,display_name:'运营管理员'});
  const {alice,bob}=await seedAdminWorkflow(f,admin);
  const ops=await f.request('GET','/api/admin/operations',undefined,admin);
  for(const [kind,count] of [['rentals',ops.data.deliveries_pending],['orders',ops.data.payments_pending]]) {
    const page=await f.request('GET','/api/admin/'+kind+'?status=needs_review&limit=1',undefined,admin);
    assert.equal(page.status,200);assert.equal(page.data.total,count);assert.equal(page.data[kind].length,1);
    const scoped=await f.request('GET','/api/admin/'+kind+'?status=needs_review&user_id='+alice.id,undefined,admin);
    assert.ok(scoped.data[kind].every(row=>row.user_id===alice.id));assert.ok(scoped.data[kind].every(row=>row.customer_name==='星河设计'));
    assert.equal(scoped.data.total,kind==='rentals'?2:3);
  }
  const refund=await f.request('GET','/api/admin/rentals?status=refund_pending',undefined,admin);assert.deepEqual(refund.data.rentals.map(r=>r.id),['r-refund']);
  const search=await f.request('GET','/api/admin/orders?q='+encodeURIComponent('北辰'),undefined,admin);assert.deepEqual(search.data.orders.map(r=>r.id),['pay-bob']);
  const member=await f.request('POST','/api/auth/login',{email:alice.email,password});
  for(const path of ['/api/admin/audit','/api/admin/orders','/api/admin/users/'+bob.id]) assert.equal((await f.request('GET',path,undefined,member)).status,403);
  assert.equal((await f.request('GET','/api/me/rentals?user_id='+bob.id,undefined,member)).status,400);
  assert.ok((await f.request('GET','/api/me/rentals',undefined,member)).data.rentals.every(r=>r.user_id===alice.id));
  for(const query of ['status=invalid','status=review&status=refunded','limit=201','offset=-1','unexpected=x']) assert.equal((await f.request('GET','/api/admin/rentals?'+query,undefined,admin)).status,400);
});

test('audit is readable, filtered and pageable beyond 500 without rewriting historical records',async t=>{
  const f=await fixture(t),admin=await f.request('POST','/api/setup',{setup_token:f.setupToken,email:'admin@example.test',password,display_name:'审计管理员'});
  const {alice,bob}=await seedAdminWorkflow(f,admin);
  const legacy=f.store.db.prepare("INSERT INTO audit(actor_id,action,subject_id,outcome,created_at) VALUES(?,'grant.update','old-unmapped-grant','ok','2020-01-01T00:00:00.000Z') RETURNING id").get(admin.data.user.id).id;
  for(let i=0;i<520;i++)f.store.audit(admin.data.user.id,'user.update',alice.id);
  f.store.audit(admin.data.user.id,'user.update',bob.id);
  const page=await f.request('GET','/api/admin/audit?user_id='+alice.id+'&action=user.update&limit=50&offset=500',undefined,admin);
  assert.equal(page.status,200);assert.equal(page.data.total,520);assert.equal(page.data.events.length,20);
  assert.ok(page.data.events.every(e=>e.customer_name==='星河设计'&&e.actor_name==='审计管理员'));
  const grants=await f.request('GET','/api/admin/audit?user_id='+alice.id+'&action=grant.create',undefined,admin);
  assert.equal(grants.data.total,1);assert.equal(grants.data.events[0].subject_name,'Account 1');
  const owned=f.state.inventory[0];const extended=await f.request('PATCH','/api/admin/grants/'+owned.grant_id,{expected_revision:owned.grant_revision,expires_at:new Date(Date.now()+10*86400000).toISOString()},admin);assert.equal(extended.status,200);
  const renewalAudit=await f.request('GET','/api/admin/audit?user_id='+alice.id+'&action=grant.extend',undefined,admin);assert.equal(renewalAudit.data.total,1);assert.equal(renewalAudit.data.events[0].subject_name,'Account 1');
  const q=await f.request('GET','/api/admin/audit?q='+encodeURIComponent('北辰'),undefined,admin);assert.ok(q.data.events.every(e=>e.resolved_customer_id===bob.id));
  const old=await f.request('GET','/api/admin/audit?from=2019-01-01T00:00:00Z&to=2021-01-01T00:00:00Z',undefined,admin);
  assert.equal(old.data.total,1);assert.equal(old.data.events[0].resolved_customer_id,null);
  for(const query of ['from=bad','from=2030-01-01&to=2020-01-01','action=x&action=y','limit=0'])assert.equal((await f.request('GET','/api/admin/audit?'+query,undefined,admin)).status,400);
  await f.restart();assert.equal(f.store.db.prepare('SELECT subject_id FROM audit WHERE id=?').get(legacy).subject_id,'old-unmapped-grant');
  assert.throws(()=>f.store.db.prepare('DELETE FROM audit WHERE id=?').run(legacy),/immutable_audit/);
  assert.equal((await f.request('GET','/api/admin/audit',undefined,admin)).raw.includes('password_hash'),false);
});

test('inventory filters use the chosen deadline, distinguish history and sort unknown dates last',()=>{
  const now=Date.parse('2026-10-29T00:00:00Z');
  const accounts=[
    {id:'a',status:'active',assigned:true,user_id:'alice',customer_name:'星河',platform:'Windows',expires_at:'2027-01-01T00:00:00Z',customer_expires_at:'2026-10-31T00:00:00Z',details:{name:'Alpha',state:'available'}},
    {id:'b',status:'active',assigned:false,platform:'MacOS',expires_at:'2026-11-02T00:00:00Z',details:{name:'Beta',state:'available'}},
    {id:'c',status:'released',assigned:false,platform:'MacOS',expires_at:'2027-01-01T00:00:00Z',details:{name:'Old',state:'available'}},
  ];
  assert.deepEqual(selectInventory(accounts,new URLSearchParams('due=7'),now).map(e=>e.account.id),['a']);
  assert.deepEqual(selectInventory(accounts,new URLSearchParams('due=7&deadline=authorization'),now).map(e=>e.account.id),['b']);
  assert.deepEqual(selectInventory(accounts,new URLSearchParams('platform=MacOS&status=assignable'),now).map(e=>e.account.id),['b']);
  assert.deepEqual(selectInventory(accounts,new URLSearchParams('q=星河'),now).map(e=>e.account.id),['a']);
  assert.deepEqual(selectInventory(accounts,new URLSearchParams('user_id=alice'),now).map(e=>e.account.id),['a','b']);
  assert.deepEqual(selectInventory(accounts,new URLSearchParams('status=released'),now).map(e=>e.account.id),['c']);
  assert.equal(renewalExpiry(accounts[0],7,now),'2026-11-07T00:00:00.000Z');
  assert.equal(renewalExpiry({...accounts[0],expires_at:'2026-11-01T00:00:00Z'},7,now),null);
  assert.equal(renewalExpiry({...accounts[0],customer_expires_at:'bad'},7,now),null);
  assert.equal(Date.parse(localDateTime(now)),now);
});
