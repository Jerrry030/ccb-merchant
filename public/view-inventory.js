import { customerPicker } from './customer-picker.js';
import { state } from './state.js';
import { managementAllows } from './management-policy.js';
import { localDateTime, renewalExpiry } from './admin-workflow.js';
import { selectInventory } from './inventory-status.js';
import { el } from './dom.js';
import { api, collection } from './api.js';
import { date, number } from './format.js';
import { navigate } from './router.js';
import { toast, notice, panel, table, stat, errorNotice, expiryIndicator } from './ui.js';
import { CANCEL, field, confirmAction, bindForm, actionButton, editorDialog } from './ui-form.js';
import { accountCard, quotaSummary } from './view-accounts.js';
import { render } from './app.js';
export async function inventoryView() {
 const batches=await batchHistory();let data;try{data=await api('/api/admin/inventory');}catch(error){return el('div',{class:'page-content'},panel('库存暂不可用','未获得完整库存，不代表库存为空；仍可查看已保存的批次。',errorNotice(error)),batches);}const accounts=collection(data,'accounts');
 const selectedAccounts=new Set(),canAssign=managementAllows(state.user,'POST','/api/admin/grants');
 const batchButton=el('button',{class:'btn primary',type:'button',disabled:true,text:'批量分配（0）',onclick:()=>allocationEditor(accounts.filter(a=>selectedAccounts.has(a.id)),customerId)});
 const selectionChanged=()=>{batchButton.textContent='批量分配（'+selectedAccounts.size+'）';batchButton.disabled=!canAssign||selectedAccounts.size===0;};
 const query=new URLSearchParams(location.search),customerId=query.get('user_id'),now=Date.now();
 const entries=selectInventory(accounts,query,now);
 const filters=el('form',{class:'admin-filters'},field('搜索账号或客户','q',{value:query.get('q')||'',placeholder:'账号名称、编号、客户姓名或邮箱'}),field('平台','platform',{type:'select',value:query.get('platform')||'',choices:[{value:'',label:'全部平台'},...Array.from(new Set(accounts.map(a=>a.platform).filter(Boolean))).sort().map(value=>({value,label:value}))]}),field('库存状态','status',{type:'select',value:query.get('status')||'',choices:[['','全部状态'],['assignable','可分配'],['assigned','已分配'],['unavailable','暂不可用'],['review','待核对'],['released','已释放'],['expired','已到期']].map(([value,label])=>({value,label}))}),field('到期口径','deadline',{type:'select',value:query.get('deadline')||'customer',choices:[{value:'customer',label:'客户到期'},{value:'authorization',label:'上游授权到期'}]}),field('到期范围','due',{type:'select',value:query.get('due')||'',choices:[{value:'',label:'全部期限'},{value:'7',label:'未来 7 天'},{value:'30',label:'未来 30 天'}]}),field('排序','sort',{type:'select',value:query.get('sort')||'expiry_asc',choices:[{value:'expiry_asc',label:'到期从近到远'},{value:'expiry_desc',label:'到期从远到近'},{value:'name',label:'账号名称'}]}),el('button',{class:'btn',type:'submit',text:'筛选库存'}));
 const controls=[...filters.children];
 const advanced=el('details',{class:'inventory-filter-details',open:['platform','status','deadline','due','sort'].some(key=>query.get(key))},el('summary',{text:'平台、状态、到期与排序'}),el('div',{class:'admin-filter-fields'},controls.slice(1,-1)));
 filters.replaceChildren(controls[0],controls.at(-1),advanced);
 filters.addEventListener('submit',event=>{event.preventDefault();const next=new URLSearchParams(location.search);next.delete('inventory_offset');for(const [key,value] of new FormData(filters)){if(value)next.set(key,value);else next.delete(key);}navigate('/admin/inventory?'+next);});
 const quick=el('div',{class:'button-row'},[7,30].map(days=>el('button',{class:'btn small',text:'客户 '+days+' 天内到期',onclick:()=>{const next=new URLSearchParams(location.search);next.set('deadline','customer');next.set('due',String(days));next.delete('view');navigate('/admin/inventory?'+next);}})),el('button',{class:'btn small',text:'清除库存筛选',onclick:()=>{const next=new URLSearchParams(location.search);for(const key of ['q','platform','status','deadline','due','sort'])next.delete(key);navigate('/admin/inventory?'+next);}}));
 const current=entries.filter(entry=>!entry.history),historical=entries.filter(entry=>entry.history);
 const selected=query.get('view')==='history'?'history':'current';
 const descriptions={current:'选账号 → 选客户 → 确认分配。每个账号最多绑定 1 台设备。',history:'已释放、已到期的授权仅供核对，不作为当前可交付库存。'};
 const allLink=customerId?el('a',{href:'/admin/inventory'+(selected==='history'?'?view=history':''),class:'btn',text:'查看全部库存'}):null;
 const pages=[['current','当前库存',current],['history','历史记录',historical]].map(([id,label,rows])=>{
  const isHistory=id==='history';
  const columns=[
   {label:'账号',render:({account:a})=>el('div',{},el('strong',{class:'inventory-account-code',text:a.account_code||a.details?.name||'编号待核对'}),el('span',{class:'table-sub',text:a.resource_name?'分组：'+a.resource_name:''}))},
   {label:'规格 / 平台',render:({account:a})=>el('div',{class:'inventory-platform'},a.details?.plan||'Claude',el('span',{class:'table-sub',text:a.platform||'平台未知'}))},
   {label:isHistory?'原授权到期':'授权到期',render:({account:a})=>el('div',{},date(a.expires_at),isHistory?null:expiryIndicator(a.expires_at))},
   {label:'状态',render:entry=>el('div',{},el('span',{class:`badge ${entry.tone}`,text:entry.label}),entry.reason?el('span',{class:'table-sub',text:entry.reason}):null)},
   {label:isHistory?'关联客户':'使用客户',render:({account:a})=>isHistory&&!a.user_id?'未提供':a.assigned?el('div',{},el('strong',{text:a.customer_name||'已分配客户'}),el('span',{class:'table-sub',text:a.customer_email||''}),el('span',{class:'table-sub',text:'客户到期：'+date(a.customer_expires_at)}),expiryIndicator(a.customer_expires_at)):'—'},
  ];
  if(!isHistory){columns.unshift({label:'选择',render:entry=>el('input',{type:'checkbox','aria-label':'选择 '+(entry.account.account_code||entry.account.details?.name||entry.account.id),disabled:!canAssign||!entry.assignable,onchange:event=>{if(event.target.checked)selectedAccounts.add(entry.account.id);else selectedAccounts.delete(entry.account.id);selectionChanged();}})});columns.splice(3,0,{label:'额度',render:({account:a})=>quotaSummary(a.details?.quota)});}
  if(!isHistory)columns.push({label:'设备',render:({account:a})=>a.details?.device_name||'未绑定'});
  columns.push({label:'操作',render:entry=>{
   const a=entry.account;
   if(isHistory)return el('button',{class:'btn small',type:'button',text:'查看记录',onclick:()=>editorDialog('历史授权记录',el('div',{},
    notice('历史授权，不计入当前库存','此记录只用于核对原授权，不代表当前账号状态，也不能用于再次分配。'),
    el('dl',{class:'inventory-record-facts'},[
     ['账号',a.details?.name||a.id],['授权编号',a.id],['状态',entry.label],['规格',a.details?.plan||'Claude'],['平台',a.platform||'未提供'],
     ['原授权到期',date(a.expires_at)],['授权创建时间',date(a.created_at)],['关联客户',a.user_id?(a.customer_name||a.customer_email||a.user_id):'未提供'],
    ].map(([name,value])=>[el('dt',{text:name}),el('dd',{text:value})]))))});
   return el('div',{class:'button-row'},
    el('button',{class:'btn small',type:'button',text:'账号详情',onclick:()=>editorDialog('账号详情',el('div',{},accountCard({...a.details,id:a.id,platform:a.platform,expires_at:a.expires_at,device_limit:1},true),el('p',{class:'inline-info inventory-record-id',text:'授权编号：'+a.id})))}),
    !a.assigned?el('button',{class:'btn small',type:'button',text:'分配客户',disabled:!canAssign||!entry.assignable,onclick:()=>allocationEditor([a],customerId)}):[
     el('button',{class:'btn small',type:'button',text:'延长客户有效期',disabled:!canAssign||!entry.active||!a.grant_revision||Date.parse(a.customer_expires_at)>=Date.parse(a.expires_at),onclick:()=>extendCustomerAccount(a)}),
     actionButton('收回账号',async()=>await confirmAction('收回账号',`收回「${a.details?.name||'此账号'}」对「${a.customer_name||'当前客户'}」的授权。原客户和设备将不能继续使用，确认成功后才可重新分配。`,'确认收回',true)?api('/api/admin/grants/'+encodeURIComponent(a.grant_id),{method:'PATCH',body:{expected_revision:a.grant_revision,status:'revoked'}}):CANCEL,{danger:true,disabled:!canAssign||!a.grant_id||!a.grant_revision})]);
  }});
  const filtering=['q','platform','status','due'].some(key=>query.get(key));
   const empty=filtering?'没有匹配的库存':isHistory?'暂无历史记录':historical.length?'暂无当前库存':'暂无账号';
  const explanation=isHistory?(customerId?'未返回与这位客户明确关联的历史授权；未关联客户的记录可在全部库存中查看。':'已释放或已到期的授权会保留在这里，不计入当前库存。'):historical.length?'当前没有可用的授权记录。可切换到历史记录核对原授权，或联系平台管理员重新分配。':customerId?'这位客户尚未获得账号，当前也没有未分配库存。':'请联系平台管理员分配账号。账号进入库存后，直接选择客户即可交付。';
  const offset=Math.max(0,Number(query.get('inventory_offset'))||0),visibleRows=rows.slice(offset,offset+50);
  const inventory=table(columns,visibleRows,empty,filtering?'请调整筛选条件；这不代表全部库存为空。':explanation);inventory.classList.add('rental-table');inventory.querySelectorAll('tbody tr').forEach((row,index)=>row.dataset.accountLease=visibleRows[index]?.account.id||'');
  const pager=el('div',{class:'pager'},el('span',{text:'共 '+rows.length+' 条 · 本页 '+visibleRows.length+' 条'}),...[-50,50].map(delta=>el('button',{class:'btn small',text:delta<0?'上一页库存':'下一页库存',disabled:delta<0?offset===0:offset+50>=rows.length,onclick:()=>{const q=new URLSearchParams(location.search);q.set('inventory_offset',String(Math.max(0,offset+delta)));navigate('/admin/inventory?'+q);}})));
  const page=el('div',{id:'inventory-'+id,role:'tabpanel','aria-labelledby':'inventory-tab-'+id,hidden:id!==selected},pager,inventory,
   el('p',{class:'inventory-scope-note',text:isHistory?(customerId?'仅显示明确关联这位客户的历史授权，不计入当前库存统计。':'历史记录仅供核对，不计入当前库存统计。'):customerId?'仅显示这位客户的账号及未分配库存；统计按当前筛选范围计算。':'当前库存包含待核对或暂不可用的授权；已释放、已到期记录请查看历史记录。'}));
  const tab=el('button',{id:'inventory-tab-'+id,type:'button',role:'tab','aria-controls':page.id,'aria-selected':String(id===selected),tabindex:id===selected?'0':'-1',onclick:()=>showPage(id)},label,el('span',{class:'inventory-tab-count',text:number(rows.length)}));
  return {id,page,tab};
 });
 function showPage(id){
  if(query.has('inventory_offset')){const q=new URLSearchParams(location.search);q.delete('inventory_offset');if(id==='history')q.set('view','history');else q.delete('view');navigate('/admin/inventory?'+q);return;}
  for(const item of pages){item.page.hidden=item.id!==id;item.tab.setAttribute('aria-selected',String(item.id===id));item.tab.tabIndex=item.id===id?0:-1;}
  inventoryPanel.querySelector('.card-head p').textContent=descriptions[id];
  const url=new URL(location.href);if(id==='history')url.searchParams.set('view','history');else url.searchParams.delete('view');
  history.replaceState({},'',url.pathname+url.search+url.hash);
  if(allLink)allLink.href='/admin/inventory'+(id==='history'?'?view=history':'');
 }
 const tabs=el('div',{class:'inventory-tabs',role:'tablist','aria-label':'库存记录范围',onkeydown:event=>{
  const index=pages.findIndex(item=>item.tab===event.target);if(index<0)return;
  const next=event.key==='Home'?0:event.key==='End'?pages.length-1:event.key==='ArrowRight'?(index+1)%pages.length:event.key==='ArrowLeft'?(index+pages.length-1)%pages.length:-1;
  if(next<0)return;event.preventDefault();showPage(pages[next].id);pages[next].tab.focus();
 }},pages.map(item=>item.tab));
 const inventoryPanel=panel('账号库存',descriptions[selected],el('div',{},tabs,pages.map(item=>item.page)));
 return el('div',{class:'page-content inventory-page'},allLink,filters,quick,
  el('div',{class:'stats-grid',role:'group','aria-label':'当前库存统计'},stat('可分配',number(current.filter(entry=>entry.assignable).length),'当前筛选范围内可交付的授权','layers'),stat('已分配',number(current.filter(entry=>entry.active&&entry.account.assigned===true).length),'仅统计当前仍有效的客户授权','users')),
  el('div',{class:'batch-toolbar'},el('button',{class:'btn',type:'button',disabled:!canAssign,text:'全选本页可分配账号',onclick:()=>{document.querySelectorAll('#inventory-current input[type=checkbox]:not(:disabled)').forEach(input=>{input.checked=true;input.dispatchEvent(new Event('change'));});}}),el('button',{class:'btn',type:'button',text:'清空选择',onclick:()=>{selectedAccounts.clear();document.querySelectorAll('#inventory-current input[type=checkbox]').forEach(input=>input.checked=false);selectionChanged();}}),batchButton),inventoryPanel,batches);
}
const allocationErrors={customer_not_ready:'客户未就绪或同步待核对',account_changed:'账号或版本已变化',delegation_forbidden:'上游未允许转授',purchase_pending:'被待支付订单占用',allocation_pending:'已有分配待核对',invalid_expiry:'客户期限超过授权上限或已过期',core_conflict:'上游版本冲突',core_outcome_unknown:'上游结果未知',outcome_unknown:'结果未知',process_interrupted:'执行中断，需只读核对'};
function batchTable(batch) {
 return el('div',{},el('p',{class:'inline-info',text:'批次 '+batch.id+' · 成功 '+batch.items.filter(i=>i.status==='succeeded').length+' / '+batch.items.length}),table([{label:'账号',render:i=>i.account_code||i.intent.account_lease_id},{label:'客户',render:i=>i.customer_name||el('a',{href:'/admin/customers?user_id='+encodeURIComponent(i.intent.user_id),text:'查看客户'})},{label:'状态',render:i=>({ready:'可执行',pending:'未执行',running:'执行中',succeeded:'已分配',failed:'明确失败',review:'结果待核对',cancelled:'已取消'}[i.status]||i.status)},{label:'结果',render:i=>i.error?(allocationErrors[i.error]||i.error):i.grant_id||'—'}],batch.items,'没有批次记录'));
}
async function batchHistory() {
 const offset=Math.max(0,Number(new URLSearchParams(location.search).get('batch_offset'))||0),data=await api('/api/admin/allocation-batches?limit=20&offset='+offset),rows=collection(data,'batches');
 const panelBody=el('div',{},el('div',{class:'pager'},el('span',{text:'全站共 '+data.total+' 批 · 第 '+(Math.floor(offset/20)+1)+' 页'}),...[-20,20].map(delta=>el('button',{class:'btn small',text:delta<0?'上一页批次':'下一页批次',disabled:delta<0?offset===0:offset+20>=data.total,onclick:()=>{const query=new URLSearchParams(location.search);query.set('batch_offset',String(Math.max(0,offset+delta)));navigate('/admin/inventory?'+query);}}))),table([{label:'创建时间',render:b=>date(b.created_at)},{label:'数量 / 状态',render:b=>b.items.length+' 项 · '+({complete:'已结束',pending:'待执行',review:'待核对',running:'执行中'}[b.status]||b.status)},{label:'操作',render:b=>el('button',{class:'btn small',text:'查看批次',onclick:()=>{
   const host=el('div',{},batchTable(b)),feedback=el('div',{}),form=el('div',{},host,feedback);const dialog=editorDialog('分配批次',form);
   const controls=el('div',{class:'button-row'},...['execute','reconcile','cancel'].map(action=>el('button',{class:'btn small',type:'button',disabled:!managementAllows(state.user,'POST','/api/admin/allocation-batches'),text:{execute:'继续未执行项',reconcile:'核对分配结果',cancel:'取消未执行项'}[action],onclick:async event=>{
    const clicked=event.currentTarget;
    if(action!=='reconcile'&&!await confirmAction('确认批次操作',action==='execute'?'只执行尚未执行的项目；不会重复成功或未知项目。':'只取消未执行项，不收回已分配账号。','确认'))return;
    clicked.disabled=true;try{const result=await api('/api/admin/allocation-batches',{method:'POST',body:{id:b.id,action}});b=result.batch;host.replaceChildren(batchTable(b));feedback.replaceChildren();}catch(error){feedback.replaceChildren(errorNotice(error));}finally{if(controls.isConnected)controls.querySelectorAll('button').forEach(button=>button.disabled=false);}
   }})),el('button',{class:'btn small',text:'导出批次结果',onclick:()=>{
    const cell=v=>'"'+String(v??'').replace(/^[=+@-]/,"'$&").replaceAll('"','""')+'"';const csv=[['批次','账号','客户 ID','客户期限','状态','错误'],...b.items.map(i=>[b.id,i.account_code||i.intent.account_lease_id,i.intent.user_id,i.intent.expires_at,i.status,i.error])].map(row=>row.map(cell).join(',')).join('\r\n');const url=URL.createObjectURL(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'}));const a=el('a',{href:url,download:'allocation-'+b.id+'.csv'});a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
   }}));form.append(controls);dialog.addEventListener('close',()=>render(),{once:true});
  }})}],rows,'暂无分配批次','新的分配将在这里保留逐项结果。'));
 return panel('分配批次','全站单条与批量交付记录。成功项不重放，未知项只读核对。',panelBody);
}
async function allocationEditor(accounts,customerId=null) {
 try{
  if(accounts.length>100)throw new Error('每批最多选择 100 个账号，请缩小筛选范围。');
  const picker=await customerPicker(customerId||''),mode=field('分配方式','mode',{type:'select',choices:[{value:'same',label:'分配给同一客户'},{value:'mapped',label:'逐项指定客户'}]}),expires=field('客户到期时间','expires_at',{type:'datetime-local',hint:'留空沿用各账号授权期限；不会静默截短超限期限。'});
  const mapping=el('div',{hidden:true}),feedback=el('div',{}),results=el('div',{}),preview=el('button',{class:'btn',type:'button',text:'预检分配'}),submit=el('button',{class:'btn primary',type:'submit',text:'确认分配'}),reconcile=el('button',{class:'btn',type:'button',hidden:true,text:'核对分配结果'});
  const form=el('form',{},notice(accounts.length===1?(accounts[0].account_code||accounts[0].details?.name):'批量分配',accounts.length+' 个账号；只交付已获授权的账号。'),mode,picker,expires,mapping,feedback,results,el('div',{class:'button-row'},preview,submit,reconcile));
  const dialog=editorDialog('分配客户',form);let busy=false,id=crypto.randomUUID(),saved=null,individual=[];
  mode.querySelector('select').addEventListener('change',async event=>{const separate=event.target.value==='mapped';mapping.hidden=!separate;picker.hidden=separate;expires.hidden=separate;picker.querySelectorAll('input,select').forEach(n=>n.disabled=separate);expires.querySelectorAll('input,select').forEach(n=>n.disabled=separate);mapping.querySelectorAll('input,select').forEach(n=>n.disabled=!separate);if(separate&&!individual.length){submit.disabled=preview.disabled=true;try{individual=await Promise.all(accounts.map(async a=>({account:a,picker:await customerPicker(customerId||''),expiry:field('客户到期时间','expires_at',{type:'datetime-local'})})));mapping.replaceChildren(...individual.map(i=>el('section',{class:'allocation-mapping'},el('h3',{text:i.account.account_code||i.account.details?.name||i.account.id}),i.picker,i.expiry)));mapping.querySelectorAll('input,select').forEach(n=>n.disabled=mode.querySelector('select').value!=='mapped');}catch(error){feedback.replaceChildren(errorNotice(error));}finally{submit.disabled=preview.disabled=busy;}}});
  const readIntent=()=>accounts.map((a,index)=>{const individualMode=mode.querySelector('select').value==='mapped',selected=individualMode?individual[index]:null;if(individualMode&&!selected)throw new Error('客户列表尚未准备好。');const user_id=(selected?.picker||picker).querySelector('select[name=user_id]').value,raw=(selected?.expiry||expires).querySelector('input').value;if(!user_id)throw new Error('请为每个账号选择客户。');const stamp=raw?Date.parse(raw):Date.parse(a.expires_at);if(!Number.isFinite(stamp)||stamp<=Date.now()||stamp>Date.parse(a.expires_at))throw new Error('客户期限必须在未来，且不能超过账号授权期限。');return {user_id,resource_id:a.resource_id,account_lease_id:a.id,expected_account_revision:a.revision,expires_at:new Date(stamp).toISOString()};});
  async function run(action){
   if(busy)return;busy=true;form.setAttribute('aria-busy','true');const controls=[...form.querySelectorAll('input,select,button')].map(node=>[node,node.disabled]);controls.forEach(([node])=>node.disabled=true);feedback.replaceChildren();
   try{
    const items=saved||readIntent();
    if(!saved&&action==='execute'){
     const result=await api('/api/admin/allocation-batches',{method:'POST',body:{id,action:'preview',items}});results.replaceChildren(batchTable(result.batch));if(!result.batch.ready)throw new Error('预检发现不可分配项，请调整后重新预检。');
     if(accounts.length>1&&!await confirmAction('确认批量分配','将按预检的客户、账号和期限逐项交付；部分失败不会撤回已成功项目。','确认分配'))return;
    }
    if(action==='execute')saved=items;
    const result=await api('/api/admin/allocation-batches',{method:'POST',body:{id,action,...(action==='preview'||!results.dataset.saved?{items}:{})}});const batch=result.batch;results.replaceChildren(batchTable(batch));
    if(!batch.preview){results.dataset.saved='true';saved=items;reconcile.hidden=false;submit.textContent='继续未执行项';
     if(batch.items.every(i=>i.status==='succeeded')){dialog.close();toast('账号已分配给客户');await render();return;}
     if(batch.status==='complete'){saved=null;id=crypto.randomUUID();submit.textContent='重新预检失败项';feedback.replaceChildren(notice('此批次已结束','请关闭后仅选择失败项重新分配；成功项不会重复执行。','warn'));submit.hidden=true;feedback.append(el('button',{class:'btn',type:'button',text:'为失败项新建分配',onclick:async()=>{const fresh=collection(await api('/api/admin/inventory'),'accounts');const failed=new Set(batch.items.filter(i=>i.status==='failed').map(i=>i.intent.account_lease_id));const remaining=fresh.filter(a=>failed.has(a.id));dialog.close();if(remaining.length)await allocationEditor(remaining,customerId);}}));}
    }
   }catch(error){feedback.replaceChildren(errorNotice(error));if(!error.uncertain&&!results.dataset.saved){saved=null;id=crypto.randomUUID();}else if(saved){reconcile.hidden=false;submit.textContent='继续未执行项';}}
   finally{busy=false;form.removeAttribute('aria-busy');controls.forEach(([node,disabled])=>node.disabled=disabled||Boolean(saved)&&['INPUT','SELECT'].includes(node.tagName));preview.disabled=Boolean(saved);submit.disabled=false;reconcile.disabled=false;}
  }
  form.addEventListener('submit',event=>{event.preventDefault();void run('execute');});preview.addEventListener('click',()=>run('preview'));reconcile.addEventListener('click',()=>run('reconcile'));
  dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});dialog.querySelector('[aria-label="关闭对话框"]').addEventListener('click',event=>{if(busy){event.preventDefault();event.stopImmediatePropagation();}},true);
 }catch(error){document.getElementById('page-feedback')?.replaceChildren(errorNotice(error));}
}
function extendCustomerAccount(account){
 const input=field('新的客户到期时间','expires_at',{type:'datetime-local',required:true,min:localDateTime(Math.max(Date.now(),Date.parse(account.customer_expires_at))+60000),max:localDateTime(account.expires_at)});
 const preview=el('div',{class:'inline-info','aria-live':'polite'}),control=input.querySelector('input');
 let chosenExpiry=null;
 const update=()=>{preview.textContent='原客户期限：'+date(account.customer_expires_at)+' → 新客户期限：'+date(chosenExpiry||control.value)+'；授权上限：'+date(account.expires_at);};
 const shortcuts=el('div',{class:'button-row'},[7,30].map(days=>el('button',{type:'button',class:'btn small',text:'延长 '+days+' 天',disabled:!renewalExpiry(account,days),title:'从原期限与当前时间中较晚者起算；不能超过上游授权期限。',onclick:()=>{const end=renewalExpiry(account,days);if(end){chosenExpiry=end;control.value=localDateTime(end);update();}}})));
 const form=el('form',{},notice(account.details?.name||'账号','客户：'+(account.customer_name||account.customer_email||'当前客户')+'。快捷延长按 24 小时计一天；超过授权上限的选项不可用。'),shortcuts,input,preview,el('button',{class:'btn primary',type:'submit',text:'确认延长'}));
 control.addEventListener('input',()=>{chosenExpiry=null;update();});update();
 const dialog=editorDialog('延长客户有效期',form);
 bindForm(form,async values=>{
   const stamp=Date.parse(chosenExpiry||values.get('expires_at'));
   if(!Number.isFinite(stamp)||stamp<=Math.max(Date.now(),Date.parse(account.customer_expires_at))||stamp>Date.parse(account.expires_at))throw new Error('新的到期时间必须晚于原期限，且不能超过账号到期时间。');
   if(!await confirmAction('确认客户续期','将「'+(account.customer_name||'当前客户')+'」的「'+(account.details?.name||'账号')+'」从 '+date(account.customer_expires_at)+' 延长至 '+date(stamp)+'。不会延长上游授权，也不会自动收款。','确认续期'))return CANCEL;
   return api('/api/admin/grants/'+encodeURIComponent(account.grant_id),{method:'PATCH',body:{expected_revision:account.grant_revision,expires_at:new Date(stamp).toISOString()}});
 },()=>{dialog.close();toast('客户有效期已由服务器确认');render();});
}
