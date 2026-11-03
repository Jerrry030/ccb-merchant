import { createHash } from 'node:crypto';
import { HttpError, opaqueId } from './security.js';
import { project, schemas } from './upstream.js';
import { deviceStatus } from '../public/device-status.js';

// Scoped and global reads share the same projection and customer snapshot
// checks. Writes remain exclusively on the existing customer-scoped routes.
export class Devices {
 constructor(store,core){this.store=store;this.core=core;this.runtimeOwners=new Map();this.runtimeLookups=new Map();}
 // Only an authenticated native status can seed this lookup. Provider usernames
 // stay filtered; a unique customer-scoped device membership proves the local user.
 // Cache proof, not the email: local identity changes are read again on every hit.
 async runtimeUsername(device, config, signal) {
  const db=this.store.db, currentProvider=()=>this.core.config.upstreamUrl===config.upstreamUrl&&this.core.config.upstreamKey===config.upstreamKey;
  if(signal?.aborted||!currentProvider()||device?.state!=='approved'||!(Date.parse(device.expires_at)>Date.now()))return;
  if(![device.id,device.owner_user_id].every(value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,150}$/.test(value)))return;
  const statement=db.prepare('SELECT id,core_customer_id,status,core_pending FROM users WHERE core_customer_id IS NOT NULL ORDER BY id LIMIT 501');
  const targets=statement.all();
  if(!targets.length||targets.length>500||targets.some(user=>user.core_pending))return;
  const signature=JSON.stringify(targets);
  const key=createHash('sha256').update(JSON.stringify([config.upstreamUrl,config.upstreamKey,device.id,device.owner_user_id,signature])).digest('hex');
  let proof=this.runtimeOwners.get(key);
  if(!proof||proof.until<=Date.now()){
   let pending=this.runtimeLookups.get(key);
   if(!pending){
    if(this.runtimeLookups.size>=2)return;
    pending=(async()=>{
     const controller=new AbortController();
     const budget=AbortSignal.timeout(Math.max(1,Math.min(1500,Math.floor(config.upstreamTimeoutMs/2))));
     const bounded=AbortSignal.any([controller.signal,budget,...(signal?[signal]:[])]);
     const matches=[];let cursor=0,observed=0,verified=false;
     const workers=Array.from({length:Math.min(4,targets.length)},async()=>{
      while(cursor<targets.length){
       if(bounded.aborted||!currentProvider())throw new Error('Identity lookup cancelled');
       const user=targets[cursor++];
       const data=await this.core.request('GET','/access/v1/customers/'+opaqueId(user.core_customer_id)+'/devices',undefined,bounded);
       if(!Array.isArray(data.devices)||data.next_cursor!==''||(observed+=data.devices.length)>10000||Number.isSafeInteger(data.total)&&data.total!==data.devices.length)throw new Error('Incomplete device membership');
       const seen=new Set();
       for(const row of data.devices){
        if(typeof row?.id!=='string'||!/^[A-Za-z0-9_-]{1,150}$/.test(row.id)||seen.has(row.id))throw new Error('Ambiguous device membership');
        seen.add(row.id);
        if(row.id===device.id){
         // Even an inactive duplicate makes the customer association ambiguous.
         if(row.state!=='approved'||!(Date.parse(row.expires_at)>Date.now()))throw new Error('Device membership is not active');
         matches.push({id:user.id,core_customer_id:user.core_customer_id,expires:Date.parse(row.expires_at)});
        }
       }
      }
     });
     try {await Promise.all(workers);verified=true;}
     catch {controller.abort();await Promise.allSettled(workers);}
     const owner=verified&&matches.length===1&&currentProvider()&&signature===JSON.stringify(statement.all())?matches[0]:null;
     const result={owner,until:owner?Math.min(Date.now()+60000,owner.expires):Date.now()+5000};
     if(this.runtimeOwners.size>=256)this.runtimeOwners.delete(this.runtimeOwners.keys().next().value);
     this.runtimeOwners.set(key,result);return result;
    })();
    this.runtimeLookups.set(key,pending);
    void pending.finally(()=>this.runtimeLookups.delete(key)).catch(()=>undefined);
   }
   proof=await pending;
  }
  if(!proof.owner||proof.until<=Date.now()||signal?.aborted||!currentProvider()||signature!==JSON.stringify(statement.all()))return;
  const user=db.prepare('SELECT email,status,core_customer_id,core_pending FROM users WHERE id=?').get(proof.owner.id);
  if(user?.status==='active'&&!user.core_pending&&user.core_customer_id===proof.owner.core_customer_id)return user.email;
 }
 async read({userId=null,q='',status='',limit=50,offset=0}={},authorize) {
  const global=userId===null,db=this.store.db;
  const targets=global?db.prepare('SELECT * FROM users WHERE core_customer_id IS NOT NULL OR core_pending IS NOT NULL ORDER BY id LIMIT 501').all():[db.prepare('SELECT * FROM users WHERE id=?').get(userId)];
  if(!global&&!targets[0])throw new HttpError(404,'not_found','Customer not found.');
  if(targets.length>500)throw new HttpError(503,'device_read_limit','Too many customer mappings for a global read. Open one customer device page.');
  const results=new Array(targets.length),signal=global?AbortSignal.timeout(15000):undefined;let cursor=0,observedDevices=0,failure=null;
  const unchanged=target=>{
   const current=db.prepare('SELECT * FROM users WHERE id=?').get(target.id);
   return current&&!current.core_pending&&current.core_customer_id===target.core_customer_id&&current.status===target.status&&current.display_name===target.display_name&&current.email===target.email;
  };
  await Promise.all(Array.from({length:Math.min(4,targets.length)},async()=>{
   while(!failure&&cursor<targets.length){
    const index=cursor++,target=targets[index];
    try {
     authorize();
     if(!unchanged(target))throw new HttpError(409,'customer_changed','Customer synchronization is pending.');
     if(!target.core_customer_id){results[index]={devices:[],accounts:[]};continue;}
     if(signal?.aborted)throw new HttpError(503,'device_read_limit','Global device read exceeded its time budget.');
     const [data,entitlements]=await Promise.all([this.core.request('GET',`/access/v1/customers/${opaqueId(target.core_customer_id)}/devices`,undefined,signal),this.core.customerEntitlements(target.core_customer_id,{includeAccounts:true,signal})]);
     authorize();if(!unchanged(target))throw new HttpError(409,'customer_changed','Customer changed during device read.');
     if(!Array.isArray(data.devices)||data.devices.length>10000)throw new HttpError(503,'invalid_core_response','Device list is unavailable.');
     if(failure)return;
     if(global&&(observedDevices+=data.devices.length)>10000){failure=new HttpError(503,'device_read_limit','Too many devices for a global read. Open one customer device page.');return;}
     const selected=new Set(data.devices.map(device=>device?.current_grant_id));
     const accounts=this.store.labelAccounts(global?entitlements.accounts.filter(a=>selected.has(a.grant_id||a.id)):entitlements.accounts),names=new Map(accounts.map(a=>[a.grant_id||a.id,a.name])),seen=new Set();
     const devices=data.devices.map(row=>{
      const device=project(row,schemas.device);
      if(!device?.id||seen.has(device.id))throw new HttpError(503,'invalid_core_response','Invalid device metadata.');
      opaqueId(device.id);seen.add(device.id);
      return {...device,account_name:device.current_grant_id?(names.get(device.current_grant_id)||'账号信息不可用'):null};
     });
     results[index]={devices,...(!global?{accounts}:{})};
    }catch(error){
     if(!global||error.status===401||error.status===403){failure=error;return;}
     results[index]={unavailable:true};
    }
   }
  }));
  if(failure)throw failure;authorize();
  if(!global){if(!unchanged(targets[0]))throw new HttpError(409,'customer_changed','Customer changed during device read.');return results[0];}
  const rows=[],unavailable=[];
  for(let index=0;index<targets.length;index++){
   const target=targets[index],result=results[index];
   const owner={user_id:target.id,customer_name:target.display_name,customer_email:target.email,customer_status:target.status};
   if(result.unavailable||!unchanged(target)){unavailable.push(owner);continue;}
   for(const device of result.devices)rows.push({...device,...owner});
  }
  const now=Date.now(),needle=q.trim().toLocaleLowerCase();
  const devices=rows.filter(d=>(!status||deviceStatus(d,now).state===status)&&(!needle||[d.id,d.name,d.platform,d.account_name,d.customer_name,d.customer_email].some(value=>String(value||'').toLocaleLowerCase().includes(needle))));
  // Stable composite identity: upstream IDs need not be unique across customers.
  devices.sort((a,b)=>a.user_id.localeCompare(b.user_id)||a.id.localeCompare(b.id));
  return {devices:devices.slice(offset,offset+limit),total:unavailable.length?null:devices.length,matched_total:devices.length,incomplete:unavailable.length>0,unavailable_customers:unavailable,checked_customers:targets.length,limit,offset};
 }
}
