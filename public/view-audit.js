import { auditActions, auditOutcomes, localDateTime } from './admin-workflow.js';
import { el } from './dom.js';
import { api, collection } from './api.js';
import { date } from './format.js';
import { navigate } from './router.js';
import { toast, notice, panel, table, listPager } from './ui.js';
import { field } from './ui-form.js';
export async function auditView() {
  const params=new URLSearchParams(location.search),query=new URLSearchParams(params);query.delete('return_to');query.set('limit','50');
  const data=await api('/api/admin/audit?'+query),events=collection(data,'events');
  const form=el('form',{class:'admin-filters'},field('搜索人员或目标','q',{value:params.get('q')||'',placeholder:'姓名、邮箱或技术标识'}),field('操作类型','action',{type:'select',value:params.get('action')||'',choices:[{value:'',label:'全部操作'},...data.actions.map(value=>({value,label:auditActions[value]||value}))]}),field('操作结果','outcome',{type:'select',value:params.get('outcome')||'',choices:[{value:'',label:'全部结果'},...data.outcomes.map(value=>({value,label:auditOutcomes[value]||value}))]}),field('开始时间','from',{type:'datetime-local',value:params.get('from')?localDateTime(params.get('from')):''}),field('结束时间','to',{type:'datetime-local',value:params.get('to')?localDateTime(params.get('to')):''}),el('button',{class:'btn',type:'submit',text:'查询审计'}));
  const feedback=el('div',{role:'alert'});
  form.addEventListener('submit',event=>{
    event.preventDefault();const values=new FormData(form),next=new URLSearchParams(params);next.delete('offset');
    if(values.get('from')&&values.get('to')&&Date.parse(values.get('from'))>Date.parse(values.get('to'))){feedback.replaceChildren(notice('时间范围不正确','开始时间不能晚于结束时间。','warn'));return;}
    for(const [key,value] of values){if(value)next.set(key,['from','to'].includes(key)?new Date(value).toISOString():value);else next.delete(key);}navigate('/admin/audit?'+next);
  });
  const records=table([
    {label:'时间',render:e=>date(e.created_at)},
    {label:'业务操作',render:e=>auditActions[e.action]||e.action},
    {label:'操作者',render:e=>el('div',{},e.actor_name||(!e.actor_id?'系统':'身份名称未提供'),el('span',{class:'table-sub',text:e.actor_email||''}))},
    {label:'关联客户 / 目标',render:e=>el('div',{},e.resolved_customer_id?el('a',{href:'/admin/customers?user_id='+encodeURIComponent(e.resolved_customer_id),text:e.customer_name||e.customer_email||'查看客户'}):el('span',{text:'未关联客户'}),e.subject_name?el('span',{class:'table-sub',text:e.subject_name}):null)},
    {label:'结果',render:e=>el('span',{class:'badge '+(['failed','unknown','delivery_unknown','core_pending'].includes(e.outcome)?'warn':''),text:auditOutcomes[e.outcome]||e.outcome||'结果未提供'})},
    {label:'变更明细',render:e=>{let d={};try{d=JSON.parse(e.details||'{}');}catch{}return el('details',{},el('summary',{text:d.reason||'查看变更'}),d.before?el('pre',{class:'audit-change',text:JSON.stringify({变更前:d.before,变更后:d.after},null,2)}):null,d.batch_id?el('p',{text:'批次：'+d.batch_id}):null,d.temporary_password?el('p',{text:'设置临时密码；未记录密码内容'}):null);}},
    {label:'技术标识',render:e=>el('details',{},el('summary',{text:'查看标识'}),el('div',{class:'audit-identifiers'},el('p',{class:'mono',text:'操作：'+e.action}),el('p',{class:'mono',text:'操作者：'+(e.actor_id||'系统')}),el('p',{class:'mono',text:'目标：'+(e.subject_id||'—')}),el('button',{type:'button',class:'btn small',text:'复制标识',onclick:async()=>{try{await navigator.clipboard.writeText('事件 '+e.id+'\n操作 '+e.action+'\n操作者 '+(e.actor_id||'系统')+'\n目标 '+(e.subject_id||'—'));toast('审计标识已复制');}catch{toast('无法访问剪贴板，请选中标识手动复制');}}})))},
  ],events,'暂无审计记录','当前筛选范围没有记录；可调整条件查询更早记录。');records.classList.add('rental-table');
  return el('div',{class:'page-content'},form,feedback,
    panel('操作审计','时间按本机时区显示。姓名按当前资料解析；新授权操作保留当时的账号名称，无法关联的旧记录不猜测归属。',records),listPager(data,params,'/admin/audit'));
}
