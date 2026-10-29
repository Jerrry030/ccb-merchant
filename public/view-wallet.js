import { paymentCheckout } from './payment-checkout.js';
import { el, icon } from './dom.js';
import { state } from './state.js';
import { api, collection } from './api.js';
import { date, money } from './format.js';
import { badge, notice, emptyState, panel, table, errorNotice } from './ui.js';
import { CANCEL, field, confirmAction, bindForm, editorDialog } from './ui-form.js';
import { orderTable } from './view-orders.js';
export async function walletView() {
  const [data, catalog] = await Promise.all([api('/api/me/wallet'), api('/api/plans'+(new URLSearchParams(location.search).get('renew_grant_id')?'?renew_grant_id='+encodeURIComponent(new URLSearchParams(location.search).get('renew_grant_id')):'')).catch(error=>({plans:[],catalogError:error.message}))]);
  const plans = collection(catalog,'plans');
  const enabled = state.public.features.payment === true && state.public.features.recharge !== false;
  const result = el('div',{});
  const balanceValue=el('div',{class:'amount',text:money(data.wallet?.balance_minor,data.wallet?.currency)});
  const history=el('div',{class:'wallet-history'});
  function paintWallet(snapshot) {
    balanceValue.textContent=money(snapshot.wallet?.balance_minor,snapshot.wallet?.currency);
    history.replaceChildren(
      panel('最近支付订单','以服务端确认状态为准',orderTable(collection(snapshot,'orders'))),
      panel('资金记录','所有金额使用人民币最小单位换算显示',table([
        {label:'记录时间',render:r=>date(r.created_at)},
        {label:'类型',render:r=>({stripe_credit:'Stripe 支付入账',payment_credit:'在线支付入账',rental_debit:'套餐购买扣款',rental_refund:'未交付退回余额'}[r.kind]||r.kind||'未提供')},
        {label:'变动金额',render:r=>money(r.amount_minor,r.currency||snapshot.wallet?.currency)},
        {label:'关联订单',render:r=>el('span',{class:'mono',text:r.rental_id||r.order_id||'—'})},
      ],collection(snapshot,'ledger'),'暂无资金记录','没有发生过服务器确认的资金变动。')));
  }
  async function refreshWallet(){try{paintWallet(await api('/api/me/wallet'));}catch{balanceValue.textContent='—';}}

  const presets = ['50','100','200','500'];
  const form = el('form',{class:'recharge-form'},
    field('支付方式','payment_method',{type:'select',required:true,disabled:!enabled,choices:(state.public.payment?.methods||[]).map(method=>({value:method.id,label:method.title}))}),
    field('充值金额（人民币元）','amount',{required:true,type:'number',min:String((state.public.payment?.min_amount_minor || 1)/100),max:state.public.payment?.max_amount_minor?String(state.public.payment.max_amount_minor/100):undefined,step:'0.01',inputmode:'decimal',placeholder:'0.00',disabled:!enabled,hint:'实际支付金额以支付平台和服务器订单为准。'}),
    el('div',{class:'amount-choices'}, presets.map(amount => el('button',{type:'button',class:'amount-choice','data-amount':amount,disabled:!enabled,text:`¥${amount}`,onclick() {
      const input = form.querySelector('input[name=amount]');
      if (!input || input.disabled) return;
      input.value = amount;
      input.dispatchEvent(new Event('input',{bubbles:true}));
      input.focus();
    }}))),
    el('button',{class:'btn primary',type:'submit',disabled:!enabled},icon('wallet'),enabled ? '创建支付订单' : '在线支付未启用'));
  form.querySelector('input[name=amount]')?.addEventListener('input', event => {
    for (const chip of form.querySelectorAll('.amount-choice')) chip.classList.toggle('on', chip.dataset.amount === event.currentTarget.value);
  });
  bindForm(form,async values => {
    if (!enabled) throw new Error('当前未启用余额充值。');
    const amount = values.get('amount').trim(); if (!/^\d+(\.\d{1,2})?$/.test(amount)) throw new Error('请输入最多两位小数的有效金额。');
    const [whole,fraction = ''] = amount.split('.'); const minor = Number(whole)*100 + Number(fraction.padEnd(2,'0'));
    if (!Number.isSafeInteger(minor) || minor < 1) throw new Error('金额超出可处理范围。');
    if (!await confirmAction('创建真实支付订单',`确认创建 ${money(minor)} 的支付订单？接下来会提供二维码或收银台，不会在此页面自动扣款。`,'创建订单')) return CANCEL;
    return api('/api/me/payments',{method:'POST',body:{amount_minor:minor,payment_method:values.get('payment_method')}});
  },async (payment,message) => {
    if (!payment.order?.id) throw Object.assign(new Error('订单创建结果不完整，请先刷新核对。'),{uncertain:true});
    result.replaceChildren(paymentCheckout(payment,{onSettled:refreshWallet}));
    await refreshWallet();
  });
  const root = el('div',{class:'page-content wallet-page'},
    el('div',{class:'wallet-top'},
      panel('账户余额','以服务器账本为准',el('div',{class:'card-body'},el('div',{class:'balance-card'},el('p',{text:'可用余额 · CNY'}),balanceValue,el('p',{text:'余额不等于账号。购买并交付后，请在「我的账号」查看。'})))),
      panel('在线充值','选择已配置的支付方式，扫码或前往收银台',el('div',{class:'card-body'},!enabled ? notice('支付服务尚未配置','暂时无法发起在线支付。请联系管理员；不会创建虚拟订单或显示模拟到账。','warn') : null,state.public.payment?.help_text?notice('支付帮助',state.public.payment.help_text):null,form,result))));
  const orderId = new URLSearchParams(location.search).get('order');
  if (orderId) {
    try { const payment = await api(`/api/me/payments/${encodeURIComponent(orderId)}`); if (!payment.order) throw new Error('订单信息缺失。'); root.prepend(panel('返回后的订单核对','回跳网址中的成功参数不会改变余额或订单状态',el('div',{},orderTable([payment.order]),paymentCheckout(payment)))); }
    catch (error) { root.prepend(errorNotice(error)); }
  }
  paintWallet(data);
  root.append(catalog.catalogError?notice('订阅目录暂不可用',catalog.catalogError,'warn'):subscriptionPanel(plans),history);
  return root;
}
function planCard(plan) {
  const platforms = Array.isArray(plan.platforms) ? plan.platforms : [];
  const available = platforms.some(item => item.available > 0);
  const facts = [plan.duration_days + ' 天', '不自动续费'];
  if (Number.isSafeInteger(plan.device_limit) && plan.device_limit > 0) facts.splice(1, 0, plan.device_limit + ' 台设备');
  const message = el('div',{class:'form-message'});
  const first = platforms.find(item => item.available > 0)?.platform || '';
  const choices = el('fieldset',{class:'platform-choices'},
    el('legend',{text:'登录平台'}),
    platforms.length ? null : el('p',{class:'plan-meta',text:'暂无可选平台。'}),
    ...platforms.map(item => el('label',{class:'platform-choice' + (item.available > 0 ? '' : ' out')},
      el('input',{class:'sr-only',type:'radio',name:'platform-' + plan.id,value:item.platform,checked:item.platform===first,disabled:item.available<1}),
      el('span',{text:item.label || item.platform}),
      el('strong',{text:item.available > 0 ? String(item.available) : '无货'}))));
  const methods = state.public.payment?.methods || [];
  const payment = methods.length ? field('支付方式','payment_method',{type:'select',choices:[{value:'wallet',label:'钱包余额'},...methods.map(method => ({value:method.id,label:method.title}))],value:'wallet'}) : null;
  const requestId = crypto.randomUUID();
  const button = el('button',{class:'btn primary',type:'button',text:'购买',disabled:!available,async onclick() {
    if (button.disabled) return;
    const platform = choices.querySelector('input:checked')?.value || '';
    const slot = platforms.find(item => item.platform === platform);
    if (!slot || slot.available < 1) { message.replaceChildren(errorNotice(new Error('请选择一个有货的登录平台。'))); return; }
    const paymentMethod = payment?.querySelector('select')?.value || 'wallet';
    const paymentLabel = paymentMethod === 'wallet' ? '钱包余额' : (methods.find(method => method.id === paymentMethod)?.title || paymentMethod);
    if (!await confirmAction('确认购买订阅', plan.name + '，' + plan.duration_days + ' 天，' + money(plan.amount_minor) + '，平台 ' + (slot.label || platform) + '，' + paymentLabel + '。余额支付会立即扣款。','确认购买')) return;
    button.disabled = true;
    message.replaceChildren();
    try {
      const data = await api('/api/me/rentals',{method:'POST',body:{plan_id:plan.id,expected_revision:plan.revision,payment_method:paymentMethod,platform,request_id:requestId,renew_grant_id:plan.renew_grant_id||''}});
      if (!data.rental?.id) throw Object.assign(new Error('订单结果未知，请前往订单核对。'),{uncertain:true});
      const result = el('div',{class:'card-body'},badge(data.rental.status),el('p',{class:'mono',text:data.rental.id}),notice('订单已记录','支付成功不等于交付完成。交付后账号会进入我的账号。'),el('a',{class:'btn',href:'/accounts',text:'查看我的账号'}),el('a',{class:'btn',href:'/orders',text:'查看订单'}));
      if (data.payment) result.append(paymentCheckout(data.payment));
      editorDialog('购买结果', result);
    } catch (error) {
      message.replaceChildren(errorNotice(error));
    } finally { button.disabled = !platforms.some(item => item.available > 0); }
  }});
  return el('article',{class:'plan-card'},
    el('div',{class:'plan-top'},el('span',{class:'eyebrow',text:'订阅'}),el('span',{class:'badge ' + (available ? 'good' : 'warn')},el('span',{class:'dot'}),available ? '有货' : '无货')),
    el('h2',{text:plan.name || '未命名套餐'}),
    plan.description ? el('p',{class:'plan-copy',text:plan.description}) : null,
    el('p',{class:'plan-price',text:money(plan.amount_minor, plan.currency)}),
    el('p',{class:'plan-meta',text:facts.join(' · ')}),
    choices,
    payment,
    message,
    button);
}
function subscriptionPanel(plans) {
  if (!plans.length) return panel('订阅套餐','只显示订阅分组的在售套餐。',emptyState('暂无在售套餐','商户为订阅分组设置有效期和金额后，可以在这里购买。','layers'));
  return panel('订阅套餐','先选择登录平台，再直接购买。有货数量随下单变化，以服务器当时核对的库存为准。',el('div',{class:'card-body'},el('div',{class:'plan-grid'},plans.map(planCard))));
}
