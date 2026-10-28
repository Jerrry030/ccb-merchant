import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,password} from './fixtures.js';

test('staff and self-service device mutations preserve customer scope, versions, audit and unknown outcomes',async t=>{
 let lose=false;const devices=new Map();
 const f=await fixture(t,{onCore:({req,url,body,json,res})=>{
  const m=url.pathname.match(/^\/access\/v1\/customers\/([^/]+)\/devices(?:\/([^/]+)(\/selection)?)?$/);if(!m)return false;
  if(['preview','approve'].includes(m[2]))return false;
  let d=devices.get(m[1]);if(!d){d={id:'device-'+m[1],name:'Laptop',platform:'Windows/x64',state:'approved',selection_version:0,current_grant_id:null,expires_at:new Date(Date.now()+86400000).toISOString()};devices.set(m[1],d);}
  if(req.method==='GET'&&!m[2]){json({devices:[{...d,token:'LEAK'}]});return true;}
  if(m[2]!==d.id){json({error:{code:'not_found'}},404);return true;}
  if(req.method==='PATCH'){if(body.expected_name!==d.name){json({error:{code:'device_stale'}},409);return true;}d.name=body.name;}
  else if(req.method==='PUT'){if(body.expected_selection_version!==d.selection_version){json({error:{code:'device_stale'}},409);return true;}d.current_grant_id=body.grant_id;d.selection_version++;}
  else if(req.method==='DELETE'){d.state='revoked';json({ok:true});return true;}
  if(lose){lose=false;res.destroy();return true;}json({device:{...d,token:'LEAK'}});return true;
 }});
 const admin=await f.request('POST','/api/setup',{setup_token:f.setupToken,email:'admin@example.test',password,display_name:'Admin'});
 const member=await f.request('POST','/api/admin/users',{email:'device@example.test',password,display_name:'Device owner',role:'member'},admin),id=member.data.user.id;
 await f.request('POST',`/api/admin/users/${id}/provision`,undefined,admin);
 const own=await f.request('POST','/api/auth/login',{email:'device@example.test',password});
 const base=`/api/admin/users/${id}/devices`,listed=await f.request('GET',base,undefined,admin);assert.equal(listed.status,200,listed.raw);assert.equal(listed.raw.includes('LEAK'),false);
 const device=listed.data.devices[0];assert.equal((await f.request('GET',base,undefined,own)).status,403);
 assert.equal((await f.request('PATCH',base+'/'+device.id,{name:'Office',expected_name:'Laptop'},admin)).status,200);
 const stale=await f.request('PATCH','/api/me/devices/'+device.id,{name:'Old',expected_name:'Laptop'},own);assert.equal(stale.status,409);assert.equal(stale.data.error.code,'device_stale');
 const selected=await f.request('PUT','/api/me/devices/'+device.id+'/selection',{surface:'code',grant_id:null,expected_selection_version:0},own);assert.equal(selected.status,200,selected.raw);assert.equal(selected.data.device.state,'approved');assert.equal(selected.data.device.selection_version,1);
 assert.equal((await f.request('PUT','/api/me/devices/'+device.id+'/selection',{surface:'code',grant_id:null,expected_selection_version:0},own)).status,409);
 assert.equal((await f.request('PUT',base+'/'+device.id+'/selection',{surface:'desktop',grant_id:null,expected_selection_version:1},admin)).status,400);
 assert.equal((await f.request('PUT',base+'/'+device.id+'/selection',{surface:'code',expected_selection_version:1},admin)).status,400);
 assert.equal((await f.request('PATCH','/api/me/devices/foreign-device',{name:'Wrong',expected_name:'Laptop'},own)).status,404);
 lose=true;const unknown=await f.request('PATCH',base+'/'+device.id,{name:'Saved despite disconnect',expected_name:'Office'},admin);assert.equal(unknown.status,503);assert.equal(unknown.data.error.code,'core_outcome_unknown');
 assert.equal(f.state.requests.filter(r=>r.method==='PATCH'&&r.body.name==='Saved despite disconnect').length,1);
 assert.equal((await f.request('GET',base,undefined,admin)).data.devices[0].name,'Saved despite disconnect');
 assert.equal((await f.request('DELETE',base+'/'+device.id,undefined,admin)).status,200);
 assert.ok(f.store.db.prepare("SELECT count(*) n FROM audit WHERE action LIKE 'device.%'").get().n>=3);
});

test('permission loss during provider preflight cannot send a device mutation',async t=>{
 let pause=false,arrive,release;const entered=new Promise(r=>arrive=r),gate=new Promise(r=>release=r);
 const f=await fixture(t,{onCore:async({url})=>{if(pause&&url.pathname==='/access/v1/me'){arrive();await gate;}}});
 const admin=await f.request('POST','/api/setup',{setup_token:f.setupToken,email:'admin@example.test',password,display_name:'Admin'});
 const member=await f.request('POST','/api/admin/users',{email:'owner@example.test',password,display_name:'Owner',role:'member'},admin),id=member.data.user.id;
 await f.request('POST',`/api/admin/users/${id}/provision`,undefined,admin);await f.request('POST','/api/admin/users',{email:'second-admin@example.test',password,display_name:'Second admin',role:'admin'},admin);await f.restart();pause=true;
 const pending=f.request('PATCH',`/api/admin/users/${id}/devices/device-1`,{name:'Denied',expected_name:'Laptop'},admin);await Promise.race([entered,pending.then(r=>{throw new Error('Expected blocked preflight, received '+r.status);})]);
 try{f.store.db.prepare("UPDATE users SET role='member' WHERE id=?").run(admin.data.user.id);}finally{release();}const answer=await pending;
 assert.ok([401,403].includes(answer.status),answer.raw);assert.equal(f.state.requests.some(r=>r.method==='PATCH'&&r.path.includes('/devices/')),false);
});

test('usage device/model/result filters and aggregate metadata survive the public projection',async t=>{
 const f=await fixture(t,{onCore:({url,json})=>{if(!url.pathname.endsWith('/usage'))return false;json({usage:{requests:50},requests:[{id:'123',device_id:'device-1',model:'test',session_id:'s-1',body:'LEAK'}],sessions:[{session_id:'s-1',requests:50,errors:1,headers:'LEAK'}],total:1,timeline:{from:'2026-10-01T00:00:00Z',to:'2026-10-02T00:00:00Z',interval:'day',points:[{time:'2026-10-01T00:00:00Z',requests:50,errors:1,input_tokens:100,unknown_usage:2}]}});return true;}});
 const admin=await f.request('POST','/api/setup',{setup_token:f.setupToken,email:'admin@example.test',password,display_name:'Admin'});await f.request('POST',`/api/admin/users/${admin.data.user.id}/provision`,undefined,admin);
 const result=await f.request('GET','/api/me/usage?device_id=device-1&model=test&result=error&view=sessions',undefined,admin);
 assert.equal(result.status,200,result.raw);assert.equal(result.data.timeline.points[0].requests,50);assert.equal(result.data.sessions[0].session_id,'s-1');assert.equal(result.raw.includes('LEAK'),false);
 assert.equal((await f.request('GET','/api/me/usage?result=bad',undefined,admin)).status,400);
});
