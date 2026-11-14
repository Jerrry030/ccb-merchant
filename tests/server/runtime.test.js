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

test('Claude Code native metadata and wire order reach Core through the finite Merchant allowlist',async t=>{
 const routes=['/bridge/v1/messages','/bridge/v1/messages/count_tokens','/bridge/v1/traffic'];
 const f=await fixture(t,{onCore:({url,json})=>{
  if(!routes.includes(url.pathname))return;
  json({type:'message',content:[]});return true;
 }});
 const environment='v=1, yw=jm, hg=wm, yl=qi, ob="2.1.321", sk="wj", wl=ki, tt=(lr), jy="fixture.invalid/repository"';
 for(const route of routes){
  for(const tools of ['[]','[{"name":"mcp__echo__ping","mcp":true},{"name":"ToolSearch"}]']){
   const headers={...native.headers,'User-Agent':'claude-cli/2.1.321 (external, cli)',
    'X-Claude-Code-Sandy-Plover':tools,'X-Claude-Code-Wiggly-Dove':environment,
    'X-Claude-Code-Unknown':'PRIVATE_UNKNOWN','X-Claude-Code-Ide-Authorization':'PRIVATE_IDE',
    'X-Api-Key':'PRIVATE_API_KEY',Cookie:'session=PRIVATE_COOKIE','X-CCB-Relay-Keys':'PRIVATE_CHAIN',
    'X-CCB-Wire-Order':'User-Agent, X-Claude-Code-Sandy-Plover, X-Api-Key, x-claude-code-wiggly-dove, X-Claude-Code-Unknown, Cookie, X-Claude-Code-Ide-Authorization, X-CCB-Relay-Keys, Content-Type',
    ...(route.endsWith('/traffic')?{'X-CCB-Target':'https://api.anthropic.com/v1/messages','X-CCB-Method':'POST'}:{}),
   };
   const body={model:'synthetic',messages:[],stream:false};
   const result=await f.request('POST',route,body,{native:true,headers});
   assert.equal(result.status,200,result.raw);
   const sent=f.state.requests.at(-1);
   assert.equal(sent.path,route);assert.deepEqual(sent.body,body);
   assert.equal(sent.headers['user-agent'],headers['User-Agent']);
   assert.equal(sent.headers['x-claude-code-sandy-plover'],tools);
   assert.equal(sent.headers['x-claude-code-wiggly-dove'],environment);
   assert.equal(sent.headers['x-ccb-wire-order'],'User-Agent,X-Claude-Code-Sandy-Plover,x-claude-code-wiggly-dove,Content-Type');
   assert.equal(sent.headers.authorization,bearer);assert.equal(sent.headers['x-ccb-access-key'],upstreamKey);
   for(const name of ['x-claude-code-unknown','x-claude-code-ide-authorization','x-api-key','cookie','x-ccb-relay-keys'])assert.equal(sent.headers[name],undefined,name);
  }
  assert.equal(f.state.requests.filter(row=>row.path===route).length,2,'one upstream attempt per call');
 }
 const result=await f.request('POST','/bridge/v1/messages',{}, {native:true,headers:{...native.headers,'X-CCB-Wire-Order':'X-Claude-Code-Sandy-Plover,X-Claude-Code-Wiggly-Dove,Content-Type'}});
 assert.equal(result.status,200);
 const sent=f.state.requests.at(-1).headers;
 assert.equal(sent['x-claude-code-sandy-plover'],undefined);assert.equal(sent['x-claude-code-wiggly-dove'],undefined);
 assert.equal(sent['x-ccb-wire-order'],'Content-Type','absent optional metadata is neither manufactured nor advertised');
});

for(const version of ['2.1.321','2.2.7'])test('Claude Code version mismatch keeps the required version and upgrade guidance: '+version,async t=>{
 const message='This gateway serves Claude Code '+version+'; update ccb (with ACCB, update ACCB), then quit Claude Code and start it again';
 const f=await fixture(t,{onCore:({url,res,json})=>{
  if(!['/bridge/v1/messages','/bridge/v1/messages/count_tokens','/bridge/v1/traffic'].includes(url.pathname))return;
  res.setHeader('X-Should-Retry','false');res.setHeader('X-Core-Secret','PRIVATE_PROVIDER');
  json({type:'error',error:{type:'claude_code_version_mismatch',code:'claude_code_version_mismatch',message,details:{account:'PRIVATE_ACCOUNT'}},request_id:'PRIVATE_REQUEST'},409);return true;
 }});
 for(const route of ['/bridge/v1/messages','/bridge/v1/messages/count_tokens','/bridge/v1/traffic']){
  const headers={...native.headers,...(route.endsWith('/traffic')?{'X-CCB-Target':'https://api.anthropic.com/api/oauth/profile','X-CCB-Method':'GET'}:{})};
  const result=await f.request('POST',route,{}, {native:true,headers});
  assert.equal(result.status,409);
  assert.deepEqual(result.data,{type:'error',error:{type:'claude_code_version_mismatch',code:'claude_code_version_mismatch',message}});
  assert.equal(result.headers.get('x-should-retry'),'false');assert.equal(result.headers.get('x-core-secret'),null);
  assert.equal(result.raw.includes('PRIVATE'),false);
  assert.equal(f.state.requests.filter(row=>row.path===route).length,1);
 }
});

test('version mismatch rebuilds safe guidance for malformed diagnostics and never asks the client to retry',async t=>{
 let message,retry;
 const f=await fixture(t,{onCore:({url,res,json})=>{
  if(url.pathname!=='/bridge/v1/messages')return;
  if(retry!==undefined)res.setHeader('X-Should-Retry',retry);
  json({error:{code:'claude_code_version_mismatch',message,details:{token:'PRIVATE_TOKEN'}}},409);return true;
 }});
 const guidance='update ccb (with ACCB, update ACCB), then quit Claude Code and start it again';
 const messages=[undefined,null,17,{private:'PRIVATE_DIAGNOSTIC'},'PRIVATE_DIAGNOSTIC',
  'This gateway serves Claude Code 2.1.321; '+guidance+' PRIVATE_DIAGNOSTIC',
  'This gateway serves Claude Code 2.1.321; '+guidance+'\nPRIVATE_DIAGNOSTIC',
  'This gateway serves Claude Code 2.1.321-private; '+guidance,
  'This gateway serves Claude Code 9999999.1.321; '+guidance,
  'This gateway serves Claude Code 02.1.321; '+guidance,
 ];
 let attempts=0;
 for(message of messages){
  retry=[undefined,'true','PRIVATE_RETRY'][attempts%3];
  const result=await f.request('POST','/bridge/v1/messages',{},native);
  assert.equal(result.status,409);
  assert.deepEqual(result.data,{type:'error',error:{type:'claude_code_version_mismatch',code:'claude_code_version_mismatch',message:'The Claude Code version does not match this gateway; '+guidance}});
  assert.equal(result.headers.get('x-should-retry'),'false');assert.equal(result.raw.includes('PRIVATE'),false);
  assert.equal(f.state.requests.filter(row=>row.path==='/bridge/v1/messages').length,++attempts);
 }
});

test('version mismatch code is only admitted with its contracted HTTP 409 status',async t=>{
 let status;
 const f=await fixture(t,{onCore:({url,json})=>{
  if(url.pathname!=='/bridge/v1/messages')return;
  json({error:{code:'claude_code_version_mismatch',message:'PRIVATE_DIAGNOSTIC'}},status);return true;
 }});
 let attempts=0;
 for(status of [400,401,403,404,429,500]){
  const result=await f.request('POST','/bridge/v1/messages',{},native);
  assert.equal(result.status,status===500?503:status);
  assert.equal(result.data.error.code,'runtime_rejected');assert.equal(result.raw.includes('PRIVATE'),false);
  assert.equal(result.headers.get('x-should-retry'),null);
  assert.equal(f.state.requests.filter(row=>row.path==='/bridge/v1/messages').length,++attempts);
 }
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

test('body and control runtime timeout are bounded; errors are sanitized, writes never replay',async t=>{
  const f=await fixture(t,{env:{RUNTIME_BODY_LIMIT:'4096',UPSTREAM_TIMEOUT_MS:'100'},onCore:async({url,res,json})=>{
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


test('thinking-only SSE stays alive beyond the header deadline and completes without replay',async t=>{
  const frames=['event: message_start\ndata: {"type":"message_start"}\n\n',
    ...Array.from({length:8},()=> 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"","estimated_tokens":100}}\n\n'),
    'event: message_stop\ndata: {"type":"message_stop"}\n\n'];
  const f=await fixture(t,{env:{RUNTIME_HEADER_TIMEOUT_MS:'200'},onCore:async({url,res})=>{
    if(url.pathname!=='/bridge/v1/messages') return;
    res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(frames[0]);
    let index=1;
    const timer=setInterval(()=>{res.write(frames[index++]);if(index===frames.length){clearInterval(timer);res.end();}},60);
    res.once('close',()=>clearInterval(timer));return true;
  }});
  const response=await fetch(`${f.config.publicOrigin}/bridge/v1/messages`,{
    method:'POST',headers:{Authorization:bearer,'Content-Type':'application/json'},
    body:JSON.stringify({stream:true}),signal:AbortSignal.timeout(5000),
  });
  assert.equal(response.status,200);
  assert.equal(await response.text(),frames.join(''));
  assert.equal(f.state.requests.filter(r=>r.path==='/bridge/v1/messages').length,1);
});

test('a non-streaming response body may outlive the header deadline',async t=>{
  const payload=JSON.stringify({type:'message',content:[{type:'text',text:'complete'}],usage:{output_tokens:1}});
  const f=await fixture(t,{env:{RUNTIME_HEADER_TIMEOUT_MS:'200'},onCore:async({url,res})=>{
    if(url.pathname!=='/bridge/v1/messages') return;
    res.writeHead(200,{'Content-Type':'application/json'});res.flushHeaders();
    const timer=setTimeout(()=>res.end(payload),500);
    res.once('close',()=>clearTimeout(timer));return true;
  }});
  const response=await fetch(`${f.config.publicOrigin}/bridge/v1/messages`,{
    method:'POST',headers:{Authorization:bearer,'Content-Type':'application/json'},
    body:JSON.stringify({stream:false}),signal:AbortSignal.timeout(5000),
  });
  assert.equal(response.status,200);assert.equal(await response.text(),payload);
  assert.equal(f.state.requests.filter(r=>r.path==='/bridge/v1/messages').length,1);
});

test('missing model response headers time out, cancel upstream and never replay',async t=>{
  const f=await fixture(t,{env:{RUNTIME_HEADER_TIMEOUT_MS:'100'},onCore:async({url,res,state})=>{
    if(url.pathname!=='/bridge/v1/messages') return;
    res.once('close',()=>{state.runtimeCancelled++;});return true;
  }});
  const result=await f.request('POST','/bridge/v1/messages',{stream:false},native);
  assert.equal(result.status,503);assert.equal(result.data.error.code,'runtime_header_timeout');
  for(let i=0;i<30&&f.state.runtimeCancelled===0;i++) await delay(20);
  assert.equal(f.state.runtimeCancelled,1);
  assert.equal(f.state.requests.filter(r=>r.path==='/bridge/v1/messages').length,1);
});

test('control response bodies remain bounded after receiving headers',async t=>{
  const f=await fixture(t,{env:{UPSTREAM_TIMEOUT_MS:'100'},onCore:async({url,res,state})=>{
    if(url.pathname!=='/bridge/v1/device/status') return;
    res.writeHead(200,{'Content-Type':'application/json'});res.write('{');
    res.once('close',()=>{state.runtimeCancelled++;});return true;
  }});
  const result=await f.request('GET','/bridge/v1/device/status',undefined,native);
  assert.equal(result.status,503);assert.equal(result.data.error.code,'runtime_timeout');
  for(let i=0;i<30&&f.state.runtimeCancelled===0;i++) await delay(20);
  assert.equal(f.state.runtimeCancelled,1);
});

test('disconnect before upstream headers cancels the pending request', {timeout:5000},async t=>{
  const entered=Promise.withResolvers(),closed=Promise.withResolvers();
  const f=await fixture(t,{onCore:async({url,res})=>{
    if(url.pathname!=='/bridge/v1/messages') return;
    res.once('close',closed.resolve);entered.resolve();return true;
  }});
  const controller=new AbortController();t.after(()=>controller.abort());
  const result=fetch(`${f.config.publicOrigin}/bridge/v1/messages`,{
    method:'POST',headers:{Authorization:bearer,'Content-Type':'application/json'},
    body:JSON.stringify({stream:false}),signal:controller.signal,
  }).catch(error=>error);
  await entered.promise;controller.abort();
  assert.equal((await result).name,'AbortError');await closed.promise;
  assert.equal(f.state.requests.filter(r=>r.path==='/bridge/v1/messages').length,1);
});

test('an interrupted upstream stream stays incomplete and is never replayed',async t=>{
  const f=await fixture(t,{onCore:async({url,res})=>{
    if(url.pathname!=='/bridge/v1/messages') return;
    res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
    const timer=setTimeout(()=>res.destroy(),50);res.once('close',()=>clearTimeout(timer));return true;
  }});
  const response=await fetch(`${f.config.publicOrigin}/bridge/v1/messages`,{
    method:'POST',headers:{Authorization:bearer,'Content-Type':'application/json'},
    body:JSON.stringify({stream:true}),signal:AbortSignal.timeout(5000),
  });
  assert.equal(response.status,200);await assert.rejects(response.text());
  assert.equal(f.state.requests.filter(r=>r.path==='/bridge/v1/messages').length,1);
  assert.equal((await f.request('GET','/bridge/v1/device/status',undefined,native)).status,200);
});

for(const code of ['rate_limit_error','grant_usage_limit_exceeded','rate_limited','concurrency_limited']) test('runtime keeps native limit classification without diagnostics: '+code,async t=>{
 const f=await fixture(t,{onCore:async({url,res,json})=>{
  if(!['/bridge/v1/messages','/bridge/v1/messages/count_tokens','/bridge/v1/traffic'].includes(url.pathname))return;
  res.setHeader('Retry-After','60');res.setHeader('X-Should-Retry','false');
  if(code==='rate_limit_error'){
   res.setHeader('Anthropic-Ratelimit-Unified-Status','rejected');res.setHeader('Anthropic-Ratelimit-Unified-Reset','1793548800');res.setHeader('Anthropic-Ratelimit-Unified-Representative-Claim','five_hour');
  }
  res.setHeader('Anthropic-Ratelimit-Unified-Secret','PRIVATE_ACCOUNT');
  json({type:'error',error:{type:'rate_limit_error',code,message:'PRIVATE_ACCOUNT_TOKEN',details:{account:'PRIVATE_ID'}}},429);return true;
 }});
 for(const route of ['/bridge/v1/messages','/bridge/v1/messages/count_tokens','/bridge/v1/traffic']){
  const actor=route.endsWith('/traffic')?{native:true,headers:{...native.headers,'X-CCB-Target':'https://api.anthropic.com/v1/messages','X-CCB-Method':'POST'}}:native;
  const result=await f.request('POST',route,{stream:true},actor);
  assert.equal(result.status,429);assert.equal(result.data.type,'error');
  assert.equal(result.data.error.code,code);assert.equal(result.data.error.type,code==='grant_usage_limit_exceeded'?'rate_limit_error':code);
  assert.equal(result.headers.get('retry-after'),'60');assert.equal(result.headers.get('x-should-retry'),'false');
  assert.equal(result.headers.get('anthropic-ratelimit-unified-status'),code==='rate_limit_error'?'rejected':null);
  assert.equal(result.headers.get('anthropic-ratelimit-unified-secret'),null);assert.equal(result.raw.includes('PRIVATE'),false);
  if(code==='grant_usage_limit_exceeded')assert.match(result.data.error.message,/CCB/);
  assert.equal(f.state.requests.filter(row=>row.path===route).length,1);
 }
});

test('runtime preserves validated quota feedback on success, not arbitrary prefix metadata',async t=>{
 const f=await fixture(t,{onCore:async({url,res,json})=>{
  if(url.pathname!=='/bridge/v1/messages')return;
  const headers={
   'Anthropic-Ratelimit-Unified-Status':'allowed_warning','Anthropic-Ratelimit-Unified-Representative-Claim':'seven_day',
   'Anthropic-Ratelimit-Unified-Reset':'1793548800','Anthropic-Ratelimit-Unified-5h-Utilization':'0.7','Anthropic-Ratelimit-Unified-7d-Utilization':'0.9',
   'Anthropic-Ratelimit-Unified-7d_oi-Reset':'1793548800','Anthropic-Ratelimit-Unified-Overage-Status':'allowed','Anthropic-Ratelimit-Unified-Overage-Reset':'1793548800',
   'Anthropic-Ratelimit-Unified-Overage-Period-Monthly-Utilization':'0.4','Anthropic-Ratelimit-Unified-5h-Surpassed-Threshold':'0.7',
   'Anthropic-Ratelimit-Unified-Secret':'PRIVATE','Anthropic-Ratelimit-Unified-7d_oi-Utilization':'Infinity','Anthropic-Ratelimit-Unified-7d-Reset':'PRIVATE','X-Should-Retry':'PRIVATE',
  };
  for(const [key,value]of Object.entries(headers))res.setHeader(key,value);
  json({type:'message',content:[]});return true;
 }});
 const r=await f.request('POST','/bridge/v1/messages',{},native);
 assert.equal(r.status,200);assert.equal(r.data.type,'message');
 for(const [suffix,value]of Object.entries({'status':'allowed_warning','representative-claim':'seven_day','reset':'1793548800','5h-utilization':'0.7','7d-utilization':'0.9','7d_oi-reset':'1793548800','overage-status':'allowed','overage-reset':'1793548800','overage-period-monthly-utilization':'0.4','5h-surpassed-threshold':'0.7'}))assert.equal(r.headers.get('anthropic-ratelimit-unified-'+suffix),value,suffix);
 for(const name of ['anthropic-ratelimit-unified-secret','anthropic-ratelimit-unified-7d_oi-utilization','anthropic-ratelimit-unified-7d-reset','x-should-retry'])assert.equal(r.headers.get(name),null,name);
});

for(const shape of ['fragmented','invalid','oversized','stalled','wrong-status'])test('runtime error body is bounded and classified safely: '+shape,async t=>{
 const f=await fixture(t,{env:{UPSTREAM_TIMEOUT_MS:'100'},onCore:async({url,res})=>{
  if(url.pathname!=='/bridge/v1/messages')return;
  res.writeHead(shape==='wrong-status'?503:429,{'Content-Type':'application/json','Retry-After':'60','X-Should-Retry':'false'});
  if(shape==='fragmented'){
   res.write('{"error":{"type":"rate_');const timer=setTimeout(()=>res.end('limit_error","message":"PRIVATE"}}'),10);res.once('close',()=>clearTimeout(timer));
  }else if(shape==='invalid')res.end('{"error":');
  else if(shape==='oversized')res.end(JSON.stringify({error:{type:'rate_limit_error',message:'x'.repeat(65536)}}));
  else if(shape==='wrong-status')res.end('{"error":{"type":"rate_limit_error","message":"PRIVATE"}}');
  else{res.write('{"error":');res.once('close',()=>{f.state.runtimeCancelled++;});}
  return true;
 }});
 const start=Date.now(),r=await f.request('POST','/bridge/v1/messages',{},native);
 assert.equal(r.status,shape==='wrong-status'?503:429);assert.equal(r.data.type,'error');
 assert.equal(r.data.error.type,shape==='fragmented'?'rate_limit_error':'gateway_error');assert.equal(r.raw.includes('PRIVATE'),false);
 assert.equal(r.headers.get('retry-after'),'60');assert.equal(r.headers.get('x-should-retry'),'false');
 assert.equal(f.state.requests.filter(row=>row.path==='/bridge/v1/messages').length,1);
 if(shape==='stalled'){assert.ok(Date.now()-start<2000);for(let i=0;i<30&&f.state.runtimeCancelled===0;i++)await delay(20);assert.equal(f.state.runtimeCancelled,1);}
});

test('runtime account list, refresh and selection use the same stable private-safe account numbers',async t=>{
 let selected='grant-a',reversed=false;
 const rows=[{id:'grant-a',account_lease_id:'owned-1',name:'',plan:'Claude Pro',state:'limited',quota:{status:'known',windows:[{key:'five_hour',label:'5 小时',used_percent:101}]}},{id:'grant-b',account_lease_id:'owned-2',name:'PRIVATE_PROVIDER_EMAIL',plan:'Claude Pro',state:'limited',quota:{status:'known',windows:[{key:'five_hour',label:'5 小时',used_percent:100}]}}];
 const f=await fixture(t,{onCore:({url,body,json})=>{
  if(url.pathname==='/bridge/v1/accounts'){json({accounts:reversed?[...rows].reverse():rows,current_grant_id:selected,selection_version:1});return true;}
  if(url.pathname==='/bridge/v1/accounts/grant-a/refresh'){json({account:rows[0]});return true;}
  if(url.pathname==='/bridge/v1/device/account'){selected=body.grant_id;json({device:{id:'device-1',state:'approved',current_grant_id:selected,account_name:'PRIVATE_PROVIDER_EMAIL',selection_version:2}});return true;}
  if(url.pathname==='/bridge/v1/device/status'){json({id:'device-1',state:'approved',current_grant_id:selected,account_name:'',selection_version:1});return true;}
 }});
 const listed=await f.request('GET','/bridge/v1/accounts?surface=code',undefined,native);
 assert.equal(listed.status,200);assert.deepEqual(listed.data.accounts.map(a=>a.name),['账号#1','账号#2']);
 assert.deepEqual(listed.data.accounts.map(a=>a.state),['limited','limited']);assert.deepEqual(listed.data.accounts.map(a=>a.quota.windows[0].used_percent),[101,100]);
 assert.equal(listed.data.current_grant_id,'grant-a');assert.equal(listed.data.account_name,'账号#1');
 for(const text of ['PRIVATE','owned-1','owned-2','account_lease_id'])assert.equal(listed.raw.includes(text),false,text);
 const refreshed=await f.request('POST','/bridge/v1/accounts/grant-a/refresh',{},native);assert.equal(refreshed.data.account.name,'账号#1');assert.equal(refreshed.raw.includes('owned-1'),false);
 const chosen=await f.request('POST','/bridge/v1/device/account',{grant_id:'grant-b',expected_selection_version:0},native);assert.equal(chosen.data.device.account_name,'账号#2');assert.equal(chosen.raw.includes('PRIVATE'),false);
 const status=await f.request('GET','/bridge/v1/device/status',undefined,native);assert.equal(status.data.account_name,'账号#2');
 reversed=true;await f.restart();
 const again=await f.request('GET','/bridge/v1/accounts',undefined,native);assert.deepEqual(again.data.accounts.map(a=>a.name),['账号#2','账号#1']);assert.equal(again.data.account_name,'账号#2');
 assert.equal(f.store.labelAccounts([{id:'grant-a'}])[0].name,'账号#1');assert.equal(f.store.labelAccounts([{id:'grant-b'}])[0].name,'账号#2');
 assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM account_codes').get().n,2);
});

test('runtime names use recorded grant mappings and never infer a provider name for unmapped accounts',async t=>{
 const f=await fixture(t,{onCore:({url,json})=>{if(url.pathname!=='/bridge/v1/accounts')return;json({accounts:[{id:'known',name:''},{id:'unknown',name:'PRIVATE_EMAIL'}]});return true;}});
 f.store.labelAccounts([{id:'known',account_lease_id:'owned-1'}]);
 const result=await f.request('GET','/bridge/v1/accounts',undefined,native);
 assert.deepEqual(result.data.accounts.map(a=>a.name),['账号#1','账号（编号待核对）']);assert.equal(result.raw.includes('PRIVATE'),false);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM account_codes').get().n,1);
});

test('runtime allocation identity conflicts cannot silently rename or remap an existing account number',async t=>{
 const f=await fixture(t,{onCore:({url,json})=>{if(url.pathname!=='/bridge/v1/accounts')return;json({accounts:[{id:'known',account_lease_id:'changed-lease',name:'PRIVATE_PROVIDER'}]});return true;}});
 f.store.labelAccounts([{id:'known',account_lease_id:'owned-1'}]);
 const result=await f.request('GET','/bridge/v1/accounts',undefined,native);
 assert.equal(result.status,503);assert.equal(result.data.error.code,'invalid_core_response');assert.equal(result.raw.includes('PRIVATE'),false);
 assert.equal(f.store.labelAccounts([{id:'known'}])[0].name,'账号#1');
 assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM account_codes').get().n,1);
});

test('native client receives only real conditional-selection capability and cannot omit the revision',async t=>{
 let capability=true;
 const f=await fixture(t,{onCore:({url,body,json})=>{
  if(url.pathname==='/bridge/v1/accounts'){json({accounts:[{id:'new-unbound',state:'available',quota:{status:'unknown',windows:[]}}],current_grant_id:null,selection_version:0,...(capability===undefined?{}:{conditional_selection:capability})});return true;}
  if(url.pathname==='/bridge/v1/device/account'){assert.equal(body.expected_selection_version,0);json({device:{current_grant_id:body.grant_id,selection_version:1}});return true;}
 }});
 const list=await f.request('GET','/bridge/v1/accounts',undefined,native);assert.equal(list.data.conditional_selection,true);assert.equal(list.data.accounts[0].id,'new-unbound');assert.equal(list.data.accounts[0].quota.status,'unknown');
 for(const value of [false,undefined,'true']){capability=value;const r=await f.request('GET','/bridge/v1/accounts',undefined,native);assert.notEqual(r.data.conditional_selection,true);}
 const before=f.state.requests.length;
 for(const body of [{grant_id:'new-unbound'}, {grant_id:'new-unbound',expected_selection_version:null}, {grant_id:'new-unbound',expected_selection_version:-1}]){assert.equal((await f.request('POST','/bridge/v1/device/account',body,native)).status,400);}
 assert.equal(f.state.requests.length,before);
 assert.equal((await f.request('POST','/bridge/v1/device/account',{grant_id:'new-unbound',expected_selection_version:0},native)).status,200);
});
for(const status of [409,503])test('conditional selection failures keep authoritative status '+status,async t=>{
 const f=await fixture(t,{onCore:({url,json})=>{if(url.pathname==='/bridge/v1/device/account'){json({code:'device_stale',error:'PRIVATE_PROVIDER_REASON'},status);return true;}}});
 const r=await f.request('POST','/bridge/v1/device/account',{grant_id:'candidate',expected_selection_version:1},native);
 assert.equal(r.status,status);assert.equal(r.data.error.code,status===409?'device_stale':'runtime_rejected');assert.equal(r.raw.includes('PRIVATE'),false);
 assert.equal(f.state.requests.filter(row=>row.path==='/bridge/v1/device/account').length,1);
});
