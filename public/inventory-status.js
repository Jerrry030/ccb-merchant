// Classify a lease, not its display name. Unknown states remain visible for review.
export function inventoryStatus(account, now = Date.now()) {
  const expiresAt = Date.parse(account.expires_at);
  const history = account.status === 'released' || account.status === 'expired' || (Number.isFinite(expiresAt) && expiresAt <= now);
  const active = !history && account.status === 'active' && Number.isFinite(expiresAt) && expiresAt > now;
  const ready = active && ['available', 'limited'].includes(account.details?.state);
  const assignable = ready && account.assigned === false && account.allow_delegation === true && !account.hold_reason;
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
  } else if(!account.assigned && account.allow_delegation !== true) {
    label = '不可转授'; tone = 'warn'; reason = '上游未授予转授权限，不能分配给客户。';
  } else if(!account.assigned && account.hold_reason) {
    label = account.hold_reason==='purchase_pending'?'订单占用':'分配待核对'; tone = 'warn'; reason = '请先核对已有订单或分配批次，不可重复交付。';
  } else {
    label = account.assigned ? '已分配' : '可分配'; tone = account.assigned ? '' : 'good';
  }
  return { history, active, assignable, label, tone, reason };
}


export function selectInventory(accounts, params, now = Date.now()) {
  const customer=params.get('user_id'), q=(params.get('q')||'').trim().toLocaleLowerCase(), platform=params.get('platform'), status=params.get('status');
  const days=Number(params.get('due')), deadline=params.get('deadline')==='authorization'?'expires_at':'customer_expires_at';
  const entries=accounts.map(account=>({account,...inventoryStatus(account,now)})).filter(entry=>{
    const a=entry.account;
    if(customer && a.user_id!==customer && (entry.history || a.assigned!==false)) return false;
    if(q && ![a.id,a.account_code,a.resource_name,a.details?.name,a.customer_name,a.customer_email].some(v=>String(v||'').toLocaleLowerCase().includes(q)))return false;
    if(platform && a.platform!==platform)return false;
    if(status && !({assignable:entry.assignable,assigned:entry.active&&a.assigned===true,unavailable:entry.active&&!['available','limited'].includes(a.details?.state),review:entry.label==='状态待核对'||entry.label==='有效期待核对',released:a.status==='released',expired:entry.history&&a.status!=='released'}[status]))return false;
    if([7,30].includes(days)) {const end=Date.parse(a[deadline]);if(!Number.isFinite(end)||end<=now||end>now+days*86400000)return false;}
    return true;
  });
  const sort=params.get('sort')||'expiry_asc';
  entries.sort((a,b)=>{
    if(sort==='name')return String(a.account.details?.name||a.account.id).localeCompare(String(b.account.details?.name||b.account.id),'zh-CN')||a.account.id.localeCompare(b.account.id);
    const x=Date.parse(a.account[deadline]),y=Date.parse(b.account[deadline]);
    if(!Number.isFinite(x)||!Number.isFinite(y))return Number(!Number.isFinite(x))-Number(!Number.isFinite(y))||a.account.id.localeCompare(b.account.id);
    return (sort==='expiry_desc'?y-x:x-y)||a.account.id.localeCompare(b.account.id);
  });
  return entries;
}
