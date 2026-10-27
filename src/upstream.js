import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { upstreamFetch, readUpstreamJSON } from './upstream-network.js';
import { HttpError, fields } from './security.js';

// Explicit output schemas, including nested objects. Unknown upstream fields are never copied.
const S = 'string', N = 'number', B = 'boolean';
const tokenUsage = { input_tokens:N, output_tokens:N, cache_read_input_tokens:N, cache_creation_input_tokens:N, cache_creation_5m:N, cache_creation_1h:N };
export const schemas = {
  heldAccount: {grant_revision:N,customer_expires_at:S,id:S,resource_id:S,platform:S,grant_id:S,customer_id:S,assigned:B,status:S,expires_at:S,revision:N,created_at:S,device_limit:N,details:{id:S,name:S,plan:S,state:S,device_name:S,platform:S,expires_at:S,device_limit:N,surfaces:[S],quota:{status:S,updated_at:S,windows:[{key:S,label:S,used_percent:N,resets_at:S,reset:B}]}}},

  merchant: { id:S, slug:S, name:S, status:S, revision:N, created_at:S },
  resource: { allocatable:B,id:S, name:S, status:S, kind:S, surfaces:[S], expires_at:S, revision:N, available:B, plans:[{id:S,duration_days:N,amount_minor:N,currency:S,status:S,revision:N}], stock:[{platform:S,label:S,available:N}] },
  account: { device_limit:N,platform:S,expires_at:S,id:S, name:S, plan:S, state:S, device_name:S, surfaces:[S], quota:{status:S,updated_at:S,windows:[{key:S,label:S,used_percent:N,resets_at:S,reset:B}]} },
  customer: { id:S, external_id:S, display_name:S, status:S, revision:N, created_at:S },
  grant: { account_lease_id:S,id:S, customer_id:S, resource_id:S, name:S, status:S, surfaces:[S], expires_at:S, revision:N, updated_at:S, pending:B },
  device: { id:S, name:S, platform:S, state:S, created_at:S, expires_at:S, last_seen:S, current_grant_id:S, account_name:S },
  preview: { name:S, platform:S, code:S, expires_at:S, renewal:B },
  usage: { requests:N, errors:N, ...tokenUsage, cost_usd:N, unknown_usage:N, average_duration_ms:N, average_first_token_ms:N },
  request: { id:'identifier', time:S, model:S, status:N, duration_ms:N, first_token_ms:N, count_only:B, stream:B, usage:tokenUsage, usage_complete:B, cost_usd:N, grant_id:S, session_id:S },
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
export const scopes = ['resources.read','customers.read','customers.write','grants.read','grants.write','devices.read','devices.write','usage.read','runtime','keys.manage'];

export class Upstream {
 constructor(config,store) {
  this.config=config;this.store=store;this.verified=null;this.changing=false;
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
  const response=await upstreamFetch(candidate,`${candidate.upstreamUrl}/merchant/v1/me`,{headers:{Authorization:`Bearer ${candidate.upstreamKey}`,Accept:'application/json'},signal:signal||AbortSignal.timeout(candidate.upstreamTimeoutMs)});
  if(!response.ok){await response.body?.cancel();throw new HttpError(503,'upstream_verification_failed','Upstream could not verify this merchant identity.');}
  const raw=await readUpstreamJSON(response);
  const data={protocol_version:raw.protocol_version,authority_id:raw.authority_id,merchant:project(raw.merchant,schemas.merchant),scopes:Array.isArray(raw.scopes)?raw.scopes.filter(v=>scopes.includes(v)):[]};
  if(data.protocol_version!==4||typeof data.authority_id!=='string'||!data.authority_id||data.authority_id.length>150||!Array.isArray(raw.scopes)||!data.merchant?.id||data.merchant.status!=='active')throw new HttpError(409,'upstream_protocol_mismatch','A compatible active direct account connection is required.');
  const pinned=this.store.db.prepare("SELECT value FROM settings WHERE key='upstream_binding'").get();
  if(pinned){const binding=JSON.parse(pinned.value);if(binding.authority_id!==data.authority_id||binding.merchant_id!==data.merchant.id)throw new HttpError(409,'upstream_identity_mismatch','Existing data is bound to another merchant or core authority.');}
  if(bind){
   this.store.db.prepare('INSERT OR IGNORE INTO settings VALUES(?,?)').run('upstream_binding',JSON.stringify({authority_id:data.authority_id,merchant_id:data.merchant.id}));
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
  if(url.pathname!=='/'||url.search||url.hash||url.username||url.password||!/^ccbm_[a-f0-9]{64}$/.test(body.api_key||''))throw new HttpError(400,'invalid_upstream','Use an upstream origin and its service merchant key.');
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
     this.store.db.prepare('INSERT OR IGNORE INTO settings VALUES(?,?)').run('upstream_binding',JSON.stringify({authority_id:data.authority_id,merchant_id:data.merchant.id}));
     this.store.audit(actor.user.id,'upstream.configure',data.merchant.id);
    });
    this.revision=saved.revision;this.saved=saved;this.config.upstreamUrl=url.origin;this.config.upstreamKey=body.api_key;this.verified={stamp:`${url.origin}|${body.api_key}`,data};
   }
   return {saved:body.action==='save',revision:this.revision,connection:data};
  } finally {this.changing=false;}
 }
 async request(method,path,body,signal,allocation=null) {
  const config={...this.config};
  if(!config.upstreamUrl||!config.upstreamKey)throw new HttpError(503,'core_not_configured','Upstream connection is not configured.');
  if(!path.startsWith('/merchant/v1/')||path.includes('#'))throw new Error('Invalid internal merchant route');
  const timed=AbortSignal.timeout(config.upstreamTimeoutMs),combined=signal?AbortSignal.any([signal,timed]):timed;
  try {
   if(method==='GET' &&path==='/merchant/v1/me')this.verified=null;
   const identity=await this.inspect(config,true,combined);
   if(method==='GET'&&path==='/merchant/v1/me')return identity;
   allocation?.authorize?.();
   if(allocation && body?.status!=='revoked' && body?.action!=='cancel'){
    const local=this.store.db.prepare('SELECT * FROM access_resources WHERE id=? AND account_id=?').get(allocation.resourceId,allocation.accountId);
    if(!local||local.status!=='active'||local.expires_at&&Date.parse(local.expires_at)<=Date.now())throw new HttpError(409,'supply_unavailable','Local resource authorization is unavailable.');
   }
   const headers={Authorization:`Bearer ${config.upstreamKey}`,Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})};
   const response=await upstreamFetch(config,`${config.upstreamUrl}${path}`,{method,headers,body:body?JSON.stringify(body):undefined,signal:combined});
   if(!response.ok){
    const safeErrors={account_device_limit:'每个账号最多绑定 1 台设备，请先在我的设备中撤销旧设备。',account_out_of_stock:'没有符合平台和期限的账号，请联系平台管理员分配或延长有效期。'};
    let code;try{const failure=await readUpstreamJSON(response);code=failure?.error?.code||failure?.code;}catch{}
    if(response.status===409&&Object.hasOwn(safeErrors,code))throw new HttpError(409,code,safeErrors[code]);
    if(![400,401,403,404,409,429].includes(response.status))throw new HttpError(503,method==='GET'?'core_unavailable':'core_outcome_unknown',method==='GET'?'Upstream unavailable.':'Write result is unknown. Read/reconcile before another change.');
    const status=response.status;
    throw new HttpError(status===401?503:status,status===409?'core_conflict':'core_rejected','Upstream rejected the operation. No automatic retry was made.');
   }
   const data=await readUpstreamJSON(response);
   return data;
  }catch(error){
   if(error instanceof HttpError)throw error;throw new HttpError(503,method==='GET'?'core_unavailable':'core_outcome_unknown',method==='GET'?'Upstream unavailable.':'Write result is unknown; request was not retried.');
  }

 }

}
