import { readPaymentSettings } from './payment-settings.js';

// Rebuild CHECK-constrained tables in one transaction without renaming referenced
// originals. Foreign keys are disabled only for this connection and verified before commit.
export function migratePaymentSchema(config,store) {
  const db=store.db;
  if(db.prepare('PRAGMA table_info(orders)').all().some(column=>column.name==='provider_config'))return;
  db.exec('PRAGMA foreign_keys=OFF');
  try {store.transaction(()=>{
    const legacyCheckouts=new Map(db.prepare('SELECT id,checkout_url FROM orders').all().map(order=>[order.id,order.checkout_url]));
    for(const table of ['orders','rentals','ledger']) {
      let sql=db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table).sql;
      const objects=db.prepare("SELECT sql FROM sqlite_schema WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL").all(table);
      const columns=db.prepare('PRAGMA table_info('+table+')').all().map(column=>column.name).filter(column=>table!=='orders'||column!=='checkout_url');
      sql=sql.replace(new RegExp('CREATE TABLE ["\\x60]?'+table+'["\\x60]?','i'),'CREATE TABLE '+table+'_next');
      if(table==='orders') {
        sql=sql.replace('stripe_session_id TEXT UNIQUE','provider_reference TEXT').replace('checkout_url TEXT,','');
        const end=sql.lastIndexOf(')');
        sql=sql.slice(0,end)+", provider TEXT NOT NULL DEFAULT 'stripe', payment_method TEXT NOT NULL DEFAULT 'stripe', provider_config TEXT NOT NULL DEFAULT '', checkout_data TEXT NOT NULL DEFAULT '{}'"+sql.slice(end);
      }
      if(table==='rentals')sql=sql.replace("IN ('wallet','stripe')","IN ('wallet','stripe','alipay','wxpay','airwallex')");
      if(table==='ledger')sql=sql.replace("IN ('stripe_credit','rental_debit','rental_refund')","IN ('stripe_credit','payment_credit','rental_debit','rental_refund')").replace("kind='stripe_credit'","kind IN ('stripe_credit','payment_credit')");
      db.exec(sql);
      const destination=columns.map(column=>table==='orders'&&column==='stripe_session_id'?'provider_reference':column);
      db.exec('INSERT INTO '+table+'_next('+destination.join(',')+') SELECT '+columns.join(',')+' FROM '+table);
      db.exec('DROP TABLE '+table+'; ALTER TABLE '+table+'_next RENAME TO '+table);
      for(const object of objects)db.exec(object.sql.replaceAll('stripe_session_id','provider_reference'));
    }
    // Previous non-Stripe switches only meant "save a draft", not permission
    // to collect. Preserve every credential, but require an explicit activation.
    const saved=JSON.parse(db.prepare("SELECT value FROM settings WHERE key='payment'").get().value);
    let changed=false;
    for(const [id,provider] of Object.entries(saved.providers))if(id!=='stripe'&&provider.enabled){provider.enabled=false;changed=true;}
    if(changed){saved.revision++;db.prepare("UPDATE settings SET value=? WHERE key='payment'").run(JSON.stringify(saved));}
    const current=readPaymentSettings(config,store).providers.stripe;
    for(const order of db.prepare('SELECT id FROM orders').all())db.prepare('UPDATE orders SET provider_config=?,checkout_data=? WHERE id=?').run(store.sealPayment(current,order.id),store.sealPayment(legacyCheckouts.get(order.id)?{url:legacyCheckouts.get(order.id)}:{},'checkout:'+order.id),order.id);
    db.exec("CREATE UNIQUE INDEX orders_provider_reference ON orders(provider,provider_reference) WHERE provider_reference IS NOT NULL; CREATE TRIGGER order_provider_immutable BEFORE UPDATE OF provider,payment_method,provider_config ON orders BEGIN SELECT RAISE(ABORT,'immutable_order'); END;");
    if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('Payment migration foreign-key check failed');
    db.exec('PRAGMA user_version=5');
  });}finally{db.exec('PRAGMA foreign_keys=ON');}
}
