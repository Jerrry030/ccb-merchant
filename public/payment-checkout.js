import { el } from './dom.js';
import { api } from './api.js';
import { notice, errorNotice } from './ui.js';

export function paymentCheckout(payment,{onSettled}={}) {
  const order=payment.order;
  if(!order?.id||!/^[A-Za-z0-9_-]{1,100}$/.test(order.id))throw new Error('支付订单信息不完整。');
  const status=el('div',{'aria-live':'polite'},notice('支付订单已创建，尚不代表已付款','订单 '+order.id+'。付款后由服务器确认结果。'));
  const actions=el('div',{class:'button-row'}),details=el('div',{class:'payment-checkout-details'});
  if(payment.checkout_url) {
    let url;try{url=new URL(payment.checkout_url);}catch{}
    const expected=order.provider==='easypay'?payment.checkout_origin:'https://checkout.stripe.com';
    if(!url||url.protocol!=='https:'||url.origin!==expected||url.username||url.password||/[\u0000-\u0020\u007f]/.test(payment.checkout_url))return notice('订单已记录，但支付链接不可安全使用','请联系管理员核对，不要重复创建订单。','warn');
    details.append(el('p',{class:'inline-info',text:'将前往外部收银台：'+url.origin}));
    actions.append(el('a',{class:'btn primary checkout-link',href:url.href,target:'_blank',rel:'noopener noreferrer',referrerpolicy:'no-referrer',text:'前往支付收银台 ↗'}));
  }
  if(payment.qr_available)details.append(el('div',{class:'payment-qr'},el('img',{src:'/api/me/payments/'+encodeURIComponent(order.id)+'/qr.svg',alt:'支付二维码',width:280,height:280}),el('p',{text:'请使用对应支付 App 扫码，并核对商户与付款金额。'})));
  if(payment.checkout_path) {
    const expected='/airwallex-checkout.html?order='+encodeURIComponent(order.id);
    if(payment.checkout_path!==expected)throw new Error('收银台入口不匹配。');
    actions.append(el('a',{class:'btn primary',href:expected,target:'_blank',rel:'noopener noreferrer',text:'打开 Airwallex 收银台 ↗'}));
  }
  const query=el('button',{class:'btn',type:'button',text:'查询支付状态',onclick:async()=>{
    query.disabled=true;
    try{const data=await api('/api/me/payments/'+encodeURIComponent(order.id)+'/reconcile',{method:'POST',body:{}});update(data.order);}
    catch(error){status.replaceChildren(errorNotice(error));}
    finally{query.disabled=false;}
  }});
  actions.append(query);
  const root=el('div',{class:'payment-checkout'},status,details,actions);
  let timer,attempts=0,lastStatus=null;
  function update(value) {
    if(['paid','expired','failed'].includes(value?.status)) {
      clearTimeout(timer);details.replaceChildren();
      if(lastStatus!==value.status){lastStatus=value.status;Promise.resolve(onSettled?.()).catch(()=>{});}
      for(const link of actions.querySelectorAll('a'))link.remove();
      status.replaceChildren(notice(value.status==='paid'?'支付已确认':value.status==='expired'?'订单已关闭':'支付未成功',value.status==='paid'?'服务器已核对支付并处理入账。套餐交付状态请在「我的订单」查看。':'状态来自支付平台查单；如已扣款，请先联系管理员核对。',value.status==='paid'?'success':'warn'));
      return true;
    }
    return false;
  }
  async function poll(){
    if(!root.isConnected||attempts++>=120)return;
    try{if(document.visibilityState==='visible'){const value=await api('/api/me/payments/'+encodeURIComponent(order.id));if(update(value.order))return;}}catch{}
    timer=setTimeout(poll,5000);
  }
  if(!update(order))timer=setTimeout(poll,5000);
  return root;
}
