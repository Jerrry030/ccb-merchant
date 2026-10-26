import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture,password,upstreamKey } from './fixtures.js';

const input={email:'admin@example.test',display_name:'Admin',password};

test('upstream wizard verifies before saving, encrypts credentials and pins identity across restarts',async t=>{
 const f=await fixture(t,{withoutCore:true}),admin=await f.request('POST','/api/setup',{...input,setup_token:f.setupToken});
 const target=`http://127.0.0.1:${f.fakeCore.address().port}`;
 const body={action:'verify',url:target,api_key:upstreamKey,expected_revision:0};
 assert.equal((await f.request('POST','/api/admin/upstream',body)).status,401);
 const verified=await f.request('POST','/api/admin/upstream',body,admin);assert.equal(verified.status,200,verified.raw);assert.equal(verified.data.saved,false);assert.equal(f.config.upstreamUrl,null);assert.equal(verified.raw.includes(upstreamKey),false);
 const saved=await f.request('POST','/api/admin/upstream',{...body,action:'save'},admin);assert.equal(saved.status,200,saved.raw);assert.equal(saved.data.revision,1);
 const stored=f.store.db.prepare("SELECT value FROM settings WHERE key='upstream'").get().value;assert.equal(stored.includes(upstreamKey),false);assert.equal((await readFile(join(f.config.dataDir,'upstream.key'))).length,32);
 assert.equal((await f.request('POST','/api/admin/upstream',{...body,action:'save'},admin)).status,409);
 await f.restart();const connection=await f.request('GET','/api/admin/connection',undefined,admin);assert.equal(connection.data.available,true);assert.equal(connection.data.revision,1);assert.equal(connection.raw.includes(upstreamKey),false);
 assert.equal((await f.request('GET','/api/admin/resources',undefined,admin)).status,200);
 assert.equal((await f.request('GET','/upstream.key')).status,404);
});

test('upstream target policy blocks private, metadata, self, redirects and wrong identity without replacing config',async t=>{
 let wrong=false,redirect=false;
 const f=await fixture(t,{withoutCore:true,onCore:({url,res,json})=>{if(url.pathname==='/merchant/v1/me'&&redirect){res.writeHead(302,{Location:'http://169.254.169.254/latest/meta-data/'});res.end();return true;}if(url.pathname==='/merchant/v1/me'&&wrong){json({protocol_version:4,authority_id:'other-authority',merchant:{id:'other-merchant',name:'Wrong',public_origin:f.config.publicOrigin,status:'active'},scopes:[]});return true;}}});
 const admin=await f.request('POST','/api/setup',{...input,setup_token:f.setupToken}),target=`http://127.0.0.1:${f.fakeCore.address().port}`;
 const body={action:'save',url:target,api_key:upstreamKey,expected_revision:0};
 for(const url of ['http://127.0.0.1:1','http://169.254.169.254','https://169.254.169.254','http://[::1]:1',f.config.publicOrigin,'file:///private','http://user:pass@host.test','https://example.test/path']){
  const result=await f.request('POST','/api/admin/upstream',{...body,url},admin);assert.ok([400,429].includes(result.status),result.raw);
 }
 // clear rate limits only within this isolated test database
 f.store.db.prepare('DELETE FROM rate_limits').run();
 redirect=true;const refused=await f.request('POST','/api/admin/upstream',body,admin);assert.equal(refused.status,503);assert.equal(f.config.upstreamUrl,null);redirect=false;
 assert.equal((await f.request('POST','/api/admin/upstream',body,admin)).status,200);
 wrong=true;const mismatch=await f.request('POST','/api/admin/upstream',{...body,expected_revision:1},admin);assert.equal(mismatch.status,409);assert.equal(mismatch.data.error.code,'upstream_identity_mismatch');assert.equal(f.config.upstreamKey,upstreamKey);
});

test('browser/member requests cannot operate child protocol or overwrite environment-managed credentials',async t=>{
 const f=await fixture(t),admin=await f.request('POST','/api/setup',{...input,setup_token:f.setupToken});
 await f.request('POST','/api/admin/users',{email:'member@example.test',display_name:'Member',password,role:'member'},admin);
 const member=await f.request('POST','/api/auth/login',{email:'member@example.test',password});
 assert.equal((await f.request('GET','/api/admin/access-accounts',undefined,member)).status,403);
 assert.equal((await f.request('POST','/api/admin/upstream',{action:'save',url:f.config.upstreamUrl,api_key:upstreamKey,expected_revision:0},admin)).status,409);
 assert.equal((await f.request('GET','/merchant/v1/me',undefined,admin)).status,403);
 assert.equal((await f.request('POST','/merchant/v1/customers',{external_id:'x'}, {headers:{Authorization:'Bearer '+upstreamKey}})).status,403);
 assert.equal((await f.request('GET','/merchant/v1/anything',undefined,{native:true})).status,404);
});

test('revoked administrator cannot save upstream after a delayed verification',async t=>{
 let release,arrived;const entered=new Promise(r=>arrived=r),wait=new Promise(r=>release=r);
 const f=await fixture(t,{withoutCore:true,onCore:async({url})=>{if(url.pathname==='/merchant/v1/me'){arrived();await wait;}}});
 const admin=await f.request('POST','/api/setup',{...input,setup_token:f.setupToken});
 await f.request('POST','/api/admin/users',{email:'second@example.test',display_name:'Second',password,role:'admin'},admin);
 const pending=f.request('POST','/api/admin/upstream',{action:'save',url:`http://127.0.0.1:${f.fakeCore.address().port}`,api_key:upstreamKey,expected_revision:0},admin);
 await entered;f.store.db.prepare("UPDATE users SET role='member' WHERE id=?").run(admin.data.user.id);release();
 const result=await pending;assert.equal(result.status,403);assert.equal(f.config.upstreamUrl,null);assert.equal(f.store.db.prepare("SELECT 1 FROM settings WHERE key='upstream'").get(),undefined);
});


