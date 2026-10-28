import { HttpError, opaqueId } from './security.js';
import { publicOrder, publicRental } from './store.js';
import { deliveryReviewStatuses, paymentReviewStatuses } from '../public/admin-workflow.js';

function pageQuery(params, allowed) {
  for (const key of params.keys()) if (!['limit','offset',...allowed].includes(key) || params.getAll(key).length !== 1) throw new HttpError(400,'invalid_query','Unsupported or repeated filter.');
  const limit = Number(params.get('limit') || 50), offset = Number(params.get('offset') || 0);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) throw new HttpError(400,'invalid_query','Invalid pagination.');
  for (const value of params.values()) if (value.length > 150) throw new HttpError(400,'invalid_query','Filter is too long.');
  if (params.get('user_id')) opaqueId(params.get('user_id'));
  return {limit,offset};
}

export function readOrderPage(store, params, {rentals = false, ownerId = null} = {}) {
  const {limit,offset} = pageQuery(params,['q','status',...(ownerId ? [] : ['user_id'])]);
  const status = params.get('status') || '', q = params.get('q') || '', userId = ownerId || params.get('user_id');
  const allowed = rentals ? ['awaiting_payment','queued','review','fulfilled','refund_pending','refunded','cancelled'] : ['creating','pending','unknown','paid','expired','failed'];
  if (status && status !== 'needs_review' && !allowed.includes(status)) throw new HttpError(400,'invalid_query','Unknown order status.');
  const statuses = status === 'needs_review' ? (rentals ? deliveryReviewStatuses : paymentReviewStatuses) : status ? [status] : [];
  const where = [], args = [];
  if (userId) { where.push('o.user_id=?'); args.push(userId); }
  if (statuses.length) { where.push('o.status IN ('+statuses.map(()=>'?').join(',')+')'); args.push(...statuses); }
  if (q) {
    where.push('(o.id LIKE ? OR u.email LIKE ? OR u.display_name LIKE ?'+(rentals ? ' OR o.name LIKE ?' : '')+')');
    args.push(...Array(rentals ? 4 : 3).fill('%'+q+'%'));
  }
  const source = (rentals ? 'rentals' : 'orders')+' o JOIN users u ON u.id=o.user_id';
  const filter = where.length ? ' WHERE '+where.join(' AND ') : '';
  const total = store.db.prepare('SELECT count(*) n FROM '+source+filter).get(...args).n;
  const rows = store.db.prepare('SELECT o.*,u.display_name customer_name,u.email customer_email FROM '+source+filter+' ORDER BY o.created_at DESC,o.id DESC LIMIT ? OFFSET ?').all(...args,limit,offset);
  const items = rows.map(row => {
    const result = {...(rentals ? publicRental(row) : publicOrder(row)),user_id:row.user_id,...(!ownerId ? {customer_name:row.customer_name,customer_email:row.customer_email} : {})};
    if (rentals) {
      const payment = store.db.prepare('SELECT id,status FROM orders WHERE rental_id=?').get(row.id);
      result.payment_order_id=payment?.id || null; result.payment_status=payment?.status || null;
    }
    return result;
  });
  return {[rentals ? 'rentals' : 'orders']:items,total,limit,offset};
}

export function readAuditPage(store, params) {
  const {limit,offset} = pageQuery(params,['q','user_id','action','outcome','from','to']);
  const from=params.get('from'), to=params.get('to'), where=[], args=[];
  if ((from && !Number.isFinite(Date.parse(from))) || (to && !Number.isFinite(Date.parse(to))) || (from && to && Date.parse(from)>Date.parse(to))) throw new HttpError(400,'invalid_query','Invalid audit date range.');
  // Enrich old records by exact local ownership, never by the identity of the actor.
  const source = 'WITH resolved AS ('+
    'SELECT a.*,COALESCE(a.customer_id,u.id,o.user_id,r.user_id) resolved_customer_id,'+
    'COALESCE(a.subject_label,u.display_name,r.name,p.name) subject_name,actor.display_name actor_name,actor.email actor_email '+
    'FROM audit a LEFT JOIN users actor ON actor.id=a.actor_id '+
    "LEFT JOIN users u ON (a.subject_id=u.id AND (a.action LIKE 'user.%' OR a.action LIKE 'auth.%' OR a.action LIKE 'customer.%' OR a.action LIKE 'mail.%' OR a.action IN ('device.approve','setup.complete'))) "+
    "OR (a.action LIKE 'device.%' AND substr(a.subject_id,1,instr(a.subject_id,':')-1)=u.id) "+
    "LEFT JOIN orders o ON a.action LIKE 'checkout.%' AND o.id=a.subject_id "+
    "LEFT JOIN rentals r ON a.action LIKE 'rental.%' AND r.id=a.subject_id "+
    "LEFT JOIN plans p ON a.action='plan.save' AND p.id=a.subject_id "+
    '), entries AS (SELECT resolved.*,c.display_name customer_name,c.email customer_email FROM resolved LEFT JOIN users c ON c.id=resolved.resolved_customer_id) ';
  for (const [key,column] of [['user_id','resolved_customer_id'],['action','action'],['outcome','outcome']]) if(params.get(key)) {where.push(column+'=?');args.push(params.get(key));}
  if (from) {where.push('created_at>=?');args.push(new Date(from).toISOString());}
  if (to) {where.push('created_at<=?');args.push(new Date(to).toISOString());}
  if (params.get('q')) {
    where.push('('+['actor_id','subject_id','actor_name','actor_email','customer_name','customer_email','subject_name'].map(c=>c+' LIKE ?').join(' OR ')+')');
    args.push(...Array(7).fill('%'+params.get('q')+'%'));
  }
  const filter=where.length?' WHERE '+where.join(' AND '):'';
  const total=store.db.prepare(source+'SELECT count(*) n FROM entries'+filter).get(...args).n;
  const events=store.db.prepare(source+'SELECT * FROM entries'+filter+' ORDER BY id DESC LIMIT ? OFFSET ?').all(...args,limit,offset);
  const actions=store.db.prepare('SELECT DISTINCT action FROM audit ORDER BY action').all().map(r=>r.action);
  const outcomes=store.db.prepare('SELECT DISTINCT outcome FROM audit ORDER BY outcome').all().map(r=>r.outcome);
  return {events,total,limit,offset,actions,outcomes};
}
