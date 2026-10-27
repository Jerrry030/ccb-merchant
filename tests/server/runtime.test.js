import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, upstreamKey } from './fixtures.js';

const bearer='Bearer original-device-bearer-fixture';
const native={native:true,headers:{Authorization:bearer}};

test('Code runtime exact route/method allowlist rejects Desktop, arbitrary URLs and browser requests',async t=>{
  const f=await fixture(t);
  for(const [method,path,body] of [
    ['POST','/bridge/v1/desktop/bindings',{}],['POST','/bridge/v1/desktop/traffic',{}],
    ['GET','/bridge/v1/admin/api/users'],['POST','/bridge/v1/messages/extra',{}],
    ['GET','/bridge/v1/bindings'],['POST','/bridge/v1/traffic',{url:'http://internal'}],
    ['GET','/bridge/v1/accounts?surface=desktop'],['POST','/bridge/v1/device/account?surface=desktop',{grant_id:'g'}],
    ['GET','/bridge/v1/device/status?target=http://evil'],['POST','/bridge/v1/messages?url=http://evil',{}],
  ]) {
    const before=f.state.requests.length, result=await f.request(method,path,body,native);
    assert.ok(result.status===400||result.status===404,`${method} ${path} got ${result.status}`);assert.equal(f.state.requests.length,before);
  }
  assert.equal((await f.request('POST','/bridge/v1/messages',{}, {headers:{Authorization:bearer}})).status,403);
  assert.equal((await f.request('GET','/bridge/v1/device/status')).status,401);
  assert.equal((await f.request('POST','/bridge/v1/device/start',{}, {native:true,headers:{Origin:''}})).status,403,'even an empty Origin header is rejected');
  assert.equal((await f.request('POST','/bridge/v1/device/start',{name:'Laptop',platform:'windows',token_hash:'a'.repeat(64)},{native:true})).status,201);
  assert.equal((await f.request('POST','/bridge/v1/traffic',{}, {native:true,headers:{...native.headers,'X-CCB-Target':'http://169.254.169.254/latest/meta-data','X-CCB-Method':'GET'}})).status,400);
});

test('runtime injects only service merchant key, preserves device bearer and protocol headers, strips cookies and secrets',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('POST','/bridge/v1/bindings',{}, {native:true,headers:{...native.headers,'X-CCB-Access-Key':'attacker'}})).status,401);
  const response=await f.request('POST','/bridge/v1/bindings',{}, {native:true,headers:{
    ...native.headers,Cookie:'session=SECRET',
    'X-Api-Key':'UPSTREAM_SECRET','X-Forwarded-For':'evil','X-Custom-Secret':'SECRET','X-CSRF-Token':'SECRET',
    'X-Stainless-Os':'windows','X-Stainless-Arch':'x64','X-CCB-Binding':'binding-test',
    'X-CCB-Wire-Order':'Cookie,Authorization,X-Stainless-Os,X-Custom-Secret,Content-Type',
  }});
  assert.equal(response.status,200);const sent=f.state.requests.at(-1).headers;
  assert.equal(sent.authorization,bearer);assert.equal(sent['x-ccb-access-key'],upstreamKey);
  assert.equal(sent['x-stainless-os'],'windows');assert.equal(sent['x-ccb-binding'],'binding-test');
  for(const header of ['cookie','x-api-key','x-forwarded-for','x-custom-secret','x-csrf-token','origin']) assert.equal(sent[header],undefined,header);
  assert.equal(sent['x-ccb-wire-order'],'Authorization,X-Stainless-Os,Content-Type');
  assert.equal(response.raw.includes('PRIVATE_CORE_USER'),false);assert.equal(response.raw.includes('LEAK'),false);assert.equal(response.raw.includes(upstreamKey),false);
  assert.match(response.data.owner_user_id,/^merchant_[a-f0-9]{64}$/);
  const status=await f.request('GET','/bridge/v1/device/status',undefined,native);
  assert.equal(status.data.owner_user_id,response.data.owner_user_id);
  await f.restart();
  assert.equal((await f.request('GET','/bridge/v1/device/status',undefined,native)).data.owner_user_id,response.data.owner_user_id);
  const accounts=await f.request('GET','/bridge/v1/accounts?surface=code',undefined,native);
  assert.equal(accounts.data.accounts[0].state,'available');assert.equal(accounts.data.accounts[0].quota.windows[0].used_percent,20);assert.equal(accounts.raw.includes('LEAK'),false);
});

test('SSE is streamed before completion, unwanted upstream headers are stripped and disconnect cancels upstream',async t=>{
  let emitted=false;
  const f=await fixture(t,{onCore:async({url,res,state})=>{
    if(url.pathname==='/bridge/v1/messages') {
      res.writeHead(200,{'Content-Type':'text/event-stream','Set-Cookie':'upstream=SECRET','X-Core-Secret':'SECRET'});
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');emitted=true;
      const timer=setInterval(()=>res.write('event: ping\ndata: {}\n\n'),30);
      res.once('close',()=>{clearInterval(timer);state.runtimeCancelled++;});return true;
    }
  }});
  const controller=new AbortController();
  const response=await fetch(`${f.config.publicOrigin}/bridge/v1/messages`,{method:'POST',headers:{Authorization:bearer,'Content-Type':'application/json'},body:JSON.stringify({stream:true}),signal:controller.signal});
  assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'text/event-stream');assert.equal(response.headers.get('set-cookie'),null);assert.equal(response.headers.get('x-core-secret'),null);
  const reader=response.body.getReader();const first=await reader.read();assert.equal(emitted,true);assert.match(new TextDecoder().decode(first.value),/message_start/);
  controller.abort();await reader.cancel().catch(()=>{});
  for(let i=0;i<30&&f.state.runtimeCancelled===0;i++) await delay(20);
  assert.equal(f.state.runtimeCancelled,1);assert.equal(f.state.requests.filter(r=>r.path==='/bridge/v1/messages').length,1);
});

test('body and overall runtime timeout are bounded; errors are sanitized, writes never replay',async t=>{
  const f=await fixture(t,{env:{RUNTIME_BODY_LIMIT:'4096',RUNTIME_TIMEOUT_MS:'100'},onCore:async({url,res,json})=>{
    if(url.pathname==='/bridge/v1/device/status') {
      const timer=setTimeout(()=>json({id:'late'}),1000);res.once('close',()=>clearTimeout(timer));return true;
    }
    if(url.pathname==='/bridge/v1/messages') {json({error:{message:'LEAK UPSTREAM_TOKEN'}},401);return true;}
  }});
  const large=await f.request('POST','/bridge/v1/messages',{message:'a'.repeat(5000)},native);
  assert.equal(large.status,413);assert.equal(f.state.requests.length,0);
  const timeout=await f.request('GET','/bridge/v1/device/status',undefined,native);
  assert.equal(timeout.status,503);assert.equal(timeout.data.error.code,'runtime_timeout');
  const rejected=await f.request('POST','/bridge/v1/messages',{message:'small'},native);
  assert.equal(rejected.status,401);assert.equal(rejected.raw.includes('LEAK'),false);
  assert.equal(f.state.requests.filter(r=>r.path==='/bridge/v1/messages').length,1);
  assert.equal((await f.request('POST','/bridge/v1/messages',{}, {native:true,headers:{...native.headers,'Content-Encoding':'gzip'}})).status,415);
});

