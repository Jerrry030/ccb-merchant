import { state } from './state.js';
export async function api(path, {method = 'GET', body} = {}) {
  const url = new URL(path, location.origin);
  if (url.origin !== location.origin || !url.pathname.startsWith('/api/') || url.username || url.password) throw new Error('仅允许访问当前接口。');
  const write = method !== 'GET';
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(),20000);
  let response;
  try {
    response = await fetch(url.pathname + url.search, {method,credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal,
      headers:{Accept:'application/json',...(body !== undefined ? {'Content-Type':'application/json'} : {}),...(write && state.csrf ? {'X-CSRF-Token':state.csrf} : {})},
      ...(body !== undefined ? {body:JSON.stringify(body)} : {})});
    let data;
    try { data = await response.json(); }
    catch { throw Object.assign(new Error(write ? '服务器未返回可确认的结果。' : '服务器响应格式异常。'),{uncertain:write,status:response.status}); }
    if (!response.ok) {
      const code = data.error?.code;
      const messages = {device_read_limit:'全局设备读取超过安全预算，请从客户页面进入该客户的设备列表核对。',delegation_forbidden:'上游未允许转授此账号。',allocation_pending:'已有分配批次待核对。',password_change_required:'请先修改临时密码。',customer_changed:'客户资料已变化，请刷新后重新编辑。',batch_changed:'批次意图已保存，不能修改；请创建新的分配。',batch_busy:'批次正在执行，请核对已保存结果。',upstream_target_blocked:'此上游目标被服务器网络策略拒绝。私网或 HTTP 地址需由部署者设置 UPSTREAM_ALLOWED_ORIGINS。',upstream_identity_mismatch:'已有业务数据绑定了另一个上游身份，不能在这里直接切换。',upstream_protocol_mismatch:'上游协议不兼容或接入账户已失效。',upstream_verification_failed:'上游未能验证接入凭据，请检查地址、密钥及上级状态。',upstream_changed:'接入配置已变化，请刷新后重新核对。',upstream_environment_managed:'上游由服务端环境配置管理，网页不能覆盖。',insufficient_balance:'钱包余额不足，请先充值或选择在线支付。',plan_changed:'套餐价格或状态已更新，请刷新并重新确认。',plan_conflict:'套餐版本已变化，请刷新后再编辑。',supply_unavailable:'供给不可用或期限不足，暂时无法购买此套餐。',purchase_pending:'此资源已有待完成订单，请先在我的订单中核对。',purchase_conflict:'该请求编号已用于另一笔购买，请核对已有订单。',customer_not_ready:'客户正在停用或同步中，暂时不能开通使用权。',order_state:'订单状态已变化，请刷新核对；已交付订单不能在这里自动退款。',payment_amount_unavailable:'此价格超出当前在线支付范围，请使用余额或联系商户。',payment_outcome_unknown:'支付结果尚未确认，请查看已有订单，勿重复付款。',invalid_credentials:'邮箱或密码不正确，或此账户暂不可用。',invalid_csrf:'会话安全令牌已失效，请重新验证会话。',core_not_configured:'上游连接尚未配置，请联系管理员。',core_unavailable:'上游服务暂不可用，请稍后重试。',core_unavailable:'上游服务暂不可用，请稍后重试。',payment_disabled:'支付服务尚未配置或已停用，当前无法创建订单。',invalid_payment_method:'请选择当前可用的支付方式。',invalid_provider_config:'渠道参数或密钥格式无效，请检查必填字段、RSA 密钥和结算币种。',mail_disabled:'邮件服务尚未配置，当前无法验证邮箱或重置密码。',registration_disabled:'站点当前未开放自助注册。',email_suffix_not_allowed:'该邮箱域名不在允许注册范围内。',email_domain_registration_limit:'该邮箱域名不能再注册新账户。',integration_environment_managed:'这项服务由服务器环境配置管理，不能在页面里覆盖。',mail_unavailable:'邮件服务器拒绝了连接或认证。请核对主机、端口和凭据。',payment_pending:'仍有未完成的支付订单，暂不能更换支付凭据。',payment_pending_limit:'待支付订单数量已达上限，请先完成或核对已有订单。',payment_daily_limit:'今日支付额度已达上限，未确认订单也占用额度。',settings_changed:'配置已被其他操作更新，请刷新后重新确认。',mail_password_required:'修改 SMTP 主机、端口、用户名或 TLS 模式后，请重新输入密码。',mail_auth_failed:'SMTP 认证失败，请检查用户名、密码或邮箱授权码。',mail_timeout:'SMTP 连接超时，请检查主机、端口和服务器网络。',mail_tls_failed:'SMTP 加密连接失败，请检查 TLS 模式和证书。',mail_recipient_rejected:'SMTP 拒绝了测试收件人，请检查地址和中继权限。',payment_verification_unavailable:'支付服务无法验证，请检查密钥、环境和网络。',invalid_password:'密码不符合要求，或当前密码不正确。',not_provisioned:'尚未分配账号，请联系管理员。',core_sync_pending:'客户信息尚未与上游同步完成，请联系管理员核对。',invalid_code:'连接码无效或已过期，请在客户端重新发起连接。',not_copyable:'这把密钥创建时未保留原文，请撤销后重新签发。',admin_required:'此操作需要商户管理员权限。',account_changed:'账号状态已变化，请刷新后重新核对。',account_unavailable:'账号暂不可用，请刷新库存或联系平台管理员。',account_assigned:'该账号已分配，请先收回原客户授权。',invalid_expiry:'客户到期时间不能超过账号到期时间。',customer_not_ready:'请选择状态正常、没有待确认变更的客户。',user_busy:'客户变更正在处理中，请稍后核对。',rate_limited:'请求过于频繁，请稍后再试。'};
      const rejected = ['core_not_configured','payment_disabled','mail_disabled','registration_disabled'].includes(code);
      throw Object.assign(new Error(messages[code] || (typeof data.error?.message === 'string' ? data.error.message : '请求未完成，请稍后再试。')),
        {status:response.status,code,uncertain:write && !rejected && (response.status >= 500 || /unknown|uncertain|timeout/i.test(code || ''))});
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw Object.assign(new Error('服务器响应格式异常。'),{uncertain:write});
    if (write) {
      const expectsOk = method === 'DELETE' || ['/api/auth/logout','/api/auth/verify','/api/auth/resend-verification','/api/auth/forgot-password','/api/auth/reset-password','/api/auth/password','/api/me/devices/approve'].includes(url.pathname);
      if (expectsOk && data.ok !== true) throw Object.assign(new Error('服务器未明确确认操作成功。'),{uncertain:true});
      const required = [];
      if(url.pathname==='/api/admin/allocation-batches')required.push('batch');
      if (['/api/setup','/api/auth/login'].includes(url.pathname)) required.push('user','csrf_token');
      else if (/\/devices\/[^/]+(?:\/selection)?$/.test(url.pathname)&&['PATCH','PUT','DELETE'].includes(method)) {if(method!=='DELETE')required.push('device');}
      else if (url.pathname.startsWith('/api/admin/users')) { required.push('user'); if (url.pathname.endsWith('/provision')) required.push('customer'); }
      else if (url.pathname.startsWith('/api/admin/grants')) required.push('grant');
      else if(/\/keys\/[^/]+\/copy$/.test(url.pathname)) required.push('token');
      else if(method!=='DELETE'&&url.pathname.startsWith('/api/admin/access-accounts')){if(/\/keys$/.test(url.pathname))required.push('key','token');else if(url.pathname.includes('/resources'))required.push('resource');else required.push('account');}
      else if (url.pathname === '/api/admin/settings') required.push('site','features');
      else if (url.pathname === '/api/me/payments' || /\/payments\/[^/]+\/reconcile$/.test(url.pathname)) required.push('order');
      else if (url.pathname === '/api/admin/upstream') required.push('connection','revision');
      else if (url.pathname.startsWith('/api/admin/plans')) required.push('plan');
      else if (url.pathname === '/api/me/rentals' || url.pathname.startsWith('/api/admin/rentals/')) required.push('rental');
      else if (url.pathname === '/api/me/devices/preview') required.push('device');
      if (required.some(key => data[key] == null || data[key] === '')) throw Object.assign(new Error('服务器返回的操作凭据不完整，请先重新读取状态。'),{uncertain:true});
    }
    return data;
  } catch (error) {
    if (!response) throw Object.assign(new Error(write ? '连接中断或超时，操作可能已被服务器接收。' : '暂时无法连接服务，请检查网络后重试。'),{uncertain:write});
    throw error;
  } finally { clearTimeout(timer); }
}
export function collection(data, key) {
  if (!Array.isArray(data?.[key])) throw new Error('响应缺少列表数据，请刷新或联系管理员。');
  return data[key];
}
