import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir} from 'node:fs/promises';
import {fixture,password} from '../server/fixtures.js';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const project=resolve(dirname(fileURLToPath(import.meta.url)),'../..');

async function inventoryHarness(t, options) {
 const f=await fixture(t,{publicDir:resolve(project,'public'),...options});
 const admin=await f.request('POST','/api/setup',{setup_token:f.setupToken,email:'admin@example.test',password,display_name:'Owner'});
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{})});
 const context=await browser.newContext({viewport:{width:1440,height:1050},reducedMotion:'reduce'}),page=await context.newPage(),errors=[],unexpected=[];
 t.after(async()=>{await browser.close();assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);});
 page.setDefaultTimeout(12000);page.on('pageerror',error=>errors.push(error.message));
 await context.route('**/*',route=>{const origin=new URL(route.request().url()).origin;if(origin===f.config.publicOrigin)return route.continue();unexpected.push(origin);return route.abort();});
 await page.goto(f.config.publicOrigin+'/login');
 await page.getByLabel('电子邮箱',{exact:true}).fill('admin@example.test');await page.getByLabel('密码',{exact:true}).fill(password);
 await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('link',{name:'库存',exact:true}).click();
 await page.getByRole('tab',{name:/当前库存/}).waitFor();
 return {f,admin,page,context};
}

test('shipped merchant inventory has operator-allocated accounts and no upstream credit or purchase action',async t=>{
 const f=await fixture(t,{publicDir:resolve(project,'public'),onCore:({req,url,state,json})=>{
  if(req.method==='GET'&&url.pathname.endsWith('/devices')){const card=state.accounts.find(a=>a.state==='available');json({devices:state.deviceReleased?[]:[{id:'bound-device',name:'本机 Laptop',state:'approved',current_grant_id:card?.id,platform:'MacOS/arm64'},{id:'other-device',name:'另一账号的设备',state:'approved',current_grant_id:'another-grant'}]});return true;}
  if(req.method==='DELETE'&&url.pathname.endsWith('/devices/bound-device')){state.deviceReleased=true;json({ok:true});return true;}
 }});
 const admin=await f.request('POST','/api/setup',{setup_token:f.setupToken,email:'admin@example.test',password,display_name:'商户管理员'});
 const member=await f.request('POST','/api/admin/users',{email:'member@example.test',password,display_name:'无需预先同步的客户',role:'member'},admin);
 assert.equal(f.state.customers.length,0);

 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{})});t.after(()=>browser.close());
 const context=await browser.newContext({viewport:{width:1440,height:1050},reducedMotion:'reduce'}),page=await context.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(12000);
 await context.route('**/*',route=>new URL(route.request().url()).origin===f.config.publicOrigin?route.continue():route.abort());
 await page.goto(f.config.publicOrigin+'/login');
 await page.getByLabel('电子邮箱',{exact:true}).fill('admin@example.test');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();
 await page.getByRole('link',{name:'库存',exact:true}).click();
 await page.getByText('账号#1',{exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:/采购账号|续购|充值|入账/}).count(),0);
 await page.getByRole('button',{name:'账号详情',exact:true}).first().click();
 await page.getByRole('dialog').getByRole('heading',{name:'账号#1',exact:true}).waitFor();
 assert.equal(await page.getByRole('dialog').getByRole('link',{name:'续期此账号',exact:true}).count(),0);
 await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'分配客户',exact:true}).first().click();
 await page.getByLabel('客户',{exact:true}).selectOption(member.data.user.id);
 await page.getByRole('button',{name:'确认分配',exact:true}).click();
 await page.getByRole('dialog').waitFor({state:'hidden'});
 await page.getByRole('cell',{name:'已分配',exact:true}).waitFor();
 await page.getByText('无需预先同步的客户',{exact:true}).waitFor();
 assert.equal(f.state.customers.length,1);
 assert.equal(await page.getByRole('button',{name:'开通映射',exact:true}).count(),0);
 assert.equal(await page.getByRole('link',{name:'客户分配',exact:true}).count(),0);
 assert.equal(f.state.grants.length,1);assert.equal(f.state.inventory[0].assigned,true);
 assert.equal(f.state.requests.some(r=>r.path.endsWith('/balance')||r.path.includes('/purchases')),false);
 const artifacts=resolve(project,'.local-preview');await mkdir(artifacts,{recursive:true});
 await page.screenshot({path:resolve(artifacts,'account-inventory-desktop.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:resolve(artifacts,'account-inventory-mobile.png'),fullPage:true});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'No mobile page overflow');
 await page.setViewportSize({width:1440,height:1050});
 const row=page.locator('#inventory-current [data-account-lease="owned-1"]');await row.getByRole('button',{name:'收回账号',exact:true}).click();await page.getByRole('dialog',{name:'收回账号'}).getByRole('button',{name:'确认收回',exact:true}).click();
 await row.getByRole('button',{name:'分配客户',exact:true}).waitFor();assert.equal(f.state.inventory[0].assigned,false);
 await row.getByRole('button',{name:'分配客户',exact:true}).click();await page.getByLabel('客户',{exact:true}).selectOption(member.data.user.id);await page.getByRole('button',{name:'确认分配',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
 f.state.accounts.filter(a=>a.state==='available').forEach(a=>a.device_name='本机 Laptop');
 await page.getByRole('button',{name:'退出登录',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'退出登录',exact:true}).click();
 await page.getByLabel('电子邮箱',{exact:true}).fill('member@example.test');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();
 await page.getByRole('link',{name:'我的账号',exact:true}).click();await page.locator('.account-card').getByRole('link',{name:'开始使用',exact:true}).waitFor();assert.equal(await page.getByRole('navigation',{name:'主导航'}).getByRole('link',{name:'开始使用',exact:true}).count(),1);assert.equal(await page.getByRole('link',{name:'充值/订阅',exact:true}).count(),0);await page.getByRole('link',{name:'更换设备',exact:true}).click();await page.getByRole('heading',{name:'更换设备',exact:true}).waitFor();await page.getByText('本机 Laptop',{exact:true}).waitFor();assert.equal(await page.getByText('另一账号的设备',{exact:true}).count(),0);
 await page.getByRole('button',{name:'撤销连接',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'撤销连接',exact:true}).click();await page.getByText('还没有连接设备',{exact:true}).waitFor();assert.equal(f.state.deviceReleased,true);
 await page.locator('#page-content').getByRole('link',{name:'开始使用',exact:true}).click();await page.getByRole('heading',{name:'开始使用',exact:true}).waitFor();
 assert.deepEqual(errors,[]);
});


test('a lost manual-delivery response freezes the intent and reconciliation never sends another assignment',async t=>{
 let dropped=false;
 const f=await fixture(t,{publicDir:resolve(project,'public'),afterGrant:({res})=>{if(!dropped){dropped=true;res.destroy();return true;}}});
 const admin=await f.request('POST','/api/setup',{setup_token:f.setupToken,email:'admin@example.test',password,display_name:'Owner'});
 const member=await f.request('POST','/api/admin/users',{email:'member@example.test',password,display_name:'Pending customer',role:'member'},admin);
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{})});t.after(()=>browser.close());
 const page=await browser.newPage();page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',route=>new URL(route.request().url()).origin===f.config.publicOrigin?route.continue():route.abort());
 await page.goto(f.config.publicOrigin+'/login');await page.getByLabel('电子邮箱',{exact:true}).fill('admin@example.test');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('link',{name:'库存',exact:true}).click();
 await page.getByRole('button',{name:'分配客户',exact:true}).first().click();await page.getByLabel('客户',{exact:true}).selectOption(member.data.user.id);await page.getByRole('button',{name:'确认分配',exact:true}).click();await page.getByRole('button',{name:'核对分配结果',exact:true}).waitFor();assert.equal(await page.getByLabel('客户',{exact:true}).isDisabled(),true);
 await page.getByRole('button',{name:'核对分配结果',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});await page.getByText('Pending customer',{exact:true}).waitFor();assert.equal(f.state.requests.filter(r=>r.method==='POST'&&r.path==='/access/v1/grants').length,1);assert.equal(f.state.grants.length,1);assert.deepEqual(errors,[]);
});

test('released history is read-only while same-name current leases retain exact assignment identities',async t=>{
 const expires_at=new Date(Date.now()+30*86400000).toISOString();
 const inventory=[
  {id:'previous-lease',status:'released',assigned:true,revision:8,grant_id:'previous-grant',grant_revision:3},
  {id:'replacement-lease',status:'active',assigned:false,allow_delegation:true,revision:4},
  {id:'same-name-independent-lease',status:'active',assigned:false,allow_delegation:true,revision:9},
 ].map(account=>({resource_id:'resource-1',platform:'Windows/x64',expires_at,created_at:new Date(Date.now()-86400000).toISOString(),details:{name:'shared@example.test',plan:'Claude Pro',state:'available',device_name:'Live device, not a historical snapshot',quota:{status:'ok',windows:[{key:'5h',label:'Live quota',used_percent:50}]}},...account}));
 const {f,admin,page,context}=await inventoryHarness(t,{inventory});
 const member=await f.request('POST','/api/admin/users',{email:'buyer@example.test',password,display_name:'Current buyer',role:'member'},admin);
 const current=page.locator('#inventory-current'),history=page.locator('#inventory-history'),stats=page.getByRole('group',{name:'当前库存统计'});
 const currentTab=page.getByRole('tab',{name:/当前库存/}),historyTab=page.getByRole('tab',{name:/历史记录/});
 assert.equal(await currentTab.getAttribute('aria-selected'),'true');
 assert.equal(await currentTab.locator('.inventory-tab-count').textContent(),'2');
 assert.equal(await historyTab.locator('.inventory-tab-count').textContent(),'1');
 assert.equal(await current.locator('tbody tr').count(),2,'Same names do not identify the same lease');
 assert.equal(await current.getByText('shared@example.test',{exact:true}).count(),0,'Provider identities are not exposed');assert.equal(new Set(await current.locator('.inventory-account-code').allTextContents()).size,2,'Independent leases get distinct local numbers');
 assert.equal(await stats.locator('.stat').filter({hasText:'可分配'}).locator('.stat-value').textContent(),'2');
 assert.equal(await stats.locator('.stat').filter({hasText:'已分配'}).locator('.stat-value').textContent(),'0','Released assigned=true must not inflate current counts');
 await historyTab.click();
 assert.equal(new URL(page.url()).searchParams.get('view'),'history');
 assert.equal(await history.locator('tbody tr').count(),1);
 assert.equal(await history.getByRole('cell',{name:'已释放',exact:true}).count(),1);
 assert.equal(await history.getByRole('columnheader',{name:'原授权到期',exact:true}).count(),1);
 assert.equal(await history.getByRole('button',{name:/分配客户|延长客户有效期|收回账号/}).count(),0);
 await history.getByRole('button',{name:'查看记录',exact:true}).click();
 const record=page.getByRole('dialog',{name:'历史授权记录'});await record.waitFor();
 assert.equal(await record.getByText('previous-lease',{exact:true}).count(),1);
 assert.equal(await record.getByText('原授权到期',{exact:true}).count(),1);
 assert.equal(await record.getByText('Live quota',{exact:true}).count(),0);
 assert.equal(await record.getByText(/Live device/).count(),0);
 assert.equal(await record.getByText('释放时间',{exact:true}).count(),0);
 await page.keyboard.press('Escape');
 assert.equal(f.state.requests.filter(r=>['POST','PATCH','DELETE'].includes(r.method)&&r.path.includes('/grants')).length,0);
 await page.reload();await page.getByRole('tabpanel',{name:/历史记录/}).waitFor();
 assert.equal(await historyTab.getAttribute('aria-selected'),'true');
 await page.getByRole('button',{name:'刷新',exact:true}).click();await page.getByRole('tabpanel',{name:/历史记录/}).waitFor();
 assert.equal(await stats.locator('.stat').filter({hasText:'已分配'}).locator('.stat-value').textContent(),'0');
 await historyTab.focus();await page.keyboard.press('Home');
 assert.equal(await currentTab.getAttribute('aria-selected'),'true');assert.equal(await currentTab.evaluate(node=>document.activeElement===node),true);
 await page.keyboard.press('End');assert.equal(await historyTab.getAttribute('aria-selected'),'true');
 await page.keyboard.press('ArrowRight');assert.equal(await currentTab.getAttribute('aria-selected'),'true');
 assert.equal(new URL(page.url()).searchParams.has('view'),false);
 await current.locator('tbody tr').first().getByRole('button',{name:'账号详情',exact:true}).click();
 assert.equal(await page.getByRole('dialog').getByText('授权编号：replacement-lease',{exact:true}).count(),1);
 await page.keyboard.press('Escape');
 await current.locator('tbody tr').first().getByRole('button',{name:'分配客户',exact:true}).click();
 await page.getByLabel('客户',{exact:true}).selectOption(member.data.user.id);await page.getByRole('button',{name:'确认分配',exact:true}).click();
 await page.getByRole('dialog').waitFor({state:'hidden'});await current.getByText('Current buyer',{exact:true}).waitFor();
 const deliveries=f.state.requests.filter(r=>r.method==='POST'&&r.path==='/access/v1/grants');
 assert.equal(deliveries.length,1);assert.equal(deliveries[0].body.account_lease_id,'replacement-lease');assert.equal(deliveries[0].body.expected_account_revision,4);
 assert.equal(f.state.inventory[2].assigned,false);
 assert.equal(await stats.locator('.stat').filter({hasText:'可分配'}).locator('.stat-value').textContent(),'1');
 assert.equal(await stats.locator('.stat').filter({hasText:'已分配'}).locator('.stat-value').textContent(),'1');
 await page.locator('.toast').waitFor({state:'hidden'});
 const artifacts=resolve(project,'tests/browser/artifacts');await mkdir(artifacts,{recursive:true});
 for(const theme of ['light','dark']){
  await page.evaluate(value=>document.documentElement.dataset.theme=value,theme);
  for(const width of [1440,390,320]){
   await page.setViewportSize({width,height:1050});
   for(const tab of [currentTab,historyTab]){
    await tab.click();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${theme} ${width}: no page overflow`);
    await page.screenshot({path:resolve(artifacts,`inventory-${await tab.getAttribute('aria-controls')}-${theme}-${width}.png`),fullPage:true});
   }
  }
 }
 assert.deepEqual(f.state.inventory.map(a=>a.id),['previous-lease','replacement-lease','same-name-independent-lease']);
 await context.close();
});

test('current anomalies stay visible, customer filters scope counts and history, and historical-only inventories stay empty',async t=>{
 const expires_at=new Date(Date.now()+30*86400000).toISOString(),past=new Date(Date.now()-86400000).toISOString();
 const inventory=[
  {id:'available'},
  {id:'assigned-a',assigned:true,customer_id:'customer-a',details:{name:'Assigned A',state:'unavailable'}},
  {id:'assigned-b',assigned:true,customer_id:'customer-b'},
  {id:'not-ready',details:{name:'Not ready',state:'unavailable'}},
  {id:'unknown-state',status:'pending'},
  {id:'unknown-expiry',assigned:true,customer_id:'customer-a',expires_at:'invalid'},
  {id:'released-a',status:'released',assigned:true,customer_id:'customer-a'},
  {id:'expired-unassociated',status:'expired'},
  {id:'expired-b',expires_at:past,assigned:true,customer_id:'customer-b'},
  {id:'detail-expired',details:{name:'Stale detail',state:'expired'}},
  {id:'missing-details',details:null},
  {id:'limited',details:{name:'Limited',state:'limited'}},
 ].map(a=>({status:'active',assigned:false,allow_delegation:true,resource_id:'resource-1',platform:'Windows/x64',expires_at,revision:1,grant_id:'grant-'+a.id,grant_revision:1,details:{name:a.id,state:'available'},...a}));
 const {f,admin,page}=await inventoryHarness(t,{inventory});
 const memberA=await f.request('POST','/api/admin/users',{email:'a@example.test',password,display_name:'Buyer A',role:'member'},admin);
 const memberB=await f.request('POST','/api/admin/users',{email:'b@example.test',password,display_name:'Buyer B',role:'member'},admin);
 f.store.db.prepare('UPDATE users SET core_customer_id=? WHERE id=?').run('customer-a',memberA.data.user.id);
 f.store.db.prepare('UPDATE users SET core_customer_id=? WHERE id=?').run('customer-b',memberB.data.user.id);
 await page.reload();await page.getByRole('tab',{name:/当前库存/}).waitFor();
 const current=page.locator('#inventory-current'),history=page.locator('#inventory-history'),stats=page.getByRole('group',{name:'当前库存统计'});
 assert.equal(await current.locator('tbody tr').count(),9);
 assert.equal(await stats.locator('.stat').filter({hasText:'可分配'}).locator('.stat-value').textContent(),'2');
 assert.equal(await stats.locator('.stat').filter({hasText:'已分配'}).locator('.stat-value').textContent(),'2');
 for(const id of ['not-ready','unknown-state','detail-expired','missing-details']){
  const row=current.locator('[data-account-lease="'+id+'"]');assert.equal(await row.count(),1);assert.equal(await row.getByRole('button',{name:'分配客户',exact:true}).isDisabled(),true);
 }
 assert.equal(await current.locator('[data-account-lease="unknown-state"]').getByText('状态待核对',{exact:true}).count(),1);
 assert.equal(await current.locator('[data-account-lease="unknown-expiry"]').getByText('有效期待核对',{exact:true}).count(),1);
 const customerURL=f.config.publicOrigin+'/admin/inventory?user_id='+memberA.data.user.id;
 await page.goto(customerURL);await page.getByRole('tab',{name:/当前库存/}).waitFor();
 assert.equal(await current.locator('tbody tr').count(),8);assert.equal(await current.getByText('Buyer B',{exact:true}).count(),0);
 assert.equal(await stats.locator('.stat').filter({hasText:'可分配'}).locator('.stat-value').textContent(),'2');
 assert.equal(await stats.locator('.stat').filter({hasText:'已分配'}).locator('.stat-value').textContent(),'1');
 await page.getByRole('tab',{name:/历史记录/}).click();
 assert.equal(new URL(page.url()).searchParams.get('user_id'),memberA.data.user.id);assert.equal(new URL(page.url()).searchParams.get('view'),'history');
 assert.equal(await history.locator('tbody tr').count(),1);assert.equal(await history.locator('[data-account-lease="released-a"]').count(),1);
 assert.equal(await history.locator('[data-account-lease="expired-unassociated"]').count(),0);assert.equal(await history.getByText('Buyer B',{exact:true}).count(),0);
 await page.reload();await page.getByRole('tabpanel',{name:/历史记录/}).waitFor();
 assert.equal(await page.getByRole('link',{name:'查看全部库存',exact:true}).getAttribute('href'),'/admin/inventory?view=history');
 await page.getByRole('link',{name:'查看全部库存',exact:true}).click();await page.getByRole('tab',{name:/历史记录\s*3/}).waitFor();
 assert.equal(await history.locator('tbody tr').count(),3);
 f.state.inventory=inventory.filter(a=>['released-a','expired-unassociated','expired-b'].includes(a.id));
 await page.goto(f.config.publicOrigin+'/admin/inventory');await page.getByText('暂无当前库存',{exact:true}).waitFor();
 assert.deepEqual(await stats.locator('.stat-value').allTextContents(),['0','0']);
 await page.getByRole('tab',{name:/历史记录/}).click();assert.equal(await history.locator('tbody tr').count(),3);
 assert.equal(await history.getByRole('button',{name:/分配客户|延长客户有效期|收回账号/}).count(),0);
 f.state.inventory=[];
 await page.reload();await page.getByText('暂无历史记录',{exact:true}).waitFor();
 await page.getByRole('tab',{name:/当前库存/}).click();await page.getByText('暂无账号',{exact:true}).waitFor();
 assert.equal(f.state.requests.filter(r=>['POST','PATCH','DELETE'].includes(r.method)&&r.path.includes('/grants')).length,0);
});
