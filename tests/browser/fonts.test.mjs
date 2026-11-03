import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { startFixture } from './fixture-server.mjs';

let browser;
before(async () => { browser = await chromium.launch({headless:true}); });
after(async () => { await browser?.close(); });

// Read the actual glyph fonts and pixels, not only the declared font-family.
// CDP capture deliberately does not wait for document.fonts.ready, unlike a Playwright screenshot.
async function typography(page, selector) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const {root} = await cdp.send('DOM.getDocument');
    const {nodeId} = await cdp.send('DOM.querySelector',{nodeId:root.nodeId,selector});
    const {fonts} = await cdp.send('CSS.getPlatformFontsForNode',{nodeId});
    const layout = await page.locator(selector).evaluate(element => {
      const {x,y,width,height} = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {text:element.textContent,x,y,width,height,family:style.fontFamily,size:style.fontSize,weight:style.fontWeight};
    });
    const {data} = await cdp.send('Page.captureScreenshot',{
      format:'png',clip:{x:Math.floor(layout.x),y:Math.floor(layout.y),width:Math.ceil(layout.width)+1,height:Math.ceil(layout.height)+1,scale:1},
    });
    return {layout,fonts:fonts.sort((a,b)=>a.familyName.localeCompare(b.familyName)),pixels:createHash('sha256').update(Buffer.from(data,'base64')).digest('hex')};
  } finally { await cdp.detach(); }
}

for (const [role,width,theme,path,title] of [
  ['member',1280,'light','/connect','开始使用'],
  ['admin',1280,'dark','/connect','开始使用'],
  ['member',390,'dark','/accounts','我的账号'],
  ['member',320,'light','/connect','开始使用'],
  ['admin',390,'light','/connect','开始使用'],
]) {
  test(`first paint stays stable through partial loading, refresh and navigation: ${role}/${width}/${theme}`,async t => {
    const fixture = await startFixture();
    fixture.state.public.site.logo_url = '';
    fixture.state.public.site.name = 'CCB Merchant';
    fixture.state.sessions.set('typography-test',{userId:role+'-1',csrf:'synthetic-font-test'});
    const context = await browser.newContext({viewport:{width,height:844},colorScheme:theme,reducedMotion:'reduce'});
    await context.addCookies([{name:'fixture_session',value:'typography-test',url:fixture.origin}]);
    const fontsReady = Promise.withResolvers(), dataReady = Promise.withResolvers();
    const fontRequests = [], errors = [];
    t.after(async () => { fontsReady.resolve(); dataReady.resolve(); await context.close(); await fixture.close(); });
    await context.route('**/*',async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== fixture.origin) { errors.push('external request: '+url.origin); return route.abort(); }
      if (request.resourceType() === 'font') {
        fontRequests.push(url.pathname);
        // The old implementation mixes system Songti for 始 with downloaded Noto for 开/使/用.
        if (url.pathname.includes('116-wght-normal')) await fontsReady.promise;
      }
      if (url.pathname === '/api/me/accounts') await dataReady.promise;
      return route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror',error => errors.push(error.message));
    await page.goto(fixture.origin+path,{waitUntil:'domcontentloaded'});
    await page.getByRole('heading',{name:title,level:1,exact:true}).waitFor();
    assert.equal(await page.locator('#page-content').getAttribute('aria-busy'),'true');
    const first = await typography(page,'.page-heading h1');
    assert.ok(first.fonts.length > 0,'inspect rendered glyphs before data and delayed fonts can finish');
    assert.ok(first.fonts.every(font=>!font.isCustomFont),JSON.stringify(first.fonts));
    assert.equal(first.fonts.length,1,'Chinese page titles must not mix a downloaded subset and a fallback');
    fontsReady.resolve();
    dataReady.resolve();
    await page.locator('#page-content:not([aria-busy])').waitFor();
    await page.evaluate(async () => { await document.fonts.ready; });
    assert.deepEqual(await typography(page,'.page-heading h1'),first,'late resources must not change the first painted heading');
    await page.getByRole('button',{name:'刷新',exact:true}).click();
    await page.locator('#page-content:not([aria-busy])').waitFor();
    assert.deepEqual(await typography(page,'.page-heading h1'),first,'refresh must not choose another font');
    await page.evaluate(() => { history.pushState({},'','/profile'); dispatchEvent(new PopStateEvent('popstate')); });
    await page.getByRole('heading',{name:'个人设置',exact:true}).waitFor();
    await page.goBack();
    await page.getByRole('heading',{name:title,level:1,exact:true}).waitFor();
    await page.locator('#page-content:not([aria-busy])').waitFor();
    assert.deepEqual(await typography(page,'.page-heading h1'),first,'returning to the route must preserve typography');
    await page.reload({waitUntil:'domcontentloaded'});
    await page.getByRole('heading',{name:title,level:1,exact:true}).waitFor();
    await page.locator('#page-content:not([aria-busy])').waitFor();
    assert.deepEqual(await typography(page,'.page-heading h1'),first,'a warm reload must match the cold first paint');
    assert.deepEqual(fontRequests,[],'page typography must not depend on downloaded fonts');
    assert.deepEqual(errors,[]);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth > innerWidth),false);
    if (process.env.CCB_FONT_CAPTURE_DIR) {
      await mkdir(process.env.CCB_FONT_CAPTURE_DIR,{recursive:true});
      await page.screenshot({path:resolve(process.env.CCB_FONT_CAPTURE_DIR,`fonts-${role}-${width}-${theme}.png`),fullPage:true});
    }
  });
}

test('auth pages and the standalone checkout also render without any webfont requests',async t => {
  const fixture = await startFixture({features:{registration:true,email_verification:true,password_reset:true}});
  fixture.state.public.site.logo_url = '';
  const context = await browser.newContext({viewport:{width:1280,height:844},reducedMotion:'reduce'});
  const requests = [], errors = [];
  t.after(async () => { await context.close(); await fixture.close(); });
  await context.route('**/*',async route => {
    const request=route.request(), url=new URL(request.url());
    if (url.origin !== fixture.origin) { errors.push('external request: '+url.origin); return route.abort(); }
    if (request.resourceType() === 'font') { requests.push(url.pathname); return route.abort(); }
    // Serve the shipped standalone document rather than the fixture's SPA fallback.
    if (url.pathname === '/airwallex-checkout.html') return route.fulfill({contentType:'text/html',body:await readFile(new URL('../../public/airwallex-checkout.html',import.meta.url),'utf8')});
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  for (const [path,title] of [['/login','欢迎回来'],['/register','创建一个账户'],['/forgot','找回您的密码'],['/verify','验证电子邮箱'],['/reset','设置新密码'],['/airwallex-checkout.html','Airwallex 收银台']]) {
    await page.goto(fixture.origin+path,{waitUntil:'domcontentloaded'});
    await page.getByRole('heading',{name:title,level:1,exact:true}).waitFor();
    const selector = path.endsWith('.html') ? 'h1' : '.auth-form h1';
    const first = await typography(page,selector);
    assert.ok(first.fonts.length > 0);
    assert.ok(first.fonts.every(font=>!font.isCustomFont));
    await page.waitForLoadState('networkidle');
    assert.deepEqual(await typography(page,selector),first,`${path} keeps its first painted font`);
  }
  assert.deepEqual(requests,[],'even a failing font network must not affect public pages');
  assert.deepEqual(errors,[]);
});
