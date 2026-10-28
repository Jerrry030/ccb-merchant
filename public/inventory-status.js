// Classify a lease, not its display name. Unknown states remain visible for review.
export function inventoryStatus(account, now = Date.now()) {
  const expiresAt = Date.parse(account.expires_at);
  const history = account.status === 'released' || account.status === 'expired' || (Number.isFinite(expiresAt) && expiresAt <= now);
  const active = !history && account.status === 'active' && Number.isFinite(expiresAt) && expiresAt > now;
  const ready = active && ['available', 'limited'].includes(account.details?.state);
  const assignable = ready && account.assigned === false;
  let label, tone = '', reason = '';
  if (account.status === 'released') label = '已释放';
  else if (history) label = '已到期';
  else if (account.status !== 'active') {
    label = '状态待核对'; tone = 'warn'; reason = '上游授权状态未知，请刷新或联系平台管理员。';
  } else if (!Number.isFinite(expiresAt)) {
    label = '有效期待核对'; tone = 'warn'; reason = '授权到期时间缺失或无效，暂不计入可分配或已分配统计。';
  } else if (!ready) {
    label = '暂不可用'; tone = 'warn'; reason = '上游状态未就绪，请联系平台管理员。';
  } else if (typeof account.assigned !== 'boolean') {
    label = '状态待核对'; tone = 'warn'; reason = '客户分配状态未知，请刷新后核对。';
  } else {
    label = account.assigned ? '已分配' : '可分配'; tone = account.assigned ? '' : 'good';
  }
  return { history, active, assignable, label, tone, reason };
}
