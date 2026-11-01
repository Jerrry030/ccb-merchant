import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {once} from 'node:events';
import {fixture} from './fixtures.js';

// Opt-in: Go's TestNativeRuntimeLimitChain supplies a live real Core response
// boundary. Only upstream responses and identity storage are synthetic. No real
// credentials, home configuration, model calls or external services are used.
const core=process.env.CCB_NATIVE_TEST_CORE_URL;
const runtime=process.env.CCB_NATIVE_TEST_RUNTIME;
for(const scenario of ['5h','7d','7d_oi','overage','rate','grant','concurrency'])test('native Claude limit display through Core and Merchant: '+scenario,{skip:!core||!runtime,timeout:25000},async t=>{
 let coreAttempts=0;
 const f=await fixture(t,{env:{UPSTREAM_TIMEOUT_MS:'10000'},onCore:async({req,res,url,body})=>{
  if(url.pathname!=='/bridge/v1/messages')return;
  coreAttempts++;
  const response=await fetch(core+'/bridge/v1/messages',{method:'POST',headers:{'Connection':'close','Content-Type':'application/json','Authorization':'Bearer fixture-device','X-CCB-Access-Key':'fixture','X-Test-Limit-Scenario':scenario},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  res.writeHead(response.status,{...Object.fromEntries(response.headers),Connection:'close'});res.end(Buffer.from(await response.arrayBuffer()));return true;
 }});
 const adapter=createServer(async(req,res)=>{
  try{
   if(!req.url.startsWith('/v1/messages')){req.resume();res.writeHead(200,{'Content-Type':'application/json'});res.end('{}');return;}
   const chunks=[];for await(const chunk of req)chunks.push(chunk);
   const response=await fetch(f.config.publicOrigin+'/bridge/v1/messages',{method:'POST',headers:{Connection:'close',Authorization:'Bearer original-device-bearer-fixture','Content-Type':'application/json'},body:Buffer.concat(chunks),signal:AbortSignal.timeout(15000)});
   assert.equal(response.status,429);assert.equal(response.headers.get('x-should-retry'),'false');
   assert.equal(response.headers.get('anthropic-ratelimit-unified-secret'),null);
   res.writeHead(response.status,{...Object.fromEntries(response.headers),Connection:'close'});res.end(Buffer.from(await response.arrayBuffer()));
  }catch(error){res.writeHead(500);res.end(String(error));}
 });
 adapter.listen(0,'127.0.0.1');await once(adapter,'listening');
 t.after(async()=>{adapter.closeAllConnections();await new Promise(resolve=>adapter.close(resolve));});
 const config=join(f.root,'native');await mkdir(config);
 t.diagnostic('isolated native fixture: '+f.root);
 const env={};for(const [key,value]of Object.entries(process.env))if(/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|PATHEXT|PROGRAMFILES|PROGRAMFILES\(X86\)|SYSTEMDRIVE|CLAUDE_CODE_GIT_BASH_PATH)$/i.test(key))env[key]=value;
 Object.assign(env,{HOME:config,USERPROFILE:config,APPDATA:config,LOCALAPPDATA:config,CLAUDE_CONFIG_DIR:config,CLAUDE_CODE_OAUTH_TOKEN:'fixture-local-token-no-real-account',CLAUDE_CODE_OAUTH_SCOPES:'user:inference user:profile',CLAUDE_CODE_SUBSCRIPTION_TYPE:'max',CLAUDE_CODE_RATE_LIMIT_TIER:'default_claude_max_20x',ANTHROPIC_BASE_URL:'http://127.0.0.1:'+adapter.address().port,_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_AUTOUPDATER:'1',HTTP_PROXY:'http://127.0.0.1:9',HTTPS_PROXY:'http://127.0.0.1:9',ALL_PROXY:'http://127.0.0.1:9',NO_PROXY:'127.0.0.1,localhost',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1'});
 const child=spawn(runtime,['-p','Say ok.','--model','claude-sonnet-4-6','--tools','','--setting-sources','','--no-session-persistence'],{env,cwd:config,windowsHide:true,stdio:['ignore','pipe','pipe']});
 let output='',stderr='',timedOut=false;child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>stderr+=data);
 const timer=setTimeout(()=>{timedOut=true;child.kill();},20000);
 const [code]=await once(child,'close');clearTimeout(timer);
 t.diagnostic(JSON.stringify({scenario,code,coreAttempts,output:output.trim(),stderr}));
 assert.equal(timedOut,false);assert.equal(code,1);assert.equal(coreAttempts,1);assert.equal(stderr,'');
 assert.doesNotMatch(output,/PRIVATE|Core rejected/);
 if(['5h','7d','7d_oi','overage'].includes(scenario)){
  assert.doesNotMatch(output,/temporarily limiting requests/);assert.match(output,/limit|credits/i);
  if(scenario==='5h')assert.match(output,/session limit.*resets/);
  if(scenario==='7d')assert.match(output,/weekly limit.*resets/);
 }else{
  assert.match(output,/temporarily limiting requests/);
  if(scenario==='grant')assert.match(output,/CCB authorization usage limit/);
  if(scenario==='concurrency')assert.match(output,/并发/);
 }
});
