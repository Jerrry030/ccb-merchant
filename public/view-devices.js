import { state } from './state.js';
import { managementAllows } from './management-policy.js';
import { el, icon } from './dom.js';
import { api, collection } from './api.js';
import { date } from './format.js';
import { badge, notice, panel, table } from './ui.js';
import { CANCEL, field, confirmAction, actionButton, editorDialog } from './ui-form.js';
import { render } from './app.js';
export async function devicesView() {
  const query=new URLSearchParams(location.search),accountId=query.get('account_id'),staff=location.pathname==='/admin/devices',userId=query.get('user_id');
  if(staff&&!userId)throw new Error('请先选择客户。');
  const base=staff?`/api/admin/users/${encodeURIComponent(userId)}/devices`:'/api/me/devices';
  const canEdit=!staff||managementAllows(state.user,'PATCH',base);
  const data=await api(base),devices=collection(data,'devices').filter(d=>!accountId||d.current_grant_id===accountId),accounts=collection(data,'accounts');
  return el('div',{class:'page-content'},panel(accountId?'更换设备':staff?null:'连接的设备','可以改名、选择账号或清空选择；清空不退出登录。单账号单设备，不会自动抢占。',table([
    {label:'设备',render:d=>el('div',{},el('strong',{text:d.name||'未命名设备'}),el('span',{class:'table-sub',text:d.platform||'未知平台'}))},
    {label:'状态',render:d=>badge(d.state)},{label:'所选账号',render:d=>d.account_name||accounts.find(a=>a.id===d.current_grant_id)?.name||'未指定'},
    {label:'最近活动',render:d=>date(d.last_seen)},{label:'到期时间',render:d=>date(d.expires_at)},
    {label:'操作',render:d=>el('div',{class:'table-actions'},
      el('button',{class:'btn small',text:'管理绑定',disabled:!canEdit||d.state!=='approved',onclick:()=>deviceEditor(d,accounts,base)}),
      el('a',{class:'btn small',href:(staff?'/admin/customer-usage?'+new URLSearchParams({user_id:userId,...(query.get('return_to')?{return_to:query.get('return_to')}:{})})+'&':'/usage?')+'device_id='+encodeURIComponent(d.id),text:'使用记录'}),
      actionButton('撤销连接',async()=>await confirmAction('撤销设备连接',`确认撤销「${d.name||'此设备'}」？此操作会阻止新的执行请求。`,'撤销连接',true)?api(base+'/'+encodeURIComponent(d.id),{method:'DELETE'}):CANCEL,{danger:true,disabled:!canEdit||d.state==='revoked'}))},
  ],devices,'还没有连接设备','请在客户端发起连接并确认。不会自动授权设备。'),staff?null:el('a',{class:'btn primary',href:'/connect'},icon('terminal'),'开始使用')));
}
function deviceEditor(device,accounts,base) {
 const name=field('设备名称','name',{required:true,maxlength:80,value:device.name}),pick=field('Code 账号','grant_id',{type:'select',choices:[{value:'',label:'不指定（保留设备登录）'},...accounts.filter(a=>a.state==='available'||a.state==='limited'||a.id===device.current_grant_id).map(a=>({value:a.id,label:a.name||a.id}))],value:device.current_grant_id||''});
 const feedback=el('div',{role:'alert'}),saveName=el('button',{type:'button',class:'btn',text:'保存名称'}),saveSelection=el('button',{type:'button',class:'btn primary',text:'保存账号选择'}),form=el('form',{},notice('不会抢占其他设备','变更携带所见版本。若结果未知，请先刷新核对，不会自动重放。'),feedback,name,saveName,pick,saveSelection);
 const dialog=editorDialog('设备绑定管理',form);
 const change=async(kind)=>{
  saveName.disabled=saveSelection.disabled=true;
  try {
   const values=new FormData(form),selection=kind==='selection';
   const result=await api(base+'/'+encodeURIComponent(device.id)+(selection?'/selection':''),{method:selection?'PUT':'PATCH',body:selection?{surface:'code',grant_id:values.get('grant_id')||null,expected_selection_version:device.selection_version}:{name:values.get('name'),expected_name:device.name}});
   device=result.device;feedback.replaceChildren(notice('已保存','设备状态已更新。'));await render();
   saveName.disabled=saveSelection.disabled=false;
  } catch(error) {feedback.replaceChildren(notice('修改未完成',error.message+' 请关闭窗口并刷新设备列表后再操作。','error'));}
 };
 saveName.addEventListener('click',()=>change('name'));saveSelection.addEventListener('click',()=>change('selection'));form.addEventListener('submit',event=>event.preventDefault());
}
