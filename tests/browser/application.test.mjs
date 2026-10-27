// Runs the shipped browser UI against the actual Node/SQLite application.
// Core, mail and payment credentials are intentionally absent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, realpath } from 'node:fs/promises';
import { dirname, resolve, join, relative, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { createMerchant } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';

const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const project=resolve(dirname(fileURLToPath(import.meta.url)),'../..');

test('shipped UI works with real setup, sessions, customer CRUD and unconfigured services',async t=>{
  const data=await mkdtemp(join(tmpdir(),'ccb-browser-app-'));
  const config=loadConfig({DATA_DIR:data},project);
  const failures=[],outbound=[];
  const app=createMerchant(config,{reconcileIntervalMs:0,onError:message=>failures.push(message)});
  let browser;
  t.after(async()=>{
    await browser?.close();
    app.server.closeAllConnections();
    await new Promise(resolve=>app.server.close(resolve));
    app.store.db.close();
    const actual=await realpath(data), inside=relative(await realpath(tmpdir()),actual);
    if(inside.startsWith('..')||isAbsolute(inside)||!basename(actual).startsWith('ccb-browser-app-')) throw new Error('Unexpected isolated browser data directory');
    await rm(actual,{recursive:true,force:true});
  });
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  config.port=app.server.address().port;
  config.publicOrigin=`http://127.0.0.1:${config.port}`;
  config.publicHost=`127.0.0.1:${config.port}`;
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{})});
  const context=await browser.newContext({viewport:{width:1280,height:960},reducedMotion:'reduce'});
  await context.route('**/*',route=>{
    if(new URL(route.request().url()).origin!==config.publicOrigin){outbound.push(route.request().url());return route.abort();}
    return route.continue();
  });
  const page=await context.newPage();
  page.on('pageerror',error=>failures.push(error.message));
  page.setDefaultTimeout(10000);
  await page.goto(config.publicOrigin+'/');
  await page.getByRole('heading',{name:'初始化工作台',exact:true}).waitFor();
  await page.getByLabel('初始化令牌',{exact:true}).fill((await readFile(app.store.setupFile,'utf8')).trim());
  await page.getByLabel('显示名称',{exact:true}).fill('本地应用测试管理员');
  await page.getByLabel('电子邮箱',{exact:true}).fill('admin@example.test');
  await page.getByLabel('密码',{exact:true}).fill('Browser-only test password!');
  await page.getByLabel('确认密码',{exact:true}).fill('Browser-only test password!');
  await page.getByRole('button',{name:'创建管理员',exact:true}).click();
  await page.getByRole('button',{name:'确认初始化',exact:true}).click();
  await page.getByRole('heading',{name:'上游接入',exact:true}).waitFor();
  await page.getByRole('link',{name:'稍后配置，返回工作台',exact:true}).click();
  await page.getByRole('heading',{name:'首页',exact:true}).waitFor();
  assert.equal(app.store.db.prepare("SELECT count(*) AS n FROM users WHERE role='admin'").get().n,1);
  assert.equal(await page.getByRole('link',{name:'客户管理',exact:true}).count(),1);

  await page.getByRole('link',{name:'客户管理',exact:true}).click();
  await page.getByRole('button',{name:'创建客户',exact:true}).click();
  await page.getByLabel('电子邮箱',{exact:true}).fill('member@example.test');
  await page.getByLabel('初始密码',{exact:true}).fill('Member-browser test password!');
  await page.getByLabel('显示名称',{exact:true}).fill('本地应用测试客户');
  await page.getByRole('button',{name:'创建客户账户',exact:true}).click();

  await page.getByRole('row').filter({hasText:'member@example.test'}).waitFor();
  const member=app.store.db.prepare('SELECT * FROM users WHERE email=?').get('member@example.test');
  assert.equal(member.role,'member');assert.equal(member.core_customer_id,null);
  await page.reload();
  await page.getByRole('row').filter({hasText:'member@example.test'}).waitFor();
  await page.getByRole('button',{name:'退出登录',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'退出登录',exact:true}).click();
  await page.getByRole('heading',{name:'欢迎回来',exact:true}).waitFor();
  await page.getByLabel('电子邮箱',{exact:true}).fill('member@example.test');
  await page.getByLabel('密码',{exact:true}).fill('Member-browser test password!');
  await page.getByRole('button',{name:'登录工作台',exact:true}).click();
  await page.getByRole('heading',{name:'首页',exact:true}).waitFor();
  assert.equal(await page.getByRole('link',{name:'客户管理',exact:true}).count(),0);
  await page.goto(config.publicOrigin+'/wallet');
  await page.getByText('支付服务尚未配置',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'在线支付未启用',exact:true}).isDisabled(),true);
  assert.equal(app.store.db.prepare('SELECT count(*) AS n FROM orders').get().n,0);
  const adminRead=await page.request.get(config.publicOrigin+'/api/admin/users');
  assert.equal(adminRead.status(),403);
  assert.deepEqual(failures,[]);assert.deepEqual(outbound,[]);
});
