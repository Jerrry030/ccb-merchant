import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, password } from './fixtures.js';

test('global devices aggregate only local customer mappings, filter before paging and retain scoped mutation boundaries',async t=>{
 const devices=new Map();
 const f=await fixture(t,{onCore:({req,url,json})=>{
  const match=url.pathname.match(/^\/access\/v1\/customers\/([^/]+)\/devices$/);
  if(req.method==='GET'&&match){json({devices:devices.get(match[1])||[]});return true;}
 }});
 const admin=await f.request('POST','/api/setup',{setup_token:f.setupToken,email:'owner@example.test',password,display_name:'Owner'}),users=[];
 for(const name of ['Alice','Bob']){
  const made=await f.request('POST','/api/admin/users',{email:name.toLowerCase()+'@example.test',password,display_name:name,role:'member'},admin);assert.equal(made.status,201,made.raw);
  const provisioned=await f.request('POST','/api/admin/users/'+made.data.user.id+'/provision',{},admin);assert.equal(provisioned.status,200,provisioned.raw);
  users.push({...made.data.user,core_id:provisioned.data.customer.id});
 }
 const end=new Date(Date.now()+86400000).toISOString();
 devices.set(users[0].core_id,[{id:'same-id',name:'Office laptop',state:'approved',expires_at:end,token:'LEAK'},{id:'old-a',name:'Old laptop',state:'approved',expires_at:'2000-01-01T00:00:00Z'}]);
 devices.set(users[1].core_id,[{id:'same-id',name:'Other laptop',state:'revoked',expires_at:end,account_name:'LEAK'},{id:'pending-b',name:'Tablet',state:'pending',expires_at:end}]);
 devices.set('unmapped-customer',[{id:'foreign',name:'NOT_LOCAL',state:'approved'}]);
 const member=await f.request('POST','/api/auth/login',{email:users[0].email,password});
 assert.equal((await f.request('GET','/api/admin/devices',undefined,member)).status,403);
 const all=await f.request('GET','/api/admin/devices?limit=2',undefined,admin);assert.equal(all.status,200,all.raw);assert.equal(all.data.total,4);assert.equal(all.data.incomplete,false);assert.equal(all.data.devices.length,2);assert.equal(all.raw.includes('LEAK'),false);assert.equal(all.raw.includes('NOT_LOCAL'),false);
 const second=await f.request('GET','/api/admin/devices?limit=2&offset=2',undefined,admin);assert.equal(second.status,200,second.raw);
 const rows=[...all.data.devices,...second.data.devices];assert.equal(new Set(rows.map(d=>d.user_id+':'+d.id)).size,4);assert.equal(rows.filter(d=>d.id==='same-id').length,2);
 assert.ok(rows.every(d=>users.some(u=>u.id===d.user_id&&u.display_name===d.customer_name&&u.email===d.customer_email)));assert.equal('accounts' in all.data,false);
 for(const [query,count] of [['q=Alice',2],['q=BOB%40EXAMPLE.TEST',2],['q=Office',1],['status=approved',1],['status=expired',1],['status=revoked',1],['status=pending',1],['q=Alice&status=revoked',0]]){
  const result=await f.request('GET','/api/admin/devices?'+query+'&limit=1',undefined,admin);assert.equal(result.status,200,result.raw);assert.equal(result.data.total,count,query);assert.ok(result.data.devices.length<=1);
 }
 for(const query of ['status=online','limit=0','offset=-1','q=x&q=y','core_customer_id=unmapped-customer'])assert.equal((await f.request('GET','/api/admin/devices?'+query,undefined,admin)).status,400,query);
 assert.equal((await f.request('DELETE','/api/admin/devices/same-id',{},admin)).status,404,'global reads do not add an unscoped write endpoint');
 assert.ok(f.state.requests.filter(r=>r.path.endsWith('/devices')).every(r=>users.some(u=>r.path.includes(u.core_id))),'only locally mapped customer devices were requested');
 const own=await f.request('GET','/api/me/devices',undefined,member);assert.equal(own.data.devices.length,2);assert.ok(own.data.devices.every(d=>!('customer_email' in d)));
});

test('partial global device failures are explicit and a lost administrator session never returns device data',async t=>{
 let fail=false,pause=false,release,arrive;const gate=new Promise(r=>release=r),entered=new Promise(r=>arrive=r);
 const f=await fixture(t,{onCore:async({req,url,json})=>{
  if(req.method==='GET'&&url.pathname.endsWith('/devices')){
   if(pause){arrive();await gate;}
   if(fail&&url.pathname.includes('customer-b')){json({code:'unavailable'},503);return true;}
   json({devices:[{id:'dev-'+url.pathname.split('/')[4],name:'Laptop',state:'approved'}]});return true;
  }
 }});
 const admin=await f.request('POST','/api/setup',{setup_token:f.setupToken,email:'owner@example.test',password,display_name:'Owner'});
 const hash=f.store.db.prepare('SELECT password_hash FROM users WHERE id=?').get(admin.data.user.id).password_hash;
 for(const [id,name,pending] of [['customer-a','A',null],['customer-b','B',null],['customer-c','C','{}']]){
  const u=f.store.createUser({email:name+'@example.test',display_name:name,password_hash:hash,role:'member',status:'active'});f.store.db.prepare('UPDATE users SET core_customer_id=?,core_pending=? WHERE id=?').run(id,pending,u.id);
 }
 fail=true;const partial=await f.request('GET','/api/admin/devices',undefined,admin);assert.equal(partial.status,200,partial.raw);assert.equal(partial.data.incomplete,true);assert.equal(partial.data.total,null);assert.equal(partial.data.matched_total,1);assert.equal(partial.data.unavailable_customers.length,2);assert.deepEqual(partial.data.unavailable_customers.map(c=>c.customer_name).sort(),['B','C']);
 assert.equal(f.state.requests.some(r=>r.path.includes('customer-c/')),false,'pending customer mappings are not queried');
 fail=false;pause=true;const pending=f.request('GET','/api/admin/devices',undefined,admin);await Promise.race([entered,pending.then(r=>{throw new Error('expected delayed read, received '+r.status);})]);
 try{f.store.db.prepare('DELETE FROM sessions').run();}finally{release();}
 const denied=await pending;assert.equal(denied.status,401,denied.raw);assert.equal('devices' in denied.data,false);
});

test('global device readers are bounded, do not truncate customer failures and keep read-only staff read-only',async t=>{
 let inFlight=0,maxInFlight=0;
 const f=await fixture(t,{onCore:async({req,url,json})=>{
  if(req.method==='GET'&&url.pathname.endsWith('/devices')){
   inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);await new Promise(resolve=>setTimeout(resolve,5));inFlight--;
   json({devices:[{id:'device',name:'Laptop',state:'approved'}]});return true;
  }
 }});
 const admin=await f.request('POST','/api/setup',{setup_token:f.setupToken,email:'owner@example.test',password,display_name:'Owner'});
 const observer=await f.request('POST','/api/admin/users',{email:'observer@example.test',password,display_name:'Observer',role:'admin',management_profile:'observer'},admin);assert.equal(observer.status,201,observer.raw);
 const session=await f.request('POST','/api/auth/login',{email:'observer@example.test',password});
 const hash=f.store.db.prepare('SELECT password_hash FROM users WHERE id=?').get(admin.data.user.id).password_hash;
 const users=[];
 for(let i=0;i<9;i++){const u=f.store.createUser({email:'batch-'+i+'@example.test',display_name:'Customer '+i,password_hash:hash,role:'member',status:'active'});f.store.db.prepare('UPDATE users SET core_customer_id=? WHERE id=?').run('mapped-'+i,u.id);users.push(u);}
 const list=await f.request('GET','/api/admin/devices?limit=3&offset=6',undefined,session);assert.equal(list.status,200,list.raw);assert.equal(list.data.total,9);assert.equal(list.data.devices.length,3);assert.ok(maxInFlight<=4);assert.ok(maxInFlight>1);
 for(const [method,suffix,body] of [['PATCH','',{name:'Denied',expected_name:'Laptop'}],['PUT','/selection',{surface:'code',grant_id:null,expected_selection_version:0}],['DELETE','',{}]]){
  assert.equal((await f.request(method,'/api/admin/users/'+users[0].id+'/devices/device'+suffix,body,session)).status,403);
 }
 assert.equal(f.state.requests.some(r=>r.method!=='GET'&&r.path.includes('/devices')),false);
 for(let i=9;i<501;i++){const u=f.store.createUser({email:'batch-'+i+'@example.test',display_name:'Customer '+i,password_hash:hash,role:'member',status:'active'});f.store.db.prepare('UPDATE users SET core_customer_id=? WHERE id=?').run('mapped-'+i,u.id);}
 const before=f.state.requests.length,overflow=await f.request('GET','/api/admin/devices',undefined,admin);assert.equal(overflow.status,503,overflow.raw);assert.equal(overflow.data.error.code,'device_read_limit');assert.equal(f.state.requests.length,before,'capacity failure must happen before starting a partial scan');
 const scoped=await f.request('GET','/api/admin/users/'+users[0].id+'/devices',undefined,session);assert.equal(scoped.status,200,scoped.raw);assert.equal(scoped.data.devices.length,1);
});

test('global scans complete upstream pages and reject aggregate overflow instead of claiming a complete first page',async t=>{
 let count=2;
 const f=await fixture(t,{onCore:({req,url,json})=>{
  if(req.method!=='GET'||!url.pathname.endsWith('/devices'))return false;
  const start=Number(url.searchParams.get('cursor')||0),end=Math.min(count,start+500);
  json({devices:Array.from({length:end-start},(_,i)=>({id:'device-'+(start+i),name:'Laptop '+(start+i),state:'approved'})),next_cursor:end<count?String(end):''});return true;
 }});
 const admin=await f.request('POST','/api/setup',{setup_token:f.setupToken,email:'owner@example.test',password,display_name:'Owner'}),hash=f.store.db.prepare('SELECT password_hash FROM users WHERE id=?').get(admin.data.user.id).password_hash;
 const users=[];for(let i=0;i<2;i++){const u=f.store.createUser({email:'many-'+i+'@example.test',display_name:'Many '+i,password_hash:hash,role:'member',status:'active'});f.store.db.prepare('UPDATE users SET core_customer_id=? WHERE id=?').run('many-'+i,u.id);users.push(u);}
 count=501;const paged=await f.request('GET','/api/admin/devices?limit=1&offset=1001',undefined,admin);assert.equal(paged.status,200,paged.raw);assert.equal(paged.data.total,1002);assert.equal(paged.data.devices.length,1);assert.ok(f.state.requests.some(r=>r.path.includes('cursor=500')));
 count=5001;const overflow=await f.request('GET','/api/admin/devices',undefined,admin);assert.equal(overflow.status,503,overflow.raw);assert.equal(overflow.data.error.code,'device_read_limit');assert.equal('devices' in overflow.data,false);
});

test('a global deadline cancels slow upstream reads and reports unobserved customers instead of empty success',async t=>{
 let closed=false;
 const f=await fixture(t,{onCore:({req,url,res})=>{
  if(req.method==='GET'&&url.pathname.endsWith('/devices')){res.once('close',()=>closed=true);return true;}
 }});
 const admin=await f.request('POST','/api/setup',{setup_token:f.setupToken,email:'owner@example.test',password,display_name:'Owner'});
 const provisioned=await f.request('POST','/api/admin/users/'+admin.data.user.id+'/provision',{},admin);assert.equal(provisioned.status,200,provisioned.raw);
 const timeout=AbortSignal.timeout.bind(AbortSignal);t.mock.method(AbortSignal,'timeout',milliseconds=>timeout(milliseconds===15000?200:milliseconds));
 const response=await f.request('GET','/api/admin/devices',undefined,admin);assert.equal(response.status,200,response.raw);assert.equal(response.data.incomplete,true);assert.equal(response.data.total,null);assert.equal(response.data.unavailable_customers.length,1);assert.deepEqual(response.data.devices,[]);
 await new Promise(resolve=>setTimeout(resolve,20));assert.equal(closed,true,'the global deadline aborts the unfinished upstream HTTP request');
});
