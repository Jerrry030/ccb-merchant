import { el } from './dom.js';
import { api, collection } from './api.js';
import { date, number } from './format.js';
import { badge, notice, panel, table, stat } from './ui.js';
import { actionButton } from './ui-form.js';
export async function operationsView() {
 const data=await api('/api/admin/operations');
 const tasks=collection(data,'pending_customers');
 const unassigned=collection(data,'unassigned_customers');
 return el('div',{class:'page-content'},
 el('div',{class:'stats-grid'},stat('待分配客户',data.inventory_available===false?'未知':number(data.unassigned_total??unassigned.length),'没有当前有效账号；列表最多 100 位','users'),stat('待同步客户',number(tasks.length),'本页最多列出 100 个','users'),el('a',{class:'operation-link',href:'/admin/orders?status=needs_review'},stat('待确认支付',number(data.payments_pending),'查看全部待确认支付 →','wallet')),el('a',{class:'operation-link',href:'/admin/rentals?status=needs_review'},stat('待核对交付',number(data.deliveries_pending),'包含待核对交付和退款核对中 →','receipt'))),
 data.inventory_available===false?notice('库存读取失败','无法确认待分配客户数量，不能按零处理。','warn'):null,
 panel('待分配账号','这些客户已经可以登录，但还没有分配账号。已下单未交付的，请同时到订单的交付分区核对。',table([{label:'客户',render:u=>el('div',{},el('strong',{text:u.display_name||'未命名客户'}),el('span',{class:'table-sub',text:u.email}))},{label:'注册时间',render:u=>date(u.created_at)},{label:'操作',render:u=>el('a',{class:'btn small',href:`/admin/inventory?user_id=${encodeURIComponent(u.id)}`,text:'查看与分配账号'})}],unassigned,'没有待分配客户','新注册并可以登录的客户，在分配账号前会显示在这里。')),
 panel('客户同步待办','停用尚未确认时，会暂停该客户的新运行请求，直到上游确认。',table([{label:'客户',render:u=>u.display_name},{label:'状态',render:u=>badge(u.status)},{label:'提示',render:u=>u.sync_error||'等待同步'},{label:'操作',render:u=>actionButton('重新核对',()=>api(`/api/admin/users/${encodeURIComponent(u.id)}${u.core_customer_id?'':'/provision'}`,{method:u.core_customer_id?'PATCH':'POST',body:{}}))}],tasks,'没有待同步客户','当前没有持久化客户同步待办。')),
 el('p',{class:'inline-info'},'邮件、支付和公开地址是否已配置，请在',el('a',{href:'/admin/settings#payment',text:'支付配置'}),'中查看。'),el('a',{class:'btn',href:'/admin/rentals?status=needs_review',text:'处理交付待办 →'}));
}
