// Durable intents live in SQLite; this single-instance worker only schedules them.
export class Reconciler {
 constructor(store,customers,payments,commerce,intervalMs) {Object.assign(this,{store,customers,payments,commerce,intervalMs});this.running=null;this.stopped=false;}
 start() {
  if(!this.intervalMs) return;
  this.timer=setInterval(()=>{this.run().catch(()=>{});},this.intervalMs);this.timer.unref();
 }
 run() {
  if(this.stopped) return Promise.resolve();
  if(this.running) return this.running;
  this.running=(async()=>{
   const db=this.store.db,now=Date.now();
   const users=db.prepare("SELECT id FROM users WHERE next_sync_at<=? AND (core_pending IS NOT NULL OR (status='active' AND core_customer_id IS NULL AND provision_name IS NOT NULL)) ORDER BY next_sync_at LIMIT 10").all(now);
   for(const u of users) {
    if(this.stopped) return;if(this.customers.locks.has(u.id)) continue;
    this.customers.locks.add(u.id);
    try {await this.customers.synchronize(u.id);} catch {} finally {this.customers.locks.delete(u.id);}
   }
   if(this.payments.config.stripe) {
    const orders=db.prepare("SELECT id FROM orders WHERE status IN ('creating','pending','unknown') AND stripe_session_id IS NOT NULL AND next_check_at<=? ORDER BY next_check_at LIMIT 10").all(now);
    for(const o of orders) {if(this.stopped)return;db.prepare('UPDATE orders SET next_check_at=? WHERE id=?').run(Date.now()+60000,o.id);try{await this.payments.reconcile(o.id);}catch{}}
   }
   const pending=db.prepare("SELECT id FROM rentals WHERE status IN ('queued','review','refund_pending') AND attempts<8 AND next_attempt_at<=? ORDER BY created_at,id LIMIT 10").all(Date.now());
   for(const row of pending) {if(this.stopped)return;await this.commerce.deliver(row.id);}
  })().finally(()=>{this.running=null;});
  return this.running;
 }
 async stop() {this.stopped=true;clearInterval(this.timer);await this.running;}
}
