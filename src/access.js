import { randomUUID,randomBytes } from 'node:crypto';
import { HttpError,fields,text,opaqueId,expiry,digest,readBody,respond } from './security.js';
import { project,schemas } from './upstream.js';

export const accessScopes=['resources.read','customers.read','customers.write','delegation.grants.read','delegation.grants.write','delegation.devices.read','delegation.devices.write','delegation.usage.read','runtime'];
const live=end=>!end||Date.parse(end)>Date.now();
function accountView(a){return {id:a.id,slug:a.slug,name:a.name,status:a.status,revision:a.revision,created_at:a.created_at};}
function customerView(c){return {id:c.id,external_id:c.external_id,display_name:c.display_name,status:c.status,revision:c.revision,created_at:c.created_at};}
function keyView(k){return {id:k.id,name:k.name,prefix:k.prefix,scopes:JSON.parse(k.scopes),expires_at:k.expires_at,revoked_at:k.revoked_at,created_at:k.created_at,copyable:!k.revoked_at&&live(k.expires_at)&&typeof k.token==='string'&&k.token.length>0};}

// A provider knows only its directly contracted API accounts. No parent ID,
// ancestor credentials or recursive topology is stored or accepted here.
export class Access {
 constructor(store,upstream){this.store=store;this.db=store.db;this.upstream=upstream;this.busy=false;}
 authenticate(req,scope){
  const runtime=req.url.startsWith('/bridge/');
  const header=runtime?'x-ccb-access-key':'authorization';
  if(req.rawHeaders.filter((v,i)=>i%2===0&&v.toLowerCase()===header).length!==1)throw new HttpError(401,'access_key_required','One credential is required.');
  const token=runtime?req.headers['x-ccb-access-key']:(req.headers.authorization||'').replace(/^Bearer /,'');
  if(typeof token!=='string'||!/^ccbm_[a-f0-9]{64}$/.test(token))throw new HttpError(401,'access_key_required','An API account key is required.');
  const key=this.db.prepare('SELECT * FROM access_keys WHERE token_hash=?').get(digest(token));
  const account=key?this.db.prepare('SELECT * FROM access_accounts WHERE id=?').get(key.account_id):null;
  if(!key||key.revoked_at||!live(key.expires_at)||account?.status!=='active')throw new HttpError(401,'access_key_invalid','Access is disabled or expired.');
  if(scope&&!JSON.parse(key.scopes).includes(scope))throw new HttpError(403,'access_scope','Permission is not granted.');
  return {key,account};
 }
 object(table,id,accountId){
  if(!['access_accounts','access_resources','access_customers','access_grants','access_devices'].includes(table))throw new Error('Invalid local table');
  opaqueId(id);
  const row=table==='access_accounts'?this.db.prepare('SELECT * FROM access_accounts WHERE id=?').get(id):this.db.prepare(`SELECT * FROM ${table} WHERE id=? AND account_id=?`).get(id,accountId);
  if(!row)throw new HttpError(404,'not_found','Object is not owned by this API account.');
  return row;
 }
 async mutate(work){
  if(this.busy)throw new HttpError(409,'access_busy','An API allocation change is in progress. Refresh before retrying.');
  this.busy=true;try{return await work();}finally{this.busy=false;}
 }
 async resources(accountId){
  const account=this.object('access_accounts',accountId),rows=this.db.prepare('SELECT * FROM access_resources WHERE account_id=? ORDER BY id').all(accountId);
  if(!rows.length)return [];
  const data=await this.upstream.request('GET','/access/v1/resources');
  if(!Array.isArray(data.resources))throw new HttpError(503,'invalid_core_response','Supply inventory is unavailable.');
  return rows.map(r=>{
   const source=data.resources.find(v=>v.id===r.upstream_id),ends=[r.expires_at,source?.expires_at].filter(Boolean).map(Date.parse);
   const end=ends.length?new Date(Math.min(...ends)).toISOString():null;
   return {id:r.id,name:r.name,status:r.status,surfaces:['code'],expires_at:end,revision:r.revision,available:account.status==='active'&&r.status==='active'&&source?.status==='active'&&source.available!==false&&live(end)};
  });
 }
 grantView(g){
  const r=this.object('access_resources',g.resource_id,g.account_id),ends=[g.expires_at,r.expires_at].filter(Boolean).map(Date.parse);
  return {id:g.id,customer_id:g.customer_id,resource_id:g.resource_id,name:r.name,status:g.status,surfaces:['code'],expires_at:ends.length?new Date(Math.min(...ends)).toISOString():null,revision:g.revision,updated_at:g.updated_at,pending:Boolean(g.pending)};
 }
 async syncCustomer(row,check){
  const list=await this.upstream.request('GET',`/access/v1/customers?external_id=${encodeURIComponent(row.upstream_external)}`);check();
  if(!Array.isArray(list.customers))throw new HttpError(503,'invalid_core_response','Customer list unavailable.');
  let remote=list.customers.find(c=>c.external_id===row.upstream_external);
  if(row.upstream_id&&remote?.id!==row.upstream_id)throw new HttpError(409,'mapping_conflict','Existing customer mapping changed.');
  if(!remote){const result=await this.upstream.request('POST','/access/v1/customers',{external_id:row.upstream_external,display_name:'API customer'});check();remote=result.customer;}
  if(!remote?.id||remote.external_id!==row.upstream_external||remote.display_name!=='API customer')throw new HttpError(409,'mapping_conflict','Customer creation remains unconfirmed.');
  if(remote.status!==row.status){const result=await this.upstream.request('PATCH',`/access/v1/customers/${opaqueId(remote.id)}`,{expected_revision:remote.revision,status:row.status});check();remote=result.customer;}
  if(remote?.external_id!==row.upstream_external||remote.status!==row.status)throw new HttpError(503,'core_outcome_unknown','Customer update remains unconfirmed.');
  this.db.prepare('UPDATE access_customers SET upstream_id=?,pending=0 WHERE id=?').run(remote.id,row.id);
  return this.object('access_customers',row.id,row.account_id);
 }
 async customers(account,method,id,body,query,check){
  if(method==='GET'){
   const limit=Number(query.get('limit')||100),offset=Number(query.get('offset')||0),external=query.get('external_id')||'';
   if(!Number.isSafeInteger(limit)||limit<1||limit>500||!Number.isSafeInteger(offset)||offset<0)throw new HttpError(400,'invalid_page','Invalid pagination.');
   const total=this.db.prepare("SELECT count(*) AS n FROM access_customers WHERE account_id=? AND(?='' OR external_id=?)").get(account.id,external,external).n;
   return {customers:this.db.prepare("SELECT * FROM access_customers WHERE account_id=? AND(?='' OR external_id=?) ORDER BY created_at,id LIMIT ? OFFSET ?").all(account.id,external,external,limit,offset).map(customerView),total,limit,offset};
  }
  return await this.mutate(async()=>{
   let row;
   if(method==='POST'){
    fields(body,['external_id','display_name'],['external_id','display_name']);const external=text(body.external_id,'external_id',150),name=text(body.display_name,'display_name',100);
    row=this.db.prepare('SELECT * FROM access_customers WHERE account_id=? AND external_id=?').get(account.id,external);
    if(row){if(row.display_name!==name)throw new HttpError(409,'customer_conflict','Customer already exists with different content.');}
    else{
     const uuid=randomUUID();this.db.prepare("INSERT INTO access_customers(id,account_id,external_id,display_name,status,upstream_external,created_at) VALUES(?,?,?,?,'active',?,?)").run(uuid,account.id,external,name,randomUUID(),new Date().toISOString());row=this.object('access_customers',uuid,account.id);}
   }else{
    fields(body,['expected_revision','status','display_name'],['expected_revision']);row=this.object('access_customers',id,account.id);
    if(body.expected_revision!==row.revision||(!body.status&&!body.display_name)||body.status&&!['active','disabled'].includes(body.status))throw new HttpError(409,'customer_conflict','Refresh customer state.');
    const name=body.display_name===undefined?row.display_name:text(body.display_name,'display_name',100),status=body.status||row.status;
    this.db.prepare('UPDATE access_customers SET display_name=?,status=?,pending=1,revision=revision+1 WHERE id=?').run(name,status,row.id);row=this.object('access_customers',row.id,account.id);
   }
   if(row.pending)row=await this.syncCustomer(row,check);
   return {customer:customerView(row)};
  });
 }
 async grants(account,method,id,body,query,check){
  if(method==='GET'){
   const customer=query.get('customer_id'),resource=query.get('resource_id');if(customer)this.object('access_customers',customer,account.id);if(resource)this.object('access_resources',resource,account.id);
   const limit=Number(query.get('limit')||100),offset=Number(query.get('offset')||0);
   if(!Number.isSafeInteger(limit)||limit<1||limit>500||!Number.isSafeInteger(offset)||offset<0)throw new HttpError(400,'invalid_page','Invalid pagination.');
   const where=' WHERE account_id=? AND(? IS NULL OR customer_id=?) AND(? IS NULL OR resource_id=?)';
   const args=[account.id,customer,customer,resource,resource];
   const total=this.db.prepare('SELECT count(*) AS n FROM access_grants'+where).get(...args).n;
   const rows=this.db.prepare('SELECT * FROM access_grants'+where+' ORDER BY id LIMIT ? OFFSET ?').all(...args,limit,offset);
   for(const g of rows){
    if(!g.upstream_id||g.pending)continue;
    const c=this.object('access_customers',g.customer_id,account.id),r=this.object('access_resources',g.resource_id,account.id);
    const remote=await this.upstream.request('GET',`/access/v1/grants?customer_id=${opaqueId(c.upstream_id)}&resource_id=${opaqueId(r.upstream_id)}`);check();
    if(!Array.isArray(remote.grants))throw new HttpError(503,'invalid_core_response','Grant lookup unavailable.');
    const current=remote.grants.find(v=>v.id===g.upstream_id),status=current?.status||'revoked',end=current?current.expires_at:g.expires_at;
    if(!['active','revoked'].includes(status))throw new HttpError(503,'invalid_core_response','Unexpected grant state.');
    if(status!==g.status||(end!==g.expires_at&&Date.parse(end||'')!==Date.parse(g.expires_at||''))){
     this.db.prepare('UPDATE access_grants SET status=?,expires_at=?,revision=revision+1,updated_at=? WHERE id=? AND pending=0 AND revision=?').run(status,end,new Date().toISOString(),g.id,g.revision);
    }
   }
   return {grants:rows.map(g=>this.grantView(this.object('access_grants',g.id,account.id))),total,limit,offset};
  }
  return await this.mutate(async()=>{
   let g,c,r;
   if(method==='POST'){
    fields(body,['customer_id','resource_id','expires_at'],['customer_id','resource_id']);c=this.object('access_customers',body.customer_id,account.id);r=this.object('access_resources',body.resource_id,account.id);
    g=this.db.prepare('SELECT * FROM access_grants WHERE customer_id=? AND resource_id=?').get(c.id,r.id);
    const offered=(await this.resources(account.id)).find(v=>v.id===r.id);check();const end=body.expires_at===undefined?offered.expires_at:expiry(body.expires_at);
    if(!offered.available||c.status!=='active'||c.pending||!live(end)||(offered.expires_at&&(!end||Date.parse(end)>Date.parse(offered.expires_at))))throw new HttpError(409,'supply_unavailable','Customer, resource or term is unavailable.');
    if(g){if(g.status!=='active'||Date.parse(g.expires_at||'')!==Date.parse(end||'')&&g.expires_at!==end)throw new HttpError(409,'grant_conflict','Existing grant differs. Use its revision to update.');}
    else{
     const uuid=randomUUID();this.db.prepare("INSERT INTO access_grants(id,account_id,customer_id,resource_id,status,expires_at,updated_at) VALUES(?,?,?,?,'active',?,?)").run(uuid,account.id,c.id,r.id,end,new Date().toISOString());g=this.object('access_grants',uuid,account.id);
    }
   }else{
    fields(body,['expected_revision','status','expires_at'],['expected_revision']);g=this.object('access_grants',id,account.id);c=this.object('access_customers',g.customer_id,account.id);r=this.object('access_resources',g.resource_id,account.id);
    if(body.expected_revision!==g.revision||body.status&&!['active','revoked'].includes(body.status))throw new HttpError(409,'grant_conflict','Grant changed.');
    const status=body.status||g.status,end=body.expires_at===undefined?g.expires_at:expiry(body.expires_at),offered=(await this.resources(account.id)).find(v=>v.id===r.id);check();
    if(status==='active'&&(!offered.available||c.pending||c.status!=='active'||!live(end)||(offered.expires_at&&(!end||Date.parse(end)>Date.parse(offered.expires_at)))))throw new HttpError(409,'supply_unavailable','Grant cannot be activated.');
    const changed=this.db.prepare('UPDATE access_grants SET status=?,expires_at=?,pending=1,revision=revision+1,updated_at=? WHERE id=? AND revision=?').run(status,end,new Date().toISOString(),g.id,g.revision);
    if(changed.changes!==1)throw new HttpError(409,'grant_conflict','Grant changed during validation; refresh.');g=this.object('access_grants',g.id,account.id);
   }
   if(g.pending)g=await this.syncGrant(g,c,r,check);
   return {grant:this.grantView(g)};
  });
 }
 async syncGrant(g,c,r,check){
  if(!c.upstream_id)throw new HttpError(409,'customer_pending','Customer provisioning is pending.');
  const list=await this.upstream.request('GET',`/access/v1/grants?customer_id=${opaqueId(c.upstream_id)}&resource_id=${opaqueId(r.upstream_id)}`);check();
  let remote=list.grants?.find(v=>v.customer_id===c.upstream_id&&v.resource_id===r.upstream_id);
  if(g.upstream_id&&remote?.id!==g.upstream_id)throw new HttpError(409,'mapping_conflict','Grant mapping changed.');
  const allocation={accountId:g.account_id,resourceId:r.id,authorize:check};
  if(!remote){if(g.status==='revoked'){this.db.prepare('UPDATE access_grants SET pending=0 WHERE id=?').run(g.id);return this.object('access_grants',g.id,g.account_id);}
   const data=await this.upstream.request('POST','/access/v1/grants',{customer_id:c.upstream_id,resource_id:r.upstream_id,expires_at:g.expires_at},undefined,allocation);check();remote=data.grant;
  }else if(remote.status!==g.status||Date.parse(remote.expires_at||'')!==Date.parse(g.expires_at||'')&&remote.expires_at!==g.expires_at){
   const data=await this.upstream.request('PATCH',`/access/v1/grants/${opaqueId(remote.id)}`,{expected_revision:remote.revision,status:g.status,expires_at:g.expires_at},undefined,allocation);check();remote=data.grant;
  }
  if(!remote?.id||remote.customer_id!==c.upstream_id||remote.resource_id!==r.upstream_id||remote.status!==g.status)throw new HttpError(503,'core_outcome_unknown','Grant result is unconfirmed.');
  this.store.transaction(()=>{this.db.prepare('UPDATE access_grants SET upstream_id=?,pending=0 WHERE id=?').run(remote.id,g.id);});
  return this.object('access_grants',g.id,g.account_id);
 }
 async fulfillment(account,orderId,body,check){
  fields(body,['customer_id','resource_id','duration_days','action'],['customer_id','resource_id','duration_days','action']);opaqueId(orderId);
  if(!Number.isInteger(body.duration_days)||body.duration_days<1||body.duration_days>366||!['fulfill','cancel'].includes(body.action))throw new HttpError(400,'invalid_input','Invalid fulfillment.');
  return await this.mutate(async()=>{
   const c=this.object('access_customers',body.customer_id,account.id),r=this.object('access_resources',body.resource_id,account.id);
   let f=this.db.prepare('SELECT * FROM access_fulfillments WHERE account_id=? AND order_id=?').get(account.id,orderId);
   if(f&&(f.customer_id!==c.id||f.resource_id!==r.id||f.duration_days!==body.duration_days))throw new HttpError(409,'fulfillment_conflict','Order is already bound to another intent.');
   if(f?.status!=='pending'&&f)return {fulfillment:this.receiptView(f)};
   if(!c.upstream_id)throw new HttpError(409,'customer_pending','Customer provisioning must complete.');
   let g=this.db.prepare('SELECT * FROM access_grants WHERE customer_id=? AND resource_id=?').get(c.id,r.id);
   if(body.action==='fulfill'){
    const offered=(await this.resources(account.id)).find(v=>v.id===r.id);check();
    if(!offered.available||c.status!=='active'||c.pending||g?.pending)throw new HttpError(409,'supply_unavailable','Customer or grant is not ready.');
    if(!f){
     if(this.db.prepare("SELECT 1 FROM access_fulfillments WHERE customer_id=? AND resource_id=? AND status='pending'").get(c.id,r.id))throw new HttpError(409,'fulfillment_pending','Resolve the earlier order first.');
     const active=g?.status==='active'&&live(g.expires_at),start=active?Date.parse(g.expires_at):Date.now(),end=start+body.duration_days*86400000;
     if(!Number.isFinite(end)||offered.expires_at&&end>Date.parse(offered.expires_at))throw new HttpError(409,'supply_unavailable','Requested term exceeds this resource authorization.');
    }
   }
   if(!f){const uuid=randomUUID();this.db.prepare("INSERT INTO access_fulfillments(id,account_id,order_id,customer_id,resource_id,duration_days,action,status,created_at) VALUES(?,?,?,?,?,?,?,'pending',?)").run(uuid,account.id,orderId,c.id,r.id,body.duration_days,body.action,new Date().toISOString());f=this.db.prepare('SELECT * FROM access_fulfillments WHERE id=?').get(uuid);}
   if(body.action==='cancel')this.db.prepare("UPDATE access_fulfillments SET action='cancel' WHERE id=? AND status='pending'").run(f.id);
   f=this.db.prepare('SELECT * FROM access_fulfillments WHERE id=?').get(f.id);
   const data=await this.upstream.request('PUT',`/access/v1/fulfillments/${f.id}`,{customer_id:c.upstream_id,resource_id:r.upstream_id,duration_days:f.duration_days,action:f.action},undefined,{accountId:account.id,resourceId:r.id,authorize:check});check();
   const v=data.fulfillment;
   if(!v||v.order_id!==f.id||v.customer_id!==c.upstream_id||v.resource_id!==r.upstream_id||v.duration_days!==f.duration_days||!['fulfilled','cancelled'].includes(v.status)||v.status==='fulfilled'&&(!v.grant_id||!Number.isFinite(Date.parse(v.expires_at))))throw new HttpError(503,'core_outcome_unknown','Fulfillment result is unconfirmed.');
   let currentGrant=null;
   if(v.status==='fulfilled'){
    const latest=await this.upstream.request('GET',`/access/v1/grants?customer_id=${opaqueId(c.upstream_id)}&resource_id=${opaqueId(r.upstream_id)}`);check();
    currentGrant=latest.grants?.find(item=>item.id===v.grant_id&&item.customer_id===c.upstream_id&&item.resource_id===r.upstream_id);
    if(!currentGrant||!['active','revoked'].includes(currentGrant.status))throw new HttpError(503,'core_outcome_unknown','Current grant state cannot be reconciled yet.');
   }
   this.store.transaction(()=>{
    if(v.status==='fulfilled'){
     if(g?.upstream_id&&g.upstream_id!==v.grant_id)throw new HttpError(409,'mapping_conflict','Fulfilled grant mapping differs.');
     if(!g){g={id:randomUUID()};this.db.prepare("INSERT INTO access_grants(id,account_id,customer_id,resource_id,upstream_id,status,expires_at,pending,updated_at) VALUES(?,?,?,?,?,?,?,0,?)").run(g.id,account.id,c.id,r.id,v.grant_id,currentGrant.status,currentGrant.expires_at,new Date().toISOString());}
     else this.db.prepare("UPDATE access_grants SET upstream_id=?,status=?,expires_at=?,pending=0,revision=revision+1,updated_at=? WHERE id=?").run(v.grant_id,currentGrant.status,currentGrant.expires_at,new Date().toISOString(),g.id);
    }
    this.db.prepare('UPDATE access_fulfillments SET status=?,grant_id=?,expires_at=? WHERE id=?').run(v.status,v.status==='fulfilled'?g.id:null,v.expires_at||null,f.id);
    
   });
   return {fulfillment:this.receiptView(this.db.prepare('SELECT * FROM access_fulfillments WHERE id=?').get(f.id))};
  });
 }
 receiptView(f){return {order_id:f.order_id,customer_id:f.customer_id,resource_id:f.resource_id,duration_days:f.duration_days,status:f.status,grant_id:f.grant_id,expires_at:f.expires_at,created_at:f.created_at};}
 async devices(account,customerId,method,suffix,body,check){
  const c=this.object('access_customers',customerId,account.id);if(!c.upstream_id)throw new HttpError(409,'customer_pending','Customer is not provisioned.');
  const base=`/access/v1/customers/${opaqueId(c.upstream_id)}`;
  if(method==='GET'){
   if(suffix!=='/devices')throw new HttpError(404,'not_found','Unsupported device read.');
   const data=await this.upstream.request('GET',base+'/devices');check();
   return {devices:(data.devices||[]).flatMap(item=>{const d=this.db.prepare('SELECT * FROM access_devices WHERE upstream_id=? AND account_id=? AND customer_id=?').get(item.id,account.id,c.id);if(!d)return [];const v=project(item,schemas.device);v.id=d.id;v.name=d.name;v.current_grant_id=this.db.prepare('SELECT id FROM access_grants WHERE upstream_id=? AND account_id=?').get(item.current_grant_id||'',account.id)?.id||null;return [v];})};
  }
  if(!(['DELETE','PATCH'].includes(method)&&/^\/devices\/[A-Za-z0-9_-]+$/.test(suffix))&&!(method==='PUT'&&/^\/devices\/[A-Za-z0-9_-]+\/selection$/.test(suffix))&&!(method==='POST'&&['/devices/preview','/devices/approve'].includes(suffix)))throw new HttpError(404,'not_found','Unsupported device operation.');
  return await this.mutate(async()=>{
   if(method==='PATCH'||method==='PUT') {
    const d=this.object('access_devices',suffix.split('/')[2],account.id);
    if(d.customer_id!==c.id||!d.upstream_id||d.disabled||c.pending||c.status!=='active')throw new HttpError(404,'not_found','Device is unavailable.');
    let value;
    if(method==='PATCH') {
     fields(body,['name','expected_name'],['name','expected_name']);
     const name=text(body.name,'name',80);if(body.expected_name!==d.name)throw new HttpError(409,'device_stale','Device name changed.');
     const data=await this.upstream.request('GET',base+'/devices');check();
     value=data.devices?.find(v=>v.id===d.upstream_id);if(!value)throw new HttpError(404,'not_found','Device not found.');
     this.db.prepare('UPDATE access_devices SET name=? WHERE id=?').run(name,d.id);
     d.name=name;
    } else {
     fields(body,['surface','grant_id','expected_selection_version'],['surface','grant_id','expected_selection_version']);
     if(body.surface!=='code'||!Number.isSafeInteger(body.expected_selection_version)||body.expected_selection_version<0)throw new HttpError(400,'invalid_selection','A Code selection and observed version are required.');
     let grant=null;
     if(body.grant_id!==null){const g=this.object('access_grants',body.grant_id,account.id);if(g.customer_id!==c.id||!this.runtimeGrant(g))throw new HttpError(403,'grant_unavailable','Grant is not usable for this customer.');grant=g.upstream_id;}
     const result=await this.upstream.request('PUT',base+'/devices/'+opaqueId(d.upstream_id)+'/selection',{...body,grant_id:grant},undefined,{authorize:check});try{check();}catch{throw new HttpError(503,'core_outcome_unknown','Permission changed after a device write; reconcile with an authorized key.');}value=result.device;
     if(!value||value.id!==d.upstream_id)throw new HttpError(503,'core_outcome_unknown','Device selection unconfirmed.');
    }
    const v=project(value,schemas.device);v.id=d.id;v.name=d.name;v.current_grant_id=this.db.prepare('SELECT id FROM access_grants WHERE upstream_id=? AND account_id=? AND customer_id=?').get(value.current_grant_id||'',account.id,c.id)?.id||null;
    if(Number.isSafeInteger(v.selection_version))this.db.prepare('UPDATE access_devices SET current_grant_id=?,selection_version=? WHERE id=? AND selection_version<=?').run(v.current_grant_id||null,v.selection_version,d.id,v.selection_version);
    return {device:v};
   }
   if(method==='DELETE'){
    fields(body,[]);const d=this.object('access_devices',suffix.split('/').at(-1),account.id);if(d.customer_id!==c.id||!d.upstream_id)throw new HttpError(404,'not_found','Device not found.');
    this.db.prepare('UPDATE access_devices SET disabled=1 WHERE id=?').run(d.id);const result=await this.upstream.request('DELETE',base+'/devices/'+opaqueId(d.upstream_id),undefined,undefined,{authorize:check});try{check();}catch{throw new HttpError(503,'core_outcome_unknown','Permission changed after device revocation; reconcile with an authorized key.');}if(result.ok!==true)throw new HttpError(503,'core_outcome_unknown','Device revocation unconfirmed.');return {ok:true};
   }
   fields(body,['code'],['code']);const code=text(body.code,'code',128).replaceAll('-','').toUpperCase();
   const d=this.db.prepare('SELECT * FROM access_devices WHERE pairing_code=? AND account_id=?').get(code,account.id);
   if(!d||d.customer_id&&d.customer_id!==c.id||c.pending||c.status!=='active')throw new HttpError(404,'not_found','Pairing does not belong to this account/customer.');
   if(suffix.endsWith('/approve'))this.db.prepare('UPDATE access_devices SET customer_id=? WHERE id=?').run(c.id,d.id);
   const result=await this.upstream.request('POST',base+suffix,{code});check();
   if(suffix.endsWith('/preview'))return {device:project(result.device,schemas.preview)};
   if(result.ok!==true)throw new HttpError(503,'core_outcome_unknown','Approval unconfirmed.');return {ok:true};
  });
 }
 async usage(account,customerId,query,check){
  const c=this.object('access_customers',customerId,account.id);if(!c.upstream_id)throw new HttpError(409,'customer_pending','Customer not ready.');
  for(const [key,value] of query)if(!['from','to','limit','offset','device_id','grant_id','model','result','session_id','view'].includes(key)||query.getAll(key).length!==1||value.length>150)throw new HttpError(400,'invalid_query','Unsupported usage filter.');
  const forwarded=new URLSearchParams(query);
  for(const [key,table] of [['device_id','access_devices'],['grant_id','access_grants']]) if(query.has(key)) {
   const object=this.object(table,query.get(key),account.id);if(object.customer_id!==c.id||!object.upstream_id)throw new HttpError(404,'not_found','Filter is outside the customer.');forwarded.set(key,object.upstream_id);
  }
  const data=await this.upstream.request('GET',`/access/v1/customers/${opaqueId(c.upstream_id)}/usage?${forwarded}`);check();
  return {usage:project(data.usage,schemas.usage),total:data.total,timeline:project(data.timeline,schemas.timeline)||null,sessions:project(data.sessions||[],[schemas.session]),requests:(data.requests||[]).map(row=>{
   const v=project(row,schemas.request);
   v.grant_id=this.db.prepare('SELECT id FROM access_grants WHERE upstream_id=? AND account_id=? AND customer_id=?').get(row.grant_id||'',account.id,c.id)?.id||null;
   v.device_id=this.db.prepare('SELECT id FROM access_devices WHERE upstream_id=? AND account_id=? AND customer_id=?').get(row.device_id||'',account.id,c.id)?.id||null;return v;
  })};
 }
 async protocol(req,res,url){
  const path=url.pathname,method=req.method;let match,scope;
  if(path==='/access/v1/me')scope=null;
  else if(path==='/access/v1/resources')scope='resources.read';
  else if(/^\/access\/v1\/customers(?:\/[A-Za-z0-9_-]+)?$/.test(path))scope=method==='GET'?'customers.read':'customers.write';
  else if(/^\/access\/v1\/grants(?:\/[A-Za-z0-9_-]+)?$/.test(path)||path.startsWith('/access/v1/fulfillments/'))scope=method==='GET'?'delegation.grants.read':'delegation.grants.write';
  else if(path.endsWith('/accounts'))scope='delegation.grants.read';
  else if(path.endsWith('/usage'))scope='delegation.usage.read';
  else if(path.includes('/devices'))scope=method==='GET'?'delegation.devices.read':'delegation.devices.write';
  else throw new HttpError(404,'not_found','No local API operation at this path.');
  const allowedQuery=path==='/access/v1/grants'?['customer_id','resource_id','limit','offset']:path==='/access/v1/customers'?['external_id','limit','offset']:path.endsWith('/usage')?['from','to','limit','offset','device_id','grant_id','model','result','session_id','view']:[];
  for(const [name,value] of url.searchParams)if(!allowedQuery.includes(name)||url.searchParams.getAll(name).length!==1||value.length>150)throw new HttpError(400,'invalid_query','Unsupported query.');
  const p=this.authenticate(req,scope),check=()=>this.authenticate(req,scope);
  this.store.throttle(`access:${p.account.id}`,300,60000);
  let body={};if(method!=='GET'&&(Number(req.headers['content-length']||0)>0||req.headers['transfer-encoding']))body=await readBody(req,16384);
  check();
  let result;
  if(path==='/access/v1/me'&&method==='GET')result={protocol_version:5,authority_id:this.upstream.instanceId,user:{...accountView(p.account),can_delegate:true},scopes:JSON.parse(p.key.scopes)};
  else if(path==='/access/v1/resources'&&method==='GET')result={resources:await this.resources(p.account.id)};
  else if((match=path.match(/^\/access\/v1\/customers(?:\/([A-Za-z0-9_-]+))?$/))&&((!match[1]&&['GET','POST'].includes(method))||(match[1]&&method==='PATCH')))result=await this.customers(p.account,method,match[1],body,url.searchParams,check);
  else if((match=path.match(/^\/access\/v1\/grants(?:\/([A-Za-z0-9_-]+))?$/))&&((!match[1]&&['GET','POST'].includes(method))||(match[1]&&method==='PATCH')))result=await this.grants(p.account,method,match[1],body,url.searchParams,check);
  else if((match=path.match(/^\/access\/v1\/fulfillments\/([A-Za-z0-9_-]+)$/))&&method==='PUT')result=await this.fulfillment(p.account,match[1],body,check);
  else if((match=path.match(/^\/access\/v1\/customers\/([A-Za-z0-9_-]+)(\/devices(?:\/[A-Za-z0-9_-]+(?:\/selection)?)?)$/)))result=await this.devices(p.account,match[1],method,match[2],body,check);
  else if((match=path.match(/^\/access\/v1\/customers\/([A-Za-z0-9_-]+)\/accounts$/))&&method==='GET') {
   const customer=this.object('access_customers',match[1],p.account.id);if(!customer.upstream_id||customer.pending)throw new HttpError(409,'customer_pending','Customer not ready.');
   const data=await this.upstream.request('GET',`/access/v1/customers/${opaqueId(customer.upstream_id)}/accounts`);check();
   result={accounts:(data.accounts||[]).flatMap(item=>{const g=this.db.prepare('SELECT * FROM access_grants WHERE upstream_id=? AND account_id=? AND customer_id=?').get(item.id,p.account.id,customer.id);if(!g||!this.runtimeGrant(g))return [];const v=project(item,schemas.account);v.id=g.id;return [v];})};
  }
  else if((match=path.match(/^\/access\/v1\/customers\/([A-Za-z0-9_-]+)\/usage$/))&&method==='GET')result=await this.usage(p.account,match[1],url.searchParams,check);
  else throw new HttpError(404,'not_found','No local API operation.');
  try{check();}catch(error){if(method==='GET')throw error;throw new HttpError(503,'core_outcome_unknown','Permission changed; another valid key must reconcile the outcome.');}
  respond(res,method==='POST'&&['/access/v1/customers','/access/v1/grants'].includes(path)?201:200,result);
 }
 async admin(req,res,url,authorize){
  const actor=authorize().user,method=req.method,path=url.pathname;
  const match=path.match(/^\/api\/admin\/access-accounts(?:\/([A-Za-z0-9_-]+))?(?:\/(resources|keys)(?:\/([A-Za-z0-9_-]+)(?:\/(copy))?)?)?$/);
  if(!match)throw new HttpError(404,'not_found','Unknown API account operation.');
  const [_,id,kind,itemId,action]=match;
  let body={};if(method!=='GET'&&(Number(req.headers['content-length']||0)>0||req.headers['transfer-encoding']))body=await readBody(req,16384);
  const account=id?this.object('access_accounts',id):null;
  if(method==='GET'){
   let data;
   if(!id){
    const limit=Number(url.searchParams.get('limit')||50),offset=Number(url.searchParams.get('offset')||0),q=url.searchParams.get('q')||'';
    if(!Number.isSafeInteger(limit)||limit<1||limit>200||!Number.isSafeInteger(offset)||offset<0||q.length>100)throw new HttpError(400,'invalid_page','Invalid pagination.');
    const needle='%'+q+'%',total=this.db.prepare('SELECT count(*) AS n FROM access_accounts WHERE(name LIKE ? OR slug LIKE ?)').get(needle,needle).n;
    data={accounts:this.db.prepare('SELECT * FROM access_accounts WHERE(name LIKE ? OR slug LIKE ?) ORDER BY created_at DESC,id LIMIT ? OFFSET ?').all(needle,needle,limit,offset).map(accountView),total,limit,offset};
   }
   else if(kind==='resources')data={resources:(await this.resources(id)).map(r=>({...r,upstream_id:this.object('access_resources',r.id,id).upstream_id}))};
   else if(kind==='keys')data={keys:this.db.prepare('SELECT * FROM access_keys WHERE account_id=? ORDER BY created_at DESC LIMIT 100').all(id).map(keyView)};
   else data={account:accountView(account)};
   authorize();respond(res,200,data);return;
  }
  const data=await this.mutate(async()=>{
   authorize();
   let result,subject=id;
   if(!kind){
    if(method==='POST'&&!id){
     fields(body,['slug','name'],['slug','name']);const slug=text(body.slug,'slug',48);if(!/^[a-z0-9][a-z0-9-]{1,47}$/.test(slug))throw new HttpError(400,'invalid_input','Invalid account slug.');
     const name=text(body.name,'name',100);
     const old=this.db.prepare('SELECT * FROM access_accounts WHERE slug=?').get(slug);
     if(old){if(old.name!==name)throw new HttpError(409,'account_conflict','Account already exists with different content.');return {account:accountView(old)};}
     subject=randomUUID();this.db.prepare("INSERT INTO access_accounts VALUES(?,?,?,'active',1,?)").run(subject,slug,name,new Date().toISOString());result={account:accountView(this.object('access_accounts',subject))};
    }else if(method==='PATCH'&&id){
     fields(body,['expected_revision','name','status'],['expected_revision']);
     if(body.expected_revision!==account.revision||body.status&&!['active','disabled'].includes(body.status))throw new HttpError(409,'account_conflict','Refresh the API account.');
     this.db.prepare('UPDATE access_accounts SET name=?,status=?,revision=revision+1 WHERE id=?').run(body.name===undefined?account.name:text(body.name,'name',100),body.status||account.status,id);
     result={account:accountView(this.object('access_accounts',id))};
    }
   }else if(kind==='keys'){
    if(method==='POST'&&!itemId){
     fields(body,['name','scopes','expires_at'],['name','scopes']);
     if(!Array.isArray(body.scopes)||!body.scopes.length||new Set(body.scopes).size!==body.scopes.length||body.scopes.some(s=>!accessScopes.includes(s)))throw new HttpError(400,'invalid_scope','Choose explicit API permissions.');
     const ends=body.expires_at===undefined?null:expiry(body.expires_at);if(!live(ends))throw new HttpError(400,'invalid_expiry','Key expiry must be future.');
     if(this.db.prepare('SELECT count(*) AS n FROM access_keys WHERE account_id=? AND revoked_at IS NULL').get(id).n>=100)throw new HttpError(409,'key_limit','Revoke unused keys first.');
     const token='ccbm_'+randomBytes(32).toString('hex'),keyId=randomUUID();
     this.db.prepare('INSERT INTO access_keys(id,account_id,name,prefix,token_hash,token,scopes,expires_at,revoked_at,created_at) VALUES(?,?,?,?,?,?,?,?,NULL,?)').run(keyId,id,text(body.name,'name',80),token.slice(0,15),digest(token),token,JSON.stringify(body.scopes),ends,new Date().toISOString());
     result={key:keyView(this.db.prepare('SELECT * FROM access_keys WHERE id=?').get(keyId)),token};subject=keyId;
    }else if(method==='POST'&&itemId&&action==='copy'){
     fields(body,[]);
     const row=this.db.prepare('SELECT token,revoked_at,expires_at FROM access_keys WHERE id=? AND account_id=?').get(itemId,id);
     if(!row||row.revoked_at||!live(row.expires_at))throw new HttpError(404,'not_found','Key not owned by this account.');
     if(typeof row.token!=='string'||!row.token)throw new HttpError(404,'not_copyable','This key was created before its text could be shown again.');
     result={token:row.token};subject=itemId;
    }else if(method==='DELETE'&&itemId){fields(body,[]);const changed=this.db.prepare('UPDATE access_keys SET revoked_at=COALESCE(revoked_at,?),token=NULL WHERE id=? AND account_id=?').run(new Date().toISOString(),itemId,id);if(!changed.changes)throw new HttpError(404,'not_found','Key not owned by this account.');result={ok:true};subject=itemId;}
   }else if(kind==='resources'&&['POST','PATCH'].includes(method)){
    fields(body,['upstream_id','name','expires_at','status','expected_revision'],['name',...(method==='POST'?['upstream_id']:['expected_revision'])]);
    const old=itemId?this.object('access_resources',itemId,id):null;
    if(old&&body.expected_revision!==old.revision)throw new HttpError(409,'resource_conflict','Refresh the resource authorization.');
    if(method==='PATCH'&&!old||method==='POST'&&itemId)throw new HttpError(400,'invalid_input','Invalid resource operation.');
    const source=old?.upstream_id||text(body.upstream_id,'upstream_id',150),status=body.status||old?.status||'active';
    if(old&&body.upstream_id&&body.upstream_id!==source||!['active','disabled'].includes(status))throw new HttpError(400,'invalid_input','Invalid status or immutable resource.');
    if(!old&&this.db.prepare('SELECT 1 FROM access_resources WHERE account_id=? AND upstream_id=?').get(id,source))throw new HttpError(409,'resource_conflict','Resource is already authorized; edit it instead.');
    const supply=await this.upstream.request('GET','/access/v1/resources');authorize();
    const sourceRow=supply.resources?.find(r=>r.id===source);if(!sourceRow)throw new HttpError(409,'supply_unavailable','Source resource is unavailable.');
    const ends=body.expires_at===undefined?(old?.expires_at??sourceRow.expires_at):expiry(body.expires_at);
    if(status==='active'&&(sourceRow.status!=='active'||sourceRow.available!==true||!live(ends)||sourceRow.expires_at&&(!ends||Date.parse(ends)>Date.parse(sourceRow.expires_at))))throw new HttpError(409,'supply_unavailable','The source cannot cover this authorization term.');
    subject=old?.id||randomUUID();
    if(old){const updated=this.db.prepare('UPDATE access_resources SET name=?,expires_at=?,status=?,revision=revision+1 WHERE id=? AND revision=?').run(text(body.name,'name',100),ends,status,old.id,body.expected_revision);if(updated.changes!==1)throw new HttpError(409,'resource_conflict','Resource changed; refresh.');}
    else this.db.prepare('INSERT INTO access_resources VALUES(?,?,?,?,?,?,1)').run(subject,id,source,text(body.name,'name',100),status,ends);
    result={resource:{...(await this.resources(id)).find(v=>v.id===subject),upstream_id:source}};
   }
   if(!result)throw new HttpError(404,'not_found','API account operation not found.');
   this.store.audit(actor.id,'access.'+(kind||'account')+'.'+method.toLowerCase(),subject);return result;
  });
  try{authorize();}catch{throw new HttpError(503,'local_outcome_unknown','Administrator permission changed after the local write. Another administrator must inspect the result; no secret is returned.');}
  respond(res,method==='POST'?201:200,data);
 }
 // Device bearer is never exchanged for the provider key. Every boundary binds
 // its digest to one local API account, maps control IDs and enforces local access.
 async prepareRuntime(req,url,raw){
  const peer=req.headers['x-ccb-access-key']!==undefined?this.authenticate(req,'runtime'):null;
  const start=req.method==='POST'&&url.pathname==='/bridge/v1/device/start';
  let body=raw;
  let control;
  if(raw?.length&&['/bridge/v1/device/start','/bridge/v1/device/account'].includes(url.pathname)){try{control=JSON.parse(raw.toString('utf8'));}catch{throw new HttpError(400,'invalid_json','Invalid control message.');}}
  const hash=start?control?.token_hash:digest((req.headers.authorization||'').replace(/^Bearer /i,''));
  if(!/^[a-f0-9]{64}$/.test(hash||''))throw new HttpError(400,'invalid_device','Invalid device digest.');
  const owner=peer?.account.id||'local',binding=this.db.prepare('SELECT owner FROM runtime_owners WHERE token_hash=?').get(hash);
  if(binding&&binding.owner!==owner)throw new HttpError(401,'device_scope','Device belongs to a different local access boundary.');
  if(!binding){if(peer&&!start)throw new HttpError(401,'device_scope','Start this device at its provider first.');this.db.prepare('INSERT OR IGNORE INTO runtime_owners VALUES(?,?)').run(hash,owner);}
  if(!peer)return {body,path:url.pathname,peer:null};
  if(start){
   this.db.prepare("INSERT INTO access_devices(token_hash,account_id,id,name,platform) VALUES(?,?,?,?,?) ON CONFLICT(token_hash) DO NOTHING").run(hash,peer.account.id,randomUUID(),text(control.name,'name',100),text(control.platform,'platform',100));
   body=Buffer.from(JSON.stringify({...control,name:'API device'}));
  }
  let device=this.db.prepare('SELECT * FROM access_devices WHERE token_hash=? AND account_id=?').get(hash,peer.account.id);
  if(!device||device.disabled)throw new HttpError(401,'device_disabled','Device is not available.');
  let path=url.pathname,selected=null;
  if(!['/bridge/v1/device/start','/bridge/v1/device/status','/bridge/v1/device/renew','/bridge/v1/device/pairing','/bridge/v1/device'].includes(path)){
   const customer=device.customer_id?this.object('access_customers',device.customer_id,peer.account.id):null;
   if(!customer||customer.pending||customer.status!=='active')throw new HttpError(403,'customer_unavailable','Device customer is not active.');
  }
  if(path==='/bridge/v1/device/account'){
   selected=this.object('access_grants',control.grant_id,peer.account.id);
   if(selected.customer_id!==device.customer_id||!this.runtimeGrant(selected))throw new HttpError(403,'grant_unavailable','Grant is unavailable.');
   body=Buffer.from(JSON.stringify({grant_id:selected.upstream_id}));
  }
  const refresh=path.match(/^\/bridge\/v1\/accounts\/([A-Za-z0-9_-]+)\/refresh$/);
  if(refresh){selected=this.object('access_grants',refresh[1],peer.account.id);if(selected.customer_id!==device.customer_id||!this.runtimeGrant(selected))throw new HttpError(403,'grant_unavailable','Grant is unavailable.');path=`/bridge/v1/accounts/${opaqueId(selected.upstream_id)}/refresh`;}
  if(['/bridge/v1/messages','/bridge/v1/messages/count_tokens','/bridge/v1/traffic','/bridge/v1/bindings','/bridge/v1/models'].includes(path)){
   selected=device.current_grant_id?this.object('access_grants',device.current_grant_id,peer.account.id):null;
   if(!selected||!this.runtimeGrant(selected))throw new HttpError(403,'grant_unavailable','Selected grant is not available.');
  }
  return {body,path,peer,device,selected};
 }
 runtimeGrant(g){const r=this.object('access_resources',g.resource_id,g.account_id);return Boolean(g.upstream_id&&!g.pending&&g.status==='active'&&live(g.expires_at)&&r.status==='active'&&live(r.expires_at));}
 runtimeControl(context,value,url,method){
  if(!context.peer)return value;
  const {peer,device}=context,accountId=peer.account.id;
  const grant=remote=>this.db.prepare('SELECT * FROM access_grants WHERE upstream_id=? AND account_id=? AND customer_id=?').get(remote||'',accountId,device.customer_id);
  const mapOption=option=>{const g=grant(option.id||option.grant_id);if(!g||!this.runtimeGrant(g))return null;const own=this.grantView(g),ends=[own.expires_at,option.expires_at].filter(Boolean).map(Date.parse);return {...option,id:g.id,...(option.grant_id?{grant_id:g.id}:{}),name:own.name,expires_at:ends.length?new Date(Math.min(...ends)).toISOString():null};};
  if(Array.isArray(value.accounts))value.accounts=value.accounts.map(mapOption).filter(Boolean);
  if(value.account)value.account=mapOption(value.account);
  const isDevice=url.pathname.startsWith('/bridge/v1/device');
  const remoteDevice=isDevice?(value.id||value.device?.id):null;
  if(remoteDevice){
   if(device.upstream_id&&device.upstream_id!==remoteDevice||value.id&&value.device?.id&&value.id!==value.device.id)throw new HttpError(409,'device_mapping_conflict','Upstream device changed.');
   const saved=this.db.prepare('UPDATE access_devices SET upstream_id=? WHERE id=? AND (upstream_id IS NULL OR upstream_id=?)').run(remoteDevice,device.id,remoteDevice);
   if(saved.changes!==1)throw new HttpError(409,'device_mapping_conflict','Upstream device mapping changed.');
   if(value.id){value.id=device.id;if(value.name)value.name=device.name;}
  }
  if(value.device_id)value.device_id=device.id;
  if(value.device?.id){value.device.id=device.id;value.device.name=device.name;}
  if(value.code){this.db.prepare('UPDATE access_devices SET pairing_code=?,expires_at=? WHERE id=?').run(String(value.code).replaceAll('-','').toUpperCase(),value.expires_at||null,device.id);}
  for(const target of [value,value.device].filter(Boolean))if(Object.hasOwn(target,'current_grant_id')){
   const g=grant(target.current_grant_id);target.current_grant_id=g?.id||null;
   if(Number.isSafeInteger(target.selection_version)&&target.selection_version>=device.selection_version)this.db.prepare('UPDATE access_devices SET current_grant_id=?,selection_version=? WHERE id=? AND selection_version<=?').run(g?.id||null,target.selection_version,device.id,target.selection_version);
   if(target.account_name)target.account_name=g?this.grantView(g).name:null;
  }
  if(context.selected&&url.pathname==='/bridge/v1/device/account'&&value.selection_version>=device.selection_version)this.db.prepare('UPDATE access_devices SET current_grant_id=?,selection_version=? WHERE id=? AND selection_version<=?').run(context.selected.id,value.selection_version,device.id,value.selection_version);
  if(method==='DELETE'&&url.pathname==='/bridge/v1/device')this.db.prepare('UPDATE access_devices SET disabled=1 WHERE id=?').run(device.id);
  return value;
 }

}
