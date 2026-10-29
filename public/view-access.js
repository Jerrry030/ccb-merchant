import { el } from './dom.js';
import { api, collection } from './api.js';
import { date } from './format.js';
import { navigate } from './router.js';
import { badge, notice, panel, table } from './ui.js';
import { CANCEL, field, confirmAction, bindForm, actionButton, editorDialog } from './ui-form.js';
import { render } from './app.js';
function showSecret(data) {
  const secret = el('code',{class:'secret',text:data.token});
  const dialog = el('dialog',{class:'dialog','aria-label':'接入密钥'});
  const discard = () => { secret.textContent = ''; data.token = ''; if (dialog.open) dialog.close(); dialog.remove(); };
  dialog.append(el('div',{class:'dialog-head'},el('h2',{text:'接入密钥'})),notice('关闭后仍可再次查看','撤销前可以在密钥列表中打开原文。撤销后会删除原文，无法恢复。不要放入客户端代码、截图或公开文档。','warn'),secret,el('p',{text:'密钥名称：' + (data.key?.name || '未命名') + '。列表不直接展示原文。'}),el('div',{class:'dialog-actions'},el('button',{class:'btn primary',type:'button',text:'关闭',onclick:discard})));
  dialog.addEventListener('cancel',event => { event.preventDefault(); discard(); });
  dialog.addEventListener('close',discard,{once:true});
  document.body.append(dialog); dialog.showModal();
}
function accessEditor(account) {
 const form=el('form',{},field('接入标识','slug',{required:true,maxlength:48,value:account?.slug||'',disabled:Boolean(account)}),field('客户名称','name',{required:true,maxlength:100,value:account?.name||''}),...(account?[field('接入状态','status',{type:'select',choices:[{value:'active',label:'正常'},{value:'disabled',label:'停用访问'}],value:account.status})]:[]),el('button',{type:'submit',class:'btn primary',text:'保存接入账户'}));
 const dialog=editorDialog(account?'编辑 API 客户':'创建 API 客户',form);
 bindForm(form,async v=>{
  const body={name:v.get('name').trim(),...(account?{expected_revision:account.revision,status:v.get('status')}:{slug:v.get('slug').trim()})};
  if(!await confirmAction('保存接入账户','只在这里创建或更新直接 API 客户。不会向上游登记该客户的站点或它的下级。','确认保存'))return CANCEL;
  return api(account?`/api/admin/access-accounts/${account.id}`:'/api/admin/access-accounts',{method:account?'PATCH':'POST',body});
 },data=>{if(!data.account?.id)throw Object.assign(new Error('结果未知，请刷新账户列表。'),{uncertain:true});dialog.close();render();});
}
function accessResourceEditor(account,sources,resource) {
 const form=el('form',{},field('上游资源','upstream_id',{type:'select',required:true,choices:sources.map(r=>({value:r.id,label:r.name})),value:resource?.upstream_id||sources[0]?.id,disabled:Boolean(resource)}),field('客户可见资源名称','name',{required:true,maxlength:100,value:resource?.name||''}),field('到期时间','expires_at',{type:'datetime-local',hint:'新建留空沿用上游期限；编辑留空保留原期限。'}),...(resource?[field('资源状态','status',{type:'select',choices:[{value:'active',label:'启用访问'},{value:'disabled',label:'停用访问'}],value:resource.status})]:[]),notice('仅在这里管理的分配','仅授予可用的资源范围与期限，不设置客户人数配额。客户可以自行经营域名和下级，不登记其组织关系。'),el('button',{type:'submit',class:'btn primary',text:'保存资源范围'}));
 const dialog=editorDialog('分配 API 资源范围',form);
 bindForm(form,async v=>{
  const body={name:v.get('name').trim(),...(resource?{expected_revision:resource.revision,status:v.get('status')}:{upstream_id:v.get('upstream_id')})};if(v.get('expires_at'))body.expires_at=new Date(v.get('expires_at')).toISOString();
  if(!await confirmAction('确认资源分配','为该接入账户授予所选资源及有效期，不限制客户数量。','确认保存'))return CANCEL;
  return api(`/api/admin/access-accounts/${account.id}/resources${resource?'/'+resource.id:''}`,{method:resource?'PATCH':'POST',body});
 },data=>{if(!data.resource?.id)throw Object.assign(new Error('资源状态未知，请刷新。'),{uncertain:true});dialog.close();render();});
}
function accessKeyEditor(account) {
 const allowed=['resources.read','customers.read','customers.write','delegation.grants.read','delegation.grants.write','delegation.devices.read','delegation.devices.write','delegation.usage.read','runtime'];
 const form=el('form',{},field('密钥名称','name',{required:true,maxlength:80,placeholder:'生产接入 / 轮换密钥'}),el('fieldset',{},el('legend',{text:'允许的接口权限'}),el('div',{class:'scope-grid'},allowed.map(scope=>el('label',{class:'check-label'},el('input',{type:'checkbox',name:'scopes',value:scope,checked:true}),scope)))),field('密钥到期时间','expires_at',{type:'datetime-local'}),notice('密钥与接入账户分离','密钥在这里生成，撤销前可以再次查看。轮换同一账户的密钥不改变它的数据与资源，也不修改它在自己平台签发的密钥。'),el('button',{type:'submit',class:'btn primary',text:'签发接入密钥'}));
 const dialog=editorDialog('签发 API 密钥',form);
 bindForm(form,async v=>{
  const body={name:v.get('name').trim(),scopes:v.getAll('scopes')};if(!body.scopes.length)throw new Error('至少选择一项权限。');if(v.get('expires_at'))body.expires_at=new Date(v.get('expires_at')).toISOString();
  if(!await confirmAction('签发接入密钥',`这把密钥只供 ${account.name} 使用。撤销前可以再次查看，撤销后无法恢复。`,'确认签发'))return CANCEL;
  return api(`/api/admin/access-accounts/${account.id}/keys`,{method:'POST',body});
 },async data=>{if(!data.key?.id||!data.token)throw Object.assign(new Error('发钥结果未知，请刷新核对。'),{uncertain:true});dialog.close();await render();});
}
export async function accessView() {
 const params=new URLSearchParams(location.search),offset=Math.max(0,Number(params.get('offset'))||0),query=new URLSearchParams({limit:'50',offset:String(offset),q:params.get('q')||''});
 const data=await api(`/api/admin/access-accounts?${query}`),accounts=collection(data,'accounts'),root=el('div',{class:'page-content api-access-page'});
 const search=el('form',{class:'button-row'},el('input',{name:'q',value:query.get('q'),placeholder:'搜索 API 客户','aria-label':'搜索 API 客户'}),el('button',{class:'btn',type:'submit',text:'搜索'}));search.addEventListener('submit',event=>{event.preventDefault();navigate('/admin/access?q='+encodeURIComponent(new FormData(search).get('q')));});
 root.append(search,el('div',{class:'pager'},el('span',{text:`共 ${data.total} 个接入账户`}),...[-50,50].map(delta=>el('button',{class:'btn small',text:delta<0?'上一页':'下一页',disabled:delta<0?offset===0:offset+accounts.length>=data.total,onclick:()=>{query.set('offset',String(Math.max(0,offset+delta)));navigate(`/admin/access?${query}`);}}))));
 const selectedID=params.get('account');if(selectedID&&!accounts.some(a=>a.id===selectedID)){const chosen=await api('/api/admin/access-accounts/'+encodeURIComponent(selectedID));accounts.push(chosen.account);}
 root.append(panel('API 客户','一个接入账户可以有多把密钥；数据和资源属于账户，不属于单把密钥。',table([{label:'客户',render:a=>el('div',{},el('strong',{text:a.name}),el('p',{class:'mono muted',text:a.slug}))},{label:'站点',render:a=>el('span',{class:'mono',text:a.public_origin})},{label:'状态',render:a=>badge(a.status)},{label:'操作',render:a=>el('div',{class:'button-row'},el('button',{class:'btn small',text:'编辑',onclick:()=>accessEditor(a)}),el('a',{class:'btn small',href:`/admin/access?account=${encodeURIComponent(a.id)}`,text:'资源与密钥'}))}],accounts,'暂无 API 客户','先创建接入账户，再分配资源和签发密钥。'),el('button',{class:'btn primary',text:'创建 API 客户',onclick:()=>accessEditor(null)})));
 const selected=accounts.find(a=>a.id===new URLSearchParams(location.search).get('account'));
 if(selected){
  const [r,k,own]=await Promise.all([api(`/api/admin/access-accounts/${selected.id}/resources`),api(`/api/admin/access-accounts/${selected.id}/keys`),api('/api/admin/resources')]),resources=collection(r,'resources'),keys=collection(k,'keys'),sources=collection(own,'resources');
  root.append(panel(`${selected.name} · 资源范围`,'分配仅限已有的资源范围和期限，不设置客户人数配额。',table([{label:'资源',render:r=>r.name},{label:'期限',render:r=>r.expires_at?date(r.expires_at):'无固定期限'},{label:'状态',render:r=>badge(r.available?'active':'disabled')},{label:'操作',render:r=>el('button',{class:'btn small',text:'编辑范围',onclick:()=>accessResourceEditor(selected,sources,r)})}],resources),el('button',{class:'btn',text:'分配资源',disabled:!sources.length,onclick:()=>accessResourceEditor(selected,sources)})));
  root.append(panel(`${selected.name} · 接入密钥`,'交付公开地址和这里生成的密钥，绝不交付上游密钥。',table([{label:'密钥',render:k=>k.name},{label:'前缀',render:k=>k.prefix+'…'},{label:'权限',render:k=>k.scopes.join(' · ')},{label:'期限',render:k=>date(k.expires_at)},{label:'状态',render:k=>badge(k.revoked_at?'revoked':k.expires_at&&Date.parse(k.expires_at)<Date.now()?'expired':'active')},{label:'操作',render:k=>el('div',{class:'table-actions'},k.copyable?actionButton('查看',async()=>{const data=await api(`/api/admin/access-accounts/${selected.id}/keys/${k.id}/copy`,{method:'POST',body:{}});showSecret({key:k,token:data.token});return CANCEL;}):el('span',{class:'muted',text:k.revoked_at?'':'不可再查看'}),actionButton('撤销',async()=>{if(!await confirmAction('撤销这把接入密钥','仅撤销这把密钥，并清除可再次查看的原文。同一接入账户的其他有效密钥和已有数据不变。','确认撤销',true))return CANCEL;return api(`/api/admin/access-accounts/${selected.id}/keys/${k.id}`,{method:'DELETE',body:{}});},{danger:true,disabled:Boolean(k.revoked_at)}))}],keys),el('button',{class:'btn',text:'签发接入密钥',onclick:()=>accessKeyEditor(selected)})));
 }
 return root;
}
