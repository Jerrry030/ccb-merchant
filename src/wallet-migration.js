// Balance corrections append to the same immutable ledger as payments and purchases.
// Preserve old receipts, foreign keys, indexes and triggers while widening its CHECK.
export function migrateWalletSchema(store) {
 const db=store.db;
 if(db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='ledger'").get().sql.includes("'admin_adjustment'"))return;
 db.exec('PRAGMA foreign_keys=OFF');
 try {store.transaction(()=>{
  const objects=db.prepare("SELECT sql FROM sqlite_schema WHERE tbl_name='ledger' AND type IN ('index','trigger') AND sql IS NOT NULL").all();
  db.exec(`CREATE TABLE ledger_next (
   id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), order_id TEXT UNIQUE REFERENCES orders(id),
   amount_minor INTEGER NOT NULL, currency TEXT NOT NULL CHECK(currency='CNY'),
   kind TEXT NOT NULL CHECK(kind IN ('stripe_credit','payment_credit','rental_debit','rental_refund','admin_adjustment')),
   reference TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, rental_id TEXT REFERENCES rentals(id),
   CHECK((kind IN ('stripe_credit','payment_credit') AND amount_minor>0 AND order_id IS NOT NULL AND rental_id IS NULL) OR
         (kind='rental_debit' AND amount_minor<0 AND order_id IS NULL AND rental_id IS NOT NULL) OR
         (kind='rental_refund' AND amount_minor>0 AND order_id IS NULL AND rental_id IS NOT NULL) OR
         (kind='admin_adjustment' AND amount_minor<>0 AND order_id IS NULL AND rental_id IS NULL))
  ) STRICT;
  INSERT INTO ledger_next(id,user_id,order_id,amount_minor,currency,kind,reference,created_at,rental_id)
   SELECT id,user_id,order_id,amount_minor,currency,kind,reference,created_at,rental_id FROM ledger;
  DROP TABLE ledger; ALTER TABLE ledger_next RENAME TO ledger;`);
  for(const object of objects)db.exec(object.sql);
  db.exec('CREATE INDEX IF NOT EXISTS ledger_user ON ledger(user_id)');
  if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('Wallet migration would break existing references');
  db.exec('PRAGMA user_version=7');
 });}finally{db.exec('PRAGMA foreign_keys=ON');}
}
