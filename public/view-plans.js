import { el } from './dom.js';
import { api, collection } from './api.js';
import { money } from './format.js';
import { badge, panel, table } from './ui.js';
import { CANCEL, field, confirmAction, bindForm, editorDialog } from './ui-form.js';
import { render } from './app.js';
function planEditor(plan,resources) {
 const choices=resources.filter(resource=>resource.kind==='subscription'&&resource.status==='active'&&resource.available!==false);
 const form=el('form',{},field('\u8ba2\u9605\u5206\u7ec4','resource_id',{type:'select',choices:(choices.length?choices:resources).map(resource=>({value:resource.id,label:resource.name})),value:plan?.resource_id||choices[0]?.id,disabled:Boolean(plan)||!choices.length}),
  field('\u6709\u6548\u671f\uff08\u5929\uff0c\u6bcf\u5929 24 \u5c0f\u65f6\uff09','duration_days',{type:'number',required:true,min:1,max:366,step:1,value:plan?.duration_days||30}),
  field('\u5957\u9910\u91d1\u989d\uff08\u4eba\u6c11\u5e01\u5143\uff09','price',{type:'number',required:true,min:0.01,step:0.01,value:plan?String(plan.amount_minor/100):''}),
  field('\u4e0a\u67b6\u72b6\u6001','status',{type:'select',choices:[{value:'active',label:'\u4e0a\u67b6'},{value:'archived',label:'\u4e0b\u67b6'}],value:plan?.status||'archived'}),el('button',{class:'btn primary',type:'submit',text:'\u4fdd\u5b58\u5957\u9910'}));
 const dialog=editorDialog(plan?'\u7f16\u8f91\u5957\u9910':'\u521b\u5efa\u5957\u9910',form);
 bindForm(form,async values=>{
  const price=values.get('price');if(!/^\d+(\.\d{1,2})?$/.test(price))throw new Error('\u4ef7\u683c\u6700\u591a\u652f\u6301\u4e24\u4f4d\u5c0f\u6570\u3002');
  const [whole,fraction='']=price.split('.'),amount=Number(whole)*100+Number(fraction.padEnd(2,'0'));
  const duration=Number(values.get('duration_days'));
  const body={name:`${duration} \u5929`,description:'',duration_days:duration,amount_minor:amount,status:values.get('status'),...(plan?{expected_revision:plan.revision}:{resource_id:values.get('resource_id')})};
  if(!await confirmAction('\u4fdd\u5b58\u5957\u9910',`\u9500\u552e\u4ef7 ${money(amount)}\uff0c\u79df\u671f ${duration} \u5929\u3002\u5df2\u6709\u8ba2\u5355\u4fdd\u7559\u539f\u4ef7\u683c\u53ca\u79df\u671f\u3002`,'\u786e\u8ba4\u4fdd\u5b58'))return CANCEL;
  return api(plan?`/api/admin/plans/${encodeURIComponent(plan.id)}`:'/api/admin/plans',{method:plan?'PATCH':'POST',body});
 },()=>{dialog.close();render();});
}
export async function planAdminView() {
 const [p,r]=await Promise.all([api('/api/admin/plans'),api('/api/admin/resources')]),plans=collection(p,'plans'),resources=collection(r,'resources');
 const groups=resources.filter(resource=>resource.kind==='subscription');
 return panel('\u8ba2\u9605\u5957\u9910','\u53ea\u586b\u6709\u6548\u671f\u548c\u91d1\u989d\u3002\u5957\u9910\u6302\u5728\u8ba2\u9605\u5206\u7ec4\u4e0a\uff0c\u4e0d\u6309\u5355\u4e2a\u8d26\u53f7\u5efa\u4ef7\u3002',table([{label:'\u5957\u9910',render:plan=>plan.name},{label:'供货参考价',render:plan=>money(plan.cost_minor)},{label:'销售价',render:plan=>money(plan.amount_minor)},{label:'\u79df\u671f',render:plan=>`${plan.duration_days} \u5929`},{label:'\u72b6\u6001',render:plan=>badge(plan.status)},{label:'\u7248\u672c',render:plan=>plan.revision},{label:'\u64cd\u4f5c',render:plan=>el('button',{class:'btn small',text:'\u7f16\u8f91',onclick:()=>planEditor(plan,resources)})}],plans,'\u5c1a\u672a\u914d\u7f6e\u5957\u9910','\u5148\u5728\u4e0a\u6e38\u628a\u5206\u7ec4\u8bbe\u4e3a\u8ba2\u9605\u5206\u7ec4\u5e76\u5206\u914d\u7ed9\u672c\u7ad9\uff0c\u518d\u586b\u6709\u6548\u671f\u548c\u91d1\u989d\u3002'),el('button',{class:'btn primary',text:'\u521b\u5efa\u5957\u9910',disabled:!groups.length,onclick:()=>planEditor(null,resources)}));
}
