import { randomUUID } from 'node:crypto';
import { HttpError, fields, text, opaqueId } from './security.js';
import { project, schemas } from './upstream.js';
import { publicRental } from './store.js';

export function publicPlan(row,admin=false) {
 return {id:row.id,name:row.name,description:row.description,duration_days:row.duration_days,amount_minor:row.amount_minor,currency:row.currency,status:row.status,revision:row.revision,...(admin?{resource_id:row.resource_id}:{})};
}
export class Commerce {
 constructor(store,core,customers) {this.store=store;this.core=core;this.customers=customers;this.running=new Set();}
 async savePlan(id,body,authorize) {
  fields(body,['name','description','resource_id','duration_days','amount_minor','status','expected_revision'],['name','duration_days','amount_minor','status',...(id?['expected_revision']:['resource_id'])]);
  const name=text(body.name,'name',100),description=text(body.description??'','description',1000,0);
  if(!Number.isSafeInteger(body.duration_days)||body.duration_days<1||body.duration_days>366||!Number.isSafeInteger(body.amount_minor)||body.amount_minor<1||body.amount_minor>100000000||!['active','archived'].includes(body.status)) throw new HttpError(400,'invalid_plan','Invalid term, price or status.');
  const prior=id?this.store.db.prepare('SELECT * FROM plans WHERE id=?').get(id):null;
  if(id && !prior) throw new HttpError(404,'plan_not_found','Plan not found.');
  if(id && (body.expected_revision!==prior.revision || (body.resource_id!==undefined && body.resource_id!==prior.resource_id))) throw new HttpError(409,'plan_conflict','Refresh the plan; its resource cannot be changed.');
  const resourceId=prior?.resource_id || text(body.resource_id,'resource_id',150);
  if(body.status==='active') {
   const data=await this.core.request('GET','/merchant/v1/resources');
   const r=data.resources?.find(r=>r.id===resourceId);
   if(!r || r.status!=='active' || r.available!==true || !r.surfaces?.includes('code') || (r.expires_at && Date.parse(r.expires_at)<Date.now()+body.duration_days*86400000)) throw new HttpError(409,'supply_unavailable','Supply cannot cover this term.');
  }
  const actor=authorize();const now=new Date().toISOString();
  return this.store.transaction(()=>{
   if(id) {
    const result=this.store.db.prepare('UPDATE plans SET name=?,description=?,duration_days=?,amount_minor=?,status=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?').run(name,description,body.duration_days,body.amount_minor,body.status,now,id,body.expected_revision);
    if(result.changes!==1) throw new HttpError(409,'plan_conflict','Plan was changed by another operation.');
   } else {id=randomUUID();this.store.db.prepare("INSERT INTO plans VALUES(?,?,?,?,?,?,'CNY',?,1,?,?)").run(id,name,description,resourceId,body.duration_days,body.amount_minor,body.status,now,now);}
   this.store.audit(actor?.user?.id || null,'plan.save',id);return publicPlan(this.store.db.prepare('SELECT * FROM plans WHERE id=?').get(id),true);
  });
 }
 async purchase(userId,body,authorize) {
  fields(body,['plan_id','expected_revision','payment_method','request_id'],['plan_id','expected_revision','payment_method','request_id']);
  const requestId=text(body.request_id,'request_id',100);
  if(!/^[A-Za-z0-9_-]{16,100}$/.test(requestId)||!['wallet','stripe'].includes(body.payment_method)||!Number.isSafeInteger(body.expected_revision)) throw new HttpError(400,'invalid_purchase','Invalid purchase intent.');
  const replay=this.store.db.prepare('SELECT * FROM rentals WHERE user_id=? AND request_id=?').get(userId,requestId);
  if(replay) {
   if(replay.plan_id!==body.plan_id||replay.plan_revision!==body.expected_revision||replay.payment_method!==body.payment_method) throw new HttpError(409,'purchase_conflict','Request identity already belongs to a different purchase.');
   return {rental:publicRental(replay),created:false};
  }
  const plan=this.store.db.prepare('SELECT * FROM plans WHERE id=?').get(text(body.plan_id,'plan_id',150));
  if(!plan || plan.status!=='active'||plan.revision!==body.expected_revision) throw new HttpError(409,'plan_changed','Refresh the catalog and confirm the current price.');
  if(this.customers.locks.has(userId)) throw new HttpError(409,'user_busy','Customer synchronization is in progress.');
  this.customers.locks.add(userId);
  try {
   let user=this.store.db.prepare('SELECT * FROM users WHERE id=?').get(userId);
   if(user.status!=='active'||user.core_pending) throw new HttpError(409,'customer_not_ready','Customer synchronization must finish first.');
   if(!user.core_customer_id) {await this.customers.synchronize(userId,authorize);user=this.store.db.prepare('SELECT * FROM users WHERE id=?').get(userId);}
   const [supply,existing]=await Promise.all([this.core.request('GET','/merchant/v1/resources'),this.core.request('GET',`/merchant/v1/grants?customer_id=${opaqueId(user.core_customer_id)}&resource_id=${opaqueId(plan.resource_id)}`)]);
   authorize();
   if(!Array.isArray(supply.resources)||!Array.isArray(existing.grants))throw new HttpError(503,'invalid_core_response','Core returned invalid supply metadata.');
   const r=supply.resources.find(r=>r.id===plan.resource_id);
   const grant=existing.grants?.find(g=>g.customer_id===user.core_customer_id&&g.resource_id===plan.resource_id);
   if(grant?.pending)throw new HttpError(409,'grant_pending','An earlier grant change must be reconciled before purchasing.');
   const active=grant?.status==='active'&&(!grant.expires_at||Date.parse(grant.expires_at)>Date.now());
   const start=active?Date.parse(grant.expires_at):Date.now();
   if(!r||r.status!=='active'||r.available!==true||!r.surfaces?.includes('code')||(r.expires_at&&!Number.isFinite(Date.parse(r.expires_at)))||!Number.isFinite(start)||(r.expires_at&&start+plan.duration_days*86400000>Date.parse(r.expires_at))) throw new HttpError(409,'supply_unavailable','Supply cannot cover this purchase or renewal.');
   return this.store.transaction(()=>{
    const fresh=this.store.db.prepare('SELECT * FROM plans WHERE id=?').get(plan.id);
    if(fresh.status!=='active'||fresh.revision!==plan.revision) throw new HttpError(409,'plan_changed','Plan changed before checkout.');
    const pending=this.store.db.prepare("SELECT user_id FROM rentals WHERE resource_id=? AND status IN ('awaiting_payment','queued','review','refund_pending')").all(plan.resource_id);
    if(pending.some(p=>p.user_id===userId)) throw new HttpError(409,'purchase_pending','An order for this resource is still pending. Review it before another purchase.');
    const id=randomUUID(),now=new Date().toISOString();
    this.store.db.prepare("INSERT INTO rentals(id,user_id,request_id,plan_id,plan_revision,name,resource_id,duration_days,amount_minor,currency,payment_method,status,customer_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'CNY',?,'awaiting_payment',?,?,?)").run(id,userId,requestId,plan.id,plan.revision,plan.name,plan.resource_id,plan.duration_days,plan.amount_minor,body.payment_method,user.core_customer_id,now,now);
    const row=this.store.db.prepare('SELECT * FROM rentals WHERE id=?').get(id);
    if(body.payment_method==='wallet') this.store.fundRental(row);
    this.store.audit(userId,'rental.create',id);
    return {rental:publicRental(this.store.db.prepare('SELECT * FROM rentals WHERE id=?').get(id)),created:true};
   });
  } finally {this.customers.locks.delete(userId);}
 }
 async deliver(id) {
  if(this.running.has(id)) return;
  const db=this.store.db,row=db.prepare('SELECT * FROM rentals WHERE id=?').get(id);
  if(!row||!['queued','review','refund_pending'].includes(row.status)) return;
  this.running.add(id);
  const action=row.status==='refund_pending'?'cancel':'fulfill';
  try {
   const user=db.prepare('SELECT * FROM users WHERE id=?').get(row.user_id);
   if(action==='fulfill' && (user.status!=='active'||user.core_pending||user.core_customer_id!==row.customer_id)) throw new HttpError(409,'customer_not_ready','Customer is disabled or synchronization is pending.');
   const data=await this.core.request('PUT',`/merchant/v1/fulfillments/${opaqueId(row.id)}`,{customer_id:row.customer_id,resource_id:row.resource_id,duration_days:row.duration_days,action});
   const f=data.fulfillment;
   if(!f||f.order_id!==row.id||f.customer_id!==row.customer_id||f.resource_id!==row.resource_id||f.duration_days!==row.duration_days||!['fulfilled','cancelled'].includes(f.status)||(f.status==='fulfilled'&&(!f.grant_id||!Number.isFinite(Date.parse(f.expires_at))))) throw new HttpError(503,'fulfillment_unconfirmed','Core fulfillment receipt is invalid.');
   this.store.transaction(()=>{
    const current=db.prepare('SELECT * FROM rentals WHERE id=?').get(id);
    if(['fulfilled','refunded'].includes(current.status)) return;
    const now=new Date().toISOString();
    if(f.status==='cancelled') {
     if(!db.prepare("SELECT 1 FROM ledger WHERE rental_id=? AND kind='rental_debit'").get(id)) throw new HttpError(409,'missing_debit','Cannot refund an unfunded order.');
     if(!Number.isSafeInteger(this.store.wallet(row.user_id).balance_minor+row.amount_minor)) throw new HttpError(409,'wallet_limit','Wallet limit reached.');
     db.prepare("INSERT INTO ledger(id,user_id,amount_minor,currency,kind,reference,created_at,rental_id) VALUES(?,?,?,'CNY','rental_refund',?,?,?) ON CONFLICT(reference) DO NOTHING").run(randomUUID(),row.user_id,row.amount_minor,`rental:${id}:refund`,now,id);
    }
    db.prepare('UPDATE rentals SET status=?,grant_id=?,expires_at=?,last_error=?,revision=revision+1,updated_at=? WHERE id=?').run(f.status==='fulfilled'?'fulfilled':'refunded',f.grant_id||null,f.expires_at||null,f.status==='fulfilled'&&current.status==='refund_pending'?'already_fulfilled':null,now,id);
    this.store.audit(null,f.status==='fulfilled'?'rental.fulfilled':'rental.refunded',id);
   });
  } catch(error) {
   const code=error instanceof HttpError?error.code:'fulfillment_unconfirmed';
   db.prepare("UPDATE rentals SET status=CASE WHEN status='refund_pending' THEN status ELSE 'review' END,attempts=attempts+1,next_attempt_at=?,last_error=?,revision=revision+1,updated_at=? WHERE id=? AND status IN ('queued','review','refund_pending')").run(Date.now()+Math.min(300000,5000*2**Math.min(row.attempts,6)),code,new Date().toISOString(),id);
  } finally {this.running.delete(id);}
 }
}
