import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { fixture,password,upstreamKey } from './fixtures.js';
import { accessScopes } from '../../src/access.js';

async function provider(t,options={}){
 const f=await fixture(t,options),admin=await f.request('POST','/api/setup',{setup_token:f.setupToken,email:'provider@example.test',display_name:'Provider',password});
 const clients=[];
 for(const slug of ['client-c','client-d']){
  const created=await f.request('POST','/api/admin/access-accounts',{slug,name:slug},admin);assert.equal(created.status,201,created.raw);
  const account=created.data.account;
  const resource=await f.request('POST',`/api/admin/access-accounts/${account.id}/resources`,{upstream_id:'resource-1',name:'Private client resource'},admin);assert.equal(resource.status,201,resource.raw);
  const key=await f.request('POST',`/api/admin/access-accounts/${account.id}/keys`,{name:'service',scopes:accessScopes},admin);assert.equal(key.status,201,key.raw);
  clients.push({account,resource:resource.data.resource,key:key.data,actor:{native:true,headers:{Authorization:`Bearer ${key.data.token}`}}});
 }
 return {f,admin,c:clients[0],d:clients[1]};
}

test('local keys isolate clients and rotate independently without upstream merchant registration or key propagation',async t=>{
 const {f,admin,c,d}=await provider(t);
 assert.equal(f.state.requests.some(r=>r.path.includes('/children')||r.path.includes('/keys')),false);
 assert.equal((await f.request('GET','/merchant/v1/me',undefined,c.actor)).data.protocol_version,4);
 const cResource=(await f.request('GET','/merchant/v1/resources',undefined,c.actor)).data.resources;
 assert.deepEqual(cResource.map(r=>r.id),[c.resource.id]);assert.equal(JSON.stringify(cResource).includes('resource-1'),false);
 const made=await f.request('POST','/merchant/v1/customers',{external_id:'customer-same',display_name:'C secret customer'},c.actor);assert.equal(made.status,201,made.raw);
 const other=await f.request('POST','/merchant/v1/customers',{external_id:'customer-same',display_name:'D secret customer'},d.actor);assert.equal(other.status,201,other.raw);assert.notEqual(made.data.customer.id,other.data.customer.id);
 assert.equal((await f.request('GET','/merchant/v1/customers',undefined,c.actor)).data.customers.length,1);
 assert.equal((await f.request('PATCH',`/merchant/v1/customers/${made.data.customer.id}`,{expected_revision:1,status:'disabled'},d.actor)).status,404);
 assert.equal((await f.request('POST','/merchant/v1/grants',{customer_id:made.data.customer.id,resource_id:d.resource.id},c.actor)).status,404);
 const forwarded=JSON.stringify(f.state.requests);
 for(const secret of [c.key.token,d.key.token,c.account.name,d.account.name,'C secret customer','D secret customer'])assert.equal(forwarded.includes(secret),false,secret);
 const remote=f.state.customers;assert.ok(remote.every(v=>v.display_name==='API customer'));assert.ok(remote.every(v=>v.external_id!=='customer-same'));assert.ok(f.state.requests.every(r=>!r.headers['x-ccb-relay-keys']));
 const rotated=await f.request('POST',`/api/admin/access-accounts/${c.account.id}/keys`,{name:'new-service',scopes:accessScopes},admin);assert.equal(rotated.status,201);
 const revoked=await f.request('DELETE',`/api/admin/access-accounts/${c.account.id}/keys/${c.key.key.id}`,{},admin);assert.equal(revoked.status,200,revoked.raw);
 assert.equal((await f.request('GET','/merchant/v1/customers',undefined,c.actor)).status,401);
 const replacement={native:true,headers:{Authorization:`Bearer ${rotated.data.token}`}};
 assert.equal((await f.request('GET','/merchant/v1/customers',undefined,replacement)).data.customers[0].id,made.data.customer.id);
 assert.equal((await f.request('GET','/merchant/v1/customers',undefined,d.actor)).status,200);
 assert.equal(f.store.db.prepare('SELECT token_hash FROM access_keys WHERE id=?').get(rotated.data.key.id).token_hash,createHash('sha256').update(rotated.data.token).digest('hex'));
 assert.equal(f.store.db.prepare('SELECT token FROM access_keys WHERE id=?').get(rotated.data.key.id).token,rotated.data.token);
 const listed=await f.request('GET',`/api/admin/access-accounts/${c.account.id}/keys`,undefined,admin);assert.equal(JSON.stringify(listed.data).includes(rotated.data.token),false);
 assert.equal(listed.data.keys.find(k=>k.id===rotated.data.key.id).copyable,true);
 const shown=await f.request('POST',`/api/admin/access-accounts/${c.account.id}/keys/${rotated.data.key.id}/copy`,{},admin);assert.equal(shown.status,201,shown.raw);assert.equal(shown.data.token,rotated.data.token);

 await f.restart();assert.equal((await f.request('GET','/merchant/v1/customers',undefined,replacement)).data.customers.length,1);
});

test('local grants, fulfilled order IDs and group access are owned per API client and survive uncertain responses',async t=>{
 let drop=true;
 const {f,admin,c,d}=await provider(t,{afterFulfillment:({json})=>{if(drop){json({error:{}},503);return true;}}});
 const customer=(await f.request('POST','/merchant/v1/customers',{external_id:'local-user',display_name:'Private'},c.actor)).data.customer;
 const body={customer_id:customer.id,resource_id:c.resource.id,duration_days:1,action:'fulfill'};
 const first=await f.request('PUT','/merchant/v1/fulfillments/private-c-order',body,c.actor);assert.equal(first.status,503,first.raw);assert.equal(f.state.grants.length,1);
 const end=f.state.grants[0].expires_at;await f.restart();drop=false;
 const retry=await f.request('PUT','/merchant/v1/fulfillments/private-c-order',body,c.actor);assert.equal(retry.status,200,retry.raw);assert.equal(retry.data.fulfillment.expires_at,end);assert.notEqual(retry.data.fulfillment.grant_id,f.state.grants[0].id);
 const grant=retry.data.fulfillment.grant_id;
 assert.equal((await f.request('GET',`/merchant/v1/grants?customer_id=${customer.id}`,undefined,d.actor)).status,404);
 const child2=(await f.request('POST','/merchant/v1/customers',{external_id:'another',display_name:'Another'},c.actor)).data.customer;
 const full=await f.request('POST','/merchant/v1/grants',{customer_id:child2.id,resource_id:c.resource.id},c.actor);assert.equal(full.status,201,full.raw);
 assert.equal((await f.request('PUT','/merchant/v1/fulfillments/private-c-order',{...body,action:'cancel'},c.actor)).data.fulfillment.status,'fulfilled');
 const unknown=await f.request('PUT','/merchant/v1/fulfillments/cancel-before-send',{...body,action:'cancel'},c.actor);assert.equal(unknown.data.fulfillment.status,'cancelled');
 assert.equal((await f.request('PUT','/merchant/v1/fulfillments/cancel-before-send',body,c.actor)).data.fulfillment.status,'cancelled');
 assert.ok([...f.state.fulfillments.keys()].every(id=>!id.includes('private-c-order')&&!id.includes('cancel-before-send')));
 const text=JSON.stringify(f.state.requests);assert.equal(text.includes(customer.id),false);assert.equal(text.includes(grant),false);
 const suspended=await f.request('PATCH',`/api/admin/access-accounts/${c.account.id}`,{expected_revision:c.account.revision,status:'disabled'},admin);assert.equal(suspended.status,200);
 assert.equal((await f.request('GET','/merchant/v1/grants',undefined,c.actor)).status,401);
 assert.equal(f.state.requests.some(r=>r.path.includes(c.account.id)),false);
});

test('retail and API customers can share authorized groups without customer seat quotas',async t=>{
 const {f,admin,c}=await provider(t);
 const over=await f.request('POST',`/api/admin/access-accounts/${c.account.id}/resources`,{upstream_id:'resource-1',name:'Extra'},admin);assert.equal(over.status,409,over.raw);
 for(let i=0;i<3;i++){
  const user=await f.request('POST','/api/admin/users',{email:`retail${i}@example.test`,display_name:'Retail',password,role:'member'},admin);assert.equal(user.status,201);
  assert.equal((await f.request('POST',`/api/admin/users/${user.data.user.id}/provision`,{},admin)).status,200);
  const grant=await f.request('POST','/api/admin/grants',{user_id:user.data.user.id,resource_id:'resource-1'},admin);assert.equal(grant.status,201,grant.raw);
 }
 assert.equal(f.state.grants.length,3);
});

test('API device ownership and grant IDs are translated while model bodies remain byte-for-byte forwarded',async t=>{
 const token='device-native-test-secret-12345',hash=createHash('sha256').update(token).digest('hex');
 const {f,c,d}=await provider(t,{onCore:({url,body,json,req})=>{
  if(url.pathname==='/bridge/v1/device/start'){json({code:'PAIRING12345',expires_at:new Date(Date.now()+60000).toISOString(),interval:3,verification_path:'/connect'},201);return true;}
  if(url.pathname==='/bridge/v1/device/status'){json({id:'upstream-device-id',state:'approved',owner_user_id:'root-internal-user',current_grant_id:f.state.grants[0]?.id,selection_version:1});return true;}
  if(url.pathname==='/bridge/v1/device/account'){json({current_grant_id:body.grant_id,selection_version:1});return true;}
  if(url.pathname==='/bridge/v1/accounts'){json({accounts:f.state.grants.map(g=>({id:g.id,name:'upstream name',state:'available'})),current_grant_id:f.state.grants[0]?.id,selection_version:1});return true;}
  if(url.pathname==='/bridge/v1/messages'){json({output:'unchanged reply'});return true;}
 }});
 const customer=(await f.request('POST','/merchant/v1/customers',{external_id:'owner',display_name:'Owner'},c.actor)).data.customer;
 const grant=(await f.request('POST','/merchant/v1/grants',{customer_id:customer.id,resource_id:c.resource.id},c.actor)).data.grant;
 const start={native:true,headers:{'X-CCB-Merchant-Key':c.key.token}},native={native:true,headers:{Authorization:`Bearer ${token}`,'X-CCB-Merchant-Key':c.key.token}};
 const paired=await f.request('POST','/bridge/v1/device/start',{name:'C user laptop',platform:'windows',token_hash:hash},start);assert.equal(paired.status,201,paired.raw);
 assert.equal((await f.request('POST',`/merchant/v1/customers/${customer.id}/devices/approve`,{code:paired.data.code},c.actor)).status,200);
 assert.equal((await f.request('GET','/bridge/v1/device/status',undefined,{native:true,headers:{Authorization:`Bearer ${token}`,'X-CCB-Merchant-Key':d.key.token}})).status,401);
 assert.equal((await f.request('GET','/bridge/v1/device/status',undefined,{native:true,headers:{Authorization:`Bearer ${token}`}})).status,401);
 const selected=await f.request('POST','/bridge/v1/device/account',{grant_id:grant.id},native);assert.equal(selected.status,200,selected.raw);assert.equal(selected.data.current_grant_id,grant.id);
 const listed=await f.request('GET','/bridge/v1/accounts',undefined,native);assert.equal(listed.data.accounts[0].id,grant.id);
 const status=await f.request('GET','/bridge/v1/device/status',undefined,native);assert.notEqual(status.data.id,'upstream-device-id');
 const payload={model:'fixture',messages:[{role:'user',content:'private request body'}]};
 const result=await f.request('POST','/bridge/v1/messages',payload,native);assert.equal(result.status,200,result.raw);assert.equal(result.data.output,'unchanged reply');
 const sent=f.state.requests.filter(r=>r.path==='/bridge/v1/messages').at(-1);assert.deepEqual(sent.body,payload);assert.equal(sent.headers['x-ccb-merchant-key'],upstreamKey);assert.equal(sent.headers['x-ccb-relay-keys'],undefined);assert.equal(sent.headers.authorization,`Bearer ${token}`);
 assert.equal(f.state.requests.find(r=>r.path==='/bridge/v1/device/start').body.name,'API device');
 assert.equal(JSON.stringify(f.state.requests).includes(c.key.token),false);
});


test('key scopes, expiry, revocation and malformed protocol routes never cross account bounds',async t=>{
 const {f,admin,c}=await provider(t);
 const made=await f.request('POST',`/api/admin/access-accounts/${c.account.id}/keys`,{name:'read-only',scopes:['resources.read']},admin);assert.equal(made.status,201);
 const read={native:true,headers:{Authorization:`Bearer ${made.data.token}`}};
 assert.equal((await f.request('GET','/merchant/v1/resources',undefined,read)).status,200);
 assert.equal((await f.request('GET','/merchant/v1/customers',undefined,read)).status,403);
 assert.equal((await f.request('POST','/merchant/v1/customers',{external_id:'x',display_name:'x'},read)).status,403);
 assert.equal((await f.request('GET','/merchant/v1/children',undefined,c.actor)).status,404);
 assert.equal((await f.request('GET','/merchant/v1/customers/not-existing',undefined,c.actor)).status,404);
 assert.equal((await f.request('GET','/merchant/v1/resources?account_id=other',undefined,c.actor)).status,400);
 assert.equal((await f.request('GET','/merchant/v1/me',undefined,{native:true,headers:{...c.actor.headers,'X-Extra-Credential':'not-forwarded'}})).status,200);
 assert.ok(f.state.requests.every(r=>r.headers['x-extra-credential']===undefined));
 f.store.db.prepare('UPDATE access_keys SET expires_at=? WHERE id=?').run(new Date(Date.now()-1000).toISOString(),made.data.key.id);
 assert.equal((await f.request('GET','/merchant/v1/resources',undefined,read)).status,401);
 assert.equal((await f.request('GET',`/api/admin/access-accounts/${c.account.id}/keys`,undefined,admin)).raw.includes(c.key.token),false);
});

test('ambiguous customer/grant writes keep local intents and retry by mapped identity without duplicating upstream objects',async t=>{
 let failCustomer=true,failGrant=true;
 const {f,c}=await provider(t,{onCore:({req,url,body,state,json})=>{
  if(req.method==='POST'&&url.pathname==='/merchant/v1/customers'&&failCustomer){state.customers.push({id:'remote-customer',external_id:body.external_id,display_name:body.display_name,status:'active',revision:1,created_at:new Date().toISOString()});json({error:{}},503);return true;}
  if(req.method==='POST'&&url.pathname==='/merchant/v1/grants'&&failGrant){state.grants.push({id:'remote-grant',customer_id:body.customer_id,resource_id:body.resource_id,status:'active',expires_at:body.expires_at,revision:1,updated_at:new Date().toISOString()});json({error:{}},503);return true;}
 }});
 const intent={external_id:'local-id',display_name:'Secret name'};
 assert.equal((await f.request('POST','/merchant/v1/customers',intent,c.actor)).status,503);await f.restart();failCustomer=false;
 const retried=await f.request('POST','/merchant/v1/customers',intent,c.actor);assert.equal(retried.status,201,retried.raw);assert.equal(f.state.customers.length,1);assert.equal(f.state.requests.filter(r=>r.method==='POST'&&r.path==='/merchant/v1/customers').length,1);
 const body={customer_id:retried.data.customer.id,resource_id:c.resource.id};assert.equal((await f.request('POST','/merchant/v1/grants',body,c.actor)).status,503);await f.restart();failGrant=false;
 const synced=await f.request('POST','/merchant/v1/grants',body,c.actor);assert.equal(synced.status,201,synced.raw);assert.equal(synced.data.grant.pending,false);assert.equal(f.state.grants.length,1);assert.equal(f.state.requests.filter(r=>r.method==='POST'&&r.path==='/merchant/v1/grants').length,1);
});

test('a cancellation receipt wins permanently and a late fulfillment receipt cannot revive an upstream revoked grant',async t=>{
 let drop=true;
 const {f,c}=await provider(t,{afterFulfillment:({json})=>{if(drop){json({error:{}},503);return true;}}});
 const customer=(await f.request('POST','/merchant/v1/customers',{external_id:'owner',display_name:'Owner'},c.actor)).data.customer;
 const body={customer_id:customer.id,resource_id:c.resource.id,duration_days:1,action:'fulfill'};
 assert.equal((await f.request('PUT','/merchant/v1/fulfillments/ambiguous-order',body,c.actor)).status,503);
 f.state.grants[0].status='revoked';drop=false;
 const reconciled=await f.request('PUT','/merchant/v1/fulfillments/ambiguous-order',body,c.actor);assert.equal(reconciled.status,200,reconciled.raw);assert.equal(reconciled.data.fulfillment.status,'fulfilled');
 assert.equal((await f.request('GET','/merchant/v1/grants',undefined,c.actor)).data.grants[0].status,'revoked');
 const cancelled=await f.request('PUT','/merchant/v1/fulfillments/cancelled-order',{...body,action:'cancel'},c.actor);assert.equal(cancelled.data.fulfillment.status,'cancelled');
 const repeat=await f.request('PUT','/merchant/v1/fulfillments/cancelled-order',body,c.actor);assert.equal(repeat.data.fulfillment.status,'cancelled');
});

test('permission loss during resource verification leaves its local allocation unchanged',async t=>{
 let delay=false,release,arrive;const entered=new Promise(r=>arrive=r),gate=new Promise(r=>release=r);
 const {f,admin,c}=await provider(t,{onCore:async({url})=>{if(delay&&url.pathname==='/merchant/v1/resources'){arrive();await gate;}}});
 await f.request('POST','/api/admin/users',{email:'otheradmin@example.test',display_name:'Other',password,role:'admin'},admin);
 delay=true;const pending=f.request('PATCH',`/api/admin/access-accounts/${c.account.id}/resources/${c.resource.id}`,{name:'changed',expected_revision:1},admin);
 await entered;f.store.db.prepare("UPDATE users SET role='member' WHERE id=?").run(admin.data.user.id);release();const result=await pending;
 assert.equal(result.status,403);assert.equal(f.store.db.prepare('SELECT name FROM access_resources WHERE id=?').get(c.resource.id).name,'Private client resource');
});


test('API key revocation terminates an active streamed response without retrying upstream',async t=>{
 const {request:httpRequest}=await import('node:http');
 const token='streamed-device-fixture-token',hash=createHash('sha256').update(token).digest('hex');
 let peerClosed;
 const closed=new Promise(r=>peerClosed=r);
 const {f,admin,c}=await provider(t,{onCore:({url,req,res,json,body})=>{
  if(url.pathname==='/bridge/v1/device/start'){json({code:'STREAM123456',expires_at:new Date(Date.now()+60000).toISOString(),interval:3,verification_path:'/connect'},201);return true;}
  if(url.pathname==='/bridge/v1/device/account'){json({current_grant_id:body.grant_id,selection_version:1});return true;}
  if(url.pathname==='/bridge/v1/messages'){
   res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: {"first":true}\n\n');const timer=setInterval(()=>res.write(': keepalive\n\n'),100);
   res.once('close',()=>{clearInterval(timer);peerClosed();});return true;
  }
 }});
 const customer=(await f.request('POST','/merchant/v1/customers',{external_id:'owner',display_name:'Owner'},c.actor)).data.customer;
 const grant=(await f.request('POST','/merchant/v1/grants',{customer_id:customer.id,resource_id:c.resource.id},c.actor)).data.grant;
 const native={native:true,headers:{Authorization:`Bearer ${token}`,'X-CCB-Merchant-Key':c.key.token}};
 await f.request('POST','/bridge/v1/device/start',{name:'Stream',platform:'windows',token_hash:hash},{native:true,headers:{'X-CCB-Merchant-Key':c.key.token}});
 await f.request('POST',`/merchant/v1/customers/${customer.id}/devices/approve`,{code:'STREAM123456'},c.actor);
 await f.request('POST','/bridge/v1/device/account',{grant_id:grant.id},native);
 let call,response,received='';
 await new Promise((resolve,reject)=>{
  const body=JSON.stringify({stream:true,messages:[]});call=httpRequest(f.config.publicOrigin+'/bridge/v1/messages',{method:'POST',headers:{...native.headers,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{response=res;res.once('data',chunk=>{received+=chunk.toString();resolve();});res.on('error',()=>{});});call.on('error',reject);call.end(body);
 });
 t.after(()=>{response?.destroy();call?.destroy();});
 assert.match(received,/first/);
 assert.equal((await f.request('DELETE',`/api/admin/access-accounts/${c.account.id}/keys/${c.key.key.id}`,{},admin)).status,200);
 let timeout;await Promise.race([closed,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('stream was not cancelled')),5000);})]).finally(()=>clearTimeout(timeout));
 assert.equal(f.state.requests.filter(r=>r.path==='/bridge/v1/messages').length,1);
});


test('revoked key during upstream grant preflight cannot send the grant mutation',async t=>{
 let release,arrive,reads=0,block=false;const gate=new Promise(r=>release=r),entered=new Promise(r=>arrive=r);
 const {f,c}=await provider(t,{onCore:async({url})=>{if(block&&url.pathname==='/merchant/v1/grants'){reads++;if(reads===1){arrive();await gate;}}}});
 const customer=(await f.request('POST','/merchant/v1/customers',{external_id:'owner',display_name:'Owner'},c.actor)).data.customer;
 block=true;const mutation=f.request('POST','/merchant/v1/grants',{customer_id:customer.id,resource_id:c.resource.id},c.actor);
 await entered;f.store.db.prepare('UPDATE access_keys SET revoked_at=? WHERE id=?').run(new Date().toISOString(),c.key.key.id);release();const result=await mutation;
 assert.equal(result.status,401,result.raw);assert.equal(f.state.requests.filter(r=>r.path==='/merchant/v1/grants'&&r.method==='POST').length,0);
});

test('API customer pagination works beyond one thousand local customers without a business cap',async t=>{
 const {f,c}=await provider(t);
 f.store.transaction(()=>{for(let i=0;i<1001;i++)f.store.db.prepare("INSERT INTO access_customers(id,account_id,external_id,display_name,status,upstream_external,upstream_id,pending,created_at) VALUES(?,?,?,?,'active',?,?,0,?)").run('seed-'+i,c.account.id,'ext-'+i,'Seed '+i,'mapped-'+i,'remote-'+i,'2020-01-01T00:00:00Z');});
 const created=await f.request('POST','/merchant/v1/customers',{external_id:'after-1000',display_name:'New'},c.actor);assert.equal(created.status,201,created.raw);
 const page=await f.request('GET','/merchant/v1/customers?limit=2&offset=1000',undefined,c.actor);assert.equal(page.status,200);assert.equal(page.data.total,1002);assert.equal(page.data.customers.length,2);
 const exact=await f.request('GET','/merchant/v1/customers?external_id=after-1000',undefined,c.actor);assert.equal(exact.data.total,1);assert.equal(exact.data.customers[0].id,created.data.customer.id);
 assert.equal('public_origin' in c.account,false);assert.equal('capacity' in c.resource,false);
});
