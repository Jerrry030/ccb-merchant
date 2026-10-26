import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixture, fixtureAccounts } from './fixture-server.mjs';

// Use an existing local/bundled Playwright package. This suite never installs browsers or packages.
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const captureRoot = resolve(dirname(fileURLToPath(import.meta.url)),'artifacts');
let browser;
before(async () => { browser = await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH} : {})}); });
after(async () => { await browser?.close(); });

async function harness(t, options = {}) {
  const fixture = await startFixture(options); const context = await browser.newContext({viewport:{width:1440,height:1050},reducedMotion:'reduce'});
  const unexpected = [], errors = [];
  await context.route('**/*',route => { const url = new URL(route.request().url()); if (url.origin !== fixture.origin) { unexpected.push(url.origin); return route.abort(); } return route.continue(); });
  context.setDefaultTimeout(10000);
  const page = await context.newPage(); page.on('pageerror',error => errors.push(error.message));
  t.after(async () => { await context.close(); await fixture.close(); assert.deepEqual(unexpected,[],'The frontend must not request external assets or APIs'); assert.deepEqual(errors,[],'No uncaught browser errors'); });
  return {fixture,context,page};
}
async function login({page,fixture},role = 'member',path = '/') {
  await page.goto(fixture.origin + path);
  await page.getByRole('heading',{name:'欢迎回来',exact:true}).waitFor();
  await page.getByLabel('电子邮箱',{exact:true}).fill(fixtureAccounts[role].email);
  await page.getByLabel('密码',{exact:true}).fill(fixtureAccounts[role].password);
  await page.getByRole('button',{name:'登录工作台',exact:true}).click();
  await page.locator('.shell').waitFor();
  await page.locator('#page-content:not([aria-busy])').waitFor();
}

// All credentials, resources, keys and orders below are synthetic and confined to the fixture.
test('member identity controls navigation; direct admin routes do not fetch privileged APIs',async t => {
  const h = await harness(t); await login(h);
  await h.page.getByRole('heading',{name:'工作概览',exact:true}).waitFor();
  await h.page.getByText('工作空间尚未连接上游服务',{exact:true}).waitFor();
  assert.equal(await h.page.getByRole('link',{name:'客户管理',exact:true}).count(),0);
  assert.equal(await h.page.getByRole('link',{name:'API 接入',exact:true}).count(),0);
  assert.equal(await h.page.getByRole('combobox').count(),0,'No identity/role switch');
  assert.equal(await h.page.getByText('—',{exact:true}).count(),3,'Unavailable upstream data must not be represented as zero');
  await h.page.goto(h.fixture.origin + '/admin/access');
  await h.page.getByRole('heading',{name:'没有管理权限',exact:true}).waitFor();
  assert.equal(h.fixture.state.requests.filter(r => r.path.startsWith('/api/admin/')).length,0);
});

test('member empty and unavailable views have honest states; payment stays disabled',async t => {
  const h = await harness(t); await login(h);
  for (const [link,text] of [['我的权益','尚未分配权益'],['设备管理','还没有连接设备'],['用量明细','此区间暂无请求'],['我的钱包','支付服务尚未配置']]) {
    await h.page.getByRole('link',{name:link,exact:true}).click(); await h.page.getByText(text,{exact:true}).waitFor();
  }
  assert.equal(await h.page.getByRole('button',{name:'在线支付未启用',exact:true}).isDisabled(),true);
  assert.equal(await h.page.getByLabel('充值金额（人民币元）').isDisabled(),true);
  assert.equal(h.fixture.state.requests.filter(r => r.path === '/api/me/payments').length,0);
  await h.page.getByText('本页仅展示人民币余额、账本与支付订单。参考 USD 不是零售费用；本工作台不提供手动充值入口。',{exact:true}).waitFor();
  await h.page.getByRole('link',{name:'个人设置',exact:true}).click(); await h.page.getByRole('heading',{name:'登录安全',exact:true}).waitFor();
});

test('admin uses the same layout and sees only genuine empty data/configuration',async t => {
  const h = await harness(t); await login(h,'admin');
  for (const title of ['客户管理','资源与授权','API 接入','支付订单','审计日志','站点设置']) assert.equal(await h.page.getByRole('link',{name:title,exact:true}).count(),1);
  for (const [link,text] of [['资源与授权','尚无可分配资源'],['API 接入','暂无 API 客户'],['支付订单','暂无支付订单'],['审计日志','暂无审计记录'],['站点设置','上游服务连接']]) {
    await h.page.getByRole('link',{name:link,exact:true}).click(); await h.page.getByText(text,{exact:true}).waitFor();
  }
  if (process.env.CCB_BROWSER_CAPTURE === '1') { await mkdir(captureRoot,{recursive:true}); await h.page.screenshot({path:resolve(captureRoot,'admin-settings.png'),fullPage:true}); }
  assert.equal(await h.page.locator('input[type=password]').count(),0,'Admin settings cannot edit upstream secrets');
  assert.equal(h.fixture.state.requests.some(r => r.method !== 'GET' && r.path.startsWith('/api/admin/')),false);
});

test('unconfigured public features remain inaccessible, including direct URLs',async t => {
  const {page,fixture} = await harness(t); await page.goto(fixture.origin + '/login');
  await page.getByRole('heading',{name:'欢迎回来',exact:true}).waitFor();
  if (process.env.CCB_BROWSER_CAPTURE === '1') { await mkdir(captureRoot,{recursive:true}); await page.screenshot({path:resolve(captureRoot,'login.png'),fullPage:true}); }
  assert.equal(await page.getByRole('link',{name:'忘记密码？',exact:true}).count(),0);
  assert.equal(await page.getByRole('link',{name:'创建账户 →',exact:true}).count(),0);
  for (const path of ['/register','/verify','/forgot','/reset','/setup']) { await page.goto(fixture.origin+path); await page.getByText('此功能当前不可用',{exact:true}).waitFor(); }
  assert.equal(fixture.state.requests.filter(r => r.method !== 'GET').length,0);
});

test('enabled registration, verification and password reset are explicit and scrub URL tokens',async t => {
  const {page,fixture} = await harness(t,{features:{registration:true,email_verification:true,password_reset:true}});
  await page.goto(fixture.origin+'/register');
  await page.getByLabel('显示名称',{exact:true}).fill('新测试成员'); await page.getByLabel('电子邮箱',{exact:true}).fill('new@example.test');
  await page.getByLabel('密码',{exact:true}).fill('fixture-new-password-123'); await page.getByLabel('确认密码',{exact:true}).fill('fixture-new-password-123');
  await page.getByRole('button',{name:'创建账户',exact:true}).click(); await page.getByText('请前往邮箱完成验证，然后返回登录。',{exact:true}).waitFor();
  await page.goto(fixture.origin+'/verify?token=fixture-verification-token');
  await page.getByRole('heading',{name:'验证电子邮箱',exact:true}).waitFor(); assert.equal(new URL(page.url()).search,'');
  assert.equal(fixture.state.requests.filter(r => r.path === '/api/auth/verify').length,0,'Opening a link must not auto-submit');
  await page.getByRole('button',{name:'确认验证',exact:true}).click(); await page.getByText('邮箱已验证，请返回登录。',{exact:true}).waitFor();
  await page.goto(fixture.origin+'/forgot'); await page.getByLabel('电子邮箱',{exact:true}).fill('anyone@example.test');
  await page.getByRole('button',{name:'发送重置邮件',exact:true}).click(); await page.getByText('如果账户符合条件，您将收到重置邮件。请同时检查垃圾邮件。',{exact:true}).waitFor();
  await page.goto(fixture.origin+'/reset?token=fixture-reset-token'); await page.getByRole('heading',{name:'设置新密码',exact:true}).waitFor(); assert.equal(new URL(page.url()).search,'');
  await page.getByLabel('新密码',{exact:true}).fill('fixture-reset-password-123'); await page.getByLabel('确认密码',{exact:true}).fill('fixture-reset-password-123');
  await page.getByRole('button',{name:'重置密码',exact:true}).click(); await page.getByText('密码已重置，请使用新密码登录。',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('重置令牌',{exact:true}).inputValue(),'');
});

test('one-time setup requires confirmation and establishes server administrator identity',async t => {
  const {page,fixture} = await harness(t,{setupRequired:true}); await page.goto(fixture.origin+'/');
  await page.getByRole('heading',{name:'初始化工作台',exact:true}).waitFor();
  await page.getByLabel('初始化令牌',{exact:true}).fill('fixture-setup-token'); await page.getByLabel('显示名称',{exact:true}).fill('首位管理员');
  await page.getByLabel('电子邮箱',{exact:true}).fill('owner@example.test'); await page.getByLabel('密码',{exact:true}).fill('fixture-setup-password-123'); await page.getByLabel('确认密码',{exact:true}).fill('fixture-setup-password-123');
  await page.getByRole('button',{name:'创建管理员',exact:true}).click(); await page.getByRole('dialog').waitFor();
  assert.equal(fixture.state.requests.filter(r => r.path === '/api/setup').length,0);
  await page.getByRole('button',{name:'确认初始化',exact:true}).click(); await page.getByRole('heading',{name:'上游接入',exact:true}).waitFor(); await page.getByRole('link',{name:'稍后配置，返回工作台',exact:true}).click(); await page.getByRole('heading',{name:'工作概览',exact:true}).waitFor();
  assert.equal(await page.getByRole('link',{name:'客户管理',exact:true}).count(),1);
});

test('connect query survives login without auto-approval; writes use cookie and CSRF',async t => {
  const h = await harness(t,{connected:true}); await login(h,'member','/connect?code=TEST-CONNECT');
  await h.page.getByRole('heading',{name:'连接设备',exact:true}).waitFor(); assert.equal(new URL(h.page.url()).pathname,'/connect'); assert.equal(new URL(h.page.url()).search,'');
  assert.equal(await h.page.getByLabel('CCB 连接码',{exact:true}).inputValue(),'TEST-CONNECT');
  assert.equal(h.fixture.state.requests.filter(r => r.path.includes('/devices/approve')).length,0);
  await h.page.getByRole('button',{name:'查看设备信息',exact:true}).click(); await h.page.getByText('我的测试笔记本',{exact:true}).waitFor();
  await h.page.getByRole('button',{name:'确认授权此设备',exact:true}).click(); await h.page.getByRole('dialog').waitFor();
  assert.equal(h.fixture.state.requests.filter(r => r.path.includes('/devices/approve')).length,0);
  await h.page.getByRole('button',{name:'确认授权',exact:true}).click(); await h.page.getByRole('heading',{name:'设备管理',exact:true}).waitFor();
  const writes = h.fixture.state.requests.filter(r => ['/api/me/devices/preview','/api/me/devices/approve'].includes(r.path));
  assert.equal(writes.length,2); for (const req of writes) { assert.equal(req.authenticated,true); assert.match(req.csrf,/^fixture-csrf-/); assert.equal(req.origin,h.fixture.origin); assert.equal(req.body.code,'TEST-CONNECT'); }
  await h.page.getByRole('button',{name:'撤销连接',exact:true}).click(); await h.page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();
  assert.equal(h.fixture.state.devices.length,1,'Cancel must not delete');
});

test('grant revoke carries exact revision, rejects 409, then requires fresh explicit confirmation',async t => {
  const resource = {id:'resource-1',name:'测试 Code 资源',status:'active',capacity:5,allocated:1,revision:2,surfaces:['code'],expires_at:null};
  const grant = {id:'grant-1',resource_id:resource.id,name:resource.name,status:'active',revision:7,surfaces:['code'],expires_at:null};
  const h = await harness(t,{connected:true,resources:[resource],grants:[grant]}); await login(h,'admin'); h.fixture.state.grantConflict = true;
  await h.page.goto(h.fixture.origin+'/admin/resources?user_id=member-1'); await h.page.getByRole('button',{name:'撤销授权',exact:true}).waitFor();
  await h.page.getByRole('button',{name:'撤销授权',exact:true}).click(); await h.page.getByRole('dialog').getByRole('button',{name:'撤销授权',exact:true}).click();
  await h.page.getByText('状态冲突，未覆盖新版本',{exact:true}).waitFor();
  let writes = h.fixture.state.requests.filter(r => r.method === 'PATCH' && r.path === '/api/admin/grants/grant-1'); assert.equal(writes.length,1); assert.equal(writes[0].body.expected_revision,7); assert.equal(h.fixture.state.grants[0].status,'active');
  await h.page.getByRole('button',{name:'刷新最新状态',exact:true}).click(); await h.page.getByRole('button',{name:'撤销授权',exact:true}).click(); await h.page.getByRole('dialog').getByRole('button',{name:'撤销授权',exact:true}).click();
  await h.page.getByRole('button',{name:'恢复授权',exact:true}).waitFor(); writes = h.fixture.state.requests.filter(r => r.method === 'PATCH' && r.path === '/api/admin/grants/grant-1'); assert.equal(writes.length,2); assert.equal(writes[1].body.expected_revision,8);
});

test('last-admin error is actionable and never locally changes the current role',async t => {
  const h = await harness(t); await login(h,'admin'); await h.page.getByRole('link',{name:'客户管理',exact:true}).click();
  await h.page.getByRole('row').filter({hasText:'admin@example.test'}).getByRole('button',{name:'编辑',exact:true}).click();
  await h.page.getByLabel('账户角色',{exact:true}).selectOption('member'); await h.page.getByRole('button',{name:'保存客户信息',exact:true}).click(); await h.page.getByRole('dialog').filter({hasText:'确认修改客户'}).getByRole('button',{name:'确认保存',exact:true}).click();
  await h.page.getByText('需要保留可用的管理员',{exact:true}).waitFor(); assert.equal(h.fixture.state.users[0].role,'admin'); assert.equal(await h.page.getByRole('link',{name:'站点设置',exact:true}).count(),1);
});


test('ambiguous write is not retried or reported successful',async t => {
  const h = await harness(t,{features:{payment:true}}); await login(h); await h.page.getByRole('link',{name:'我的钱包',exact:true}).click();
  h.fixture.state.disconnected.add('/api/me/payments'); await h.page.getByLabel('充值金额（人民币元）').fill('12.34');
  await h.page.getByRole('button',{name:'创建 Stripe 支付订单',exact:true}).click(); await h.page.getByRole('button',{name:'创建订单',exact:true}).click();
  await h.page.getByText('操作结果尚未确认',{exact:true}).waitFor(); assert.equal(await h.page.getByRole('button',{name:'创建 Stripe 支付订单',exact:true}).isDisabled(),true);
  assert.equal(h.fixture.state.requests.filter(r => r.path === '/api/me/payments').length,1); assert.equal(h.fixture.state.orders.length,0);
});

test('unsafe checkout URL is inert and amount is sent as integer minor units',async t => {
  const h = await harness(t,{features:{payment:true},checkoutUrl:'javascript:globalThis.checkoutLeak=true'}); await login(h); await h.page.getByRole('link',{name:'我的钱包',exact:true}).click();
  await h.page.getByLabel('充值金额（人民币元）').fill('12.34'); await h.page.getByRole('button',{name:'创建 Stripe 支付订单',exact:true}).click(); await h.page.getByRole('button',{name:'创建订单',exact:true}).click();
  await h.page.getByText('订单已记录，但支付链接不可安全使用',{exact:true}).waitFor(); assert.equal(await h.page.locator('a[href^="javascript:"]').count(),0);
  assert.equal(h.fixture.state.requests.find(r => r.path === '/api/me/payments').body.amount_minor,1234); assert.equal(await h.page.evaluate(() => globalThis.checkoutLeak),undefined);
  await h.page.goto(h.fixture.origin+'/wallet?order=order-1&success=true'); await h.page.getByRole('heading',{name:'返回后的订单核对',exact:true}).waitFor(); assert.equal(await h.page.getByText('已支付',{exact:true}).count(),0); assert.equal(h.fixture.state.orders[0].status,'pending');
});

test('valid checkout is an explicit external link, never an automatic redirect or charge',async t => {
  const h = await harness(t,{features:{payment:true}}); await login(h); await h.page.getByRole('link',{name:'我的钱包',exact:true}).click();
  await h.page.getByLabel('充值金额（人民币元）').fill('20.00'); await h.page.getByRole('button',{name:'创建 Stripe 支付订单',exact:true}).click(); await h.page.getByRole('button',{name:'创建订单',exact:true}).click();
  const link = h.page.getByRole('link',{name:'打开 Stripe 收银台 ↗',exact:true}); await link.waitFor(); assert.equal(await link.getAttribute('target'),'_blank'); assert.equal(await link.getAttribute('rel'),'noopener noreferrer'); assert.equal(new URL(h.page.url()).origin,h.fixture.origin);
});

test('API failures are not converted into empty success and malicious display text is inert',async t => {
  const h = await harness(t,{displayName:'<img src=x onerror="globalThis.injected=true">'}); await login(h);
  assert.equal(await h.page.locator('.user-info img').count(),0); assert.equal(await h.page.evaluate(() => globalThis.injected),undefined);
  h.fixture.state.failures.set('/api/me/usage',{status:503,code:'core_unavailable',message:'核心服务不可用。'});
  await h.page.getByRole('link',{name:'用量明细',exact:true}).click(); await h.page.getByRole('heading',{name:'数据暂不可用',exact:true}).waitFor(); assert.equal(await h.page.getByText('此区间暂无请求',{exact:true}).count(),0);
  await h.page.getByRole('button',{name:'重试读取',exact:true}).click(); await h.page.getByText('此区间暂无请求',{exact:true}).waitFor();
});

test('responsive light/dark layout has no page overflow and preference persists',async t => {
  const h = await harness(t); await login(h); await h.page.getByRole('heading',{name:'我的资源',exact:true}).waitFor();
  if (process.env.CCB_BROWSER_CAPTURE === '1') { await mkdir(captureRoot,{recursive:true}); await h.page.screenshot({path:resolve(captureRoot,'overview-light.png'),fullPage:true}); }
  await h.page.getByRole('button',{name:'切换深色主题',exact:true}).click(); assert.equal(await h.page.locator('html').getAttribute('data-theme'),'dark');
  if (process.env.CCB_BROWSER_CAPTURE === '1') await h.page.screenshot({path:resolve(captureRoot,'overview-dark.png'),fullPage:true});
  await h.page.reload(); await h.page.getByRole('heading',{name:'我的资源',exact:true}).waitFor(); assert.equal(await h.page.locator('html').getAttribute('data-theme'),'dark');
  await h.page.setViewportSize({width:390,height:844}); assert.equal(await h.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),true);
  if (process.env.CCB_BROWSER_CAPTURE === '1') await h.page.screenshot({path:resolve(captureRoot,'overview-mobile.png'),fullPage:true});
  await h.page.getByRole('button',{name:'打开导航',exact:true}).click(); await h.page.getByRole('link',{name:'我的权益',exact:true}).click(); await h.page.getByText('尚未分配权益',{exact:true}).waitFor();
  assert.equal(await h.page.getByRole('button',{name:'打开导航',exact:true}).getAttribute('aria-expanded'),'false');
});

test('partial overview failures preserve unknown counters even when core itself is available',async t => {
  const h = await harness(t,{connected:true,pending:['grants_unavailable','devices_unavailable','usage_unavailable']}); await login(h);
  await h.page.getByText('权益数据暂不可用 · 设备数据暂不可用 · 用量统计暂不可用',{exact:true}).waitFor();
  assert.equal(await h.page.getByText('—',{exact:true}).count(),3);
  await h.page.getByText('等待资源连接',{exact:true}).waitFor(); assert.equal(await h.page.getByText('还没有可用权益',{exact:true}).count(),0);
});

test('customer create/provision and resource assignment are distinct confirmed writes',async t => {
  const resource = {id:'resource-1',name:'仅供回归的 Code 资源',status:'active',capacity:3,allocated:0,revision:1,surfaces:['code'],expires_at:null};
  const h = await harness(t,{connected:true,resources:[resource]}); await login(h,'admin'); await h.page.getByRole('link',{name:'客户管理',exact:true}).click();
  await h.page.getByRole('button',{name:'创建客户',exact:true}).click(); await h.page.getByLabel('电子邮箱',{exact:true}).fill('new-customer@example.test');
  await h.page.getByLabel('初始密码',{exact:true}).fill('fixture-only-new-password'); await h.page.getByLabel('显示名称',{exact:true}).fill('回归测试客户');
  await h.page.getByRole('button',{name:'创建客户账户',exact:true}).click(); assert.equal(h.fixture.state.users.length,2);
  await h.page.getByRole('dialog').filter({hasText:'确认创建客户'}).getByRole('button',{name:'确认保存',exact:true}).click();
  const row = h.page.getByRole('row').filter({hasText:'new-customer@example.test'}); await row.waitFor(); assert.equal(h.fixture.state.users[2].core_customer_id,undefined);
  await row.getByRole('button',{name:'开通映射',exact:true}).click(); await h.page.getByRole('button',{name:'确认开通',exact:true}).click();
  await row.getByRole('link',{name:'管理授权',exact:true}).click(); await h.page.getByRole('button',{name:'分配资源',exact:true}).click();
  await h.page.getByRole('combobox',{name:'分配资源',exact:true}).selectOption('resource-1'); await h.page.getByRole('dialog').getByRole('button',{name:'分配资源',exact:true}).click();
  await h.page.getByRole('button',{name:'确认授权',exact:true}).click(); await h.page.getByRole('button',{name:'撤销授权',exact:true}).waitFor();
  const grant = h.fixture.state.requests.find(r => r.method === 'POST' && r.path === '/api/admin/grants'); assert.deepEqual(grant.body,{user_id:'user-3',resource_id:'resource-1',expires_at:null});
  assert.equal(h.fixture.state.requests.filter(r => r.path === '/api/admin/users/user-3/provision').length,1);
});

test('settings save only public fields; profile password update returns to authentication',async t => {
  const h = await harness(t); await login(h,'admin'); await h.page.getByRole('link',{name:'站点设置',exact:true}).click();
  await h.page.getByLabel('站点名称',{exact:true}).fill('回归验证站点'); await h.page.getByLabel('站点简介',{exact:true}).fill('只修改公开信息。');
  await h.page.getByLabel('支持邮箱',{exact:true}).fill('support@example.test'); await h.page.getByRole('checkbox',{name:'允许用户自助注册',exact:true}).check();
  await h.page.getByRole('button',{name:'保存公开设置',exact:true}).click(); await h.page.getByRole('button',{name:'确认保存',exact:true}).click(); await h.page.getByText('公开设置已保存',{exact:true}).waitFor();
  const save = h.fixture.state.requests.find(r => r.method === 'PATCH' && r.path === '/api/admin/settings'); assert.deepEqual(Object.keys(save.body).sort(),['accent_color','description','logo_url','name','registration_enabled','support_email']);
  await h.page.getByRole('link',{name:'个人设置',exact:true}).click(); await h.page.getByLabel('当前密码',{exact:true}).fill(fixtureAccounts.admin.password);
  await h.page.getByLabel('新密码',{exact:true}).fill('fixture-only-changed-password'); await h.page.getByLabel('确认新密码',{exact:true}).fill('fixture-only-changed-password');
  await h.page.getByRole('button',{name:'更新密码',exact:true}).click(); await h.page.getByRole('dialog').getByRole('button',{name:'更新密码',exact:true}).click(); await h.page.getByRole('heading',{name:'欢迎回来',exact:true}).waitFor();
  assert.equal(await h.page.getByRole('link',{name:'客户管理',exact:true}).count(),0); assert.equal(h.fixture.state.sessions.size,0);
});

test('loading is visible and expired sessions explicitly request fresh login',async t => {
  const h = await harness(t); await login(h); h.fixture.state.delays.set('/api/me/grants',600);
  await h.page.getByRole('link',{name:'我的权益',exact:true}).click(); await h.page.getByText('正在读取最新数据…',{exact:true}).waitFor(); await h.page.getByText('尚未分配权益',{exact:true}).waitFor();
  h.fixture.state.sessions.clear(); await h.page.getByRole('link',{name:'设备管理',exact:true}).click(); await h.page.getByText('登录已失效',{exact:true}).waitFor();
  await h.page.getByRole('button',{name:'重新登录',exact:true}).click(); await h.page.getByRole('heading',{name:'欢迎回来',exact:true}).waitFor();
  await h.page.getByLabel('电子邮箱',{exact:true}).fill(fixtureAccounts.member.email); await h.page.getByLabel('密码',{exact:true}).fill(fixtureAccounts.member.password); await h.page.getByRole('button',{name:'登录工作台',exact:true}).click(); await h.page.getByRole('heading',{name:'设备管理',exact:true}).waitFor();
});

test('unsafe return targets and non-Stripe HTTPS checkout origins are never navigated',async t => {
  const h = await harness(t,{features:{payment:true},checkoutUrl:'https://untrusted.invalid/checkout'}); await login(h,'member','/login?next=https%3A%2F%2Funtrusted.invalid%2Fsteal');
  assert.equal(new URL(h.page.url()).pathname,'/'); await h.page.getByRole('link',{name:'我的钱包',exact:true}).click(); await h.page.getByLabel('充值金额（人民币元）').fill('20.00');
  await h.page.getByRole('button',{name:'创建 Stripe 支付订单',exact:true}).click(); await h.page.getByRole('button',{name:'创建订单',exact:true}).click(); await h.page.getByText('订单已记录，但支付链接不可安全使用',{exact:true}).waitFor();
  assert.equal(await h.page.getByRole('link',{name:'打开 Stripe 收银台 ↗',exact:true}).count(),0);
});
