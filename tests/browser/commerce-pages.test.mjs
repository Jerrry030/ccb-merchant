import { chromium } from 'playwright';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fixture, stripeFixture, password } from '../server/fixtures.js';

const root=resolve(import.meta.dirname,'../..');
async function scenario(t) {
  const stripe=stripeFixture(),f=await fixture(t,{publicDir:resolve(root,'public'),env:{STRIPE_SECRET_KEY:'sk_test_pages_fixture',STRIPE_WEBHOOK_SECRET:'whsec_test_fixture'},paymentTransport:stripe.transport});
  const admin=await f.request('POST','/api/setup',{setup_token:f.setupToken,email:'admin@example.test',password,display_name:'商户管理员'});
  await f.request('POST','/api/admin/users',{email:'buyer@example.test',password,display_name:'页面测试客户',role:'member'},admin);
  const buyer=await f.request('POST','/api/auth/login',{email:'buyer@example.test',password});
  const made=await f.request('POST','/api/admin/plans',{name:'7 天体验',description:'',resource_id:'resource-1',duration_days:7,amount_minor:300,status:'active'},admin);
  assert.equal(made.status,201,made.raw);
  await f.request('POST','/api/me/payments',{amount_minor:1000},buyer);
  const session=[...stripe.sessions.values()][0];session.status='complete';session.payment_status='paid';
  const event=stripe.event(session.id);await f.request('POST','/api/webhooks/stripe',event.payload,{headers:{'Stripe-Signature':event.signature}});
  const browser=await chromium.launch({headless:true}),context=await browser.newContext({viewport:{width:1440,height:1050},reducedMotion:'reduce'}),page=await context.newPage();
  const errors=[],external=[],requests=[];page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{const url=new URL(request.url());if(url.pathname.startsWith('/api/'))requests.push({path:url.pathname,query:url.search,method:request.method()});});
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==f.config.publicOrigin){external.push(route.request().url());return route.abort();}return route.continue();});
  t.after(async()=>{await browser.close();assert.deepEqual(errors,[]);assert.deepEqual(external,[]);});
  await page.goto(f.config.publicOrigin+'/login');await page.getByLabel('电子邮箱',{exact:true}).fill('buyer@example.test');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('heading',{name:'首页',exact:true}).waitFor();
  return {f,admin,buyer,plan:made.data.plan,context,page,requests};
}

test('catalog, orders and wallet have distinct ownership, responsive navigation, and admin destinations',async t=>{
  const {f,context,page,requests}=await scenario(t);
  const nav=page.getByRole('navigation',{name:'主导航'});
  for(const name of ['购买套餐','我的订单','钱包'])assert.equal(await nav.getByRole('link',{name,exact:true}).count(),1);
  assert.equal(await nav.getByRole('link',{name:'套餐管理',exact:true}).count(),0);
  let start=requests.length;
  await page.goto(f.config.publicOrigin+'/plans');await page.getByRole('link',{name:'选择套餐',exact:true}).waitFor();
  assert.equal(await page.getByLabel('付款方式',{exact:true}).count(),0);assert.equal(await page.getByLabel('充值金额（人民币元）',{exact:true}).count(),0);
  assert.equal(requests.slice(start).some(request=>request.path==='/api/me/wallet'),false,'catalog does not load wallet or payment history');
  const before=f.store.db.prepare('SELECT count(*) n FROM rentals').get().n;
  await page.getByRole('link',{name:'选择套餐',exact:true}).click();await page.getByRole('heading',{name:'确认订单',exact:true}).waitFor();
  assert.equal(await page.getByLabel('付款方式',{exact:true}).inputValue(),'wallet');assert.equal(f.store.db.prepare('SELECT count(*) n FROM rentals').get().n,before);
  start=requests.length;
  await page.goto(f.config.publicOrigin+'/wallet');await page.getByRole('heading',{name:'余额流水',exact:true}).waitFor();
  assert.equal(await page.getByLabel('充值金额（人民币元）',{exact:true}).count(),0);assert.equal(await page.getByRole('link',{name:'选择套餐',exact:true}).count(),0);
  assert.equal(requests.slice(start).some(request=>request.path==='/api/plans'),false,'wallet does not depend on catalog availability');
  await page.getByRole('link',{name:'充值',exact:true}).click();await page.getByRole('heading',{name:'余额充值',exact:true}).first().waitFor();
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM orders').get().n,1,'opening recharge never creates an order');
  const artifacts=resolve(root,'tests/browser/artifacts');await mkdir(artifacts,{recursive:true});
  for(const width of [1440,1100,390,320])for(const theme of ['light','dark'])for(const [path,name]of [['/plans','购买套餐'],['/orders','我的订单'],['/wallet','钱包']]){
    await page.setViewportSize({width,height:1050});await page.goto(f.config.publicOrigin+path);await page.getByRole('heading',{name,exact:true}).waitFor();await page.locator('#page-content:not([aria-busy])').waitFor();
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await page.evaluate(()=>document.fonts.ready);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,path+' '+width+' '+theme);
    if(width===1440&&theme==='light')await page.screenshot({path:resolve(artifacts,'commerce-'+path.slice(1)+'-desktop.png'),fullPage:true});
  }
  await page.setViewportSize({width:390,height:844});await page.goto(f.config.publicOrigin+'/wallet');await page.getByRole('heading',{name:'钱包',exact:true}).waitFor();
  await page.getByRole('button',{name:'购买与账单',exact:true}).click();await nav.getByRole('link',{name:'购买套餐',exact:true}).click();await page.getByRole('heading',{name:'购买套餐',exact:true}).waitFor();
  await page.screenshot({path:resolve(artifacts,'commerce-plans-mobile.png'),fullPage:true});
  await context.route('**/api/plans',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'core_unavailable',message:'Catalog unavailable'}})}));
  await page.goto(f.config.publicOrigin+'/wallet');await page.getByRole('heading',{name:'余额流水',exact:true}).waitFor();
  await page.goto(f.config.publicOrigin+'/plans');await page.getByText('数据暂不可用',{exact:true}).waitFor();assert.equal(await page.getByText('暂无在售套餐',{exact:true}).count(),0);
  await context.unroute('**/api/plans');await page.setViewportSize({width:1440,height:1050});
  await page.getByRole('button',{name:'退出登录',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'退出登录',exact:true}).click();
  await page.getByLabel('电子邮箱',{exact:true}).fill('admin@example.test');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.locator('.sidebar').waitFor();
  for(const name of ['套餐管理','订单管理','支付记录']){await nav.getByRole('link',{name,exact:true}).click();await page.getByRole('heading',{name,exact:true}).waitFor();assert.equal(await page.getByRole('navigation',{name:'订单分区'}).count(),0);}
});

test('a lost purchase response recovers the original request after reload without a second debit or new price',async t=>{
  const {f,admin,buyer,plan,context,page,requests}=await scenario(t);
  await context.route('**/api/me/rentals',async route=>{if(route.request().method()==='POST'){const response=await route.fetch();assert.equal(response.status(),201);return route.abort('failed');}return route.continue();});
  await page.goto(f.config.publicOrigin+'/checkout?plan='+plan.id);await page.getByRole('button',{name:'确认购买',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'确认下单',exact:true}).click();
  await page.getByText('操作结果尚未确认',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'确认购买',exact:true}).isDisabled(),true);
  const key=new URL(page.url()).searchParams.get('request_id');assert.ok(key);assert.equal(new URL(page.url()).searchParams.get('submitted'),'1');
  const rental=f.store.db.prepare('SELECT * FROM rentals WHERE request_id=?').get(key);assert.equal(rental.status,'fulfilled');assert.equal(f.store.wallet(buyer.data.user.id).balance_minor,700);
  const changed=await f.request('PATCH','/api/admin/plans/'+plan.id,{name:'Changed price',description:'',duration_days:7,amount_minor:400,status:'active',expected_revision:plan.revision},admin);assert.equal(changed.status,200,changed.raw);
  await page.reload();await page.getByRole('heading',{name:'套餐订单详情',exact:true}).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('rental'),rental.id);assert.equal(await page.getByText('¥3.00 / 7 天',{exact:true}).count(),1);assert.equal((await page.locator('.rental-detail').innerText()).includes('版本'),false);assert.equal(rental.plan_revision,1);
  assert.equal(requests.filter(request=>request.path==='/api/me/rentals'&&request.method==='POST').length,1);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM rentals').get().n,1);assert.equal(f.store.db.prepare("SELECT count(*) n FROM ledger WHERE kind='rental_debit'").get().n,1);
  const id=rental.id;await page.goto(f.config.publicOrigin+'/orders?rental='+id);await page.getByRole('heading',{name:'套餐订单详情',exact:true}).waitFor();
});

test('lost recharge acknowledgement stays pending across reload and return flags cannot credit money',async t=>{
  const {f,context,page,requests}=await scenario(t);
  await context.route('**/api/me/payments',async route=>{if(route.request().method()==='POST'){const response=await route.fetch();assert.equal(response.status(),201);return route.abort('failed');}return route.continue();});
  await page.goto(f.config.publicOrigin+'/checkout?recharge=1');await page.getByLabel('充值金额（人民币元）',{exact:true}).fill('12.34');await page.getByRole('button',{name:'前往支付',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'创建订单',exact:true}).click();
  await page.getByText('操作结果尚未确认',{exact:true}).waitFor();await page.reload();await page.getByText('订单结果待核对',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('充值金额（人民币元）',{exact:true}).count(),0);assert.equal(requests.filter(request=>request.path==='/api/me/payments'&&request.method==='POST').length,1);
  await page.getByRole('link',{name:'查看充值订单',exact:true}).click();await page.getByRole('row').filter({hasText:'¥12.34'}).waitFor();
  const pending=f.store.db.prepare("SELECT * FROM orders WHERE status='pending'").get();assert.ok(pending);
  await page.goto(f.config.publicOrigin+'/wallet?order='+pending.id+'&success=true');await page.getByRole('heading',{name:'收银台',exact:true}).waitFor();
  assert.equal(new URL(page.url()).pathname,'/checkout');assert.equal(new URL(page.url()).searchParams.has('success'),false);
  assert.equal(f.store.db.prepare('SELECT status FROM orders WHERE id=?').get(pending.id).status,'pending');assert.equal(f.store.db.prepare('SELECT count(*) n FROM ledger').get().n,1);
});

test('unknown balance never becomes zero and pausing recharge does not remove online plan payment',async t=>{
  const {f,admin,plan,context,page}=await scenario(t);
  await context.route('**/api/me/wallet',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'wallet_unavailable',message:'Wallet unavailable'}})}));
  await page.goto(f.config.publicOrigin+'/checkout?plan='+plan.id);await page.getByRole('heading',{name:'确认订单',exact:true}).waitFor();
  assert.equal(await page.getByLabel('付款方式',{exact:true}).inputValue(),'stripe');
  const wallet=page.getByLabel('付款方式',{exact:true}).locator('option[value=wallet]');assert.equal(await wallet.evaluate(node=>node.disabled),true);assert.equal(await wallet.innerText(),'钱包余额暂不可用');
  const changed=await f.request('PATCH','/api/admin/payment',{expected_revision:1,recharge_enabled:false},admin);assert.equal(changed.status,200,changed.raw);
  await page.reload();await page.getByRole('heading',{name:'确认订单',exact:true}).waitFor();assert.equal(await page.getByLabel('付款方式',{exact:true}).inputValue(),'stripe');assert.equal(await page.getByRole('button',{name:'确认购买',exact:true}).isDisabled(),false);
  await context.unroute('**/api/me/wallet');await page.goto(f.config.publicOrigin+'/wallet');await page.getByRole('heading',{name:'钱包',exact:true}).waitFor();assert.equal(await page.getByRole('link',{name:'充值',exact:true}).count(),0);
  await page.goto(f.config.publicOrigin+'/checkout?recharge=1');await page.getByLabel('充值金额（人民币元）',{exact:true}).waitFor();assert.equal(await page.getByLabel('充值金额（人民币元）',{exact:true}).isDisabled(),true);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM rentals').get().n,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM orders').get().n,1);
});
