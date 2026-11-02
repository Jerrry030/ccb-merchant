import { el, icon } from './dom.js';
import { state } from './state.js';
import { api, collection } from './api.js';
import { connectGuides } from './router.js';
import { desktopTargets, parseDesktopRelease } from './desktop-releases.js';
import { notice, emptyState, panel, errorNotice, supportContact } from './ui.js';
import { field, bindForm } from './ui-form.js';
export async function connectView() {
  const query = new URLSearchParams(location.search);
  if (query.has('code')) { state.code = query.get('code').slice(0,128); history.replaceState({},'','/connect'); }
  const ticket = state.view;
  const accountId = query.get('account_id');
  const downloads = await desktopDownloadPanel();
  let accounts;
  try { accounts = collection(await api('/api/me/accounts'),'accounts'); }
  catch (error) { if (ticket !== state.view) return; return el('div',{class:'connect-page'},downloads,errorNotice(error)); }
  if (ticket !== state.view) return;
  if (!accounts.length) {
    const lead = document.getElementById('connect-lead');
    if (lead) lead.textContent = '分配到账号之后，再安装并确认设备。';
    return el('div',{class:'connect-page'},downloads,panel('等待分配账号','没有账号时不能连接设备。',emptyState('请先等待账号分配','管理员分配账号后，再回到这里安装客户端并确认设备。在此之前不需要运行安装命令。'+supportContact(),'layers',el('a',{class:'btn',href:'/accounts',text:'返回我的账号'}))));
  }
  let selected = null;
  if (accountId) {
    selected = accounts.find(account => account.id === accountId);
    if (!selected || !['available','limited'].includes(selected.state) || !/^[A-Za-z0-9_.-]+$/.test(accountId)) return panel('账号暂不可用','请返回我的账号重新选择。',el('a',{href:'/accounts',class:'btn',text:'返回我的账号'}));
  }
  const executables = { windows: '& "$env:LOCALAPPDATA\\Programs\\Anthropic-ccb\\resources\\bin\\ccb.exe"', mac: '"/Applications/Anthropic-ccb.app/Contents/Resources/bin/ccb"', linux: './resources/bin/ccb' };
  const operatingSystem = /Win/i.test(navigator.platform) ? 'windows' : /Mac/i.test(navigator.platform) ? 'mac' : 'linux';
  let executable = executables[operatingSystem];
  const platformSelect = el('select',{id:'client-command-system','aria-label':'电脑系统',value:operatingSystem},el('option',{value:'windows',text:'Windows · PowerShell'}),el('option',{value:'mac',text:'macOS · 终端'}),el('option',{value:'linux',text:'Linux · 终端'}));
  platformSelect.value=operatingSystem;
  const platformControl=el('div',{class:'client-command-controls'},el('label',{for:'client-command-system',text:'电脑系统'}),platformSelect,el('span',{text:'使用客户端内置 CCB。Windows 按默认安装目录；macOS 请先移到“应用程序”；Linux 请先进入解压目录。自定义路径需相应替换。'}));
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
      commandBlock('检查连接',executable+' status'),
      el('a',{class:'btn completion-action',href:'/devices',text:'查看我的设备'})
    );
    place(true);
  }
  const commands=[commandBlock('初始化命令',executable+' update'),commandBlock('登录命令',loginCommand(selected?.id,executable)),commandBlock('选择账号命令',executable+' account')];
  const steps = el('ol',{class:'connection-steps'},
    el('li',{},el('h2',{text:'安装客户端'}),el('p',{text:'下载上方对应系统的客户端并安装或解压，然后用内置 CCB 准备运行时，无需安装旧版 npm CLI。'}),commands[0],el('p',{class:'instruction-note',text:'该命令下载并校验 Claude Code 运行时，不发起模型请求。客户端内置 CCB 随客户端一起更新，不覆盖系统中其他 CLI。'})),
    el('li',{},el('h2',{text:'登录这台电脑'}),el('p',{text:'在需要接入的电脑上运行登录命令，浏览器会打开本页让你确认设备。'}),commands[1],el('p',{class:'instruction-note',text:'浏览器没有自动打开时，在本页“确认终端连接码”中输入终端显示的连接码。登录命令使用本站公开地址。'})),
    el('li',{},el('h2',{text:'选择账号，开始项目'}),el('p',{text:'首次选择可用账号后，打开客户端并选择项目文件夹；不需要另外保持一个终端会话运行。'}),commands[2],el('p',{class:'instruction-note',text:'指定账号的登录命令会在确认设备后完成选择。后续请使用客户端账号菜单切号；存在其他活动会话或未知进程时，会保守暂停。'})));
  const reference = el('dl',{class:'connection-reference','aria-label':'常用命令'});
  const references=[['检查连接','status'],['设备续期','login --renew'],['更新 Claude Code','update']];
  for (const [name,args] of references)reference.append(el('div',{},el('dt',{text:name}),el('dd',{},el('code',{text:executable+' '+args}))));
  platformSelect.addEventListener('change',()=>{
    executable=executables[platformSelect.value];
    if(!executable)return;
    const values=[executable+' update',loginCommand(selected?.id,executable),executable+' account'];
    commands.forEach((block,index)=>{block.querySelector('code').textContent=values[index];block.querySelector('.command-copy').textContent='复制';});
    reference.querySelectorAll('code').forEach((code,index)=>{code.textContent=executable+' '+references[index][1];});
  });
  const guide = el('section',{class:'connection-instructions','aria-label':'安装与登录指南'},steps,reference);
  renderIdle();
  const account = selected ? el('section',{class:'card account-context'},el('div',{class:'card-body'},el('h2',{text:selected.name || '当前账号'}),el('p',{text:'设备确认后，终端将选择此账号；这不会抢占其他设备。本站当前提供 Code。'}),el('a',{href:'/accounts',text:'返回我的账号'}))) : null;
  return el('div',{class:'connect-page'},downloads,platformControl,account,layout);
}
export function loginCommand(accountId, executable) {
  try {
    const address = new URL(String(state.public?.site?.public_origin || ''));
    if (!/^https?:\/\/(?:[A-Za-z0-9.-]+|\[[0-9a-f:]+\])(?::\d+)?$/i.test(address.origin) || (accountId && !/^[A-Za-z0-9_.-]+$/.test(accountId)) || !['http:','https:'].includes(address.protocol) || address.username || address.password || address.search || address.hash || address.pathname !== '/') return executable+' login --gateway';
    return `${executable} login --gateway ${address.origin}${accountId?' --account '+accountId+' --surface code':''}`;
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

async function desktopDownloadPanel() {
  const status = el('p',{class:'accb-download-status',role:'status'});
  const actions = el('div',{class:'accb-download-actions'});
  const content = el('section',{class:'card accb-download-bar','aria-label':'ACCB 客户端下载'},
    el('div',{class:'accb-download-heading'},icon('monitor'),el('div',{},el('h2',{text:'客户端'}),el('p',{text:'选择适合你电脑的版本，下载安装后按下方步骤完成登录。'}))),actions,status);
  try {
    const response = await fetch('/accb-releases.json',{cache:'no-cache',signal:AbortSignal.timeout(8000)});
    if (!response.ok || !(response.headers.get('content-type') || '').includes('application/json')) throw new Error('Catalog unavailable');
    const catalog = parseDesktopRelease(await response.json());
    for (const target of desktopTargets) {
      const file = catalog.files.find(file => file.id === target.id);
      if (!file) { actions.append(el('span',{class:'accb-download-unavailable','aria-disabled':'true',text:target.label + ' · 暂未发布'})); continue; }
      const size = (file.size / 1048576).toFixed(1) + ' MB';
      actions.append(el('a',{class:'btn accb-download-link',href:file.href,download:file.name,'aria-label':'下载 ACCB ' + target.label,title:'SHA-256: ' + file.sha256},el('strong',{text:target.label}),el('span',{text:target.detail + ' · ' + size})));
    }
    status.append(catalog.version ? '版本 ' + catalog.version + ' · ' : '安装包尚未发布。');
    if (catalog.version) status.append('自动切号需要 Windows 配套客户端与新网关。Windows 包未做发行商签名；macOS 包仅 ad-hoc 签名、未公证。macOS / Linux 为未完成真机验收的预览包。 ',el('a',{href:'/accb-releases.json',text:'文件校验信息'}));
  } catch {
    status.textContent = '暂时无法读取安装包，请稍后刷新。下方命令行连接方式仍可使用。';
  }
  return content;
}
