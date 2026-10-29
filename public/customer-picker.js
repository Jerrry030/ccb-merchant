import { el } from './dom.js';
import { api, collection } from './api.js';
import { field } from './ui-form.js';
import { errorNotice } from './ui.js';

// Search and page without discarding the explicitly selected customer.
export async function customerPicker(selected = '', label = '客户') {
 let current=null,offset=0,total=0,ticket=0;
 if(selected){const data=await api('/api/admin/users/'+encodeURIComponent(selected));if(data.user?.id!==selected)throw new Error('指定客户资料缺失。');current=data.user;}
 const search=field('搜索客户','customer_search',{placeholder:'姓名或邮箱'});
 const pick=field(label,'user_id',{type:'select',required:true,choices:[{value:'',label:'请选择客户'}]});
 const select=pick.querySelector('select'),info=el('span',{}),error=el('div',{});
 const previous=el('button',{class:'btn small',type:'button',text:'上一页客户'}),next=el('button',{class:'btn small',type:'button',text:'下一页客户'});
 const root=el('div',{class:'customer-picker'},search,pick,el('div',{class:'button-row'},previous,info,next),error);
 let page=[];
 async function load(){
  const version=++ticket;previous.disabled=next.disabled=true;
  try{const result=await api('/api/admin/users?'+new URLSearchParams({limit:'50',offset:String(offset),q:search.querySelector('input').value,status:'active'}));if(version!==ticket)return;
   page=collection(result,'users');total=result.total;const rows=[...(current&&!page.some(u=>u.id===current.id)?[current]:[]),...page];
   select.replaceChildren(el('option',{value:'',text:'请选择客户'}),...rows.map(u=>el('option',{value:u.id,disabled:u.status!=='active'||u.sync_pending,text:(u.display_name||u.email)+' · '+u.email+(u.sync_pending?' · 同步待核对':u.status!=='active'?' · 不可分配':'')})));
   select.value=current?.id||'';info.textContent='共 '+total+' 位 · 第 '+(Math.floor(offset/50)+1)+' 页';error.replaceChildren();
  }catch(e){if(version===ticket)error.replaceChildren(errorNotice(e));}finally{if(version===ticket){previous.disabled=offset===0;next.disabled=offset+50>=total;}}
 }
 select.addEventListener('change',()=>{current=page.find(u=>u.id===select.value)|| (current?.id===select.value?current:null);});
 let timer;search.querySelector('input').addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(()=>{offset=0;void load();},250);});
 previous.addEventListener('click',()=>{offset=Math.max(0,offset-50);void load();});next.addEventListener('click',()=>{offset+=50;void load();});
 await load();return root;
}
