import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir} from 'node:fs/promises';
import {fixture,password} from '../server/fixtures.js';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');

test('numbered inventory exposes quota uncertainty and batches retain customers beyond the first 200',async t=>{
 const f=await fixture(t,{publicDir:resolve(root,'public')});
 f.state.inventory[2].allow_delegation=false;
 f.state.inventory[0].details.quota={status:'error',updated_at:'2026-01-01T00:00:00Z',windows:[{key:'five_hour',label:'5 小时',used_percent:null}]};
 const admin=await f.request('POST','/api/setup',{setup_token:f.setupToken,email:'admin@example.test',display_name:'管理员',password});
 const hash=f.store.db.prepare('SELECT password_hash FROM users WHERE id=?').get(admin.data.user.id).password_hash;
 let selected;f.store.transaction(()=>{for(let i=0;i<205;i++){selected=f.store.createUser({email:'buyer-'+i+'@example.test',display_name:'客户 '+i,password_hash:hash,role:'member',status:'active'});f.store.db.prepare('UPDATE users SET created_at=? WHERE id=?').run(new Date(Date.parse('2030-01-01T00:00:00Z')+i*1000).toISOString(),selected.id);}});
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const context=await browser.newContext({viewport:{width:1440,height:1050},reducedMotion:'reduce'}),page=await context.newPage(),faults=[],external=[];
 page.setDefaultTimeout(10000);page.on('pageerror',e=>faults.push(e.message));await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==f.config.publicOrigin){external.push(route.request().url());return route.abort();}return route.continue();});
 await page.goto(f.config.publicOrigin+'/login');try{await page.getByLabel('电子邮箱',{exact:true}).fill('admin@example.test');}catch(error){console.error(JSON.stringify({phase:'login-ready',url:page.url(),body:await page.locator('body').innerText()}));throw error;}await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('link',{name:'库存',exact:true}).waitFor();
 await page.goto(f.config.publicOrigin+'/admin/inventory?user_id='+selected.id);await page.getByRole('tab',{name:/当前库存/}).waitFor();
 const current=page.locator('#inventory-current'),blocked=current.locator('[data-account-lease="owned-3"]');assert.equal(await blocked.getByRole('button',{name:'分配客户',exact:true}).isDisabled(),true);assert.equal(await blocked.getByRole('checkbox').isDisabled(),true);
 const row=current.locator('[data-account-lease="owned-1"]');await row.getByRole('button',{name:'账号详情',exact:true}).click();assert.equal(await page.getByRole('dialog').locator('.quota-summary-label strong').textContent(),'未知');assert.equal(await page.getByRole('dialog').getByText('0%',{exact:true}).count(),0);await page.keyboard.press('Escape');
 await current.locator('[data-account-lease="owned-1"]').getByRole('checkbox').check();await current.locator('[data-account-lease="owned-2"]').getByRole('checkbox').check();await page.getByRole('button',{name:'批量分配（2）',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'分配客户'});await dialog.getByLabel('客户',{exact:true}).waitFor();assert.equal(await dialog.getByLabel('客户',{exact:true}).inputValue(),selected.id);
 await dialog.getByLabel('搜索客户',{exact:true}).fill('客户 10');await page.waitForResponse(r=>new URL(r.url()).pathname==='/api/admin/users'&&new URL(r.url()).searchParams.get('q')==='客户 10');assert.equal(await dialog.getByLabel('客户',{exact:true}).inputValue(),selected.id);
 await dialog.getByRole('button',{name:'预检分配',exact:true}).click();await dialog.getByText('可执行',{exact:true}).first().waitFor();assert.equal(f.state.grants.length,0);
 const artifacts=resolve(root,'.local-preview/admin-management-ui');await mkdir(artifacts,{recursive:true});await page.screenshot({path:resolve(artifacts,'batch-preflight.png')});
 await dialog.getByRole('button',{name:'确认分配',exact:true}).click();await page.getByRole('dialog').filter({hasText:'确认批量分配'}).getByRole('button',{name:'确认分配',exact:true}).click();await dialog.waitFor({state:'hidden'});assert.equal(f.state.grants.length,2);assert.ok(f.state.grants.every(g=>g.customer_id===f.store.db.prepare('SELECT core_customer_id FROM users WHERE id=?').get(selected.id).core_customer_id));
 await page.getByRole('heading',{name:'分配批次',exact:true}).waitFor();await page.screenshot({path:resolve(artifacts,'inventory-desktop.png'),fullPage:true});await page.setViewportSize({width:390,height:844});await page.screenshot({path:resolve(artifacts,'inventory-mobile.png'),fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
 const writes=f.state.requests.filter(r=>r.method==='POST'&&r.path==='/access/v1/grants').length;await page.getByRole('button',{name:'查看批次',exact:true}).click();await page.getByRole('button',{name:'继续未执行项',exact:true}).click();const resumed=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/admin/allocation-batches'&&r.request().method()==='POST');await page.getByRole('dialog').filter({hasText:'确认批次操作'}).getByRole('button',{name:'确认',exact:true}).click();await resumed;await page.getByRole('button',{name:'继续未执行项',exact:true}).waitFor();assert.equal(f.state.requests.filter(r=>r.method==='POST'&&r.path==='/access/v1/grants').length,writes);
 assert.deepEqual(faults,[]);assert.deepEqual(external,[]);
});

test('administrator security UI resets a member without impersonating them and temporary login must change password',async t=>{
 const f=await fixture(t,{publicDir:resolve(root,'public')}),admin=await f.request('POST','/api/setup',{setup_token:f.setupToken,email:'admin@example.test',display_name:'管理员',password});
 const created=await f.request('POST','/api/admin/users',{email:'member@example.test',display_name:'客户安全测试',password,role:'member'},admin);
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();page.setDefaultTimeout(10000);await page.route('**/*',route=>new URL(route.request().url()).origin===f.config.publicOrigin?route.continue():route.abort());
 await page.goto(f.config.publicOrigin+'/login');try{await page.getByLabel('电子邮箱',{exact:true}).fill('admin@example.test');}catch(error){console.error(JSON.stringify({phase:'login-ready',url:page.url(),body:await page.locator('body').innerText()}));throw error;}await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('link',{name:'库存',exact:true}).waitFor();await page.goto(f.config.publicOrigin+'/admin/customers?user_id='+created.data.user.id);
 await page.getByRole('button',{name:'登录安全 / 重置密码',exact:true}).click();const dialog=page.getByRole('dialog',{name:'客户登录安全'});await dialog.getByLabel('临时密码',{exact:true}).fill('Temporary-browser-test-password');await dialog.getByLabel('管理员当前密码',{exact:true}).fill(password);await dialog.getByLabel('处理原因',{exact:true}).fill('Synthetic support verification');await dialog.getByRole('button',{name:'确认安全操作',exact:true}).click();await page.getByRole('dialog').filter({hasText:'确认客户登录安全操作'}).getByRole('button',{name:'确认执行',exact:true}).click();await dialog.waitFor({state:'hidden'});
 await page.getByRole('button',{name:'退出登录',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'退出登录',exact:true}).click();await page.getByLabel('电子邮箱',{exact:true}).fill('member@example.test');await page.getByLabel('密码',{exact:true}).fill('Temporary-browser-test-password');await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('button',{name:'更新密码',exact:true}).waitFor();assert.equal(new URL(page.url()).pathname,'/profile');
 await page.goto(f.config.publicOrigin+'/accounts');await page.getByRole('button',{name:'更新密码',exact:true}).waitFor();assert.equal(new URL(page.url()).pathname,'/profile');await page.getByLabel('当前密码',{exact:true}).fill('Temporary-browser-test-password');await page.getByLabel('新密码',{exact:true}).fill('A-new-browser-test-password');await page.getByLabel('确认新密码',{exact:true}).fill('A-new-browser-test-password');await page.getByRole('button',{name:'更新密码',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'更新密码',exact:true}).click();await page.getByRole('button',{name:'登录',exact:true}).waitFor();
 assert.equal(f.store.db.prepare('SELECT must_change_password FROM users WHERE id=?').get(created.data.user.id).must_change_password,0);
});


test('mapped batch distributes different allocations to different customers without a hidden common selector blocking submission',async t=>{
 const f=await fixture(t,{publicDir:resolve(root,'public')}),admin=await f.request('POST','/api/setup',{setup_token:f.setupToken,email:'admin@example.test',display_name:'管理员',password});
 const customers=[];for(const name of ['a','b']){const r=await f.request('POST','/api/admin/users',{email:name+'@example.test',display_name:'Mapped '+name,password,role:'member'},admin);customers.push(r.data.user);}
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();page.setDefaultTimeout(10000);await page.route('**/*',route=>new URL(route.request().url()).origin===f.config.publicOrigin?route.continue():route.abort());
 await page.goto(f.config.publicOrigin+'/login');try{await page.getByLabel('电子邮箱',{exact:true}).fill('admin@example.test');}catch(error){console.error(JSON.stringify({phase:'login-ready',url:page.url(),body:await page.locator('body').innerText()}));throw error;}await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('link',{name:'库存',exact:true}).click();
 await page.locator('#inventory-current [data-account-lease="owned-1"]').getByRole('checkbox').check();await page.locator('#inventory-current [data-account-lease="owned-2"]').getByRole('checkbox').check();await page.getByRole('button',{name:'批量分配（2）',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'分配客户'});await dialog.getByLabel('分配方式',{exact:true}).selectOption('mapped');const maps=dialog.locator('.allocation-mapping');await maps.nth(1).waitFor();
 for(let i=0;i<2;i++)await maps.nth(i).getByLabel('客户',{exact:true}).selectOption(customers[i].id);
 await dialog.getByRole('button',{name:'确认分配',exact:true}).click();await page.getByRole('dialog').filter({hasText:'确认批量分配'}).getByRole('button',{name:'确认分配',exact:true}).click();await dialog.waitFor({state:'hidden'});
 assert.equal(f.state.grants.length,2);assert.equal(new Set(f.state.grants.map(g=>g.customer_id)).size,2);
 for(let i=0;i<2;i++){const expected=f.store.db.prepare('SELECT core_customer_id FROM users WHERE id=?').get(customers[i].id).core_customer_id;assert.equal(f.state.inventory[i].customer_id,expected);}
});
