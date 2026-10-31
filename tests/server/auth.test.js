import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.js';
import { fixture, password } from './fixtures.js';

const credentials={email:'admin@example.test',password,display_name:'Administrator'};

test('network configuration fails closed and credentials are service-scoped',()=>{
  assert.equal(loadConfig({}).host,'127.0.0.1');
  assert.throws(()=>loadConfig({HOST:'0.0.0.0'}),/Network operation/);
  assert.throws(()=>loadConfig({HOST:'0.0.0.0',ALLOW_REMOTE:'true'}),/Network operation/);
  assert.throws(()=>loadConfig({PUBLIC_ORIGIN:'http://store.example',ALLOW_REMOTE:'true'}),/HTTPS/);
  assert.throws(()=>loadConfig({UPSTREAM_URL:'https://core.example',UPSTREAM_API_KEY:'platform-admin-key'}),/owner-scoped/);
  assert.throws(()=>loadConfig({UPSTREAM_URL:'https://core.example'}),/both/);
  assert.throws(()=>loadConfig({DATA_DIR:'public/private'}),/outside public/);
  assert.throws(()=>loadConfig({SMTP_HOST:'localhost'}),/SMTP/);
  assert.throws(()=>loadConfig({STRIPE_SECRET_KEY:'sk_test_foo'}),/Stripe/);
  assert.equal(loadConfig({HOST:'0.0.0.0',PUBLIC_ORIGIN:'https://store.example',ALLOW_REMOTE:'true'}).secureCookies,true);
});

test('bootstrap secret stays private, one-time setup rotates cookie and cannot be replayed after restart',async t=>{
  const f=await fixture(t,{withoutCore:true});
  const before=await f.request('GET','/api/public');
  assert.equal(before.data.setup_required,true);assert.equal(before.raw.includes(f.setupToken),false);
  assert.equal(before.data.site.public_origin,f.config.publicOrigin);
  assert.deepEqual(before.data.features,{registration:false,email_verification:false,password_reset:false,payment:false,recharge:false,token_billing:false,term_rentals:false});
  assert.equal((await f.request('GET','/data/setup.secret')).status,404);
  assert.equal((await f.request('GET','/src/server.js')).status,404);
  assert.equal((await f.request('POST','/api/setup',{...credentials,setup_token:'incorrect'})).status,403);
  const admin=await f.request('POST','/api/setup',{...credentials,setup_token:f.setupToken});
  assert.equal(admin.status,201);assert.equal(admin.data.user.role,'admin');
  assert.match(admin.headers.get('set-cookie'),/HttpOnly/);assert.match(admin.headers.get('set-cookie'),/SameSite=Lax/);
  assert.equal((await f.request('GET','/api/auth/session',undefined,admin)).data.user.id,admin.data.user.id);
  await assert.rejects(access(f.store.setupFile));
  const stored=f.store.db.prepare('SELECT password_hash FROM users').get().password_hash;
  assert.match(stored,/^scrypt-v1\$/);assert.equal(stored.includes(password),false);
  await f.restart();
  assert.equal((await f.request('POST','/api/setup',{...credentials,setup_token:f.setupToken})).status,403);
  assert.equal((await f.request('GET','/api/public')).data.setup_required,false);
  const login=await f.request('POST','/api/auth/login',{email:credentials.email,password},admin);
  assert.equal(login.status,200);assert.notEqual(login.cookie,admin.cookie);
  assert.equal((await f.request('GET','/api/auth/session',undefined,admin)).status,401);
  assert.equal((await f.request('GET','/api/auth/session',undefined,login)).status,200);
});

test('Host, Origin, CSRF, role, and session checks protect all browser writes',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('GET','/api/public',undefined,{headers:{Host:'attacker.example'}})).status,421);
  assert.equal((await f.request('POST','/api/auth/login',credentials,{headers:{Origin:'https://attacker.example'}})).status,403);
  const admin=await f.request('POST','/api/setup',{...credentials,setup_token:f.setupToken});
  assert.equal((await f.request('PATCH','/api/admin/settings',{name:'changed'},{cookie:admin.cookie})).status,403);
  assert.equal((await f.request('PATCH','/api/admin/settings',{name:'changed'},{...admin,headers:{Origin:'null'}})).status,403);
  const member=await f.request('POST','/api/admin/users',{email:'member@example.test',password,display_name:'Member',role:'member'},admin);
  assert.equal(member.status,201);
  const login=await f.request('POST','/api/auth/login',{email:'member@example.test',password});
  assert.equal((await f.request('GET','/api/admin/users',undefined,login)).status,403);
  assert.equal((await f.request('POST','/api/admin/users',{email:'bad@example.test',password,display_name:'bad',role:'admin'},login)).status,403);
  assert.equal((await f.request('PATCH','/api/auth/password',{current_password:password,new_password:'replacement password 456!'},login)).status,200);
  assert.equal((await f.request('GET','/api/auth/session',undefined,login)).status,401);
  assert.equal((await f.request('POST','/api/auth/login',{email:'member@example.test',password})).status,401);
  const relogin=await f.request('POST','/api/auth/login',{email:'member@example.test',password:'replacement password 456!'});
  assert.equal(relogin.status,200);
  assert.equal((await f.request('POST','/api/auth/logout',undefined,relogin)).status,200);
  assert.equal((await f.request('GET','/api/auth/session',undefined,relogin)).status,401);
});

test('last active admin is protected in HTTP and SQLite, and self-disable is rejected',async t=>{
  const f=await fixture(t), admin=await f.request('POST','/api/setup',{...credentials,setup_token:f.setupToken});
  const id=admin.data.user.id;
  assert.equal((await f.request('PATCH',`/api/admin/users/${id}`,{...({role:'member'}),expected_revision:f.store.db.prepare('SELECT revision FROM users WHERE id=?').get((`/api/admin/users/${id}`).split('/').at(-1))?.revision},admin)).data.error.code,'last_admin');
  assert.equal((await f.request('PATCH',`/api/admin/users/${id}`,{...({status:'disabled'}),expected_revision:f.store.db.prepare('SELECT revision FROM users WHERE id=?').get((`/api/admin/users/${id}`).split('/').at(-1))?.revision},admin)).data.error.code,'self_disable');
  assert.throws(()=>f.store.db.prepare('DELETE FROM users WHERE id=?').run(id),/last_admin/);
  assert.throws(()=>f.store.db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(id),/last_admin/);
  const second=await f.request('POST','/api/admin/users',{email:'second@example.test',password,display_name:'Second',role:'admin'},admin);
  assert.equal(second.status,201);
  assert.equal((await f.request('PATCH',`/api/admin/users/${id}`,{...({role:'member'}),expected_revision:f.store.db.prepare('SELECT revision FROM users WHERE id=?').get((`/api/admin/users/${id}`).split('/').at(-1))?.revision},admin)).status,200);
  assert.equal((await f.request('GET','/api/admin/users',undefined,admin)).status,401);
});

test('unconfigured email/payment stay safely disabled and never create simulated orders',async t=>{
  const f=await fixture(t,{withoutCore:true}), admin=await f.request('POST','/api/setup',{...credentials,setup_token:f.setupToken});
  assert.equal((await f.request('PATCH','/api/admin/settings',{registration_enabled:true},admin)).data.features.registration,false);
  assert.equal((await f.request('POST','/api/auth/register',{email:'new@example.test',password,display_name:'New'})).status,503);
  assert.equal((await f.request('POST','/api/auth/forgot-password',{email:'missing@example.test'})).status,200);
  assert.equal((await f.request('POST','/api/me/payments',{amount_minor:100},admin)).status,503);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM orders').get().n,0);
  const overview=await f.request('GET','/api/me/overview',undefined,admin);
  assert.deepEqual(overview.data.connection,{configured:false,available:false});assert.equal(overview.data.usage,null);
  assert.deepEqual((await f.request('GET','/api/me/wallet',undefined,admin)).data.wallet,{balance_minor:0,currency:'CNY'});
  const mail=await f.request('GET','/api/admin/mail',undefined,admin), payment=await f.request('GET','/api/admin/payment',undefined,admin);
  assert.equal(mail.data.mail.configured,false);assert.equal(payment.data.payment.configured,false);
});

test('registration requires verification; tokens are hashed, expire, single-use and resets revoke all sessions',async t=>{
  const deliveries=[];
  const f=await fixture(t,{env:{SMTP_HOST:'smtp.example.invalid',SMTP_FROM:'merchant@example.test'},mailer:{async send(address,kind,token){deliveries.push({address,kind,token});}}});
  const admin=await f.request('POST','/api/setup',{...credentials,setup_token:f.setupToken});
  await f.request('PATCH','/api/admin/settings',{registration_enabled:true},admin);
  const registered=await f.request('POST','/api/auth/register',{email:'new@example.test',password,display_name:'New'});
  assert.deepEqual(registered.data,{status:'verification_required',delivery:'sent'});
  assert.equal((await f.request('POST','/api/auth/login',{email:'new@example.test',password})).status,401);
  assert.equal(deliveries[0].kind,'verify');
  const token=deliveries[0].token;
  assert.match(token,/^\d{6}$/);
  assert.equal(JSON.stringify(f.store.db.prepare('SELECT * FROM auth_tokens').all()).includes(token),false);
  assert.equal((await f.request('POST','/api/auth/verify',{email:'new@example.test',code:token==='000000'?'111111':'000000'})).status,400);
  assert.equal((await f.request('POST','/api/auth/verify',{email:'new@example.test',code:token})).status,200);
  assert.equal((await f.request('POST','/api/auth/verify',{email:'new@example.test',code:token})).status,400);
  const session=await f.request('POST','/api/auth/login',{email:'new@example.test',password});assert.equal(session.status,200);
  const miss=await f.request('POST','/api/auth/forgot-password',{email:'absent@example.test'});
  const known=await f.request('POST','/api/auth/forgot-password',{email:'new@example.test'});
  assert.deepEqual(miss.data,known.data);
  const reset=deliveries.at(-1).token;
  assert.equal((await f.request('POST','/api/auth/reset-password',{token:reset,password:'new replacement password 123'})).status,200);
  assert.equal((await f.request('GET','/api/auth/session',undefined,session)).status,401);
  assert.equal((await f.request('POST','/api/auth/reset-password',{token:reset,password:'new replacement password 123'})).status,400);
  await f.request('POST','/api/auth/forgot-password',{email:'new@example.test'});
  f.store.db.prepare('UPDATE auth_tokens SET expires_at=0').run();
  assert.equal((await f.request('POST','/api/auth/reset-password',{token:deliveries.at(-1).token,password:'new replacement password 123'})).status,400);
});

test('JSON size limits, SQL-shaped strings, unknown fields and public file boundaries',async t=>{
  const f=await fixture(t), admin=await f.request('POST','/api/setup',{...credentials,setup_token:f.setupToken});
  assert.equal((await f.request('PATCH','/api/admin/settings',{description:'x'.repeat(70000)},admin)).status,413);
  assert.equal((await f.request('PATCH','/api/admin/settings',{UPSTREAM_API_KEY:'stolen'},admin)).status,400);
  assert.equal((await f.request('POST','/api/admin/users',{email:"sql'quote@example.test",password,display_name:"Robert'); DROP TABLE users; --",role:'member'},admin)).status,201);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM users').get().n,2);
  await writeFile(join(f.root,'public','index.html'),'<!doctype html><title>real static test shell</title>');
  assert.match((await f.request('GET','/connect')).raw,/real static test shell/);
  assert.equal((await f.request('GET','/admin/api/users')).status,404);
  assert.equal((await f.request('GET','/.env')).status,404);
  assert.equal((await f.request('GET','/access/v1/customers')).status,401);
  assert.equal((await f.request('GET','/api/admin/settings',undefined,{...admin,headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
  const file=await readFile(join(f.root,'data','merchant.sqlite'));assert.ok(file.length>0);
});

test('setup races atomically and emailed-link navigation is not mistaken for a cross-site API fetch',async t=>{
  const f=await fixture(t);
  const attempts=await Promise.all([
    f.request('POST','/api/setup',{...credentials,setup_token:f.setupToken}),
    f.request('POST','/api/setup',{...credentials,email:'other-admin@example.test',setup_token:f.setupToken}),
  ]);
  assert.equal(attempts.filter(result=>result.status===201).length,1);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM users WHERE role='admin'").get().n,1);
  await writeFile(join(f.root,'public','index.html'),'<!doctype html><title>email landing</title>');
  const landing=await f.request('GET','/verify?token=test-only-token',undefined,{headers:{'Sec-Fetch-Site':'cross-site','Sec-Fetch-Mode':'navigate'}});
  assert.equal(landing.status,200);assert.match(landing.raw,/email landing/);
  assert.equal(landing.headers.get('referrer-policy'),'no-referrer');
  assert.equal((await f.request('GET','/api/auth/session',undefined,{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
});

test('sessions expire, auth throttling survives restart, and HTTPS origins use __Host Secure cookies',async t=>{
  const f=await fixture(t,{env:{PUBLIC_ORIGIN:'https://store.example.test',ALLOW_REMOTE:'true'}});
  const admin=await f.request('POST','/api/setup',{...credentials,setup_token:f.setupToken});
  assert.match(admin.headers.get('set-cookie'),/^__Host-ccb_session=/);assert.match(admin.headers.get('set-cookie'),/; Secure/);
  f.store.db.prepare('UPDATE sessions SET expires_at=0').run();
  assert.equal((await f.request('GET','/api/auth/session',undefined,admin)).status,401);
  for(let i=0;i<35;i++) await f.request('POST','/api/auth/login',{email:'not-valid',password:'wrong'});
  assert.equal((await f.request('POST','/api/auth/login',{email:credentials.email,password})).status,429);
  await f.restart();
  assert.equal((await f.request('POST','/api/auth/login',{email:credentials.email,password})).status,429);
});

test('mail delivery errors reveal neither transport credentials nor verification/reset tokens',async t=>{
  const f=await fixture(t,{env:{SMTP_HOST:'smtp.example.invalid',SMTP_FROM:'merchant@example.test'},mailer:{async send(){throw new Error('SMTP_PASSWORD PRIVATE_DELIVERY_TOKEN');}}});
  const admin=await f.request('POST','/api/setup',{...credentials,setup_token:f.setupToken});
  await f.request('PATCH','/api/admin/settings',{registration_enabled:true},admin);
  const registered=await f.request('POST','/api/auth/register',{email:'mail@example.test',display_name:'Mail',password});
  assert.equal(registered.status,200);assert.equal(registered.data.delivery,'unconfirmed');assert.equal(registered.raw.includes('PRIVATE_DELIVERY_TOKEN'),false);
  const audit=await f.request('GET','/api/admin/audit',undefined,admin);
  assert.ok(audit.data.events.some(event=>event.outcome==='delivery_unknown'));
  assert.equal(audit.raw.includes('SMTP_PASSWORD'),false);
});

test('a verification code is six digits, stored only as a hash, and burned after five failures',async t=>{
  const deliveries=[];
  const f=await fixture(t,{env:{SMTP_HOST:'smtp.example.invalid',SMTP_FROM:'merchant@example.test'},mailer:{async send(address,kind,token){deliveries.push({address,kind,token});}}});
  const admin=await f.request('POST','/api/setup',{...credentials,setup_token:f.setupToken});
  await f.request('PATCH','/api/admin/settings',{registration_enabled:true},admin);
  assert.equal((await f.request('POST','/api/auth/register',{email:'coded@example.test',password,display_name:'Coded'})).status,200);
  const code=deliveries.at(-1).token;
  const wrong=code==='000000'?'111111':'000000';
  assert.match(code,/^\d{6}$/);
  assert.equal(JSON.stringify(f.store.db.prepare('SELECT token_hash,attempts FROM auth_tokens').all()).includes(code),false);
  for(let i=0;i<5;i++) assert.equal((await f.request('POST','/api/auth/verify',{email:'coded@example.test',code:wrong})).status,400);
  assert.equal((await f.request('POST','/api/auth/verify',{email:'coded@example.test',code})).status,400);
  assert.equal((await f.request('POST','/api/auth/resend-verification',{email:'coded@example.test'})).data.ok,true);
  const replacement=deliveries.at(-1).token;
  assert.match(replacement,/^\d{6}$/);
  assert.notEqual(replacement,code);
  assert.equal((await f.request('POST','/api/auth/verify',{email:'coded@example.test',code:replacement})).status,200);
  assert.equal((await f.request('POST','/api/auth/login',{email:'coded@example.test',password})).status,200);
});
