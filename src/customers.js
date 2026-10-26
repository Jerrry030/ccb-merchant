import { HttpError, opaqueId } from './security.js';
import { project, schemas } from './upstream.js';

export class Customers {
 constructor(store,core) { this.store=store;this.core=core;this.locks=new Set(); }
 async synchronize(userId,authorize=()=>{}) {
  const db=this.store.db;
  const before=db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if(!before) throw new HttpError(404,'user_not_found','User not found.');
  if(!before.core_customer_id && before.status!=='active') throw new HttpError(409,'user_inactive','Only active customers can be provisioned.');
  const name=before.provision_name || before.display_name;
  if(!before.core_customer_id) db.prepare('UPDATE users SET provision_name=? WHERE id=?').run(name,userId);
  const desired=before.core_pending?JSON.parse(before.core_pending):null;
  const check=()=>{
   authorize();
   const current=db.prepare('SELECT * FROM users WHERE id=?').get(userId);
   if(!current || current.core_pending!==before.core_pending || current.status!==before.status || current.display_name!==before.display_name || current.core_customer_id!==before.core_customer_id) throw new HttpError(409,'customer_changed','Customer changed while synchronization was in progress.');
  };
  try {
   const list=await this.core.request('GET',`/merchant/v1/customers?external_id=${encodeURIComponent(userId)}`); check();
   if(!Array.isArray(list.customers)) throw new HttpError(503,'invalid_core_response','Invalid customer list.');
   let customer=list.customers.map(c=>project(c,schemas.customer)).find(c=>c?.external_id===userId);
   if(before.core_customer_id) {
    if(customer?.id!==before.core_customer_id) throw new HttpError(409,'immutable_mapping','Existing customer mapping could not be verified.');
    if(desired && (customer.status!==desired.status || customer.display_name!==desired.display_name)) {
     const data=await this.core.request('PATCH',`/merchant/v1/customers/${opaqueId(customer.id)}`,{expected_revision:customer.revision,...desired});
     customer=project(data.customer,schemas.customer);check();
    }
    if(customer?.id!==before.core_customer_id || customer.external_id!==userId || (desired && (customer.status!==desired.status || customer.display_name!==desired.display_name))) throw new HttpError(503,'core_sync_pending','Customer synchronization is unconfirmed.');
   } else {
    if(!customer) {const data=await this.core.request('POST','/merchant/v1/customers',{external_id:userId,display_name:name});customer=project(data.customer,schemas.customer);check();}
    if(!customer?.id || customer.external_id!==userId || customer.display_name!==name || customer.status!=='active') throw new HttpError(409,'customer_conflict','Existing customer differs from the persisted provisioning request.');
   }
   check();
   this.store.transaction(()=>{
    db.prepare('UPDATE users SET core_customer_id=?,status=?,core_pending=NULL,sync_attempts=0,next_sync_at=0,sync_error=NULL WHERE id=?').run(customer.id,desired?.status || before.status,userId);
    this.store.audit(null,before.core_customer_id?'customer.reconciled':'customer.provision',userId);
   });
   return customer;
  } catch(error) {
   const code=error instanceof HttpError?error.code:'core_sync_pending';
   db.prepare('UPDATE users SET sync_attempts=sync_attempts+1,next_sync_at=?,sync_error=? WHERE id=?').run(Date.now()+Math.min(300000,5000*2**Math.min(before.sync_attempts||0,6)),code,userId);
   throw error;
  }
 }
}
