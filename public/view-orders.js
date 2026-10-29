import { paymentReviewStatuses, deliveryReviewStatuses } from './admin-workflow.js';
import { el } from './dom.js';
import { state } from './state.js';
import { api, collection } from './api.js';
import { date, money } from './format.js';
import { navigate } from './router.js';
import { badge, notice, panel, table, listPager } from './ui.js';
import { CANCEL, field, confirmAction, actionButton } from './ui-form.js';
export function orderTable(orders, showCustomer = false) {
  return table([...(showCustomer ? [{label:'客户',render:o => el('div',{},el('a',{href:'/admin/customers?user_id='+encodeURIComponent(o.user_id),text:o.customer_name||o.user_id||'未提供'}),el('span',{class:'table-sub',text:o.customer_email||''}))}] : []),{label:'订单编号',render:o => el('span',{class:'mono',text:o.id})},{label:'支付方式',render:o=>({stripe:'Stripe',alipay:'支付宝',wxpay:'微信支付',airwallex:'Airwallex'}[o.payment_method]||'Stripe')},{label:'用途',render:o=>o.rental_id?'套餐支付':'余额充值'},{label:'金额',render:o => money(o.amount_minor,o.currency)},{label:'支付状态',render:o => badge(o.status)},{label:'创建时间',render:o => date(o.created_at)},{label:'操作',render:o=>paymentReviewStatuses.includes(o.status)?el('div',{class:'button-row'},actionButton('核对支付',()=>api(`/api/${showCustomer?'admin':'me'}/payments/${encodeURIComponent(o.id)}/reconcile`,{method:'POST',body:{}})),showCustomer?null:el('a',{class:'btn small',href:'/wallet?order='+encodeURIComponent(o.id),text:'继续支付'})):'—'}],orders,'暂无支付订单','只有服务器创建的真实支付订单才会出现在这里。');
}
export async function ordersView() {
  const params=new URLSearchParams(location.search),query=new URLSearchParams(params);query.delete('return_to');query.set('limit','30');
  const data=await api('/api/admin/orders?'+query),orders=collection(data,'orders'),userId=params.get('user_id');
  const form=el('form',{class:'admin-filters'},field('订单或客户','q',{value:query.get('q')||''}),field('支付状态','status',{type:'select',value:query.get('status')||'',choices:[['','全部'],['needs_review','全部待确认'],['creating','创建中'],['pending','待支付'],['unknown','结果未知'],['paid','已支付'],['expired','已过期'],['failed','失败']].map(([value,label])=>({value,label}))}),el('button',{class:'btn',type:'submit',text:'筛选支付'}));
  form.addEventListener('submit',event=>{event.preventDefault();const next=new URLSearchParams(params);next.delete('offset');for(const [key,value] of new FormData(form)){if(value)next.set(key,value);else next.delete(key);}navigate('/admin/orders?'+next);});
  return el('div',{class:'page-content'},userId?null:el('a',{href:'/admin/operations',class:'btn small',text:'返回待办'}),form,
    state.public.features.payment!==true?notice('在线支付未启用','仍可核对已有订单，不会模拟收款或提供手工入账。','warn'):null,
    panel('支付订单','按服务端状态核对，待确认包括创建中、待支付和结果未知。',orderTable(orders,true)),listPager(data,params,'/admin/orders','笔'));
}
export async function rentalsView() {
 const admin=location.pathname==='/admin/rentals',base=admin?'/admin/rentals':'/orders',endpoint=admin?'/api/admin/rentals':'/api/me/rentals';
 const params=new URLSearchParams(location.search),query=new URLSearchParams(params);query.delete('order');query.delete('return_to');query.set('limit','30');
 const data=await api(`${endpoint}?${query}`),rows=collection(data,'rentals');
 const filters=el('form',{class:'button-row'},field('订单或套餐','q',{value:query.get('q')||''}),field('交付状态','status',{type:'select',choices:[{value:'',label:'全部'},{value:'needs_review',label:'全部待核对（含退款）'},...['awaiting_payment','queued','review','fulfilled','refund_pending','refunded','cancelled'].map(value=>({value,label:{awaiting_payment:'待支付',queued:'待开通',review:'待核对',fulfilled:'已交付',refund_pending:'退款核对中',refunded:'已退回余额',cancelled:'已取消'}[value]}))],value:query.get('status')||''}),el('button',{class:'btn',type:'submit',text:'筛选'}));
 filters.addEventListener('submit',event=>{event.preventDefault();const v=new FormData(filters);const next=new URLSearchParams(params);next.delete('offset');next.set('q',v.get('q'));next.set('status',v.get('status'));navigate(base+'?'+next);});
 const columns=[{label:'订单 / 套餐',render:o=>el('div',{},el('strong',{text:o.name}),el('p',{class:'mono muted',text:o.id}))},...(admin?[{label:'客户',render:o=>el('div',{},el('a',{href:'/admin/customers?user_id='+encodeURIComponent(o.user_id),text:o.customer_name||o.user_id}),el('span',{class:'table-sub',text:o.customer_email||''}))}]:[]),{label:'价格 / 租期',render:o=>`${money(o.amount_minor)} / ${o.duration_days} 天`},{label:'交付状态',render:o=>el('div',{},badge(o.status),o.last_error?el('p',{class:'muted',text:o.last_error}):null)},{label:'已交付期限',render:o=>date(o.expires_at)},{label:'操作',render:o=>{
  const actions=el('div',{class:'button-row'});
  if(o.payment_order_id&&o.payment_status!=='paid')actions.append(actionButton('核对支付',()=>api(`/api/${admin?'admin':'me'}/payments/${encodeURIComponent(o.payment_order_id)}/reconcile`,{method:'POST',body:{}})));
  if(!admin&&o.payment_order_id&&o.status==='awaiting_payment')actions.append(el('a',{class:'btn small',href:'/wallet?order='+encodeURIComponent(o.payment_order_id),text:'继续支付'}));
  if(admin&&['queued',...deliveryReviewStatuses].includes(o.status))for(const action of (o.status==='refund_pending'?['refund']:['retry','refund']))actions.append(actionButton(action==='retry'?'重新核对':'退回余额',async()=>{
   if(!await confirmAction(action==='retry'?'重新核对订单':'退回未交付款项',action==='retry'?'将按原订单编号核对上游回执，不重复增加租期。':'仅在上游确认没有交付后，将订单全额退回余额，不是支付渠道原路退款。','确认执行',action==='refund'))return CANCEL;
   return api(`/api/admin/rentals/${encodeURIComponent(o.id)}/resolve`,{method:'POST',body:{action,expected_revision:o.revision}});
  },{danger:action==='refund'}));
  return actions;
 }}];
 const exportButton=el('button',{class:'btn small',text:'导出本页 CSV',onclick:()=>{
  const cell=v=>`"${String(v??'').replace(/^[=+@\-\t\r]/,"' $&").replaceAll('"','""')}"`;
  const csv='\uFEFF'+[['订单','套餐','金额分','币种','天数','状态','到期时间'],...rows.map(r=>[r.id,r.name,r.amount_minor,r.currency,r.duration_days,r.status,r.expires_at])].map(r=>r.map(cell).join(',')).join('\r\n');
  const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));const link=el('a',{href:url,download:'rental-orders.csv'});link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }});
 const pager=listPager(data,params,base,'笔');
 const rentalTable=table(columns,rows);rentalTable.classList.add('rental-table');
 return el('div',{class:'page-content'},admin&&!params.get('user_id')?el('a',{href:'/admin/operations',class:'btn small',text:'返回待办'}):null,filters,panel('套餐订单','价格、租期和购买身份以下单快照为准。',rentalTable,exportButton),pager);
}
