function minorUnits(raw) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) throw new Error('金额必须是非负数，最多两位小数。');
  const [whole, fraction=''] = raw.split('.');
  const amount=Number(whole)*100+Number(fraction.padEnd(2,'0'));
  if(!Number.isSafeInteger(amount)) throw new Error('金额超出范围。');
  return amount;
}

export function paymentSettingsView(ui, initial) {
  const {el, field, switchRow, panel, notice, errorNotice, bindForm, confirmAction, api, state, CANCEL} = ui;
  let payment=initial;
  const status=el('div',{'aria-live':'polite',class:'payment-summary'});
  const methodStatuses=new Map(), providerStatuses=new Map();
  function readback(data) {
    payment=data.payment; state.public.features=data.features;
    state.public.payment={currency:'CNY',min_amount_minor:payment.min_amount_minor,max_amount_minor:payment.max_amount_minor,help_text:payment.help_text,methods:payment.methods.filter(method=>method.offered).map(method=>({id:method.id,title:method.title}))};
    status.replaceChildren(el('strong',{text:payment.configured?'在线支付已启用':'在线支付未就绪'}),el('span',{class:'badge '+(payment.configured?'good':'warn'),text:payment.configured?'可创建支付单':'不创建新支付单'}),el('p',{text:'结算币种 CNY · 已有订单仍由服务端查单和签名回调确认。'}));
    for(const method of payment.methods) {
      const reasons={disabled:'未启用',payment_disabled:'全局支付已停用',source_missing:'尚未选择来源',credentials_missing:'来源未启用或凭据不完整'};
      const node=methodStatuses.get(method.id);
      if(node) node.textContent=method.offered?'可在当前收银台使用':reasons[method.reason]||'未提供';
    }
    for(const provider of payment.providers) {
      const node=providerStatuses.get(provider.id);
      if(node) { node.className='badge '+(provider.ready?'good':'warn');node.textContent=provider.ready?(provider.id==='stripe'?(provider.live?'正式环境 · 已配置':'测试环境 · 已配置'):'已配置'):'未启用或配置不完整'; }
    }
  }
  const general=el('form',{'aria-label':'支付全局设置'},
    switchRow('启用在线支付','停用只禁止新建订单，不中断已有订单查单、回调和入账。','enabled',payment.enabled),
    switchRow('允许余额充值','关闭后仍可为套餐创建在线支付订单，已有钱包余额仍可使用。','recharge_enabled',payment.recharge_enabled),
    el('div',{class:'settings-field-grid'},
      field('最低金额（元）','min_amount_minor',{type:'number',min:'0.01',step:'0.01',required:true,value:(payment.min_amount_minor/100).toFixed(2)}),
      field('最高金额（元）','max_amount_minor',{type:'number',min:'0.01',step:'0.01',required:true,value:(payment.max_amount_minor/100).toFixed(2)}),
      field('每人每日限额（元）','daily_limit_minor',{type:'number',min:0,step:'0.01',required:true,value:(payment.daily_limit_minor/100).toFixed(2),hint:'0 表示不限。按 UTC 自然日统计，包含未确认订单占用。'}),
      field('每人最多待支付订单','max_pending_orders',{type:'number',min:1,max:100,required:true,value:payment.max_pending_orders,hint:'包含结果未知的订单；请先核对，不会自动判为失败。'}),
      field('订单有效期（分钟）','order_timeout_minutes',{type:'number',min:30,max:1440,required:true,value:payment.order_timeout_minutes,hint:'Stripe、支付宝、微信和随行付使用此期限；其他渠道按平台规则关闭，最终状态以查单为准。'}),
      field('充值商品名称','product_name',{required:true,maxlength:80,value:payment.product_name})),
    field('支付帮助说明','help_text',{type:'textarea',maxlength:1000,value:payment.help_text,hint:'展示在用户充值页。不要填写密钥或其他敏感信息。'}),
    el('button',{class:'btn primary',type:'submit',text:'保存支付规则'}));
  bindForm(general,async values=>{
    const body={expected_revision:payment.revision,enabled:values.get('enabled')==='on',recharge_enabled:values.get('recharge_enabled')==='on',product_name:values.get('product_name').trim(),help_text:values.get('help_text').trim()};
    for(const key of ['min_amount_minor','max_amount_minor','daily_limit_minor']) body[key]=minorUnits(values.get(key));
    for(const key of ['max_pending_orders','order_timeout_minutes']) body[key]=Number(values.get(key));
    if(!await confirmAction('保存支付规则','规则对新订单生效，不修改历史金额和钱包账本。','确认保存')) return CANCEL;
    return api('/api/admin/payment',{method:'PATCH',body});
  },(data,message)=>{readback(data);message.replaceChildren(notice('支付规则已保存','新的下单请求将使用这些规则。','success'));});
  const methods=el('form',{'aria-label':'前台支付方式'});
  for(const method of payment.methods) {
    const detail=el('p',{class:'inline-info','data-method-status':method.id}); methodStatuses.set(method.id,detail);
    methods.append(el('div',{class:'payment-method-row'},
      switchRow('前台展示'+method.title,'同时需要启用来源渠道并填写完整凭据。','method_'+method.id,method.enabled),
      field(method.title+'来源','source_'+method.id,{type:'select',value:method.source||'',choices:[{value:'',label:'未配置'},...method.sources.map(source=>({value:source.id,label:source.label}))]}),detail));
  }
  methods.append(el('button',{class:'btn primary',type:'submit',text:'保存支付方式'}));
  bindForm(methods,async values=>{
    const changes={};
    for(const method of payment.methods) changes[method.id]={enabled:values.get('method_'+method.id)==='on',source:values.get('source_'+method.id)};
    if(!await confirmAction('保存支付方式','未启用或凭据不完整的来源不会向用户开放。','确认保存')) return CANCEL;
    return api('/api/admin/payment',{method:'PATCH',body:{expected_revision:payment.revision,methods:changes}});
  },(data,message)=>{readback(data);message.replaceChildren(notice('支付方式已保存','下方状态显示服务器实际可用性，不以开关代替就绪检查。','success'));});
  const providers=el('div',{class:'provider-list'});
  for(const provider of payment.providers) {
    const editable=provider.editable !== false;
    const providerStatus=el('span',{class:'badge '+(provider.ready?'good':'warn')}); providerStatuses.set(provider.id,providerStatus);
    const result=el('div',{'aria-live':'polite'});
    const form=el('form',{'aria-label':provider.title+'渠道配置'},
      !editable?notice('凭据由环境变量管理','可暂停该渠道，但不能在网页覆盖或清除服务端环境凭据。','warn'):null,
      switchRow('启用'+provider.title,'停用保留配置。启用时必须填齐必填凭据。','enabled',provider.enabled));
    const grid=el('div',{class:'settings-field-grid'});
    for(const item of provider.fields) {
      const options=item.options?{type:'select',choices:item.options,value:item.value||''}:{type:item.kind==='pem'?'textarea':item.sensitive?'password':'text',value:item.sensitive?'':item.value||'',autocomplete:item.sensitive?'new-password':'off',spellcheck:'false',placeholder:item.sensitive?(item.configured?'已配置，留空保持不变':'尚未配置'):''};
      grid.append(field(provider.title+' '+item.label,item.key,{...options,disabled:!editable,hint:item.hint||(item.required?'启用时必填。':'可选。')}));
    }
    form.append(grid);
    if(provider.webhook_url) form.append(field(provider.title+' 回调地址','callback',{value:provider.webhook_url,readonly:true,hint:provider.id==='stripe'?'在 Stripe 后台订阅 checkout.session.completed、checkout.session.async_payment_succeeded、checkout.session.async_payment_failed 和 checkout.session.expired。':provider.id==='airwallex'?'在 Airwallex 后台订阅 payment_intent.succeeded 和 payment_intent.cancelled。':'下单时由服务器设置通知地址，并自动附加订单号；无需手工修改。'}));
    if(editable) form.append(switchRow('清除'+provider.title+'密钥','需先停用。正在处理的支付订单会阻止该渠道凭据清除或更换。','clear_secrets',false));
    const actions=el('div',{class:'button-row'},el('button',{class:'btn primary',type:'submit',text:'保存'+provider.title+'渠道'}));
    actions.append(el('button',{class:'btn',type:'button',text:['stripe','airwallex'].includes(provider.id)?'测试'+provider.title+'连接':'检查'+provider.title+'配置',onclick:async()=>{
      if(form.dataset.busy==='true') return;
      const values=new FormData(form), config={};
      for(const item of provider.fields) config[item.key]=values.get(item.key)||'';
      const controls=[...form.querySelectorAll('input,select,textarea,button')].map(node=>[node,node.disabled]);
      form.dataset.busy='true';controls.forEach(([node])=>node.disabled=true);result.replaceChildren(notice('正在检查支付配置…','不会创建支付订单或保存配置。'));
      try {const data=await api('/api/admin/payment/test',{method:'POST',body:{provider:provider.id,...(editable?{config}:{})}});result.replaceChildren(notice(data.scope==='connection'?'支付 API 连接成功':'配置格式检查通过',data.scope==='connection'?'接口认证成功；未发起付款，回调仍需支付平台联调验证。':'密钥格式和参数校验通过，尚未向支付平台发起交易或验证商户权限。','success'));}
      catch(error){result.replaceChildren(errorNotice(error));}
      finally{form.dataset.busy='false';controls.forEach(([node,disabled])=>node.disabled=disabled);}
    }}));
    form.append(actions,result);
    bindForm(form,async values=>{
      const change={enabled:values.get('enabled')==='on'};
      if(editable){change.clear_secrets=values.get('clear_secrets')==='on';for(const item of provider.fields) change[item.key]=values.get(item.key)||'';}
      if(!await confirmAction('保存'+provider.title+'渠道',change.clear_secrets?'将清除已保存密钥。未完成订单可能阻止此操作。':'只修改此渠道；空白敏感字段保留原值。','确认保存',change.clear_secrets))return CANCEL;
      return api('/api/admin/payment',{method:'PATCH',body:{expected_revision:payment.revision,providers:{[provider.id]:change}}});
    },(data,message)=>{
      readback(data);const saved=payment.providers.find(item=>item.id===provider.id);
      for(const item of saved.fields) if(item.sensitive){form.elements[item.key].value='';form.elements[item.key].placeholder=item.configured?'已配置，留空保持不变':'尚未配置';}
      if(form.elements.clear_secrets)form.elements.clear_secrets.checked=false;
      result.replaceChildren();message.replaceChildren(notice('渠道配置已保存','实时可用性以页顶状态和「前台方式」为准。','success'));
    });
    form.addEventListener('input',()=>result.replaceChildren());
    providers.append(el('details',{class:'provider-block',open:provider.id==='stripe'},el('summary',{},el('strong',{text:provider.title}),providerStatus),form));
  }
  readback({payment,features:state.public.features});
  const sections = [
    ['channels','收款渠道',panel('支付渠道','先填写收款凭据，再到「前台方式」选择要开放的来源。各渠道独立保存。',el('div',{class:'card-body'},providers))],
    ['methods','前台方式',panel('前台支付方式','把用户看到的方式与实际收款渠道分开配置。',el('div',{class:'card-body'},methods))],
    ['rules','交易规则',panel('支付规则','金额、限额和订单期限统一由服务器校验。结算币种固定为人民币。',el('div',{class:'card-body'},general))],
  ];
  const tabs=el('div',{class:'payment-tabs',role:'tablist','aria-label':'支付配置分区'});
  for(const [id,title,section] of sections) {
    section.id='payment-'+id;section.setAttribute('role','tabpanel');section.setAttribute('aria-labelledby','payment-tab-'+id);section.hidden=id!=='channels';
    const button=el('button',{id:'payment-tab-'+id,class:'btn'+(id==='channels'?' selected':''),type:'button',role:'tab','aria-controls':section.id,'aria-selected':id==='channels'?'true':'false',text:title,onclick:()=>{
      for(const [key,,content] of sections)content.hidden=key!==id;
      for(const tab of tabs.children){const selected=tab===button;tab.classList.toggle('selected',selected);tab.setAttribute('aria-selected',String(selected));}
    }});
    tabs.append(button);
  }
  tabs.addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    const buttons=[...tabs.children],index=buttons.indexOf(event.target);
    if(index<0) return;
    event.preventDefault();
    const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;
    buttons[next].click();buttons[next].focus();
  });
  return el('section',{id:'payment',class:'settings-section'},status,tabs,...sections.map(([, ,section])=>section));
}
