import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture } from '../server/fixtures.js';

test('Caddy preserves long SSE and propagates cancellation before and after upstream headers', {timeout:15000}, async t=>{
  const waiting=Promise.withResolvers(),waitingClosed=Promise.withResolvers(),streamClosed=Promise.withResolvers();
  const f=await fixture(t,{env:{RUNTIME_HEADER_TIMEOUT_MS:'200'},onCore:async({url,res,body})=>{
    if(url.pathname!=='/bridge/v1/messages') return;
    if(body.mode==='waiting') {res.once('close',waitingClosed.resolve);waiting.resolve();return true;}
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
    let ticks=0;
    const timer=setInterval(()=>{
      res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"","estimated_tokens":100}}\n\n');
      if(body.mode==='complete' && ++ticks===8) {clearInterval(timer);res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');}
    },60);
    res.once('close',()=>{clearInterval(timer);if(body.mode==='cancel')streamClosed.resolve();});return true;
  }});
  const portReservation=createServer();portReservation.listen(0,'127.0.0.1');await once(portReservation,'listening');
  const proxyPort=portReservation.address().port;
  await new Promise(resolve=>portReservation.close(resolve));
  const backend=new URL(f.config.publicOrigin).host,origin=`http://127.0.0.1:${proxyPort}`;
  f.config.publicOrigin=origin;f.config.publicHost=new URL(origin).host;
  const root=await mkdtemp(join(tmpdir(),'ccb-merchant-caddy-test-'));
  let child,stopped,log='',spawnError;
  t.after(async()=>{
    if(child && child.exitCode===null && child.signalCode===null)child.kill();
    if(stopped)await stopped;
    const actual=await realpath(root),inside=relative(await realpath(tmpdir()),actual);
    if(inside.startsWith('..')||isAbsolute(inside)||!basename(actual).startsWith('ccb-merchant-caddy-test-'))throw new Error('Refusing cleanup outside isolated proxy test root');
    await rm(actual,{recursive:true,force:true});
  });
  const template=await readFile(new URL('../../Caddyfile.example',import.meta.url),'utf8');
  const config=`{\n admin off\n auto_https off\n}\n`+template.replace('merchant.example.com {',`${origin} {`).replace('127.0.0.1:8787',backend);
  const configPath=join(root,'Caddyfile');await writeFile(configPath,config);
  child=spawn(process.env.CADDY_BIN||'caddy',['run','--config',configPath,'--adapter','caddyfile'],{
    windowsHide:true,env:{...process.env,APPDATA:join(root,'appdata'),XDG_DATA_HOME:join(root,'data'),XDG_CONFIG_HOME:join(root,'config')},stdio:['ignore','pipe','pipe'],
  });
  stopped=new Promise(resolve=>{child.once('error',error=>{spawnError=error;resolve();});child.once('exit',resolve);});
  for(const pipe of [child.stdout,child.stderr])pipe.on('data',chunk=>{log=(log+chunk).slice(-8192);});
  let ready=false;
  for(let i=0;i<50;i++){
    if(spawnError||child.exitCode!==null)break;
    try {const response=await fetch(origin+'/api/public',{signal:AbortSignal.timeout(200)});await response.arrayBuffer();if(response.ok){ready=true;break;}}catch{}
    await delay(50);
  }
  assert.ok(ready,`Caddy must be installed (or set CADDY_BIN): ${spawnError?.message||log}`);
  const headers={Authorization:'Bearer original-device-bearer-fixture','Content-Type':'application/json','Accept-Encoding':'identity'};
  const complete=await fetch(origin+'/bridge/v1/messages',{method:'POST',headers,body:JSON.stringify({mode:'complete',stream:true}),signal:AbortSignal.timeout(5000)});
  assert.equal(complete.status,200);const text=await complete.text();assert.match(text,/message_stop/);
  assert.equal((text.match(/estimated_tokens/g)||[]).length,8);
  const streamController=new AbortController();t.after(()=>streamController.abort());
  const stream=await fetch(origin+'/bridge/v1/messages',{method:'POST',headers,body:JSON.stringify({mode:'cancel',stream:true}),signal:streamController.signal});
  const reader=stream.body.getReader();assert.match(new TextDecoder().decode((await reader.read()).value),/message_start/);
  streamController.abort();await reader.cancel().catch(()=>{});
  assert.equal(await Promise.race([streamClosed.promise.then(()=>true),delay(1000).then(()=>false)]),true,'downstream SSE abort must cancel the provider, not leave it running');
  f.config.runtimeHeaderTimeoutMs=5000;
  const waitingController=new AbortController();t.after(()=>waitingController.abort());
  const result=fetch(origin+'/bridge/v1/messages',{method:'POST',headers,body:JSON.stringify({mode:'waiting',stream:false}),signal:waitingController.signal}).catch(error=>error);
  await waiting.promise;waitingController.abort();assert.equal((await result).name,'AbortError');
  assert.equal(await Promise.race([waitingClosed.promise.then(()=>true),delay(1000).then(()=>false)]),true,'downstream abort before response headers must cancel the provider');
  assert.equal(f.state.requests.filter(r=>r.path==='/bridge/v1/messages').length,3,'never replay a model request');
});
