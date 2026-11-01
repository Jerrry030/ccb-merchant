import {randomUUID} from 'node:crypto';
import {HttpError,fields,opaqueId,text} from './security.js';
import {project,schemas} from './upstream.js';

const phases=new Set(['pending','queued','exchanging','provisioning','success','error','review','cancelled','expired']);
const invalid=()=>new HttpError(503,'invalid_core_response','提供方回执不完整，未确认成功。');
// Only non-secret intentions and neighbour mappings are durable here. Callback
// codes and authorization URLs are never written into merchant storage.
export class Custody {
 constructor(store,upstream){this.store=store;this.db=store.db;this.upstream=upstream;}
 scope(){const c=this.upstream.context.getStore();return {owner:c?.peerAccountId||'local',origin:c?.localOrigin||''};}
 async options(){
  const data=await this.upstream.request('GET','/access/v1/account-intake');
  if(typeof data.available!=='boolean'||!Array.isArray(data.environments)||data.environments.length>32)throw invalid();
  const seen=new Set();const environments=data.environments.map(e=>{
   if(!e||typeof e.id!=='string'||seen.has(e.id)||typeof e.name!=='string'||!e.name.trim()||e.name.length>200||typeof e.region!=='string'||! /^[A-Z]{2}$/.test(e.region)||typeof e.timezone!=='string'||e.timezone.length>100||!e.timezone||!Array.isArray(e.platforms)||!e.platforms.length||e.platforms.length>6||e.platforms.some(v=>! /^(Windows|MacOS|Linux)\/(x64|arm64)$/.test(v)))throw invalid();
   opaqueId(e.id);seen.add(e.id);try{new Intl.DateTimeFormat('en',{timeZone:e.timezone});}catch{throw invalid();}this.db.prepare('INSERT OR IGNORE INTO custody_environment_ids VALUES(?,?)').run(randomUUID(),e.id);
   return {id:this.db.prepare('SELECT id FROM custody_environment_ids WHERE upstream_id=?').get(e.id).id,name:e.name,region:e.region,timezone:e.timezone,platforms:e.platforms};
  });
  return {available:data.available&&environments.length>0,environments};
 }
 resource(owner,origin,upstreamId){
  let row=this.db.prepare('SELECT * FROM access_resources WHERE account_id=? AND origin_ref=? AND upstream_id=?').get(owner,origin,upstreamId);
  if(!row){const id=randomUUID();this.db.prepare("INSERT INTO access_resources(id,account_id,upstream_id,name,status,expires_at,origin_ref,source) VALUES(?,?,?,'自有账号','active',NULL,?,'owned')").run(id,owner,upstreamId,origin);row=this.db.prepare('SELECT * FROM access_resources WHERE id=?').get(id);}
  if(row.source!=='owned')throw new HttpError(409,'mapping_conflict','账号来源与已有资源映射冲突。');
  return row;
 }
 mapManaged(raw){
  if(!raw||['id','name','platform','environment_id','resource_id','account_lease_id'].some(k=>typeof raw[k]!=='string'||!raw[k]||raw[k].length>200)||!Number.isSafeInteger(raw.revision)||raw.revision<1||!['active','paused','closed','provisioning'].includes(raw.status))throw invalid();
  for(const key of ['id','environment_id','resource_id','account_lease_id'])opaqueId(raw[key]);
  const {owner,origin}=this.scope();
  let saved=this.db.prepare('SELECT * FROM custody_accounts WHERE owner_id=? AND origin_ref=? AND upstream_id=?').get(owner,origin,raw.id);
  const id=saved?.id||randomUUID(),prior=saved?JSON.parse(saved.snapshot):null;
  if(prior&&raw.revision<prior.upstream_revision)throw new HttpError(409,'account_changed','A stale provider receipt cannot replace newer observed state.');
  let resourceId=raw.resource_id,leaseId=raw.account_lease_id;
  if(owner!=='local'){
   const resource=this.resource(owner,origin,raw.resource_id);resourceId=resource.id;
   this.db.prepare('INSERT OR IGNORE INTO access_account_leases(id,account_id,origin_ref,upstream_id,resource_id) VALUES(?,?,?,?,?)').run(randomUUID(),owner,origin,raw.account_lease_id,resourceId);
   leaseId=this.db.prepare('SELECT id FROM access_account_leases WHERE account_id=? AND origin_ref=? AND upstream_id=?').get(owner,origin,raw.account_lease_id).id;
  }
  const environment=this.db.prepare('SELECT id FROM custody_environment_ids WHERE upstream_id=?').get(raw.environment_id);
  const view={id,name:raw.name,status:raw.status,platform:raw.platform,environment_id:environment?.id||'',resource_id:resourceId,account_lease_id:leaseId,revision:prior?(prior.view.revision+(prior.upstream_revision===raw.revision?0:1)):1};
  this.db.prepare('INSERT INTO custody_accounts(id,owner_id,origin_ref,upstream_id,snapshot) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET snapshot=excluded.snapshot').run(id,owner,origin,raw.id,JSON.stringify({view,upstream_revision:raw.revision}));
  return view;
 }
 async managed(method,id,body,check){
  const {owner,origin}=this.scope();
  if(!id){
   const data=await this.upstream.request('GET','/access/v1/managed-accounts');check();if(!Array.isArray(data.accounts))throw invalid();
   return {accounts:data.accounts.map(v=>this.mapManaged(v))};
  }
  const row=this.db.prepare('SELECT * FROM custody_accounts WHERE id=? AND owner_id=? AND origin_ref=?').get(opaqueId(id),owner,origin);
  if(!row)throw new HttpError(404,'not_found','账号不属于当前来源。');
  let intent;
  if(method!=='GET'){
   fields(body,method==='DELETE'?['expected_revision']:['expected_revision','status'],['expected_revision']);const prior=JSON.parse(row.snapshot);
   if(body.expected_revision!==prior.view.revision||method==='PATCH'&&!['active','paused'].includes(body.status))throw new HttpError(409,'account_changed','请刷新账号状态后操作。');
   intent={expected_revision:prior.upstream_revision,...(method==='PATCH'?{status:body.status}:{})};
  }
  const data=await this.upstream.request(method,`/access/v1/managed-accounts/${opaqueId(row.upstream_id)}`,intent);check();
  return {ok:true,account:this.mapManaged(data.account)};
 }
 async authorization(method,id,body,complete,check){
  const {owner,origin}=this.scope();
  if(!id){const rows=this.db.prepare('SELECT id FROM custody_operations WHERE owner_id=? AND origin_ref=? ORDER BY updated_at DESC LIMIT 100').all(owner,origin);const authorizations=[];for(const row of rows)authorizations.push((await this.authorization('GET',row.id,{},false,check)).authorization);return {authorizations};}
  opaqueId(id);if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))throw new HttpError(400,'invalid_operation_id','Authorization ID must be a UUID.');let row=this.db.prepare('SELECT * FROM custody_operations WHERE owner_id=? AND origin_ref=? AND id=?').get(owner,origin,id);
  if(method==='PUT'){
   fields(body,['name','environment_id','platform','managed_account_id','expected_revision']);
   if(!row){
    const upstreamIntent={};
    if(body.managed_account_id){
     const a=this.db.prepare('SELECT * FROM custody_accounts WHERE id=? AND owner_id=? AND origin_ref=?').get(opaqueId(body.managed_account_id),owner,origin);if(!a)throw new HttpError(404,'not_found','账号不存在。');
     const snapshot=JSON.parse(a.snapshot);if(body.expected_revision!==snapshot.view.revision)throw new HttpError(409,'account_changed','请刷新账号后重新授权。');
     upstreamIntent.managed_account_id=a.upstream_id;upstreamIntent.expected_revision=snapshot.upstream_revision;
    }else{
     upstreamIntent.name=text(body.name,'name',100);await this.options();check();
     const env=this.db.prepare('SELECT upstream_id FROM custody_environment_ids WHERE id=?').get(opaqueId(body.environment_id));if(!env)throw new HttpError(400,'invalid_environment','请选择可用环境。');
     if(!/^(Windows|MacOS|Linux)\/(x64|arm64)$/.test(body.platform))throw new HttpError(400,'invalid_platform','请选择平台。');
     upstreamIntent.environment_id=env.upstream_id;upstreamIntent.platform=body.platform;
    }
    check();this.db.prepare('INSERT OR IGNORE INTO custody_operations(owner_id,origin_ref,id,upstream_id,intent,upstream_intent,updated_at) VALUES(?,?,?,?,?,?,?)').run(owner,origin,id,randomUUID(),JSON.stringify(body),JSON.stringify(upstreamIntent),new Date().toISOString());
    row=this.db.prepare('SELECT * FROM custody_operations WHERE owner_id=? AND origin_ref=? AND id=?').get(owner,origin,id);
   }
   if(JSON.stringify(Object.entries(body).sort())!==JSON.stringify(Object.entries(JSON.parse(row.intent)).sort()))throw new HttpError(409,'operation_conflict','操作标识已经绑定另一项授权。');
  }
  if(!row)throw new HttpError(404,'not_found','授权操作不存在。');
  let payload;if(method==='PUT')payload=JSON.parse(row.upstream_intent);if(complete){fields(body,['callback_url'],['callback_url']);payload={callback_url:text(body.callback_url,'callback_url',16000)};}
  const data=await this.upstream.request(method,`/access/v1/account-authorizations/${opaqueId(row.upstream_id)}${complete?'/complete':''}`,payload);check();
  const raw=data.authorization;if(!raw||raw.id!==row.upstream_id||!phases.has(raw.status))throw invalid();
  const view={id,status:raw.status,error:typeof raw.error==='string'?raw.error:''};
  if(raw.account_id){const managed=await this.upstream.request('GET',`/access/v1/managed-accounts/${opaqueId(raw.account_id)}`);check();view.account_id=this.mapManaged(managed.account).id;}
  this.db.prepare('UPDATE custody_operations SET snapshot=?,updated_at=? WHERE owner_id=? AND origin_ref=? AND id=?').run(JSON.stringify(view),new Date().toISOString(),owner,origin,id);
  if(raw.status==='pending'){if(typeof raw.auth_url!=='string'||raw.auth_url.length>16000)throw invalid();view.auth_url=raw.auth_url;}
  return {ok:true,authorization:view};
 }
 // A verified source resource can transit without becoming the relay's stock.
 async inventory(accountId){
  const {origin}=this.scope();const data=await this.upstream.request('GET','/access/v1/accounts');
  if(!Array.isArray(data.accounts))throw invalid();const result=[];
  for(const raw of data.accounts){
   let resource=this.db.prepare("SELECT * FROM access_resources WHERE account_id=? AND upstream_id=? AND(source<>'owned' OR origin_ref=?)").get(accountId,raw.resource_id,origin);
   if(raw.source==='owned')resource=this.resource(accountId,origin,raw.resource_id);
   if(!resource||resource.status!=='active')continue;
   if(!Number.isSafeInteger(raw.revision))throw invalid();
   let link=this.db.prepare('SELECT * FROM access_account_leases WHERE account_id=? AND origin_ref=? AND upstream_id=?').get(accountId,origin,raw.id);
   const id=link?.id||randomUUID(),old=link?JSON.parse(link.snapshot):{};
   if(link&&raw.revision<link.upstream_revision)throw new HttpError(409,'account_changed','Provider account revision moved backwards.');
   const view=project(raw,schemas.heldAccount);view.id=id;view.resource_id=resource.id;view.revision=old.revision?(old.revision+(raw.revision===link.upstream_revision?0:1)):1;
   if(raw.managed_account_id){let a=this.db.prepare('SELECT id FROM custody_accounts WHERE owner_id=? AND origin_ref=? AND upstream_id=?').get(accountId,origin,raw.managed_account_id);if(!a){const m=await this.upstream.request('GET',`/access/v1/managed-accounts/${opaqueId(raw.managed_account_id)}`);a=this.mapManaged(m.account);}view.managed_account_id=a.id;}
   view.customer_id=raw.customer_id?this.db.prepare('SELECT id FROM access_customers WHERE account_id=? AND origin_ref=? AND upstream_id=?').get(accountId,origin,raw.customer_id)?.id||null:null;
   let grant=raw.grant_id?this.db.prepare('SELECT * FROM access_grants WHERE account_id=? AND upstream_id=?').get(accountId,raw.grant_id):null;
   if(grant&&!grant.pending&&raw.grant_revision!==grant.upstream_revision){
    const remote=(await this.upstream.request('GET',`/access/v1/grants/${opaqueId(grant.upstream_id)}`)).grant;
    if(!remote||remote.id!==grant.upstream_id||remote.pending||!Number.isSafeInteger(remote.revision)||!['active','revoked'].includes(remote.status))throw invalid();
    this.db.prepare('UPDATE access_grants SET status=?,expires_at=?,upstream_revision=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND pending=0').run(remote.status,remote.expires_at,remote.revision,new Date().toISOString(),grant.id,grant.revision);
    grant=this.db.prepare('SELECT * FROM access_grants WHERE id=?').get(grant.id);
   }
   view.grant_id=grant?.id||null;view.grant_revision=grant?.revision||0;
   if((grant?.pending||this.db.prepare('SELECT 1 FROM access_grants WHERE account_lease_id=? AND pending=1').get(id))&&view.details)view.details.state='unavailable';
   if(view.details){view.details.id=id;view.details.name=raw.details?.name||'账号';}
   this.db.prepare('INSERT INTO access_account_leases(id,account_id,origin_ref,upstream_id,resource_id,upstream_revision,snapshot) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET upstream_revision=excluded.upstream_revision,snapshot=excluded.snapshot').run(id,accountId,origin,raw.id,resource.id,raw.revision,JSON.stringify(view));result.push(view);
  }
  return result;
 }
}
