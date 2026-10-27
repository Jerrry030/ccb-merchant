import { randomUUID } from 'node:crypto';
import { HttpError, digest } from './security.js';
import { publicOrder } from './store.js';
import { readPaymentSettings, describePayment } from './payment-settings.js';
import { paymentMethods } from '../public/payment-catalog.js';
import { PaymentProvider, notificationOrder, validateProviderConfig } from './payment-providers.js';

export class Payments {
  constructor(config,store,transport){this.config=config;this.store=store;this.transport=transport;}
  validateIntent(userId,amount,recharge,method) {
    const settings=describePayment(this.config,this.store),available=settings.methods.filter(item=>item.offered);
    if(!settings.configured||(recharge&&!settings.recharge_enabled))throw new HttpError(503,'payment_disabled','New payments are disabled.');
    if(method===undefined&&available.length===1)method=available[0].id;
    const selected=available.find(item=>item.id===method);
    if(!selected)throw new HttpError(400,'invalid_payment_method','Select an available payment method.');
    if(!Number.isSafeInteger(amount)||amount<settings.min_amount_minor||amount>settings.max_amount_minor)throw new HttpError(400,'invalid_amount','Amount outside the configured online payment range.');
    const pending=this.store.db.prepare("SELECT count(*) AS n FROM orders WHERE user_id=? AND status IN ('creating','pending','unknown')").get(userId).n;
    if(pending>=settings.max_pending_orders)throw new HttpError(409,'payment_pending_limit','Finish existing orders before creating another payment.');
    const start=new Date().toISOString().slice(0,10)+'T00:00:00.000Z';
    const used=this.store.db.prepare("SELECT coalesce(sum(amount_minor),0) AS n FROM orders WHERE user_id=? AND created_at>=? AND status NOT IN ('failed','expired')").get(userId,start).n;
    if(settings.daily_limit_minor&&used+amount>settings.daily_limit_minor)throw new HttpError(409,'payment_daily_limit','Daily payment limit reached, including pending reservations.');
    const provider=paymentMethods[selected.id].sources.find(source=>source.id===selected.source).provider;
    const configuration=readPaymentSettings(this.config,this.store).providers[provider];
    validateProviderConfig(provider,configuration);
    return {settings,method:selected.id,provider,configuration};
  }
  provider(order) {
    const configuration=this.store.openPayment(order.provider_config,order.id);
    validateProviderConfig(order.provider,configuration);
    return new PaymentProvider(order.provider,configuration,this.transport,this.config.publicOrigin);
  }
  checkout(order) {
    const data=this.store.openPayment(order.checkout_data,'checkout:'+order.id);
    // The Airwallex intent secret is owner-scoped, encrypted at rest, and only
    // returned by the dedicated checkout endpoint, never in lists or audit data.
    return {order:publicOrder(order),checkout_url:data.url||null,checkout_origin:data.url?new URL(data.url).origin:null,qr_available:Boolean(data.qr),checkout_path:data.airwallex?'/airwallex-checkout.html?order='+encodeURIComponent(order.id):null};
  }
  async create(userId,amount,{rentalId=null,method,clientIp='127.0.0.1'}={}) {
    const rental=rentalId?this.store.db.prepare('SELECT * FROM rentals WHERE id=? AND user_id=?').get(rentalId,userId):null;
    if(rentalId&&(!rental||rental.status!=='awaiting_payment'||rental.payment_method==='wallet'||rental.amount_minor!==amount||rental.payment_method!==method))throw new HttpError(409,'order_state','Invalid rental checkout.');
    const id=randomUUID().replaceAll('-',''),now=new Date().toISOString();let intent;
    this.store.transaction(()=>{
      intent=this.validateIntent(userId,amount,!rentalId,method);
      this.store.db.prepare("INSERT INTO orders(id,user_id,amount_minor,currency,status,created_at,updated_at,rental_id,provider,payment_method,provider_config,checkout_data) VALUES (?,?,?,'CNY','creating',?,?,?,?,?,?,?)").run(id,userId,amount,now,now,rentalId,intent.provider,intent.method,this.store.sealPayment(intent.configuration,id),this.store.sealPayment({},'checkout:'+id));
      this.store.audit(userId,'checkout.create',id,'pending');
    });
    const order=this.store.db.prepare('SELECT * FROM orders WHERE id=?').get(id);
    try {
      const result=await this.provider(order).create(order,{subject:rental?rental.name+' · '+rental.duration_days+' days':intent.settings.product_name,clientIp,expiresAt:Math.floor(Date.now()/1000)+Math.min(86400,intent.settings.order_timeout_minutes*60+30)});
      if(result.qr&&(typeof result.qr!=='string'||result.qr.length>4096||!/^https:\/\/|^weixin:\/\/wxpay\/bizpayurl\?|^alipays:\/\//.test(result.qr)))throw new Error('Invalid payment QR payload');
      if(!result.url&&!result.qr&&!result.airwallex)throw new Error('Missing checkout instructions');
      const changed=this.store.db.prepare("UPDATE orders SET provider_reference=coalesce(?,provider_reference),checkout_data=?,status=CASE WHEN status IN ('paid','expired','failed') THEN status ELSE 'pending' END,updated_at=? WHERE id=? AND (provider_reference IS NULL OR ? IS NULL OR provider_reference=?)").run(result.reference||null,this.store.sealPayment(result,'checkout:'+id),new Date().toISOString(),id,result.reference||null,result.reference||null);
      if(changed.changes!==1)throw new Error('Conflicting provider identity');
      return this.checkout(this.store.db.prepare('SELECT * FROM orders WHERE id=?').get(id));
    }catch {
      this.store.db.prepare("UPDATE orders SET status='unknown',updated_at=? WHERE id=? AND status='creating'").run(new Date().toISOString(),id);
      throw new HttpError(503,'payment_outcome_unknown','Payment creation outcome is unknown; inspect the existing order. No automatic retry was made.');
    }
  }
  async webhook(provider,raw,headers,selectedOrder) {
    let id;
    try{
      if(provider==='wxpay'&&!selectedOrder){
        const current=readPaymentSettings(this.config,this.store).providers.wxpay;
        validateProviderConfig('wxpay',current);
        const decoded=new PaymentProvider('wxpay',current,this.transport,this.config.publicOrigin).decodeWxNotification(raw.toString('utf8'),headers);
        if(!decoded.data)return;
        id=decoded.data.out_trade_no;
      }else id=selectedOrder||notificationOrder(provider,raw.toString('utf8'));
    }catch{throw new HttpError(400,'invalid_signature','Invalid payment notification.');}
    const order=typeof id==='string'?this.store.db.prepare('SELECT * FROM orders WHERE id=? AND provider=?').get(id,provider):null;
    if(!order)throw new HttpError(400,'invalid_signature','Unrecognized payment notification.');
    const adapter=this.provider(order);let notification;
    try{notification=adapter.notification(raw.toString('utf8'),headers,order);}catch(error){if(error instanceof HttpError&&error.status===409)throw error;throw new HttpError(400,'invalid_signature','Invalid payment signature or payload.');}
    if(!notification)return;
    const event={id:provider+':'+notification.eventId,digest:digest(raw),type:notification.eventType};
    const prior=this.store.db.prepare('SELECT digest FROM webhook_events WHERE id=?').get(event.id);
    if(prior){if(prior.digest!==event.digest)throw new HttpError(409,'event_conflict','Webhook event identity conflict.');return;}
    let observation;
    try{observation=await adapter.query(order,notification.reference||order.provider_reference);}catch(error){if(error instanceof HttpError&&error.code==='payment_mismatch')throw error;throw new HttpError(503,'payment_verification_unavailable','Provider confirmation unavailable; notification may retry safely.');}
    if(notification.reference&&observation.reference!==notification.reference)throw new HttpError(409,'payment_mismatch','Notification and query identities differ.');
    if(event.type==='checkout.session.async_payment_failed'&&observation.status==='pending')observation.status='failed';
    this.confirm(order,observation,event);
  }
  async reconcile(orderId) {
    const order=this.store.db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
    if(!order)throw new HttpError(404,'order_not_found','Order not found.');
    try{const result=await this.provider(order).query(order);this.confirm(order,result);}catch(error){if(error instanceof HttpError)throw error;throw new HttpError(503,'payment_verification_unavailable','Provider confirmation unavailable.');}
    return publicOrder(this.store.db.prepare('SELECT * FROM orders WHERE id=?').get(orderId));
  }
  confirm(order,observation,event=null) {
    const now=new Date().toISOString();
    this.store.transaction(()=>{
      if(event){const recorded=this.store.db.prepare('SELECT digest FROM webhook_events WHERE id=?').get(event.id);if(recorded){if(recorded.digest!==event.digest)throw new HttpError(409,'event_conflict','Webhook event identity conflict.');return;}}
      const current=this.store.db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
      if(current.provider_reference&&observation.reference&&current.provider_reference!==observation.reference)throw new HttpError(409,'payment_mismatch','Provider transaction identity conflict.');
      const credit=this.store.db.prepare('SELECT reference FROM ledger WHERE order_id=?').get(order.id);
      const receipt=order.provider==='stripe'?observation.reference:order.provider+':'+observation.reference;
      if(credit&&observation.reference&&credit.reference!==receipt)throw new HttpError(409,'payment_mismatch','Ledger reference conflict.');
      const paid=observation.status==='paid';
      if(paid){
        if(!observation.reference)throw new HttpError(409,'payment_mismatch','Paid receipt has no transaction identity.');
        if(!credit&&!Number.isSafeInteger(this.store.wallet(order.user_id).balance_minor+order.amount_minor))throw new HttpError(409,'wallet_limit','Wallet safe integer limit reached.');
        this.store.db.prepare("INSERT INTO ledger(id,user_id,order_id,amount_minor,currency,kind,reference,created_at) VALUES (?,?,?,?,'CNY',?,?,?) ON CONFLICT(order_id) DO NOTHING").run(randomUUID(),order.user_id,order.id,order.amount_minor,order.provider==='stripe'?'stripe_credit':'payment_credit',receipt,now);
        if(order.rental_id){const rental=this.store.db.prepare('SELECT * FROM rentals WHERE id=?').get(order.rental_id);if(rental.status!=='cancelled')this.store.fundRental(rental);else this.store.db.prepare("UPDATE rentals SET last_error='late_payment_wallet_credit',updated_at=? WHERE id=?").run(now,rental.id);}
      }
      this.store.db.prepare("UPDATE orders SET provider_reference=coalesce(?,provider_reference),status=CASE WHEN status='paid' THEN status ELSE ? END,next_check_at=?,updated_at=? WHERE id=?").run(observation.reference,observation.status,Date.now()+60000,now,order.id);
      if(order.rental_id&&current.status!=='paid'&&['expired','failed'].includes(observation.status))this.store.db.prepare("UPDATE rentals SET status='cancelled',last_error='payment_unpaid',revision=revision+1,updated_at=? WHERE id=? AND status='awaiting_payment'").run(now,order.rental_id);
      this.store.audit(null,event?'checkout.webhook':'checkout.reconcile',order.id,observation.status);
      if(event)this.store.db.prepare('INSERT INTO webhook_events VALUES (?,?,?)').run(event.id,event.digest,now);
    });
  }
}
