import { state } from './state.js';
import { managementAllows } from './management-policy.js';
import { deviceStatus } from './device-status.js';
import { el, icon } from './dom.js';
import { api, collection } from './api.js';
import { date } from './format.js';
import { notice, panel, table, emptyState, errorNotice } from './ui.js';
import { CANCEL, field, confirmAction, actionButton, editorDialog } from './ui-form.js';
import { navigate } from './router.js';
import { render } from './app.js';
export async function devicesView() {
 const query=new URLSearchParams(location.search),accountId=query.get('account_id'),staff=location.pathname==='/admin/devices',userId=query.get('user_id'),global=staff&&!userId;
 const base=staff?(global?'/api/admin/devices':`/api/admin/users/${encodeURIComponent(userId)}/devices`):'/api/me/devices';
 const filters=new URLSearchParams();if(global)for(const key of ['q','status','limit','offset'])if(query.has(key))filters.set(key,query.get(key));
 const data=await api(base+(global?'?'+filters:'')),devices=collection(data,'devices').filter(d=>!accountId||d.current_grant_id===accountId),accounts=global?null:collection(data,'accounts');
 const root=el('div',{class:'page-content devices-page'}),feedback=el('div',{'aria-live':'polite'});
 if(accountId)root.append(el('div',{class:'device-scope-heading'},el('h2',{text:'更换设备'}),el('p',{class:'muted',text:'仅显示当前账号绑定的设备。先撤销旧设备连接，再在新电脑登录并确认。'})));
 if(global){
  const form=el('form',{class:'admin-filters'},field('搜索设备或客户','q',{value:query.get('q')||'',maxlength:100,placeholder:'设备名称、账号编号、客户姓名或邮箱'}),field('设备授权状态','status',{type:'select',value:query.get('status')||'',choices:[['','全部状态'],['approved','已授权'],['pending','待确认'],['expired','已到期'],['revoked','已撤销'],['cancelled','已取消'],['unknown','状态未知']].map(([value,label])=>({value,label}))}),el('button',{class:'btn',type:'submit',text:'筛选设备'}),el('a',{class:'btn',href:'/admin/devices',text:'清除筛选'}));
  form.addEventListener('submit',event=>{event.preventDefault();const next=new URLSearchParams();for(const [key,value] of new FormData(form))if(value)next.set(key,value);navigate('/admin/devices?'+next);});root.append(form);
  if(data.incomplete){
   const unavailable=collection(data,'unavailable_customers');
   root.append(notice('设备列表未读取完整',`${unavailable.length} 位客户的设备暂不可用，下方仅显示已读取部分，不能代表全部设备或全局总数。请刷新重试，或进入客户设备核对。`,'warn'),el('details',{class:'device-read-failures'},el('summary',{text:'查看读取失败的客户'}),el('ul',{},unavailable.map(u=>el('li',{},el('a',{href:'/admin/devices?user_id='+encodeURIComponent(u.user_id),text:(u.customer_name||'未命名客户')+' · '+u.customer_email}))))));
  }
  root.append(el('div',{class:'pager'},el('span',{text:(data.incomplete?'已读取部分匹配 ':'共 ')+data.matched_total+' 台 · 本页 '+devices.length+' 台'}),...[-1,1].map(direction=>el('button',{class:'btn small',type:'button',text:direction<0?'上一页设备':'下一页设备',disabled:direction<0?data.offset===0:data.offset+data.limit>=data.matched_total,onclick:()=>{const next=new URLSearchParams(filters);next.set('offset',String(Math.max(0,data.offset+direction*data.limit)));navigate('/admin/devices?'+next);}}))));
 }else{
  root.append(el('div',{class:'device-toolbar'},el('p',{class:'muted',text:'共 '+devices.length+' 台设备 · 授权状态不代表实时在线状态'}),staff?el('a',{class:'btn',href:'/admin/devices',text:'查看全部客户设备'}):el('a',{class:'btn primary',href:'/connect'},icon('plus'),'连接设备'),accountId?el('a',{class:'btn',href:'/devices',text:'查看全部设备'}):null));
 }
 root.append(feedback);
 const now=Date.now(),entries=devices.map(device=>{
  const ownerId=global?device.user_id:userId,endpoint=staff?'/api/admin/users/'+encodeURIComponent(ownerId)+'/devices':base;
  const status=deviceStatus(device,now),ownerStatus=global?device.customer_status:state.scopedCustomer?.user?.status;
  const canEdit=(!staff||managementAllows(state.user,'PATCH',endpoint))&&(!staff||ownerStatus==='active');
  const canRevoke=!staff||managementAllows(state.user,'DELETE',endpoint+'/'+encodeURIComponent(device.id));
  const usage=staff?'/admin/customer-usage?'+new URLSearchParams({user_id:ownerId,...(!global&&query.get('return_to')?{return_to:query.get('return_to')}:{})})+'&':'/usage?';
  const edit=el('button',{class:'btn small',type:'button',text:'管理绑定',disabled:!canEdit||!status.editable});
  edit.addEventListener('click',async()=>{const ticket=state.view;edit.disabled=true;try{await deviceEditor(device,accounts,endpoint);}catch(error){if(ticket===state.view)feedback.replaceChildren(errorNotice(error));}finally{edit.disabled=!canEdit||!status.editable;}});
  const actions=el('div',{class:'table-actions'},edit,el('a',{class:'btn small',href:usage+'device_id='+encodeURIComponent(device.id),text:'使用记录'}),actionButton('撤销连接',async()=>await confirmAction('撤销设备连接',`确认撤销「${device.name||'此设备'}」${global?'（客户：'+(device.customer_name||device.customer_email)+'）':''}？此操作会阻止新的执行请求。`,'撤销连接',true)?api(endpoint+'/'+encodeURIComponent(device.id),{method:'DELETE'}):CANCEL,{danger:true,disabled:!canRevoke||!status.revocable}));
  const badge=el('span',{class:'badge '+status.tone},el('span',{class:'dot'}),status.label);
  return {device,status,badge,actions,accountName:device.account_name||accounts?.find(a=>a.id===device.current_grant_id)?.name||(device.current_grant_id?'账号信息不可用':'未指定')};
 });
 if(staff){
  root.append(panel(global?'全部客户设备':null,'设备归属以本站客户为准。已授权不等于在线；最近活动和到期时间使用服务端返回的数据。',table([
   {label:'设备',render:({device:d})=>el('div',{},el('strong',{text:d.name||'未命名设备'}),el('span',{class:'table-sub',text:d.platform||'未知平台'}))},
   ...(global?[{label:'所属客户',render:({device:d})=>el('div',{},el('a',{href:'/admin/devices?user_id='+encodeURIComponent(d.user_id),text:d.customer_name||'未命名客户'}),el('span',{class:'table-sub',text:d.customer_email}),d.customer_status==='disabled'?el('span',{class:'badge warn',text:'客户已停用'}):null)}]:[]),
   {label:'授权状态',render:row=>row.badge},{label:'所选账号',render:row=>row.accountName},
   {label:'最近活动',render:({device:d})=>d.last_seen?date(d.last_seen):'暂无记录'},
   {label:'授权到期',render:({device:d})=>d.expires_at?date(d.expires_at):'期限未提供'},
   {label:'操作',render:row=>row.actions},
  ],entries,data.incomplete?'暂未读到匹配设备':global?'没有匹配设备':'还没有连接设备',data.incomplete?'部分客户读取失败，请先恢复读取后再判断。':global?'调整设备或客户搜索、授权状态筛选后重试。':'请在客户端发起连接并确认。不会自动授权设备。')));
 }else{
  root.append(entries.length?el('div',{class:'device-grid'},entries.map(({device,status,badge,actions,accountName})=>el('article',{class:'card device-card','data-device-id':device.id,'aria-label':device.name||'未命名设备'},
   el('div',{class:'device-card-head'},el('span',{class:'device-icon'},icon('monitor')),el('div',{class:'device-card-title'},el('h2',{text:device.name||'未命名设备'}),el('p',{text:device.platform||'未知平台'})),badge),
   el('dl',{class:'device-card-facts'},el('dt',{text:'Claude Code'}),el('dd',{text:accountName}),el('dt',{text:'最近活动'}),el('dd',{text:device.last_seen?date(device.last_seen):'暂无记录'}),el('dt',{text:'授权到期'}),el('dd',{text:device.expires_at?date(device.expires_at):'期限未提供'})),
   status.state==='expired'?el('p',{class:'device-card-hint',text:'授权已到期，请在这台电脑重新登录后确认设备。'}):status.state==='revoked'?el('p',{class:'device-card-hint',text:'此设备连接已撤销，不能继续发起新的执行请求。'}):null,
   el('div',{class:'device-card-actions'},actions)
  ))):emptyState(accountId?'此账号没有绑定设备':'还没有连接设备',accountId?'可返回全部设备核对，或从开始使用页连接设备。':'请在需要使用的电脑运行登录命令，再到开始使用页确认。','monitor'));
 }
 return root;
}
async function deviceEditor(device,accounts,base) {
 if(accounts===null){
  const ticket=state.view,data=await api(base);if(ticket!==state.view)return;
  accounts=collection(data,'accounts');const current=collection(data,'devices').find(d=>d.id===device.id);
  if(!current||!deviceStatus(current).editable)throw new Error('设备状态已变化，请刷新全局列表后再操作。');device=current;
 }
 const name=field('设备名称','name',{required:true,maxlength:80,value:device.name}),pick=field('Code 账号','grant_id',{type:'select',choices:[{value:'',label:'不指定（保留设备登录）'},...accounts.filter(a=>a.state==='available'||a.state==='limited'||a.id===device.current_grant_id).map(a=>({value:a.id,label:a.name||a.id}))],value:device.current_grant_id||''});
 const feedback=el('div',{role:'alert'}),saveName=el('button',{type:'button',class:'btn',text:'保存名称'}),saveSelection=el('button',{type:'button',class:'btn primary',text:'保存账号选择'}),form=el('form',{},notice('不会抢占其他设备','变更携带所见版本。若结果未知，请先刷新核对，不会自动重放。'),feedback,name,saveName,pick,saveSelection);
 editorDialog('设备绑定管理',form);
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
