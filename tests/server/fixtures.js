import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, rm, readFile, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, basename } from 'node:path';
import { once } from 'node:events';
import { randomUUID, createHmac } from 'node:crypto';
import { createMerchant } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';

export const password='Test-only long password 123!';
export const upstreamKey='ccbm_'+ 'a'.repeat(64);
export const now='2026-10-26T00:00:00.000Z';

export async function fixture(t,options={}) {
  const root=await mkdtemp(join(tmpdir(),'ccb-merchant-test-'));
  await mkdir(join(root,'public'));
  const state={fulfillments:new Map(),customers:[],grants:[],requests:[],keys:[],runtimeCancelled:0};
  const fakeCore=createServer(async(req,res)=>{
    const chunks=[]; for await(const chunk of req) chunks.push(chunk);
    const raw=Buffer.concat(chunks), url=new URL(req.url,'http://localhost');
    let body={}; try {body=JSON.parse(raw.toString());} catch {}
    state.requests.push({method:req.method,path:req.url,headers:req.headers,body,raw});
    const json=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    if(await options.onCore?.({req,res,url,body,state,json})) return;
    if(url.pathname.startsWith('/merchant/') && req.headers.authorization!==`Bearer ${upstreamKey}`) {json({error:{message:'bad secret'}},401);return;}
    const path=url.pathname;
    if(path==='/merchant/v1/me') {json({protocol_version:4,authority_id:'fixture-authority',merchant:{id:'merchant-1',name:'Test merchant',slug:'test',status:'active',api_key:'LEAK'},scopes:['resources.read','customers.read','customers.write','devices.read','devices.write','usage.read','runtime','keys.manage','grants.read','grants.write'],credentials:'LEAK'});return;}
    if(path==='/merchant/v1/resources') {json({resources:[{id:'resource-1',name:'Code resource',status:'active',surfaces:['code'],expires_at:null,revision:1,available:true,delegated:0,account_id:'LEAK',email:'LEAK',proxy_password:'LEAK'}]});return;}
    if(path==='/merchant/v1/customers') {
      if(req.method==='GET') {json({customers:state.customers.filter(c=>!url.searchParams.has('external_id')||c.external_id===url.searchParams.get('external_id'))});return;}
      let customer=state.customers.find(c=>c.external_id===body.external_id);
      if(customer && customer.display_name!==body.display_name) {json({error:{code:'conflict'}},409);return;}
      if(!customer) {customer={id:`customer-${randomUUID()}`,external_id:body.external_id,display_name:body.display_name,status:'active',revision:1,created_at:now,core_user_id:'LEAK'};state.customers.push(customer);}
      json({customer},201);return;
    }
    let match;
    if(req.method==='PATCH' && (match=path.match(/^\/merchant\/v1\/customers\/([^/]+)$/))) {
      const customer=state.customers.find(c=>c.id===match[1]);
      if(!customer) {json({error:{}},404);return;}
      if(customer.revision!==body.expected_revision) {json({error:{}},409);return;}
      Object.assign(customer,{status:body.status??customer.status,display_name:body.display_name??customer.display_name,revision:customer.revision+1});json({customer});return;
    }
    if(req.method==='PUT' && path.startsWith('/merchant/v1/fulfillments/')) {
      const id=path.split('/').at(-1),prior=state.fulfillments.get(id);
      if(prior) {if(prior.customer_id!==body.customer_id||prior.resource_id!==body.resource_id||prior.duration_days!==body.duration_days){json({error:{}},409);return;}json({fulfillment:prior});return;}
      const receipt={order_id:id,customer_id:body.customer_id,resource_id:body.resource_id,duration_days:body.duration_days,status:'cancelled',expires_at:null,created_at:new Date().toISOString()};
      if(body.action==='fulfill') {
        let grant=state.grants.find(g=>g.customer_id===body.customer_id&&g.resource_id===body.resource_id);
        const start=grant?.status==='active'&&grant.expires_at?Math.max(Date.now(),Date.parse(grant.expires_at)):Date.now();
        if(!grant){grant={id:`grant-${randomUUID()}`,customer_id:body.customer_id,resource_id:body.resource_id,name:'Code entitlement',surfaces:['code'],revision:0};state.grants.push(grant);}
        Object.assign(grant,{status:'active',expires_at:new Date(start+body.duration_days*86400000).toISOString(),revision:grant.revision+1,updated_at:new Date().toISOString()});
        Object.assign(receipt,{status:'fulfilled',grant_id:grant.id,expires_at:grant.expires_at});
      }
      state.fulfillments.set(id,receipt);
      if(await options.afterFulfillment?.({req,res,body,state,receipt,json}))return;
      json({fulfillment:receipt});return;
    }
    if(path==='/merchant/v1/grants') {
      if(req.method==='GET') {json({grants:state.grants.filter(g=>!url.searchParams.has('customer_id')||g.customer_id===url.searchParams.get('customer_id'))});return;}
      let grant=state.grants.find(g=>g.customer_id===body.customer_id&&g.resource_id===body.resource_id);
      if(!grant) {grant={id:`grant-${randomUUID()}`,customer_id:body.customer_id,resource_id:body.resource_id,name:'Code entitlement',status:'active',surfaces:['code'],expires_at:body.expires_at??null,revision:1,updated_at:now,token:'LEAK'};state.grants.push(grant);}
      json({grant},201);return;
    }
    if(req.method==='PATCH' && (match=path.match(/^\/merchant\/v1\/grants\/([^/]+)$/))) {
      const grant=state.grants.find(g=>g.id===match[1]);
      if(!grant) {json({error:{}},404);return;}
      if(grant.revision!==body.expected_revision) {json({error:{message:'SQL TOKEN LEAK'}},409);return;}
      Object.assign(grant,{...body,revision:grant.revision+1});json({grant});return;
    }
    if(path.endsWith('/devices/preview')) {json({device:{name:'My laptop',platform:'windows',code:body.code,expires_at:now,renewal:false,upstream_email:'LEAK'}});return;}
    if(path.endsWith('/devices/approve') || (req.method==='DELETE' && path.includes('/devices/'))) {json({ok:true,secret:'LEAK'});return;}
    if(path.endsWith('/devices')) {json({devices:[{id:'device-1',name:'Laptop',platform:'windows',state:'approved',created_at:now,expires_at:now,token:'LEAK'}]});return;}
    if(path.endsWith('/usage')) {json({usage:{requests:1,errors:0,input_tokens:30,output_tokens:5,cache_read_input_tokens:0,cache_creation_input_tokens:0,cost_usd:4.2,unknown_usage:0,average_duration_ms:20,average_first_token_ms:3,body:'LEAK'},requests:[{id:123,time:now,model:'test-model',status:200,duration_ms:20,first_token_ms:3,count_only:false,stream:true,usage:{input_tokens:30,output_tokens:5,cache_creation_5m:7,cache_creation_1h:11,prompt:'LEAK'},usage_complete:true,cost_usd:4.2,grant_id:'grant-1',session_id:'session-1',raw_request:'LEAK',headers:{Authorization:'LEAK'}}],total:1});return;}
    if(path==='/merchant/v1/keys') {
      if(req.method==='GET') {json({keys:state.keys});return;}
      const key={id:`key-${randomUUID()}`,name:body.name,scopes:body.scopes,expires_at:body.expires_at??null,created_at:now,revoked_at:null,prefix:'ccbm_test',token:'LEAK'};
      state.keys.push(key);json({key,token:'ccbm_once_only_test_token_value_123'});return;
    }
    if(req.method==='DELETE' && path.startsWith('/merchant/v1/keys/')) {json({ok:true});return;}
    if(path==='/bridge/v1/device/status' || path==='/bridge/v1/bindings') {
      json({id:'device-1',binding:'binding-1',device_id:'device-1',owner_user_id:'PRIVATE_CORE_USER',owner_username:'LEAK',state:'approved',selection_version:1,os:'windows',arch:'x64',expires_at:now,traffic:{version:1,timezone:'UTC',domains:['anthropic.com'],secret:'LEAK'},token:'LEAK'});return;
    }
    if(path==='/bridge/v1/device/start') {json({code:'ABC123',verification_path:'/connect',expires_at:now,interval:3},201);return;}
    if(path==='/bridge/v1/accounts') {json({accounts:[{id:'grant-1',name:'Code',state:'available',plan:'max',shared:true,quota:{status:'available',windows:[{key:'five_hour',label:'5 hours',used_percent:20,secret:'LEAK'}]},email:'LEAK'}],current_grant_id:'grant-1',selection_version:1});return;}
    if(path.startsWith('/bridge/v1/')) {json({ok:true});return;}
    json({error:{code:'not_found'}},404);
  });
  fakeCore.listen(0,'127.0.0.1'); await once(fakeCore,'listening');
  const config=loadConfig({UPSTREAM_URL:`http://127.0.0.1:${fakeCore.address().port}`,UPSTREAM_API_KEY:upstreamKey,UPSTREAM_TIMEOUT_MS:'500',...options.env},root);
  if(options.publicDir)config.publicDir=options.publicDir;
  if(options.withoutCore) {config.upstreamUrl=null;config.upstreamKey='';config.upstreamEnvironment=false;}
  let app=createMerchant(config,{reconcileIntervalMs:0,mailer:options.mailer??null,paymentTransport:options.paymentTransport,onError:options.onError});
  app.server.listen(0,'127.0.0.1'); await once(app.server,'listening');
  config.port=app.server.address().port; config.publicOrigin=`http://127.0.0.1:${config.port}`;config.publicHost=`127.0.0.1:${config.port}`;
  const request=async(method,path,body,actor={})=>{
    const headers={...(body!==undefined?{'Content-Type':'application/json','Content-Length':String(Buffer.byteLength(JSON.stringify(body)))}:{}),...(actor.cookie?{Cookie:actor.cookie}:{}),...(actor.csrf?{'X-CSRF-Token':actor.csrf}:{}),...(!['GET','HEAD'].includes(method) && !actor.native?{Origin:config.publicOrigin}:{}),...actor.headers};
    return await new Promise((resolve,reject)=>{
      const call=httpRequest(config.publicOrigin,{method,path,headers,agent:false},response=>{
        const chunks=[];
        response.on('data',chunk=>chunks.push(chunk));response.on('error',reject);
        response.on('end',()=>{
          const raw=Buffer.concat(chunks).toString('utf8');let data;try{data=JSON.parse(raw);}catch{data=raw;}
          const responseHeaders=new Headers();for(const [name,value] of Object.entries(response.headers)) for(const item of Array.isArray(value)?value:[value]) if(item!==undefined) responseHeaders.append(name,item);
          resolve({status:response.statusCode,data,raw,headers:responseHeaders,cookie:responseHeaders.get('set-cookie')?.split(';')[0],csrf:data?.csrf_token});
        });
      });
      call.on('error',reject);call.end(body===undefined?undefined:JSON.stringify(body));
    });
  };
  const setupToken=(await readFile(app.store.setupFile,'utf8')).trim();
  const f={root,config,state,fakeCore,request,setupToken,get store(){return app.store;},get server(){return app.server;},get reconciler(){return app.reconciler;},async restart(){
    app.server.closeAllConnections(); await new Promise(resolve=>app.server.close(resolve));app.store.db.close();
    app=createMerchant(config,{reconcileIntervalMs:0,mailer:options.mailer??null,paymentTransport:options.paymentTransport});
    app.server.listen(config.port,'127.0.0.1');await once(app.server,'listening');
  }};
  t.after(async()=>{app.server.closeAllConnections();fakeCore.closeAllConnections();await Promise.all([new Promise(resolve=>app.server.close(resolve)),new Promise(resolve=>fakeCore.close(resolve))]);app.store.db.close();const actual=await realpath(root), inside=relative(await realpath(tmpdir()),actual);if(inside.startsWith('..')||isAbsolute(inside)||!basename(actual).startsWith('ccb-merchant-test-')) throw new Error('Refusing cleanup outside isolated test root');await rm(actual,{recursive:true,force:true});});
  return f;
}

export function stripeFixture() {
  const sessions=new Map(), calls=[];
  let dropCreate=false, failGet=false;
  const transport=async(url,options)=>{
    calls.push({url,options});
    if(options.method==='POST') {
      const form=new URLSearchParams(options.body), id=`cs_test_${randomUUID().replaceAll('-','')}`;
      const session={id,url:`https://checkout.stripe.com/c/pay/${id}`,mode:'payment',livemode:false,payment_status:'unpaid',status:'open',currency:'cny',amount_total:Number(form.get('line_items[0][price_data][unit_amount]')),client_reference_id:form.get('client_reference_id'),metadata:{order_id:form.get('metadata[order_id]'),user_id:form.get('metadata[user_id]')}};
      sessions.set(id,session);
      if(dropCreate) throw new Error('simulated lost response');
      return Response.json(session);
    }
    if(failGet) throw new Error('simulated Stripe outage');
    return Response.json(sessions.get(url.split('/').at(-1))||{error:'missing'});
  };
  const event=(sessionId,{id=`evt_${randomUUID().replaceAll('-','')}`,type='checkout.session.completed',timestamp=Math.floor(Date.now()/1000),secret='whsec_test_fixture',mutate}={})=>{
    const payload={id,type,livemode:false,data:{object:{id:sessionId}}}; if(mutate) mutate(payload);
    const raw=JSON.stringify(payload), signature=`t=${timestamp},v1=${createHmac('sha256',secret).update(`${timestamp}.${raw}`).digest('hex')}`;
    return {raw,signature,payload};
  };
  return {sessions,calls,transport,event,set dropCreate(value){dropCreate=value;},set failGet(value){failGet=value;}};
}





