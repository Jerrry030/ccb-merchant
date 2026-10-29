import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startFixture, fixtureAccounts } from './fixture-server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

test('approved A artwork remains light, local and readable across auth pages and screen sizes', async t => {
  const fixture = await startFixture({features:{registration:true,email_verification:true,password_reset:true}});
  t.after(() => fixture.close());
  fixture.state.public.site.logo_url = '';
  fixture.state.public.site.name = 'CCB';
  const browser = await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH} : {})});
  t.after(() => browser.close());
  const context = await browser.newContext({viewport:{width:1280,height:800},colorScheme:'light',reducedMotion:'reduce'});
  const page = await context.newPage(), errors = [], external = [];
  page.setDefaultTimeout(10000);
  page.on('pageerror',error => errors.push(error.message));
  await context.route('**/*',route => {
    const url = new URL(route.request().url());
    if (url.origin !== fixture.origin) { external.push(url.origin); return route.abort(); }
    return route.continue();
  });
  await page.goto(fixture.origin + '/login');
  await page.getByRole('heading',{name:'欢迎回来',exact:true}).waitFor();
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.locator('.auth-art-copy h1').innerText(),'独家防封，\n用着不烧心。');
  assert.equal(await page.locator('.auth-art-copy p').innerText(),'一键获取独享账号 · 畅用 Claude');
  assert.equal(await page.locator('.auth-terminal').getAttribute('aria-hidden'),'true');
  assert.match(await page.locator('.auth-terminal').getAttribute('title'),/示意/);
  assert.doesNotMatch(await page.locator('.auth-terminal').innerText(),/独享|防封/);
  assert.equal(await page.getByLabel('电子邮箱',{exact:true}).getAttribute('autocomplete'),'email');
  assert.equal(await page.getByLabel('密码',{exact:true}).getAttribute('autocomplete'),'current-password');

  const asset = await page.request.get(fixture.origin + '/auth-mist-lake.webp');
  assert.equal(asset.status(),200);
  assert.equal(asset.headers()['content-type'],'image/webp');
  assert.deepEqual(await asset.body(),await readFile(new URL('../../public/auth-mist-lake.webp',import.meta.url)));
  const artwork = await page.locator('.auth-art').evaluate(async element => {
    const source = /url\(["']?([^"')]+)["']?\)/.exec(getComputedStyle(element).backgroundImage)?.[1];
    if (!source) return null;
    const image = new Image();
    image.src = source;
    await image.decode();
    return {path:new URL(source,location.href).pathname,width:image.naturalWidth,height:image.naturalHeight};
  });
  assert.equal(artwork?.path,'/auth-mist-lake.webp');
  assert.ok(artwork.width > 0 && artwork.height > 0,'the browser decodes the shipped background');

  for (const theme of ['light','dark']) {
    if (theme === 'dark') await page.getByRole('button',{name:'切换深色主题',exact:true}).click();
    for (const viewport of [{width:1280,height:800},{width:1024,height:768},{width:768,height:1024},{width:720,height:960},{width:390,height:844},{width:320,height:780}]) {
      await page.setViewportSize(viewport);
      const layout = await page.evaluate(() => {
        const art=document.querySelector('.auth-art').getBoundingClientRect();
        const copy=document.querySelector('.auth-art-copy').getBoundingClientRect();
        const terminal=document.querySelector('.auth-terminal');
        const rect=terminal.getBoundingClientRect();
        const cursor=document.querySelector('.auth-terminal-cursor');
        return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,background:getComputedStyle(terminal).backgroundColor,copyBottom:copy.bottom,terminalTop:rect.top,terminalBottom:rect.bottom,artBottom:art.bottom,terminalLeft:rect.left,terminalRight:rect.right,artLeft:art.left,artRight:art.right,cursorAnimation:getComputedStyle(cursor).animationName};
      });
      assert.ok(layout.scrollWidth <= layout.width,`${theme}/${viewport.width}: no horizontal page overflow`);
      assert.equal(layout.background,'rgb(250, 251, 248)',`${theme}/${viewport.width}: CLI stays light`);
      assert.ok(layout.copyBottom <= layout.terminalTop + 1,`${theme}/${viewport.width}: headline does not overlap CLI`);
      assert.ok(layout.terminalBottom <= layout.artBottom && layout.terminalLeft >= layout.artLeft && layout.terminalRight <= layout.artRight,`${theme}/${viewport.width}: CLI stays inside the artwork`);
      assert.equal(layout.cursorAnimation,'none','reduced-motion users get a static cursor');
      assert.equal(await page.locator('.auth-terminal-body > p:visible').count(),viewport.width <= 720 ? 3 : 8);
      assert.equal(await page.getByRole('button',{name:'登录',exact:true}).isVisible(),true);
      if (process.env.CCB_AUTH_CAPTURE_DIR && [1280,390].includes(viewport.width)) {
        await mkdir(process.env.CCB_AUTH_CAPTURE_DIR,{recursive:true});
        await page.screenshot({path:resolve(process.env.CCB_AUTH_CAPTURE_DIR,`auth-a-${theme}-${viewport.width}.png`),fullPage:true});
      }
    }
  }

  await page.setViewportSize({width:1280,height:800});
  for (const [path,title] of [['/register','创建您的账户'],['/forgot','找回您的密码'],['/verify','验证电子邮箱'],['/reset','设置新密码']]) {
    await page.goto(fixture.origin + path);
    await page.getByRole('heading',{name:title,exact:true}).waitFor();
    assert.equal(await page.locator('.auth-art-copy p').innerText(),'一键获取独享账号 · 畅用 Claude');
    assert.equal(await page.locator('.auth-terminal').evaluate(element=>getComputedStyle(element).backgroundColor),'rgb(250, 251, 248)');
    await page.getByRole('link',{name:'← 返回登录',exact:true}).click();
    await page.getByRole('heading',{name:'欢迎回来',exact:true}).waitFor();
  }
  assert.equal(fixture.state.requests.some(request=>request.method==='POST' && request.path.startsWith('/api/auth/')),false,'decorative account and device rows never make auth writes');
  await page.getByLabel('电子邮箱',{exact:true}).fill(fixtureAccounts.member.email);
  await page.getByLabel('密码',{exact:true}).fill(fixtureAccounts.member.password);
  await page.getByRole('button',{name:'登录',exact:true}).click();
  await page.getByRole('heading',{name:'首页',exact:true}).waitFor();
  assert.equal(await page.locator('.auth-art').count(),0);
  assert.deepEqual(errors,[]);
  assert.deepEqual(external,[]);
});

