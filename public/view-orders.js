import { paymentReviewStatuses, deliveryReviewStatuses } from './admin-workflow.js';
import { el } from './dom.js';
import { state } from './state.js';
import { api, collection } from './api.js';
import { date, money } from './format.js';
import { navigate } from './router.js';
import { badge, notice, panel, table, listPager, emptyState } from './ui.js';
import { CANCEL, field, confirmAction, actionButton } from './ui-form.js';

export function orderTable(orders, {admin=false,recharge=false}={}) {
  return table([
    ...(admin?[{label:'客户',render:o=>el('div',{},el('a',{href:'/admin/customers?user_id='+encodeURIComponent(o.user_id),text:o.customer_name||o.user_id||'未提供'}),el('span',{class:'table-sub',text:o.customer_email||''}))}]:[]),
    {label:'订单编号',render:o=>el('span',{class:'mono',text:o.id})},
    {label:'支付方式',render:o=>({stripe:'Stripe',alipay:'支付宝',wxpay:'微信支付',airwallex:'Airwallex'}[o.payment_method]||'未提供')},
    ...(recharge?[]:[{label:'用途',render:o=>o.rental_id?'套餐支付':'余额充值'}]),
    {label:'金额',render:o=>money(o.amount_minor,o.currency)},
    {label:'支付状态',render:o=>badge(o.status)},
    ...(recharge?[{label:'入账状态',render:o=>o.credited===true?'已入账':o.credited===false?'未入账':'待核对'}]:[]),
    {label:'创建时间',render:o=>date(o.created_at)},
    {label:'操作',render:o=>admin?(paymentReviewStatuses.includes(o.status)?actionButton('核对支付',()=>api('/api/admin/payments/'+encodeURIComponent(o.id)+'/reconcile',{method:'POST',body:{}})):'—'):
      el('a',{class:'btn small',href:'/checkout?order='+encodeURIComponent(o.id),text:o.status==='pending'?'继续支付':paymentReviewStatuses.includes(o.status)?'核对订单':'查看详情'})},
  ],orders,recharge?'暂无充值订单':'暂无支付订单','只有服务器创建的真实订单才会显示在这里。');
}

export async function ordersView() {
  const params=new URLSearchParams(location.search),query=new URLSearchParams(params);query.delete('return_to');query.set('limit','30');
  const data=await api('/api/admin/orders?'+query),orders=collection(data,'orders'),userId=params.get('user_id');
  const form=el('form',{class:'admin-filters'},field('订单或客户','q',{value:query.get('q')||''}),field('支付状态','status',{type:'select',value:query.get('status')||'',choices:[['','全部'],['needs_review','全部待确认'],['creating','创建中'],['pending','待支付'],['unknown','结果未知'],['paid','已支付'],['expired','已过期'],['failed','失败']].map(([value,label])=>({value,label}))}),el('button',{class:'btn',type:'submit',text:'筛选支付'}));
  form.addEventListener('submit',event=>{event.preventDefault();const next=new URLSearchParams(params);next.delete('offset');for(const [key,value] of new FormData(form)){if(value)next.set(key,value);else next.delete(key);}navigate('/admin/orders?'+next);});
  return el('div',{class:'page-content'},userId?null:el('a',{href:'/admin/operations',class:'btn small',text:'返回待办'}),form,
    state.public.features.payment!==true?notice('在线支付未启用','仍可核对已有订单，不会模拟收款或提供手工入账。','warn'):null,
    panel('支付订单','支付与套餐交付分别核对。',orderTable(orders,{admin:true})),listPager(data,params,'/admin/orders','笔'));
}

export async function rentalsView() {
  const admin=location.pathname==='/admin/rentals',base=admin?'/admin/rentals':'/orders';
  const params=new URLSearchParams(location.search),recharge=!admin&&params.get('type')==='recharge';
  if(!admin&&params.get('rental')) {
    const id=params.get('rental'),data=await api('/api/me/rentals?id='+encodeURIComponent(id));
    const rental=collection(data,'rentals').find(row=>row.id===id);
    if(!rental)return emptyState('没有找到套餐订单','请核对订单编号及当前登录账户。','receipt',el('a',{class:'btn',href:'/orders',text:'返回套餐订单'}));
    const facts=el('dl',{class:'checkout-facts'},
      el('dt',{text:'订单编号'}),el('dd',{class:'mono',text:rental.id}),el('dt',{text:'套餐'}),el('dd',{text:rental.name}),
      el('dt',{text:'购买快照'}),el('dd',{text:money(rental.amount_minor,rental.currency)+' / '+rental.duration_days+' 天'}),
      el('dt',{text:'登录平台'}),el('dd',{text:rental.platform||'未提供'}),el('dt',{text:'购买类型'}),el('dd',{text:rental.renew_grant_id?'原账号续期':'新购账号'}),
      el('dt',{text:'支付状态'}),el('dd',{},rental.payment_status?badge(rental.payment_status):'未确认'),el('dt',{text:'交付状态'}),el('dd',{},badge(rental.status)),
      el('dt',{text:'已交付期限'}),el('dd',{text:date(rental.expires_at)}));
    return el('div',{class:'page-content rental-detail'},el('a',{class:'btn small',href:'/orders',text:'返回套餐订单'}),
      panel('套餐订单详情','价格与租期以下单快照为准。',el('div',{class:'card-body'},facts,
        rental.last_error?notice('订单核对信息',rental.last_error,'warn'):null,
        rental.status==='refunded'?notice('已退回钱包余额','这不是支付渠道的原路退款。','warn'):null,
        el('div',{class:'button-row'},rental.payment_order_id?el('a',{class:'btn',href:'/checkout?order='+encodeURIComponent(rental.payment_order_id),text:rental.status==='awaiting_payment'?'继续支付':'查看支付订单'}):null,
          el('a',{class:'btn',href:'/accounts',text:'查看我的账号'})))));
  }
  const query=new URLSearchParams();
  for(const key of ['q','status','offset',...(admin?['user_id']:[])])if(params.get(key))query.set(key,params.get(key));
  query.set('limit','30');if(recharge)query.set('purpose','recharge');
  const endpoint=admin?'/api/admin/rentals':recharge?'/api/me/orders':'/api/me/rentals';
  const data=await api(endpoint+'?'+query),rows=collection(data,recharge?'orders':'rentals');
  const statuses=recharge?[['creating','创建中'],['pending','待支付'],['unknown','结果未知'],['paid','已支付'],['expired','已过期'],['failed','失败']]:[['awaiting_payment','待支付'],['queued','待开通'],['review','待核对'],['fulfilled','已交付'],['refund_pending','退款核对中'],['refunded','已退回余额'],['cancelled','已取消']];
  const filters=el('form',{class:'button-row'},field(recharge?'充值订单':'订单或套餐','q',{value:query.get('q')||''}),field(recharge?'支付状态':'交付状态','status',{type:'select',choices:[{value:'',label:'全部'},{value:'needs_review',label:recharge?'全部待确认':'全部待核对（含退款）'},...statuses.map(([value,label])=>({value,label}))],value:query.get('status')||''}),el('button',{class:'btn',type:'submit',text:'筛选'}));
  filters.addEventListener('submit',event=>{event.preventDefault();const values=new FormData(filters),next=new URLSearchParams(params);next.delete('offset');for(const [key,value]of values){if(value)next.set(key,value);else next.delete(key);}navigate(base+'?'+next);});
  if(recharge)return el('div',{class:'page-content'},filters,panel('充值订单','支付成功与实际入账分别显示。',orderTable(rows,{recharge:true})),listPager(data,params,base,'笔'));
  const columns=[{label:'订单 / 套餐',render:o=>el('div',{},el('strong',{text:o.name}),el('p',{class:'mono muted',text:o.id}))},
    ...(admin?[{label:'客户',render:o=>el('div',{},el('a',{href:'/admin/customers?user_id='+encodeURIComponent(o.user_id),text:o.customer_name||o.user_id}),el('span',{class:'table-sub',text:o.customer_email||''}))}]:[]),
    {label:'价格 / 租期',render:o=>money(o.amount_minor,o.currency)+' / '+o.duration_days+' 天'},
    {label:'支付状态',render:o=>o.payment_status?badge(o.payment_status):'未确认'},
    {label:'交付状态',render:o=>el('div',{},badge(o.status),o.last_error?el('p',{class:'muted',text:o.last_error}):null)},
    {label:'已交付期限',render:o=>date(o.expires_at)},
    {label:'操作',render:o=>{
      const actions=el('div',{class:'button-row'});
      if(!admin)actions.append(el('a',{class:'btn small',href:'/orders?rental='+encodeURIComponent(o.id),text:'查看详情'}));
      if(o.payment_order_id&&o.payment_status!=='paid')actions.append(actionButton('核对支付',()=>api('/api/'+(admin?'admin':'me')+'/payments/'+encodeURIComponent(o.payment_order_id)+'/reconcile',{method:'POST',body:{}})));
      if(!admin&&o.payment_order_id&&o.status==='awaiting_payment')actions.append(el('a',{class:'btn small',href:'/checkout?order='+encodeURIComponent(o.payment_order_id),text:'继续支付'}));
      if(admin&&['queued',...deliveryReviewStatuses].includes(o.status))for(const action of(o.status==='refund_pending'?['refund']:['retry','refund']))actions.append(actionButton(action==='retry'?'重新核对':'退回余额',async()=>{
        if(!await confirmAction(action==='retry'?'重新核对订单':'退回未交付款项',action==='retry'?'将按原订单编号核对上游回执，不重复增加租期。':'仅在上游确认没有交付后，将订单全额退回余额，不是支付渠道原路退款。','确认执行',action==='refund'))return CANCEL;
        return api('/api/admin/rentals/'+encodeURIComponent(o.id)+'/resolve',{method:'POST',body:{action,expected_revision:o.revision}});
      },{danger:action==='refund'}));
      return actions;
    }}];
  const exportButton=el('button',{class:'btn small',text:'导出本页 CSV',onclick:()=>{
    const cell=value=>'"'+String(value??'').replace(/^[=+@\-\t\r]/,"' $&").replaceAll('"','""')+'"';
    const csv='\uFEFF'+[['订单','套餐','金额分','币种','天数','状态','到期时间'],...rows.map(row=>[row.id,row.name,row.amount_minor,row.currency,row.duration_days,row.status,row.expires_at])].map(row=>row.map(cell).join(',')).join('\r\n');
    const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'})),link=el('a',{href:url,download:'rental-orders.csv'});link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }});
  const rentalTable=table(columns,rows);rentalTable.classList.add('rental-table');
  return el('div',{class:'page-content'},admin&&!params.get('user_id')?el('a',{href:'/admin/operations',class:'btn small',text:'返回待办'}):null,filters,panel('套餐订单','支付与交付分别确认，价格和租期以下单快照为准。',rentalTable,exportButton),listPager(data,params,base,'笔'));
}
