import { el } from './dom.js';
import { state } from './state.js';
import { api, collection } from './api.js';
import { date, money } from './format.js';
import { navigate } from './router.js';
import { notice, panel, emptyState } from './ui.js';
import { CANCEL, field, bindForm, confirmAction } from './ui-form.js';
import { paymentCheckout } from './payment-checkout.js';

export async function checkoutView() {
  const params=new URLSearchParams(location.search),orderId=params.get('order'),planId=params.get('plan');
  const recharge=params.get('recharge')==='1',submitted=params.get('submitted')==='1';
  if([Boolean(orderId),Boolean(planId),recharge].filter(Boolean).length!==1) return emptyState('请选择交易入口','从套餐、钱包或已有订单进入收银台。','wallet',el('a',{class:'btn',href:'/orders',text:'查看我的订单'}));
  if(orderId) {
    if(!/^[A-Za-z0-9_-]{1,100}$/.test(orderId))throw new Error('支付订单编号无效。');
    const payment=await api('/api/me/payments/'+encodeURIComponent(orderId)),order=payment.order;
    if(order?.id!==orderId)throw new Error('支付订单信息不匹配。');
    const facts=el('dl',{class:'checkout-facts'},
      el('dt',{text:'订单编号'}),el('dd',{class:'mono',text:order.id}),
      el('dt',{text:'支付用途'}),el('dd',{text:order.rental_id?'套餐购买':'余额充值'}),
      el('dt',{text:'订单金额'}),el('dd',{text:money(order.amount_minor,order.currency)}),
      el('dt',{text:'创建时间'}),el('dd',{text:date(order.created_at)}));
    return el('div',{class:'page-content checkout-page'},
      panel(order.rental_id?'套餐收银台':'充值收银台','',el('div',{class:'card-body'},facts,paymentCheckout(payment))),
      el('div',{class:'button-row'},el('a',{class:'btn',href:order.rental_id?'/orders?rental='+encodeURIComponent(order.rental_id):'/orders?type=recharge',text:order.rental_id?'查看套餐订单':'查看充值订单'}),el('a',{class:'btn',href:'/wallet',text:'查看钱包'})));
  }
  if(submitted) {
    if(planId) {
      const requestId=params.get('request_id');
      if(!/^[A-Za-z0-9_-]{16,100}$/.test(requestId||''))throw new Error('购买请求编号缺失，请从我的订单核对。');
      const rows=collection(await api('/api/me/rentals?request_id='+encodeURIComponent(requestId)),'rentals');
      if(rows.length>1)throw new Error('购买回执不唯一，请联系商户核对。');
      if(rows.length) {
        if(rows[0].plan_id!==planId)throw new Error('购买回执与当前套餐不匹配。');
        navigate(rows[0].payment_order_id?'/checkout?order='+encodeURIComponent(rows[0].payment_order_id):'/orders?rental='+encodeURIComponent(rows[0].id),true);
        return el('div',{role:'status',text:'正在读取原订单…'});
      }
    }
    return el('div',{class:'page-content checkout-page'},notice('订单结果待核对','请求可能已被服务器接收。刷新只读取原请求，不会再次下单。','warn'),
      planId?el('p',{class:'mono',text:'购买请求：'+params.get('request_id')}):null,
      el('a',{class:'btn',href:planId?'/orders':'/orders?type=recharge',text:planId?'查看套餐订单':'查看充值订单'}));
  }
  const methods=state.public.features.payment===true?(state.public.payment?.methods||[]):[];
  if(planId) {
    const renewal=params.get('renew_grant_id')||'',catalogQuery=new URLSearchParams(renewal?{renew_grant_id:renewal}:{});
    const [catalog,balance]=await Promise.all([api('/api/plans'+(renewal?'?'+catalogQuery:'')),api('/api/me/wallet').catch(error=>({balanceError:error}))]);
    const plan=collection(catalog,'plans').find(item=>item.id===planId);
    if(!plan)return emptyState('套餐暂不可购买','请返回查看当前在售套餐。','layers',el('a',{class:'btn',href:'/plans',text:'返回套餐'}));
    if(renewal&&plan.renew_grant_id!==renewal)throw new Error('续期对象与套餐不匹配，请重新核对账号。');
    const platforms=Array.isArray(plan.platforms)?plan.platforms:[],first=platforms.find(item=>item.available>0);
    const knownBalance=Number.isSafeInteger(balance.wallet?.balance_minor)&&balance.wallet?.currency==='CNY';
    const walletAvailable=knownBalance&&balance.wallet.balance_minor>=plan.amount_minor;
    const onlineAvailable=plan.amount_minor>=(state.public.payment?.min_amount_minor||1)&&(!state.public.payment?.max_amount_minor||plan.amount_minor<=state.public.payment.max_amount_minor);
    const choices=[{value:'wallet',label:knownBalance?'钱包余额 '+money(balance.wallet.balance_minor)+(walletAvailable?'':' · 余额不足'):'钱包余额暂不可用',disabled:!walletAvailable},...methods.map(method=>({value:method.id,label:method.title,disabled:!onlineAvailable}))];
    const selected=choices.find(item=>!item.disabled)?.value||'';
    const requestId=params.get('request_id')||crypto.randomUUID();
    if(!/^[A-Za-z0-9_-]{16,100}$/.test(requestId))throw new Error('购买请求编号无效。');
    const form=el('form',{class:'purchase-form'},
      field('登录平台','platform',{type:'select',required:true,choices:platforms.map(item=>({value:item.platform,label:(item.label||item.platform)+(item.available>0?' · 有货':' · 无货'),disabled:item.available<1})),value:first?.platform||''}),
      field('付款方式','payment_method',{type:'select',required:true,choices,value:selected}),
      !walletAvailable?el('div',{class:'button-row'},el('span',{class:'muted',text:knownBalance?'余额不足，可选择在线支付或先充值。':'余额读取失败，不能确认余额付款。'}),el('a',{href:'/checkout?recharge=1',text:'去充值'})):null,
      el('button',{class:'btn primary',type:'submit',disabled:!first||!selected,text:renewal?'确认续期':'确认购买'}));
    bindForm(form,async values=>{
      const platform=values.get('platform'),method=values.get('payment_method');
      if(!platforms.some(item=>item.platform===platform&&item.available>0)||!choices.some(item=>item.value===method&&!item.disabled))throw new Error('请选择可用平台和付款方式。');
      const body={plan_id:plan.id,expected_revision:plan.revision,payment_method:method,platform,request_id:requestId,renew_grant_id:renewal};
      if(!await confirmAction(renewal?'确认账号续期':'确认购买套餐',plan.name+'，'+plan.duration_days+' 天，'+money(plan.amount_minor)+'，平台 '+platform+'。'+(method==='wallet'?'余额付款会立即扣款。':'即将创建在线支付订单。'),'确认下单'))return CANCEL;
      const pending=new URLSearchParams(params);pending.set('request_id',requestId);pending.set('submitted','1');
      history.replaceState({},'','/checkout?'+pending);
      try {
        const data=await api('/api/me/rentals',{method:'POST',body});
        if(!data.rental?.id)throw Object.assign(new Error('购买回执缺失，请按原请求核对。'),{uncertain:true});
        return data;
      } catch(error) {
        if(['purchase_pending','purchase_conflict'].includes(error.code))error.uncertain=true;
        if(!error.uncertain&&form.isConnected){pending.delete('submitted');history.replaceState({},'','/checkout?'+pending);}
        throw error;
      }
    },data=>navigate(data.payment?.order?.id?'/checkout?order='+encodeURIComponent(data.payment.order.id):'/orders?rental='+encodeURIComponent(data.rental.id),true));
    const facts=el('dl',{class:'checkout-facts'},
      el('dt',{text:'套餐'}),el('dd',{text:plan.name}),el('dt',{text:'订单金额'}),el('dd',{text:money(plan.amount_minor,plan.currency)}),
      el('dt',{text:'有效期'}),el('dd',{text:plan.duration_days+' 天 · 不自动续费'}),el('dt',{text:'购买类型'}),el('dd',{text:renewal?'原账号续期':'新购账号'}),
      renewal?el('dt',{text:'续期账号'}):null,renewal?el('dd',{class:'mono',text:renewal}):null);
    return el('div',{class:'page-content checkout-page'},el('a',{class:'btn small',href:'/plans'+(renewal?'?'+catalogQuery:''),text:'返回套餐'}),
      el('div',{class:'checkout-layout'},panel('订单信息','',el('div',{class:'card-body'},facts)),panel('确认与付款','',el('div',{class:'card-body'},form))));
  }
  const enabled=state.public.features.payment===true&&state.public.features.recharge!==false&&methods.length>0;
  const form=el('form',{class:'recharge-form'},
    field('支付方式','payment_method',{type:'select',required:true,disabled:!enabled,choices:methods.map(method=>({value:method.id,label:method.title}))}),
    field('充值金额（人民币元）','amount',{required:true,type:'number',min:String((state.public.payment?.min_amount_minor||1)/100),max:state.public.payment?.max_amount_minor?String(state.public.payment.max_amount_minor/100):undefined,step:'0.01',inputmode:'decimal',placeholder:'0.00',disabled:!enabled}),
    el('div',{class:'amount-choices'},['50','100','200','500'].map(amount=>el('button',{type:'button',class:'amount-choice','data-amount':amount,disabled:!enabled,text:'¥'+amount,onclick(){const input=form.querySelector('input[name=amount]');input.value=amount;input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();}}))),
    el('button',{class:'btn primary',type:'submit',disabled:!enabled,text:enabled?'前往支付':state.public.features.payment===true?'余额充值未启用':'在线支付未启用'}));
  form.querySelector('input[name=amount]').addEventListener('input',event=>{for(const choice of form.querySelectorAll('.amount-choice'))choice.classList.toggle('on',choice.dataset.amount===event.target.value);});
  bindForm(form,async values=>{
    if(!enabled)throw new Error('当前未启用余额充值。');
    const amount=values.get('amount').trim();if(!/^\d+(\.\d{1,2})?$/.test(amount))throw new Error('请输入最多两位小数的有效金额。');
    const [whole,fraction='']=amount.split('.'),minor=Number(whole)*100+Number(fraction.padEnd(2,'0'));
    if(!Number.isSafeInteger(minor)||minor<1)throw new Error('金额超出可处理范围。');
    if(!await confirmAction('确认余额充值','充值 '+money(minor)+'。充值不会自动购买套餐。','创建订单'))return CANCEL;
    const pending=new URLSearchParams({recharge:'1',submitted:'1'});history.replaceState({},'','/checkout?'+pending);
    try {
      const payment=await api('/api/me/payments',{method:'POST',body:{amount_minor:minor,payment_method:values.get('payment_method')}});
      if(!payment.order?.id)throw Object.assign(new Error('充值订单回执缺失，请在充值订单核对。'),{uncertain:true});
      return payment;
    } catch(error) {if(!error.uncertain&&form.isConnected){pending.delete('submitted');history.replaceState({},'','/checkout?'+pending);}throw error;}
  },payment=>navigate('/checkout?order='+encodeURIComponent(payment.order.id),true));
  return el('div',{class:'page-content checkout-page'},el('a',{class:'btn small',href:'/wallet',text:'返回钱包'}),
    panel('余额充值','充值只增加钱包余额，不自动购买套餐。',el('div',{class:'card-body'},
      !enabled?notice(state.public.features.payment===true?'余额充值未启用':'支付服务尚未配置','当前无法创建在线充值订单。','warn'):null,
      state.public.payment?.help_text?notice('支付帮助',state.public.payment.help_text):null,form)));
}
