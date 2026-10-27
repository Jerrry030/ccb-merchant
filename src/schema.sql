-- Current standalone merchant schema. Initialized once; no historical upgrades.

CREATE TABLE access_accounts(id TEXT PRIMARY KEY,slug TEXT NOT NULL UNIQUE,name TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('active','disabled')),revision INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL) STRICT;

CREATE TABLE access_customers(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES access_accounts(id),external_id TEXT NOT NULL,display_name TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('active','disabled')),upstream_external TEXT NOT NULL UNIQUE,upstream_id TEXT UNIQUE,pending INTEGER NOT NULL DEFAULT 1,revision INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,UNIQUE(account_id,external_id)) STRICT;

CREATE TABLE access_devices(token_hash TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES access_accounts(id),id TEXT NOT NULL UNIQUE,upstream_id TEXT UNIQUE,customer_id TEXT REFERENCES access_customers(id),pairing_code TEXT,current_grant_id TEXT REFERENCES access_grants(id),selection_version INTEGER NOT NULL DEFAULT 0,name TEXT NOT NULL DEFAULT 'API device',platform TEXT NOT NULL DEFAULT '',disabled INTEGER NOT NULL DEFAULT 0,expires_at TEXT) STRICT;

CREATE TABLE access_fulfillments(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES access_accounts(id),order_id TEXT NOT NULL,customer_id TEXT NOT NULL REFERENCES access_customers(id),resource_id TEXT NOT NULL REFERENCES access_resources(id),duration_days INTEGER NOT NULL CHECK(duration_days BETWEEN 1 AND 366),action TEXT NOT NULL CHECK(action IN ('fulfill','cancel')),status TEXT NOT NULL CHECK(status IN ('pending','fulfilled','cancelled')),grant_id TEXT REFERENCES access_grants(id),expires_at TEXT,created_at TEXT NOT NULL,UNIQUE(account_id,order_id)) STRICT;

CREATE TABLE access_grants(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES access_accounts(id),customer_id TEXT NOT NULL REFERENCES access_customers(id),resource_id TEXT NOT NULL REFERENCES access_resources(id),upstream_id TEXT UNIQUE,status TEXT NOT NULL CHECK(status IN ('active','revoked')),expires_at TEXT,pending INTEGER NOT NULL DEFAULT 1,revision INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL,UNIQUE(customer_id,resource_id)) STRICT;

CREATE TABLE access_keys(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES access_accounts(id),name TEXT NOT NULL,prefix TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,token TEXT,scopes TEXT NOT NULL,expires_at TEXT,revoked_at TEXT,created_at TEXT NOT NULL) STRICT;

CREATE TABLE access_resources(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES access_accounts(id),upstream_id TEXT NOT NULL,name TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('active','disabled')),expires_at TEXT,revision INTEGER NOT NULL DEFAULT 1,UNIQUE(account_id,upstream_id)) STRICT;


CREATE TABLE audit (id INTEGER PRIMARY KEY, actor_id TEXT, action TEXT NOT NULL, subject_id TEXT, outcome TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;

CREATE TABLE auth_tokens (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL CHECK(kind IN ('verify','reset')), expires_at INTEGER NOT NULL) STRICT;

CREATE TABLE ledger (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), order_id TEXT UNIQUE REFERENCES orders(id),
  amount_minor INTEGER NOT NULL, currency TEXT NOT NULL CHECK(currency='CNY'),
  kind TEXT NOT NULL CHECK(kind IN ('stripe_credit','rental_debit','rental_refund')),
  reference TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, rental_id TEXT REFERENCES rentals(id),
  CHECK((kind='stripe_credit' AND amount_minor>0 AND order_id IS NOT NULL AND rental_id IS NULL) OR
        (kind='rental_debit' AND amount_minor<0 AND order_id IS NULL AND rental_id IS NOT NULL) OR
        (kind='rental_refund' AND amount_minor>0 AND order_id IS NULL AND rental_id IS NOT NULL))
 ) STRICT;

CREATE TABLE orders (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), amount_minor INTEGER NOT NULL CHECK(amount_minor>0),
        currency TEXT NOT NULL CHECK(currency='CNY'), status TEXT NOT NULL CHECK(status IN ('creating','pending','unknown','paid','expired','failed')),
        stripe_session_id TEXT UNIQUE, checkout_url TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      , rental_id TEXT REFERENCES rentals(id), next_check_at INTEGER NOT NULL DEFAULT 0) STRICT;

CREATE TABLE plans (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
  resource_id TEXT NOT NULL, duration_days INTEGER NOT NULL CHECK(duration_days BETWEEN 1 AND 366),
  amount_minor INTEGER NOT NULL CHECK(amount_minor BETWEEN 1 AND 100000000),
  currency TEXT NOT NULL CHECK(currency='CNY'), status TEXT NOT NULL CHECK(status IN ('active','archived')),
  revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
 ) STRICT;

CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL) STRICT;

CREATE TABLE rentals (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), request_id TEXT NOT NULL,
  plan_id TEXT NOT NULL REFERENCES plans(id), plan_revision INTEGER NOT NULL, name TEXT NOT NULL,
  resource_id TEXT NOT NULL, duration_days INTEGER NOT NULL, amount_minor INTEGER NOT NULL CHECK(amount_minor>0),
  currency TEXT NOT NULL CHECK(currency='CNY'), payment_method TEXT NOT NULL CHECK(payment_method IN ('wallet','stripe')),
  platform TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('awaiting_payment','queued','review','fulfilled','refund_pending','refunded','cancelled')),
  customer_id TEXT, grant_id TEXT, expires_at TEXT, attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0, last_error TEXT, revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(user_id,request_id)
 ) STRICT;

CREATE TABLE runtime_owners(token_hash TEXT PRIMARY KEY,owner TEXT NOT NULL) STRICT;

CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), csrf TEXT NOT NULL, expires_at INTEGER NOT NULL) STRICT;

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;

CREATE TABLE users (
        id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','member')),
        status TEXT NOT NULL CHECK(status IN ('active','disabled','pending_verification')),
        core_customer_id TEXT UNIQUE, provision_name TEXT, core_pending TEXT,
        created_at TEXT NOT NULL
      , sync_attempts INTEGER NOT NULL DEFAULT 0, next_sync_at INTEGER NOT NULL DEFAULT 0, sync_error TEXT) STRICT;

CREATE TABLE webhook_events (id TEXT PRIMARY KEY, digest TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;

CREATE INDEX access_customers_account ON access_customers(account_id);

CREATE INDEX access_grants_account ON access_grants(account_id);

CREATE INDEX access_keys_account ON access_keys(account_id);

CREATE UNIQUE INDEX ledger_rental_kind ON ledger(rental_id,kind) WHERE rental_id IS NOT NULL;

CREATE UNIQUE INDEX orders_rental ON orders(rental_id) WHERE rental_id IS NOT NULL;

CREATE INDEX orders_user ON orders(user_id,created_at);

CREATE INDEX rentals_pending ON rentals(status,next_attempt_at);

CREATE INDEX rentals_user ON rentals(user_id,created_at);

CREATE INDEX sessions_user ON sessions(user_id);

CREATE TRIGGER access_customer_mapping BEFORE UPDATE OF upstream_id ON access_customers WHEN OLD.upstream_id IS NOT NULL AND NEW.upstream_id IS NOT OLD.upstream_id BEGIN SELECT RAISE(ABORT,'immutable_access_mapping');END;

CREATE TRIGGER access_grant_mapping BEFORE UPDATE OF upstream_id ON access_grants WHEN OLD.upstream_id IS NOT NULL AND NEW.upstream_id IS NOT OLD.upstream_id BEGIN SELECT RAISE(ABORT,'immutable_access_mapping');END;

CREATE TRIGGER access_receipt_immutable BEFORE UPDATE ON access_fulfillments WHEN OLD.status<>'pending' BEGIN SELECT RAISE(ABORT,'immutable_access_receipt');END;

CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'immutable_audit'); END;

CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'immutable_audit'); END;

CREATE TRIGGER immutable_customer BEFORE UPDATE OF core_customer_id ON users
        WHEN OLD.core_customer_id IS NOT NULL AND NEW.core_customer_id IS NOT OLD.core_customer_id
        BEGIN SELECT RAISE(ABORT,'immutable_customer'); END;

CREATE TRIGGER last_admin_delete BEFORE DELETE ON users
        WHEN OLD.role='admin' AND OLD.status='active' AND (SELECT count(*) FROM users WHERE role='admin' AND status='active')<=1
        BEGIN SELECT RAISE(ABORT,'last_admin'); END;

CREATE TRIGGER last_admin_update BEFORE UPDATE OF role,status ON users
        WHEN OLD.role='admin' AND OLD.status='active' AND (NEW.role!='admin' OR NEW.status!='active')
        AND (SELECT count(*) FROM users WHERE role='admin' AND status='active')<=1
        BEGIN SELECT RAISE(ABORT,'last_admin'); END;

CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT,'immutable_ledger'); END;

CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger BEGIN SELECT RAISE(ABORT,'immutable_ledger'); END;

CREATE TRIGGER order_amount_immutable BEFORE UPDATE OF user_id,amount_minor,currency ON orders BEGIN SELECT RAISE(ABORT,'immutable_order'); END;

CREATE TRIGGER order_rental_immutable BEFORE UPDATE OF rental_id ON orders BEGIN SELECT RAISE(ABORT,'immutable_order'); END;

CREATE TRIGGER rental_no_delete BEFORE DELETE ON rentals BEGIN SELECT RAISE(ABORT,'immutable_rental'); END;

CREATE TRIGGER rental_snapshot_immutable BEFORE UPDATE OF user_id,request_id,plan_id,plan_revision,name,resource_id,duration_days,amount_minor,currency,payment_method,platform ON rentals BEGIN SELECT RAISE(ABORT,'immutable_rental'); END;

PRAGMA application_id=1128481357;
PRAGMA user_version=4;
