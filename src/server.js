import { Access } from './access.js';
import { Customers } from './customers.js';
import { Commerce, publicPlan } from './commerce.js';
import { Reconciler } from './reconciler.js';
import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, relative, extname, isAbsolute } from 'node:path';
import { Store, publicUser, publicOrder, publicRental } from './store.js';
import { Auth } from './auth.js';
import { Upstream, project, schemas, scopes } from './upstream.js';
import { Payments } from './payments.js';
import { createMailer, verifyMail } from './mail.js';
import { readSite, readServices, writeServices, publicSettings, effectiveMail, effectiveStripe, describeMail, describeStripe, applyMailUpdate, applyStripeUpdate, stripeSecretsDiffer, registrationView, strictEmailSuffixWhitelist } from './integrations.js';
import { describePaymentCatalog, parsePaymentCatalog } from '../public/payment-catalog.js';
import { proxyRuntime } from './runtime.js';
import { HttpError, fields, text, email, opaqueId, expiry, passwordHash, readBody, respond, requestBoundary } from './security.js';

function listQuery(params) {
  for(const key of params.keys()) if(!['limit','offset','q','status'].includes(key)||params.getAll(key).length!==1) throw new HttpError(400,'invalid_query','Invalid list filter.');
  const limit=Number(params.get('limit')||50),offset=Number(params.get('offset')||0),q=params.get('q')||'',status=params.get('status')||'';
  if(!Number.isSafeInteger(limit)||limit<1||limit>200||!Number.isSafeInteger(offset)||offset<0||offset>1000000||q.length>100||status.length>30)throw new HttpError(400,'invalid_query','Invalid pagination.');
  return {limit,offset,q,status};
}
function usageQuery(params) {
  const out=new URLSearchParams();
  for(const [key,value] of params) {
    if(!['from','to','limit','offset'].includes(key) || params.getAll(key).length!==1) throw new HttpError(400,'invalid_query','Unsupported usage query.');
    if(key==='limit' || key==='offset') {
      const number=Number(value);
      if(!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number<(key==='limit'?1:0) || number>(key==='limit'?100:1000000)) throw new HttpError(400,'invalid_query','Invalid pagination.');
    } else expiry(value);
    out.set(key,value);
  }
  if(out.has('from') && out.has('to') && Date.parse(out.get('from'))>Date.parse(out.get('to'))) throw new HttpError(400,'invalid_query','Usage date range is reversed.');
  if(!out.has('limit')) out.set('limit','50');
  return out.toString();
}
function collection(value,schema) {
  if(!Array.isArray(value) || value.length>10000) throw new HttpError(503,'invalid_core_response','Core returned an invalid collection.');
  return value.map(item=>{
    const result=project(item,schema);
    if(!result || typeof result.id!=='string') throw new HttpError(503,'invalid_core_response','Core returned invalid metadata.');
    return result;
  });
}

export function createMerchant(config, options={}) {
  const store=new Store(config), core=new Upstream(config,store);
  const mailNow=()=>effectiveMail(config,store);
  const stripeNow=()=>effectiveStripe(config,store);
  const mailerNow=()=>options.mailer || (mailNow() ? createMailer({...config, mail:mailNow()}) : null);
  const auth=new Auth(config,store,mailerNow), payments=new Payments(config,store,options.paymentTransport,stripeNow);
  const access=new Access(store,core);
  const customers=new Customers(store,core), commerce=new Commerce(store,core,customers);
  const reconciler=new Reconciler(store,customers,payments,commerce,options.reconcileIntervalMs??config.reconcileIntervalMs);
  const lockedUsers=customers.locks;
  let runtimeInFlight=0;
  const settings=()=>{ const value=publicSettings(readSite(store), mailNow(), stripeNow(), config.upstreamUrl); value.site.public_origin=config.publicOrigin; if(config.homePreviewSample) value.features.home_preview=true; return value; };
  const adminSettings=()=>({...settings(), connection:{configured:Boolean(config.upstreamUrl)}, mail:describeMail(config,store), payment:{...describeStripe(config,store), catalog:describePaymentCatalog(readServices(store).payment_catalog)}, registration:registrationView(readSite(store))});
  async function connection() {
    if(!config.upstreamUrl) return {configured:false,available:false};
    try {
      const data=await core.request('GET','/merchant/v1/me');
      const merchant=project(data.merchant,schemas.merchant);
      if(!merchant?.id || !Array.isArray(data.scopes)) throw new Error('Invalid core metadata');
      return {configured:true,available:merchant.status==='active',protocol_version:data.protocol_version,merchant,scopes:data.scopes.filter(scope=>scopes.includes(scope))};
    } catch(error) { return {configured:true,available:false,error:error instanceof HttpError?error.code:'invalid_core_response'}; }
  }
  async function staticFile(req,res,path) {
    if(!['GET','HEAD'].includes(req.method) || ['/api','/bridge','/merchant','/admin/api','.'].some(prefix=>path===prefix || path.startsWith(`${prefix}/`)) || path.split('/').some(part=>part.startsWith('.'))) throw new HttpError(404,'not_found','Not found.');
    const candidate=resolve(config.publicDir,`.${path}`);
    let file;
    try {
      const info=await stat(candidate);
      file=info.isFile()?candidate:resolve(config.publicDir,'index.html');
    } catch {
      if(extname(path)) throw new HttpError(404,'not_found','Not found.');
      file=resolve(config.publicDir,'index.html');
    }
    try {
      const resolved=await realpath(file), root=await realpath(config.publicDir), local=relative(root,resolved);
      if(local.startsWith('..') || isAbsolute(local)) throw new HttpError(404,'not_found','Not found.');
      const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.webp':'image/webp','.woff2':'font/woff2','.json':'application/json'}[extname(resolved)];
      if(!mime) throw new HttpError(404,'not_found','Not found.');
      const bytes=await readFile(resolved);
      res.writeHead(200,{'Content-Type':mime,'Content-Length':bytes.length,'Cache-Control':'no-cache'});
      res.end(req.method==='HEAD'?undefined:bytes);
    } catch(error) {
      if(error instanceof HttpError) throw error;
      throw new HttpError(404,'ui_not_available','Frontend files are not installed.');
    }
  }
  const server=createServer({maxHeaderSize:16384,headersTimeout:15000,requestTimeout:30000,keepAliveTimeout:5000},async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader('Cache-Control','no-store');
    if(config.secureCookies) res.setHeader('Strict-Transport-Security','max-age=31536000');
    try {
      const rawPath=(req.url || '').split('?')[0];
      if(!rawPath.startsWith('/') || rawPath.startsWith('//') || rawPath.includes('\\') || rawPath.includes('%') || rawPath.split('/').some(part=>part==='..' || part==='.') || rawPath.includes('//')) throw new HttpError(400,'invalid_path','Invalid request path.');
      const url=new URL(req.url,config.publicOrigin), path=url.pathname, route=`${req.method} ${path}`;
      requestBoundary(req,config,path);
      if(path.startsWith('/merchant/v1/')) {
        await access.protocol(req,res,url);return;
      }
      if(path.startsWith('/bridge/')) {
        // Fail closed for ALL new runtime admissions if a local suspension has not been confirmed at core.
        if(store.db.prepare("SELECT 1 FROM users WHERE status='disabled' AND core_pending IS NOT NULL LIMIT 1").get()) throw new HttpError(503,'suspension_sync_pending','Runtime is paused until pending customer suspension is reconciled.');
        if(runtimeInFlight>=config.runtimeMaxInFlight) throw new HttpError(503,'runtime_busy','Runtime concurrency limit reached. No request was forwarded.');
        runtimeInFlight++;
        try { await proxyRuntime(req,res,core,store,url,access); } finally { runtimeInFlight--; }
        return;
      }
      if(route==='POST /api/webhooks/stripe') {
        store.throttle(`webhook:${req.socket.remoteAddress}`,300,60000);
        const raw=await readBody(req,1024*1024,false);
        respond(res,200,await payments.webhook(raw,req.headers['stripe-signature'])); return;
      }
      if(path==='/api/webhooks/stripe') throw new HttpError(405,'method_not_allowed','POST required.');
      if(!path.startsWith('/api/')) { await staticFile(req,res,path); return; }
      store.throttle(`api:${req.socket.remoteAddress}`,300,60000);
      if(route==='GET /api/public') {
        respond(res,200,{...settings(),setup_required:Boolean(store.db.prepare("SELECT 1 FROM settings WHERE key='setup_hash'").get())}); return;
      }
      if(path==='/api/admin/access-accounts'||path.startsWith('/api/admin/access-accounts/')) {
        auth.require(req,true);await access.admin(req,res,url,()=>auth.require(req,true));return;
      }
      let body={};
      if(!['GET','HEAD'].includes(req.method) && (Number(req.headers['content-length'] || 0)>0 || req.headers['transfer-encoding'])) body=await readBody(req,config.jsonBodyLimit);
      if(await auth.handle(req,res,path,body,settings().features)) return;
      const {user}=auth.require(req,path.startsWith('/api/admin/'));
      const memberPrefix=user.core_customer_id?`/merchant/v1/customers/${opaqueId(user.core_customer_id)}`:null;
      const customerReady=()=>{
        if(!memberPrefix) throw new HttpError(409,'not_provisioned','Contact the administrator to assign an account first.');
        if(user.core_pending) throw new HttpError(409,'core_sync_pending','Customer synchronization must be reconciled first.');
      };
      switch(route) {
        case 'GET /api/me/overview': {
          const state=await connection(), pending=[];
          let grants=[],devices=[],usage=null;
          if(store.db.prepare("SELECT 1 FROM users WHERE status='disabled' AND core_pending IS NOT NULL LIMIT 1").get()) pending.push('runtime_suspension_sync_pending');
          if(!memberPrefix) pending.push('customer_not_provisioned');
          if(user.core_pending) pending.push('customer_sync_pending');
          if(memberPrefix && state.available && !user.core_pending) {
            const results=await Promise.allSettled([
              core.request('GET',`/merchant/v1/grants?customer_id=${opaqueId(user.core_customer_id)}`),
              core.request('GET',`${memberPrefix}/devices`),core.request('GET',`${memberPrefix}/usage?limit=1`),
            ]);
            if(results[0].status==='fulfilled') grants=collection(results[0].value.grants,schemas.grant).filter(g=>g.customer_id===user.core_customer_id); else pending.push('grants_unavailable');
            if(results[1].status==='fulfilled') devices=collection(results[1].value.devices,schemas.device); else pending.push('devices_unavailable');
            if(results[2].status==='fulfilled') usage=project(results[2].value.usage,schemas.usage) ?? null; else pending.push('usage_unavailable');
          }
          if(!state.available) pending.push('core_unavailable');
          respond(res,200,{grants,devices,usage,wallet:store.wallet(user.id),connection:{configured:state.configured,available:state.available},pending}); return;
        }
        case 'GET /api/me/grants': {
          customerReady();
          const data=await core.request('GET',`/merchant/v1/grants?customer_id=${opaqueId(user.core_customer_id)}`);
          respond(res,200,{grants:collection(data.grants,schemas.grant).filter(g=>g.customer_id===user.core_customer_id)}); return;
        }
        case 'GET /api/me/accounts': {
          if(!memberPrefix) {respond(res,200,{accounts:[]});return;}
          customerReady();
          const data=await core.request('GET',`${memberPrefix}/accounts`);
          respond(res,200,{accounts:collection(data.accounts,schemas.account)}); return;
        }
        case 'GET /api/me/devices': {
          if(!memberPrefix) {respond(res,200,{devices:[]});return;}
          customerReady(); const data=await core.request('GET',`${memberPrefix}/devices`);
          respond(res,200,{devices:collection(data.devices,schemas.device)}); return;
        }
        case 'POST /api/me/devices/preview':
        case 'POST /api/me/devices/approve': {
          customerReady(); fields(body,['code'],['code']);
          const preview=path.endsWith('preview'), code=text(body.code,'code',128);
          const data=await core.request('POST',`${memberPrefix}/devices/${preview?'preview':'approve'}`,{code});
          if(preview) { const device=project(data.device,schemas.preview); if(!device) throw new HttpError(503,'invalid_core_response','Invalid device preview.'); respond(res,200,{device}); }
          else { if(data.ok!==true) throw new HttpError(503,'core_outcome_unknown','Device approval has not been confirmed.'); store.audit(user.id,'device.approve',user.id); respond(res,200,{ok:true}); } return;
        }
        case 'GET /api/me/usage': {
          customerReady(); const data=await core.request('GET',`${memberPrefix}/usage?${usageQuery(url.searchParams)}`);
          const usage=project(data.usage,schemas.usage);
          if(!usage || !Number.isSafeInteger(data.total)) throw new HttpError(503,'invalid_core_response','Invalid usage metadata.');
          respond(res,200,{usage,requests:collection(data.requests,schemas.request),total:data.total}); return;
        }
        case 'GET /api/me/wallet': {
          const ledger=store.db.prepare('SELECT id,order_id,rental_id,amount_minor,currency,kind,created_at FROM ledger WHERE user_id=? ORDER BY created_at DESC LIMIT 200').all(user.id);
          const orders=store.db.prepare('SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 200').all(user.id).map(publicOrder);
          respond(res,200,{wallet:store.wallet(user.id),ledger,orders}); return;
        }
        case 'POST /api/me/payments': {
          fields(body,['amount_minor'],['amount_minor']); store.throttle(`checkout:${user.id}`,10,60000);
          respond(res,201,await payments.create(user.id,body.amount_minor)); return;
        }
        case 'GET /api/plans':
        case 'GET /api/admin/plans': {respond(res,200,{plans:await commerce.catalog(path.startsWith('/api/admin/'),user.core_customer_id,url.searchParams.get('renew_grant_id'))});return;}
        case 'GET /api/admin/inventory': {
          const owned=await core.request('GET','/merchant/v1/accounts');
          if(!Array.isArray(owned.accounts))throw new HttpError(503,'invalid_core_response','Upstream allocated accounts are unavailable.');
          const users=new Map(store.db.prepare('SELECT id,display_name,email,core_customer_id FROM users WHERE core_customer_id IS NOT NULL').all().map(u=>[u.core_customer_id,u]));
          const accounts=collection(owned.accounts,schemas.heldAccount).map(account=>{
            const customer=account.assigned?users.get(account.customer_id):null;
            return {...account,user_id:customer?.id??null,customer_name:customer?.display_name??null,customer_email:customer?.email??null};
          });
          respond(res,200,{accounts,device_limit:1});return;
        }
        case 'POST /api/admin/plans': respond(res,201,{plan:await commerce.savePlan(null,body,()=>auth.require(req,true))});return;
        case 'POST /api/me/rentals': {
          store.throttle(`rental:${user.id}`,10,60000);
          if(body.payment_method==='stripe' && !stripeNow()) throw new HttpError(503,'payment_disabled','Payments are not configured.');
          if(body.payment_method==='stripe') {
            const plan=store.db.prepare('SELECT amount_minor FROM plans WHERE id=?').get(body.plan_id || '');
            if(plan&&(plan.amount_minor<config.paymentMin||plan.amount_minor>config.paymentMax)) throw new HttpError(409,'payment_amount_unavailable','This price is outside the configured online payment range; use wallet balance or contact support.');
          }
          const result=await commerce.purchase(user.id,body,()=>auth.require(req));
          let checkout=null;
          if(result.created && body.payment_method==='stripe') checkout=await payments.create(user.id,result.rental.amount_minor,result.rental.id);
          else if(!result.created && result.rental.status==='awaiting_payment') checkout=store.db.prepare('SELECT checkout_url FROM orders WHERE rental_id=?').get(result.rental.id);
          if(body.payment_method==='wallet') await commerce.deliver(result.rental.id);
          respond(res,result.created?201:200,{rental:publicRental(store.db.prepare('SELECT * FROM rentals WHERE id=?').get(result.rental.id)),checkout_url:checkout?.checkout_url || null});return;
        }
        case 'GET /api/me/rentals':
        case 'GET /api/admin/rentals': {
          const admin=path.startsWith('/api/admin/'),query=listQuery(url.searchParams);
          const where=[...(admin?[]:['user_id=?']),...(query.status?['status=?']:[]),...(query.q?['(id LIKE ? OR name LIKE ?)']:[])];
          const args=[...(admin?[]:[user.id]),...(query.status?[query.status]:[]),...(query.q?[`%${query.q}%`,`%${query.q}%`]:[])];
          const sql=where.length?` WHERE ${where.join(' AND ')}`:'';
          const total=store.db.prepare(`SELECT count(*) AS n FROM rentals${sql}`).get(...args).n;
          const rows=store.db.prepare(`SELECT * FROM rentals${sql} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`).all(...args,query.limit,query.offset);
          respond(res,200,{rentals:rows.map(row=>{const payment=store.db.prepare('SELECT * FROM orders WHERE rental_id=?').get(row.id);return {...publicRental(row),payment_order_id:payment?.id||null,payment_status:payment?.status||null,checkout_url:row.status==='awaiting_payment'?payment?.checkout_url||null:null};}),total,limit:query.limit,offset:query.offset});return;
        }
        case 'GET /api/admin/operations': {
          const pending=store.db.prepare("SELECT * FROM users WHERE core_pending IS NOT NULL OR (provision_name IS NOT NULL AND core_customer_id IS NULL) ORDER BY created_at LIMIT 100").all().map(publicUser);
          const totals=store.db.prepare('SELECT status,count(*) AS count FROM rentals GROUP BY status').all();
          const paymentsPending=store.db.prepare("SELECT count(*) AS n FROM orders WHERE status IN ('creating','pending','unknown')").get().n;
          respond(res,200,{pending_customers:pending,rentals:totals,payments_pending:paymentsPending,worker:{interval_ms:config.reconcileIntervalMs,max_attempts:8},readiness:{core_configured:Boolean(config.upstreamUrl),mail_configured:Boolean(mailNow()),payment_configured:Boolean(stripeNow()),https:config.secureCookies,schema_version:store.db.prepare('PRAGMA user_version').get().user_version,runtime_limit:config.runtimeMaxInFlight}});return;
        }
        case 'GET /api/admin/connection': respond(res,200,{...await connection(),upstream_url:config.upstreamUrl,public_origin:config.publicOrigin,environment_managed:config.upstreamEnvironment,revision:core.revision}); return;
        case 'POST /api/admin/upstream': {
          store.throttle(`upstream-config:${user.id}`,10,60000);
          respond(res,200,await core.configure(body,()=>auth.require(req,true)));return;
        }
        case 'POST /api/admin/mail/test': {
          fields(body,[]);
          const mail=mailNow();
          if(!mail && !options.mailer) throw new HttpError(503,'mail_disabled','Email delivery is not configured.');
          if(!options.mailer) {
            try { await verifyMail(mail); }
            catch { throw new HttpError(503,'mail_unavailable','The mail server rejected the connection or credentials.'); }
          }
          store.audit(user.id,'site.mail_test',null);
          respond(res,200,{ok:true}); return;
        }
        case 'GET /api/admin/settings': respond(res,200,adminSettings()); return;
        case 'PATCH /api/admin/settings': {
          fields(body,['name','description','support_email','registration_enabled','logo_url','accent_color','email_suffix_whitelist','email_verification_enabled','email_domain_quota_enabled','mail','payment','payment_catalog']);
          const saved=readSite(store);
          if(body.name!==undefined) saved.name=text(body.name,'name',100);
          if(body.description!==undefined) saved.description=text(body.description,'description',1000,0);
          if(body.support_email!==undefined) saved.support_email=body.support_email===''?'':email(body.support_email);
          if(body.logo_url!==undefined) {
            const logo=text(body.logo_url,'logo_url',500,0);
            if(logo) {let u;try{u=new URL(logo);}catch{throw new HttpError(400,'invalid_brand','Logo must use HTTPS.');}if(u.protocol!=='https:'||u.username||u.password)throw new HttpError(400,'invalid_brand','Logo must use HTTPS without credentials.');}
            saved.logo_url=logo;
          }
          if(body.accent_color!==undefined) {if(!/^#[0-9a-fA-F]{6}$/.test(body.accent_color))throw new HttpError(400,'invalid_brand','Invalid accent color.');saved.accent_color=body.accent_color;}
          if(body.registration_enabled!==undefined) { if(typeof body.registration_enabled!=='boolean') throw new HttpError(400,'invalid_input','registration_enabled must be boolean.'); saved.registration_enabled=body.registration_enabled; }
          if(body.email_verification_enabled!==undefined) { if(typeof body.email_verification_enabled!=='boolean') throw new HttpError(400,'invalid_input','email_verification_enabled must be boolean.'); saved.email_verification_enabled=body.email_verification_enabled; }
          if(body.email_domain_quota_enabled!==undefined) { if(typeof body.email_domain_quota_enabled!=='boolean') throw new HttpError(400,'invalid_input','email_domain_quota_enabled must be boolean.'); saved.email_domain_quota_enabled=body.email_domain_quota_enabled; }
          if(body.email_suffix_whitelist!==undefined) saved.email_suffix_whitelist=strictEmailSuffixWhitelist(body.email_suffix_whitelist);
          const services=readServices(store);
          if(body.mail!==undefined) {
            if(config.mail) throw new HttpError(409,'integration_environment_managed','Mail is managed by the server environment and cannot be changed here.');
            services.mail=applyMailUpdate(services.mail, body.mail);
          }
          if(body.payment!==undefined) {
            if(config.stripe) throw new HttpError(409,'integration_environment_managed','Payment is managed by the server environment and cannot be changed here.');
            const next=applyStripeUpdate(services.stripe, body.payment);
            if(stripeSecretsDiffer(services.stripe, next) && store.db.prepare("SELECT count(*) AS n FROM orders WHERE status IN ('creating','pending','unknown')").get().n) throw new HttpError(409,'payment_pending','Wait until in-progress payments finish before changing Stripe credentials.');
            services.stripe=next;
          }
          if(body.payment_catalog!==undefined) {
            const parsed=parsePaymentCatalog(services.payment_catalog, body.payment_catalog);
            if(!parsed.ok) throw new HttpError(400,'invalid_input',parsed.message);
            services.payment_catalog=parsed.value;
          }
          store.transaction(()=>{
            store.db.prepare("UPDATE settings SET value=? WHERE key='site'").run(JSON.stringify(saved));
            if(body.mail!==undefined || body.payment!==undefined || body.payment_catalog!==undefined) writeServices(store, services);
            store.audit(user.id,'site.update',null);
          });
          respond(res,200,adminSettings()); return;
        }
        case 'GET /api/admin/users': {
 const page=listQuery(url.searchParams),needle='%'+page.q+'%';
 const total=store.db.prepare('SELECT count(*) AS n FROM users WHERE(email LIKE ? OR display_name LIKE ?)').get(needle,needle).n;
 respond(res,200,{users:store.db.prepare('SELECT * FROM users WHERE(email LIKE ? OR display_name LIKE ?) ORDER BY created_at,id LIMIT ? OFFSET ?').all(needle,needle,page.limit,page.offset).map(publicUser),total,limit:page.limit,offset:page.offset});return;
 }
        case 'POST /api/admin/users': {
          fields(body,['email','password','display_name','role'],['email','password','display_name','role']);
          if(!['admin','member'].includes(body.role)) throw new HttpError(400,'invalid_role','Invalid role.');
          const address=email(body.email), name=text(body.display_name,'display_name',100), hash=await passwordHash(body.password);
          auth.require(req,true); // Recheck privileges after asynchronous password hashing.
          const created=store.transaction(()=>{ const added=store.createUser({email:address,display_name:name,password_hash:hash,role:body.role,status:'active'}); store.audit(user.id,'user.create',added.id); return added; });
          respond(res,201,{user:publicUser(created)}); return;
        }
        case 'GET /api/admin/resources': { const data=await core.request('GET','/merchant/v1/resources'); respond(res,200,{resources:collection(data.resources,schemas.resource)}); return; }
        case 'GET /api/admin/grants': {
          const limit=Number(url.searchParams.get('limit')||100),offset=Number(url.searchParams.get('offset')||0);if(!Number.isSafeInteger(limit)||limit<1||limit>500||!Number.isSafeInteger(offset)||offset<0)throw new HttpError(400,'invalid_page','Invalid pagination.');
          let query=`?limit=${limit}&offset=${offset}`;
          if([...url.searchParams.keys()].some(key=>!['user_id','limit','offset'].includes(key)||url.searchParams.getAll(key).length>1)) throw new HttpError(400,'invalid_query','Unsupported grant filter.');
          if(url.searchParams.has('user_id')) {
            const target=store.db.prepare('SELECT core_customer_id FROM users WHERE id=?').get(url.searchParams.get('user_id'));
            if(!target) throw new HttpError(404,'user_not_found','User not found.');
            if(!target.core_customer_id) {respond(res,200,{grants:[]}); return;}
            query+=`&customer_id=${opaqueId(target.core_customer_id)}`;
          }
          const data=await core.request('GET',`/merchant/v1/grants${query}`);
          respond(res,200,{grants:collection(data.grants,schemas.grant),total:data.total,limit,offset}); return;
        }
        case 'POST /api/admin/grants': {
          fields(body,['user_id','resource_id','expires_at','account_lease_id','expected_account_revision'],['user_id','resource_id']);
          const targetId=text(body.user_id,'user_id',150);
          const payload={resource_id:decodeURIComponent(opaqueId(body.resource_id))};
          if(body.expires_at!==undefined) payload.expires_at=expiry(body.expires_at);
          if(body.account_lease_id) {
            payload.account_lease_id=decodeURIComponent(opaqueId(body.account_lease_id));
            if(!Number.isSafeInteger(body.expected_account_revision)||body.expected_account_revision<1)throw new HttpError(400,'invalid_input','Refresh the account before delivery.');
            payload.expected_account_revision=body.expected_account_revision;
          }
          if(lockedUsers.has(targetId))throw new HttpError(409,'user_busy','A customer change is in progress. Retry this delivery after it completes.');
          lockedUsers.add(targetId);
          try {
            let target=store.db.prepare('SELECT * FROM users WHERE id=?').get(targetId);
            if(!target||target.status!=='active'||target.core_pending)throw new HttpError(409,'customer_not_ready','Select an active customer with no pending changes.');
            if(payload.account_lease_id) {
              const owned=await core.request('GET','/merchant/v1/accounts');auth.require(req,true);
              if(!Array.isArray(owned.accounts))throw new HttpError(503,'invalid_core_response','Account inventory is unavailable.');
              const account=owned.accounts.find(a=>a.id===payload.account_lease_id);
              if(!account||account.resource_id!==payload.resource_id||account.status!=='active'||!Number.isFinite(Date.parse(account.expires_at))||Date.parse(account.expires_at)<=Date.now())throw new HttpError(409,'account_unavailable','This account is no longer available. Refresh the inventory.');
              payload.expires_at??=account.expires_at;
              if(Date.parse(payload.expires_at)>Date.parse(account.expires_at)||Date.parse(payload.expires_at)<=Date.now())throw new HttpError(400,'invalid_expiry','Customer expiry must be in the future and within the account expiry.');
              if(account.revision!==payload.expected_account_revision && !(account.revision===payload.expected_account_revision+1&&account.assigned&&account.customer_id===target.core_customer_id))throw new HttpError(409,'account_changed','The account changed. Refresh before assigning it.');
              if(account.assigned&&account.customer_id!==target.core_customer_id)throw new HttpError(409,'account_assigned','Reclaim the current assignment before choosing another customer.');
              if(!['available','limited'].includes(account.details?.state))throw new HttpError(409,'account_unavailable','This account is currently unavailable.');
              if(store.db.prepare("SELECT 1 FROM rentals WHERE account_lease_id=? AND status IN ('awaiting_payment','queued','review','refund_pending')").get(account.id))throw new HttpError(409,'purchase_pending','Account is reserved by a customer checkout.');
            }
            if(!target.core_customer_id)await customers.synchronize(targetId,()=>auth.require(req,true));
            auth.require(req,true);
            target=store.db.prepare('SELECT * FROM users WHERE id=?').get(targetId);
            if(!target?.core_customer_id||target.status!=='active'||target.core_pending)throw new HttpError(409,'customer_not_ready','Customer state changed. Refresh before delivery.');
            payload.customer_id=target.core_customer_id;
            const data=await core.request('POST','/merchant/v1/grants',payload), grant=project(data.grant,schemas.grant);
            auth.require(req,true);
            if(!grant?.id||grant.status!=='active'||grant.customer_id!==target.core_customer_id||grant.resource_id!==payload.resource_id||(payload.account_lease_id&&(grant.account_lease_id!==payload.account_lease_id||Date.parse(grant.expires_at)!==Date.parse(payload.expires_at))))throw new HttpError(503,'core_outcome_unknown','Delivery is unconfirmed. Check the account before retrying the same assignment.');
            store.audit(user.id,'grant.create',grant.id);respond(res,201,{grant});return;
          } finally {lockedUsers.delete(targetId);}
        }
        case 'GET /api/admin/orders': respond(res,200,{orders:store.db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 1000').all().map(order=>({...publicOrder(order),user_id:order.user_id}))}); return;
        case 'GET /api/admin/audit': respond(res,200,{events:store.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 500').all()}); return;
      }
      let match;

      if(req.method==='PATCH' && (match=path.match(/^\/api\/admin\/plans\/([^/]+)$/))) {
        respond(res,200,{plan:await commerce.savePlan(decodeURIComponent(opaqueId(match[1])),body,()=>auth.require(req,true))});return;
      }
      if(req.method==='POST' && (match=path.match(/^\/api\/admin\/rentals\/([^/]+)\/resolve$/))) {
        fields(body,['action','expected_revision'],['action','expected_revision']);
        const row=store.db.prepare('SELECT * FROM rentals WHERE id=?').get(match[1]);
        if(!row)throw new HttpError(404,'order_not_found','Order not found.');
        if(row.revision!==body.expected_revision||!['retry','refund'].includes(body.action)||!['queued','review','refund_pending'].includes(row.status)||(row.status==='refund_pending'&&body.action!=='refund'))throw new HttpError(409,'order_state','Refresh the order. Only undelivered paid orders can be retried or refunded to the wallet.');
        store.transaction(()=>{
          store.db.prepare('UPDATE rentals SET status=?,attempts=0,next_attempt_at=0,last_error=NULL,revision=revision+1,updated_at=? WHERE id=?').run(body.action==='refund'?'refund_pending':'queued',new Date().toISOString(),row.id);
          store.audit(user.id,`rental.${body.action}.requested`,row.id);
        });
        await commerce.deliver(row.id);respond(res,200,{rental:publicRental(store.db.prepare('SELECT * FROM rentals WHERE id=?').get(row.id))});return;
      }
      if(req.method==='POST' && (match=path.match(/^\/api\/(me|admin)\/payments\/([^/]+)\/reconcile$/))) {
        fields(body,[]);
        const row=store.db.prepare('SELECT * FROM orders WHERE id=?').get(match[2]);
        if(!row||(match[1]==='me'&&row.user_id!==user.id))throw new HttpError(404,'order_not_found','Order not found.');
        const order=await payments.reconcile(row.id);
        if(row.rental_id)await commerce.deliver(row.rental_id);
        respond(res,200,{order});return;
      }
      if(req.method==='GET' && (match=path.match(/^\/api\/me\/payments\/([^/]+)$/))) {
        const order=store.db.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(decodeURIComponent(opaqueId(match[1])),user.id);
        if(!order) throw new HttpError(404,'order_not_found','Order not found.');
        respond(res,200,{order:publicOrder(order)}); return;
      }
      if(req.method==='DELETE' && (match=path.match(/^\/api\/me\/devices\/([^/]+)$/))) {
        customerReady(); fields(body,[]);
        const data=await core.request('DELETE',`${memberPrefix}/devices/${opaqueId(match[1])}`);
        if(data.ok!==true) throw new HttpError(503,'core_outcome_unknown','Device revocation has not been confirmed. Refresh before another change.');
        store.audit(user.id,'device.revoke',match[1]); respond(res,200,{ok:true}); return;
      }
      if(req.method==='PATCH' && (match=path.match(/^\/api\/admin\/grants\/([^/]+)$/))) {
        fields(body,['expected_revision','status','expires_at'],['expected_revision']);
        if(!Number.isSafeInteger(body.expected_revision) || body.expected_revision<1 || (body.status!==undefined && !['active','revoked'].includes(body.status))) throw new HttpError(400,'invalid_input','Invalid grant revision/status.');
        if(body.expires_at!==undefined) expiry(body.expires_at);
        const data=await core.request('PATCH',`/merchant/v1/grants/${opaqueId(match[1])}`,body), grant=project(data.grant,schemas.grant);
        if(grant?.id!==match[1]) throw new HttpError(503,'core_outcome_unknown','Grant update is unconfirmed. Refresh before another change.');
        store.audit(user.id,'grant.update',grant.id); respond(res,200,{grant}); return;
      }
      if((req.method==='PATCH' && (match=path.match(/^\/api\/admin\/users\/([^/]+)$/))) || (req.method==='POST' && (match=path.match(/^\/api\/admin\/users\/([^/]+)\/provision$/)))) {
        const targetId=decodeURIComponent(opaqueId(match[1]));
        if(lockedUsers.has(targetId)) throw new HttpError(409,'user_busy','A user change is already in progress. Refresh before continuing.');
        lockedUsers.add(targetId);
        try {
          let target=store.db.prepare('SELECT * FROM users WHERE id=?').get(targetId);
          if(!target) throw new HttpError(404,'user_not_found','User not found.');
          if(req.method==='POST') {
            fields(body,[]);
            if(target.status!=='active') throw new HttpError(409,'user_inactive','Only active users can be provisioned.');
            if(target.core_pending) throw new HttpError(409,'core_sync_pending','Reconcile the pending user change before provisioning.');
            const customer=await customers.synchronize(target.id,()=>auth.require(req,true));
            target=store.db.prepare('SELECT * FROM users WHERE id=?').get(target.id);
            respond(res,200,{user:publicUser(target),customer}); return;
          }
          fields(body,['display_name','status','role']);
          if(!Object.keys(body).length && !target.core_pending) throw new HttpError(400,'invalid_input','Provide a user change.');
          if(body.status!==undefined && !['active','disabled'].includes(body.status)) throw new HttpError(400,'invalid_status','Invalid user status.');
          if(body.role!==undefined && !['admin','member'].includes(body.role)) throw new HttpError(400,'invalid_role','Invalid role.');
          if(target.id===user.id && body.status==='disabled') throw new HttpError(409,'self_disable','Administrators cannot disable themselves.');
          if(target.status==='pending_verification' && body.status==='active') throw new HttpError(409,'verification_required','Email verification must be completed.');
          const desired={display_name:body.display_name===undefined?target.display_name:text(body.display_name,'display_name',100),status:body.status || target.status};
          const needsSync=Boolean(target.core_customer_id && (body.status!==undefined || body.display_name!==undefined || target.core_pending));
          store.transaction(()=>{
            const localStatus=needsSync && desired.status==='active' && target.status==='disabled'?'disabled':desired.status;
            store.db.prepare('UPDATE users SET display_name=?,role=?,status=?,core_pending=?,next_sync_at=0,sync_error=NULL WHERE id=?').run(desired.display_name,body.role || target.role,localStatus,needsSync?JSON.stringify(desired):target.core_pending,target.id);
            if(localStatus!=='active' || (body.role && body.role!==target.role)) store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);
            store.audit(user.id,'user.update',target.id,needsSync?'core_pending':'ok');
          });
          if(needsSync) await customers.synchronize(target.id,()=>auth.require(req,true));
          target=store.db.prepare('SELECT * FROM users WHERE id=?').get(target.id);
          respond(res,200,{user:publicUser(target)}); return;
        } finally { lockedUsers.delete(targetId); }
      }
      if(req.method==='GET'&&/^\/api\/admin\/users\/[A-Za-z0-9_-]+$/.test(path)){auth.require(req,true);const row=store.db.prepare('SELECT * FROM users WHERE id=?').get(path.split('/').at(-1));if(!row)throw new HttpError(404,'user_not_found','User not found.');respond(res,200,{user:publicUser(row)});return;}
      throw new HttpError(404,'not_found','API route not found.');
    } catch(error) {
      if(res.headersSent) {res.destroy(); return;}
      if(!(error instanceof HttpError) && /UNIQUE constraint failed: access_/.test(String(error.message)))error=new HttpError(409,'access_conflict','This local API object already exists. Refresh before making another change.');
      if(!(error instanceof HttpError) && String(error.message).includes('last_admin')) error=new HttpError(409,'last_admin','At least one active administrator must remain.');
      const known=error instanceof HttpError;
      if(!known) options.onError?.('internal_error');
      respond(res,known?error.status:500,{error:{code:known?error.code:'internal_error',message:known?error.message:'An internal error occurred. No upstream retry was made.'}});
    }
  });
  server.on('listening',()=>reconciler.start());
  server.on('close',()=>{reconciler.stop().catch(()=>{});});
  return {server,store,reconciler};
}

