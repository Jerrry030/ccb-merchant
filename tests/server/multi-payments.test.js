import { randomUUID } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture,password } from './fixtures.js';
import { providerFixture } from './payment-provider-fixture.js';
import { paymentJSON,paymentAmount,validateProviderConfig } from '../../src/payment-providers.js';

const owner={email:'admin@example.test',password,display_name:'Payment owner'};
const cases=[['alipay','alipay','official_alipay'],['wxpay','wxpay','official_wxpay'],['easypay','alipay','easypay_alipay'],['easypay','wxpay','easypay_wxpay'],['suixingpay','alipay','suixingpay_alipay'],['suixingpay','wxpay','suixingpay_wxpay'],['airwallex','airwallex','airwallex_checkout']];
for(const [provider,method,source] of cases)test(provider+' / '+method+': real adapter signing, checkout, verified callback, requery, single credit and restart',async t=>{
  const remote=providerFixture(),f=await fixture(t,{withoutCore:true,paymentTransport:remote.transport});
  const admin=await f.request('POST','/api/setup',{...owner,setup_token:f.setupToken});
  const configured=await f.request('PATCH','/api/admin/payment',{expected_revision:1,providers:{[provider]:remote.configs[provider]},methods:{[method]:{enabled:true,source}}},admin);
  assert.equal(configured.status,200,configured.raw);assert.equal(configured.data.features.payment,true);
  const created=await f.request('POST','/api/me/payments',{amount_minor:1234,payment_method:method},admin);assert.equal(created.status,201,created.raw);
  assert.equal(created.data.order.provider,provider);assert.equal(created.data.order.payment_method,method);
  const id=created.data.order.id,row=f.store.db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  assert.equal(row.provider_config.includes('BEGIN PRIVATE KEY'),false);assert.equal(row.provider_config.includes('fixture-airwallex-key'),false);
  assert.equal((await readFile(join(f.config.dataDir,'payment.key'))).length,32);
  assert.equal((await f.request('GET','/api/public')).raw.includes('private_key'),false);
  if(provider==='airwallex'){
    assert.equal(created.data.checkout_path,'/airwallex-checkout.html?order='+id);assert.equal(created.raw.includes('fixture-intent-secret'),false);
    const checkout=await f.request('GET','/api/me/payments/'+id+'/checkout',undefined,admin);assert.equal(checkout.data.client_secret,'fixture-intent-secret');
    assert.equal(row.checkout_data.includes('fixture-intent-secret'),false);
    assert.equal((await f.request('GET','/api/me/wallet',undefined,admin)).raw.includes('fixture-intent-secret'),false);
  }else{assert.equal(created.data.qr_available,true);const qr=await f.request('GET','/api/me/payments/'+id+'/qr.svg',undefined,admin);assert.equal(qr.status,200);assert.match(qr.raw,/<svg/);assert.match(qr.headers.get('content-type'),/image\/svg/);}
  const wrong=remote.notification(provider,id,provider==='alipay'?{total_amount:'12.35'}:provider==='wxpay'?{amount:{total:1235,currency:'CNY'}}:provider==='easypay'?{money:'12.35'}:provider==='suixingpay'?{amt:'12.35'}:{amount:12.35});
  assert.equal((await f.request('POST',wrong.path,wrong.raw,{raw:true,headers:wrong.headers})).status,409);
  const valid=remote.notification(provider,id),badHeaders={...valid.headers};let badRaw=valid.raw;
  if(provider==='wxpay')badHeaders['Wechatpay-Signature']='invalid';else if(provider==='airwallex')badHeaders['x-signature']='invalid';else if(provider==='suixingpay'){const body=JSON.parse(badRaw);body.sign='invalid';badRaw=JSON.stringify(body);}else badRaw=badRaw.replace(/sign=[^&]*/,'sign=invalid');
  assert.ok((await f.request('POST',valid.path,badRaw,{raw:true,headers:badHeaders})).status>=400);
  assert.equal(f.store.wallet(admin.data.user.id).balance_minor,0);
  assert.equal((await f.request('PATCH','/api/admin/payment',{expected_revision:2,providers:{[provider]:{enabled:false,clear_secrets:true}}},admin)).data.error.code,'payment_pending');
  remote.orders.get(id).paid=true;
  await f.restart();
  const replies=await Promise.all([1,2,3].map(index=>f.request('POST',provider==='wxpay'&&index===1?'/api/webhooks/wxpay':valid.path,valid.raw,{raw:true,headers:valid.headers})));
  for(const reply of replies)assert.equal(reply.status,200,reply.raw);
  assert.equal(f.store.wallet(admin.data.user.id).balance_minor,1234);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM ledger WHERE order_id=?').get(id).n,1);
  assert.equal((await f.request('GET','/api/me/payments/'+id,undefined,admin)).data.order.status,'paid');
  assert.equal((await f.request('PATCH','/api/admin/payment',{expected_revision:2,providers:{[provider]:{enabled:false,clear_secrets:true}}},admin)).status,200);
  assert.equal((await f.request('POST',valid.path,valid.raw,{raw:true,headers:valid.headers})).status,200);
  const audit=await f.request('GET','/api/admin/audit',undefined,admin);assert.equal(audit.raw.includes('PRIVATE KEY'),false);assert.equal(audit.raw.includes('fixture-intent-secret'),false);
});

for(const [provider,method,source] of cases.filter(([provider,method])=>!['easypay','suixingpay'].includes(provider)||method==='alipay'))test(provider+': lost create response recovers without another payment creation',async t=>{
  const remote=providerFixture(),f=await fixture(t,{withoutCore:true,paymentTransport:remote.transport});const admin=await f.request('POST','/api/setup',{...owner,setup_token:f.setupToken});
  assert.equal((await f.request('PATCH','/api/admin/payment',{expected_revision:1,providers:{[provider]:remote.configs[provider]},methods:{[method]:{enabled:true,source}}},admin)).status,200);
  remote.dropCreate=true;assert.equal((await f.request('POST','/api/me/payments',{amount_minor:200,payment_method:method},admin)).data.error.code,'payment_outcome_unknown');
  const row=f.store.db.prepare('SELECT * FROM orders').get();assert.equal(row.status,'unknown');remote.orders.get(row.id).paid=true;await f.restart();
  const before=remote.requests.length;
  if(provider==='airwallex'){const hook=remote.notification(provider,row.id);assert.equal((await f.request('POST',hook.path,hook.raw,{raw:true,headers:hook.headers})).status,200);}else await f.reconciler.run();
  assert.equal(f.store.wallet(admin.data.user.id).balance_minor,200);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM orders').get().n,1);
  assert.ok(remote.requests.slice(before).every(r=>!r.url.endsWith('/create')&&!r.url.endsWith('/mapi.php')&&!r.url.endsWith('/activePlusScan')&&!(r.options.method==='POST'&&r.url.endsWith('/native'))));
});

test('merchant identity, provider-query amount, signatures and owner-scoped checkout fail closed',async t=>{
  const remote=providerFixture(),f=await fixture(t,{withoutCore:true,paymentTransport:remote.transport});const admin=await f.request('POST','/api/setup',{...owner,setup_token:f.setupToken});
  await f.request('PATCH','/api/admin/payment',{expected_revision:1,providers:{easypay:remote.configs.easypay},methods:{wxpay:{enabled:true,source:'easypay_wxpay'}}},admin);
  const created=await f.request('POST','/api/me/payments',{amount_minor:300,payment_method:'wxpay'},admin),id=created.data.order.id,hook=remote.notification('easypay',id);
  remote.orders.get(id).paid=true;
  for(const patch of [{money:'3.01'},{pid:'another-merchant'},{type:'alipay'},{out_trade_no:'different-order'}]){
    remote.orders.get(id).patch=patch;assert.equal((await f.request('POST',hook.path,hook.raw,{raw:true,headers:hook.headers})).status,409);assert.equal(f.store.wallet(admin.data.user.id).balance_minor,0);
  }
  remote.orders.get(id).patch={};
  const duplicate=hook.raw+'&money=3.00';assert.ok((await f.request('POST',hook.path,duplicate,{raw:true,headers:hook.headers})).status>=400);
  await f.request('POST','/api/admin/users',{email:'member@example.test',password,display_name:'Member',role:'member'},admin);
  const member=await f.request('POST','/api/auth/login',{email:'member@example.test',password});
  for(const suffix of ['', '/qr.svg','/checkout'])assert.equal((await f.request('GET','/api/me/payments/'+id+suffix,undefined,member)).status,404);
  assert.equal((await f.request('GET',hook.path+'?'+hook.raw,undefined,{headers:hook.headers})).status,200);
  assert.equal(f.store.wallet(admin.data.user.id).balance_minor,300);
});

test('signed provider response corruption never becomes an actionable QR or a paid order',async t=>{
  for(const provider of ['wxpay','suixingpay']){
    const remote=providerFixture(),f=await fixture(t,{withoutCore:true,paymentTransport:remote.transport});const admin=await f.request('POST','/api/setup',{...owner,setup_token:f.setupToken});
    await f.request('PATCH','/api/admin/payment',{expected_revision:1,providers:{[provider]:remote.configs[provider]},methods:{wxpay:{enabled:true,source:provider==='wxpay'?'official_wxpay':'suixingpay_wxpay'}}},admin);
    remote.corruptSignature=true;const created=await f.request('POST','/api/me/payments',{amount_minor:500,payment_method:'wxpay'},admin);assert.equal(created.status,503);
    const row=f.store.db.prepare('SELECT * FROM orders').get();remote.orders.get(row.id).paid=true;
    assert.ok((await f.request('POST','/api/me/payments/'+row.id+'/reconcile',{},admin)).status>=400);assert.equal(f.store.wallet(admin.data.user.id).balance_minor,0);
    remote.corruptSignature=false;assert.equal((await f.request('POST','/api/me/payments/'+row.id+'/reconcile',{},admin)).status,200);assert.equal(f.store.wallet(admin.data.user.id).balance_minor,500);
  }
});

test('signed JSON parser preserves source bytes, rejects duplicate nested keys, and amounts stay exact',()=>{
  const raw='{"response": {"text":"\\u4e2d\\/\\\"", "items":[1,2]},"sign":"abc"}';const parsed=paymentJSON(raw);assert.equal(parsed.fields.response,'{"text":"\\u4e2d\\/\\\"", "items":[1,2]}');
  for(const input of ['{"id":1,"id":2}','{"data":{"id":1,"id":2}}','{"data":[{"id":1,"id":2}]}'])assert.throws(()=>paymentJSON(input));
  assert.equal(paymentAmount('12.34'),1234);for(const input of ['1e2','1.001','-1','NaN','1.2x'])assert.throws(()=>paymentAmount(input));
});


test('changing an Alipay source never changes previously admitted orders or their credentials',async t=>{
 const remote=providerFixture(),f=await fixture(t,{withoutCore:true,paymentTransport:remote.transport});const admin=await f.request('POST','/api/setup',{...owner,setup_token:f.setupToken});
 assert.equal((await f.request('PATCH','/api/admin/payment',{expected_revision:1,providers:{alipay:remote.configs.alipay,easypay:remote.configs.easypay},methods:{alipay:{enabled:true,source:'official_alipay'}}},admin)).status,200);
 const first=await f.request('POST','/api/me/payments',{amount_minor:200,payment_method:'alipay'},admin);assert.equal(first.status,201);
 assert.equal((await f.request('PATCH','/api/admin/payment',{expected_revision:2,methods:{alipay:{enabled:true,source:'easypay_alipay'}}},admin)).status,200);
 const second=await f.request('POST','/api/me/payments',{amount_minor:300,payment_method:'alipay'},admin);assert.equal(second.status,201);
 assert.equal(first.data.order.provider,'alipay');assert.equal(second.data.order.provider,'easypay');
 for(const payment of [first,second]){const order=payment.data.order;remote.orders.get(order.id).paid=true;const hook=remote.notification(order.provider,order.id);assert.equal((await f.request('POST',hook.path,hook.raw,{raw:true,headers:hook.headers})).status,200);}
 assert.equal(f.store.wallet(admin.data.user.id).balance_minor,500);
});


test('SuixingPay RSA/SHA-1 merchant contracts use their configured algorithm, not a hardcoded RSA2 variant',async t=>{
 const remote=providerFixture();remote.configs.suixingpay.sign_type='RSA';
 const f=await fixture(t,{withoutCore:true,paymentTransport:remote.transport}),admin=await f.request('POST','/api/setup',{...owner,setup_token:f.setupToken});
 assert.equal((await f.request('PATCH','/api/admin/payment',{expected_revision:1,providers:{suixingpay:remote.configs.suixingpay},methods:{alipay:{enabled:true,source:'suixingpay_alipay'}}},admin)).status,200);
 const created=await f.request('POST','/api/me/payments',{amount_minor:200,payment_method:'alipay'},admin);assert.equal(created.status,201);
 const id=created.data.order.id;remote.orders.get(id).paid=true;const hook=remote.notification('suixingpay',id);
 assert.equal((await f.request('POST',hook.path,hook.raw,{raw:true,headers:hook.headers})).status,200);assert.equal(f.store.wallet(admin.data.user.id).balance_minor,200);
});


for(const [provider,method,source] of cases)test(provider+' / '+method+': confirmed online term payment funds and delivers once',async t=>{
 const remote=providerFixture(),f=await fixture(t,{paymentTransport:remote.transport});const admin=await f.request('POST','/api/setup',{...owner,setup_token:f.setupToken});
 assert.equal((await f.request('PATCH','/api/admin/payment',{expected_revision:1,providers:{[provider]:remote.configs[provider]},methods:{[method]:{enabled:true,source}}},admin)).status,200);
 const made=await f.request('POST','/api/admin/plans',{name:'Native payment plan',description:'Fixture',resource_id:'resource-1',duration_days:7,amount_minor:300,status:'active'},admin);assert.equal(made.status,201,made.raw);
 const body={plan_id:made.data.plan.id,expected_revision:made.data.plan.revision,payment_method:method,platform:'MacOS/arm64',request_id:randomUUID()};
 const purchase=await f.request('POST','/api/me/rentals',body,admin);assert.equal(purchase.status,201,purchase.raw);assert.equal(purchase.data.payment.order.provider,provider);
 const order=purchase.data.payment.order;remote.orders.get(order.id).paid=true;const hook=remote.notification(provider,order.id);
 assert.equal((await f.request('POST',hook.path,hook.raw,{raw:true,headers:hook.headers})).status,200);
 await f.reconciler.run();assert.equal(f.store.db.prepare('SELECT status FROM rentals WHERE id=?').get(purchase.data.rental.id).status,'fulfilled');assert.equal(f.store.wallet(admin.data.user.id).balance_minor,0);
 assert.equal((await f.request('POST',hook.path,hook.raw,{raw:true,headers:hook.headers})).status,200);const count=remote.requests.length;
 assert.equal((await f.request('POST','/api/me/rentals',body,admin)).status,200);assert.equal(remote.requests.length,count);
 assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM ledger WHERE kind='payment_credit'").get().n,1);assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM ledger WHERE kind='rental_debit'").get().n,1);
});


test('missing historical provider credentials fail before any network call',()=>{
 assert.throws(()=>validateProviderConfig('stripe',{}),error=>error.code==='invalid_provider_config');
 assert.throws(()=>validateProviderConfig('stripe',{secret_key:'sk_test_fixture'}),error=>error.code==='invalid_provider_config');
 assert.doesNotThrow(()=>validateProviderConfig('stripe',{secret_key:'sk_test_fixture'},{allowMissingWebhook:true}));
});
