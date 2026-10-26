import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { fixture,stripeFixture,password } from '../server/fixtures.js';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const project=resolve(dirname(fileURLToPath(import.meta.url)),'../..');

test('actual storefront UI creates a plan, buys, renews, filters and exports immutable rental orders',async t=>{
 const stripe=stripeFixture(),f=await fixture(t,{publicDir:resolve(project,'public'),env:{STRIPE_SECRET_KEY:'sk_test_fixture',STRIPE_WEBHOOK_SECRET:'whsec_test_fixture'},paymentTransport:stripe.transport});
 const admin=await f.request('POST','/api/setup',{setup_token:f.setupToken,email:'admin@example.test',password,display_name:'商户管理员'});
 await f.request('POST','/api/admin/users',{email:'member@example.test',password,display_name:'购买测试客户',role:'member'},admin);
 const member=await f.request('POST','/api/auth/login',{email:'member@example.test',password});
 const topup=await f.request('POST','/api/me/payments',{amount_minor:10000},member);assert.equal(topup.status,201);
 const session=[...stripe.sessions.values()][0];session.status='complete';session.payment_status='paid';const event=stripe.event(session.id);
 await f.request('POST','/api/webhooks/stripe',event.payload,{headers:{'Stripe-Signature':event.signature}});
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{})});
 t.after(()=>browser.close());
 const context=await browser.newContext({viewport:{width:1440,height:1050},reducedMotion:'reduce'}),page=await context.newPage(),failures=[],external=[];
 page.on('pageerror',e=>failures.push(e.message));page.setDefaultTimeout(10000);
 await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==f.config.publicOrigin){external.push(route.request().url());return route.abort();}return route.continue();});
 await page.goto(f.config.publicOrigin+'/login');
 await page.getByLabel('电子邮箱',{exact:true}).fill('admin@example.test');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录工作台',exact:true}).click();
 await page.getByRole('link',{name:'套餐管理',exact:true}).click();await page.getByRole('button',{name:'创建套餐',exact:true}).click();
 await page.getByLabel('套餐名称',{exact:true}).fill('Code 周套餐');await page.getByLabel('套餐说明',{exact:true}).fill('测试供给 · 按期限使用，不按 Token 扣费');
 await page.getByLabel('租期（天，每天 24 小时）',{exact:true}).fill('7');await page.getByLabel('销售价（人民币元）',{exact:true}).fill('12.34');await page.getByLabel('上架状态',{exact:true}).selectOption('active');
 await page.getByRole('button',{name:'保存套餐',exact:true}).click();await page.getByRole('dialog').filter({hasText:'已有订单保留原价格'}).getByRole('button',{name:'确认保存',exact:true}).click();
 await page.getByRole('row').filter({hasText:'Code 周套餐'}).waitFor();
 const artifacts=resolve(project,'tests/browser/artifacts');await mkdir(artifacts,{recursive:true});await page.screenshot({path:resolve(artifacts,'rental-admin-plans.png'),fullPage:true});
 await page.getByRole('link',{name:'运营待办',exact:true}).click();await page.getByText('后台自动核对已启用',{exact:true}).waitFor();
 await page.getByRole('button',{name:'退出登录',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'退出登录',exact:true}).click();
 await page.getByLabel('电子邮箱',{exact:true}).fill('member@example.test');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录工作台',exact:true}).click();
 await page.getByRole('link',{name:'套餐与续期',exact:true}).click();assert.equal(await page.getByRole('link',{name:'套餐管理',exact:true}).count(),0);
 await page.getByRole('heading',{name:'Code 周套餐',exact:true}).waitFor();await page.screenshot({path:resolve(artifacts,'rental-member-plans.png'),fullPage:true});
 for(let i=0;i<2;i++){
  await page.getByRole('button',{name:'购买 / 续期',exact:true}).click();await page.getByRole('button',{name:'确认下单',exact:true}).click();await page.getByRole('dialog').filter({hasText:'确认购买套餐'}).getByRole('button',{name:'确认购买',exact:true}).click();
  await page.getByRole('dialog').getByText('已交付',{exact:true}).waitFor();await page.getByRole('dialog').getByRole('link',{name:'查看订单与交付',exact:true}).click();
  await page.getByRole('heading',{name:'我的订单',exact:true}).waitFor();await page.getByRole('row').filter({hasText:'Code 周套餐'}).first().waitFor();assert.equal(await page.getByRole('row').filter({hasText:'Code 周套餐'}).count(),i+1);
  if(i===0){await page.getByRole('link',{name:'套餐与续期',exact:true}).click();}
 }
 const rows=f.store.db.prepare('SELECT * FROM rentals ORDER BY created_at').all();assert.equal(rows.length,2);assert.equal(Date.parse(rows[1].expires_at)-Date.parse(rows[0].expires_at),7*86400000);
 assert.equal(f.store.wallet(member.data.user.id).balance_minor,7532);
 await page.getByLabel('订单或套餐',{exact:true}).fill('不存在');await page.getByRole('button',{name:'筛选',exact:true}).click();await page.getByText('共 0 笔 · 本页 0 笔',{exact:true}).waitFor();
 await page.getByLabel('订单或套餐',{exact:true}).fill('Code');await page.getByRole('button',{name:'筛选',exact:true}).click();await page.getByText('共 2 笔 · 本页 2 笔',{exact:true}).waitFor();
 const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'导出本页 CSV',exact:true}).click();assert.equal((await downloaded).suggestedFilename(),'rental-orders.csv');
 await page.screenshot({path:resolve(artifacts,'rental-member-orders.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:resolve(artifacts,'rental-member-mobile.png'),fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
 assert.deepEqual(failures,[]);assert.deepEqual(external,[]);
});
