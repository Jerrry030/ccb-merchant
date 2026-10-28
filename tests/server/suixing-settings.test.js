import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { fixture,password } from './fixtures.js';
import { providerFixture } from './payment-provider-fixture.js';
import { validateProviderConfig } from '../../src/payment-providers.js';

const owner={email:'admin@example.test',password,display_name:'Suixing settings owner'};

test('Suixing 1024-bit bare PKCS1 merchant draft can be enabled without resubmitting saved secrets or contacting a provider',async t=>{
 const remote=providerFixture({merchantBits:1024});
 const config={...remote.configs.suixingpay,enabled:false,sign_type:'RSA',private_key:createPrivateKey(remote.configs.suixingpay.private_key).export({format:'der',type:'pkcs1'}).toString('base64'),public_key:createPublicKey(remote.configs.suixingpay.public_key).export({format:'der',type:'spki'}).toString('base64')};
 const f=await fixture(t,{withoutCore:true,paymentTransport:remote.transport}),admin=await f.request('POST','/api/setup',{...owner,setup_token:f.setupToken});
 const draft=await f.request('PATCH','/api/admin/payment',{expected_revision:1,providers:{suixingpay:config}},admin);assert.equal(draft.status,200,draft.raw);
 const saved=await f.request('PATCH','/api/admin/payment',{expected_revision:2,providers:{suixingpay:{enabled:true,private_key:'',public_key:''}}},admin);
 assert.equal(saved.status,200,saved.raw);assert.equal(saved.data.payment.providers.find(p=>p.id==='suixingpay').ready,true);
 assert.equal(remote.requests.length,0);assert.equal(saved.raw.includes(config.private_key),false);assert.equal(saved.raw.includes(config.public_key),false);
 const check=await f.request('POST','/api/admin/payment/test',{provider:'suixingpay'},admin);assert.equal(check.status,200,check.raw);assert.equal(check.data.scope,'configuration');assert.equal(check.data.remote_verified,false);assert.equal(remote.requests.length,0);
 const stored=JSON.parse(f.store.db.prepare("SELECT value FROM settings WHERE key='payment'").get().value).providers.suixingpay;assert.equal(stored.private_key,config.private_key);assert.equal(stored.public_key,config.public_key);
 await f.restart();assert.equal((await f.request('GET','/api/admin/payment',undefined,admin)).data.payment.providers.find(p=>p.id==='suixingpay').ready,true);
 assert.equal((await f.request('GET','/api/admin/audit',undefined,admin)).raw.includes(config.private_key),false);
});

for(const merchantBits of [1024,2048])for(const algorithm of ['RSA','RSA2'])test('Suixing '+merchantBits+'-bit merchant / '+algorithm+' signs create and query while verifying 2048-bit platform callbacks',async t=>{
 const remote=providerFixture({merchantBits});remote.configs.suixingpay.sign_type=algorithm;
 const f=await fixture(t,{withoutCore:true,paymentTransport:remote.transport}),admin=await f.request('POST','/api/setup',{...owner,setup_token:f.setupToken});
 const saved=await f.request('PATCH','/api/admin/payment',{expected_revision:1,providers:{suixingpay:remote.configs.suixingpay},methods:{alipay:{enabled:true,source:'suixingpay_alipay'}}},admin);assert.equal(saved.status,200,saved.raw);
 const created=await f.request('POST','/api/me/payments',{amount_minor:300,payment_method:'alipay'},admin);assert.equal(created.status,201,created.raw);
 const id=created.data.order.id;remote.orders.get(id).paid=true;const notification=remote.notification('suixingpay',id);
 assert.equal((await f.request('POST',notification.path,notification.raw,{raw:true,headers:notification.headers})).status,200);
 assert.equal((await f.request('POST','/api/me/payments/'+id+'/reconcile',{},admin)).status,200);
 assert.equal(f.store.wallet(admin.data.user.id).balance_minor,300);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM ledger WHERE order_id=?').get(id).n,1);
});

test('Suixing merchant compatibility does not lower platform or other provider RSA requirements',()=>{
 const remote=providerFixture({merchantBits:1024});
 for(const format of ['pem','der'])for(const type of ['pkcs1','pkcs8']){
  const encoded=createPrivateKey(remote.configs.suixingpay.private_key).export({format,type});
  assert.doesNotThrow(()=>validateProviderConfig('suixingpay',{...remote.configs.suixingpay,private_key:format==='der'?encoded.toString('base64'):encoded}));
 }
 for(const provider of ['alipay','wxpay'])assert.throws(()=>validateProviderConfig(provider,remote.configs[provider]),error=>error.code==='invalid_payment_key'&&error.message.includes('2048')&&error.message.includes('私钥'));
 const platform1024=createPublicKey(remote.configs.suixingpay.private_key).export({type:'spki',format:'pem'});
 assert.throws(()=>validateProviderConfig('suixingpay',{...remote.configs.suixingpay,public_key:platform1024}),error=>error.code==='invalid_payment_key'&&error.message.includes('平台公钥')&&error.message.includes('2048'));
 const below1024=generateKeyPairSync('rsa',{modulusLength:512}).privateKey.export({type:'pkcs8',format:'pem'});
 assert.throws(()=>validateProviderConfig('suixingpay',{...remote.configs.suixingpay,private_key:below1024}),error=>error.code==='invalid_payment_key'&&error.message.includes('商户私钥')&&error.message.includes('1024'));
 const nonRSA=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({type:'pkcs8',format:'pem'});
 assert.throws(()=>validateProviderConfig('suixingpay',{...remote.configs.suixingpay,private_key:nonRSA}),error=>error.code==='invalid_payment_key');
});

test('invalid Suixing keys report the affected field without leaking values and failed saves remain atomic',async t=>{
 const remote=providerFixture(),f=await fixture(t,{withoutCore:true,paymentTransport:remote.transport}),admin=await f.request('POST','/api/setup',{...owner,setup_token:f.setupToken});
 const invalid='fixture-invalid-private-key-secret-0123456789';
 const bad=await f.request('PATCH','/api/admin/payment',{expected_revision:1,providers:{suixingpay:{...remote.configs.suixingpay,private_key:invalid}}},admin);
 assert.equal(bad.status,400);assert.equal(bad.data.error.code,'invalid_payment_key');assert.match(bad.data.error.message,/随行付.*商户私钥/);assert.equal(bad.raw.includes(invalid),false);
 const testResult=await f.request('POST','/api/admin/payment/test',{provider:'suixingpay',config:{...Object.fromEntries(Object.entries(remote.configs.suixingpay).filter(([key])=>key!=='enabled')),private_key:invalid}},admin);
 assert.equal(testResult.status,400);assert.equal(testResult.data.error.code,'invalid_payment_key');assert.equal(testResult.raw.includes(invalid),false);
 assert.equal((await f.request('GET','/api/admin/payment',undefined,admin)).data.payment.revision,1);assert.equal(remote.requests.length,0);
});
