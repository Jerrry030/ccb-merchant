import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { fixture, stripeFixture, password } from './fixtures.js';
import { applyMailUpdate } from '../../src/integrations.js';

const owner={email:'admin@example.test',password,display_name:'Owner'};
const mail={enabled:true,host:'smtp.example.test',port:587,username:'mailer',password:'fixture-smtp-secret',from:'sender@example.test',from_name:'测试发件人',use_tls:true};
const stripeEnv={STRIPE_SECRET_KEY:'sk_test_isolated_fixture',STRIPE_WEBHOOK_SECRET:'whsec_test_fixture'};

test('unsaved mail connection and delivery use the submitted draft without persisting or leaking credentials',async t=>{
  const calls=[];
  const f=await fixture(t,{withoutCore:true,mailTransportFactory:options=>{
    const call={options,closed:false};calls.push(call);
    return {async verify(){call.verified=true;},async sendMail(message){call.message=message;return {accepted:[message.to]};},close(){call.closed=true;}};
  }});
  const admin=await f.request('POST','/api/setup',{...owner,setup_token:f.setupToken});
  const before=f.store.db.prepare("SELECT value FROM settings WHERE key='mail'").get().value;
  assert.equal((await f.request('POST','/api/admin/mail/test',{mail},admin)).data.mode,'connection');
  const sent=await f.request('POST','/api/admin/mail/test',{mail,recipient:'inbox@example.test'},admin);
  assert.equal(sent.status,200);assert.equal(sent.data.mode,'send');
  assert.equal(calls[0].options.host,mail.host);assert.equal(calls[0].options.auth.pass,mail.password);
  assert.equal(calls[0].verified,true);assert.equal(calls[1].message.to,'inbox@example.test');
  assert.match(calls[1].message.from,/sender@example.test/);assert.ok(calls.every(call=>call.closed));
  assert.equal(f.store.db.prepare("SELECT value FROM settings WHERE key='mail'").get().value,before);
  assert.equal((await f.request('GET','/api/public')).data.features.password_reset,false);
  const audit=await f.request('GET','/api/admin/audit',undefined,admin);
  assert.equal((sent.raw+audit.raw).includes(mail.password),false);
  assert.equal((sent.raw+audit.raw).includes('sender@example.test'),false);
  assert.equal((await f.request('POST','/api/admin/mail/test',{mail,recipient:'bad-address'},admin)).status,400);
  assert.equal(calls.length,2);
});

test('blank SMTP passwords only reuse the saved credential for the unchanged destination and auth context',async t=>{
  const calls=[];
  const f=await fixture(t,{withoutCore:true,mailTransportFactory:options=>({async verify(){calls.push(options);},close(){}})});
  const admin=await f.request('POST','/api/setup',{...owner,setup_token:f.setupToken});
  assert.equal((await f.request('PATCH','/api/admin/mail',{expected_revision:1,mail},admin)).status,200);
  assert.equal((await f.request('POST','/api/admin/mail/test',{mail:{...mail,password:''}},admin)).status,200);
  assert.equal(calls[0].auth.pass,mail.password);
  const changed=await f.request('POST','/api/admin/mail/test',{mail:{...mail,host:'another.example.test',password:''}},admin);
  assert.equal(changed.status,400);assert.equal(changed.data.error.code,'mail_password_required');assert.equal(calls.length,1);
  for(const change of [{port:465},{username:'other'},{use_tls:false}]) assert.throws(()=>applyMailUpdate({host:mail.host,port:587,user:'mailer',pass:mail.password,use_tls:true},{...mail,...change,password:''}),error=>error.code==='mail_password_required');
  assert.equal((await f.request('POST','/api/admin/mail/test',{mail:{...mail,host:'another.example.test',password:'new-fixture-password'}},admin)).status,200);
  assert.equal(calls[1].auth.pass,'new-fixture-password');
  assert.equal((await f.request('PATCH','/api/admin/mail',{expected_revision:1,mail},admin)).data.error.code,'settings_changed');
  assert.equal((await f.request('PATCH','/api/admin/mail',{expected_revision:2,mail:{...mail,enabled:false,password:''}},admin)).status,200);
  assert.equal((await f.request('GET','/api/public')).data.features.password_reset,false);
  assert.equal((await f.request('GET','/api/admin/mail',undefined,admin)).data.mail.password_configured,true);
});

test('mail failures are sanitized, rate limited and protected by admin and CSRF checks',async t=>{
  let closed=0,called=0;
  const f=await fixture(t,{withoutCore:true,mailTransportFactory:()=>({async verify(){called++;throw Object.assign(new Error('private smtp-secret-value'),{code:'EAUTH'});},close(){closed++;}})});
  const admin=await f.request('POST','/api/setup',{...owner,setup_token:f.setupToken});
  const badCsrf=await f.request('POST','/api/admin/mail/test',{mail},{...admin,csrf:'invalid'});
  assert.equal(badCsrf.status,403);assert.equal(called,0);
  const member=await f.request('POST','/api/admin/users',{email:'member@example.test',password,display_name:'Member',role:'member'},admin);
  assert.equal(member.status,201);
  const login=await f.request('POST','/api/auth/login',{email:'member@example.test',password});
  assert.equal((await f.request('POST','/api/admin/mail/test',{mail},login)).status,403);
  for(let i=0;i<5;i++){
    const result=await f.request('POST','/api/admin/mail/test',{mail},admin);
    assert.equal(result.data.error.code,'mail_auth_failed');assert.equal(result.raw.includes('smtp-secret-value'),false);
  }
  assert.equal(closed,5);assert.equal((await f.request('POST','/api/admin/mail/test',{mail},admin)).status,429);
});

test('real Nodemailer performs unsaved SMTP verification and sends a message to an isolated loopback SMTP server',async t=>{
  const messages=[],sockets=new Set();
  const smtp=createServer(socket=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});
    socket.write('220 localhost SMTP fixture\r\n');
    let buffer='',data=false;
    socket.on('data',chunk=>{
      buffer+=chunk.toString();
      while(buffer){
        if(data){const end=buffer.indexOf('\r\n.\r\n');if(end<0)return;messages.push(buffer.slice(0,end));buffer=buffer.slice(end+5);data=false;socket.write('250 accepted\r\n');continue;}
        const end=buffer.indexOf('\r\n');if(end<0)return;
        const line=buffer.slice(0,end);buffer=buffer.slice(end+2);
        if(line.startsWith('EHLO'))socket.write('250-localhost\r\n250 PIPELINING\r\n');
        else if(line==='DATA'){data=true;socket.write('354 send data\r\n');}
        else if(line==='QUIT'){socket.end('221 bye\r\n');}
        else socket.write('250 OK\r\n');
      }
    });
  });
  smtp.listen(0,'127.0.0.1');await once(smtp,'listening');
  t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>smtp.close(resolve));});
  const f=await fixture(t,{withoutCore:true});const admin=await f.request('POST','/api/setup',{...owner,setup_token:f.setupToken});
  const draft={host:'127.0.0.1',port:smtp.address().port,username:'',password:'',from:'sender@example.test',from_name:'Fixture',use_tls:false};
  assert.equal((await f.request('POST','/api/admin/mail/test',{mail:draft},admin)).status,200);
  const result=await f.request('POST','/api/admin/mail/test',{mail:draft,recipient:'inbox@example.test'},admin);
  assert.equal(result.status,200);assert.equal(messages.length,1);assert.match(messages[0],/To: inbox@example.test/);assert.match(messages[0],/From: Fixture <sender@example.test>/);
  assert.equal(JSON.parse(f.store.db.prepare("SELECT value FROM settings WHERE key='mail'").get().value).config,null);
});

test('payment rules govern admission, pending reservations and UTC daily limits while paused payments still settle',async t=>{
  const stripe=stripeFixture(),f=await fixture(t,{withoutCore:true,env:stripeEnv,paymentTransport:stripe.transport});
  const admin=await f.request('POST','/api/setup',{...owner,setup_token:f.setupToken});
  const updated=await f.request('PATCH','/api/admin/payment',{expected_revision:1,min_amount_minor:200,max_amount_minor:800,daily_limit_minor:1000,max_pending_orders:1,order_timeout_minutes:90,product_name:'测试充值'},admin);
  assert.equal(updated.status,200);
  assert.equal((await f.request('POST','/api/me/payments',{amount_minor:100},admin)).data.error.code,'invalid_amount');
  assert.equal((await f.request('POST','/api/me/payments',{amount_minor:600},admin)).status,201);
  const form=new URLSearchParams(stripe.calls[0].options.body);
  assert.equal(form.get('line_items[0][price_data][product_data][name]'),'测试充值');
  assert.ok(Number(form.get('expires_at'))>Date.now()/1000+89*60);
  assert.equal((await f.request('POST','/api/me/payments',{amount_minor:200},admin)).data.error.code,'payment_pending_limit');
  const session=[...stripe.sessions.values()][0];session.payment_status='paid';session.status='complete';
  const event=stripe.event(session.id);assert.equal((await f.request('POST','/api/webhooks/stripe',event.payload,{headers:{'Stripe-Signature':event.signature}})).status,200);
  assert.equal((await f.request('POST','/api/me/payments',{amount_minor:500},admin)).data.error.code,'payment_daily_limit');
  assert.equal((await f.request('POST','/api/me/payments',{amount_minor:200},admin)).status,201);
  assert.equal((await f.request('PATCH','/api/admin/payment',{expected_revision:2,enabled:false},admin)).status,200);
  assert.equal((await f.request('POST','/api/me/payments',{amount_minor:200},admin)).data.error.code,'payment_disabled');
  const second=[...stripe.sessions.values()][1];second.payment_status='paid';second.status='complete';const paid=stripe.event(second.id);
  assert.equal((await f.request('POST','/api/webhooks/stripe',paid.payload,{headers:{'Stripe-Signature':paid.signature}})).status,200);
  assert.equal(f.store.wallet(admin.data.user.id).balance_minor,800);
  assert.equal((await f.request('GET','/api/public')).data.features.payment,false);
  assert.equal(stripe.calls.filter(call=>call.options.method==='POST').length,2);
});

test('concurrent checkout admission never exceeds the configured pending limit',async t=>{
  const stripe=stripeFixture(),f=await fixture(t,{withoutCore:true,env:stripeEnv,paymentTransport:stripe.transport});
  const admin=await f.request('POST','/api/setup',{...owner,setup_token:f.setupToken});
  await f.request('PATCH','/api/admin/payment',{expected_revision:1,max_pending_orders:1},admin);
  const results=await Promise.all([1,2,3].map(()=>f.request('POST','/api/me/payments',{amount_minor:100},admin)));
  assert.equal(results.filter(result=>result.status===201).length,1);
  assert.equal(results.filter(result=>result.data.error?.code==='payment_pending_limit').length,2);
  assert.equal(stripe.calls.filter(call=>call.options.method==='POST').length,1);
});

test('Stripe draft API tests do not save or create orders, and configuration revisions and bounds fail closed',async t=>{
  const calls=[];const f=await fixture(t,{withoutCore:true,paymentTransport:async(url,options)=>{calls.push({url,options});return Response.json({object:'balance',livemode:false});}});
  const admin=await f.request('POST','/api/setup',{...owner,setup_token:f.setupToken});
  const original=f.store.db.prepare("SELECT value FROM settings WHERE key='payment'").get().value;
  const tested=await f.request('POST','/api/admin/payment/test',{provider:'stripe',config:{secret_key:'sk_test_unsaved_fixture'}},admin);
  assert.equal(tested.status,200);assert.equal(tested.data.webhook_verified,false);assert.equal(tested.raw.includes('sk_test_unsaved_fixture'),false);
  assert.equal(calls[0].options.headers.Authorization,'Bearer sk_test_unsaved_fixture');assert.equal(calls[0].options.method,'GET');assert.equal(calls[0].url,'https://api.stripe.com/v1/balance');
  assert.equal(f.store.db.prepare("SELECT value FROM settings WHERE key='payment'").get().value,original);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM orders').get().n,0);
  assert.equal((await f.request('POST','/api/admin/payment/test',{provider:'easypay'},admin)).status,400);
  assert.equal((await f.request('POST','/api/admin/payment/test',{provider:'stripe',config:null},admin)).status,400);
  for(const body of [{min_amount_minor:200,max_amount_minor:100},{min_amount_minor:1.5},{order_timeout_minutes:29},{enabled:'true'},{providers:{unknown:{}}}]) assert.equal((await f.request('PATCH','/api/admin/payment',{expected_revision:1,...body},admin)).status,400);
  assert.equal((await f.request('PATCH','/api/admin/payment',{expected_revision:1,help_text:'请核对订单后付款'},admin)).status,200);
  assert.equal((await f.request('PATCH','/api/admin/payment',{expected_revision:1,enabled:false},admin)).data.error.code,'settings_changed');
  assert.equal((await f.request('PATCH','/api/admin/settings',{payment:{}},admin)).status,400);
});

test('legacy mixed services migrate atomically without losing credentials or changing users and survive reopening',async t=>{
  const stripe=stripeFixture(),f=await fixture(t,{withoutCore:true,paymentTransport:stripe.transport});
  const admin=await f.request('POST','/api/setup',{...owner,setup_token:f.setupToken});
  f.store.transaction(()=>{
    f.store.db.prepare("DELETE FROM settings WHERE key IN ('mail','payment')").run();
    f.store.db.prepare('INSERT INTO settings VALUES (?,?)').run('services',JSON.stringify({mail:{host:mail.host,port:587,user:mail.username,pass:mail.password,from:mail.from,use_tls:true},stripe:{secret:'sk_test_isolated_fixture',webhook_secret:'whsec_test_fixture'},payment_catalog:{providers:{easypay:{enabled:false,pid:'1001',pkey:'preserve-fixture-secret',api_base:'https://example.test'}}}}));
  });
  await f.restart();
  assert.equal(f.store.db.prepare("SELECT 1 FROM settings WHERE key='services'").get(),undefined);
  assert.equal((await f.request('GET','/api/admin/mail',undefined,admin)).data.mail.password_configured,true);
  const payment=await f.request('GET','/api/admin/payment',undefined,admin);
  assert.equal(payment.data.payment.configured,true);assert.equal(payment.raw.includes('preserve-fixture-secret'),false);
  const stored=f.store.db.prepare("SELECT value FROM settings WHERE key='payment'").get().value;
  assert.ok(stored.includes('preserve-fixture-secret'));assert.ok(stored.includes('sk_test_isolated_fixture'));
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM users').get().n,1);
  await f.restart();assert.equal(f.store.db.prepare("SELECT value FROM settings WHERE key='payment'").get().value,stored);
  assert.equal((await f.request('POST','/api/me/payments',{amount_minor:200},admin)).status,201);
});


test('Stripe clear is explicit and pending-protected, while a paused channel can still settle',async t=>{
  const stripe=stripeFixture(),f=await fixture(t,{withoutCore:true,paymentTransport:stripe.transport});
  const admin=await f.request('POST','/api/setup',{...owner,setup_token:f.setupToken});
  assert.equal((await f.request('PATCH','/api/admin/payment',{expected_revision:1,providers:{stripe:{enabled:true,secret_key:'sk_test_isolated_fixture',webhook_secret:'whsec_test_fixture'}},methods:{stripe:{enabled:true,source:'stripe_checkout'}}},admin)).status,200);
  assert.equal((await f.request('POST','/api/me/payments',{amount_minor:300},admin)).status,201);
  assert.equal((await f.request('PATCH','/api/admin/payment',{expected_revision:2,providers:{stripe:{enabled:false,clear_secrets:true}}},admin)).data.error.code,'payment_pending');
  assert.equal((await f.request('PATCH','/api/admin/payment',{expected_revision:2,providers:{stripe:{enabled:false}}},admin)).status,200);
  assert.equal((await f.request('POST','/api/me/payments',{amount_minor:300},admin)).data.error.code,'payment_disabled');
  const session=[...stripe.sessions.values()][0];session.status='complete';session.payment_status='paid';const event=stripe.event(session.id);
  assert.equal((await f.request('POST','/api/webhooks/stripe',event.payload,{headers:{'Stripe-Signature':event.signature}})).status,200);
  assert.equal(f.store.wallet(admin.data.user.id).balance_minor,300);
  assert.equal((await f.request('PATCH','/api/admin/payment',{expected_revision:3,providers:{stripe:{clear_secrets:true}}},admin)).status,200);
  const saved=JSON.parse(f.store.db.prepare("SELECT value FROM settings WHERE key='payment'").get().value);
  assert.equal(saved.providers.stripe.secret_key,'');assert.equal(saved.providers.stripe.webhook_secret,'');
});
