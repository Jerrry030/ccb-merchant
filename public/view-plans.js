import { el } from './dom.js';
import { api, collection } from './api.js';
import { money } from './format.js';
import { badge, panel, table, emptyState, notice } from './ui.js';
import { CANCEL, field, confirmAction, bindForm, editorDialog } from './ui-form.js';
import { render } from './app.js';

export async function plansView() {
 const renewal=new URLSearchParams(location.search).get('renew_grant_id')||'';
 const query=new URLSearchParams(renewal?{renew_grant_id:renewal}:{});
 const plans=collection(await api('/api/plans'+(renewal?'?'+query:'')),'plans');
 const cards=plans.map(plan=>{
  const platforms=Array.isArray(plan.platforms)?plan.platforms:[],available=platforms.some(item=>item.available>0);
  const target=new URLSearchParams({plan:plan.id});if(renewal)target.set('renew_grant_id',renewal);
  return el('article',{class:'plan-card'},
   el('div',{class:'plan-top'},el('span',{class:'eyebrow',text:renewal?'账号续期':'订阅套餐'}),el('span',{class:'badge '+(available?'good':'warn'),text:available?'有货':'无货'})),
   el('h2',{text:plan.name||'未命名套餐'}),plan.description?el('p',{class:'plan-copy',text:plan.description}):null,
   el('p',{class:'plan-price',text:money(plan.amount_minor,plan.currency)}),
   el('p',{class:'plan-meta',text:plan.duration_days+' 天 · '+(plan.device_limit||1)+' 台设备 · 不自动续费'}),
   el('div',{class:'plan-platforms'},platforms.length?platforms.map(item=>el('span',{class:'chip',text:(item.label||item.platform)+' · '+(item.available>0?'有货':'无货')})):el('span',{class:'muted',text:'暂无可选平台'})),
   available?el('a',{class:'btn primary',href:'/checkout?'+target,text:renewal?'选择续期套餐':'选择套餐'}):el('button',{class:'btn',type:'button',disabled:true,text:'暂时无货'}));
 });
 return el('div',{class:'page-content storefront-page'},
  renewal?notice('为当前账号续期','只展示与该账号匹配的套餐；不会替换成其他账号。'):null,
  plans.length?el('div',{class:'plan-grid'},cards):panel('在售套餐','',emptyState(renewal?'暂无可用续期套餐':'暂无在售套餐',renewal?'当前供给不足或期限不匹配，请稍后核对或联系商户。':'套餐上架后会显示在这里。','layers')));
}
function planEditor(plan,resources) {
 const choices=resources.filter(resource=>resource.kind==='subscription'&&resource.status==='active'&&resource.available!==false);
 const form=el('form',{},field('套餐名称','name',{required:true,maxlength:100,value:plan?.name||'',placeholder:'例如：Code 月度套餐'}),field('\u8ba2\u9605\u5206\u7ec4','resource_id',{type:'select',choices:(choices.length?choices:resources).map(resource=>({value:resource.id,label:resource.name})),value:plan?.resource_id||choices[0]?.id,disabled:Boolean(plan)||!choices.length}),
  field('\u6709\u6548\u671f\uff08\u5929\uff0c\u6bcf\u5929 24 \u5c0f\u65f6\uff09','duration_days',{type:'number',required:true,min:1,max:366,step:1,value:plan?.duration_days||30}),
  field('\u5957\u9910\u91d1\u989d\uff08\u4eba\u6c11\u5e01\u5143\uff09','price',{type:'number',required:true,min:0.01,step:0.01,value:plan?String(plan.amount_minor/100):''}),
  field('\u4e0a\u67b6\u72b6\u6001','status',{type:'select',choices:[{value:'active',label:'\u4e0a\u67b6'},{value:'archived',label:'\u4e0b\u67b6'}],value:plan?.status||'archived'}),el('button',{class:'btn primary',type:'submit',text:'\u4fdd\u5b58\u5957\u9910'}));
 const dialog=editorDialog(plan?'\u7f16\u8f91\u5957\u9910':'\u521b\u5efa\u5957\u9910',form);
 bindForm(form,async values=>{
  const price=values.get('price');if(!/^\d+(\.\d{1,2})?$/.test(price))throw new Error('\u4ef7\u683c\u6700\u591a\u652f\u6301\u4e24\u4f4d\u5c0f\u6570\u3002');
  const [whole,fraction='']=price.split('.'),amount=Number(whole)*100+Number(fraction.padEnd(2,'0'));
  const duration=Number(values.get('duration_days'));
  const body={name:values.get('name').trim(),description:plan?.description||'',duration_days:duration,amount_minor:amount,status:values.get('status'),...(plan?{expected_revision:plan.revision}:{resource_id:values.get('resource_id')})};
  if(!await confirmAction('\u4fdd\u5b58\u5957\u9910',`\u9500\u552e\u4ef7 ${money(amount)}\uff0c\u79df\u671f ${duration} \u5929\u3002\u5df2\u6709\u8ba2\u5355\u4fdd\u7559\u539f\u4ef7\u683c\u53ca\u79df\u671f\u3002`,'\u786e\u8ba4\u4fdd\u5b58'))return CANCEL;
  return api(plan?`/api/admin/plans/${encodeURIComponent(plan.id)}`:'/api/admin/plans',{method:plan?'PATCH':'POST',body});
 },()=>{dialog.close();render();});
}
export async function planAdminView() {
 const [p,r]=await Promise.all([api('/api/admin/plans'),api('/api/admin/resources')]),plans=collection(p,'plans'),resources=collection(r,'resources');
 const groups=resources.filter(resource=>resource.kind==='subscription');
 return panel('\u8ba2\u9605\u5957\u9910','设置套餐名称、有效期和销售价。\u5957\u9910\u6302\u5728\u8ba2\u9605\u5206\u7ec4\u4e0a\uff0c\u4e0d\u6309\u5355\u4e2a\u8d26\u53f7\u5efa\u4ef7\u3002',table([{label:'套餐名称',render:plan=>plan.name},{label:'供货参考价',render:plan=>money(plan.cost_minor)},{label:'销售价',render:plan=>money(plan.amount_minor)},{label:'\u79df\u671f',render:plan=>`${plan.duration_days} \u5929`},{label:'\u72b6\u6001',render:plan=>badge(plan.status)},{label:'\u64cd\u4f5c',render:plan=>el('button',{class:'btn small',text:'\u7f16\u8f91',onclick:()=>planEditor(plan,resources)})}],plans,'\u5c1a\u672a\u914d\u7f6e\u5957\u9910','\u5148\u5728\u4e0a\u6e38\u628a\u5206\u7ec4\u8bbe\u4e3a\u8ba2\u9605\u5206\u7ec4\u5e76\u5206\u914d\u7ed9\u672c\u7ad9\uff0c再设置套餐名称、有效期和销售价。'),el('button',{class:'btn primary',text:'\u521b\u5efa\u5957\u9910',disabled:!groups.length,onclick:()=>planEditor(null,resources)}));
}
