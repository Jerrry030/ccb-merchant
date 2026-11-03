import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, stripeFixture, password } from './fixtures.js';

const env={STRIPE_SECRET_KEY:'sk_test_pages_fixture',STRIPE_WEBHOOK_SECRET:'whsec_test_fixture'};

test('wallet and recharge history paginate beyond 200 rows, remain owner scoped, and distinguish paid from credited',async t=>{
  const stripe=stripeFixture(),f=await fixture(t,{withoutCore:true,env,paymentTransport:stripe.transport});
  const admin=await f.request('POST','/api/setup',{setup_token:f.setupToken,email:'admin@example.test',password,display_name:'Admin'});
  await f.request('POST','/api/admin/users',{email:'buyer@example.test',password,display_name:'Buyer',role:'member'},admin);
  const buyer=await f.request('POST','/api/auth/login',{email:'buyer@example.test',password});
  const made=await f.request('POST','/api/me/payments',{amount_minor:100},buyer);
  assert.equal(made.status,201,made.raw);
  const prototype=f.store.db.prepare('SELECT * FROM orders WHERE id=?').get(made.data.order.id);
  const config=f.store.openPayment(prototype.provider_config,prototype.id);
  const columns=Object.keys(prototype),insert=f.store.db.prepare('INSERT INTO orders('+columns.join(',')+') VALUES('+columns.map(()=>'?').join(',')+')');
  const ledger=f.store.db.prepare("INSERT INTO ledger(id,user_id,order_id,amount_minor,currency,kind,reference,created_at) VALUES(?,?,?,100,'CNY','payment_credit',?,?)");
  f.store.transaction(()=>{
    for(let i=0;i<205;i++){
      const id='page-order-'+String(i).padStart(4,'0');
      const row={...prototype,id,status:'paid',provider_reference:null,provider_config:f.store.sealPayment(config,id),checkout_data:f.store.sealPayment({},'checkout:'+id)};
      insert.run(...columns.map(column=>row[column]));
      ledger.run('page-ledger-'+i,buyer.data.user.id,id,'fixture:'+id,prototype.created_at);
    }
  });
  const foreign=await f.request('POST','/api/me/payments',{amount_minor:777},admin);
  const first=await f.request('GET','/api/me/orders?purpose=recharge&limit=30',undefined,buyer);
  assert.equal(first.status,200,first.raw);assert.equal(first.data.total,206);assert.equal(first.data.orders.length,30);
  assert.ok(first.data.orders.every(order=>order.user_id===buyer.data.user.id));
  assert.equal(first.raw.includes(foreign.data.order.id),false);assert.equal(first.raw.includes('provider_config'),false);assert.equal(first.raw.includes(env.STRIPE_SECRET_KEY),false);
  const all=[];
  for(let offset=0;offset<206;offset+=30){const page=await f.request('GET','/api/me/orders?purpose=recharge&limit=30&offset='+offset,undefined,buyer);all.push(...page.data.orders.map(order=>order.id));}
  assert.equal(new Set(all).size,206);
  const wallet=await f.request('GET','/api/me/wallet?limit=30&offset=200',undefined,buyer);
  assert.equal(wallet.data.total,205);assert.equal(wallet.data.ledger.length,5);assert.equal(wallet.data.wallet.balance_minor,20500);
  assert.equal('orders' in wallet.data,false,'wallet never bundles payment history or catalog');
  assert.equal((await f.request('GET','/api/me/wallet?user_id='+admin.data.user.id,undefined,buyer)).status,400);
  assert.equal((await f.request('GET','/api/me/orders?user_id='+admin.data.user.id,undefined,buyer)).status,400);
  assert.equal((await f.request('GET','/api/me/orders?id='+foreign.data.order.id,undefined,buyer)).data.total,0);
  for(const query of ['purpose=invalid','limit=201','offset=-1','purpose=recharge&purpose=subscription'])assert.equal((await f.request('GET','/api/me/orders?'+query,undefined,buyer)).status,400,query);
  f.store.db.prepare("UPDATE orders SET status='paid' WHERE id=?").run(prototype.id);
  const uncredited=await f.request('GET','/api/me/orders?id='+prototype.id,undefined,buyer);
  assert.equal(uncredited.data.orders[0].status,'paid');assert.equal(uncredited.data.orders[0].credited,false,'payment label alone is not ledger evidence');
  assert.equal((await f.request('GET','/api/me/wallet')).status,401);
});

test('rental receipts resolve by original request identity and expose independent payment state without cross-owner access',async t=>{
  const stripe=stripeFixture(),f=await fixture(t,{env,paymentTransport:stripe.transport});
  const admin=await f.request('POST','/api/setup',{setup_token:f.setupToken,email:'admin@example.test',password,display_name:'Admin'});
  await f.request('POST','/api/admin/users',{email:'buyer@example.test',password,display_name:'Buyer',role:'member'},admin);
  const buyer=await f.request('POST','/api/auth/login',{email:'buyer@example.test',password});
  const created=await f.request('POST','/api/admin/plans',{name:'7 days',description:'',resource_id:'resource-1',duration_days:7,amount_minor:300,status:'active'},admin);
  assert.equal(created.status,201,created.raw);
  const topup=await f.request('POST','/api/me/payments',{amount_minor:1000},buyer);
  const session=[...stripe.sessions.values()][0];session.status='complete';session.payment_status='paid';
  const event=stripe.event(session.id);await f.request('POST','/api/webhooks/stripe',event.payload,{headers:{'Stripe-Signature':event.signature}});
  const requestId=randomUUID(),plan=created.data.plan;
  const purchase=await f.request('POST','/api/me/rentals',{plan_id:plan.id,expected_revision:plan.revision,payment_method:'wallet',platform:'MacOS/arm64',request_id:requestId},buyer);
  assert.equal(purchase.status,201,purchase.raw);
  const receipt=await f.request('GET','/api/me/rentals?request_id='+requestId,undefined,buyer);
  assert.equal(receipt.data.total,1);assert.equal(receipt.data.rentals[0].id,purchase.data.rental.id);assert.equal(receipt.data.rentals[0].payment_status,'paid');assert.equal(receipt.data.rentals[0].status,'fulfilled');
  assert.equal((await f.request('GET','/api/me/rentals?request_id='+requestId,undefined,admin)).data.total,0);
  assert.equal((await f.request('GET','/api/me/rentals?id='+purchase.data.rental.id,undefined,admin)).data.total,0);
  assert.equal((await f.request('GET','/api/me/rentals?request_id=short',undefined,buyer)).status,400);
  const accounts=await f.request('GET','/api/me/accounts',undefined,buyer);
  assert.equal(accounts.data.accounts[0].renew_grant_id,purchase.data.rental.grant_id);
  const online=await f.request('POST','/api/me/rentals',{plan_id:plan.id,expected_revision:plan.revision,payment_method:'stripe',platform:'MacOS/arm64',request_id:randomUUID()},buyer);
  assert.equal(online.status,201,online.raw);
  const recharge=await f.request('GET','/api/me/orders?purpose=recharge',undefined,buyer),subscription=await f.request('GET','/api/me/orders?purpose=subscription',undefined,buyer);
  assert.deepEqual(recharge.data.orders.map(order=>order.id),[topup.data.order.id]);
  assert.deepEqual(subscription.data.orders.map(order=>order.id),[online.data.payment.order.id]);
  const form=new URLSearchParams(stripe.calls.filter(call=>call.options.method==='POST').at(-1).options.body);
  assert.equal(new URL(form.get('success_url')).pathname,'/checkout');assert.equal(new URL(form.get('cancel_url')).pathname,'/checkout');
  assert.equal(new URL(form.get('success_url')).searchParams.get('order'),online.data.payment.order.id);
  await f.restart();
  const recovered=await f.request('GET','/api/me/rentals?request_id='+requestId,undefined,buyer);
  assert.equal(recovered.data.rentals[0].id,purchase.data.rental.id,'restart preserves the original purchase lookup');
});
