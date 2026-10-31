import { el, icon } from './dom.js';
import { state } from './state.js';
import { api, collection } from './api.js';
import { connectGuides } from './router.js';
import { notice, emptyState, panel, errorNotice, supportContact } from './ui.js';
import { field, bindForm } from './ui-form.js';
export async function connectView() {
  const query = new URLSearchParams(location.search);
  if (query.has('code')) { state.code = query.get('code').slice(0,128); history.replaceState({},'','/connect'); }
  const ticket = state.view;
  const accountId = query.get('account_id');
  const accounts = collection(await api('/api/me/accounts'),'accounts');
  if (ticket !== state.view) return;
  if (!accounts.length) {
    const lead = document.getElementById('connect-lead');
    if (lead) lead.textContent = '分配到账号之后，再安装并确认设备。';
    return panel('等待分配账号','没有账号时不能连接设备。',emptyState('请先等待账号分配','管理员分配账号后，再回到这里安装 ccb 并确认设备。在此之前不需要运行安装命令。'+supportContact(),'layers',el('a',{class:'btn',href:'/accounts',text:'返回我的账号'})));
  }
  let selected = null;
  if (accountId) {
    selected = accounts.find(account => account.id === accountId);
    if (!selected || !['available','limited'].includes(selected.state) || !/^[A-Za-z0-9_.-]+$/.test(accountId)) return panel('账号暂不可用','请返回我的账号重新选择。',el('a',{href:'/accounts',class:'btn',text:'返回我的账号'}));
  }
  const approver = state.user?.display_name || state.user?.email || '—';
  const approval = el('section',{class:'card approval-card','aria-label':'设备登录确认'});
  const layout = el('div',{class:'connect-layout'});
  let currentPreview = null;
  let timer = 0;
  const stopTimer = () => { clearInterval(timer); timer = 0; };
  const setLead = pairing => {
    if (ticket !== state.view) return;
    const lead = document.getElementById('connect-lead');
    if (lead) lead.textContent = pairing ? connectGuides.pairing : connectGuides.idle;
  };
  const place = pairing => {
    layout.classList.toggle('confirmation-first', pairing);
    layout.replaceChildren(...(pairing ? [approval, guide] : [guide, approval]));
    setLead(pairing);
  };
  const contextRow = () => el('div',{class:'approval-context'},el('span',{text:'授权用户'}),el('strong',{text:approver}));
  const warning = () => el('p',{class:'approval-warning'},icon('key'),'只确认你本人发起的请求。');
  function renderIdle() {
    stopTimer();
    currentPreview = null;
    const form = el('form',{class:'form-narrow'},field('连接码','code',{required:true,maxlength:128,value:state.code,class:'code-input',autocomplete:'off',spellcheck:'false',placeholder:'输入终端显示的连接码',hint:'打开本页不会自动授权。先核对设备，再单独确认。'}),el('button',{class:'btn primary block',type:'submit',text:'核对设备'}));
    form.querySelector('input').addEventListener('input',() => { currentPreview = null; state.code = ''; if (layout.classList.contains('confirmation-first')) place(false); });
    bindForm(form,async values => {
      stopTimer();
      currentPreview = null;
      state.code = values.get('code').trim();
      if (!state.code) throw new Error('请输入连接码。');
      return api('/api/me/devices/preview',{method:'POST',body:{code:state.code}});
    },data => {
      if (!data.device || typeof data.device !== 'object') throw new Error('服务器没有返回可核对的设备信息。');
      currentPreview = {device:data.device,code:state.code};
      renderPending(currentPreview.device, currentPreview.code);
    });
    approval.replaceChildren(el('div',{class:'approval-eyebrow'},icon('key'),el('span',{text:'设备授权'})),el('h2',{text:'确认终端连接码'}),el('p',{class:'lead',text:'运行 ccb login 后，在这里输入终端显示的连接码。'}),contextRow(),form,warning());
    place(Boolean(state.code));
  }
  function renderPending(device, code) {
    stopTimer();
    const renewal = Boolean(device.renewal);
    const remain = el('dd');
    const approve = el('button',{class:'btn primary',type:'button',text:renewal ? '确认设备续期' : '确认设备登录'});
    const back = el('button',{class:'btn',type:'button',text:'重新输入',onclick:() => { state.code = ''; renderIdle(); }});
    const tick = () => {
      if (ticket !== state.view || !remain.isConnected) { stopTimer(); return; }
      const seconds = Math.ceil((Date.parse(device.expires_at) - Date.now()) / 1000);
      const valid = Number.isFinite(seconds) && seconds > 0;
      remain.className = valid ? '' : 'expired-code';
      remain.textContent = valid ? Math.floor(seconds / 60) + ' 分 ' + String(seconds % 60).padStart(2,'0') + ' 秒' : '已过期，请在终端重新登录';
      approve.disabled = !valid || approve.dataset.busy === 'true';
    };
    timer = setInterval(tick, 1000);
    approve.addEventListener('click',async () => {
      if (approve.dataset.busy === 'true' || approve.disabled) return;
      if (!currentPreview || currentPreview.code !== code || Date.parse(device.expires_at) <= Date.now()) {
        document.getElementById('page-feedback')?.replaceChildren(notice('预览已失效','请重新输入连接码并核对设备。','warn'));
        approve.disabled = true;
        return;
      }
      approve.dataset.busy = 'true'; approve.disabled = true; back.disabled = true;
      try {
        const result = await api('/api/me/devices/approve',{method:'POST',body:{code}});
        if (ticket !== state.view) return;
        if (result.ok !== true) throw Object.assign(new Error('未收到授权确认。'),{uncertain:true});
        state.code = ''; currentPreview = null;
        renderDone(device, renewal);
      } catch (error) {
        if (ticket !== state.view) return;
        document.getElementById('page-feedback')?.replaceChildren(errorNotice(error));
        if (!error.uncertain) { approve.dataset.busy = ''; approve.disabled = Date.parse(device.expires_at) <= Date.now(); back.disabled = false; }
      }
    });
    approval.replaceChildren(
      el('div',{class:'approval-eyebrow'},icon('key'),el('span',{text:'设备授权'})),
      el('h2',{text:renewal ? '确认设备续期' : '确认设备登录'}),
      el('p',{class:'lead',text:'确认设备名称和连接码与你的终端一致。'}),
      contextRow(),
      el('div',{class:'pending-device'},el('span',{class:'device-icon'},icon('monitor')),el('div',{},el('strong',{text:device.name || '未命名设备'}),el('small',{text:device.platform || '未提供'}))),
      el('dl',{class:'device-facts'},el('dt',{text:'连接码'}),el('dd',{},el('code',{text:device.code || code})),el('dt',{text:'剩余时间'}),remain),
      el('p',{class:'fine-print',text:renewal ? '设备续期保留项目历史，不延长账号有效期；设备已过期时需要重新选择账号。' : (selected ? '确认后，终端会选择当前账号，不会抢占其他设备。' : '确认后，终端会列出你可使用的账号供你选择。')}),
      el('div',{class:'approval-actions'},back,approve),
      warning()
    );
    place(true);
    tick();
  }
  function renderDone(device, renewal) {
    stopTimer();
    approval.replaceChildren(
      el('div',{class:'approval-eyebrow'},icon('key'),el('span',{text:'设备授权'})),
      el('div',{class:'approved-mark','aria-hidden':'true',text:'✓'}),
      el('h2',{text:renewal ? '设备已续期' : '设备已登录'}),
      el('p',{class:'lead',text:renewal ? '回到终端等待续期完成。项目历史会保留；设备已过期时需要重新选择账号。' : (selected ? '回到终端等待登录完成。终端会选择当前账号，然后就可以开始项目。' : '回到终端等待登录完成，再查看并选择可用账号，开始你的项目。')}),
      el('div',{class:'approved-device'},el('small',{text:approver}),el('strong',{text:device.name || '未命名设备'})),
      commandBlock('回到项目终端','ccb'),
      el('a',{class:'btn completion-action',href:'/devices',text:'查看我的设备'})
    );
    place(true);
  }
  const steps = el('ol',{class:'connection-steps'},
    el('li',{},el('h2',{text:'安装 ccb'}),el('p',{text:'需要 Node.js 18 或更新版本。Windows、macOS 和 Linux 使用同一条命令。'}),commandBlock('安装命令','npm install -g @rimuruchan/ccb'),el('p',{class:'instruction-note'},'首次启动时 ccb 会下载官方 Claude Code；电脑上已有 ',el('code',{text:'claude'}),' 时直接使用。以后用同一条命令更新。')),
    el('li',{},el('h2',{text:'登录这台电脑'}),el('p',{text:'在需要接入的电脑上运行登录命令，浏览器会打开本页让你确认设备。'}),commandBlock('登录命令',loginCommand(selected?.id)),el('p',{class:'instruction-note',text:'浏览器没有自动打开时，在本页「确认终端连接码」中输入终端显示的连接码。登录命令使用本站公开地址；其他电脑需要能访问它。'})),
    el('li',{},el('h2',{text:'选择账号，开始项目'}),el('p',{text:'回到项目目录，运行启动命令，开始你的项目。'}),commandBlock('启动命令','ccb'),el('p',{class:'instruction-note'},'指定账号的登录命令会在确认设备后完成选择；未指定时会列出可用账号。之后用 ',el('code',{text:'ccb account'}),' 切换。')));
  const reference = el('dl',{class:'connection-reference','aria-label':'常用命令'});
  for (const [name, command] of [['继续上次会话','ccb -c'],['切换账号','ccb account'],['检查连接','ccb status'],['设备续期','ccb login --renew'],['更新 Claude Code','ccb update']]) reference.append(el('div',{},el('dt',{text:name}),el('dd',{},el('code',{text:command}))));
  const guide = el('section',{class:'connection-instructions','aria-label':'安装与登录指南'},steps,reference);
  renderIdle();
  const account = selected ? el('section',{class:'card account-context'},el('div',{class:'card-body'},el('h2',{text:selected.name || '当前账号'}),el('p',{text:'设备确认后，终端将选择此账号；这不会抢占其他设备。本站当前提供 Code。'}),el('a',{href:'/accounts',text:'返回我的账号'}))) : null;
  return el('div',{class:'connect-page'},account,layout);
}
export function loginCommand(accountId) {
  try {
    const address = new URL(String(state.public?.site?.public_origin || ''));
    if (!['http:','https:'].includes(address.protocol) || address.username || address.password || address.search || address.hash || address.pathname !== '/') return 'ccb login --gateway';
    return `ccb login --gateway ${address.origin}${accountId?' --account '+accountId+' --surface code':''}`;
  } catch { return 'ccb login --gateway'; }
}
export function commandBlock(label, command) {
  const code = el('code',{text:command});
  const status = el('span',{class:'sr-only',role:'status'});
  const button = el('button',{class:'btn small command-copy',type:'button','aria-label':`复制${label}`,text:'复制'});
  let timer = 0;
  const block = el('div',{class:'command-block'},el('div',{class:'command-label',text:label}),el('div',{class:'command-line'},el('pre',{},code),button),status);

  button.addEventListener('click', async () => {
    const value = code.textContent;
    button.disabled = true;
    let copied = false;
    try { await navigator.clipboard.writeText(value); copied = true; }
    catch { copied = false; }
    button.disabled = false;
    if (!copied) {
      status.textContent = '无法访问剪贴板，已选中命令，请手动复制。';
      const selection = getSelection(); const range = document.createRange();
      range.selectNodeContents(code); selection.removeAllRanges(); selection.addRange(range);
      return;
    }
    button.textContent = '已复制';
    status.textContent = '命令已复制';
    clearTimeout(timer);
    timer = setTimeout(() => { button.textContent = '复制'; status.textContent = ''; }, 1800);
  });
  return block;
}
