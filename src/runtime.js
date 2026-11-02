import { upstreamFetch,readUpstreamJSON } from './upstream-network.js';
import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HttpError, readBody, respond } from './security.js';
import { project } from './upstream.js';

const routes = new Map([
  ['POST /bridge/v1/device/start','control'],['POST /bridge/v1/device/renew','control'],
  ['GET /bridge/v1/device/status','control'],['POST /bridge/v1/device/account','control'],
  ['DELETE /bridge/v1/device/pairing','control'],['DELETE /bridge/v1/device','control'],
  ['GET /bridge/v1/accounts','control'],['POST /bridge/v1/bindings','control'],
  ['POST /bridge/v1/messages','data'],['POST /bridge/v1/messages/count_tokens','data'],
  ['GET /bridge/v1/models','data'],['POST /bridge/v1/traffic','data'],
]);
const runtimeHeaders = [
  'authorization','content-type','accept','anthropic-version','anthropic-beta','user-agent',
  'x-ccb-binding','x-ccb-selection-version','x-ccb-timezone','x-ccb-region','x-ccb-target','x-ccb-method',
  'x-stainless-os','x-stainless-arch','x-stainless-lang','x-stainless-package-version','x-stainless-runtime',
  'x-stainless-runtime-version','x-stainless-retry-count','x-stainless-timeout','x-app',
  'x-claude-code-session-id','x-claude-code-parent-session-id',
];
const deviceSchema = { id:'string', name:'string', platform:'string', state:'string', expires_at:'string', owner_user_id:'string', service_name:'string', current_grant_id:'string', account_name:'string', selection_version:'number', pairing_pending:'boolean' };
const accountSchema = { account_lease_id:'string', plan:'string', state:'string', shared:'boolean', quota:{status:'string',updated_at:'string',windows:[{key:'string',label:'string',used_percent:'number',resets_at:'string',reset:'boolean'}]}, id:'string', grant_id:'string', name:'string', status:'string', expires_at:'string', available:'boolean', reason:'string', revision:'number', surfaces:['string'], selected:'boolean', usage:{ five_hour:{ utilization:'number', resets_at:'string' }, seven_day:{ utilization:'number', resets_at:'string' } } };
const controlSchema = { ...deviceSchema, conditional_selection:'boolean', ok:'boolean', code:'string', interval:'number', verification_path:'string', device:deviceSchema, account:accountSchema, accounts:[accountSchema], binding:'string', device_id:'string', os:'string', arch:'string', subscription_type:'string', rate_limit_tier:'string', traffic:{ version:'number', timezone:'string', region:'string', domains:['string'] } };

export async function proxyRuntime(req, res, integration, store, url, access) {
  const config={...integration.config};
  if (url.pathname.startsWith('/bridge/v1/desktop')) throw new HttpError(404,'desktop_disabled','Desktop is disabled in this Code-only release.');
  if (url.searchParams.get('surface') === 'desktop') throw new HttpError(400,'desktop_disabled','Desktop is disabled in this Code-only release.');
  const refresh = /^\/bridge\/v1\/accounts\/[A-Za-z0-9_-]{1,150}\/refresh$/.test(url.pathname) && req.method === 'POST';
  const kind = refresh ? 'control' : routes.get(`${req.method} ${url.pathname}`);
  if (!kind) throw new HttpError(404,'not_found','Runtime route is not available.');
  if (!config.upstreamUrl) throw new HttpError(503,'core_not_configured','Core connection is not configured.');
  if (req.method === 'POST' && url.pathname.endsWith('/device/start')) {
    store.throttle(`device-start:${req.socket.remoteAddress}`, 10, 60000);
  } else if (!/^Bearer [A-Za-z0-9._~-]{16,512}$/i.test(req.headers.authorization || '')) {
    throw new HttpError(401,'device_bearer_required','Original device bearer is required.');
  }
  const queryRules = url.pathname === '/bridge/v1/accounts' || url.pathname.endsWith('/device/account') ? ['surface'] : url.pathname.includes('/messages') ? ['beta'] : url.pathname === '/bridge/v1/models' ? ['limit','before_id','after_id'] : [];
  for (const [key,value] of url.searchParams) {
    if (!queryRules.includes(key) || url.searchParams.getAll(key).length !== 1 || value.length > 512 || !value || (key === 'surface' && value !== 'code') || (key === 'beta' && value !== 'true')) throw new HttpError(400,'invalid_query','Unsupported runtime query.');
  }
  if (url.pathname === '/bridge/v1/traffic') {
    let target;
    try { target=new URL(req.headers['x-ccb-target']); } catch { throw new HttpError(400,'invalid_target','An official Code target is required.'); }
    const allowedHost = target.hostname === 'api.anthropic.com' || (target.hostname === 'platform.claude.com' && target.pathname === '/v1/oauth/hello');
    if (!allowedHost || target.protocol !== 'https:' || (target.port && target.port !== '443') || target.username || target.password || target.hash || target.href.length > 8192 || !['GET','POST'].includes(req.headers['x-ccb-method'])) throw new HttpError(400,'invalid_target','Only official Code targets are supported; core applies the exact endpoint policy.');
  }
  const controller = new AbortController();
  const abort = () => { controller.abort(); if (!req.complete) req.destroy(); };
  const onClose = () => { if (!res.writableEnded) abort(); };
  req.once('aborted',abort); res.once('close',onClose);
  let timedOut=false, guard;
  // Data requests are bounded until headers arrive, not while the provider
  // streams. Control replies remain bounded through their complete JSON body.
  const timer = setTimeout(()=>{timedOut=true;abort();}, kind==='control' ? config.upstreamTimeoutMs : config.runtimeHeaderTimeoutMs); timer.unref();
  try {
    const headers = { 'x-ccb-access-key':config.upstreamKey, 'accept-encoding':'identity' };
    for (const key of runtimeHeaders) if (typeof req.headers[key] === 'string') headers[key] = req.headers[key];
    // Wire order may contain credential/header names; only advertise headers actually forwarded.
    if (req.headers['x-ccb-wire-order']) headers['x-ccb-wire-order'] = req.headers['x-ccb-wire-order'].split(',').map(s=>s.trim()).filter(s=>runtimeHeaders.includes(s.toLowerCase())).join(',');
    let body = ['POST','DELETE'].includes(req.method) ? await readBody(req, kind === 'control' ? 8192 : config.runtimeBodyLimit, false) : undefined;
    if (controller.signal.aborted) return;
    const boundary=await access.prepareRuntime(req,url,body);
    body=boundary.body;
    if(boundary.peer){guard=setInterval(()=>{try{access.authenticate(req,'runtime');if(boundary.selected&&!access.runtimeGrant(access.object('access_grants',boundary.selected.id,boundary.peer.account.id)))throw new Error('revoked');if(boundary.device.customer_id){const c=access.object('access_customers',boundary.device.customer_id,boundary.peer.account.id);if(c.status!=='active'||c.pending)throw new Error('revoked');}}catch{abort();}},2000);guard.unref();}
    await integration.inspect(config,true,controller.signal);
    if(boundary.peer){access.authenticate(req,'runtime');if(boundary.selected&&!access.runtimeGrant(access.object('access_grants',boundary.selected.id,boundary.peer.account.id)))throw new HttpError(403,'grant_unavailable','Grant changed before admission.');}
    const upstream = await upstreamFetch(config,`${config.upstreamUrl}${boundary.path}${url.search}`, { method:req.method,headers,body:body?.length?body:undefined,signal:controller.signal,redirect:'error' });
    // Limit feedback is needed on successes too (warnings and cleared limits).
    for (const [name,value] of upstream.headers) {
      if(name==='retry-after'||name==='x-should-retry'&&['true','false'].includes(value)||runtimeLimitHeader(name,value))res.setHeader(name,value);
    }
    if (!upstream.ok) {
      clearTimeout(timer);
      // Header latency must not grant an unbounded or oversized error body.
      const errorTimer=setTimeout(()=>controller.abort(),Math.min(config.upstreamTimeoutMs,5000));errorTimer.unref();
      let failure;try{failure=await readUpstreamJSON(upstream,64*1024);}catch{}finally{clearTimeout(errorTimer);}
      const code=failure?.code??failure?.error?.code??failure?.error?.type;
      const safe={
        account_device_limit:[409,'每个账号最多绑定 1 台设备，请先撤销旧设备。'],
        account_selection_changed:[409,'账号已变化，请重新启动客户端。'],
        device_stale:[409,'设备选择已变化，请刷新后再选择。'],
        account_unavailable:[409,'此账号暂时无法用于当前设备。'],
        grant_stale:[409,'授权已变化，请刷新后再选择。'],
        rate_limited:[429,'请求过于频繁，请按返回的重试信息稍后重试。'],
        concurrency_limited:[429,'当前并发请求过多，请稍后重试。'],
        rate_limit_error:[429,'Upstream request rate or usage limit reached; follow the returned limit and retry information.'],
        grant_usage_limit_exceeded:[429,'CCB authorization usage limit reached; wait for the usage window to reset or choose another authorized account.'],
      };
      if(Object.hasOwn(safe,code)&&safe[code][0]===upstream.status){
        respond(res,upstream.status,{type:'error',error:{type:code==='grant_usage_limit_exceeded'?'rate_limit_error':code,code,message:safe[code][1]}});
        return;
      }
      const status = [400,401,403,404,409,413,415,429].includes(upstream.status) ? upstream.status : 503;
      respond(res,status,{type:'error',error:{type:'gateway_error',code:'runtime_rejected',message:'Core rejected the runtime request. It was not retried.'}});
      return;
    }
    if (kind === 'data') clearTimeout(timer);
    if (kind === 'control') {
      const chunks=[]; let size=0;
      for await (const chunk of upstream.body) { size+=chunk.length; if(size>1024*1024) throw new Error('Control response too large'); chunks.push(chunk); }
      let filtered=project(JSON.parse(Buffer.concat(chunks).toString('utf8')),controlSchema);
      if (!filtered) throw new Error('Invalid control response');
      filtered=access.runtimeControl(boundary,filtered,url,req.method);
      const salt=store.db.prepare("SELECT value FROM settings WHERE key='runtime_salt'").get().value;
      // CCB requires a stable owner across status and binding; expose a merchant-local pseudonym, never a core user ID.
      for (const object of [filtered,filtered.device]) if (object?.owner_user_id) object.owner_user_id=`merchant_${createHmac('sha256',salt).update(object.owner_user_id).digest('hex')}`;
      if (filtered.verification_path) filtered.verification_path='/connect';
      respond(res,upstream.status,filtered);
    } else if(boundary.peer&&url.pathname==='/bridge/v1/traffic'&&['/api/oauth/profile','/api/oauth/claude_cli/roles'].includes(new URL(req.headers['x-ccb-target']).pathname)){
      const chunks=[];let size=0;for await(const chunk of upstream.body){size+=chunk.length;if(size>1024*1024)throw new Error('Metadata limit');chunks.push(chunk);}
      const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(data.account){data.account={uuid:boundary.device.customer_id,email:'customer@customer.invalid',display_name:'Customer',has_claude_max:data.account.has_claude_max===true,has_claude_pro:data.account.has_claude_pro===true};data.organization={uuid:boundary.peer.account.id,name:boundary.peer.account.name,organization_type:'claude_max'};}
      else if(data.organization_name)data.organization_name=boundary.peer.account.name;
      respond(res,upstream.status,data);
    } else {
      const responseHeaders = { 'Cache-Control':'no-store', 'X-Accel-Buffering':'no' };
      for (const name of ['content-type','request-id']) if (upstream.headers.has(name)) responseHeaders[name]=upstream.headers.get(name);
      res.writeHead(upstream.status,responseHeaders); res.flushHeaders();
      await pipeline(Readable.fromWeb(upstream.body), res, { signal:controller.signal });
    }
  } catch(error) {
    if (res.destroyed || req.aborted) return;
    if (res.headersSent) { res.destroy(); return; }
    if (error instanceof HttpError) throw error;
    const code=timedOut ? (kind==='control' ? 'runtime_timeout' : 'runtime_header_timeout') : 'runtime_unavailable';
    throw new HttpError(503,code,'Runtime connection ended or timed out. No automatic replay was attempted.');
  } finally { clearTimeout(timer); clearInterval(guard); req.removeListener('aborted',abort); res.removeListener('close',onClose); }
}




// Keep this finite projection aligned with docs/downstream-api.md in Core.
// Shared prefixes never authorize new provider metadata or opaque values.
function runtimeLimitHeader(name,value){
 const prefix='anthropic-ratelimit-unified-';
 if(!name.startsWith(prefix)||!value||value.length>128)return false;
 const suffix=name.slice(prefix.length);
 if(['status','overage-status'].includes(suffix))return ['allowed','allowed_warning','rejected'].includes(value);
 if(suffix==='representative-claim')return ['five_hour','seven_day','seven_day_opus','seven_day_sonnet','seven_day_overage_included','overage'].includes(value);
 const windows=['5h','7d','7d_oi','overage'];
 if(suffix==='reset'||windows.some(window=>suffix===window+'-reset'))return /^[0-9]+$/.test(value)&&Number(value)>0&&Number(value)<=253402300799;
 if(windows.some(window=>suffix===window+'-utilization'||suffix===window+'-surpassed-threshold')||['overage-period-monthly-utilization','overage-period-channel-utilization'].includes(suffix))return /^[0-9.eE+-]+$/.test(value)&&Number.isFinite(Number(value))&&Number(value)>=0;
 return false;
}
