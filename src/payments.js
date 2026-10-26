import { createHmac, randomUUID } from 'node:crypto';
import { HttpError, digest, equalSecret } from './security.js';
import { publicOrder } from './store.js';

export class Payments {
  constructor(config, store, transport=fetch) { this.config=config; this.store=store; this.transport=transport; }
  async stripeRequest(method,path,form,key) {
    if (!this.config.stripe) throw new HttpError(503,'payment_disabled','Payments are not configured.');
    try {
      const response=await this.transport(`https://api.stripe.com/v1${path}`, { method,headers:{ Authorization:`Bearer ${this.config.stripe.secret}`, ...(form ? {'Content-Type':'application/x-www-form-urlencoded'}:{}), ...(key?{'Idempotency-Key':key}:{}) },body:form?.toString(),signal:AbortSignal.timeout(15000),redirect:'error' });
      if (!response.ok) { await response.body?.cancel(); throw new Error('Stripe rejected'); }
      const chunks=[]; let size=0;
      for await (const chunk of response.body) { size+=chunk.length; if(size>1048576) throw new Error('Stripe response limit'); chunks.push(chunk); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { throw new HttpError(503,method==='GET'?'payment_verification_unavailable':'payment_outcome_unknown',method==='GET'?'Payment confirmation unavailable; webhook may retry safely.':'Checkout creation outcome is unknown. Check your orders; no automatic retry was made.'); }
  }
  async create(userId,amount,rentalId=null) {
    if (!this.config.stripe) throw new HttpError(503,'payment_disabled','Payments are not configured.');
    if (!Number.isSafeInteger(amount) || amount<this.config.paymentMin || amount>this.config.paymentMax) throw new HttpError(400,'invalid_amount',`Amount must be integer minor units between ${this.config.paymentMin} and ${this.config.paymentMax}.`);
    const rental=rentalId?this.store.db.prepare('SELECT * FROM rentals WHERE id=? AND user_id=?').get(rentalId,userId):null;
    if(rentalId && (!rental || rental.status!=='awaiting_payment' || rental.payment_method!=='stripe' || rental.amount_minor!==amount)) throw new HttpError(409,'order_state','Invalid rental checkout.');
    const id=randomUUID(), now=new Date().toISOString();
    this.store.db.prepare("INSERT INTO orders(id,user_id,amount_minor,currency,status,created_at,updated_at,rental_id) VALUES (?,?,?,'CNY','creating',?,?,?)").run(id,userId,amount,now,now,rentalId);
    this.store.audit(userId,'checkout.create',id,'pending');
    const form=new URLSearchParams({ mode:'payment', client_reference_id:id,
      'metadata[order_id]':id,'metadata[user_id]':userId,
      'line_items[0][price_data][currency]':'cny', 'line_items[0][price_data][product_data][name]':rental?`${rental.name} · ${rental.duration_days} days`:'Merchant wallet credit',
      'line_items[0][price_data][unit_amount]':String(amount),'line_items[0][quantity]':'1',
      success_url:`${this.config.publicOrigin}/${rental?'orders':'wallet'}?order=${id}`,cancel_url:`${this.config.publicOrigin}/${rental?'orders':'wallet'}?order=${id}` });
    if(rental) form.set('payment_method_types[0]','card');
    try {
      const session=await this.stripeRequest('POST','/checkout/sessions',form,`merchant-order-${id}`);
      let checkout;
      try { checkout=new URL(session.url); } catch { throw new Error('Missing checkout URL'); }
      if (!/^cs_[A-Za-z0-9_]+$/.test(session.id) || checkout.protocol!=='https:' || checkout.hostname!=='checkout.stripe.com' || checkout.username || checkout.password) throw new Error('Unexpected Checkout response');
      this.store.db.prepare("UPDATE orders SET stripe_session_id=?,checkout_url=?,status=CASE WHEN status IN ('paid','expired','failed') THEN status ELSE 'pending' END,updated_at=? WHERE id=? AND (stripe_session_id IS NULL OR stripe_session_id=?)").run(session.id,checkout.href,new Date().toISOString(),id,session.id);
      return { order:publicOrder(this.store.db.prepare('SELECT * FROM orders WHERE id=?').get(id)),checkout_url:checkout.href };
    } catch(error) {
      this.store.db.prepare("UPDATE orders SET status='unknown',updated_at=? WHERE id=? AND status='creating'").run(new Date().toISOString(),id);
      if(error instanceof HttpError) throw error;
      throw new HttpError(503,'payment_outcome_unknown','Checkout outcome is unknown. Check your orders before starting another payment.');
    }
  }
  async webhook(raw,signature) {
    if (!this.config.stripe) throw new HttpError(503,'payment_disabled','Payments are not configured.');
    if (typeof signature!=='string' || signature.length>2048) throw new HttpError(400,'invalid_signature','Invalid webhook signature.');
    const parts=signature.split(',').map(s=>s.trim().split('='));
    const timestamps=parts.filter(([k])=>k==='t'), signatures=parts.filter(([k])=>k==='v1').map(([,v])=>v);
    const timestamp=Number(timestamps[0]?.[1]);
    const expected=createHmac('sha256',this.config.stripe.webhookSecret).update(`${timestamp}.`).update(raw).digest('hex');
    if(timestamps.length!==1 || !Number.isSafeInteger(timestamp) || Math.abs(Date.now()/1000-timestamp)>300 || !signatures.some(sig=>equalSecret(sig,expected))) throw new HttpError(400,'invalid_signature','Invalid or expired webhook signature.');
    let event; try { event=JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400,'invalid_event','Invalid webhook payload.'); }
    if(typeof event.id!=='string' || !/^evt_[A-Za-z0-9_]{1,200}$/.test(event.id) || event.livemode!==this.config.stripe.live) throw new HttpError(400,'invalid_event','Invalid webhook environment.');
    const bodyDigest=digest(raw);
    const previous=this.store.db.prepare('SELECT digest FROM webhook_events WHERE id=?').get(event.id);
    if(previous) { if(previous.digest!==bodyDigest) throw new HttpError(409,'event_conflict','Webhook event identity conflict.'); return {ok:true}; }
    const relevant=['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed','checkout.session.expired'];
    if(!relevant.includes(event.type)) return {ok:true};
    const reported=event.data?.object;
    if(!reported || !/^cs_[A-Za-z0-9_]+$/.test(reported.id || '')) throw new HttpError(400,'invalid_event','Invalid Checkout session.');
    // The signed event is notification, not a browser-provided claim. Re-read the session server-to-server.
    const session=await this.stripeRequest('GET',`/checkout/sessions/${encodeURIComponent(reported.id)}`);
    if(session.id!==reported.id) throw new HttpError(409,'payment_mismatch','Checkout session identity mismatch.');
    this.confirm(session,{id:event.id,digest:bodyDigest,type:event.type});
    return {ok:true};
  }
  async reconcile(orderId) {
    const order=this.store.db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
    if(!order) throw new HttpError(404,'order_not_found','Order not found.');
    if(!order.stripe_session_id) throw new HttpError(409,'payment_outcome_unknown','No confirmed session ID. Wait for the signed webhook; do not create another payment for this order.');
    const session=await this.stripeRequest('GET',`/checkout/sessions/${encodeURIComponent(order.stripe_session_id)}`);
    if(session.id!==order.stripe_session_id) throw new HttpError(409,'payment_mismatch','Checkout session identity mismatch.');
    this.confirm(session);
    return publicOrder(this.store.db.prepare('SELECT * FROM orders WHERE id=?').get(orderId));
  }
  confirm(session,event=null) {
    const order=this.store.db.prepare('SELECT * FROM orders WHERE id=?').get(session.metadata?.order_id || '');
    if(!order || session.mode!=='payment' || session.livemode!==this.config.stripe.live || session.client_reference_id!==order.id || session.metadata?.user_id!==order.user_id || session.currency!=='cny' || session.amount_total!==order.amount_minor || (order.stripe_session_id && order.stripe_session_id!==session.id)) throw new HttpError(409,'payment_mismatch','Checkout session does not match the immutable order.');
    const now=new Date().toISOString();
    this.store.transaction(()=>{
      if(event) {
        const recorded=this.store.db.prepare('SELECT digest FROM webhook_events WHERE id=?').get(event.id);
        if(recorded) { if(recorded.digest!==event.digest) throw new HttpError(409,'event_conflict','Webhook event identity conflict.'); return; }
      }
      const current=this.store.db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
      if(current.stripe_session_id && current.stripe_session_id!==session.id) throw new HttpError(409,'payment_mismatch','Checkout session identity conflict.');
      const credit=this.store.db.prepare('SELECT reference FROM ledger WHERE order_id=?').get(order.id);
      if(credit && credit.reference!==session.id) throw new HttpError(409,'payment_mismatch','Ledger reference conflict.');
      const paid=session.payment_status==='paid' && session.status==='complete';
      if(paid) {
        if(!credit && !Number.isSafeInteger(this.store.wallet(order.user_id).balance_minor+order.amount_minor)) throw new HttpError(409,'wallet_limit','Wallet safe-integer limit reached; credit requires operator review.');
        this.store.db.prepare("INSERT INTO ledger(id,user_id,order_id,amount_minor,currency,kind,reference,created_at) VALUES (?,?,?,?,'CNY','stripe_credit',?,?) ON CONFLICT(order_id) DO NOTHING").run(randomUUID(),order.user_id,order.id,order.amount_minor,session.id,now);
        if(order.rental_id) {
          const rental=this.store.db.prepare('SELECT * FROM rentals WHERE id=?').get(order.rental_id);
          // A late confirmed payment after an earlier terminal unpaid observation is
          // kept as wallet credit for review, never silently reactivates a cancelled sale.
          if(rental.status!=='cancelled') this.store.fundRental(rental);
          else this.store.db.prepare("UPDATE rentals SET last_error='late_payment_wallet_credit',updated_at=? WHERE id=?").run(now,rental.id);
        }
      }
      const next=paid?'paid':session.status==='expired'?'expired':event?.type==='checkout.session.async_payment_failed'?'failed':'pending';
      this.store.db.prepare("UPDATE orders SET stripe_session_id=?,status=CASE WHEN status='paid' THEN status ELSE ? END,next_check_at=?,updated_at=? WHERE id=?").run(session.id,next,Date.now()+60000,now,order.id);
      if(order.rental_id && current.status!=='paid' && ['expired','failed'].includes(next)) this.store.db.prepare("UPDATE rentals SET status='cancelled',last_error='payment_unpaid',revision=revision+1,updated_at=? WHERE id=? AND status='awaiting_payment'").run(now,order.rental_id);
      this.store.audit(null,event?'checkout.webhook':'checkout.reconcile',order.id,next);
      if(event) this.store.db.prepare('INSERT INTO webhook_events VALUES (?,?,?)').run(event.id,event.digest,now);
    });
  }
}
