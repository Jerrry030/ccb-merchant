import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir} from 'node:fs/promises';
import {fixture,password} from '../server/fixtures.js';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright'),root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');

test('personal device cards and global staff devices expose navigation, truthful status and scoped controls',async t=>{
 const deviceSets=new Map();let failingCustomer='';
 const f=await fixture(t,{publicDir:resolve(root,'public'),onCore:({req,url,body,state,json})=>{
  const m=url.pathname.match(/^\/access\/v1\/customers\/([^/]+)\/devices(?:\/([^/]+)(\/selection)?)?$/);if(!m)return false;
  if(req.method==='GET'&&!m[2]){if(m[1]===failingCustomer){json({code:'unavailable'},503);return true;}json({devices:deviceSets.get(m[1])||[]});return true;}
  const d=deviceSets.get(m[1])?.find(device=>device.id===m[2]);if(!d){json({code:'not_found'},404);return true;}
  if(req.method==='PATCH'){if(body.expected_name!==d.name){json({code:'device_stale'},409);return true;}d.name=body.name;}
  else if(req.method==='PUT'){
   if(body.expected_selection_version!==d.selection_version){json({code:'device_stale'},409);return true;}
   if(body.grant_id&&!state.grants.some(g=>g.id===body.grant_id&&g.customer_id===m[1]&&g.status==='active')){json({code:'grant_unavailable'},403);return true;}
   d.current_grant_id=body.grant_id;d.selection_version++;
  }else if(req.method==='DELETE'){d.state='revoked';d.current_grant_id=null;json({ok:true});return true;}
  json({device:d});return true;
 }});
 const admin=await f.request('POST','/api/setup',{setup_token:f.setupToken,email:'admin@example.test',password,display_name:'管理员'}),users=[];
 for(const [index,name] of ['客户甲','客户乙'].entries()){
  const created=await f.request('POST','/api/admin/users',{email:'device-user-'+index+'@example.test',password,display_name:name,role:'member'},admin);assert.equal(created.status,201,created.raw);
  const assigned=await f.request('POST','/api/admin/grants',{user_id:created.data.user.id,resource_id:'resource-1',account_lease_id:'owned-'+(index+1),expected_account_revision:1,expires_at:new Date(Date.now()+86400000).toISOString()},admin);assert.equal(assigned.status,201,assigned.raw);
  users.push({...created.data.user,grant:assigned.data.grant,core:f.store.db.prepare('SELECT core_customer_id FROM users WHERE id=?').get(created.data.user.id).core_customer_id});
 }
 const staff=await f.request('POST','/api/admin/users',{email:'audit@example.test',password,display_name:'只读管理员',role:'admin',management_profile:'observer'},admin);assert.equal(staff.status,201,staff.raw);
 const future=new Date(Date.now()+2*86400000).toISOString();
 deviceSets.set(users[0].core,[{id:'shared-device',name:'甲的办公电脑',platform:'Windows/x64',state:'approved',selection_version:1,current_grant_id:users[0].grant.id,last_seen:new Date(Date.now()-3600000).toISOString(),expires_at:future,token:'LEAK'},
  {id:'expired',name:'旧设备待重新登录',platform:'macOS/arm64',state:'approved',expires_at:'2001-01-01T00:00:00Z'},
  {id:'revoked',name:'已撤销设备',platform:'Linux/x64',state:'revoked'},
  {id:'unknown',name:'资料不完整的设备',state:'unrecognized'}]);
 deviceSets.set(users[1].core,[{id:'shared-device',name:'乙的办公电脑',platform:'macOS/arm64',state:'approved',selection_version:2,current_grant_id:users[1].grant.id,expires_at:future}]);
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{})}),faults=[],external=[];t.after(async()=>{await browser.close();assert.deepEqual(faults,[]);assert.deepEqual(external,[]);});
 const pages=[];
 for(const email of [users[0].email,'admin@example.test','audit@example.test']){
  const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),page=await context.newPage();pages.push(page);page.setDefaultTimeout(12000);page.on('pageerror',e=>faults.push(e.message));
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin===f.config.publicOrigin)return route.continue();external.push(route.request().url());return route.abort();});
  await page.goto(f.config.publicOrigin+'/login');await page.getByLabel('电子邮箱',{exact:true}).fill(email);await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.locator('.shell').waitFor();
 }
 const [member,owner,observer]=pages,artifacts=resolve(root,'tests/browser/artifacts');await mkdir(artifacts,{recursive:true});
 await member.getByRole('navigation',{name:'主导航'}).getByRole('link',{name:'我的设备',exact:true}).click();await member.getByRole('heading',{name:'甲的办公电脑',exact:true}).waitFor();
 assert.equal(await member.locator('.device-card').count(),4);assert.equal(await member.getByRole('navigation',{name:'主导航'}).getByRole('link',{name:'我的设备',exact:true}).getAttribute('aria-current'),'page');
 const own=member.locator('.device-card[data-device-id="shared-device"]');await own.getByText(users[0].grant.name,{exact:true}).waitFor();await own.getByText('已授权',{exact:true}).waitFor();
 const expired=member.locator('.device-card[data-device-id="expired"]');await expired.getByText('已到期',{exact:true}).waitFor();assert.equal(await expired.getByRole('button',{name:'管理绑定'}).isDisabled(),true);
 assert.equal(await member.locator('.device-card[data-device-id="revoked"]').getByRole('button',{name:'撤销连接'}).isDisabled(),true);await member.locator('.device-card[data-device-id="unknown"]').getByText('状态未知',{exact:true}).waitFor();
 assert.doesNotMatch(await member.locator('.device-grid').innerText(),/在线|离线|30 天|Desktop|LEAK|客户乙/);
 for(const [width,theme] of [[1440,'light'],[1440,'dark'],[1100,'dark'],[1001,'light'],[900,'light'],[390,'light'],[320,'dark']]){
  await member.setViewportSize({width,height:1000});await member.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  assert.equal(await member.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  const links=await member.getByRole('navigation',{name:'主导航'}).locator('a').evaluateAll(items=>items.map(item=>({top:item.getBoundingClientRect().top,bottom:item.getBoundingClientRect().bottom})));
  assert.equal(links.length,7);if(width<=1000)assert.ok(Math.max(...links.map(l=>l.top))-Math.min(...links.map(l=>l.top))<1,'mobile navigation stays on a single horizontally scrollable row');
  await member.screenshot({path:resolve(artifacts,`personal-devices-${width}-${theme}.png`),fullPage:true});
 }
 await member.setViewportSize({width:1440,height:1000});await own.getByRole('button',{name:'管理绑定'}).click();const ownDialog=member.getByRole('dialog',{name:'设备绑定管理'});await ownDialog.getByLabel('设备名称',{exact:true}).fill('甲的新电脑名');await ownDialog.getByRole('button',{name:'保存名称'}).click();await ownDialog.getByText('已保存',{exact:true}).waitFor();assert.equal(deviceSets.get(users[0].core)[0].name,'甲的新电脑名');await member.keyboard.press('Escape');
 await member.getByRole('link',{name:'连接设备',exact:true}).click();await member.getByRole('heading',{name:'开始使用',exact:true}).waitFor();
 assert.equal(f.state.requests.some(r=>r.method==='POST'&&r.path.endsWith('/devices/approve')),false);
 await owner.getByRole('navigation',{name:'主导航'}).getByRole('link',{name:'设备',exact:true}).click();await owner.getByRole('heading',{name:'全部客户设备',exact:true}).waitFor();
 assert.equal(await owner.locator('.devices-page tbody tr').count(),5);assert.equal(await owner.getByRole('navigation',{name:'主导航'}).getByRole('link',{name:'设备',exact:true}).getAttribute('aria-current'),'page');
 const bob=owner.getByRole('row').filter({hasText:'乙的办公电脑'});await bob.getByRole('button',{name:'管理绑定'}).click();const dialog=owner.getByRole('dialog',{name:'设备绑定管理'});await dialog.waitFor();const choices=await dialog.getByLabel('Code 账号',{exact:true}).locator('option').allTextContents();assert.ok(choices.includes(users[1].grant.name));assert.ok(!choices.includes(users[0].grant.name));
 await dialog.getByLabel('Code 账号',{exact:true}).selectOption('');await dialog.getByRole('button',{name:'保存账号选择'}).click();await dialog.getByText('已保存',{exact:true}).waitFor();assert.equal(deviceSets.get(users[1].core)[0].current_grant_id,null);assert.equal(deviceSets.get(users[0].core)[0].current_grant_id,users[0].grant.id);await owner.keyboard.press('Escape');
 await owner.getByLabel('搜索设备或客户',{exact:true}).fill('客户乙');await owner.getByRole('button',{name:'筛选设备'}).click();await owner.getByText('共 1 台 · 本页 1 台',{exact:true}).waitFor();assert.equal(await owner.getByText('甲的新电脑名',{exact:true}).count(),0);
 await owner.getByRole('link',{name:'清除筛选',exact:true}).click();await owner.getByText('共 5 台 · 本页 5 台',{exact:true}).waitFor();
 await owner.getByLabel('设备授权状态',{exact:true}).selectOption('expired');await owner.getByRole('button',{name:'筛选设备'}).click();await owner.getByText('旧设备待重新登录',{exact:true}).waitFor();assert.equal(await owner.locator('.devices-page tbody tr').count(),1);
 await owner.goto(f.config.publicOrigin+'/admin/devices?limit=2');await owner.getByText('共 5 台 · 本页 2 台',{exact:true}).waitFor();await owner.getByRole('button',{name:'下一页设备'}).click();await owner.waitForURL('**/admin/devices?limit=2&offset=2');await owner.getByText('共 5 台 · 本页 2 台',{exact:true}).waitFor();
 await owner.goto(f.config.publicOrigin+'/admin/devices');await owner.getByRole('heading',{name:'全部客户设备',exact:true}).waitFor();
 for(const [width,theme] of [[1440,'light'],[390,'dark']]){await owner.setViewportSize({width,height:1000});await owner.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);assert.equal(await owner.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);await owner.screenshot({path:resolve(artifacts,`global-devices-${width}-${theme}.png`),fullPage:true});}
 await owner.setViewportSize({width:1440,height:1000});await bob.getByRole('button',{name:'撤销连接'}).click();await owner.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();assert.equal(deviceSets.get(users[1].core)[0].state,'approved');
 await bob.getByRole('button',{name:'撤销连接'}).click();await owner.getByRole('dialog').getByRole('button',{name:'撤销连接',exact:true}).click();await bob.getByText('已撤销',{exact:true}).waitFor();assert.equal(deviceSets.get(users[0].core)[0].state,'approved');
 await bob.getByRole('link',{name:'客户乙',exact:true}).click();await owner.getByRole('heading',{name:'客户乙',exact:true}).waitFor();assert.equal(new URL(owner.url()).searchParams.get('user_id'),users[1].id);await owner.getByRole('link',{name:'查看全部客户设备',exact:true}).click();await owner.getByRole('heading',{name:'全部客户设备',exact:true}).waitFor();
 failingCustomer=users[1].core;await owner.getByRole('button',{name:'刷新',exact:true}).click();await owner.getByText('设备列表未读取完整',{exact:true}).waitFor();assert.equal(await owner.getByText('乙的办公电脑',{exact:true}).count(),0);assert.equal(await owner.getByText('甲的新电脑名',{exact:true}).count(),1);failingCustomer='';
 await observer.getByRole('navigation',{name:'主导航'}).getByRole('link',{name:'设备',exact:true}).click();await observer.getByRole('heading',{name:'全部客户设备',exact:true}).waitFor();for(const button of await observer.getByRole('button',{name:/^(管理绑定|撤销连接)$/}).all())assert.equal(await button.isDisabled(),true);
});
