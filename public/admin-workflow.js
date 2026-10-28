// Task counts and destination filters share these exact states.
export const deliveryReviewStatuses = ['review', 'refund_pending'];
export const paymentReviewStatuses = ['creating', 'pending', 'unknown'];
export const auditActions = {
  'setup.complete':'初始化站点', 'auth.login':'登录', 'auth.logout':'退出登录',
  'auth.register':'注册账户', 'auth.register_refresh':'重发注册验证', 'auth.verify':'验证邮箱',
  'auth.reset':'重置密码', 'auth.password':'修改密码', 'mail.verify':'发送验证邮件', 'mail.reset':'发送重置邮件',
  'user.create':'创建客户', 'user.update':'修改客户资料或权限', 'customer.provision':'同步客户到上游',
  'customer.reconciled':'核对客户同步', 'grant.create':'分配账号', 'grant.update':'修改账号授权',
  'grant.extend':'延长客户有效期', 'grant.revoke':'收回账号', 'device.approve':'确认设备连接',
  'device.rename':'修改设备名称', 'device.select':'更换设备账号', 'device.revoke':'撤销设备连接',
  'plan.save':'保存套餐', 'rental.create':'创建套餐订单', 'rental.funded':'订单余额付款',
  'rental.fulfilled':'完成账号交付', 'rental.refunded':'退回订单余额',
  'rental.retry.requested':'人工核对交付', 'rental.refund.requested':'申请退回未交付余额',
  'checkout.create':'创建支付订单', 'checkout.webhook':'接收支付回调', 'checkout.reconcile':'核对支付结果',
  'upstream.configure':'保存上游连接', 'site.update':'修改站点设置', 'site.mail_update':'保存邮件配置',
  'site.mail_test_send':'发送测试邮件', 'site.mail_test_connection':'测试邮件连接',
  'site.payment_update':'保存支付配置', 'site.payment_test':'测试支付配置',
};
export const auditOutcomes = {ok:'已完成',pending:'待确认',core_pending:'客户同步待确认',delivery_unknown:'邮件投递结果未知',paid:'已支付',expired:'已过期',failed:'失败',unknown:'结果未知'};

export function localDateTime(value) {
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return '';
  const pad = n => String(n).padStart(2,'0');
  return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+'T'+pad(d.getHours())+':'+pad(d.getMinutes());
}

export function renewalExpiry(account, days, now = Date.now()) {
  const prior = Date.parse(account.customer_expires_at), ceiling = Date.parse(account.expires_at);
  if (!Number.isFinite(prior) || !Number.isFinite(ceiling) || ![7,30].includes(days)) return null;
  const end = Math.max(now, prior) + days * 86400000;
  return end <= ceiling ? new Date(end).toISOString() : null;
}
