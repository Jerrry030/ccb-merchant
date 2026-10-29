import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startFixture, fixtureAccounts } from './fixture-server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

for (const custom of [false, true]) {
  test(custom ? 'an explicitly configured logo still overrides the bundled portal' : 'portal SVG is shared by login, navigation and favicon in light and dark layouts', async t => {
    const fixture = await startFixture();
    t.after(() => fixture.close());
    fixture.state.public.site.logo_url = custom ? fixture.origin + '/custom-brand.svg' : '';
    const browser = await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH} : {})});
    t.after(() => browser.close());
    const context = await browser.newContext({viewport:{width:1440,height:960},colorScheme:'light',reducedMotion:'reduce'});
    const page = await context.newPage(), errors = [], external = [];
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== fixture.origin) { external.push(url.origin); return route.abort(); }
      if (url.pathname === '/custom-brand.svg') return route.fulfill({status:200,contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" fill="#984956"/></svg>'});
      return route.continue();
    });
    await page.goto(fixture.origin + '/login');
    const logo = page.locator('.brand-logo');
    await logo.waitFor({state:'visible'});
    await page.waitForFunction(() => { const img=document.querySelector('.brand-logo'); return img?.complete && img.naturalWidth>0; });
    assert.equal(await logo.getAttribute('src'), custom ? fixture.origin + '/custom-brand.svg' : '/mark.svg');
    assert.equal(await logo.getAttribute('alt'), '');
    assert.equal(await page.locator('.brand-mark .icon').count(),0);
    assert.equal(await page.locator('link[rel="icon"]').getAttribute('href'),'/mark.svg');
    assert.equal(await page.locator('.brand-mark-custom').count(),custom ? 1 : 0);
    if (!custom) {
      const response = await page.request.get(fixture.origin + '/mark.svg');
      assert.equal(response.status(),200);
      assert.match(response.headers()['content-type'],/image\/svg\+xml/);
      const svg = await response.text();
      assert.equal(svg,await readFile(new URL('../../public/mark.svg',import.meta.url),'utf8'));
      assert.match(svg,/fill="#254f52"/);
      assert.doesNotMatch(svg,/<(?:image|script)\b|data:image|#7755e8/);
      if (process.env.CCB_BRAND_CAPTURE_DIR) {
        await mkdir(process.env.CCB_BRAND_CAPTURE_DIR,{recursive:true});
        await page.screenshot({path:resolve(process.env.CCB_BRAND_CAPTURE_DIR,'login-portal.png'),fullPage:true});
      }
    }
    await page.getByLabel('电子邮箱',{exact:true}).fill(fixtureAccounts.admin.email);
    await page.getByLabel('密码',{exact:true}).fill(fixtureAccounts.admin.password);
    await page.getByRole('button',{name:'登录',exact:true}).click();
    await page.locator('.sidebar .brand-logo').waitFor({state:'visible'});
    assert.equal(await page.locator('.sidebar .brand-logo').getAttribute('src'),custom ? fixture.origin+'/custom-brand.svg' : '/mark.svg');
    if (!custom) {
      assert.equal(await page.locator('.brand-mark').evaluate(el => getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)');
      if (process.env.CCB_BRAND_CAPTURE_DIR) await page.screenshot({path:resolve(process.env.CCB_BRAND_CAPTURE_DIR,'sidebar-portal-light.png'),fullPage:true});
      await page.getByRole('button',{name:'切换深色主题',exact:true}).click();
      assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
      assert.equal(await logo.evaluate(img=>img.complete&&img.naturalWidth>0),true);
      if (process.env.CCB_BRAND_CAPTURE_DIR) await page.screenshot({path:resolve(process.env.CCB_BRAND_CAPTURE_DIR,'sidebar-portal-dark.png'),fullPage:true});
      await page.setViewportSize({width:390,height:844});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    }
    assert.deepEqual(errors,[]);
    assert.deepEqual(external,[]);
  });
}
