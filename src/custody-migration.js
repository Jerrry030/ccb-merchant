import {readFileSync} from 'node:fs';

// Rebuild only the known grant table to replace shared-resource uniqueness with
// shared OR concrete-lease uniqueness. All rows, IDs, references and triggers
// survive; the transaction is checked before foreign-key enforcement resumes.
export function migrateCustody(db) {
 const columns=db.prepare('PRAGMA table_info(access_grants)').all();
 if(columns.some(c=>c.name==='account_lease_id'))return;
 const triggers=db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='access_grants'").all().map(r=>r.sql);
 db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
 try{
  db.exec(readFileSync(new URL('./custody-schema.sql',import.meta.url),'utf8'));
  db.exec(`CREATE TABLE access_grants_next(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES access_accounts(id),customer_id TEXT NOT NULL REFERENCES access_customers(id),resource_id TEXT NOT NULL REFERENCES access_resources(id),upstream_id TEXT UNIQUE,status TEXT NOT NULL CHECK(status IN ('active','revoked')),expires_at TEXT,pending INTEGER NOT NULL DEFAULT 1,revision INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL,account_lease_id TEXT REFERENCES access_account_leases(id),intent TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(intent))) STRICT;
   INSERT INTO access_grants_next(id,account_id,customer_id,resource_id,upstream_id,status,expires_at,pending,revision,updated_at) SELECT id,account_id,customer_id,resource_id,upstream_id,status,expires_at,pending,revision,updated_at FROM access_grants;
   DROP TABLE access_grants;ALTER TABLE access_grants_next RENAME TO access_grants;
   CREATE UNIQUE INDEX access_grant_shared ON access_grants(customer_id,resource_id) WHERE account_lease_id IS NULL;
   CREATE UNIQUE INDEX access_grant_lease ON access_grants(customer_id,account_lease_id) WHERE account_lease_id IS NOT NULL;`);
  for(const sql of triggers)db.exec(sql);
  if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('Custody migration would break existing references');
  db.exec('PRAGMA user_version=6; COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}finally{db.exec('PRAGMA foreign_keys=ON');}
}
