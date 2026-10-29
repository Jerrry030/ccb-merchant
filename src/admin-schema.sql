CREATE TABLE IF NOT EXISTS account_codes (
 number INTEGER PRIMARY KEY AUTOINCREMENT, lease_id TEXT NOT NULL UNIQUE
) STRICT;
CREATE TABLE IF NOT EXISTS account_grant_codes (
 grant_id TEXT PRIMARY KEY, lease_id TEXT NOT NULL REFERENCES account_codes(lease_id)
) STRICT;
CREATE TABLE IF NOT EXISTS allocation_batches (
 id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, intent TEXT NOT NULL, items TEXT NOT NULL,
 status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS allocation_batch_status ON allocation_batches(status,created_at);

CREATE TRIGGER IF NOT EXISTS last_owner_update BEFORE UPDATE OF role,status,management_profile ON users
WHEN OLD.role='admin' AND OLD.status='active' AND OLD.management_profile='owner'
 AND (NEW.role<>'admin' OR NEW.status<>'active' OR NEW.management_profile<>'owner')
 AND NOT EXISTS(SELECT 1 FROM users WHERE id<>OLD.id AND role='admin' AND status='active' AND management_profile='owner')
BEGIN SELECT RAISE(ABORT,'last_admin'); END;
CREATE TRIGGER IF NOT EXISTS last_owner_delete BEFORE DELETE ON users
WHEN OLD.role='admin' AND OLD.status='active' AND OLD.management_profile='owner'
 AND NOT EXISTS(SELECT 1 FROM users WHERE id<>OLD.id AND role='admin' AND status='active' AND management_profile='owner')
BEGIN SELECT RAISE(ABORT,'last_admin'); END;
