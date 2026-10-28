import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir} from 'node:fs/promises';
import {fixture,password} from '../server/fixtures.js';
import {seedAdminWorkflow} from '../server/admin-workflow-fixture.js';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const project=resolve(dirname(fileURLToPath(import.meta.url)),'../..');

async function workflowHarness(t) {
 const control={failInventory:false};
 const f=await fixture(t,{publicDir:resolve(project,'public'),onCore:({url,json})=>{
  if(control.failInventory&&url.pathname==='/access/v1/accounts'){json({error:{code:'unavailable'}},503);return true;}
  if(url.pathname.endsWith('/usage')&&url.searchParams.get('result')==='error') {json({usage:{requests:1,errors:1},requests:[{id:7,time:new Date().toISOString(),model:'fixture-model',status:503}],total:1});return true;}
 }});
 const admin=await f.request('POST','/api/setup',{setup_token:f.setupToken,email:'admin@example.test',password,display_name:'体验管理员'});
 const users=await seedAdminWorkflow(f,admin);
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{})});
 const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce',timezoneId:'Asia/Shanghai'}),page=await context.newPage(),errors=[],outbound=[];
 t.after(async()=>{await browser.close();assert.deepEqual(errors,[]);assert.deepEqual(outbound,[]);});
 await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==f.config.publicOrigin){outbound.push(route.request().url());return route.abort();}return route.continue();});
 page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(10000);
 await page.goto(f.config.publicOrigin+'/login');await page.getByLabel('电子邮箱',{exact:true}).fill('admin@example.test');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('heading',{name:'首页',exact:true}).waitFor();
 return {f,admin,users,page,control};
}

test('operator task links open the exact actionable states, including refund-only work',async t=>{
 const {f,page}=await workflowHarness(t);
 // Leave only a refund review to reproduce the original empty-destination defect.
 f.store.db.prepare("UPDATE rentals SET status='fulfilled' WHERE status='review'").run();
 await page.getByRole('link',{name:'运营待办',exact:true}).click();
 await page.getByRole('link',{name:/待核对交付 1/}).waitFor();
 await page.getByRole('link',{name:'处理交付待办 →',exact:true}).click();
 await page.getByText('r-refund',{exact:true}).waitFor();
 assert.equal(await page.getByLabel('交付状态',{exact:true}).inputValue(),'needs_review');
 assert.equal(await page.getByText('r-done',{exact:true}).count(),0);
 await page.getByRole('link',{name:'返回运营待办',exact:true}).click();
 await page.getByRole('link',{name:/待确认支付 4/}).click();
 await page.getByText('pay-unknown',{exact:true}).waitFor();assert.equal(await page.getByText('pay-paid',{exact:true}).count(),0);
 assert.equal(await page.getByRole('button',{name:'核对支付',exact:true}).count(),4);
});

test('customer workspace preserves identity and list position across devices, orders and partial failures',async t=>{
 const {f,page,users,control}=await workflowHarness(t);
 await page.goto(f.config.publicOrigin+'/admin/customers?q='+encodeURIComponent('星河'));
 await page.getByRole('link',{name:'客户详情',exact:true}).click();
 await page.getByRole('heading',{name:'账号与期限',exact:true}).waitFor();
 await page.locator('.customer-context').getByText('星河设计',{exact:true}).waitFor();
 assert.equal(await page.getByText('Account 2',{exact:true}).count(),0);
 await page.getByRole('heading',{name:'最近失败请求',exact:true}).waitFor();await page.getByText('fixture-model',{exact:true}).waitFor();
 if(process.env.CCB_BROWSER_CAPTURE==='1'){const dir=resolve(project,'.local-preview/admin-workflow');await mkdir(dir,{recursive:true});await page.screenshot({path:resolve(dir,'customer-detail-desktop.png'),fullPage:true});await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:resolve(dir,'customer-detail-mobile.png'),fullPage:true});await page.setViewportSize({width:1440,height:1000});}
 await page.getByRole('link',{name:'设备管理',exact:true}).click();
 await page.getByRole('link',{name:'返回客户详情',exact:true}).waitFor();assert.equal(new URL(page.url()).searchParams.get('user_id'),users.alice.id);
 await page.getByRole('link',{name:'返回客户详情',exact:true}).click();
 await page.getByRole('link',{name:'交付订单',exact:true}).click();await page.getByText('r-refund',{exact:true}).waitFor();assert.equal(await page.getByText('r-bob',{exact:true}).count(),0);
 await page.getByLabel('交付状态',{exact:true}).selectOption('needs_review');await page.getByRole('button',{name:'筛选',exact:true}).click();await page.getByText('r-refund',{exact:true}).waitFor();assert.equal(new URL(page.url()).searchParams.get('user_id'),users.alice.id);
 await page.getByRole('link',{name:'返回客户详情',exact:true}).click();
 control.failInventory=true;await page.getByRole('button',{name:'刷新',exact:true}).click();
 await page.getByText('此项数据暂不可用',{exact:true}).waitFor();await page.getByText('pay-paid',{exact:true}).waitFor();
 assert.equal(await page.getByRole('heading',{name:'尚未分配账号',exact:true}).count(),0);
 await page.getByRole('link',{name:'账号与分配',exact:true}).click();await page.getByText('数据暂不可用',{exact:true}).waitFor();await page.locator('.customer-context').getByText('星河设计',{exact:true}).waitFor();await page.getByRole('link',{name:'返回客户详情',exact:true}).click();
 await page.getByRole('link',{name:'返回客户列表',exact:true}).click();assert.equal(new URL(page.url()).searchParams.get('q'),'星河');
});

test('inventory due filters and safe renewal keep the customer context and exact grant revision',async t=>{
 const {f,page,users}=await workflowHarness(t);
 await page.goto(f.config.publicOrigin+'/admin/inventory');await page.getByRole('button',{name:'客户 7 天内到期',exact:true}).click();
 await page.getByText('Account 1',{exact:true}).waitFor();assert.equal(await page.getByText('Account 2',{exact:true}).count(),0);assert.equal(await page.getByText('Account 4',{exact:true}).count(),0);
 await page.getByLabel('到期口径',{exact:true}).selectOption('authorization');await page.getByRole('button',{name:'筛选库存',exact:true}).click();await page.getByText('Account 4',{exact:true}).waitFor();assert.equal(await page.getByText('Account 1',{exact:true}).count(),0);
 await page.goto(f.config.publicOrigin+'/admin/inventory?user_id='+users.alice.id);
 const row=page.getByRole('row').filter({hasText:'Account 1'}),prior=f.state.inventory[0].customer_expires_at,revision=f.state.inventory[0].grant_revision;
 await row.getByRole('button',{name:'延长客户有效期',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'延长客户有效期',exact:true});await dialog.getByRole('button',{name:'延长 7 天',exact:true}).click();
 const value=await dialog.getByLabel('新的客户到期时间',{exact:true}).inputValue();
 // The field shows local minutes; the chosen preset retains the exact original instant.
 const expected=Date.parse(prior)+7*86400000;assert.equal(Date.parse(value+'+08:00'),Math.floor(expected/60000)*60000);
 await dialog.getByRole('button',{name:'确认延长',exact:true}).click();await page.getByRole('dialog',{name:'确认客户续期',exact:true}).getByRole('button',{name:'确认续期',exact:true}).click();await dialog.waitFor({state:'hidden'});
 assert.equal(Date.parse(f.state.inventory[0].customer_expires_at),expected);assert.equal(f.state.inventory[0].grant_revision,revision+1);
 const mutations=f.state.requests.filter(r=>r.method==='PATCH'&&r.path.includes('/grants/'));assert.equal(mutations.length,1);assert.equal(mutations[0].body.expected_revision,revision);
 await page.locator('.customer-context').getByText('星河设计',{exact:true}).waitFor();
 await row.getByRole('button',{name:'延长客户有效期',exact:true}).click();await page.getByRole('dialog',{name:'延长客户有效期'}).getByLabel('新的客户到期时间',{exact:true}).fill('2099-01-01T00:00');await page.getByRole('dialog',{name:'延长客户有效期'}).getByRole('button',{name:'确认延长',exact:true}).click();assert.equal(f.state.requests.filter(r=>r.method==='PATCH'&&r.path.includes('/grants/')).length,1);
 await page.keyboard.press('Escape');await page.getByRole('heading',{name:'账号库存',exact:true}).first().click();await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 if(process.env.CCB_BROWSER_CAPTURE==='1'){const dir=resolve(project,'.local-preview/admin-workflow');await mkdir(dir,{recursive:true});await page.screenshot({path:resolve(dir,'inventory-mobile.png'),fullPage:true});}
});

test('audit shows business names, customer-scoped pagination and query validation',async t=>{
 const {f,page,users,admin}=await workflowHarness(t);
 for(let i=0;i<55;i++)f.store.audit(admin.data.user.id,'user.update',users.alice.id);
 await page.goto(f.config.publicOrigin+'/admin/audit?user_id='+users.alice.id+'&action=user.update');
 await page.getByText('共 55 条 · 第 1 页',{exact:true}).waitFor();
 assert.equal(await page.getByRole('cell',{name:'修改客户资料或权限',exact:true}).count(),50);
 await page.getByRole('button',{name:'下一页',exact:true}).click();await page.getByText('共 55 条 · 第 2 页',{exact:true}).waitFor();assert.equal(await page.getByRole('cell',{name:'修改客户资料或权限',exact:true}).count(),5);
 assert.equal(new URL(page.url()).searchParams.get('user_id'),users.alice.id);
 await page.getByLabel('操作类型',{exact:true}).selectOption('grant.create');await page.getByRole('button',{name:'查询审计',exact:true}).click();await page.getByText('Account 1',{exact:true}).waitFor();assert.equal(new URL(page.url()).searchParams.has('offset'),false);
 await page.getByText('查看标识',{exact:true}).click();await page.getByText('操作：grant.create',{exact:true}).waitFor();
 await page.getByLabel('开始时间',{exact:true}).fill('2030-01-01T00:00');await page.getByLabel('结束时间',{exact:true}).fill('2020-01-01T00:00');await page.getByRole('button',{name:'查询审计',exact:true}).click();await page.getByText('时间范围不正确',{exact:true}).waitFor();
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 if(process.env.CCB_BROWSER_CAPTURE==='1'){const dir=resolve(project,'.local-preview/admin-workflow');await mkdir(dir,{recursive:true});await page.screenshot({path:resolve(dir,'audit-mobile.png'),fullPage:true});}
});
