import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {fixture} from './fixtures.js';
const headers={Authorization:'Bearer original-device-bearer-fixture'};
const native={native:true,headers};
const body=Buffer.from('PK\x03\x04fixture-desktop-bytes');
const release={version:'0.1.0-bridge.1',os:'windows',arch:'amd64',size:body.length,sha256:createHash('sha256').update(body).digest('hex')};
const query='os=windows&arch=amd64';

test('Code package metadata is validated and projected without provider secrets',async t=>{
 const f=await fixture(t,{onCore:({url,json})=>{if(url.pathname!=='/bridge/v1/code')return false;json({...release,token:'PRIVATE',path:'/private/releases',gateway:'https://private.invalid'});return true;}});
 const r=await f.request('GET','/bridge/v1/code?'+query,undefined,native);
 assert.equal(r.status,200);assert.deepEqual(r.data,release);assert.equal(r.raw.includes('PRIVATE'),false);
});

test('Code package routes reject duplicate/unknown parameters, invalid targets and Desktop requests before forwarding',async t=>{
 const f=await fixture(t);
 for(const path of ['/bridge/v1/code?os=windows&arch=amd64&os=linux','/bridge/v1/code?'+query+'&url=https://evil','/bridge/v1/code?os=windows&arch=arm64','/bridge/v1/code/download?'+query+'&version=../../escape','/bridge/v1/code?'+query+'&surface=desktop']){
  const before=f.state.requests.length;const r=await f.request('GET',path,undefined,native);assert.equal(r.status,400,path);assert.equal(f.state.requests.length,before);
 }
 assert.equal((await f.request('POST','/bridge/v1/code',{},native)).status,404);
});

test('Code package download is binary and supports a single validated range',async t=>{
 const f=await fixture(t,{onCore:({req,res,url})=>{
  if(url.pathname!=='/bridge/v1/code/download')return false;
  const part=req.headers.range?body.subarray(4):body;
  res.writeHead(req.headers.range?206:200,{'Content-Type':'application/zip','Content-Length':part.length,'Set-Cookie':'PRIVATE',...(req.headers.range?{'Content-Range':`bytes 4-${body.length-1}/${body.length}`}:{})});res.end(part);return true;
 }});
 const url=f.config.publicOrigin+'/bridge/v1/code/download?'+query+'&version='+release.version;
 let r=await fetch(url,{headers});assert.equal(r.status,200);assert.equal(r.headers.get('set-cookie'),null);assert.deepEqual(Buffer.from(await r.arrayBuffer()),body);
 r=await fetch(url,{headers:{...headers,Range:'bytes=4-'}});assert.equal(r.status,206);assert.equal(r.headers.get('content-range'),`bytes 4-${body.length-1}/${body.length}`);assert.deepEqual(Buffer.from(await r.arrayBuffer()),body.subarray(4));
 r=await fetch(url,{headers:{...headers,Range:'bytes=0-1,4-6'}});assert.equal(r.status,400);await r.arrayBuffer();
});

test('Code metadata never accepts unknown sizes, path versions or missing SHA256',async t=>{
 let extra={sha256:'unknown'};
 const f=await fixture(t,{onCore:({url,json})=>{if(url.pathname!=='/bridge/v1/code')return false;json({...release,...extra});return true;}});
 for(extra of [{sha256:'unknown'},{size:0},{size:512*1024*1024+1},{version:'../escape'},{os:'linux'}])assert.equal((await f.request('GET','/bridge/v1/code?'+query,undefined,native)).status,503);
});

test('Code download bodies outlive the model header deadline and disconnect cancels upstream',async t=>{
 let closed=0;
 const f=await fixture(t,{env:{RUNTIME_HEADER_TIMEOUT_MS:'100'},onCore:({url,res})=>{
  if(url.pathname!=='/bridge/v1/code/download')return false;
  res.writeHead(200,{'Content-Type':'application/zip'});res.write(body.subarray(0,4));
  const timer=setInterval(()=>res.write(body),60);res.once('close',()=>{clearInterval(timer);closed++;});return true;
 }});
 const controller=new AbortController(),r=await fetch(f.config.publicOrigin+'/bridge/v1/code/download?'+query+'&version='+release.version,{headers,signal:controller.signal});
 assert.equal(r.status,200);const reader=r.body.getReader();await reader.read();await delay(250);assert.equal(closed,0);
 controller.abort();await reader.cancel().catch(()=>{});for(let i=0;i<30&&!closed;i++)await delay(20);assert.equal(closed,1);
});
