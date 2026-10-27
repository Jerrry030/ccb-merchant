import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { fixture,password } from '../server/fixtures.js';
import { providerFixture } from '../server/payment-provider-fixture.js';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const project=resolve(dirname(fileURLToPath(import.meta.url)),'../..');

test('actual multi-channel storefront renders local QR codes, confirms payment and opens owner-scoped Airwallex checkout',async t=>{
 const remote=providerFixture(),f=await fixture(t,{withoutCore:true,publicDir:resolve(project,'public'),paymentTransport:remote.transport});
 const admin=await f.request('POST','/api/setup',{email:'admin@example.test',password,display_name:'支付测试管理员',setup_token:f.setupToken});
 assert.equal((await f.request('PATCH','/api/admin/payment',{expected_revision:1,providers:{alipay:remote.configs.alipay,wxpay:remote.configs.wxpay,airwallex:remote.configs.airwallex},methods:{alipay:{enabled:true,source:'official_alipay'},wxpay:{enabled:true,source:'official_wxpay'},airwallex:{enabled:true,source:'airwallex_checkout'}}},admin)).status,200);
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{})});t.after(()=>browser.close());
 const context=await browser.newContext({viewport:{width:1365,height:1000},reducedMotion:'reduce'}),page=await context.newPage(),errors=[],external=[];
 page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
 await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==f.config.publicOrigin){external.push(route.request().url());return route.abort();}return route.continue();});
 t.after(()=>{assert.deepEqual(errors,[]);assert.deepEqual(external,[]);});
 await page.goto(f.config.publicOrigin+'/login');await page.getByLabel('电子邮箱',{exact:true}).fill('admin@example.test');await page.getByLabel('密码',{exact:true}).fill(password);await page.locator('.auth-form button[type=submit]').click();await page.getByRole('link',{name:'站点设置',exact:true}).waitFor();
 await page.goto(f.config.publicOrigin+'/admin/settings#payment');await page.getByRole('tab',{name:'支付配置',exact:true}).waitFor();
 assert.equal(await page.getByText('此渠道尚未接入收款',{exact:true}).count(),0);assert.equal(await page.getByText('未接入收款',{exact:true}).count(),0);
 await page.locator('summary').filter({hasText:'支付宝官方'}).click();await page.getByLabel('支付宝官方 App ID',{exact:true}).waitFor();
 const artifacts=resolve(project,'tests/browser/artifacts');await mkdir(artifacts,{recursive:true});await page.screenshot({path:resolve(artifacts,'payment-alipay-implemented.png'),fullPage:true});
 await page.goto(f.config.publicOrigin+'/wallet');
 await page.getByLabel('支付方式',{exact:true}).waitFor();
 const choices=await page.getByLabel('支付方式',{exact:true}).locator('option').allTextContents();assert.deepEqual(new Set(choices),new Set(['支付宝','微信支付','Airwallex']));
 for(const method of ['alipay','wxpay','airwallex']) {
   await page.getByLabel('支付方式',{exact:true}).selectOption(method);await page.getByLabel('充值金额（人民币元）',{exact:true}).fill('12.34');
   await page.getByRole('button',{name:'创建支付订单',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'创建订单',exact:true}).click();
   await page.getByText('支付订单已创建，尚不代表已付款',{exact:true}).waitFor();
   const row=f.store.db.prepare('SELECT * FROM orders WHERE payment_method=? ORDER BY created_at DESC LIMIT 1').get(method);assert.ok(row);
   if(method!=='airwallex') {
     const qr=page.getByAltText('支付二维码',{exact:true});await qr.waitFor();await qr.evaluate(image=>image.decode());assert.ok(await qr.evaluate(image=>image.naturalWidth>0));
     await page.screenshot({path:resolve(artifacts,'payment-'+method+'-checkout.png'),fullPage:true});
     if(method==='wxpay'){await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:resolve(artifacts,'payment-wxpay-mobile.png'),fullPage:true});await page.setViewportSize({width:1365,height:1000});}
   }else{
     await context.route(f.config.publicOrigin+'/vendor/airwallex-sdk.mjs',route=>route.fulfill({contentType:'text/javascript',body:'export async function init(options){globalThis.sdkInitOptions=options;return {payments:{redirectToCheckout(value){globalThis.sdkCheckout=value;}}};}'}));
     const popupPromise=context.waitForEvent('page');await page.getByRole('link',{name:'打开 Airwallex 收银台 ↗',exact:true}).click();const popup=await popupPromise;
     await popup.getByText('订单已准备好。点击按钮前往 Airwallex 完成付款；本页面不会自动扣款。',{exact:true}).waitFor();
     assert.equal(await popup.evaluate(()=>globalThis.sdkCheckout),undefined);
     await popup.getByRole('button',{name:'前往安全收银台',exact:true}).click();await popup.waitForFunction(()=>Boolean(globalThis.sdkCheckout));
     const captured=await popup.evaluate(()=>({options:globalThis.sdkCheckout,init:globalThis.sdkInitOptions,storage:JSON.stringify(localStorage)}));
     assert.equal(captured.options.intent_id,'int_'+row.id);assert.equal(captured.options.client_secret,'fixture-intent-secret');assert.equal(captured.init.env,'demo');assert.equal(captured.storage.includes('fixture-intent-secret'),false);
     assert.equal(new URL(popup.url()).origin,f.config.publicOrigin);await popup.close();
   }
   remote.orders.get(row.id).paid=true;await page.getByRole('button',{name:'查询支付状态',exact:true}).click();await page.getByText('支付已确认',{exact:true}).waitFor();
   assert.equal(await page.getByAltText('支付二维码',{exact:true}).count(),0);
   const expected=1234*(['alipay','wxpay','airwallex'].indexOf(method)+1);
   await page.waitForFunction(amount=>document.querySelector('.balance-card .amount')?.textContent.includes((amount/100).toFixed(2)),expected);
 }
 assert.equal(f.store.wallet(admin.data.user.id).balance_minor,3702);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM ledger').get().n,3);
});
