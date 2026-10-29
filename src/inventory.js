import { HttpError, fields, text, opaqueId, expiry } from './security.js';
import { project, schemas } from './upstream.js';

export class Inventory {
 constructor(store,core,customers){Object.assign(this,{store,core,customers});this.running=new Set();}
 async read(exceptBatch='') {
  const data=await this.core.request('GET','/access/v1/accounts');
  if(!Array.isArray(data.accounts))throw new HttpError(503,'invalid_core_response','Inventory is unavailable.');
  const resourceNames=new Map();try{const listed=await this.core.request('GET','/access/v1/resources');for(const r of listed.resources||[])if(typeof r.id==='string'&&typeof r.name==='string')resourceNames.set(r.id,r.name.slice(0,200));}catch{/* Public resource labels are optional; do not substitute upstream account names. */}
  const users=new Map(this.store.db.prepare('SELECT id,display_name,email,core_customer_id FROM users WHERE core_customer_id IS NOT NULL').all().map(u=>[u.core_customer_id,u]));
  const held=this.store.accountHolds(exceptBatch);
  const rows=data.accounts.map(row=>{const a=project(row,schemas.heldAccount);if(!a?.id)throw new HttpError(503,'invalid_core_response','Inventory row is invalid.');return {...a,resource_name:resourceNames.get(a.resource_id)||''};});
  return this.store.labelAccounts(rows,true).map(a=>{const u=a.assigned?users.get(a.customer_id):null;const hold=held.get(a.id);return {...a,user_id:u?.id||null,customer_name:u?.display_name||null,customer_email:u?.email||null,hold_reason:hold?.reason||null,hold_order_id:hold?.order_id||null,hold_batch_id:hold?.batch_id||null};});
 }
 async assign(body,authorize,{batchId='',accounts=null}={}) {
          fields(body,['user_id','resource_id','expires_at','account_lease_id','expected_account_revision'],['user_id','resource_id']);
          const targetId=text(body.user_id,'user_id',150);
          const payload={resource_id:decodeURIComponent(opaqueId(body.resource_id))};
          let accountLabel=null;
          if(body.expires_at!==undefined) payload.expires_at=expiry(body.expires_at);
          if(body.account_lease_id) {
            payload.account_lease_id=decodeURIComponent(opaqueId(body.account_lease_id));
            if(!Number.isSafeInteger(body.expected_account_revision)||body.expected_account_revision<1)throw new HttpError(400,'invalid_input','Refresh the account before delivery.');
            payload.expected_account_revision=body.expected_account_revision;
          }
          if(this.customers.locks.has(targetId))throw new HttpError(409,'user_busy','A customer change is in progress. Retry this delivery after it completes.');
          this.customers.locks.add(targetId);
          try {
            let target=this.store.db.prepare('SELECT * FROM users WHERE id=?').get(targetId);
            if(!target||target.status!=='active'||target.core_pending)throw new HttpError(409,'customer_not_ready','Select an active customer with no pending changes.');
            if(payload.account_lease_id) {
              const owned={accounts:accounts||await this.read(batchId)};authorize();
              if(!Array.isArray(owned.accounts))throw new HttpError(503,'invalid_core_response','Account inventory is unavailable.');
              const account=owned.accounts.find(a=>a.id===payload.account_lease_id);
              if(!account||account.resource_id!==payload.resource_id||account.status!=='active'||!Number.isFinite(Date.parse(account.expires_at))||Date.parse(account.expires_at)<=Date.now())throw new HttpError(409,'account_unavailable','This account is no longer available. Refresh the inventory.');
              if(account.allow_delegation!==true)throw new HttpError(409,'delegation_forbidden','This allocation cannot be delegated.');
              const hold=this.store.accountHolds(batchId).get(account.id);if(hold)throw new HttpError(409,hold.reason,'This allocation is reserved. Reconcile the existing operation.');
              accountLabel=typeof account.details?.name==='string'?account.details.name.slice(0,200):account.id;
              payload.expires_at??=account.expires_at;
              if(Date.parse(payload.expires_at)>Date.parse(account.expires_at)||Date.parse(payload.expires_at)<=Date.now())throw new HttpError(400,'invalid_expiry','Customer expiry must be in the future and within the account expiry.');
              if(account.revision!==payload.expected_account_revision && !(account.revision===payload.expected_account_revision+1&&account.assigned&&account.customer_id===target.core_customer_id))throw new HttpError(409,'account_changed','The account changed. Refresh before assigning it.');
              if(account.assigned&&account.customer_id!==target.core_customer_id)throw new HttpError(409,'account_assigned','Reclaim the current assignment before choosing another customer.');
              if(!['available','limited'].includes(account.details?.state))throw new HttpError(409,'account_unavailable','This account is currently unavailable.');
              if(this.store.db.prepare("SELECT 1 FROM rentals WHERE account_lease_id=? AND status IN ('awaiting_payment','queued','review','refund_pending')").get(account.id))throw new HttpError(409,'purchase_pending','Account is reserved by a customer checkout.');
            }
            if(!target.core_customer_id)await this.customers.synchronize(targetId,()=>authorize());
            authorize();
            target=this.store.db.prepare('SELECT * FROM users WHERE id=?').get(targetId);
            if(!target?.core_customer_id||target.status!=='active'||target.core_pending)throw new HttpError(409,'customer_not_ready','Customer state changed. Refresh before delivery.');
            payload.customer_id=target.core_customer_id;
            const data=await this.core.request('POST','/access/v1/grants',payload), grant=project(data.grant,schemas.grant);
            try{authorize();}catch{throw new HttpError(503,'core_outcome_unknown','Permission changed after submission. An authorized operator must reconcile this allocation.');}
            if(!grant?.id||grant.status!=='active'||grant.customer_id!==target.core_customer_id||grant.resource_id!==payload.resource_id||(payload.account_lease_id&&(grant.account_lease_id!==payload.account_lease_id||Date.parse(grant.expires_at)!==Date.parse(payload.expires_at))))throw new HttpError(503,'core_outcome_unknown','Delivery is unconfirmed. Check the account before retrying the same assignment.');
            if(accountLabel){grant.name=accountLabel;this.store.labelAccounts([{id:grant.id,grant_id:grant.id,account_lease_id:payload.account_lease_id}]);}
            this.store.audit(authorize().user.id,'grant.create',grant.id,'ok',{customer_id:targetId,subject_label:accountLabel,details:{batch_id:batchId||null,expires_at:grant.expires_at}});return grant;
          } finally {this.customers.locks.delete(targetId);}
 }
 async batch(body,authorize) {
  fields(body,['id','action','items'],['id','action']);
  const id=text(body.id,'id',100);if(!/^[A-Za-z0-9_-]{16,100}$/.test(id)||!['preview','execute','reconcile','cancel'].includes(body.action))throw new HttpError(400,'invalid_batch','Invalid batch identity or action.');
  let row=this.store.db.prepare('SELECT * FROM allocation_batches WHERE id=?').get(id);
  let intent;
  if(body.items!==undefined){
   if(!Array.isArray(body.items)||!body.items.length||body.items.length>100)throw new HttpError(400,'invalid_batch','Select between 1 and 100 allocations.');
   const seen=new Set();intent=body.items.map(item=>{
    fields(item,['user_id','resource_id','account_lease_id','expected_account_revision','expires_at'],['user_id','resource_id','account_lease_id','expected_account_revision','expires_at']);
    const value={user_id:text(item.user_id,'user_id',150),resource_id:opaqueId(item.resource_id),account_lease_id:opaqueId(item.account_lease_id),expected_account_revision:item.expected_account_revision,expires_at:expiry(item.expires_at)};
    if(!value.expires_at||!Number.isSafeInteger(value.expected_account_revision)||value.expected_account_revision<1||seen.has(value.account_lease_id))throw new HttpError(400,'invalid_batch','Select each allocation once with its revision and expiry.');seen.add(value.account_lease_id);return value;
   });
   if(row&&row.intent!==JSON.stringify(intent))throw new HttpError(409,'batch_changed','The saved batch is immutable. Create a new batch for a different intent.');
  } else if(row) intent=JSON.parse(row.intent);else throw new HttpError(404,'batch_not_found','Batch not found.');
  const actorId=authorize().user.id;
  if(body.action==='preview'){
   const accounts=await this.read(id);authorize();const byID=new Map(accounts.map(a=>[a.id,a]));
   const items=intent.map(item=>{const account=byID.get(item.account_lease_id),user=this.store.db.prepare('SELECT * FROM users WHERE id=?').get(item.user_id);let error=null;
    if(!user||user.status!=='active'||user.core_pending)error='customer_not_ready';
    else if(!account||account.status!=='active'||!Number.isFinite(Date.parse(account.expires_at))||Date.parse(account.expires_at)<=Date.now()||account.resource_id!==item.resource_id||!['available','limited'].includes(account.details?.state)||account.assigned||account.revision!==item.expected_account_revision)error='account_changed';
    else if(account.allow_delegation!==true)error='delegation_forbidden';else if(account.hold_reason)error=account.hold_reason;
    else if(Date.parse(item.expires_at)<=Date.now()||Date.parse(item.expires_at)>Date.parse(account.expires_at))error='invalid_expiry';
    return {intent:item,account_code:account?.account_code||null,customer_name:user?.display_name||null,status:error?'failed':'ready',error};
   });return {id,preview:true,ready:items.every(item=>!item.error),items};
  }
  if(this.running.has(id))throw new HttpError(409,'batch_busy','Batch is running. Read its saved results.');
  if(!row){
   if(body.action!=='execute')throw new HttpError(404,'batch_not_found','Batch not found.');
   const now=new Date().toISOString(),actor=authorize().user;
   this.store.transaction(()=>{
    const holds=this.store.accountHolds();
    const initial=intent.map(value=>{const code=this.store.db.prepare('SELECT number FROM account_codes WHERE lease_id=?').get(value.account_lease_id),u=this.store.db.prepare('SELECT display_name FROM users WHERE id=?').get(value.user_id),hold=holds.get(value.account_lease_id);return {intent:value,account_code:code?'账号#'+code.number:null,customer_name:u?.display_name||null,status:hold?'failed':'pending',error:hold?.reason||null};});
    this.store.db.prepare('INSERT INTO allocation_batches VALUES(?,?,?,?,?,?,?)').run(id,actor.id,JSON.stringify(intent),JSON.stringify(initial),initial.some(i=>i.status==='pending')?'pending':'complete',now,now);
   });
   row=this.store.db.prepare('SELECT * FROM allocation_batches WHERE id=?').get(id);
  }
  this.running.add(id);let items=JSON.parse(row.items);
  const save=()=>{const status=items.some(i=>i.status==='running')?'running':items.some(i=>i.status==='review')?'review':items.some(i=>i.status==='pending')?'pending':'complete';this.store.db.prepare('UPDATE allocation_batches SET items=?,status=?,updated_at=? WHERE id=?').run(JSON.stringify(items),status,new Date().toISOString(),id);};
  try {
   const snapshot=body.action==='cancel'?null:await this.read(id);authorize();
   for(const item of items){
    authorize();
    if(body.action==='cancel'){if(item.status==='pending'){item.status='cancelled';save();}continue;}
    if(item.status==='review'){
     try{authorize();const a=snapshot.find(a=>a.id===item.intent.account_lease_id);const user=this.store.db.prepare('SELECT * FROM users WHERE id=?').get(item.intent.user_id);
      if(a?.assigned&&a.status==='active'&&Date.parse(a.expires_at)>Date.now()&&Date.parse(a.customer_expires_at)>Date.now()&&a.user_id===user?.id&&a.revision===item.intent.expected_account_revision+1&&Date.parse(a.customer_expires_at)===Date.parse(item.intent.expires_at)){
       item.status='succeeded';item.error=null;item.account_code=a.account_code;item.grant_id=a.grant_id;save();
       this.store.audit(actorId,'grant.reconciled',a.grant_id,'ok',{customer_id:user.id,subject_label:a.account_code,details:{batch_id:id}});
      }
     }catch{ /* Unknown remains reserved; reconciliation never sends a write. */ }
     continue;
    }
    if(body.action!=='execute'||item.status!=='pending')continue;
    item.status='running';save();
    try{const grant=await this.assign(item.intent,authorize,{batchId:id,accounts:snapshot});item.status='succeeded';item.grant_id=grant.id;item.account_code=grant.name;item.error=null;}
    catch(error){item.status=!(error instanceof HttpError)||error.status>=500||/unknown|uncertain|timeout/.test(error.code||'')?'review':'failed';item.error=error instanceof HttpError?error.code:'outcome_unknown';}
    const number=this.store.db.prepare('SELECT number FROM account_codes WHERE lease_id=?').get(item.intent.account_lease_id);if(number)item.account_code='账号#'+number.number;
    if(item.status!=='succeeded')this.store.audit(actorId,'grant.batch_item',item.intent.account_lease_id,item.status,{customer_id:item.intent.user_id,subject_label:item.account_code||null,details:{batch_id:id,error:item.error}});
    save();
   }
  } catch(error){if(items.some(i=>['running','review','succeeded'].includes(i.status)))throw new HttpError(503,'core_outcome_unknown','The batch has recorded outcomes. Reconcile it with an authorized session before further action.');throw error;} finally {save();this.running.delete(id);}
  const saved=this.store.db.prepare('SELECT * FROM allocation_batches WHERE id=?').get(id);
  try{authorize();}catch{throw new HttpError(503,'core_outcome_unknown','Permission changed; an authorized operator must read the saved batch.');}return {id,status:saved.status,items,created_at:saved.created_at,updated_at:saved.updated_at};
 }

}
