import { managementAllows, managementProfiles } from './management-policy.js';
import { inventoryStatus } from './inventory-status.js';
import { el, icon } from './dom.js';
import { state, adoptSession } from './state.js';
import { api, collection } from './api.js';
import { date, number, money } from './format.js';
import { navigate } from './router.js';
import { toast, badge, statusBadge, notice, emptyState, panel, table, stat, expiryIndicator } from './ui.js';
import { CANCEL, field, confirmAction, bindForm, editorDialog } from './ui-form.js';
import { render } from './app.js';
function customerEditor(user) {
  const create=!user,full=state.user.management_profile==='owner'||!state.user.management_profile;
  const form=el('form',{},field('电子邮箱','email',{type:'email',required:true,maxlength:254,value:user?.email||'',autocomplete:'off'}));
  if(create)form.append(field('初始密码','password',{type:'password',required:true,minlength:7,maxlength:256,autocomplete:'new-password',hint:'请通过安全渠道交付；保存后不会显示。'}));
  form.append(field('显示名称','display_name',{required:true,maxlength:100,value:user?.display_name||''}));
  if(full)form.append(field('账户角色','role',{type:'select',choices:[{value:'member',label:'成员'},{value:'admin',label:'管理员'}],value:user?.role||'member'}),field('管理权限','management_profile',{type:'select',choices:Object.entries(managementProfiles).map(([value,label])=>({value,label})),value:user?.management_profile||'owner',hint:'仅管理员角色生效；客服、运营和财务不能修改站点设置。'}));
  if(!create)form.append(field('账户状态','status',{type:'select',choices:[{value:'active',label:'正常'},{value:'disabled',label:'停用'},...(user.status==='pending_verification'?[{value:'pending_verification',label:'待验证'}]:[])],value:user.status,disabled:user.id===state.user.id}),field('备注','notes',{type:'textarea',maxlength:4000,value:user.notes||'',hint:'仅本站管理人员可见，不向提供方发送。'}),field('标签','tags',{value:(user.tags||[]).join(', '),hint:'逗号分隔，最多 20 个标签。'}),field('变更原因','reason',{maxlength:500}),field('管理员密码（修改邮箱时必填）','admin_password',{type:'password',autocomplete:'current-password'}),user.pending_email?notice('邮箱验证待完成',user.pending_email+'；验证前仍使用原邮箱登录。','warn'):null);
  const roleControl=form.querySelector('[name=role]'),profileField=form.querySelector('[name=management_profile]')?.closest('.field');if(roleControl&&profileField){profileField.hidden=roleControl.value!=='admin';roleControl.addEventListener('change',()=>profileField.hidden=roleControl.value!=='admin');}
  form.append(el('button',{class:'btn primary',type:'submit',text:create?'创建客户账户':'保存客户信息'}));
  const dialog=editorDialog(create?'创建客户账户':'编辑 '+(user.display_name||user.email),form);
  bindForm(form,async values=>{
   const payload=Object.fromEntries(values);payload.role=payload.role||user?.role||'member';
   if(payload.role!=='admin')delete payload.management_profile;
   if(!create){payload.expected_revision=user.revision;payload.tags=(payload.tags||'').split(/[,，]/).map(v=>v.trim()).filter(Boolean);if(payload.status===user.status)delete payload.status;if(payload.email===user.email){delete payload.admin_password;delete payload.email;}else if(!payload.reason||!payload.admin_password)throw new Error('修改邮箱需要管理员密码和变更原因。');}
   if((create&&payload.role==='admin'||!create&&(payload.status==='disabled'||payload.role!==user.role||payload.management_profile&&payload.management_profile!==user.management_profile))&&!await confirmAction('确认权限变更','请核对目标客户与权限范围；现有会话可能失效。','确认变更',true))return CANCEL;
   return api(create?'/api/admin/users':'/api/admin/users/'+encodeURIComponent(user.id),{method:create?'POST':'PATCH',body:payload});
  },async data=>{if(!data.user)throw Object.assign(new Error('未收到客户变更确认。'),{uncertain:true});dialog.close();toast(data.user.pending_email?'资料已保存，新邮箱等待验证':'客户信息已保存');if(user?.id===state.user.id){try{adoptSession(await api('/api/auth/session'));}catch{state.user=null;state.csrf=null;navigate('/login',true);return;}}render();});
}
function credentialEditor(user) {
 const action=field('操作','action',{type:'select',choices:[{value:'reset_password',label:'设置临时密码（首次登录必须更改）'},{value:'email_reset',label:'发送密码重置邮件'},{value:'revoke_sessions',label:'退出所有网页登录会话'}]});
 const fresh=field('临时密码','new_password',{type:'password',required:true,minlength:7,autocomplete:'new-password'});
 const form=el('form',{},notice('仅管理本站登录','不会读取旧密码，也不会修改提供方账号凭据或自动撤销运行设备。'),action,fresh,field('管理员当前密码','admin_password',{type:'password',required:true,autocomplete:'current-password'}),field('处理原因','reason',{required:true,maxlength:500}),el('button',{class:'btn primary',type:'submit',text:'确认安全操作'}));
 action.querySelector('select').addEventListener('change',event=>{fresh.hidden=event.target.value!=='reset_password';fresh.querySelector('input').disabled=fresh.hidden;});
 const dialog=editorDialog('客户登录安全',form);
 bindForm(form,async values=>{if(!await confirmAction('确认客户登录安全操作','目标：'+(user.display_name||user.email)+'。临时密码设置后将撤销旧网页登录会话。','确认执行',true))return CANCEL;return api('/api/admin/users/'+encodeURIComponent(user.id)+'/credentials',{method:'POST',body:{...Object.fromEntries(values),expected_revision:user.revision}});},data=>{dialog.close();toast(data.delivery==='unconfirmed'?'邮件发送结果待核对，请勿视为已送达':'安全操作已完成');render();});
}
async function customerDetailView(user) {
  const scope=new URLSearchParams({user_id:user.id,return_to:location.pathname+location.search});
  const since=new Date(Date.now()-7*86400000).toISOString();
  const endpoints=['/api/admin/inventory','/api/admin/users/'+encodeURIComponent(user.id)+'/devices','/api/admin/rentals?limit=5&user_id='+encodeURIComponent(user.id),'/api/admin/orders?limit=5&user_id='+encodeURIComponent(user.id),...(user.core_customer_id?['/api/admin/users/'+encodeURIComponent(user.id)+'/usage?limit=5&result=error&from='+encodeURIComponent(since)]:[])];
  const results=await Promise.allSettled(endpoints.map(async(path,index)=>{const value=await api(path);collection(value,['accounts','devices','rentals','orders','requests'][index]);return value;}));
  const data=results.map(r=>r.status==='fulfilled'?r.value:null);
  const accounts=data[0]?collection(data[0],'accounts').filter(a=>a.user_id===user.id&&!inventoryStatus(a).history):null;
  const devices=data[1]?collection(data[1],'devices'):null;
  const nextExpiry=accounts?.map(a=>Date.parse(a.customer_expires_at)).filter(Number.isFinite).sort((a,b)=>a-b)[0];
  const root=el('div',{class:'page-content customer-detail'},
    el('div',{class:'button-row'},(user.role!=='admin'||!state.user.management_profile||state.user.management_profile==='owner')&&managementAllows(state.user,'PATCH','/api/admin/users/'+user.id)?el('button',{class:'btn',text:'编辑客户资料',onclick:()=>customerEditor(user)}):null,user.id!==state.user.id&&(user.role!=='admin'||!state.user.management_profile||state.user.management_profile==='owner')&&managementAllows(state.user,'POST','/api/admin/users/'+user.id+'/credentials')?el('button',{class:'btn',text:'登录安全 / 重置密码',onclick:()=>credentialEditor(user)}):null),
    panel('客户资料','仅本站管理人员可见',el('div',{class:'card-body'},el('p',{text:'最近登录：'+date(user.last_login_at)}),el('p',{text:'标签：'+((user.tags||[]).join(' · ')||'未设置')}),el('p',{text:'备注：'+(user.notes||'未填写')}))),
    user.sync_pending?notice('客户同步待确认',user.sync_error||'新的交付或使用可能受限，请先到待办核对。','warn',el('a',{href:'/admin/operations',class:'btn small',text:'处理同步待办'})):null,
    el('div',{class:'stats-grid'},stat('当前账号',accounts?number(accounts.length):'未知','当前客户范围内的授权','layers'),stat('最近客户到期',nextExpiry?date(nextExpiry):accounts?'—':'未知','以客户期限为准，不是上游授权期限','receipt'),stat('已连接设备',devices?number(devices.filter(d=>d.state==='approved').length):'未知','仅统计已批准的连接','monitor')));
  const sections=[
    ['账号与期限','账号和客户期限来自当前库存；管理与分配保留版本校验。',accounts&&table([{label:'账号',render:a=>el('div',{},el('strong',{text:a.details?.name||a.id}),el('span',{class:'table-sub',text:a.platform}))},{label:'状态',render:a=>inventoryStatus(a).label},{label:'客户到期',render:a=>el('div',{},date(a.customer_expires_at),expiryIndicator(a.customer_expires_at))},{label:'授权上限',render:a=>date(a.expires_at)}],accounts,'尚未分配账号','可从这位客户的账号页选择库存。'),'/admin/inventory',0],
    ['客户设备','核对设备、所选账号和最近活动，无需冒用客户登录。',devices&&table([{label:'设备',render:d=>d.name||d.id},{label:'状态',render:d=>badge(d.state)},{label:'所选账号',render:d=>d.account_name||'未指定'},{label:'最近活动',render:d=>date(d.last_seen)}],devices,'还没有连接设备','请让客户从客户端发起连接。'),'/admin/devices',1],
    ['最近交付订单','只展示最近 5 笔；查看全部可筛选异常订单。',data[2]&&table([{label:'订单 / 套餐',render:o=>el('div',{},o.name,el('span',{class:'table-sub',text:o.id}))},{label:'状态',render:o=>badge(o.status)},{label:'客户到期',render:o=>date(o.expires_at)}],data[2].rentals,'暂无交付订单','人工分配的账号请看上方账号与期限。'),'/admin/rentals',2],
    ['最近支付订单','只展示最近 5 笔；支付结果以服务端核对为准。',data[3]&&table([{label:'订单',render:o=>o.id},{label:'金额',render:o=>money(o.amount_minor,o.currency)},{label:'状态',render:o=>badge(o.status)}],data[3].orders,'暂无支付订单','没有支付订单不代表没有人工分配的账号。'),'/admin/orders',3],
  ];
  for(const [title,description,body,path,index] of sections){if(index<2&&body)body.classList.add('rental-table');root.append(panel(title,description,body||notice('此项数据暂不可用',results[index].reason?.message||'未获得完整结果，不代表没有记录。','warn'),el('a',{class:'btn small',href:path+'?'+scope,text:'查看全部'})));}
  root.append(panel('最近失败请求','近 7 天，最多显示最近 5 条；不是全部用量汇总。',!user.core_customer_id?emptyState('尚未建立使用记录','客户获得账号并开始使用后可在这里核对。'):data[4]?table([{label:'时间',render:r=>date(r.time)},{label:'模型',render:r=>r.model||'—'},{label:'状态',render:r=>statusBadge(r.status)}],collection(data[4],'requests'),'此区间没有失败请求','仅代表本次查询返回的近 7 天范围。'):notice('使用记录暂不可用',results[4]?.reason?.message||'请稍后核对。','warn'),el('a',{class:'btn small',href:'/admin/customer-usage?'+scope+'&result=error&range=7d',text:'查看失败请求'})));
  return root;
}
export async function customersView() {
  const selected=new URLSearchParams(location.search).get('user_id');
  if(selected){const cached=state.scopedCustomer;const user=cached?.ticket===state.view&&cached.user?.id===selected?cached.user:(await api('/api/admin/users/'+encodeURIComponent(selected))).user;return customerDetailView(user);}
  const params=new URLSearchParams(location.search),offset=Math.max(0,Number(params.get('offset'))||0),query=new URLSearchParams({limit:'50',offset:String(offset),q:params.get('q')||''});for(const key of ['status','role','assignment','due','tag'])if(params.get(key))query.set(key,params.get(key));
  const data=await api(`/api/admin/users?${query}`),users=collection(data,'users');
  const search=el('form',{class:'admin-filters'},field('搜索客户','q',{value:query.get('q'),placeholder:'邮箱或名称'}),field('状态','status',{type:'select',value:params.get('status')||'',choices:[['','全部'],['active','正常'],['disabled','停用'],['pending_verification','待验证']].map(([value,label])=>({value,label}))}),field('角色','role',{type:'select',value:params.get('role')||'',choices:[['','全部'],['member','成员'],['admin','管理员']].map(([value,label])=>({value,label}))}),field('账号情况','assignment',{type:'select',value:params.get('assignment')||'',choices:[['','全部'],['unassigned','无有效账号'],['assigned','已分配'],['sync_pending','同步异常']].map(([value,label])=>({value,label}))}),field('客户临期','due',{type:'select',value:params.get('due')||'',choices:[['','全部'],['7','7 天内'],['30','30 天内']].map(([value,label])=>({value,label}))}),field('标签','tag',{value:params.get('tag')||''}),el('button',{class:'btn',type:'submit',text:'搜索'}));search.addEventListener('submit',event=>{event.preventDefault();const next=new URLSearchParams();for(const [key,value] of new FormData(search))if(value)next.set(key,value);navigate('/admin/customers?'+next);});
  const pager=el('div',{class:'pager'},el('span',{text:`共 ${data.total} 位客户 · 本页 ${users.length} 位`}),...[-50,50].map(delta=>el('button',{class:'btn small',text:delta<0?'上一页':'下一页',disabled:delta<0?offset===0:offset+users.length>=data.total,onclick:()=>{query.set('offset',String(Math.max(0,offset+delta)));navigate(`/admin/customers?${query}`);}})));
  const exportButton=el('button',{class:'btn',text:'导出本页客户',onclick:()=>{const cell=v=>'"'+String(v??'').replace(/^[=+@-]/,"'$&").replaceAll('"','""')+'"';const csv=[['客户编号','姓名','邮箱','角色','状态','标签','最近登录'],...users.map(u=>[u.id,u.display_name,u.email,u.role,u.status,(u.tags||[]).join(';'),u.last_login_at])].map(row=>row.map(cell).join(',')).join('\r\n');const url=URL.createObjectURL(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'}));el('a',{href:url,download:'customers-page.csv'}).click();setTimeout(()=>URL.revokeObjectURL(url),1000);}});
  return el('div',{class:'page-content'},search,pager,exportButton,panel('客户账户',`${number(users.length)} 个站点账户`,table([
    {label:'客户',render:u => el('div',{},el('strong',{text:u.display_name || '未命名客户'}),el('span',{class:'table-sub',text:u.email}))},
    {label:'角色 / 状态',render:u => el('div',{class:'button-row'},badge(u.role),u.role==='admin'?el('span',{class:'table-sub',text:managementProfiles[u.management_profile||'owner']}):null,badge(u.status))},
    {label:'创建时间',render:u => date(u.created_at)},
    {label:'操作',render:u => el('div',{class:'table-actions'},el('a',{class:'btn small',href:'/admin/customers?'+new URLSearchParams({...Object.fromEntries(query),user_id:u.id}),text:'客户详情'}),el('button',{class:'btn small',type:'button',text:'编辑',disabled:u.role==='admin'&&Boolean(state.user.management_profile)&&state.user.management_profile!=='owner'||!managementAllows(state.user,'PATCH','/api/admin/users/'+u.id),onclick:()=>customerEditor(u)}),el('a',{class:'btn small',href:`/admin/inventory?user_id=${encodeURIComponent(u.id)}`,text:'查看与分配账号'}),el('a',{class:'btn small',href:`/admin/devices?user_id=${encodeURIComponent(u.id)}`,text:'管理设备'}))},
  ],users,'暂无客户账户','创建客户后，在账号库存选择账号并分配给客户。'),el('button',{class:'btn primary',type:'button',disabled:!managementAllows(state.user,'POST','/api/admin/users'),onclick:() => customerEditor()},icon('plus'),'创建客户')));
}
