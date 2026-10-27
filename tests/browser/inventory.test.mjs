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
 await page.getByLabel('电子邮箱',{exact:true}).fill('admin@example.test');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录工作台',exact:true}).click();
 await page.getByRole('link',{name:'账号库存',exact:true}).click();
 await page.getByText('Account 1',{exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:/采购账号|续购|充值|入账/}).count(),0);
 await page.getByRole('button',{name:'账号详情',exact:true}).first().click();
 await page.getByRole('dialog').getByRole('heading',{name:'Account 1',exact:true}).waitFor();
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
 const row=page.getByRole('row').filter({hasText:'Account 1'});await row.getByRole('button',{name:'收回账号',exact:true}).click();await page.getByRole('dialog',{name:'收回账号'}).getByRole('button',{name:'确认收回',exact:true}).click();
 await row.getByRole('button',{name:'分配客户',exact:true}).waitFor();assert.equal(f.state.inventory[0].assigned,false);
 await row.getByRole('button',{name:'分配客户',exact:true}).click();await page.getByLabel('客户',{exact:true}).selectOption(member.data.user.id);await page.getByRole('button',{name:'确认分配',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
 f.state.accounts.filter(a=>a.state==='available').forEach(a=>a.device_name='本机 Laptop');
 await page.getByRole('button',{name:'退出登录',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'退出登录',exact:true}).click();
 await page.getByLabel('电子邮箱',{exact:true}).fill('member@example.test');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录工作台',exact:true}).click();
 await page.getByRole('link',{name:'我的账号',exact:true}).click();await page.getByRole('link',{name:'开始使用',exact:true}).waitFor();assert.equal(await page.getByRole('link',{name:'充值/订阅',exact:true}).count(),0);await page.getByRole('link',{name:'更换设备',exact:true}).click();await page.getByRole('heading',{name:'更换设备',exact:true}).waitFor();await page.getByText('本机 Laptop',{exact:true}).waitFor();assert.equal(await page.getByText('另一账号的设备',{exact:true}).count(),0);
 await page.getByRole('button',{name:'撤销连接',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'撤销连接',exact:true}).click();await page.getByText('还没有连接设备',{exact:true}).waitFor();assert.equal(f.state.deviceReleased,true);
 await page.getByRole('link',{name:'开始使用',exact:true}).click();await page.getByRole('heading',{name:'开始使用',exact:true}).waitFor();
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
 await page.goto(f.config.publicOrigin+'/login');await page.getByLabel('电子邮箱',{exact:true}).fill('admin@example.test');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录工作台',exact:true}).click();await page.getByRole('link',{name:'账号库存',exact:true}).click();
 await page.getByRole('button',{name:'分配客户',exact:true}).first().click();await page.getByLabel('客户',{exact:true}).selectOption(member.data.user.id);await page.getByRole('button',{name:'确认分配',exact:true}).click();await page.getByRole('button',{name:'核对分配结果',exact:true}).waitFor();assert.equal(await page.getByLabel('客户',{exact:true}).isDisabled(),true);
 await page.getByRole('button',{name:'核对分配结果',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});await page.getByText('Pending customer',{exact:true}).waitFor();assert.equal(f.state.requests.filter(r=>r.method==='POST'&&r.path==='/access/v1/grants').length,1);assert.equal(f.state.grants.length,1);assert.deepEqual(errors,[]);
});
