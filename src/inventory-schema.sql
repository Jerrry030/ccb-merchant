-- Historical procurement_orders, if present, remain untouched and have no active write path.
CREATE UNIQUE INDEX IF NOT EXISTS rental_account_pending ON rentals(account_lease_id)
 WHERE account_lease_id<>'' AND status IN ('awaiting_payment','queued','review','refund_pending');
DROP TRIGGER IF EXISTS rental_snapshot_immutable;
CREATE TRIGGER rental_snapshot_immutable BEFORE UPDATE OF user_id,request_id,plan_id,plan_revision,name,resource_id,duration_days,amount_minor,currency,payment_method,platform,account_lease_id,renew_grant_id ON rentals BEGIN SELECT RAISE(ABORT,'immutable_rental'); END;
