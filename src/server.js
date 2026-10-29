import { managementProfiles } from '../public/management-policy.js';
import { Inventory } from './inventory.js';
import { readOrderPage, readAuditPage } from './admin-queries.js';
import { deliveryReviewStatuses, paymentReviewStatuses } from '../public/admin-workflow.js';
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
import { createMailer, testMail } from './mail.js';
import { readSite, publicSettings, effectiveMail, describeMail, applyMailUpdate, registrationView, strictEmailSuffixWhitelist } from './integrations.js';
import QRCode from 'qrcode';
import { PaymentProvider } from './payment-providers.js';
import { paymentProviders, parsePaymentCatalog } from '../public/payment-catalog.js';
import { readPaymentSettings, describePayment, applyPaymentUpdate } from './payment-settings.js';
import { proxyRuntime } from './runtime.js';
import { HttpError, fields, text, email, opaqueId, expiry, passwordHash, readBody, respond, requestBoundary } from './security.js';

function listQuery(params) {
  for(const key of params.keys()) if(!['limit','offset','q','status','role','tag','assignment','due'].includes(key)||params.getAll(key).length!==1) throw new HttpError(400,'invalid_query','Invalid list filter.');
  const limit=Number(params.get('limit')||50),offset=Number(params.get('offset')||0),q=params.get('q')||'',status=params.get('status')||'';
  if(!Number.isSafeInteger(limit)||limit<1||limit>200||!Number.isSafeInteger(offset)||offset<0||offset>1000000||q.length>100||status.length>30)throw new HttpError(400,'invalid_query','Invalid pagination.');
  return {limit,offset,q,status,role:params.get('role')||'',tag:params.get('tag')||'',assignment:params.get('assignment')||'',due:params.get('due')||''};
}
function usageQuery(params) {
  const out=new URLSearchParams();
  for(const [key,value] of params) {
    if(!['from','to','limit','offset','device_id','grant_id','model','result','session_id','view'].includes(key) || params.getAll(key).length!==1) throw new HttpError(400,'invalid_query','Unsupported usage query.');
    if(key==='limit' || key==='offset') {
      const number=Number(value);
      if(!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number<(key==='limit'?1:0) || number>(key==='limit'?100:1000000)) throw new HttpError(400,'invalid_query','Invalid pagination.');
    } else if(['from','to'].includes(key)) expiry(value);
    else if(['device_id','grant_id'].includes(key))opaqueId(value);
    else if(key==='session_id')text(value,'session_id',128);
    else if(key==='model')text(value,'model',128);
    else if(key==='result'&&!['success','error'].includes(value)||key==='view'&&!['requests','sessions'].includes(value))throw new HttpError(400,'invalid_query','Invalid usage filter.');
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
  const mailerNow=()=>options.mailer || (effectiveMail(config,store) ? createMailer({...config, mail:effectiveMail(config,store)}) : null);
  const auth=new Auth(config,store,mailerNow), payments=new Payments(config,store,options.paymentTransport);
  const access=new Access(store,core);
  const customers=new Customers(store,core), commerce=new Commerce(store,core,customers);
  const reconciler=new Reconciler(store,customers,payments,commerce,options.reconcileIntervalMs??config.reconcileIntervalMs);
  const lockedUsers=customers.locks;
  const inventory=new Inventory(store,core,customers);
  let runtimeInFlight=0;
  const settings=()=>{
    const payment=describePayment(config,store);
    const value=publicSettings(readSite(store),effectiveMail(config,store),payment,config.upstreamUrl);
    value.site.public_origin=config.publicOrigin;
    value.payment={currency:'CNY',min_amount_minor:payment.min_amount_minor,max_amount_minor:payment.max_amount_minor,help_text:payment.help_text,methods:payment.methods.filter(method=>method.offered).map(method=>({id:method.id,title:method.title}))};
    if(config.homePreviewSample) value.features.home_preview=true;
    return value;
  };
  const adminSettings=()=>({...settings(), connection:{configured:Boolean(config.upstreamUrl)}, registration:registrationView(readSite(store))});
  async function connection() {
    if(!config.upstreamUrl) return {configured:false,available:false};
    try {
      const data=await core.request('GET','/access/v1/me');
      const user=project(data.user,schemas.user);
      if(!user?.id || !Array.isArray(data.scopes)) throw new Error('Invalid core metadata');
      return {configured:true,available:user.status==='active',user,scopes:data.scopes.filter(scope=>scopes.includes(scope))};
    } catch(error) { return {configured:true,available:false,error:error instanceof HttpError?error.code:'invalid_core_response'}; }
  }
  async function staticFile(req,res,path) {
    if(!['GET','HEAD'].includes(req.method) || ['/api','/bridge','/access','/admin/api','.'].some(prefix=>path===prefix || path.startsWith(`${prefix}/`)) || path.split('/').some(part=>part.startsWith('.'))) throw new HttpError(404,'not_found','Not found.');
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
      if(path.startsWith('/access/v1/')) {
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
      const hook=path.match(/^\/api\/webhooks\/(stripe|alipay|wxpay|easypay|suixingpay|airwallex)(?:\/([A-Za-z0-9_-]{1,100}))?$/);
      if(hook) {
        if(req.method!=='POST'&&!(req.method==='GET'&&['alipay','easypay'].includes(hook[1])))throw new HttpError(405,'method_not_allowed','Unsupported notification method.');
        store.throttle('webhook:'+req.socket.remoteAddress,300,60000);
        const raw=req.method==='GET'?Buffer.from(url.search.slice(1)):await readBody(req,1024*1024,false);
        const headers=new Headers();for(const [key,value] of Object.entries(req.headers))if(typeof value==='string')headers.set(key,value);
        await payments.webhook(hook[1],raw,headers,hook[2]);
        if(['alipay','easypay','suixingpay'].includes(hook[1])){res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'});res.end('success');}
        else respond(res,200,hook[1]==='wxpay'?{code:'SUCCESS',message:'成功'}:{ok:true});
        return;
      }
      if(path==='/airwallex-checkout.html')res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' https://static.airwallex.com https://static-demo.airwallex.com; connect-src 'self' https://api.airwallex.com https://api-demo.airwallex.com https://checkout.airwallex.com https://checkout-demo.airwallex.com https://static.airwallex.com https://static-demo.airwallex.com; frame-src https://checkout.airwallex.com https://checkout-demo.airwallex.com; img-src 'self' data: https://static.airwallex.com https://static-demo.airwallex.com; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action https://checkout.airwallex.com https://checkout-demo.airwallex.com");
      if(['/vendor/airwallex-sdk.mjs','/vendor/airwallex-tracker.mjs'].includes(path)&&['GET','HEAD'].includes(req.method)) {
        const sdk=path.endsWith('sdk.mjs');
        let source=await readFile(new URL(sdk?'../node_modules/@airwallex/components-sdk/lib/index.mjs':'../node_modules/@airwallex/airtracker/lib/index.mjs',import.meta.url),'utf8');
        if(sdk)source=source.replace("from '@airwallex/airtracker'","from '/vendor/airwallex-tracker.mjs'");
        res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});res.end(req.method==='HEAD'?undefined:source);return;
      }
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
      const memberPrefix=user.core_customer_id?`/access/v1/customers/${opaqueId(user.core_customer_id)}`:null;
      const customerReady=()=>{
        if(!memberPrefix) throw new HttpError(409,'not_provisioned','Contact the administrator to assign an account first.');
        if(user.core_pending) throw new HttpError(409,'core_sync_pending','Customer synchronization must be reconciled first.');
      };
      if(path==='/api/admin/allocation-batches'){
        if(req.method==='POST'){const batch=await inventory.batch(body,()=>auth.require(req,true));respond(res,200,{batch});return;}
        if(req.method==='GET'){
          const limit=Number(url.searchParams.get('limit')||20),offset=Number(url.searchParams.get('offset')||0);if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(offset)||offset<0)throw new HttpError(400,'invalid_query','Invalid batch page.');
          const id=url.searchParams.get('id');const where=id?' WHERE id=?':'',args=id?[id]:[];
          const batches=store.db.prepare('SELECT * FROM allocation_batches'+where+' ORDER BY created_at DESC,id LIMIT ? OFFSET ?').all(...args,limit,offset).map(row=>({id:row.id,status:row.status,items:JSON.parse(row.items),created_at:row.created_at,updated_at:row.updated_at}));
          respond(res,200,{batches,total:store.db.prepare('SELECT COUNT(*) n FROM allocation_batches'+where).get(...args).n,limit,offset});return;
        }
      }
      // Both personal and staff device operations resolve the customer from a local user,
      // never from a browser-supplied provider identifier.
      const deviceRoute=path.match(/^\/api\/(me|admin\/users\/([A-Za-z0-9_-]+))\/devices(?:\/([A-Za-z0-9_-]+)(\/selection)?)?$/);
      if(deviceRoute && !['preview','approve'].includes(deviceRoute[3])) {
        const staff=deviceRoute[1]!=='me', targetId=staff?deviceRoute[2]:user.id;
        const target=store.db.prepare('SELECT * FROM users WHERE id=?').get(targetId);
        if(!target) throw new HttpError(404,'not_found','Customer not found.');
        const id=deviceRoute[3], selection=Boolean(deviceRoute[4]), write=req.method!=='GET';
        const check=()=>{auth.require(req,staff);const current=store.db.prepare('SELECT * FROM users WHERE id=?').get(targetId);if(!current||current.core_customer_id!==target.core_customer_id||current.core_pending||(write&&current.status!=='active'&&req.method!=='DELETE'))throw new HttpError(409,'customer_changed','Customer changed; refresh before continuing.');};
        if(req.method==='GET'&&!id&&!target.core_customer_id){respond(res,200,{devices:[],accounts:[]});return;}
        if(!target.core_customer_id)throw new HttpError(409,'not_provisioned','Assign an account first.');
        check();
        const base=`/access/v1/customers/${opaqueId(target.core_customer_id)}`;
        if(req.method==='GET'&&!id) {
          const [data,accounts]=await Promise.all([core.request('GET',base+'/devices'),core.request('GET',base+'/accounts')]);check();
          const cards=store.labelAccounts(collection(accounts.accounts,schemas.account));const names=new Map(cards.map(a=>[a.grant_id||a.id,a.name]));respond(res,200,{devices:collection(data.devices,schemas.device).map(d=>({...d,account_name:d.current_grant_id?(names.get(d.current_grant_id)||'账号（编号待核对）'):null})),accounts:cards});return;
        }
        if(!id||!(req.method==='DELETE'&&!selection||req.method==='PATCH'&&!selection||req.method==='PUT'&&selection))throw new HttpError(404,'not_found','Unsupported device operation.');
        let payload={};
        if(req.method==='PATCH') {fields(body,['name','expected_name'],['name','expected_name']);payload={name:text(body.name,'name',80),expected_name:text(body.expected_name,'expected_name',80)};}
        else if(selection) {
          fields(body,['surface','grant_id','expected_selection_version'],['surface','grant_id','expected_selection_version']);
          if(body.surface!=='code'||!Number.isSafeInteger(body.expected_selection_version)||body.expected_selection_version<0)throw new HttpError(400,'invalid_device_selection','A Code selection and its observed version are required.');
          payload={surface:'code',grant_id:body.grant_id===null?null:opaqueId(body.grant_id),expected_selection_version:body.expected_selection_version};
        } else fields(body,[]);
        if(lockedUsers.has(targetId))throw new HttpError(409,'user_busy','A customer change is in progress.');
        lockedUsers.add(targetId);
        try {
          check();const result=await core.request(req.method,base+'/devices/'+opaqueId(id)+(selection?'/selection':''),req.method==='DELETE'?undefined:payload,undefined,{authorize:check});
          try {check();} catch {throw new HttpError(503,'core_outcome_unknown','Permission changed; refresh with an authorized session to reconcile the device.');}
          if(req.method==='DELETE') {if(result.ok!==true)throw new HttpError(503,'core_outcome_unknown','Device revocation unconfirmed.');respond(res,200,{ok:true});}
          else {const device=project(result.device,schemas.device);if(!device||device.id!==id)throw new HttpError(503,'core_outcome_unknown','Device change unconfirmed.');respond(res,200,{device});}
          store.audit(user.id,selection?'device.select':req.method==='PATCH'?'device.rename':'device.revoke',targetId+':'+id);
        } finally {lockedUsers.delete(targetId);}
        return;
      }
      const historyRoute=path.match(/^\/api\/(me|admin\/users\/([A-Za-z0-9_-]+))\/usage$/);
      if(historyRoute && req.method==='GET') {
        const staff=historyRoute[1]!=='me',target=staff?store.db.prepare('SELECT * FROM users WHERE id=?').get(historyRoute[2]):user;
        if(!target)throw new HttpError(404,'not_found','Customer not found.');
        if(!target.core_customer_id||target.core_pending)throw new HttpError(409,'customer_not_ready','Customer is not synchronized.');
        const data=await core.request('GET',`/access/v1/customers/${opaqueId(target.core_customer_id)}/usage?${usageQuery(url.searchParams)}`);auth.require(req,staff);
        const current=store.db.prepare('SELECT * FROM users WHERE id=?').get(target.id);if(!current||current.core_customer_id!==target.core_customer_id||current.core_pending)throw new HttpError(409,'customer_changed','Customer changed during read.');
        const usage=project(data.usage,schemas.usage);if(!usage||!Number.isSafeInteger(data.total))throw new HttpError(503,'invalid_core_response','Invalid usage metadata.');
        respond(res,200,{usage,requests:collection(data.requests,schemas.request),sessions:project(data.sessions||[],[schemas.session]),total:data.total,timeline:project(data.timeline,schemas.timeline)||null});return;
      }
      switch(route) {
        case 'GET /api/me/overview': {
          const state=await connection(), pending=[];
          let grants=[],devices=[],usage=null;
          if(store.db.prepare("SELECT 1 FROM users WHERE status='disabled' AND core_pending IS NOT NULL LIMIT 1").get()) pending.push('runtime_suspension_sync_pending');
          if(!memberPrefix) pending.push('customer_not_provisioned');
          if(user.core_pending) pending.push('customer_sync_pending');
          if(memberPrefix && state.available && !user.core_pending) {
            const results=await Promise.allSettled([
              core.request('GET',`/access/v1/grants?customer_id=${opaqueId(user.core_customer_id)}`),
              core.request('GET',`${memberPrefix}/devices`),core.request('GET',`${memberPrefix}/usage?limit=1`),
            ]);
            if(results[0].status==='fulfilled') grants=store.labelAccounts(collection(results[0].value.grants,schemas.grant).filter(g=>g.customer_id===user.core_customer_id)); else pending.push('grants_unavailable');
            if(results[1].status==='fulfilled') devices=collection(results[1].value.devices,schemas.device); else pending.push('devices_unavailable');
            if(results[2].status==='fulfilled') usage=project(results[2].value.usage,schemas.usage) ?? null; else pending.push('usage_unavailable');
          }
          if(!state.available) pending.push('core_unavailable');
          respond(res,200,{grants,devices,usage,wallet:store.wallet(user.id),connection:{configured:state.configured,available:state.available},pending}); return;
        }
        case 'GET /api/me/grants': {
          customerReady();
          const data=await core.request('GET',`/access/v1/grants?customer_id=${opaqueId(user.core_customer_id)}`);
          respond(res,200,{grants:store.labelAccounts(collection(data.grants,schemas.grant).filter(g=>g.customer_id===user.core_customer_id))}); return;
        }
        case 'GET /api/me/accounts': {
          if(!memberPrefix) {respond(res,200,{accounts:[]});return;}
          customerReady();
          const data=await core.request('GET',`${memberPrefix}/accounts`);
          respond(res,200,{accounts:store.labelAccounts(collection(data.accounts,schemas.account))}); return;
        }
        case 'POST /api/me/devices/preview':
        case 'POST /api/me/devices/approve': {
          customerReady(); fields(body,['code'],['code']);
          const preview=path.endsWith('preview'), code=text(body.code,'code',128);
          const data=await core.request('POST',`${memberPrefix}/devices/${preview?'preview':'approve'}`,{code});
          if(preview) { const device=project(data.device,schemas.preview); if(!device) throw new HttpError(503,'invalid_core_response','Invalid device preview.'); respond(res,200,{device}); }
          else { if(data.ok!==true) throw new HttpError(503,'core_outcome_unknown','Device approval has not been confirmed.'); store.audit(user.id,'device.approve',user.id); respond(res,200,{ok:true}); } return;
        }
        case 'GET /api/me/wallet': {
          const ledger=store.db.prepare('SELECT id,order_id,rental_id,amount_minor,currency,kind,created_at FROM ledger WHERE user_id=? ORDER BY created_at DESC LIMIT 200').all(user.id);
          const orders=store.db.prepare('SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 200').all(user.id).map(publicOrder);
          respond(res,200,{wallet:store.wallet(user.id),ledger,orders}); return;
        }
        case 'POST /api/me/payments': {
          fields(body,['amount_minor','payment_method'],['amount_minor']); store.throttle(`checkout:${user.id}`,10,60000);
          respond(res,201,await payments.create(user.id,body.amount_minor,{method:body.payment_method,clientIp:(req.socket.remoteAddress||'').replace('::ffff:','')})); return;
        }
        case 'GET /api/plans':
        case 'GET /api/admin/plans': {respond(res,200,{plans:await commerce.catalog(path.startsWith('/api/admin/'),user.core_customer_id,url.searchParams.get('renew_grant_id'))});return;}
        case 'GET /api/admin/inventory': {const accounts=await inventory.read();auth.require(req,true);respond(res,200,{accounts,device_limit:1});return;}
        case 'POST /api/admin/plans': respond(res,201,{plan:await commerce.savePlan(null,body,()=>auth.require(req,true))});return;
        case 'POST /api/me/rentals': {
          store.throttle(`rental:${user.id}`,10,60000);
          if(body.payment_method!=='wallet') {
            const prior=store.db.prepare('SELECT id FROM rentals WHERE user_id=? AND request_id=?').get(user.id,body.request_id||'');
            const plan=store.db.prepare('SELECT amount_minor FROM plans WHERE id=?').get(body.plan_id || '');
            if(!prior && plan) payments.validateIntent(user.id,plan.amount_minor,false,body.payment_method);
          }
          const result=await commerce.purchase(user.id,body,()=>auth.require(req));
          let checkout=null;
          if(result.created && body.payment_method!=='wallet') {
            try { checkout=await payments.create(user.id,result.rental.amount_minor,{rentalId:result.rental.id,method:body.payment_method,clientIp:(req.socket.remoteAddress||'').replace('::ffff:','')}); }
            catch(error) {
              // Release stock only if no payment request was durably admitted. Unknown outcomes stay reserved.
              store.db.prepare("UPDATE rentals SET status='cancelled',last_error='payment_not_admitted',revision=revision+1 WHERE id=? AND status='awaiting_payment' AND NOT EXISTS (SELECT 1 FROM orders WHERE rental_id=?)").run(result.rental.id,result.rental.id);
              throw error;
            }
          }
          else if(!result.created && result.rental.status==='awaiting_payment') {const row=store.db.prepare('SELECT * FROM orders WHERE rental_id=?').get(result.rental.id);if(row)checkout=payments.checkout(row);}
          if(body.payment_method==='wallet') await commerce.deliver(result.rental.id);
          respond(res,result.created?201:200,{rental:publicRental(store.db.prepare('SELECT * FROM rentals WHERE id=?').get(result.rental.id)),payment:checkout});return;
        }
        case 'GET /api/me/rentals':
        case 'GET /api/admin/rentals': {
          respond(res,200,readOrderPage(store,url.searchParams,{rentals:true,ownerId:path.startsWith('/api/admin/')?null:user.id}));return;
        }
        case 'GET /api/admin/operations': {
          const pending=store.db.prepare("SELECT * FROM users WHERE core_pending IS NOT NULL OR (provision_name IS NOT NULL AND core_customer_id IS NULL) ORDER BY created_at LIMIT 100").all().map(u=>publicUser(u,true));
          let unassigned=[],inventoryAvailable=true,unassignedTotal=null;
          try{const rows=await inventory.read();const assigned=new Set(rows.filter(a=>a.assigned&&a.status==='active'&&Date.parse(a.expires_at)>Date.now()&&Date.parse(a.customer_expires_at)>Date.now()).map(a=>a.user_id));const exclusions=JSON.stringify([...assigned].filter(Boolean)),where="role='member' AND status='active' AND core_pending IS NULL AND id NOT IN (SELECT value FROM json_each(?))";unassignedTotal=store.db.prepare('SELECT COUNT(*) n FROM users WHERE '+where).get(exclusions).n;unassigned=store.db.prepare('SELECT * FROM users WHERE '+where+' ORDER BY created_at,id LIMIT 100').all(exclusions).map(u=>publicUser(u,true));}catch{inventoryAvailable=false;unassigned=store.db.prepare("SELECT * FROM users WHERE role='member' AND status='active' AND core_customer_id IS NULL AND core_pending IS NULL ORDER BY created_at,id LIMIT 100").all().map(u=>publicUser(u,true));}
          auth.require(req,true);
          const totals=store.db.prepare('SELECT status,count(*) AS count FROM rentals GROUP BY status').all();
          const paymentsPending=store.db.prepare('SELECT count(*) AS n FROM orders WHERE status IN ('+paymentReviewStatuses.map(()=>'?').join(',')+')').get(...paymentReviewStatuses).n;
          const deliveriesPending=totals.filter(row=>deliveryReviewStatuses.includes(row.status)).reduce((sum,row)=>sum+row.count,0);
          respond(res,200,{pending_customers:pending,unassigned_customers:unassigned,unassigned_total:unassignedTotal,inventory_available:inventoryAvailable,rentals:totals,payments_pending:paymentsPending,deliveries_pending:deliveriesPending,worker:{interval_ms:config.reconcileIntervalMs,max_attempts:8},readiness:{core_configured:Boolean(config.upstreamUrl),mail_configured:Boolean(effectiveMail(config,store)),payment_configured:describePayment(config,store).configured,https:config.secureCookies,schema_version:store.db.prepare('PRAGMA user_version').get().user_version,runtime_limit:config.runtimeMaxInFlight}});return;
        }
        case 'GET /api/admin/connection': respond(res,200,{...await connection(),upstream_url:config.upstreamUrl,public_origin:config.publicOrigin,environment_managed:config.upstreamEnvironment,revision:core.revision}); return;
        case 'POST /api/admin/upstream': {
          store.throttle(`upstream-config:${user.id}`,10,60000);
          respond(res,200,await core.configure(body,()=>auth.require(req,true)));return;
        }
        case 'GET /api/admin/mail': respond(res,200,{mail:describeMail(config,store),features:settings().features}); return;
        case 'PATCH /api/admin/mail': {
          fields(body,['expected_revision','mail'],['expected_revision','mail']);
          if(config.mail) throw new HttpError(409,'integration_environment_managed','Mail is managed by the environment.');
          store.transaction(()=>{
            const record=JSON.parse(store.db.prepare("SELECT value FROM settings WHERE key='mail'").get().value);
            if(body.expected_revision!==record.revision) throw new HttpError(409,'settings_changed','Mail configuration changed; reload before saving.');
            const mail=applyMailUpdate(record.config,body.mail);
            store.db.prepare("UPDATE settings SET value=? WHERE key='mail'").run(JSON.stringify({revision:record.revision+1,config:mail}));
            store.audit(user.id,'site.mail_update',null);
          });
          respond(res,200,{mail:describeMail(config,store),features:settings().features}); return;
        }
        case 'POST /api/admin/mail/test': {
          fields(body,['mail','recipient']);
          store.throttle('mail-test:'+user.id,5,60000);
          let mail=effectiveMail(config,store);
          if(body.mail!==undefined) {
            if(config.mail) throw new HttpError(409,'integration_environment_managed','Test environment-managed mail without overriding it.');
            const record=JSON.parse(store.db.prepare("SELECT value FROM settings WHERE key='mail'").get().value);
            const draft=applyMailUpdate(record.config,body.mail);
            // Test the draft even when its delivery switch is currently off; never save it.
            mail=effectiveMail(config,store,draft?{...draft,enabled:true}:null);
          }
          if(!mail) throw new HttpError(400,'mail_disabled','Fill in SMTP settings before testing.');
          const recipient=body.recipient!==undefined?email(body.recipient):undefined;
          const result=await testMail(mail,recipient,options.mailTransportFactory);
          store.audit(user.id,recipient?'site.mail_test_send':'site.mail_test_connection',null);
          respond(res,200,result); return;
        }
        case 'GET /api/admin/payment': respond(res,200,{payment:describePayment(config,store),features:settings().features}); return;
        case 'PATCH /api/admin/payment': {
          store.transaction(()=>{
            const value=applyPaymentUpdate(config,store,body);
            store.db.prepare("UPDATE settings SET value=? WHERE key='payment'").run(JSON.stringify(value));
            store.audit(user.id,'site.payment_update',null);
          });
          respond(res,200,{payment:describePayment(config,store),features:settings().features}); return;
        }
        case 'POST /api/admin/payment/test': {
          fields(body,['provider','config'],['provider']);
          store.throttle('payment-test:'+user.id,5,60000);
          if(!Object.hasOwn(paymentProviders,body.provider))throw new HttpError(400,'invalid_input','Unknown provider.');
          if(config.stripe&&body.provider==='stripe'&&body.config!==undefined)throw new HttpError(409,'integration_environment_managed','Stripe credentials are environment managed.');
          if(body.config!==undefined)fields(body.config,paymentProviders[body.provider].fields.map(field=>field.key));
          const current=readPaymentSettings(config,store);
          const parsed=parsePaymentCatalog(current,{providers:{[body.provider]:{...(body.config||{}),enabled:false}}});
          if(!parsed.ok)throw new HttpError(400,'invalid_input',parsed.message);
          const configuration=parsed.value.providers[body.provider];
          // Connection checks may use an unsaved Stripe key before its webhook is entered.
          for(const field of paymentProviders[body.provider].fields)if(field.required&&!configuration[field.key]&&!(body.provider==='stripe'&&field.key==='webhook_secret'))throw new HttpError(400,'invalid_provider_config','Required provider settings are missing.');
          let result;try{result=await new PaymentProvider(body.provider,configuration,options.paymentTransport,config.publicOrigin).test();}catch(error){if(error instanceof HttpError&&error.status===400)throw error;throw new HttpError(503,'payment_verification_unavailable','Payment provider verification failed.');}
          store.audit(user.id,'site.payment_test',body.provider);
          respond(res,200,result);return;
        }
        case 'GET /api/admin/settings': respond(res,200,adminSettings()); return;
        case 'PATCH /api/admin/settings': {
          fields(body,['name','description','support_email','registration_enabled','logo_url','accent_color','email_suffix_whitelist','email_verification_enabled','email_domain_quota_enabled']);
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
          store.transaction(()=>{
            store.db.prepare("UPDATE settings SET value=? WHERE key='site'").run(JSON.stringify(saved));
            store.audit(user.id,'site.update',null);
          });
          respond(res,200,adminSettings()); return;
        }
        case 'GET /api/admin/users': {
          const page=listQuery(url.searchParams),conditions=['(email LIKE ? OR display_name LIKE ?)'],args=['%'+page.q+'%','%'+page.q+'%'];
          for(const [key,allowed] of [['status',['active','disabled','pending_verification']],['role',['admin','member']]]){if(page[key]){if(!allowed.includes(page[key]))throw new HttpError(400,'invalid_query','Unknown customer filter.');conditions.push(key+'=?');args.push(page[key]);}}
          if(page.tag){conditions.push('EXISTS(SELECT 1 FROM json_each(users.tags) WHERE value=?)');args.push(page.tag);}
          if(page.assignment&&!['unassigned','assigned','sync_pending'].includes(page.assignment)||page.due&&!['7','30'].includes(page.due))throw new HttpError(400,'invalid_query','Unknown assignment filter.');
          if(page.assignment==='sync_pending')conditions.push("(core_pending IS NOT NULL OR (provision_name IS NOT NULL AND core_customer_id IS NULL))");
          if(!['unassigned','assigned'].includes(page.assignment)&&!page.due){
            const where=conditions.join(' AND '),total=store.db.prepare('SELECT COUNT(*) n FROM users WHERE '+where).get(...args).n;
            const users=store.db.prepare('SELECT * FROM users WHERE '+where+' ORDER BY created_at,id LIMIT ? OFFSET ?').all(...args,page.limit,page.offset).map(u=>publicUser(u,true));respond(res,200,{users,total,limit:page.limit,offset:page.offset});return;
          }
          let rows=store.db.prepare('SELECT * FROM users WHERE '+conditions.join(' AND ')+' ORDER BY created_at,id').all(...args);
          if(['unassigned','assigned'].includes(page.assignment)||page.due){
            const accounts=await inventory.read();auth.require(req,true);
            rows=rows.filter(u=>{const owned=accounts.filter(a=>a.user_id===u.id&&a.assigned&&a.status==='active'&&Date.parse(a.expires_at)>Date.now()&&Date.parse(a.customer_expires_at)>Date.now());return (!page.assignment||page.assignment==='sync_pending'||(page.assignment==='assigned'?owned.length>0:owned.length===0))&&(!page.due||owned.some(a=>Date.parse(a.customer_expires_at)<=Date.now()+Number(page.due)*86400000));});
          }
          respond(res,200,{users:rows.slice(page.offset,page.offset+page.limit).map(u=>publicUser(u,true)),total:rows.length,limit:page.limit,offset:page.offset});return;
        }
        case 'POST /api/admin/users': {
          fields(body,['email','password','display_name','role','management_profile'],['email','password','display_name','role']);
          if(user.management_profile!=='owner'&&(body.role==='admin'||body.management_profile))throw new HttpError(403,'admin_required','Only the site administrator can create staff.');
          if(body.management_profile&&!Object.hasOwn(managementProfiles,body.management_profile))throw new HttpError(400,'invalid_role','Unknown management profile.');
          if(!['admin','member'].includes(body.role)) throw new HttpError(400,'invalid_role','Invalid role.');
          const address=email(body.email), name=text(body.display_name,'display_name',100), hash=await passwordHash(body.password);
          auth.require(req,true); // Recheck privileges after asynchronous password hashing.
          const created=store.transaction(()=>{ const added=store.createUser({email:address,display_name:name,password_hash:hash,role:body.role,status:'active'}); if(body.role==='admin'&&body.management_profile)store.db.prepare('UPDATE users SET management_profile=? WHERE id=?').run(body.management_profile,added.id);store.audit(user.id,'user.create',added.id);return store.db.prepare('SELECT * FROM users WHERE id=?').get(added.id); });
          respond(res,201,{user:publicUser(created,true)}); return;
        }
        case 'GET /api/admin/resources': { const data=await core.request('GET','/access/v1/resources'); respond(res,200,{resources:collection(data.resources,schemas.resource)}); return; }
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
          const data=await core.request('GET',`/access/v1/grants${query}`);
          respond(res,200,{grants:store.labelAccounts(collection(data.grants,schemas.grant)),total:data.total,limit,offset}); return;
        }
        case 'POST /api/admin/grants': {const grant=await inventory.assign(body,()=>auth.require(req,true));respond(res,201,{grant});return;}
        case 'GET /api/admin/orders': respond(res,200,readOrderPage(store,url.searchParams)); return;
        case 'GET /api/admin/audit': respond(res,200,readAuditPage(store,url.searchParams)); return;
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
      if(req.method==='GET'&&(match=path.match(/^\/api\/me\/payments\/([^/]+)\/(qr\.svg|checkout)$/))) {
        const row=store.db.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(match[1],user.id);
        if(!row)throw new HttpError(404,'order_not_found','Order not found.');
        if(!['pending','creating','unknown'].includes(row.status))throw new HttpError(409,'order_state','This checkout is no longer payable.');
        const data=store.openPayment(row.checkout_data,'checkout:'+row.id);
        if(match[2]==='checkout') {if(!data.airwallex)throw new HttpError(404,'not_found','No embedded checkout.');respond(res,200,data.airwallex);return;}
        if(!data.qr)throw new HttpError(404,'not_found','This order has no QR code.');
        const svg=await QRCode.toString(data.qr,{type:'svg',width:280,margin:2,errorCorrectionLevel:'M'});
        res.writeHead(200,{'Content-Type':'image/svg+xml; charset=utf-8'});res.end(svg);return;
      }
      if(req.method==='GET' && (match=path.match(/^\/api\/me\/payments\/([^/]+)$/))) {
        const order=store.db.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(decodeURIComponent(opaqueId(match[1])),user.id);
        if(!order) throw new HttpError(404,'order_not_found','Order not found.');
        respond(res,200,payments.checkout(order)); return;
      }

      if(req.method==='PATCH' && (match=path.match(/^\/api\/admin\/grants\/([^/]+)$/))) {
        fields(body,['expected_revision','status','expires_at'],['expected_revision']);
        if(!Number.isSafeInteger(body.expected_revision) || body.expected_revision<1 || (body.status!==undefined && !['active','revoked'].includes(body.status))) throw new HttpError(400,'invalid_input','Invalid grant revision/status.');
        if(body.expires_at!==undefined) expiry(body.expires_at);
        const data=await core.request('PATCH',`/access/v1/grants/${opaqueId(match[1])}`,body), grant=project(data.grant,schemas.grant);
        if(grant?.id!==match[1]) throw new HttpError(503,'core_outcome_unknown','Grant update is unconfirmed. Refresh before another change.');
        if(grant.account_lease_id)grant.name=store.labelAccounts([grant])[0].name;
        const auditCustomer=store.db.prepare('SELECT id FROM users WHERE core_customer_id=?').get(grant.customer_id || '');
        const priorLabel=store.db.prepare("SELECT subject_label FROM audit WHERE subject_id=? AND action='grant.create' ORDER BY id DESC LIMIT 1").get(grant.id);
        store.audit(user.id,body.status==='revoked'?'grant.revoke':body.expires_at?'grant.extend':'grant.update',grant.id,'ok',{customer_id:auditCustomer?.id || null,subject_label:priorLabel?.subject_label || (grant.account_lease_id?grant.name:null)}); respond(res,200,{grant}); return;
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
            respond(res,200,{user:publicUser(target,true),customer}); return;
          }
          fields(body,['display_name','status','role','expected_revision','email','notes','tags','admin_password','reason','management_profile']);
          const editing=Object.keys(body).some(key=>key!=='expected_revision');
          if(editing&&(!Number.isSafeInteger(body.expected_revision)||body.expected_revision!==target.revision))throw new HttpError(409,'customer_changed','Customer information changed. Refresh before saving.');
          if(user.management_profile!=='owner'&&(target.role==='admin'||body.role&&body.role!=='member'||body.management_profile))throw new HttpError(403,'admin_required','Only the site administrator can change staff roles.');
          if(body.management_profile&&!Object.hasOwn(managementProfiles,body.management_profile))throw new HttpError(400,'invalid_role','Unknown management profile.');
          if(target.id===user.id && body.status==='disabled') throw new HttpError(409,'self_disable','Administrators cannot disable themselves.');
          if(target.role==='admin'&&target.management_profile==='owner'&&target.status==='active'&&(body.role==='member'||body.status==='disabled'||body.management_profile&&body.management_profile!=='owner')&&store.db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND status='active' AND management_profile='owner'").get().n<=1)throw new HttpError(409,'last_admin','At least one site administrator must remain.');
          const newEmail=body.email===undefined?target.email:email(body.email),emailChanged=newEmail!==target.email;
          const notes=body.notes===undefined?target.notes:text(body.notes,'notes',4000,0);
          let tags=JSON.parse(target.tags||'[]');if(body.tags!==undefined){if(!Array.isArray(body.tags)||body.tags.length>20)throw new HttpError(400,'invalid_input','At most 20 tags are allowed.');tags=[...new Set(body.tags.map(tag=>text(tag,'tag',40)))];}
          let pendingEmail=target.pending_email;
          if(emailChanged){
            text(body.reason,'reason',500);store.throttle('email-change:'+user.id,10,600000);
            if(!await passwordHash(body.admin_password,user.password_hash))throw new HttpError(403,'invalid_password','Administrator password is incorrect.');
            const freshActor=auth.require(req,true).user;
            if(freshActor.password_hash!==user.password_hash||freshActor.management_profile!==user.management_profile)throw new HttpError(409,'account_changed','Administrator credentials changed.');
            if(store.db.prepare('SELECT id FROM users WHERE (email=? OR pending_email=?) AND id<>?').get(newEmail,newEmail,target.id))throw new HttpError(409,'email_exists','This address is already used or awaiting verification.');
            if(settings().features.email_verification){if(!auth.mailer)throw new HttpError(409,'mail_disabled','Email verification must be available before changing this address.');pendingEmail=newEmail;}
          }
          if(store.db.prepare('SELECT revision FROM users WHERE id=?').get(target.id)?.revision!==target.revision)throw new HttpError(409,'customer_changed','Customer changed while validating.');

          if(!Object.keys(body).length && !target.core_pending) throw new HttpError(400,'invalid_input','Provide a user change.');
          if(body.status!==undefined && !['active','disabled'].includes(body.status)) throw new HttpError(400,'invalid_status','Invalid user status.');
          if(body.role!==undefined && !['admin','member'].includes(body.role)) throw new HttpError(400,'invalid_role','Invalid role.');

          if(target.status==='pending_verification' && body.status==='active') throw new HttpError(409,'verification_required','Email verification must be completed.');
          const desired={display_name:body.display_name===undefined?target.display_name:text(body.display_name,'display_name',100),status:body.status || target.status};
          const needsSync=Boolean(target.core_customer_id && (body.status!==undefined || body.display_name!==undefined || target.core_pending));
          store.transaction(()=>{
            const localStatus=needsSync && desired.status==='active' && target.status==='disabled'?'disabled':desired.status;
            store.db.prepare('UPDATE users SET display_name=?,role=?,status=?,core_pending=?,next_sync_at=0,sync_error=NULL,revision=revision+1,email=?,pending_email=?,notes=?,tags=?,management_profile=? WHERE id=? AND revision=?').run(desired.display_name,body.role || target.role,localStatus,needsSync?JSON.stringify(desired):target.core_pending,emailChanged&&!settings().features.email_verification?newEmail:target.email,pendingEmail,notes,JSON.stringify(tags),body.management_profile||target.management_profile,target.id,target.revision);
            if(emailChanged&&!settings().features.email_verification){store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);store.db.prepare('DELETE FROM auth_tokens WHERE user_id=?').run(target.id);}
            if(localStatus!=='active' || (body.role && body.role!==target.role) || body.management_profile&&body.management_profile!==target.management_profile) store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);
            store.audit(user.id,'user.update',target.id,needsSync?'core_pending':'ok',{customer_id:target.id,details:{reason:body.reason||null,before:{display_name:target.display_name,role:target.role,status:target.status,email:target.email,notes:target.notes,tags:JSON.parse(target.tags||'[]'),management_profile:target.management_profile},after:{...desired,role:body.role||target.role,email:emailChanged?newEmail:target.email,notes,tags,management_profile:body.management_profile||target.management_profile},email_verification_pending:Boolean(pendingEmail)}});
          });
          if(emailChanged&&pendingEmail)await auth.sendMail({...target,email:pendingEmail},'verify');
          if(needsSync) await customers.synchronize(target.id,()=>auth.require(req,true));
          target=store.db.prepare('SELECT * FROM users WHERE id=?').get(target.id);
          respond(res,200,{user:publicUser(target,true)}); return;
        } finally { lockedUsers.delete(targetId); }
      }
      if(req.method==='GET'&&/^\/api\/admin\/users\/[A-Za-z0-9_-]+$/.test(path)){auth.require(req,true);const row=store.db.prepare('SELECT * FROM users WHERE id=?').get(path.split('/').at(-1));if(!row)throw new HttpError(404,'user_not_found','User not found.');respond(res,200,{user:publicUser(row,true)});return;}
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

