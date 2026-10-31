import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, password } from '../server/fixtures.js';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');

test('reclaimed accounts disappear after refresh from cards, home, device choices and connection links',async t=>{
 const f=await fixture(t,{publicDir:resolve(root,'public'),onCore:({req,url,state,json})=>{
  if(req.method==='GET'&&url.pathname.endsWith('/devices')){json({devices:[{id:'laptop',name:'测试电脑',state:'approved',selection_version:1,current_grant_id:state.grants[0]?.id}]});return true;}
 }});
 const admin=await f.request('POST','/api/setup',{setup_token:f.setupToken,email:'owner@example.test',password,display_name:'Owner'});
 const user=(await f.request('POST','/api/admin/users',{email:'member@example.test',password,display_name:'Member',role:'member'},admin)).data.user;
 const grants=[];
 for(const account_lease_id of ['owned-1','owned-2']){
  const created=await f.request('POST','/api/admin/grants',{user_id:user.id,resource_id:'resource-1',account_lease_id,expected_account_revision:1,expires_at:new Date(Date.now()+86400000).toISOString()},admin);
  assert.equal(created.status,201,created.raw);grants.push(created.data.grant);
 }
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{})});
 const faults=[],unexpected=[];t.after(async()=>{await browser.close();assert.deepEqual(faults,[]);assert.deepEqual(unexpected,[]);});
 const pages=[];
 for(const email of ['owner@example.test',user.email]){
  const context=await browser.newContext({viewport:{width:1440,height:1050},reducedMotion:'reduce'}),page=await context.newPage();pages.push(page);
  page.setDefaultTimeout(10000);page.on('pageerror',error=>faults.push(error.message));
  await context.route('**/*',route=>{const origin=new URL(route.request().url()).origin;if(origin===f.config.publicOrigin)return route.continue();unexpected.push(origin);return route.abort();});
  await page.goto(f.config.publicOrigin+'/login');await page.getByLabel('电子邮箱',{exact:true}).fill(email);await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.locator('.shell').waitFor();
 }
 const [owner,member]=pages;
 await member.goto(f.config.publicOrigin+'/accounts');await member.getByRole('heading',{name:grants[0].name,exact:true}).waitFor();await member.getByRole('heading',{name:grants[1].name,exact:true}).waitFor();
 await owner.goto(f.config.publicOrigin+'/admin/inventory');
 await owner.getByRole('row').filter({has:owner.getByText(grants[0].name,{exact:true})}).getByRole('button',{name:'收回账号',exact:true}).click();
 const revoked=owner.waitForResponse(r=>r.request().method()==='PATCH'&&new URL(r.url()).pathname==='/api/admin/grants/'+grants[0].id);
 await owner.getByRole('dialog').getByRole('button',{name:'确认收回',exact:true}).click();assert.equal((await revoked).status(),200);
 await owner.getByRole('dialog').waitFor({state:'hidden'});assert.equal(f.state.grants[0].status,'revoked');
 // An old card can be unavailable (rather than expired) with a future expiry.
 f.state.accounts[0].state='unavailable';
 await member.getByRole('button',{name:'刷新',exact:true}).click();await member.getByRole('heading',{name:grants[0].name,exact:true}).waitFor({state:'hidden'});
 await member.getByRole('heading',{name:grants[1].name,exact:true}).waitFor();assert.equal(await member.locator('.account-card').count(),1);
 await member.goto(f.config.publicOrigin+'/');await member.locator('.account-rows').getByText(grants[1].name,{exact:true}).waitFor();assert.equal(await member.locator('.account-rows').getByText(grants[0].name,{exact:true}).count(),0);
 await member.goto(f.config.publicOrigin+'/devices');await member.getByRole('button',{name:'管理绑定',exact:true}).click();
 const dialog=member.getByRole('dialog',{name:'设备绑定管理'}),options=await dialog.getByLabel('Code 账号',{exact:true}).locator('option').allTextContents();
 assert.ok(options.includes(grants[1].name));assert.ok(!options.includes(grants[0].name));await member.keyboard.press('Escape');
 await member.goto(f.config.publicOrigin+'/connect?account_id='+grants[0].id);await member.getByRole('heading',{name:'账号暂不可用',exact:true}).waitFor();assert.equal(await member.getByRole('button',{name:'核对设备',exact:true}).count(),0);
 const last=await f.request('PATCH','/api/admin/grants/'+grants[1].id,{expected_revision:1,status:'revoked'},admin);assert.equal(last.status,200,last.raw);
 await member.goto(f.config.publicOrigin+'/accounts');await member.getByRole('heading',{name:'还没有账号',exact:true}).waitFor();assert.equal(await member.locator('.account-card').count(),0);
 await member.goto(f.config.publicOrigin+'/connect');await member.getByRole('heading',{name:'等待分配账号',exact:true}).waitFor();
 assert.equal(f.state.requests.some(r=>r.method==='POST'&&r.path.endsWith('/devices/approve')),false);
});
