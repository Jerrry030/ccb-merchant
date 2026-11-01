import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,password} from './fixtures.js';
import {custodyProvider} from './custody-fixture.js';
import {accessScopes} from '../../src/access.js';
import {inventoryStatus} from '../../public/inventory-status.js';

test('owned onboarding needs no policy or stock; lost response and restart retain intent without callback secrets',async t=>{
 const provider=custodyProvider(),f=await fixture(t,{inventory:[],onCore:provider.onCore});
 const admin=await f.request('POST','/api/setup',{setup_token:f.setupToken,email:'owner@example.test',display_name:'Owner',password});
 const options=await f.request('GET','/api/admin/account-intake',undefined,admin);assert.equal(options.status,200);assert.equal(options.raw.includes('PRIVATE_PROXY'),false);
 const id=randomUUID(),path='/api/admin/account-authorizations/'+id,body={name:'Own X',environment_id:options.data.environments[0].id,platform:'Windows/x64'};
 provider.loseResponse=true;assert.equal((await f.request('PUT',path,body,admin)).status,503);assert.equal(provider.operations.size,1);
 await f.restart();assert.equal((await f.request('PUT',path,body,admin)).status,200);assert.equal(provider.operations.size,1);
 assert.equal((await f.request('PUT',path,{...body,name:'different'},admin)).status,409);
 const callback_url='http://localhost/callback?code=TRANSIENT_CODE&state=fixture-state';
 const completed=await f.request('POST',path+'/complete',{callback_url},admin);assert.equal(completed.status,202,completed.raw);
 const saved=f.store.db.prepare('SELECT * FROM custody_operations').all();assert.doesNotMatch(JSON.stringify(saved),/TRANSIENT_CODE|fixture-state|auth_url|callback_url/);
 const list=await f.request('GET','/api/admin/managed-accounts',undefined,admin);assert.equal(list.data.accounts.length,1);
 const account=list.data.accounts[0],paused=await f.request('PATCH','/api/admin/managed-accounts/'+account.id,{expected_revision:account.revision,status:'paused'},admin);assert.equal(paused.status,200,paused.raw);
 const closed=await f.request('DELETE','/api/admin/managed-accounts/'+account.id,{expected_revision:paused.data.account.revision},admin);assert.equal(closed.status,200,closed.raw);
 assert.equal((await f.request('GET','/api/admin/custody-policy',undefined,admin)).status,404);
});

test('origin is scoped to authenticated peer and scopes; upper ordinary listing and sibling origins cannot claim account',async t=>{
 const provider=custodyProvider(),f=await fixture(t,{onCore:provider.onCore});
 const admin=await f.request('POST','/api/setup',{setup_token:f.setupToken,email:'owner@example.test',display_name:'Owner',password});
 const peers=[];
 for(const slug of ['peer-a','peer-b']){const a=await f.request('POST','/api/admin/access-accounts',{slug,name:slug},admin);const key=await f.request('POST',`/api/admin/access-accounts/${a.data.account.id}/keys`,{name:'service',scopes:accessScopes},admin);peers.push({native:true,headers:{Authorization:'Bearer '+key.data.token,'X-CCB-Origin':'leaf-c'}});}
 const opts=await f.request('GET','/access/v1/account-intake',undefined,peers[0]);const op=randomUUID(),path='/access/v1/account-authorizations/'+op;
 const started=await f.request('PUT',path,{name:'C X',environment_id:opts.data.environments[0].id,platform:'Windows/x64'},peers[0]);assert.equal(started.status,200,started.raw);
 assert.equal((await f.request('GET',path,undefined,peers[1])).status,404);
 const cousin={...peers[0],headers:{...peers[0].headers,'X-CCB-Origin':'leaf-d'}};assert.equal((await f.request('GET',path,undefined,cousin)).status,404);
 const complete=await f.request('POST',path+'/complete',{callback_url:'http://localhost/callback?state=fixture-state&code=fixture'},peers[0]);assert.equal(complete.status,202,complete.raw);
 const id=complete.data.authorization.account_id;assert.equal((await f.request('GET','/access/v1/managed-accounts/'+id,undefined,peers[1])).status,404);
 assert.deepEqual((await f.request('GET','/api/admin/managed-accounts',undefined,admin)).data.accounts,[]);
 assert.equal((await f.request('GET','/access/v1/account-intake',undefined,{...peers[0],headers:{...peers[0].headers,'X-CCB-Access-Hops':'0'}})).status,503);
});

test('only explicit owned provenance treats null holding date as unbounded; customer date is still required',()=>{
 const base={status:'active',expires_at:null,assigned:false,allow_delegation:true,details:{state:'available'}};
 assert.equal(inventoryStatus(base).assignable,false);assert.equal(inventoryStatus({...base,source:'supplied'}).assignable,false);
 assert.equal(inventoryStatus({...base,source:'owned'}).assignable,true);assert.equal(inventoryStatus({...base,source:'owned',expires_at:'invalid'}).assignable,false);
});
