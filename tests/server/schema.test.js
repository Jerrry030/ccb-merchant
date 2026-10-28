import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp,rm,realpath,cp,readFile,rename } from 'node:fs/promises';
import { join,relative,isAbsolute,basename } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../src/store.js';

test('fresh schema has the current ledger and local API tables, and reopen preserves data',async t=>{
 const data=await mkdtemp(join(tmpdir(),'ccb-schema-'));
 t.after(async()=>{const actual=await realpath(data),inside=relative(await realpath(tmpdir()),actual);if(inside.startsWith('..')||isAbsolute(inside)||!basename(actual).startsWith('ccb-schema-'))throw new Error('Unsafe fixture cleanup');await rm(actual,{recursive:true,force:true});});
 const config={dataDir:data,siteName:'Schema fixture'};let store=new Store(config);
 assert.equal(store.db.prepare('PRAGMA application_id').get().application_id,1128481357);assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,5);
 const tables=store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(v=>v.name);
 for(const name of ['users','ledger','rentals','plans','access_accounts','access_keys','access_grants','access_devices'])assert.ok(tables.includes(name),name);
 assert.ok(store.db.prepare('PRAGMA table_info(access_keys)').all().some(column=>column.name==='token'));
 assert.equal(tables.some(n=>/archived|retired|legacy|ledger_v1/.test(n)),false);
 const user=store.createUser({email:'current@example.test',display_name:'Current',password_hash:'test-hash',role:'admin',status:'active'});
 store.db.prepare("INSERT INTO settings VALUES('setup_complete','true')").run();const salt=store.db.prepare("SELECT value FROM settings WHERE key='runtime_salt'").get().value;
 store.db.close();store=new Store(config);assert.equal(store.db.prepare('SELECT id FROM users').get().id,user.id);assert.equal(store.db.prepare("SELECT value FROM settings WHERE key='runtime_salt'").get().value,salt);assert.equal(store.db.prepare("SELECT 1 FROM settings WHERE key='setup_hash'").get(),undefined);store.db.close();
});

test('an unrelated nonempty SQLite database is refused without mutation',async t=>{
 const data=await mkdtemp(join(tmpdir(),'ccb-schema-'));
 t.after(async()=>{const actual=await realpath(data),inside=relative(await realpath(tmpdir()),actual);if(inside.startsWith('..')||isAbsolute(inside)||!basename(actual).startsWith('ccb-schema-'))throw new Error('Unsafe fixture cleanup');await rm(actual,{recursive:true,force:true});});
 let db=new DatabaseSync(join(data,'merchant.sqlite'));db.exec("CREATE TABLE unrelated(id TEXT);INSERT INTO unrelated VALUES('keep');PRAGMA user_version=99");db.close();
 assert.throws(()=>new Store({dataDir:data,siteName:'No adoption'}),/schema does not match/);
 db=new DatabaseSync(join(data,'merchant.sqlite'));assert.equal(db.prepare('SELECT id FROM unrelated').get().id,'keep');assert.equal(db.prepare('PRAGMA user_version').get().user_version,99);assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table'").get().n,1);db.close();
});

test('offline whole-directory backup restores identity, ledger and runtime pseudonym salt together',async t=>{
 const root=await mkdtemp(join(tmpdir(),'ccb-migration-backup-'));
 t.after(async()=>{const actual=await realpath(root),inside=relative(await realpath(tmpdir()),actual);if(inside.startsWith('..')||isAbsolute(inside)||!basename(actual).startsWith('ccb-migration-'))throw new Error('Unsafe fixture cleanup');await rm(actual,{recursive:true,force:true});});
 const original=join(root,'original'),backup=join(root,'backup'),restored=join(root,'restored');
 let store=new Store({dataDir:original,siteName:'Backup fixture'});
 store.db.prepare('INSERT INTO settings VALUES(?,?)').run('setup_complete','true');
 const user=store.createUser({email:'backup@example.test',display_name:'Backup',password_hash:'test-hash',role:'admin',status:'active'});
 const salt=store.db.prepare("SELECT value FROM settings WHERE key='runtime_salt'").get().value;
 store.db.prepare("INSERT INTO orders(id,user_id,amount_minor,currency,status,created_at,updated_at) VALUES('backup-order',?,100,'CNY','paid','2026-10-26','2026-10-26')").run(user.id);
 store.db.prepare("INSERT INTO ledger(id,user_id,order_id,amount_minor,currency,kind,reference,created_at) VALUES('backup-ledger',?,'backup-order',100,'CNY','stripe_credit','cs_test_backup','2026-10-26')").run(user.id);
 store.db.close(); // Never copy a live WAL database.
 await cp(original,backup,{recursive:true,errorOnExist:true,force:false});await cp(backup,restored,{recursive:true,errorOnExist:true,force:false});
 store=new Store({dataDir:restored,siteName:'Restored fixture'});
 assert.equal(store.db.prepare('SELECT id FROM users').get().id,user.id);assert.equal(store.wallet(user.id).balance_minor,100);
 assert.equal(store.db.prepare("SELECT value FROM settings WHERE key='runtime_salt'").get().value,salt);
 store.db.close();
});


test('recognized version-2 preview data upgrades additively without changing users or wallet money',async t=>{
 const data=await mkdtemp(join(tmpdir(),'ccb-schema-'));
 t.after(async()=>{const actual=await realpath(data),inside=relative(await realpath(tmpdir()),actual);if(inside.startsWith('..')||isAbsolute(inside)||!basename(actual).startsWith('ccb-schema-'))throw new Error('Unsafe fixture cleanup');await rm(actual,{recursive:true,force:true});});
 const db=new DatabaseSync(join(data,'merchant.sqlite'));
 let schema=await readFile(new URL('../../src/schema.sql',import.meta.url),'utf8');schema=schema.replace("  platform TEXT NOT NULL DEFAULT '',\n",'').replace(',payment_method,platform ON rentals',',payment_method ON rentals').replace('PRAGMA user_version=4','PRAGMA user_version=2');
 db.exec(schema);db.prepare("INSERT INTO audit(actor_id,action,subject_id,outcome,created_at) VALUES(NULL,'grant.update','legacy-grant','ok','2020-01-01T00:00:00Z')").run();db.prepare("INSERT INTO users(id,email,display_name,password_hash,role,status,created_at) VALUES('kept','kept@example.test','Kept','fixture','admin','active','2026-10-26')").run();db.prepare("INSERT INTO settings VALUES('setup_complete','true')").run();db.prepare("INSERT INTO orders(id,user_id,amount_minor,currency,status,created_at,updated_at) VALUES('payment','kept',100,'CNY','paid','2026-10-26','2026-10-26')").run();db.prepare("INSERT INTO ledger(id,user_id,order_id,amount_minor,currency,kind,reference,created_at) VALUES('entry','kept','payment',100,'CNY','stripe_credit','test','2026-10-26')").run();db.close();
 const store=new Store({dataDir:data,siteName:'Upgrade fixture'});assert.equal(store.wallet('kept').balance_minor,100);assert.equal(store.db.prepare('SELECT id FROM users').get().id,'kept');const historical=store.db.prepare("SELECT * FROM audit WHERE subject_id='legacy-grant'").get();assert.equal(historical.action,'grant.update');assert.equal(historical.customer_id,null);assert.equal(historical.subject_label,null);assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,5);assert.ok(store.db.prepare('PRAGMA table_info(rentals)').all().some(c=>c.name==='account_lease_id'));store.db.close();
});


test('v4 payment migration preserves receipts and credentials, requires draft activation, and refuses a missing encryption key',async t=>{
 const data=await mkdtemp(join(tmpdir(),'ccb-schema-'));
 t.after(async()=>{const actual=await realpath(data),inside=relative(await realpath(tmpdir()),actual);if(inside.startsWith('..')||isAbsolute(inside)||!basename(actual).startsWith('ccb-schema-'))throw new Error('Unsafe fixture cleanup');await rm(actual,{recursive:true,force:true});});
 const config={dataDir:data,siteName:'Payment upgrade'},db=new DatabaseSync(join(data,'merchant.sqlite'));
 db.exec(await readFile(new URL('../../src/schema.sql',import.meta.url),'utf8'));
 db.exec("INSERT INTO users(id,email,display_name,password_hash,role,status,created_at) VALUES('owner','owner@example.test','Owner','fixture','admin','active','2026-10-26'); INSERT INTO settings VALUES('setup_complete','true'); INSERT INTO orders(id,user_id,amount_minor,currency,status,stripe_session_id,checkout_url,created_at,updated_at) VALUES('legacy','owner',1234,'CNY','paid','cs_test_legacy','https://checkout.stripe.com/pay/legacy','2026-10-26','2026-10-26'); INSERT INTO ledger(id,user_id,order_id,amount_minor,currency,kind,reference,created_at) VALUES('receipt','owner','legacy',1234,'CNY','stripe_credit','cs_test_legacy','2026-10-26');");
 db.prepare('INSERT INTO settings VALUES(?,?)').run('services',JSON.stringify({stripe:{secret:'sk_test_legacy',webhook_secret:'whsec_legacy'},payment_catalog:{providers:{easypay:{enabled:true,pid:'10001',pkey:'preserved-fixture-key',api_base:'https://easy.example.test'}},methods:{alipay:{enabled:true,source:'easypay_alipay'}}}}));db.close();
 let store=new Store(config);const order=store.db.prepare('SELECT * FROM orders').get();assert.equal(order.provider,'stripe');assert.equal(order.provider_reference,'cs_test_legacy');assert.equal(store.wallet('owner').balance_minor,1234);
 assert.equal(store.openPayment(order.provider_config,order.id).secret_key,'sk_test_legacy');assert.throws(()=>store.openPayment(order.provider_config,'another-order'));
 assert.equal(store.openPayment(order.checkout_data,'checkout:legacy').url,'https://checkout.stripe.com/pay/legacy');
 const saved=JSON.parse(store.db.prepare("SELECT value FROM settings WHERE key='payment'").get().value);assert.equal(saved.providers.easypay.pkey,'preserved-fixture-key');assert.equal(saved.providers.easypay.enabled,false);assert.equal(saved.providers.stripe.enabled,true);
 assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);assert.throws(()=>store.db.prepare("UPDATE orders SET provider='easypay'").run(),/immutable_order/);assert.throws(()=>store.db.prepare('DELETE FROM ledger').run(),/immutable_ledger/);
 store.db.close();const key=join(data,'payment.key'),backup=join(data,'payment.key.saved');await rename(key,backup);assert.throws(()=>new Store(config),/missing payment encryption key/);await rename(backup,key);
 store=new Store(config);assert.equal(store.wallet('owner').balance_minor,1234);store.db.close();
});
