/** Isolated contract fixture. Never imported by the production application. */
import http from 'node:http';
import { defaultPaymentSettings } from '../../src/payment-settings.js';
import { describePaymentCatalog } from '../../public/payment-catalog.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const publicRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../public');
export const fixtureAccounts = {
  member: { email:'member@example.test', password:'fixture-only-password-123' },
  admin: { email:'admin@example.test', password:'fixture-only-password-123' },
};

export async function startFixture(options = {}) {
  const now = new Date().toISOString();
  const state = {
    requests: [], sessions:new Map(), failures:new Map(), disconnected:new Set(),
    public: {site:{name:'紫序工作台',description:'一个安静、高效的 Code 工作空间。',support_email:'support@example.test',currency:'CNY',logo_url:'https://untrusted.invalid/tracking.svg'},features:{registration:false,email_verification:false,password_reset:false,payment:false,token_billing:false,...options.features},setup_required:options.setupRequired || false},
    users:[{id:'admin-1',email:fixtureAccounts.admin.email,display_name:'测试管理员',role:'admin',status:'active',core_customer_id:'customer-admin',created_at:now},{id:'member-1',email:fixtureAccounts.member.email,display_name:options.displayName || '测试成员',role:'member',status:'active',core_customer_id:'customer-member',created_at:now}],
    connection:{configured:Boolean(options.connected),available:Boolean(options.connected),...(options.connected ? {user:{id:'merchant-fixture',name:'独立测试商户'},scopes:['resources.read','customers.read','customers.write','delegation.grants.read','delegation.grants.write','delegation.devices.read','delegation.devices.write','delegation.usage.read','runtime','delegation.keys.manage']} : {})},
    pending:options.pending || [], resources:options.resources || [], grants:options.grants || [],devices:options.devices || [],orders:[],ledger:[],events:[],
    checkoutUrl:options.checkoutUrl || 'https://checkout.stripe.com/c/pay/fixture-only', grantConflict:false,
  };
  state.public.payment={currency:'CNY',min_amount_minor:1,max_amount_minor:1000000,help_text:'',methods:state.public.features.payment?[{id:'stripe',title:'Stripe 收银台'}]:[]};
  let origin;
  const server = http.createServer(async (req,res) => {
    const url = new URL(req.url,origin); const path = url.pathname;
    const reply = (status,data,message) => { const payload = status >= 400 ? {error:{code:data,message}} : data; res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(payload)); };
    try {
      if (!path.startsWith('/api/')) {
        if (!['GET','HEAD'].includes(req.method)) return reply(405,'method_not_allowed','Method not allowed.');
        const asset = {'/app.js':['app.js','text/javascript; charset=utf-8'],'/payment-checkout.js':['payment-checkout.js','text/javascript; charset=utf-8'],'/mail-settings.js':['mail-settings.js','text/javascript; charset=utf-8'],'/payment-settings.js':['payment-settings.js','text/javascript; charset=utf-8'],'/payment-catalog.js':['payment-catalog.js','text/javascript; charset=utf-8'],'/usage-detail.js':['usage-detail.js','text/javascript; charset=utf-8'],'/registration-policy.js':['registration-policy.js','text/javascript; charset=utf-8'],'/styles.css':['styles.css','text/css; charset=utf-8'],'/mark.svg':['mark.svg','image/svg+xml']}[path] || ['index.html','text/html; charset=utf-8'];
        const body = await readFile(resolve(publicRoot,asset[0]));
        res.writeHead(200,{'Content-Type':asset[1],'Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"});
        return res.end(body);
      }
      let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 20000) return reply(413,'too_large','Request too large.'); }
      let body = {}; if (raw) { try { body = JSON.parse(raw); } catch { return reply(400,'invalid_json','Invalid JSON.'); } }
      const cookie = /(?:^|;\s*)fixture_session=([^;]+)/.exec(req.headers.cookie || '')?.[1]; const session = state.sessions.get(cookie); const user = state.users.find(u => u.id === session?.userId);
      const write = req.method !== 'GET';
      // Only synthetic fixture payloads live in this in-memory inspection log.
      const loggedBody = {...body}; for (const key of ['password','current_password','new_password','setup_token','token']) if (key in loggedBody) loggedBody[key] = '[redacted]';
      state.requests.push({method:req.method,path,query:url.search,body:loggedBody,csrf:req.headers['x-csrf-token'],origin:req.headers.origin,authenticated:Boolean(user)});
      if (state.disconnected.has(path)) { state.disconnected.delete(path); res.writeHead(200,{'Content-Type':'application/json'}); res.write('{"incomplete":'); setTimeout(() => res.destroy(),20); return; }
      const failure = state.failures.get(path);
      if (failure) { if (!failure.repeat) state.failures.delete(path); return reply(failure.status,failure.code,failure.message); }
      if (write && req.headers.origin !== origin) return reply(403,'invalid_origin','A same-origin request is required.');
      if (path === '/api/public' && !write) return reply(200,state.public);
      if (path === '/api/auth/login' && req.method === 'POST') {
        const account = Object.values(fixtureAccounts).find(a => a.email === body.email && a.password === body.password);
        const found = account && state.users.find(u => u.email === body.email);
        if (!found) return reply(401,'invalid_credentials','邮箱或密码不正确。');
        const id = randomUUID(), csrf = `fixture-csrf-${randomUUID()}`; state.sessions.set(id,{userId:found.id,csrf});
        res.setHeader('Set-Cookie',`fixture_session=${id}; Path=/; HttpOnly; SameSite=Lax`); return reply(200,{user:found,csrf_token:csrf});
      }
      if (path === '/api/setup' && req.method === 'POST') {
        if (!state.public.setup_required) return reply(409,'setup_complete','Setup already complete.');
        if (body.setup_token !== 'fixture-setup-token') return reply(403,'invalid_setup','Invalid setup token.');
        state.public.setup_required = false; const found = state.users[0]; const id = randomUUID(),csrf = `fixture-csrf-${randomUUID()}`;
        state.sessions.set(id,{userId:found.id,csrf}); res.setHeader('Set-Cookie',`fixture_session=${id}; Path=/; HttpOnly; SameSite=Lax`); return reply(201,{user:found,csrf_token:csrf});
      }
      if (['/api/auth/register','/api/auth/verify','/api/auth/forgot-password','/api/auth/reset-password'].includes(path) && write) {
        if (path.endsWith('/register')) return state.public.features.registration ? reply(201,{status:state.public.features.email_verification ? 'verification_required' : 'created'}) : reply(503,'registration_disabled','Registration disabled.');
        const enabled = path.endsWith('/verify') ? state.public.features.email_verification : state.public.features.password_reset;
        return enabled ? reply(200,{ok:true}) : reply(503,'mail_disabled','Email services disabled.');
      }
      if (!user) return reply(401,'session_required','Please sign in.');
      if (write && req.headers['x-csrf-token'] !== session.csrf) return reply(403,'invalid_csrf','CSRF validation failed.');
      if (path === '/api/auth/session' && !write) return reply(200,{user,csrf_token:session.csrf});
      if (path === '/api/auth/logout') { state.sessions.delete(cookie); res.setHeader('Set-Cookie','fixture_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax'); return reply(200,{ok:true}); }
      if (path === '/api/auth/password') { state.sessions.delete(cookie); return reply(200,{ok:true}); }
      if (path.startsWith('/api/admin/') && user.role !== 'admin') return reply(403,'admin_required','Admin required.');
      if (path === '/api/me/overview') return reply(200,{grants:state.grants,devices:state.devices,usage:null,wallet:{balance_minor:0,currency:'CNY'},connection:state.connection,pending:state.pending});
      if (path === '/api/me/grants') return reply(200,{grants:state.grants});
      if (path === '/api/me/devices') return reply(200,{devices:state.devices,accounts:[]});
      if (path === '/api/me/devices/preview') {
        if (body.code !== 'TEST-CONNECT') return reply(400,'invalid_code','连接码无效或已过期。');
        return reply(200,{device:{name:'我的测试笔记本',platform:'Windows',code:body.code,expires_at:new Date(Date.now()+600000).toISOString(),renewal:false}});
      }
      if (path === '/api/me/devices/approve') {
        if (body.code !== 'TEST-CONNECT') return reply(400,'invalid_code','Invalid code.');
        state.devices.push({id:'device-fixture',name:'我的测试笔记本',platform:'Windows',state:'active',created_at:now,expires_at:new Date(Date.now()+86400000).toISOString()}); return reply(200,{ok:true});
      }
      if (path.startsWith('/api/me/devices/') && req.method === 'DELETE') { state.devices = state.devices.filter(d => d.id !== decodeURIComponent(path.split('/').pop())); return reply(200,{ok:true}); }
      if (path === '/api/me/usage') return reply(200,{usage:null,requests:[],total:0});
      if (path === '/api/me/wallet') return reply(200,{wallet:{balance_minor:0,currency:'CNY'},ledger:state.ledger,orders:state.orders});
      if (path === '/api/plans' || path === '/api/admin/plans') return reply(200,{plans:[]});
      if (path === '/api/me/accounts') return reply(200,{accounts:[]});
      if (path === '/api/me/payments' && req.method === 'POST') {
        if (!state.public.features.payment) return reply(503,'payment_disabled','Payments are not configured.');
        const order = {id:`order-${state.orders.length+1}`,status:'pending',amount_minor:body.amount_minor,currency:'CNY',created_at:now}; state.orders.push(order); return reply(201,{order,checkout_url:state.checkoutUrl});
      }
      if (path.startsWith('/api/me/payments/') && !write) { const order = state.orders.find(o => o.id === decodeURIComponent(path.split('/').pop())); return order ? reply(200,{order}) : reply(404,'not_found','Order not found.'); }
      if(path==='/api/admin/access-accounts'&&!write)return reply(200,{accounts:[]});
      if (path === '/api/admin/connection') return reply(200,state.connection);
      if (path === '/api/admin/inventory') return reply(200,{accounts:state.grants.map(g=>({id:'held-'+g.id,resource_id:g.resource_id,platform:'Windows/x64',status:'active',revision:2,expires_at:new Date(Date.now()+90*86400000).toISOString(),grant_id:g.id,grant_revision:g.revision,customer_expires_at:g.expires_at,assigned:g.status==='active',user_id:'member-1',customer_name:'测试成员',details:{name:g.name,state:'available',device_name:''}}))});
      if (path === '/api/admin/resources') return reply(200,{resources:state.resources});
      if (path === '/api/admin/users' && !write) return reply(200,{users:state.users});
      if (path === '/api/admin/users' && req.method === 'POST') {
        const created = {id:`user-${state.users.length+1}`,email:body.email,display_name:body.display_name,role:body.role,status:'active',created_at:now}; state.users.push(created); return reply(201,{user:created});
      }
      if (/^\/api\/admin\/users\/[^/]+\/provision$/.test(path)) {
        const found = state.users.find(u => u.id === decodeURIComponent(path.split('/')[4])); if (!found) return reply(404,'not_found','User not found.'); found.core_customer_id = `customer-${found.id}`; return reply(200,{user:found,customer:{id:found.core_customer_id}});
      }
      if (path.startsWith('/api/admin/users/') && req.method === 'PATCH') {
        const found = state.users.find(u => u.id === decodeURIComponent(path.split('/').pop())); if (!found) return reply(404,'not_found','User not found.');
        if (found.role === 'admin' && (body.role === 'member' || body.status === 'disabled')) return reply(409,'last_admin','The last active administrator must be preserved.');
        Object.assign(found,body); return reply(200,{user:found});
      }
      if (path === '/api/admin/grants' && !write) return reply(200,{grants:state.grants});
      if (path === '/api/admin/grants' && req.method === 'POST') {
        const resource = state.resources.find(r => r.id === body.resource_id); if (!resource) return reply(400,'invalid_resource','Unknown resource.');
        const grant = {id:`grant-${state.grants.length+1}`,customer_id:'customer-member',resource_id:resource.id,name:resource.name,status:'active',surfaces:['code'],expires_at:body.expires_at,revision:1,updated_at:now}; state.grants.push(grant); return reply(201,{grant});
      }
      if (path.startsWith('/api/admin/grants/') && req.method === 'PATCH') {
        const grant = state.grants.find(g => g.id === decodeURIComponent(path.split('/').pop())); if (!grant) return reply(404,'not_found','Grant not found.');
        if (state.grantConflict) { grant.revision++; state.grantConflict = false; }
        if (body.expected_revision !== grant.revision) return reply(409,'revision_conflict','授权已被其他操作更新。');
        const {expected_revision,...patch} = body; Object.assign(grant,patch,{revision:grant.revision+1}); return reply(200,{grant});
      }

      if (path === '/api/admin/orders') return reply(200,{orders:state.orders});
      if (path === '/api/admin/audit') return reply(200,{events:state.events});
      if (path === '/api/admin/operations') return reply(200,{pending_customers:[],rentals:[],payments_pending:0,worker:{interval_ms:15000,max_attempts:8},readiness:{core_configured:Boolean(state.connection.configured),mail_configured:false,payment_configured:Boolean(state.public.features.payment),https:false,schema_version:3,runtime_limit:8}});
      if (path === '/api/admin/settings' && req.method === 'PATCH') {
        Object.assign(state.public.site,{name:body.name,description:body.description,support_email:body.support_email}); state.public.features.registration = body.registration_enabled; return reply(200,{site:state.public.site,features:state.public.features});
      }
      if (path === '/api/admin/mail') return reply(200,{mail:{revision:1,configured:false,editable:true,enabled:true,port:587,use_tls:true},features:state.public.features});
      if (path === '/api/admin/payment') {
        const settings=defaultPaymentSettings({});
        return reply(200,{payment:{...settings,...describePaymentCatalog(settings),configured:state.public.features.payment},features:state.public.features});
      }
      if (path === '/api/admin/settings') return reply(200,{site:state.public.site,features:state.public.features,connection:{configured:state.connection.configured}});
      return reply(404,'not_found','Fixture endpoint is not part of the contract.');
    } catch { if (!res.headersSent) reply(500,'fixture_error','Fixture could not complete the request.'); else res.end(); }
  });
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(options.port || 0,'127.0.0.1',resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  state.public.site.public_origin = origin;
  return {origin,state,close:() => new Promise((resolve,reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); })};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fixture = await startFixture({port:Number(process.env.PORT) || 0});
  console.log(`Isolated browser fixture: ${fixture.origin}`);
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal,async () => { await fixture.close(); process.exit(0); });
}
