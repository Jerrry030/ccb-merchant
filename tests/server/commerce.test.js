import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture,stripeFixture,password } from './fixtures.js';

async function shop(t,options={}) {
 const stripe=stripeFixture(),f=await fixture(t,{env:{STRIPE_SECRET_KEY:'sk_test_fixture',STRIPE_WEBHOOK_SECRET:'whsec_test_fixture'},paymentTransport:stripe.transport,...options});
 const admin=await f.request('POST','/api/setup',{setup_token:f.setupToken,email:'admin@example.test',password,display_name:'Admin'});
 const made=await f.request('POST','/api/admin/users',{email:'member@example.test',password,display_name:'Member',role:'member'},admin);
 const member=await f.request('POST','/api/auth/login',{email:'member@example.test',password});
 assert.equal(member.status,200);
 const body={name:'Code 7 days',description:'Rental fixture',resource_id:'resource-1',duration_days:7,amount_minor:300,status:'active'};
 const created=await f.request('POST','/api/admin/plans',body,admin);assert.equal(created.status,201,created.raw);
 // Fund through the real signed-payment path; no manual credit endpoint or test mode.
 const recharge=await f.request('POST','/api/me/payments',{amount_minor:1200},member);assert.equal(recharge.status,201);
 const session=[...stripe.sessions.values()][0];session.status='complete';session.payment_status='paid';
 const event=stripe.event(session.id);
 assert.equal((await f.request('POST','/api/webhooks/stripe',event.payload,{headers:{'Stripe-Signature':event.signature}})).status,200);
 return {f,stripe,admin,member,plan:created.data.plan,user:made.data.user,planBody:body};
}

test('wallet purchase is immutable, idempotent and renews exactly once; member cannot manage plans or another order',async t=>{
 const {f,admin,member,plan,user,planBody}=await shop(t);
 assert.equal((await f.request('GET','/api/admin/plans',undefined,member)).status,403);
 const catalog=await f.request('GET','/api/plans',undefined,member);assert.equal(catalog.raw.includes('resource_id'),false);
 const body={plan_id:plan.id,expected_revision:plan.revision,payment_method:'wallet',request_id:randomUUID()};
 const a=await f.request('POST','/api/me/rentals',body,member);assert.equal(a.status,201,a.raw);assert.equal(a.data.rental.status,'fulfilled');
 const end=a.data.rental.expires_at;
 const replay=await f.request('POST','/api/me/rentals',body,member);assert.equal(replay.status,200);assert.equal(replay.data.rental.expires_at,end);
 assert.equal(f.store.wallet(user.id).balance_minor,900);assert.equal(f.state.grants.length,1);
 const b=await f.request('POST','/api/me/rentals',{...body,request_id:randomUUID()},member);assert.equal(b.status,201,b.raw);
 assert.equal(Date.parse(b.data.rental.expires_at)-Date.parse(end),7*86400000);
 assert.equal(f.store.wallet(user.id).balance_minor,600);
 const edit=await f.request('PATCH',`/api/admin/plans/${plan.id}`,{...planBody,amount_minor:500,duration_days:10,expected_revision:1},admin);assert.equal(edit.status,200);
 assert.equal((await f.request('POST','/api/me/rentals',{...body,request_id:randomUUID()},member)).status,409);
 assert.equal((await f.request('POST','/api/me/rentals',{...body,payment_method:'stripe'},member)).status,409);
 const orders=await f.request('GET','/api/me/rentals?limit=1',undefined,member);assert.equal(orders.data.total,2);assert.equal(orders.data.rentals[0].duration_days,7);
 assert.equal((await f.request('GET','/api/me/rentals',undefined,admin)).data.total,0);
 assert.throws(()=>f.store.db.prepare('UPDATE rentals SET amount_minor=1').run(),/immutable_rental/);
 await f.restart();assert.equal(f.store.wallet(user.id).balance_minor,600);
});

test('lost fulfillment acknowledgement survives restart without repeat renewal or refunding delivered supply',async t=>{
 let drop=true;
 const {f,member,admin,plan,user}=await shop(t,{afterFulfillment:({json})=>{if(drop){json({error:{}},500);return true;}}});
 const purchase=await f.request('POST','/api/me/rentals',{plan_id:plan.id,expected_revision:1,payment_method:'wallet',request_id:randomUUID()},member);
 assert.equal(purchase.status,201);assert.equal(purchase.data.rental.status,'review');assert.equal(f.state.grants.length,1);
 const end=f.state.grants[0].expires_at;drop=false;await f.restart();
 const row=purchase.data.rental;
 const refund=await f.request('POST',`/api/admin/rentals/${row.id}/resolve`,{action:'refund',expected_revision:row.revision},admin);
 assert.equal(refund.status,200,refund.raw);assert.equal(refund.data.rental.status,'fulfilled');
 assert.equal(f.state.grants[0].expires_at,end);assert.equal(f.store.wallet(user.id).balance_minor,900);
 assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM ledger WHERE kind='rental_refund'").get().n,0);
});

test('unfulfilled refunds are fenced in core, credit once, and reject stale retries',async t=>{
 let reject=true;
 const {f,admin,member,plan,user}=await shop(t,{onCore:({req,url,body,json})=>{if(reject&&req.method==='PUT'&&url.pathname.includes('/fulfillments/')&&body.action==='fulfill'){json({error:{}},409);return true;}}});
 const body={plan_id:plan.id,expected_revision:1,payment_method:'wallet',request_id:randomUUID()};
 const created=await f.request('POST','/api/me/rentals',body,member);assert.equal(created.data.rental.status,'review');
 const row=created.data.rental;
 assert.equal((await f.request('POST',`/api/admin/rentals/${row.id}/resolve`,{action:'refund',expected_revision:row.revision},member)).status,403);
 const refund=await f.request('POST',`/api/admin/rentals/${row.id}/resolve`,{action:'refund',expected_revision:row.revision},admin);assert.equal(refund.data.rental.status,'refunded',refund.raw);
 assert.equal(f.store.wallet(user.id).balance_minor,1200);assert.equal(f.state.fulfillments.get(row.id).status,'cancelled');
 reject=false;await f.reconciler.run();
 assert.equal(f.state.grants.length,0);
 assert.equal((await f.request('POST',`/api/admin/rentals/${row.id}/resolve`,{action:'retry',expected_revision:row.revision},admin)).status,409);
 assert.equal((await f.request('POST','/api/me/rentals',body,member)).data.rental.status,'refunded');
 assert.equal(f.store.wallet(user.id).balance_minor,1200);
});

test('online purchase requires server-confirmed payment; repeated webhooks debit and deliver once',async t=>{
 const {f,stripe,member,plan,user}=await shop(t);
 const created=await f.request('POST','/api/me/rentals',{plan_id:plan.id,expected_revision:1,payment_method:'stripe',request_id:randomUUID()},member);
 assert.equal(created.status,201,created.raw);assert.equal(created.data.rental.status,'awaiting_payment');assert.equal(f.state.grants.length,0);
 const session=[...stripe.sessions.values()].at(-1);session.status='complete';session.payment_status='paid';
 const event=stripe.event(session.id);
 const responses=await Promise.all([1,2,3].map(()=>f.request('POST','/api/webhooks/stripe',event.payload,{headers:{'Stripe-Signature':event.signature}})));
 assert.ok(responses.every(r=>r.status===200));await f.reconciler.run();
 const orders=await f.request('GET','/api/me/rentals',undefined,member);assert.equal(orders.data.rentals[0].status,'fulfilled');
 assert.equal(f.store.wallet(user.id).balance_minor,1200);assert.equal(f.state.grants.length,1);
 assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM ledger WHERE kind='rental_debit'").get().n,1);
 await f.restart();await f.reconciler.run();assert.equal(f.state.grants.length,1);
});

test('expired checkout releases pending capacity; known-session reconciliation recovers a missing webhook',async t=>{
 const {f,stripe,member,plan}=await shop(t);
 const body={plan_id:plan.id,expected_revision:1,payment_method:'stripe',request_id:randomUUID()};
 const created=await f.request('POST','/api/me/rentals',body,member);assert.equal(created.status,201);
 assert.equal((await f.request('POST','/api/me/rentals',{...body,request_id:randomUUID()},member)).status,409);
 const session=[...stripe.sessions.values()].at(-1);session.status='expired';await f.reconciler.run();
 assert.equal((await f.request('GET','/api/me/rentals',undefined,member)).data.rentals[0].status,'cancelled');
 const next=await f.request('POST','/api/me/rentals',{...body,request_id:randomUUID()},member);assert.equal(next.status,201,next.raw);
 const paid=[...stripe.sessions.values()].at(-1);paid.status='complete';paid.payment_status='paid';await f.reconciler.run();
 assert.equal((await f.request('GET','/api/me/rentals',undefined,member)).data.rentals.find(r=>r.id===next.data.rental.id).status,'fulfilled');
});

test('insufficient funds, excessive term and concurrent purchases never create unbacked debits',async t=>{
 const {f,member,plan,admin,planBody,user}=await shop(t);
 const updated=await f.request('PATCH',`/api/admin/plans/${plan.id}`,{...planBody,amount_minor:900,expected_revision:1},admin);assert.equal(updated.status,200);
 const body={plan_id:plan.id,expected_revision:2,payment_method:'wallet',request_id:randomUUID()};
 const results=await Promise.all([f.request('POST','/api/me/rentals',body,member),f.request('POST','/api/me/rentals',{...body,request_id:randomUUID()},member)]);
 assert.equal(results.filter(r=>r.status===201).length,1);assert.equal(f.store.wallet(user.id).balance_minor,300);
 assert.equal((await f.request('POST','/api/me/rentals',{...body,request_id:randomUUID()},member)).status,409);
 assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM rentals").get().n,1);
 assert.equal((await f.request('POST','/api/admin/plans',{...planBody,duration_days:367},admin)).status,400);
});


test('background customer synchronization restores a suspended site after restart and honors current intent',async t=>{
 let offline=false;
 const {f,admin,member,user,plan}=await shop(t,{onCore:({req,url,json})=>{if(offline&&req.method==='PATCH'&&url.pathname.startsWith('/merchant/v1/customers/')){json({error:{}},503);return true;}}});
 const purchase=await f.request('POST','/api/me/rentals',{plan_id:plan.id,expected_revision:1,payment_method:'wallet',request_id:randomUUID()},member);assert.equal(purchase.data.rental.status,'fulfilled');
 offline=true;const disabled=await f.request('PATCH',`/api/admin/users/${user.id}`,{status:'disabled'},admin);assert.equal(disabled.status,503);
 assert.ok(f.store.db.prepare('SELECT core_pending FROM users WHERE id=?').get(user.id).core_pending);
 assert.equal((await f.request('GET','/bridge/v1/models',undefined,{native:true})).status,503);
 await f.restart();offline=false;f.store.db.prepare('UPDATE users SET next_sync_at=0 WHERE id=?').run(user.id);await f.reconciler.run();
 assert.equal(f.store.db.prepare('SELECT core_pending FROM users WHERE id=?').get(user.id).core_pending,null);
 assert.equal(f.state.customers.find(c=>c.external_id===user.id).status,'disabled');
 const ops=await f.request('GET','/api/admin/operations',undefined,admin);assert.equal(ops.data.pending_customers.length,0);
});

test('late payment after a confirmed expired order is visible wallet credit, not a revived entitlement',async t=>{
 const {f,stripe,member,plan,user}=await shop(t);
 const purchase=await f.request('POST','/api/me/rentals',{plan_id:plan.id,expected_revision:1,payment_method:'stripe',request_id:randomUUID()},member);
 const session=[...stripe.sessions.values()].at(-1);session.status='expired';await f.reconciler.run();
 session.status='complete';session.payment_status='paid';const event=stripe.event(session.id);
 assert.equal((await f.request('POST','/api/webhooks/stripe',event.payload,{headers:{'Stripe-Signature':event.signature}})).status,200);
 await f.reconciler.run();const row=f.store.db.prepare('SELECT * FROM rentals WHERE id=?').get(purchase.data.rental.id);
 assert.equal(row.status,'cancelled');assert.equal(row.last_error,'late_payment_wallet_credit');assert.equal(f.state.grants.length,0);assert.equal(f.store.wallet(user.id).balance_minor,1500);
});
