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
  await page.getByRole('button',{name:'登录',exact:true}).click();
  await page.locator('.shell').waitFor();
  await page.locator('#page-content:not([aria-busy])').waitFor();
}

// All credentials, resources, keys and orders below are synthetic and confined to the fixture.
test('member identity controls navigation; direct admin routes do not fetch privileged APIs',async t => {
  const h = await harness(t); await login(h);
  await h.page.getByRole('heading',{name:'首页',exact:true}).waitFor();
  await h.page.getByText('工作空间尚未连接上游服务',{exact:true}).waitFor();
  assert.equal(await h.page.getByRole('link',{name:'客户',exact:true}).count(),0);
  assert.equal(await h.page.getByRole('link',{name:'API 接入',exact:true}).count(),0);
  assert.equal(await h.page.getByRole('navigation',{name:'主导航'}).getByRole('link',{name:'开始使用',exact:true}).count(),1);
  assert.equal(await h.page.getByRole('combobox').count(),0,'No identity/role switch');
  assert.equal(await h.page.locator('.overview-page .is-unknown').count(),15,'Unavailable usage stays unknown');
  assert.equal(await h.page.getByText('0',{exact:true}).count(),0,'Unavailable upstream data must not be represented as zero');
  await h.page.getByRole('navigation',{name:'主导航'}).getByRole('link',{name:'开始使用',exact:true}).click();
  await h.page.getByRole('heading',{name:'开始使用',exact:true}).waitFor();
  await h.page.getByRole('heading',{name:'等待分配账号',exact:true}).waitFor();
  await h.page.goto(h.fixture.origin + '/admin/access');
  await h.page.getByRole('heading',{name:'没有管理权限',exact:true}).waitFor();
  assert.equal(h.fixture.state.requests.filter(r => r.path.startsWith('/api/admin/')).length,0);
});

test('member empty and unavailable views have honest states; payment stays disabled',async t => {
  const h = await harness(t); await login(h);
  for (const [path,text] of [['/accounts','还没有账号'],['/devices','还没有连接设备'],['/usage','此区间暂无请求'],['/wallet','支付服务尚未配置']]) {
    await h.page.goto(h.fixture.origin+path); await h.page.getByText(text,{exact:true}).waitFor();
  }
  assert.equal(await h.page.getByRole('button',{name:'在线支付未启用',exact:true}).isDisabled(),true);
  assert.equal(await h.page.getByLabel('充值金额（人民币元）').isDisabled(),true);
  assert.equal(h.fixture.state.requests.filter(r => r.path === '/api/me/payments').length,0);
  await h.page.getByRole('link',{name:'个人设置',exact:true}).click(); await h.page.getByRole('heading',{name:'登录安全',exact:true}).waitFor();
});

test('admin uses the same layout and sees only genuine empty data/configuration',async t => {
  const h = await harness(t); await login(h,'admin');
  for (const title of ['开始使用','客户','库存','审计','设置']) assert.equal(await h.page.getByRole('link',{name:title,exact:true}).count(),1);
  for (const [link,text] of [['库存','暂无账号'],['审计','暂无审计记录'],['设置','公开站点信息']]) {
    await h.page.getByRole('link',{name:link,exact:true}).click(); await h.page.getByText(text,{exact:true}).waitFor();
  }
  if (process.env.CCB_BROWSER_CAPTURE === '1') { await mkdir(captureRoot,{recursive:true}); await h.page.screenshot({path:resolve(captureRoot,'admin-settings.png'),fullPage:true}); }
  assert.equal(await h.page.locator('#public input[type=password]').count(),0,'Public settings do not collect secrets');
  assert.equal(h.fixture.state.requests.some(r => r.method !== 'GET' && r.path.startsWith('/api/admin/')),false);
});


test('payment settings show supported sources without configuration-only warnings', async t => {
  const h = await harness(t); await login(h,'admin');
  await h.page.getByRole('link',{name:'设置',exact:true}).click();
  await h.page.getByRole('tab',{name:'支付配置',exact:true}).click();
  assert.equal(await h.page.getByRole('tab',{name:'邮件配置',exact:true}).count(),1);
  assert.equal(await h.page.getByRole('tab',{name:'邮件与支付',exact:true}).count(),0);
  await h.page.getByRole('tab',{name:'前台方式',exact:true}).click();
  await h.page.getByLabel('支付宝来源',{exact:true}).waitFor();
  await h.page.getByLabel('微信支付来源',{exact:true}).waitFor();
  assert.equal(await h.page.getByRole('button',{name:'保存支付方式',exact:true}).count(),1);
  assert.equal(await h.page.getByRole('checkbox',{name:'前台展示支付宝',exact:true}).isChecked(), false);
  assert.equal(h.fixture.state.requests.some(r => r.method === 'PATCH' && r.path === '/api/admin/settings'), false);
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
  await page.getByRole('button',{name:'创建账户',exact:true}).click(); await page.getByText('请查看邮箱。新注册或尚未验证的账户会收到 15 分钟内有效的 6 位验证码，并使用你刚刚填写的密码。已经可以登录的账户不会被修改，请用原密码登录或找回密码。',{exact:true}).waitFor();
  await page.goto(fixture.origin+'/verify?token=fixture-verification-token');
  await page.getByRole('heading',{name:'验证电子邮箱',exact:true}).waitFor(); assert.equal(new URL(page.url()).search,'');
  assert.equal(fixture.state.requests.filter(r => r.path === '/api/auth/verify').length,0,'Opening a link must not auto-submit');
  await page.getByLabel('电子邮箱',{exact:true}).fill('new@example.test'); await page.getByLabel('验证码',{exact:true}).fill('123456');
  await page.getByRole('button',{name:'确认验证',exact:true}).click(); await page.getByText('邮箱已验证，请返回登录。',{exact:true}).waitFor();
  await page.goto(fixture.origin+'/forgot'); await page.getByLabel('电子邮箱',{exact:true}).fill('anyone@example.test');
  await page.getByRole('button',{name:'发送重置邮件',exact:true}).click(); await page.getByText('如果这个邮箱可以重置密码，你会收到 30 分钟内有效的重置邮件。如果账户还没完成验证，你会收到验证码，而不是重置链接。请同时检查垃圾邮件。',{exact:true}).waitFor();
  await page.goto(fixture.origin+'/reset?token=fixture-reset-token'); await page.getByRole('heading',{name:'设置新密码',exact:true}).waitFor(); assert.equal(new URL(page.url()).search,'');
  await page.getByLabel('新密码',{exact:true}).fill('fixture-reset-password-123'); await page.getByLabel('确认密码',{exact:true}).fill('fixture-reset-password-123');
  await page.getByRole('button',{name:'重置密码',exact:true}).click(); await page.getByText('密码已重置，请使用新密码登录。',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('重置令牌',{exact:true}).inputValue(),'');
});

test('one-time setup requires confirmation and establishes server administrator identity',async t => {
  const {page,fixture} = await harness(t,{setupRequired:true}); await page.goto(fixture.origin+'/');
  await page.getByRole('heading',{name:'初始化',exact:true}).waitFor();
  await page.getByLabel('初始化令牌',{exact:true}).fill('fixture-setup-token'); await page.getByLabel('显示名称',{exact:true}).fill('首位管理员');
  await page.getByLabel('电子邮箱',{exact:true}).fill('owner@example.test'); await page.getByLabel('密码',{exact:true}).fill('fixture-setup-password-123'); await page.getByLabel('确认密码',{exact:true}).fill('fixture-setup-password-123');
  await page.getByRole('button',{name:'创建管理员',exact:true}).click(); await page.getByRole('dialog').waitFor();
  assert.equal(fixture.state.requests.filter(r => r.path === '/api/setup').length,0);
  await page.getByRole('button',{name:'确认初始化',exact:true}).click(); await page.getByRole('heading',{name:'上游接入',exact:true}).waitFor(); await page.getByRole('link',{name:'稍后配置，返回首页',exact:true}).click(); await page.getByRole('heading',{name:'首页',exact:true}).waitFor();
  assert.equal(await page.getByRole('link',{name:'客户',exact:true}).count(),1);
});

test('connect query survives login without auto-approval; writes use cookie and CSRF',async t => {
  const h = await harness(t,{connected:true,accounts:[{id:'account-1',name:'测试账号',state:'available',plan:'Claude',surfaces:['code']}]}); await login(h,'member','/connect?code=TEST-CONNECT');
  await h.page.getByRole('heading',{name:'开始使用',exact:true}).waitFor(); assert.equal(new URL(h.page.url()).pathname,'/connect'); assert.equal(new URL(h.page.url()).search,'');
  assert.equal(await h.page.getByLabel('连接码',{exact:true}).inputValue(),'TEST-CONNECT');
  assert.equal(await h.page.getByText('核对设备信息并确认，然后回到终端继续。',{exact:true}).count(),1);
  assert.equal(await h.page.getByLabel('网关地址',{exact:true}).count(),0);
  assert.equal(await h.page.getByText(`ccb login --gateway ${h.fixture.origin}`,{exact:true}).count(),1);
  assert.equal(await h.page.getByText('npm install -g @rimuruchan/ccb',{exact:true}).count(),1);
  assert.equal(h.fixture.state.requests.filter(r => r.path.includes('/devices')).length,0);
  await h.page.getByRole('button',{name:'核对设备',exact:true}).click(); await h.page.getByText('我的测试笔记本',{exact:true}).waitFor();
  assert.equal(h.fixture.state.requests.filter(r => r.path.includes('/devices/approve')).length,0);
  await h.page.getByRole('button',{name:'确认设备登录',exact:true}).click(); await h.page.getByRole('heading',{name:'设备已登录',exact:true}).waitFor();
  await h.page.getByRole('link',{name:'查看我的设备',exact:true}).click(); await h.page.getByRole('heading',{name:'我的设备',exact:true}).waitFor();
  const writes = h.fixture.state.requests.filter(r => ['/api/me/devices/preview','/api/me/devices/approve'].includes(r.path));
  assert.equal(writes.length,2); for (const req of writes) { assert.equal(req.authenticated,true); assert.match(req.csrf,/^fixture-csrf-/); assert.equal(req.origin,h.fixture.origin); assert.equal(req.body.code,'TEST-CONNECT'); }
  await h.page.getByRole('button',{name:'撤销连接',exact:true}).click(); await h.page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();
  assert.equal(h.fixture.state.devices.length,1,'Cancel must not delete');
});

test('grant revoke carries exact revision, rejects 409, then requires fresh explicit confirmation',async t => {
  const resource = {id:'resource-1',name:'测试 Code 资源',status:'active',capacity:5,allocated:1,revision:2,surfaces:['code'],expires_at:null};
  const grant = {id:'grant-1',resource_id:resource.id,name:resource.name,status:'active',revision:7,surfaces:['code'],expires_at:null};
  const h = await harness(t,{connected:true,resources:[resource],grants:[grant]}); await login(h,'admin'); h.fixture.state.grantConflict = true;
  await h.page.goto(h.fixture.origin+'/admin/inventory?user_id=member-1'); await h.page.getByRole('button',{name:'收回账号',exact:true}).waitFor();
  await h.page.getByRole('button',{name:'收回账号',exact:true}).click(); await h.page.getByRole('dialog').getByRole('button',{name:'确认收回',exact:true}).click();
  await h.page.getByText('状态冲突，未覆盖新版本',{exact:true}).waitFor();
  let writes = h.fixture.state.requests.filter(r => r.method === 'PATCH' && r.path === '/api/admin/grants/grant-1'); assert.equal(writes.length,1); assert.equal(writes[0].body.expected_revision,7); assert.equal(h.fixture.state.grants[0].status,'active');
  await h.page.getByRole('button',{name:'刷新最新状态',exact:true}).click(); await h.page.getByRole('button',{name:'收回账号',exact:true}).click(); await h.page.getByRole('dialog').getByRole('button',{name:'确认收回',exact:true}).click();
  await h.page.getByRole('button',{name:'分配客户',exact:true}).waitFor(); writes = h.fixture.state.requests.filter(r => r.method === 'PATCH' && r.path === '/api/admin/grants/grant-1'); assert.equal(writes.length,2); assert.equal(writes[1].body.expected_revision,8);
});

test('last-admin error is actionable and never locally changes the current role',async t => {
  const h = await harness(t); await login(h,'admin'); await h.page.getByRole('link',{name:'客户',exact:true}).click();
  await h.page.getByRole('row').filter({hasText:'admin@example.test'}).getByRole('button',{name:'编辑',exact:true}).click();
  await h.page.getByLabel('账户角色',{exact:true}).selectOption('member'); await h.page.getByRole('button',{name:'保存客户信息',exact:true}).click(); await h.page.getByRole('dialog').filter({hasText:'确认权限变更'}).getByRole('button',{name:'确认变更',exact:true}).click();
  await h.page.getByText('需要保留可用的管理员',{exact:true}).waitFor(); assert.equal(h.fixture.state.users[0].role,'admin'); assert.equal(await h.page.getByRole('link',{name:'设置',exact:true}).count(),1);
});


test('ambiguous write is not retried or reported successful',async t => {
  const h = await harness(t,{features:{payment:true}}); await login(h); await h.page.goto(h.fixture.origin+'/wallet');
  h.fixture.state.disconnected.add('/api/me/payments'); await h.page.getByLabel('充值金额（人民币元）').fill('12.34');
  await h.page.getByRole('button',{name:'创建支付订单',exact:true}).click(); await h.page.getByRole('button',{name:'创建订单',exact:true}).click();
  await h.page.getByText('操作结果尚未确认',{exact:true}).waitFor(); assert.equal(await h.page.getByRole('button',{name:'创建支付订单',exact:true}).isDisabled(),true);
  assert.equal(h.fixture.state.requests.filter(r => r.path === '/api/me/payments').length,1); assert.equal(h.fixture.state.orders.length,0);
});

test('unsafe checkout URL is inert and amount is sent as integer minor units',async t => {
  const h = await harness(t,{features:{payment:true},checkoutUrl:'javascript:globalThis.checkoutLeak=true'}); await login(h); await h.page.goto(h.fixture.origin+'/wallet');
  await h.page.getByLabel('充值金额（人民币元）').fill('12.34'); await h.page.getByRole('button',{name:'创建支付订单',exact:true}).click(); await h.page.getByRole('button',{name:'创建订单',exact:true}).click();
  await h.page.getByText('订单已记录，但支付链接不可安全使用',{exact:true}).waitFor(); assert.equal(await h.page.locator('a[href^="javascript:"]').count(),0);
  assert.equal(h.fixture.state.requests.find(r => r.path === '/api/me/payments').body.amount_minor,1234); assert.equal(await h.page.evaluate(() => globalThis.checkoutLeak),undefined);
  await h.page.goto(h.fixture.origin+'/wallet?order=order-1&success=true'); await h.page.getByRole('heading',{name:'返回后的订单核对',exact:true}).waitFor(); assert.equal(await h.page.getByText('已支付',{exact:true}).count(),0); assert.equal(h.fixture.state.orders[0].status,'pending');
});

test('valid checkout is an explicit external link, never an automatic redirect or charge',async t => {
  const h = await harness(t,{features:{payment:true}}); await login(h); await h.page.goto(h.fixture.origin+'/wallet');
  await h.page.getByLabel('充值金额（人民币元）').fill('20.00'); await h.page.getByRole('button',{name:'创建支付订单',exact:true}).click(); await h.page.getByRole('button',{name:'创建订单',exact:true}).click();
  const link = h.page.getByRole('link',{name:'前往支付收银台 ↗',exact:true}); await link.waitFor(); assert.equal(await link.getAttribute('target'),'_blank'); assert.equal(await link.getAttribute('rel'),'noopener noreferrer'); assert.equal(new URL(h.page.url()).origin,h.fixture.origin);
});

test('API failures are not converted into empty success and malicious display text is inert',async t => {
  const h = await harness(t,{displayName:'<img src=x onerror="globalThis.injected=true">'}); await login(h);
  assert.equal(await h.page.locator('.user-info img').count(),0); assert.equal(await h.page.evaluate(() => globalThis.injected),undefined);
  h.fixture.state.failures.set('/api/me/usage',{status:503,code:'core_unavailable',message:'核心服务不可用。'});
  await h.page.getByRole('link',{name:'使用记录',exact:true}).click(); await h.page.getByRole('heading',{name:'数据暂不可用',exact:true}).waitFor(); assert.equal(await h.page.getByText('此区间暂无请求',{exact:true}).count(),0);
  await h.page.getByRole('button',{name:'重试读取',exact:true}).click(); await h.page.getByText('此区间暂无请求',{exact:true}).waitFor();
});

test('responsive light/dark layout has no page overflow and preference persists',async t => {
  const h = await harness(t); await login(h); await h.page.getByRole('heading',{name:'用量',exact:true}).waitFor();
  if (process.env.CCB_BROWSER_CAPTURE === '1') { await mkdir(captureRoot,{recursive:true}); await h.page.screenshot({path:resolve(captureRoot,'overview-light.png'),fullPage:true}); }
  await h.page.getByRole('button',{name:'切换深色主题',exact:true}).click(); assert.equal(await h.page.locator('html').getAttribute('data-theme'),'dark');
  if (process.env.CCB_BROWSER_CAPTURE === '1') await h.page.screenshot({path:resolve(captureRoot,'overview-dark.png'),fullPage:true});
  await h.page.reload(); await h.page.getByRole('heading',{name:'用量',exact:true}).waitFor(); assert.equal(await h.page.locator('html').getAttribute('data-theme'),'dark');
  await h.page.setViewportSize({width:390,height:844}); assert.equal(await h.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),true);
  if (process.env.CCB_BROWSER_CAPTURE === '1') await h.page.screenshot({path:resolve(captureRoot,'overview-mobile.png'),fullPage:true});
  const tabBar = await h.page.getByRole('navigation',{name:'主导航'}).boundingBox(); assert.ok(tabBar && tabBar.y + tabBar.height <= 844 && tabBar.y > 844 / 2,'Phone navigation stays at the bottom of the screen');
  await h.page.getByRole('navigation',{name:'主导航'}).getByRole('link',{name:'我的账号',exact:true}).click(); await h.page.getByText('还没有账号',{exact:true}).waitFor();
  assert.equal(await h.page.getByRole('navigation',{name:'主导航'}).getByRole('link',{name:'我的账号',exact:true}).getAttribute('aria-current'),'page');
});

test('partial overview failures preserve unknown counters even when core itself is available',async t => {
  const h = await harness(t,{connected:true,pending:['grants_unavailable','devices_unavailable','usage_unavailable']}); await login(h);
  await h.page.getByText('权益数据暂不可用 · 设备数据暂不可用 · 用量统计暂不可用',{exact:true}).waitFor();
  assert.equal(await h.page.locator('.overview-page .is-unknown').count(),15);
  assert.equal(await h.page.getByText('0',{exact:true}).count(),0);
  await h.page.getByText('用量汇总尚未返回。缺失项保持未知，不会显示为 0。',{exact:true}).waitFor(); assert.equal(await h.page.getByText('还没有可用权益',{exact:true}).count(),0); assert.equal(await h.page.getByText('累计还没有模型请求。',{exact:true}).count(),0);
});

test('customer management creates local accounts without exposing a provisioning or resource editor',async t=>{
 const h=await harness(t,{connected:true});await login(h,'admin');await h.page.getByRole('link',{name:'客户',exact:true}).click();
 await h.page.getByRole('button',{name:'创建客户',exact:true}).click();
 const dialog=h.page.getByRole('dialog',{name:'创建客户账户'});await dialog.getByLabel('电子邮箱',{exact:true}).fill('new@example.test');await dialog.getByLabel('初始密码',{exact:true}).fill('fixture-password-123');await dialog.getByLabel('显示名称',{exact:true}).fill('新客户');await dialog.getByRole('button',{name:'创建客户账户',exact:true}).click();
 await dialog.waitFor({state:'hidden'});const row=h.page.getByRole('row').filter({hasText:'new@example.test'});await row.waitFor();assert.equal(await row.getByRole('button',{name:'开通映射',exact:true}).count(),0);await row.getByRole('link',{name:'查看与分配账号',exact:true}).click();await h.page.getByRole('heading',{name:'账号库存',exact:true}).first().waitFor();assert.ok(!h.fixture.state.requests.some(r=>r.path.endsWith('/provision')));
});

test('settings save only public fields; profile password update returns to authentication',async t => {
  const h = await harness(t); await login(h,'admin'); await h.page.getByRole('link',{name:'设置',exact:true}).click();
  await h.page.getByLabel('站点名称',{exact:true}).fill('回归验证站点'); await h.page.getByLabel('站点简介',{exact:true}).fill('只修改公开信息。');
  await h.page.getByLabel('支持邮箱',{exact:true}).fill('support@example.test'); await h.page.getByRole('checkbox',{name:'允许用户自助注册',exact:true}).check();
  await h.page.getByRole('button',{name:'保存公开设置',exact:true}).click(); await h.page.getByRole('button',{name:'确认保存',exact:true}).click(); await h.page.getByText('公开设置已保存',{exact:true}).waitFor();
  const save = h.fixture.state.requests.find(r => r.method === 'PATCH' && r.path === '/api/admin/settings'); assert.deepEqual(Object.keys(save.body).sort(),['accent_color','description','logo_url','name','registration_enabled','support_email']);
  await h.page.getByRole('link',{name:'个人设置',exact:true}).click(); await h.page.getByLabel('当前密码',{exact:true}).fill(fixtureAccounts.admin.password);
  await h.page.getByLabel('新密码',{exact:true}).fill('fixture-only-changed-password'); await h.page.getByLabel('确认新密码',{exact:true}).fill('fixture-only-changed-password');
  await h.page.getByRole('button',{name:'更新密码',exact:true}).click(); await h.page.getByRole('dialog').getByRole('button',{name:'更新密码',exact:true}).click(); await h.page.getByRole('heading',{name:'欢迎回来',exact:true}).waitFor();
  assert.equal(await h.page.getByRole('link',{name:'客户',exact:true}).count(),0); assert.equal(h.fixture.state.sessions.size,0);
});

test('loading is visible and expired sessions explicitly request fresh login',async t => {
  const h = await harness(t); await login(h);
  let release;
  const responseGate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  // Hold the actual accounts request until the loading state has been observed.
  // A delay on the retired grants endpoint only sampled a scheduling race.
  await h.page.route(h.fixture.origin + '/api/me/accounts',async route => { await responseGate; await route.continue(); });
  await h.page.getByRole('link',{name:'我的账号',exact:true}).click();
  try { await h.page.getByText('正在读取最新数据…',{exact:true}).waitFor(); }
  finally { release(); }
  await h.page.getByText('还没有账号',{exact:true}).waitFor();
  await h.page.unroute(h.fixture.origin + '/api/me/accounts');
  h.fixture.state.sessions.clear(); await h.page.getByRole('link',{name:'我的账号',exact:true}).click(); await h.page.getByText('登录已失效',{exact:true}).waitFor();
  await h.page.getByRole('button',{name:'重新登录',exact:true}).click(); await h.page.getByRole('heading',{name:'欢迎回来',exact:true}).waitFor();
  await h.page.getByLabel('电子邮箱',{exact:true}).fill(fixtureAccounts.member.email); await h.page.getByLabel('密码',{exact:true}).fill(fixtureAccounts.member.password); await h.page.getByRole('button',{name:'登录',exact:true}).click(); await h.page.getByRole('heading',{name:'我的账号',exact:true}).first().waitFor();
});

test('unsafe return targets and non-Stripe HTTPS checkout origins are never navigated',async t => {
  const h = await harness(t,{features:{payment:true},checkoutUrl:'https://untrusted.invalid/checkout'}); await login(h,'member','/login?next=https%3A%2F%2Funtrusted.invalid%2Fsteal');
  assert.equal(new URL(h.page.url()).pathname,'/'); await h.page.goto(h.fixture.origin+'/wallet'); await h.page.getByLabel('充值金额（人民币元）').fill('20.00');
  await h.page.getByRole('button',{name:'创建支付订单',exact:true}).click(); await h.page.getByRole('button',{name:'创建订单',exact:true}).click(); await h.page.getByText('订单已记录，但支付链接不可安全使用',{exact:true}).waitFor();
  assert.equal(await h.page.getByRole('link',{name:'前往支付收银台 ↗',exact:true}).count(),0);
});

test('connection instructions align headings, command panels and notes without mobile gaps',async t=>{
 const accountId='account-'+ '1'.repeat(64),h=await harness(t,{connected:true,accounts:[{id:accountId,name:'布局测试账号',state:'available',plan:'Claude',surfaces:['code']}]});
 await login(h,'member','/connect');await mkdir(captureRoot,{recursive:true});
 for(const selected of [false,true]){
  h.fixture.state.public.site.public_origin=selected?'https://gateway-for-long-command-layout.example.test':h.fixture.origin;
  await h.page.goto(h.fixture.origin+'/connect'+(selected?'?account_id='+accountId:''));
  const steps=h.page.locator('.connection-steps');await steps.getByRole('heading',{name:'安装 ccb',exact:true}).waitFor();
  assert.equal(await steps.getByRole('button',{name:/^复制(安装|登录|启动)命令$/}).count(),3);
  assert.equal(await steps.locator('.command-line pre').nth(0).innerText(),'npm install -g @rimuruchan/ccb');
  assert.equal(await steps.locator('.command-line pre').nth(1).innerText(),'ccb login --gateway '+h.fixture.state.public.site.public_origin+(selected?' --account '+accountId+' --surface code':''));
  assert.equal(await steps.locator('.command-line pre').nth(2).innerText(),'ccb');
  for(const [width,theme] of [[1920,'light'],[1440,'light'],[1101,'dark'],[1100,'light'],[768,'dark'],[390,'light'],[320,'dark']]){
   await h.page.setViewportSize({width,height:1050});await h.page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await h.page.evaluate(()=>document.fonts.ready);
   const rows=await steps.locator(':scope > li').evaluateAll(items=>items.map(item=>{
    const rect=element=>{const r=element.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,width:r.width,height:r.height};};
    return {card:rect(item),title:rect(item.querySelector('h2')),description:rect(item.querySelector('p')),command:rect(item.querySelector('.command-block')),code:rect(item.querySelector('.command-line pre')),note:item.querySelector('.instruction-note')?rect(item.querySelector('.instruction-note')):null};
   }));
   assert.equal(rows.length,3);
   if(width>1100){
    for(const part of ['card','title','description','command','code'])assert.ok(Math.max(...rows.map(row=>row[part].top))-Math.min(...rows.map(row=>row[part].top))<1,`${part} must share its top edge at ${width}px (selected=${selected})`);
    assert.ok(Math.max(...rows.map(row=>row.command.bottom))-Math.min(...rows.map(row=>row.command.bottom))<1,'command panels share their bottom edge');
    assert.ok(rows.every(row=>row.note),'every step has its explanation after the command');
    assert.ok(Math.max(...rows.map(row=>row.note.top))-Math.min(...rows.map(row=>row.note.top))<1,'notes share their top edge');
   }else{
    for(let i=0;i<rows.length;i++){
     const row=rows[i];assert.ok(row.command.top-row.description.bottom>=0&&row.command.top-row.description.bottom<=20,'stacked cards must not reserve desktop description space');
     if(i)assert.ok(row.card.top>=rows[i-1].card.bottom,'mobile steps remain in order without overlap');
    }
   }
   assert.equal(await h.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'long gateway and account commands must not overflow');
   await steps.screenshot({path:resolve(captureRoot,`connect-steps-${selected?'selected':'default'}-${width}-${theme}.png`)});
  }
 }
 await h.page.setViewportSize({width:1440,height:1050});await h.page.goto(h.fixture.origin+'/connect?code=LAYOUT-TEST');await h.page.getByLabel('连接码',{exact:true}).waitFor();
 const order=await h.page.locator('.connect-layout').evaluate(layout=>{const approval=layout.querySelector('.approval-card').getBoundingClientRect(),steps=layout.querySelector('.connection-steps').getBoundingClientRect();return approval.bottom<=steps.top;});assert.equal(order,true,'device confirmation still takes priority over the guide');
 assert.equal(h.fixture.state.requests.filter(request=>request.path.endsWith('/devices/approve')).length,0,'layout changes never auto-approve a device');
});
