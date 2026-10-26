import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, stripeFixture, password } from './fixtures.js';

const env={STRIPE_SECRET_KEY:'sk_test_isolated_fixture',STRIPE_WEBHOOK_SECRET:'whsec_test_fixture'};
const credentials={email:'admin@example.test',password,display_name:'Admin'};

test('Stripe Checkout uses immutable server prices and only signed server-confirmed payment credits once',async t=>{
  const stripe=stripeFixture();
  const f=await fixture(t,{env,paymentTransport:stripe.transport});
  const admin=await f.request('POST','/api/setup',{...credentials,setup_token:f.setupToken});
  assert.equal((await f.request('POST','/api/me/payments',{amount_minor:1.5},admin)).status,400);
  assert.equal((await f.request('POST','/api/me/payments',{amount_minor:99},admin)).status,400);
  assert.equal((await f.request('POST','/api/me/payments',{amount_minor:100,user_id:'another'},admin)).status,400);
  const created=await f.request('POST','/api/me/payments',{amount_minor:12345},admin);
  assert.equal(created.status,201);assert.equal(created.data.order.status,'pending');assert.equal(created.data.order.currency,'CNY');assert.match(created.data.checkout_url,/^https:\/\/checkout.stripe.com\//);
  const session=[...stripe.sessions.values()][0];
  const form=new URLSearchParams(stripe.calls[0].options.body);
  assert.equal(form.get('line_items[0][price_data][unit_amount]'),'12345');assert.equal(form.get('line_items[0][quantity]'),'1');
  assert.match(stripe.calls[0].options.headers['Idempotency-Key'],new RegExp(created.data.order.id));
  assert.equal((await f.request('GET',`/api/me/payments/${created.data.order.id}?success=true`,undefined,admin)).data.order.status,'pending');
  assert.equal((await f.request('GET','/api/me/wallet',undefined,admin)).data.wallet.balance_minor,0);
  const unsigned=stripe.event(session.id);
  assert.equal((await f.request('POST','/api/webhooks/stripe',unsigned.payload)).status,400);
  // Even a signed "completed" notification is not credited while the API reports unpaid.
  assert.equal((await f.request('POST','/api/webhooks/stripe',unsigned.payload,{headers:{'Stripe-Signature':unsigned.signature}})).status,200);
  assert.equal(f.store.wallet(admin.data.user.id).balance_minor,0);
  session.payment_status='paid';session.status='complete';
  const event=stripe.event(session.id,{type:'checkout.session.async_payment_succeeded'});
  const responses=await Promise.all(Array.from({length:4},()=>f.request('POST','/api/webhooks/stripe',event.payload,{headers:{'Stripe-Signature':event.signature,Origin:'https://stripe.example'}})));
  assert.ok(responses.every(response=>response.status===200));
  const secondEvent=stripe.event(session.id);
  assert.equal((await f.request('POST','/api/webhooks/stripe',secondEvent.payload,{headers:{'Stripe-Signature':secondEvent.signature}})).status,200);
  const wallet=await f.request('GET','/api/me/wallet',undefined,admin);
  assert.equal(wallet.data.wallet.balance_minor,12345);assert.equal(wallet.data.ledger.length,1);assert.equal(wallet.data.orders[0].status,'paid');
  assert.throws(()=>f.store.db.prepare('UPDATE ledger SET amount_minor=1').run(),/immutable_ledger/);
  assert.throws(()=>f.store.db.prepare('DELETE FROM ledger').run(),/immutable_ledger/);
  assert.throws(()=>f.store.db.prepare('UPDATE orders SET amount_minor=1').run(),/immutable_order/);
  await f.restart();
  assert.equal((await f.request('GET','/api/me/wallet',undefined,admin)).data.wallet.balance_minor,12345);
  assert.equal((await f.request('POST','/api/webhooks/stripe',event.payload,{headers:{'Stripe-Signature':event.signature}})).status,200);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM ledger').get().n,1);
  for(const path of ['/api/public','/api/admin/settings','/api/admin/orders','/api/admin/audit']) {
    const response=await f.request('GET',path,undefined,admin);assert.equal(response.raw.includes(env.STRIPE_SECRET_KEY),false);assert.equal(response.raw.includes(env.STRIPE_WEBHOOK_SECRET),false);
  }
});

test('invalid signatures, old timestamps, altered amounts, currencies, environment and identities cannot credit',async t=>{
  const stripe=stripeFixture(), f=await fixture(t,{env,paymentTransport:stripe.transport});
  const admin=await f.request('POST','/api/setup',{...credentials,setup_token:f.setupToken});
  await f.request('POST','/api/me/payments',{amount_minor:200},admin);
  const session=[...stripe.sessions.values()][0];session.status='complete';session.payment_status='paid';
  for(const options of [{secret:'wrong'},{timestamp:Math.floor(Date.now()/1000)-600},{mutate:event=>event.livemode=true}]) {
    const event=stripe.event(session.id,options);
    assert.equal((await f.request('POST','/api/webhooks/stripe',event.payload,{headers:{'Stripe-Signature':event.signature}})).status,400);
  }
  const original=structuredClone(session);
  for(const patch of [{amount_total:201},{currency:'usd'},{metadata:{order_id:session.metadata.order_id,user_id:'another'}},{livemode:true},{client_reference_id:'another'}]) {
    Object.assign(session,original,patch);
    const event=stripe.event(session.id);
    assert.equal((await f.request('POST','/api/webhooks/stripe',event.payload,{headers:{'Stripe-Signature':event.signature}})).status,409);
  }
  Object.assign(session,original);
  assert.equal(f.store.wallet(admin.data.user.id).balance_minor,0);
  const event=stripe.event(session.id);
  assert.equal((await f.request('POST','/api/webhooks/stripe',event.payload,{headers:{'Stripe-Signature':event.signature}})).status,200);
  const changed=stripe.event(session.id,{id:event.payload.id,type:'checkout.session.expired'});
  assert.equal((await f.request('POST','/api/webhooks/stripe',changed.payload,{headers:{'Stripe-Signature':changed.signature}})).status,409);
  assert.equal(f.store.wallet(admin.data.user.id).balance_minor,200);
});

test('unknown Checkout creation persists, never blindly retries, and a verified webhook reconciles it',async t=>{
  const stripe=stripeFixture();stripe.dropCreate=true;
  const f=await fixture(t,{env,paymentTransport:stripe.transport}), admin=await f.request('POST','/api/setup',{...credentials,setup_token:f.setupToken});
  const created=await f.request('POST','/api/me/payments',{amount_minor:500},admin);
  assert.equal(created.status,503);assert.equal(created.data.error.code,'payment_outcome_unknown');assert.equal(stripe.calls.filter(call=>call.options.method==='POST').length,1);
  assert.equal((await f.request('GET','/api/me/wallet',undefined,admin)).data.orders[0].status,'unknown');
  await f.restart();assert.equal(stripe.calls.length,1);
  const session=[...stripe.sessions.values()][0];session.payment_status='paid';session.status='complete';
  const event=stripe.event(session.id);
  stripe.failGet=true;
  assert.equal((await f.request('POST','/api/webhooks/stripe',event.payload,{headers:{'Stripe-Signature':event.signature}})).status,503);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM webhook_events').get().n,0);
  stripe.failGet=false;
  assert.equal((await f.request('POST','/api/webhooks/stripe',event.payload,{headers:{'Stripe-Signature':event.signature}})).status,200);
  assert.equal(f.store.wallet(admin.data.user.id).balance_minor,500);
  assert.equal(stripe.calls.filter(call=>call.options.method==='POST').length,1);
});

test('order and wallet isolation; expired or failed orders are not credits and paid never regresses',async t=>{
  const stripe=stripeFixture(), f=await fixture(t,{env,paymentTransport:stripe.transport});
  const admin=await f.request('POST','/api/setup',{...credentials,setup_token:f.setupToken});
  await f.request('POST','/api/admin/users',{email:'member@example.test',password,display_name:'Member',role:'member'},admin);
  const member=await f.request('POST','/api/auth/login',{email:'member@example.test',password});
  const created=await f.request('POST','/api/me/payments',{amount_minor:300},member), session=[...stripe.sessions.values()][0];
  assert.equal((await f.request('GET',`/api/me/payments/${created.data.order.id}`,undefined,admin)).status,404);
  session.status='expired';
  let event=stripe.event(session.id,{type:'checkout.session.expired'});
  assert.equal((await f.request('POST','/api/webhooks/stripe',event.payload,{headers:{'Stripe-Signature':event.signature}})).status,200);
  assert.equal((await f.request('GET',`/api/me/payments/${created.data.order.id}`,undefined,member)).data.order.status,'expired');
  assert.equal(f.store.wallet(member.data.user.id).balance_minor,0);
  session.status='complete';session.payment_status='paid';event=stripe.event(session.id);
  await f.request('POST','/api/webhooks/stripe',event.payload,{headers:{'Stripe-Signature':event.signature}});
  session.status='expired';session.payment_status='unpaid';event=stripe.event(session.id,{type:'checkout.session.expired'});
  await f.request('POST','/api/webhooks/stripe',event.payload,{headers:{'Stripe-Signature':event.signature}});
  assert.equal((await f.request('GET',`/api/me/payments/${created.data.order.id}`,undefined,member)).data.order.status,'paid');
  assert.equal(f.store.wallet(member.data.user.id).balance_minor,300);assert.equal(f.store.wallet(admin.data.user.id).balance_minor,0);
});
