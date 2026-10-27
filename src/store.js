import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { migratePaymentSchema } from './payment-migration.js';
import { defaultPaymentSettings } from './payment-settings.js';
import { normalizePaymentCatalog } from '../public/payment-catalog.js';
import { digest, randomToken, HttpError } from './security.js';

export class Store {
  constructor(config) {
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    const path = join(config.dataDir, 'merchant.sqlite');
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    try {
      const tables=this.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n;
      if(tables && (this.db.prepare('PRAGMA application_id').get().application_id!==1128481357 || ![2,3,4,5].includes(this.db.prepare('PRAGMA user_version').get().user_version))) throw new Error('Database schema does not match this build; use a matching or empty data directory');
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
      if(!tables) {
        this.db.exec('BEGIN IMMEDIATE');
        try {this.db.exec(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));this.db.exec('COMMIT');}
        catch(error){this.db.exec('ROLLBACK');throw error;}
      } else if(!this.db.prepare('PRAGMA table_info(access_keys)').all().some(column => column.name === 'token')) {
        this.db.exec('ALTER TABLE access_keys ADD COLUMN token TEXT');
      }
    } catch(error) { this.db.close(); throw error; }
    // Additive local schema changes preserve existing users, wallets and receipts.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [table, columns] of Object.entries({rentals:{platform:"TEXT NOT NULL DEFAULT ''",account_lease_id:"TEXT NOT NULL DEFAULT ''",renew_grant_id:"TEXT NOT NULL DEFAULT ''"},plans:{source_plan_id:'TEXT',source_revision:'INTEGER',cost_minor:'INTEGER'}})) {
        const existing=new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name));
        for(const [name,type] of Object.entries(columns)) if(!existing.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
      }
      this.db.exec(readFileSync(new URL('./inventory-schema.sql',import.meta.url),'utf8'));
      if(this.db.prepare('PRAGMA user_version').get().user_version<4)this.db.exec('PRAGMA user_version=4');
      this.db.exec('COMMIT');
    } catch(error) {this.db.exec('ROLLBACK');this.db.close();throw error;}
    this.db.prepare('INSERT OR IGNORE INTO settings VALUES (?,?)').run('site', JSON.stringify({ name: config.siteName, description: '', support_email: '', currency: 'CNY', registration_enabled: false }));
    this.db.prepare('INSERT OR IGNORE INTO settings VALUES (?,?)').run('runtime_salt', randomToken());
    // One-time settings migration: preserve credentials, retire the disconnected catalog.
    // Both new records and removal of the old record commit together.
    this.transaction(() => {
      const legacy = this.db.prepare("SELECT value FROM settings WHERE key='services'").get();
      const services = legacy ? JSON.parse(legacy.value) : {};
      const payment = { ...defaultPaymentSettings(config), ...normalizePaymentCatalog(services.payment_catalog) };
      if (services.stripe) payment.providers.stripe = { enabled: true, secret_key: services.stripe.secret || '', webhook_secret: services.stripe.webhook_secret || '' };
      if (services.stripe || config.stripe) {
        payment.providers.stripe.enabled = true;
        payment.methods.stripe = { enabled: true, source: 'stripe_checkout' };
      }
      this.db.prepare('INSERT OR IGNORE INTO settings VALUES (?,?)').run('mail', JSON.stringify({ revision: 1, config: services.mail || null }));
      this.db.prepare('INSERT OR IGNORE INTO settings VALUES (?,?)').run('payment', JSON.stringify(payment));
      if (legacy) this.db.prepare("DELETE FROM settings WHERE key='services'").run();
    });
    const paymentKey=join(config.dataDir,'payment.key');
    try {
      if(!existsSync(paymentKey)) {
        const hasSnapshots=this.db.prepare('PRAGMA table_info(orders)').all().some(column=>column.name==='provider_config') && this.db.prepare("SELECT 1 FROM orders WHERE provider_config<>'' LIMIT 1").get();
        if(hasSnapshots)throw new Error('Restore the missing payment encryption key from backup');
        writeFileSync(paymentKey,randomBytes(32),{flag:'wx',mode:0o600});
      }
      this.paymentKey=readFileSync(paymentKey);
      if(this.paymentKey.length!==32)throw new Error('Invalid payment encryption key');
      migratePaymentSchema(config,this);
    }catch(error){this.db.close();throw error;}
    this.setupFile = join(config.dataDir, 'setup.secret');
    if (!this.db.prepare("SELECT 1 FROM settings WHERE key='setup_complete'").get() && !this.db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
      if (!existsSync(this.setupFile)) writeFileSync(this.setupFile, randomToken(), { flag: 'wx', mode: 0o600 });
      const token = readFileSync(this.setupFile, 'utf8').trim();
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Invalid setup secret file; restore it from a private backup');
      this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run('setup_hash', digest(token));
    } else {
      this.db.prepare("DELETE FROM settings WHERE key='setup_hash'").run();
      if (existsSync(this.setupFile)) unlinkSync(this.setupFile);
    }
    // A process may have exited after Stripe accepted the POST. Never automatically replay it.
    this.db.prepare("UPDATE orders SET status='unknown' WHERE status='creating'").run();
  }
  sealPayment(value,context) {
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.paymentKey,iv);
    cipher.setAAD(Buffer.from(context));
    const data=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
    return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64');
  }
  openPayment(value,context) {
    const bytes=Buffer.from(value,'base64');
    const decipher=createDecipheriv('aes-256-gcm',this.paymentKey,bytes.subarray(0,12));
    decipher.setAAD(Buffer.from(context));decipher.setAuthTag(bytes.subarray(12,28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8'));
  }
  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = work(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  audit(actor, action, subject, outcome = 'ok') {
    this.db.prepare('INSERT INTO audit(actor_id,action,subject_id,outcome,created_at) VALUES (?,?,?,?,?)').run(actor || null, action, subject || null, outcome, new Date().toISOString());
  }
  throttle(key, max, windowMs) {
    const now = Date.now();
    this.db.prepare('DELETE FROM rate_limits WHERE expires_at<=?').run(now);
    const result = this.db.prepare('INSERT INTO rate_limits VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count').get(key, now + windowMs);
    if (result.count > max) throw new HttpError(429, 'rate_limited', 'Too many requests; try again later.');
  }
  wallet(userId) {
    return { balance_minor: this.db.prepare('SELECT coalesce(sum(amount_minor),0) AS balance FROM ledger WHERE user_id=?').get(userId).balance, currency: 'CNY' };
  }
  // Caller holds BEGIN IMMEDIATE: debit and durable delivery intent commit together.
  fundRental(rental) {
    if(this.db.prepare("SELECT 1 FROM ledger WHERE rental_id=? AND kind='rental_debit'").get(rental.id)) return;
    if(rental.status!=='awaiting_payment') throw new HttpError(409,'order_state','Order cannot be funded.');
    const balance=this.wallet(rental.user_id).balance_minor;
    if(!Number.isSafeInteger(balance) || balance<rental.amount_minor) throw new HttpError(409,'insufficient_balance','Wallet balance is insufficient.');
    const now=new Date().toISOString();
    this.db.prepare("INSERT INTO ledger(id,user_id,amount_minor,currency,kind,reference,created_at,rental_id) VALUES(?,?,?,'CNY','rental_debit',?,?,?)").run(randomUUID(),rental.user_id,-rental.amount_minor,`rental:${rental.id}:debit`,now,rental.id);
    this.db.prepare("UPDATE rentals SET status='queued',next_attempt_at=0,updated_at=?,revision=revision+1 WHERE id=?").run(now,rental.id);
    this.audit(rental.user_id,'rental.funded',rental.id);
  }
  createUser({ email, display_name, password_hash, role, status }) {
    const user = { id: randomUUID(), email, display_name, password_hash, role, status, created_at: new Date().toISOString() };
    try {
      this.db.prepare('INSERT INTO users(id,email,display_name,password_hash,role,status,created_at) VALUES (?,?,?,?,?,?,?)').run(user.id, email, display_name, password_hash, role, status, user.created_at);
    } catch (error) {
      if (String(error.message).includes('users.email')) throw new HttpError(409, 'email_exists', 'This email is already registered.');
      throw error;
    }
    return user;
  }

}
export function publicUser(user) {
  return { id: user.id, email: user.email, display_name: user.display_name, role: user.role, status: user.status, ...(user.core_customer_id ? { core_customer_id: user.core_customer_id } : {}), created_at: user.created_at, sync_pending:Boolean(user.core_pending || (!user.core_customer_id && user.provision_name)), sync_error:user.sync_error || null };
}
export function publicOrder(order) {
  return { id: order.id, status: order.status, amount_minor: order.amount_minor, currency: order.currency, created_at: order.created_at, updated_at: order.updated_at, rental_id:order.rental_id || null, payment_method:order.payment_method, provider:order.provider };
}


export function publicRental(row) {
 return {id:row.id,user_id:row.user_id,plan_id:row.plan_id,plan_revision:row.plan_revision,name:row.name,duration_days:row.duration_days,amount_minor:row.amount_minor,currency:row.currency,payment_method:row.payment_method,platform:row.platform||'',renew_grant_id:row.renew_grant_id||'',status:row.status,grant_id:row.grant_id,expires_at:row.expires_at,attempts:row.attempts,last_error:row.last_error,revision:row.revision,created_at:row.created_at,updated_at:row.updated_at};
}
