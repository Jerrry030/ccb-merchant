import { el } from './dom.js';
import { state } from './state.js';
import { api, collection } from './api.js';
import { date, money } from './format.js';
import { notice, panel, table, listPager } from './ui.js';

export async function walletView() {
  const params=new URLSearchParams(location.search),query=new URLSearchParams();
  for(const key of ['limit','offset'])if(params.has(key))query.set(key,params.get(key));
  query.set('limit','30');
  const data=await api('/api/me/wallet?'+query);
  const enabled=state.public.features.payment===true&&state.public.features.recharge!==false;
  const summary=el('section',{class:'card wallet-summary','aria-label':'账户余额'},
    el('div',{},el('p',{class:'muted',text:'可用余额 · CNY'}),el('div',{class:'amount',text:money(data.wallet?.balance_minor,data.wallet?.currency)})),
    enabled?el('a',{class:'btn primary',href:'/checkout?recharge=1',text:'充值'}):el('button',{class:'btn',type:'button',disabled:true,text:state.public.features.payment===true?'余额充值未启用':'在线支付未启用'}));
  const ledger=table([
    {label:'记录时间',render:r=>date(r.created_at)},
    {label:'资金变动',render:r=>['stripe_credit','payment_credit'].includes(r.kind)?(r.payment_rental_id?'套餐在线支付入账':'充值入账'):({rental_debit:'套餐购买扣款',rental_refund:'未交付退回余额'}[r.kind]||r.kind||'未提供')},
    {label:'变动金额',render:r=>money(r.amount_minor,r.currency||data.wallet?.currency)},
    {label:'关联订单',render:r=>r.rental_id?el('a',{class:'mono',href:'/orders?rental='+encodeURIComponent(r.rental_id),text:r.rental_id}):r.order_id?el('a',{class:'mono',href:'/checkout?order='+encodeURIComponent(r.order_id),text:r.order_id}):'—'},
  ],collection(data,'ledger'),'暂无资金记录','余额变化经服务器确认后显示在这里。');
  return el('div',{class:'page-content wallet-page'},summary,
    !enabled?notice(state.public.features.payment===true?'余额充值未启用':'支付服务尚未配置','暂时无法在线充值；已有余额和订单仍可查看。','warn'):null,
    panel('余额流水','',ledger,el('a',{class:'btn small',href:'/orders?type=recharge',text:'查看充值订单'})),
    listPager(data,query,'/wallet','笔'));
}
