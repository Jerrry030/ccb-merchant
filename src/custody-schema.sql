-- No business account quotas. These are provenance and immutable operation maps.
CREATE TABLE IF NOT EXISTS custody_environment_ids(id TEXT PRIMARY KEY,upstream_id TEXT NOT NULL UNIQUE) STRICT;
CREATE TABLE IF NOT EXISTS custody_operations(
 owner_id TEXT NOT NULL,origin_ref TEXT NOT NULL,id TEXT NOT NULL,
 upstream_id TEXT NOT NULL UNIQUE,intent TEXT NOT NULL CHECK(json_valid(intent)),
 upstream_intent TEXT NOT NULL CHECK(json_valid(upstream_intent)),
 snapshot TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(snapshot)),updated_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,origin_ref,id)
) STRICT;
CREATE TABLE IF NOT EXISTS custody_accounts(
 id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,origin_ref TEXT NOT NULL,upstream_id TEXT NOT NULL,
 snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),UNIQUE(owner_id,origin_ref,upstream_id)
) STRICT;
CREATE TABLE IF NOT EXISTS access_account_leases(
 id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES access_accounts(id),origin_ref TEXT NOT NULL,
 upstream_id TEXT NOT NULL,resource_id TEXT NOT NULL REFERENCES access_resources(id),
 upstream_revision INTEGER NOT NULL DEFAULT 0,snapshot TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(snapshot)),
 UNIQUE(account_id,origin_ref,upstream_id)
) STRICT;
CREATE TABLE IF NOT EXISTS access_grant_attempts(
 id TEXT NOT NULL,revision INTEGER NOT NULL,account_id TEXT NOT NULL REFERENCES access_accounts(id),
 intent TEXT NOT NULL CHECK(json_valid(intent)),outcome TEXT NOT NULL,created_at TEXT NOT NULL,
 PRIMARY KEY(id,revision)
) STRICT;
