import { createHash, randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { upstreamFetch, readUpstreamJSON } from './upstream-network.js';
import { HttpError, fields, opaqueId } from './security.js';

// Explicit output schemas, including nested objects. Unknown upstream fields are never copied.
const S = 'string', N = 'number', B = 'boolean';
const tokenUsage = { input_tokens:N, output_tokens:N, cache_read_input_tokens:N, cache_creation_input_tokens:N, cache_creation_5m:N, cache_creation_1h:N };
export const schemas = {
  heldAccount: {allow_delegation:B,grant_revision:N,customer_expires_at:S,id:S,resource_id:S,platform:S,grant_id:S,customer_id:S,assigned:B,status:S,expires_at:S,revision:N,created_at:S,device_limit:N,details:{id:S,name:S,plan:S,state:S,device_name:S,platform:S,expires_at:S,device_limit:N,surfaces:[S],quota:{status:S,updated_at:S,windows:[{key:S,label:S,used_percent:N,resets_at:S,reset:B}]}}},

  user: { id:S, username:S, name:S, status:S, can_delegate:B, revision:N, created_at:S },
  resource: { allocatable:B,id:S, name:S, status:S, kind:S, surfaces:[S], expires_at:S, revision:N, available:B, plans:[{id:S,duration_days:N,amount_minor:N,currency:S,status:S,revision:N}], stock:[{platform:S,label:S,available:N}] },
  account: { grant_id:S,account_lease_id:S,device_limit:N,platform:S,expires_at:S,id:S, name:S, plan:S, state:S, device_name:S, surfaces:[S], quota:{status:S,updated_at:S,windows:[{key:S,label:S,used_percent:N,resets_at:S,reset:B}]} },
  customer: { id:S, external_id:S, display_name:S, status:S, revision:N, created_at:S },
  grant: { account_lease_id:S,id:S, customer_id:S, resource_id:S, name:S, status:S, surfaces:[S], expires_at:S, revision:N, updated_at:S, pending:B },
  device: { id:S, name:S, platform:S, state:S, created_at:S, expires_at:S, last_seen:S, selection_version:N, current_grant_id:S, account_name:S },
  preview: { name:S, platform:S, code:S, expires_at:S, renewal:B },
  usage: { requests:N, errors:N, ...tokenUsage, cost_usd:N, unknown_usage:N, average_duration_ms:N, average_first_token_ms:N },
  timeline:{from:S,to:S,interval:S,points:[{time:S,requests:N,errors:N,input_tokens:N,output_tokens:N,unknown_usage:N}]},
  session:{session_id:S,first_time:S,last_time:S,requests:N,errors:N,model:S,status:N,active:B},
  request: { device_id:S, id:'identifier', time:S, model:S, status:N, duration_ms:N, first_token_ms:N, count_only:B, stream:B, usage:tokenUsage, usage_complete:B, cost_usd:N, grant_id:S, session_id:S },
};
export function project(value, schema) {
  if (schema === 'identifier') {
    if (typeof value === 'string' && value.length > 0 && value.length <= 150) return value;
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
  }
  if (value === null) return null;
  if (Array.isArray(schema)) return Array.isArray(value) ? value.slice(0,10000).map(item => project(item, schema[0])).filter(item => item !== undefined) : [];
  if (typeof schema === 'string') return typeof value === schema && (schema !== N || Number.isFinite(value)) ? (schema === S ? value.slice(0,8192) : value) : undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = {};
  for (const [key, rule] of Object.entries(schema)) {
    if (!Object.hasOwn(value,key)) continue;
    const filtered = project(value[key],rule);
    if (filtered !== undefined) result[key] = filtered;
  }
  return result;
}
export const scopes = ['resources.read','customers.read','customers.write','delegation.grants.read','delegation.grants.write','delegation.devices.read','delegation.devices.write','delegation.usage.read','runtime','delegation.keys.manage'];

export class Upstream {
 constructor(config,store) {
  this.config=config;this.store=store;this.verified=null;this.changing=false;
  // Convert only the persisted correlation key; never rebind to another owner.
  store.transaction(()=>{
   const saved=store.db.prepare("SELECT value FROM settings WHERE key='upstream_binding'").get();
   if(saved){const binding=JSON.parse(saved.value);if(Object.hasOwn(binding,'merchant_id')){binding.user_id=binding.merchant_id;delete binding.merchant_id;store.db.prepare("UPDATE settings SET value=? WHERE key='upstream_binding'").run(JSON.stringify(binding));}}
   for(const key of store.db.prepare('SELECT id,scopes FROM access_keys').all()){
    const before=JSON.parse(key.scopes),after=before.map(value=>['grants.read','grants.write','devices.read','devices.write','usage.read','keys.manage'].includes(value)?'delegation.'+value:value);
    if(JSON.stringify(before)!==JSON.stringify(after))store.db.prepare('UPDATE access_keys SET scopes=? WHERE id=?').run(JSON.stringify(after),key.id);
   }
  });
  store.db.prepare('INSERT OR IGNORE INTO settings VALUES(?,?)').run('instance_id',randomUUID());
  this.instanceId=store.db.prepare("SELECT value FROM settings WHERE key='instance_id'").get().value;
  const saved=store.db.prepare("SELECT value FROM settings WHERE key='upstream'").get();
  this.saved=saved?JSON.parse(saved.value):null;
  this.revision=this.saved?.revision||0;
  this.masterPath=join(config.dataDir,'upstream.key');
  if(this.saved&&!config.upstreamEnvironment){
   const master=readFileSync(this.masterPath);if(master.length!==32)throw new Error('Invalid upstream encryption key');
   const encrypted=this.saved.secret,decipher=createDecipheriv('aes-256-gcm',master,Buffer.from(encrypted.iv,'base64'));decipher.setAuthTag(Buffer.from(encrypted.tag,'base64'));
   config.upstreamUrl=this.saved.url;config.upstreamKey=Buffer.concat([decipher.update(Buffer.from(encrypted.data,'base64')),decipher.final()]).toString('utf8');
  }
 }
 async inspect(candidate=this.config,bind=false,signal) {
  const stamp=`${candidate.upstreamUrl}|${candidate.upstreamKey}`;
  if(bind&&this.verified?.stamp===stamp)return this.verified.data;
  if(!candidate.upstreamUrl||!candidate.upstreamKey)throw new HttpError(503,'core_not_configured','Upstream connection is not configured.');
  const response=await upstreamFetch(candidate,`${candidate.upstreamUrl}/access/v1/me`,{headers:{Authorization:`Bearer ${candidate.upstreamKey}`,Accept:'application/json'},signal:signal||AbortSignal.timeout(candidate.upstreamTimeoutMs)});
  if(!response.ok){await response.body?.cancel();throw new HttpError(503,'upstream_verification_failed','Upstream could not verify this merchant identity.');}
  const raw=await readUpstreamJSON(response);
  const data={authority_id:raw.authority_id,user:project(raw.user,schemas.user),scopes:Array.isArray(raw.scopes)?raw.scopes.filter(v=>scopes.includes(v)):[]};
  if(typeof data.authority_id!=='string'||!data.authority_id||data.authority_id.length>150||!Array.isArray(raw.scopes)||!data.user?.id||data.user.status!=='active')throw new HttpError(409,'upstream_protocol_mismatch','A compatible active direct account connection is required.');
  const pinned=this.store.db.prepare("SELECT value FROM settings WHERE key='upstream_binding'").get();
  if(pinned){const binding=JSON.parse(pinned.value);if(binding.authority_id!==data.authority_id||binding.user_id!==data.user.id)throw new HttpError(409,'upstream_identity_mismatch','Existing data is bound to another merchant or core authority.');}
  if(bind){
   this.store.db.prepare('INSERT OR IGNORE INTO settings VALUES(?,?)').run('upstream_binding',JSON.stringify({authority_id:data.authority_id,user_id:data.user.id}));
   this.verified={stamp,data};
  }
  return data;
 }
 async configure(body,authorize) {
  fields(body,['action','url','api_key','expected_revision'],['action','url','api_key','expected_revision']);
  if(this.config.upstreamEnvironment)throw new HttpError(409,'upstream_environment_managed','This installation uses environment-managed upstream credentials.');
  if(this.changing||body.expected_revision!==this.revision)throw new HttpError(409,'upstream_changed','Refresh connection configuration before saving.');
  if(!['verify','save'].includes(body.action))throw new HttpError(400,'invalid_input','Choose verify or save.');
  let url;try{url=new URL(body.url);}catch{throw new HttpError(400,'invalid_upstream','Invalid upstream origin.');}
  if(url.pathname!=='/'||url.search||url.hash||url.username||url.password||!/^ccb[km]_[A-Za-z0-9_-]{32,128}$/.test(body.api_key||''))throw new HttpError(400,'invalid_upstream','Use an upstream origin and its service merchant key.');
  this.changing=true;
  try {
   const candidate={...this.config,upstreamUrl:url.origin,upstreamKey:body.api_key};
   const data=await this.inspect(candidate);const actor=authorize();
   if(body.expected_revision!==this.revision)throw new HttpError(409,'upstream_changed','Configuration changed during verification.');
   if(body.action==='save') {
    let master;
    try{master=readFileSync(this.masterPath);}catch(error){if(error.code!=='ENOENT')throw error;master=randomBytes(32);writeFileSync(this.masterPath,master,{flag:'wx',mode:0o600});}
    if(master.length!==32)throw new Error('Invalid encryption key');
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',master,iv);const bytes=Buffer.concat([cipher.update(body.api_key,'utf8'),cipher.final()]);
    const saved={url:url.origin,revision:this.revision+1,secret:{iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:bytes.toString('base64')}};
    this.store.transaction(()=>{
     this.store.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('upstream',JSON.stringify(saved));
     this.store.db.prepare('INSERT OR IGNORE INTO settings VALUES(?,?)').run('upstream_binding',JSON.stringify({authority_id:data.authority_id,user_id:data.user.id}));
     this.store.audit(actor.user.id,'upstream.configure',data.user.id);
    });
    this.revision=saved.revision;this.saved=saved;this.config.upstreamUrl=url.origin;this.config.upstreamKey=body.api_key;this.verified={stamp:`${url.origin}|${body.api_key}`,data};
   }
   return {saved:body.action==='save',revision:this.revision,connection:data};
  } finally {this.changing=false;}
 }
 async request(method,path,body,signal,allocation=null) {
  const config={...this.config};
  if(!config.upstreamUrl||!config.upstreamKey)throw new HttpError(503,'core_not_configured','Upstream connection is not configured.');
  if(!path.startsWith('/access/v1/')||path.includes('#'))throw new Error('Invalid internal merchant route');
  const timed=AbortSignal.timeout(config.upstreamTimeoutMs),combined=signal?AbortSignal.any([signal,timed]):timed;
  try {
   if(method==='GET' &&path==='/access/v1/me')this.verified=null;
   const identity=await this.inspect(config,true,combined);
   if(method==='GET'&&path==='/access/v1/me')return identity;
   allocation?.authorize?.();
   if(allocation?.resourceId && body?.status!=='revoked' && body?.action!=='cancel'){
    const local=this.store.db.prepare('SELECT * FROM access_resources WHERE id=? AND account_id=?').get(allocation.resourceId,allocation.accountId);
    if(!local||local.status!=='active'||local.expires_at&&Date.parse(local.expires_at)<=Date.now())throw new HttpError(409,'supply_unavailable','Local resource authorization is unavailable.');
   }
   const headers={Authorization:`Bearer ${config.upstreamKey}`,Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})};
   if(method==='POST'&&['/access/v1/customers','/access/v1/grants','/access/v1/keys'].includes(path)) {
    const canonical=JSON.stringify(body,Object.keys(body).sort());
    headers['Idempotency-Key']=createHash('sha256').update(method+' '+path+' '+canonical).digest('hex');
   }
   const requested=new URL(path,'http://internal.invalid');
   const usageRoute=method==='GET'&&/^\/access\/v1\/customers\/[^/]+\/usage$/.test(requested.pathname);
   const collectionRoute=method==='GET'&&(usageRoute||/^\/access\/v1\/(resources|accounts|customers|grants|keys)$/.test(requested.pathname)||/^\/access\/v1\/customers\/[^/]+\/(accounts|devices)$/.test(requested.pathname));
   const offset=Number(requested.searchParams.get('offset')||0),limit=requested.searchParams.has('limit')?Number(requested.searchParams.get('limit')):null;
   if(collectionRoute){requested.searchParams.delete('offset');requested.searchParams.set('limit',usageRoute?String(limit??50):'500');path=requested.pathname+requested.search;}
   const response=await upstreamFetch(config,`${config.upstreamUrl}${path}`,{method,headers,body:body?JSON.stringify(body):undefined,signal:combined});
   if(!response.ok){
    const safeErrors={device_stale:'设备已变更，请刷新核对后重新操作。',grant_unavailable:'该账号授权不能用于此设备。',account_device_limit:'每个账号最多绑定 1 台设备，请先在我的设备中撤销旧设备。',account_out_of_stock:'没有符合平台和期限的账号，请联系平台管理员分配或延长有效期。'};
    let code;try{const failure=await readUpstreamJSON(response);code=failure?.code;}catch{}
    if(response.status===409&&Object.hasOwn(safeErrors,code))throw new HttpError(409,code,safeErrors[code]);
    if(![400,401,403,404,409,429].includes(response.status))throw new HttpError(503,method==='GET'?'core_unavailable':'core_outcome_unknown',method==='GET'?'Upstream unavailable.':'Write result is unknown. Read/reconcile before another change.');
    const status=response.status;
    throw new HttpError(status===401?503:status,status===409?'core_conflict':'core_rejected','Upstream rejected the operation. No automatic retry was made.');
   }
   const data=await readUpstreamJSON(response);
   if(response.headers.get('Idempotent-Replayed')==='true'&&method==='POST'&&['/access/v1/customers','/access/v1/grants'].includes(path)){
    const field=path.endsWith('/customers')?'customer':'grant',accepted=data[field];
    if(!accepted?.id)throw new HttpError(503,'core_outcome_unknown','Replay receipt cannot be identified.');
    allocation?.authorize?.();
    const currentResponse=await upstreamFetch(config,`${config.upstreamUrl}${path}/${opaqueId(accepted.id)}`,{method:'GET',headers,signal:combined});
    if(!currentResponse.ok){await currentResponse.body?.cancel();throw new HttpError(503,'core_outcome_unknown','Could not confirm current state after replay.');}
    const current=project((await readUpstreamJSON(currentResponse))[field],schemas[field]);allocation?.authorize?.();
    if(!current||current.id!==accepted.id||current.revision!==accepted.revision||current.status!=='active'||current.expires_at&&Date.parse(current.expires_at)<=Date.now())throw new HttpError(409,'core_conflict','The accepted intent is historical; current state changed. Refresh before a new operation.');
    data[field]=current;
   }
   if(collectionRoute){
    const field=usageRoute?(requested.searchParams.get('view')==='sessions'?'sessions':'requests'):requested.pathname.split('/').at(-1), rows=data[field];
    if(!Array.isArray(rows)||typeof data.next_cursor!=='string')throw new HttpError(503,'invalid_core_response','Missing collection pagination.');
    const seen=new Set();let cursor=data.next_cursor;
    while(cursor&&(!usageRoute||rows.length<offset+(limit??50))){
     if(seen.has(cursor)||rows.length>=50000)throw new HttpError(503,'collection_budget_exceeded','Collection continuation exceeds this operation budget. No partial result was returned.');seen.add(cursor);
     requested.searchParams.set('cursor',cursor);
     const next=await upstreamFetch(config,`${config.upstreamUrl}${requested.pathname}${requested.search}`,{method:'GET',headers,signal:combined});
     if(!next.ok){await next.body?.cancel();throw new HttpError(503,'core_unavailable','Could not complete collection retrieval.');}
     const page=await readUpstreamJSON(next);
     if(!Array.isArray(page[field])||typeof page.next_cursor!=='string')throw new HttpError(503,'invalid_core_response','Invalid collection continuation.');
     rows.push(...page[field]);cursor=page.next_cursor;
    }
    data[field]=usageRoute?rows.slice(offset,offset+(limit??50)):limit===null?rows:rows.slice(offset,offset+limit);data.next_cursor=cursor;
    data.total??=rows.length;
    if(limit!==null){data.limit=limit;data.offset=offset;}
   }
   return data;
  }catch(error){
   if(error instanceof HttpError)throw error;throw new HttpError(503,method==='GET'?'core_unavailable':'core_outcome_unknown',method==='GET'?'Upstream unavailable.':'Write result is unknown; request was not retried.');
  }

 }

}
