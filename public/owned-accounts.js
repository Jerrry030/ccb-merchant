import {el} from './dom.js';
import {api,collection} from './api.js';
import {notice,table,errorNotice} from './ui.js';
import {field,bindForm,editorDialog,confirmAction,actionButton,CANCEL} from './ui-form.js';

const labels={pending:'等待账号授权',queued:'等待处理',exchanging:'正在确认授权',provisioning:'正在接入库存',success:'账号已就绪',error:'授权失败',review:'结果待核对，请重新授权',cancelled:'已取消',expired:'授权已过期',active:'正常',paused:'已暂停',closed:'已退出'};
async function authorizationDialog(id){
 const content=el('div'),dialog=editorDialog('账号授权进度',content);let busy=false,timer;
 dialog.addEventListener('close',()=>clearTimeout(timer),{once:true});
 const refresh=async()=>{
  if(busy||!dialog.isConnected)return;busy=true;
  try{
   const {authorization:a}=await api('/api/admin/account-authorizations/'+id);
   content.replaceChildren(notice(labels[a.status]||a.status,a.error?'提供方状态：'+a.error:'授权成功后，账号将进入本站库存；客户仍经过所有直接提供方使用。'));
   if(a.status==='pending'){
    if(a.auth_url){const url=new URL(a.auth_url);if(url.protocol!=='https:')throw new Error('授权地址不安全。');content.append(el('a',{class:'btn primary',href:url.href,target:'_blank',rel:'noopener noreferrer',text:'打开供应商授权页面'}));}
    const form=el('form',{},field('授权完成后的回调地址','callback_url',{required:true,type:'password',autocomplete:'off',hint:'将浏览器最终显示的完整回调地址粘贴在这里。本站不保存授权码。'}),el('button',{type:'submit',class:'btn primary',text:'提交授权结果'}));
    bindForm(form,async v=>{const callback_url=v.get('callback_url');form.querySelector('input').value='';return api('/api/admin/account-authorizations/'+id+'/complete',{method:'POST',body:{callback_url}});},()=>refresh());content.append(form);
   }
   if(['pending','queued','exchanging','provisioning'].includes(a.status)){
    content.append(actionButton('取消本次授权',async()=>{if(!await confirmAction('取消账号授权','尚未发布的授权将终止；如发布已完成，请在账号列表退出托管。','确认取消',true))return CANCEL;const data=await api('/api/admin/account-authorizations/'+id,{method:'DELETE'});await refresh();return data;}));
    if(a.status!=='pending')timer=setTimeout(refresh,2000);
   }
   content.append(actionButton('核对当前状态',async()=>{await refresh();return CANCEL;}));
  }catch(error){content.replaceChildren(errorNotice(error),actionButton('重新核对',async()=>{await refresh();return CANCEL;}));}finally{busy=false;}
 };
 await refresh();
}
async function startAuthorization(asset){
 const id=crypto.randomUUID();let content;
 if(asset){
  if(!await confirmAction('重新授权账号','必须登录原账号。来源、客户交付和已撤销状态不会被重置。','继续授权'))return;
  await api('/api/admin/account-authorizations/'+id,{method:'PUT',body:{managed_account_id:asset.id,expected_revision:asset.revision}});await authorizationDialog(id);return;
 }
 const options=await api('/api/admin/account-intake');
 if(!options.available)throw new Error('没有可用的接入环境，请联系直接提供方。无需设置托管名额。');
 const environment=field('运行环境','environment_id',{type:'select',required:true,choices:options.environments.map(e=>({value:e.id,label:e.name+' · '+e.region+' · '+e.timezone}))});
 const platform=field('账号平台','platform',{type:'select',required:true,choices:[]});
 const update=()=>{const e=options.environments.find(e=>e.id===environment.querySelector('select').value);platform.querySelector('select').replaceChildren(...e.platforms.map(p=>el('option',{value:p,text:p})));};environment.addEventListener('change',update);update();
 content=el('form',{},notice('添加自己的账号','不购买上级库存、不扣钱包，也不设置托管期限。客户交付时仍需要填写明确的使用期限。'),field('账号名称','name',{required:true,maxlength:100}),environment,platform,el('button',{type:'submit',class:'btn primary',text:'开始授权'}));
 const dialog=editorDialog('添加自有账号',content);
 bindForm(content,v=>api('/api/admin/account-authorizations/'+id,{method:'PUT',body:{name:v.get('name'),environment_id:v.get('environment_id'),platform:v.get('platform')}}),async()=>{dialog.close();await authorizationDialog(id);});
}
export async function ownedAccountsDialog(){
 const content=el('div'),dialog=editorDialog('自有账号',content);
 const refresh=async()=>{
  const [assets,operations]=await Promise.all([api('/api/admin/managed-accounts'),api('/api/admin/account-authorizations')]);
  if(!dialog.isConnected)return;
  const change=async(a,status)=>{if(!await confirmAction(status==='closed'?'退出账号托管':status==='paused'?'暂停账号':'恢复账号',status==='closed'?'终止客户使用并退出本平台托管，保留历史；不代表供应商侧授权已撤销。':status==='paused'?'暂停运行并清除设备选择，保留客户合同；恢复后需重新选择设备账号。':'恢复来源账号，不会恢复已收回的客户授权。','确认操作',status!=='active'))return CANCEL;await api('/api/admin/managed-accounts/'+a.id,{method:status==='closed'?'DELETE':'PATCH',body:{expected_revision:a.revision,...(status==='closed'?{}:{status})}});await refresh();return CANCEL;};
  content.replaceChildren(notice('账号属于本站，运行仍逐级经过提供方','“暂停账号”“收回客户授权”和“退出托管”是三件不同的事。授权未确认就绪前不会成为可交付库存。'),actionButton('添加自有账号',async()=>{await startAuthorization();return CANCEL;}),actionButton('刷新账号与任务',async()=>{await refresh();return CANCEL;}),table([{label:'账号',render:a=>a.name},{label:'平台',render:a=>a.platform},{label:'状态',render:a=>labels[a.status]||a.status},{label:'操作',render:a=>el('div',{class:'button-row'},...(['active','paused'].includes(a.status)?[actionButton('重新授权',async()=>{await startAuthorization(a);return CANCEL;}),actionButton(a.status==='active'?'暂停':'恢复',()=>change(a,a.status==='active'?'paused':'active')),actionButton('退出托管',()=>change(a,'closed'),{danger:true})]:[]))}],collection(assets,'accounts'),'暂无自有账号'),table([{label:'授权操作',render:a=>a.id},{label:'状态',render:a=>labels[a.status]||a.status},{label:'操作',render:a=>actionButton('查看进度',async()=>{await authorizationDialog(a.id);return CANCEL;})}],collection(operations,'authorizations'),'暂无授权任务'));
 };
 try{await refresh();}catch(error){content.replaceChildren(errorNotice(error),actionButton('重试读取',async()=>{await refresh();return CANCEL;}));}
}
