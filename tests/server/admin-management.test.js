import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,password } from './fixtures.js';
import { inventoryStatus } from '../../public/inventory-status.js';
const adminInput={email:'admin@example.test',display_name:'Owner',password};

test('local account numbers are persistent per lease, never provider names; grant views share the number',async t=>{
 const f=await fixture(t),admin=await f.request('POST','/api/setup',{...adminInput,setup_token:f.setupToken});
 const before=await f.request('GET','/api/admin/inventory',null,admin);
 assert.equal(before.data.accounts[0].account_code,'账号#1');assert.equal(before.data.accounts[0].details.name,'账号#1');assert.equal(before.raw.includes('Account 1'),false);assert.equal(before.data.accounts[0].resource_name,'Code resource');
 const codes=new Map(before.data.accounts.map(a=>[a.id,a.account_code]));
 f.state.inventory.reverse();f.state.inventory.forEach(a=>a.details.name='Different public resource');
 const after=await f.request('GET','/api/admin/inventory',null,admin);for(const a of after.data.accounts)assert.equal(a.account_code,codes.get(a.id));
 const projected=f.store.labelAccounts([{id:'grant-a',account_lease_id:'owned-1',name:'Provider display'}]);assert.equal(projected[0].name,'账号#1');
 await f.restart();const reopened=await f.request('GET','/api/admin/inventory',null,admin);assert.equal(reopened.data.accounts.find(a=>a.id==='owned-1').account_code,'账号#1');
 assert.equal(f.store.labelAccounts([{id:'grant-a',name:'Provider display'}])[0].name,'账号#1');
 assert.equal(f.store.labelAccounts([{id:'unknown-grant',name:'Never expose a private name'}])[0].name,'账号（编号待核对）');
});

test('non-delegable allocations fail closed, no customer is provisioned and unknown permissions are not assignable',async t=>{
 const f=await fixture(t),admin=await f.request('POST','/api/setup',{...adminInput,setup_token:f.setupToken});
 const member=await f.request('POST','/api/admin/users',{email:'buyer@example.test',display_name:'Buyer',password,role:'member'},admin);
 f.state.inventory[0].allow_delegation=false;
 const response=await f.request('POST','/api/admin/grants',{user_id:member.data.user.id,resource_id:'resource-1',account_lease_id:'owned-1',expected_account_revision:1},admin);
 assert.equal(response.status,409);assert.equal(response.data.error.code,'delegation_forbidden');assert.equal(f.state.customers.length,0);
 assert.equal(inventoryStatus(f.state.inventory[0]).assignable,false);
 assert.equal(inventoryStatus({...f.state.inventory[1],allow_delegation:undefined}).assignable,false);
 assert.equal(inventoryStatus({...f.state.inventory[1],hold_reason:'purchase_pending'}).assignable,false);
});

test('staff reset requires password and revision, revokes sessions, gates temporary login and keeps secrets out of audit',async t=>{
 const f=await fixture(t),admin=await f.request('POST','/api/setup',{...adminInput,setup_token:f.setupToken});
 const member=await f.request('POST','/api/admin/users',{email:'buyer@example.test',display_name:'Buyer',password,role:'member'},admin),id=member.data.user.id;
 const old=await f.request('POST','/api/auth/login',{email:'buyer@example.test',password});
 const body={action:'reset_password',admin_password:password,expected_revision:1,new_password:'Temporary-test-password-984',reason:'Support verification complete'};
 assert.equal((await f.request('POST',`/api/admin/users/${id}/credentials`,{...body,admin_password:'wrong'},admin)).status,403);
 const reset=await f.request('POST',`/api/admin/users/${id}/credentials`,body,admin);assert.equal(reset.status,200,reset.raw);assert.equal(reset.data.user.must_change_password,true);
 assert.equal((await f.request('GET','/api/auth/session',null,old)).status,401);
 const temporary=await f.request('POST','/api/auth/login',{email:'buyer@example.test',password:body.new_password});assert.equal(temporary.status,200);assert.equal(temporary.data.user.must_change_password,true);
 assert.equal((await f.request('GET','/api/me/accounts',null,temporary)).data.error.code,'password_change_required');
 assert.equal((await f.request('PATCH','/api/auth/password',{current_password:body.new_password,new_password:body.new_password},temporary)).status,400);
 assert.equal((await f.request('PATCH','/api/auth/password',{current_password:body.new_password,new_password:'A-brand-new-test-password'},temporary)).status,200);
 const logged=await f.request('POST','/api/auth/login',{email:'buyer@example.test',password:'A-brand-new-test-password'});assert.equal(logged.data.user.must_change_password,false);
 const audit=JSON.stringify(f.store.db.prepare('SELECT * FROM audit').all());assert.equal(audit.includes(body.new_password),false);assert.equal(audit.includes(password),false);assert.ok(audit.includes('user.password_reset'));
 assert.equal((await f.request('POST',`/api/admin/users/${id}/credentials`,body,admin)).status,409);
});

test('customer revisions reject stale editors and notes stay out of member sessions and Core',async t=>{
 const f=await fixture(t),admin=await f.request('POST','/api/setup',{...adminInput,setup_token:f.setupToken});
 const member=await f.request('POST','/api/admin/users',{email:'buyer@example.test',display_name:'Buyer',password,role:'member'},admin),id=member.data.user.id;
 const change=await f.request('PATCH',`/api/admin/users/${id}`,{expected_revision:1,display_name:'Updated',notes:'Private service note',tags:['priority']},admin);assert.equal(change.status,200,change.raw);assert.equal(change.data.user.revision,2);
 assert.equal((await f.request('PATCH',`/api/admin/users/${id}`,{expected_revision:1,display_name:'Stale'},admin)).status,409);
 assert.equal((await f.request('PATCH',`/api/admin/users/${id}`,{display_name:'Unversioned'},admin)).status,409);
 const logged=await f.request('POST','/api/auth/login',{email:'buyer@example.test',password});assert.equal(Object.hasOwn(logged.data.user,'notes'),false);assert.equal(Object.hasOwn(logged.data.user,'tags'),false);
 const filtered=await f.request('GET','/api/admin/users?tag=priority&status=active&role=member',null,admin);assert.equal(filtered.data.users.length,1);
 assert.equal(JSON.stringify(f.state.requests).includes('Private service note'),false);
 const event=f.store.db.prepare("SELECT details FROM audit WHERE action='user.update' ORDER BY id DESC LIMIT 1").get();assert.equal(JSON.parse(event.details).before.display_name,'Buyer');
});

test('email correction without verification requires administrator confirmation and invalidates the old session',async t=>{
 const f=await fixture(t),admin=await f.request('POST','/api/setup',{...adminInput,setup_token:f.setupToken});
 const member=await f.request('POST','/api/admin/users',{email:'buyer@example.test',display_name:'Buyer',password,role:'member'},admin),id=member.data.user.id;
 const old=await f.request('POST','/api/auth/login',{email:'buyer@example.test',password});
 const changed=await f.request('PATCH',`/api/admin/users/${id}`,{expected_revision:1,email:'corrected@example.test',admin_password:password,reason:'Verified correction'},admin);assert.equal(changed.status,200,changed.raw);
 assert.equal((await f.request('GET','/api/auth/session',null,old)).status,401);assert.equal((await f.request('POST','/api/auth/login',{email:'corrected@example.test',password})).status,200);
});

test('restricted management profiles cannot escalate or use settings; last owner remains protected',async t=>{
 const f=await fixture(t),admin=await f.request('POST','/api/setup',{...adminInput,setup_token:f.setupToken});
 const staff=await f.request('POST','/api/admin/users',{email:'support@example.test',display_name:'Support',password,role:'admin',management_profile:'support'},admin);
 const login=await f.request('POST','/api/auth/login',{email:'support@example.test',password});
 assert.equal((await f.request('GET','/api/admin/users',null,login)).status,200);
 assert.equal((await f.request('GET','/api/admin/settings',null,login)).status,403);
 assert.equal((await f.request('POST','/api/admin/grants',{},login)).status,403);
 assert.equal((await f.request('PATCH',`/api/admin/users/${staff.data.user.id}`,{expected_revision:1,management_profile:'owner'},login)).status,403);
 assert.equal((await f.request('POST','/api/admin/users',{email:'escalated@example.test',display_name:'E',password,role:'admin'},login)).status,403);
 assert.equal((await f.request('PATCH',`/api/admin/users/${admin.data.user.id}`,{expected_revision:1,management_profile:'observer'},admin)).data.error.code,'last_admin');
 assert.throws(()=>f.store.db.prepare("UPDATE users SET management_profile='support' WHERE id=?").run(admin.data.user.id),/last_admin/);
});

test('durable batches preflight without mutation, reserve unknown items, resume pending items and never replay completed grants',async t=>{
 let drop=true;const f=await fixture(t,{afterGrant:({res})=>{if(drop){drop=false;res.destroy();return true;}}}),admin=await f.request('POST','/api/setup',{...adminInput,setup_token:f.setupToken});
 const member=await f.request('POST','/api/admin/users',{email:'buyer@example.test',display_name:'Buyer',password,role:'member'},admin);
 const items=f.state.inventory.slice(0,2).map(a=>({user_id:member.data.user.id,resource_id:a.resource_id,account_lease_id:a.id,expected_account_revision:1,expires_at:new Date(Date.now()+30*86400000).toISOString()}));
 const id='batch-durable-test-1234';let r=await f.request('POST','/api/admin/allocation-batches',{id,action:'preview',items},admin);assert.equal(r.status,200,r.raw);assert.equal(r.data.batch.ready,true);assert.equal(f.state.grants.length,0);
 r=await f.request('POST','/api/admin/allocation-batches',{id,action:'execute',items},admin);assert.equal(r.status,200,r.raw);assert.deepEqual(r.data.batch.items.map(i=>i.status),['review','succeeded']);assert.equal(f.state.grants.length,2);
 assert.equal((await f.request('POST','/api/admin/allocation-batches',{id,action:'execute',items:[{...items[0],expires_at:new Date(Date.now()+86400000).toISOString()}]},admin)).status,409);
 const writes=f.state.requests.filter(r=>r.method==='POST'&&r.path==='/access/v1/grants').length;
 await f.restart();r=await f.request('POST','/api/admin/allocation-batches',{id,action:'reconcile'},admin);assert.equal(r.status,200,r.raw);assert.ok(r.data.batch.items.every(i=>i.status==='succeeded'));
 r=await f.request('POST','/api/admin/allocation-batches',{id,action:'execute'},admin);assert.equal(r.status,200);assert.equal(f.state.requests.filter(r=>r.method==='POST'&&r.path==='/access/v1/grants').length,writes);
});

test('batch failures are per-item and unexecuted cancellation does not revoke a completed allocation',async t=>{
 const f=await fixture(t),admin=await f.request('POST','/api/setup',{...adminInput,setup_token:f.setupToken});
 const member=await f.request('POST','/api/admin/users',{email:'buyer@example.test',display_name:'Buyer',password,role:'member'},admin);
 f.state.inventory[1].allow_delegation=false;
 const items=f.state.inventory.slice(0,2).map(a=>({user_id:member.data.user.id,resource_id:a.resource_id,account_lease_id:a.id,expected_account_revision:1,expires_at:new Date(Date.now()+86400000).toISOString()}));
 const id='batch-partial-test-1234';const result=await f.request('POST','/api/admin/allocation-batches',{id,action:'execute',items},admin);assert.equal(result.status,200,result.raw);assert.deepEqual(result.data.batch.items.map(i=>i.status),['succeeded','failed']);
 const cancelled=await f.request('POST','/api/admin/allocation-batches',{id,action:'cancel'},admin);assert.equal(cancelled.status,200);assert.equal(f.state.grants[0].status,'active');assert.equal(f.state.grants.length,1);
});


test('verified email change retains the old address until the new mailbox confirms and logs no token',async t=>{
 const sent=[];const f=await fixture(t,{env:{SMTP_HOST:'smtp.example.test',SMTP_FROM:'sender@example.test'},mailer:{send:async(...args)=>sent.push(args)}});
 const admin=await f.request('POST','/api/setup',{...adminInput,setup_token:f.setupToken});
 await f.request('PATCH','/api/admin/settings',{email_verification_enabled:true},admin);
 const created=await f.request('POST','/api/admin/users',{email:'before@example.test',display_name:'Mailbox verification',password,role:'member'},admin),id=created.data.user.id;
 const update=await f.request('PATCH',`/api/admin/users/${id}`,{expected_revision:1,email:'after@example.test',reason:'Verified request',admin_password:password},admin);
 assert.equal(update.status,200,update.raw);assert.equal(update.data.user.email,'before@example.test');assert.equal(update.data.user.pending_email,'after@example.test');
 const [destination,kind,token]=sent.at(-1);assert.equal(destination,'after@example.test');assert.equal(kind,'verify');assert.match(token,/^\d{6}$/);
 const result=await f.request('POST','/api/auth/verify',{email:destination,code:token});assert.equal(result.status,200,result.raw);
 assert.equal(f.store.db.prepare('SELECT email,pending_email FROM users WHERE id=?').get(id).email,'after@example.test');
 assert.equal(JSON.stringify(f.store.db.prepare('SELECT * FROM audit').all()).includes(token),false);
 assert.equal((await f.request('POST','/api/auth/verify',{email:destination,code:token})).status,400);
});

test('a saved running batch becomes review on restart and does not release or replay its unknown allocation',async t=>{
 const f=await fixture(t),admin=await f.request('POST','/api/setup',{...adminInput,setup_token:f.setupToken});
 const member=await f.request('POST','/api/admin/users',{email:'buyer@example.test',display_name:'Buyer',password,role:'member'},admin);
 const intent={user_id:member.data.user.id,resource_id:'resource-1',account_lease_id:'owned-1',expected_account_revision:1,expires_at:new Date(Date.now()+86400000).toISOString()},id='batch-interrupted-test-1234',now=new Date().toISOString();
 f.store.db.prepare('INSERT INTO allocation_batches VALUES(?,?,?,?,?,?,?)').run(id,admin.data.user.id,JSON.stringify([intent]),JSON.stringify([{intent,status:'running'}]),'running',now,now);
 await f.restart();const listed=await f.request('GET','/api/admin/inventory',null,admin);assert.equal(listed.data.accounts.find(a=>a.id==='owned-1').hold_reason,'allocation_pending');
 const result=await f.request('POST','/api/admin/allocation-batches',{id,action:'execute'},admin);assert.equal(result.data.batch.items[0].status,'review');assert.equal(f.state.grants.length,0);
 await f.request('POST','/api/admin/allocation-batches',{id,action:'cancel'},admin);assert.equal(f.store.accountHolds().get('owned-1').reason,'allocation_pending');
});


test('revocation after a committed Core write remains unknown until another authorized operator reconciles it',async t=>{
 let ownerID;const f=await fixture(t,{afterGrant:()=>{f.store.db.prepare("UPDATE users SET management_profile='observer',revision=revision+1 WHERE id=?").run(ownerID);return false;}});
 const admin=await f.request('POST','/api/setup',{...adminInput,setup_token:f.setupToken});ownerID=admin.data.user.id;
 await f.request('POST','/api/admin/users',{email:'other-admin@example.test',display_name:'Other owner',password,role:'admin'},admin);
 const other=await f.request('POST','/api/auth/login',{email:'other-admin@example.test',password});
 const member=await f.request('POST','/api/admin/users',{email:'buyer@example.test',display_name:'Buyer',password,role:'member'},admin);
 const id='batch-authority-change-123',items=[{user_id:member.data.user.id,resource_id:'resource-1',account_lease_id:'owned-1',expected_account_revision:1,expires_at:new Date(Date.now()+86400000).toISOString()}];
 const response=await f.request('POST','/api/admin/allocation-batches',{id,action:'execute',items},admin);assert.equal(response.status,503,response.raw);assert.equal(f.state.grants.length,1);
 assert.equal(JSON.parse(f.store.db.prepare('SELECT items FROM allocation_batches WHERE id=?').get(id).items)[0].status,'review');
 const checked=await f.request('POST','/api/admin/allocation-batches',{id,action:'reconcile'},other);assert.equal(checked.status,200,checked.raw);assert.equal(checked.data.batch.items[0].status,'succeeded');assert.equal(f.state.grants.length,1);
});
