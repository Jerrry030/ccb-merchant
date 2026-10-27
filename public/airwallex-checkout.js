const status=document.querySelector('#checkout-status'),button=document.querySelector('#checkout-open');
const id=new URLSearchParams(location.search).get('order');
let checkout;
try {
  if(!/^[A-Za-z0-9_-]{1,100}$/.test(id||''))throw new Error('无效的支付订单。');
  const response=await fetch('/api/me/payments/'+encodeURIComponent(id)+'/checkout',{credentials:'same-origin',cache:'no-store'});
  if(!response.ok)throw new Error(response.status===401?'请先在本站登录，再打开收银台。':'订单无法继续支付，请返回订单列表核对。');
  checkout=await response.json();button.disabled=false;status.textContent='订单已准备好。点击按钮前往 Airwallex 完成付款；本页面不会自动扣款。';
}catch(error){status.textContent=error.message;}
button.addEventListener('click',async()=>{
  button.disabled=true;status.textContent='正在连接 Airwallex 收银台…';
  try {
    const {init}=await import('/vendor/airwallex-sdk.mjs');
    const sdk=await init({env:checkout.env,enabledElements:['payments'],locale:'zh'});
    if(!sdk.payments)throw new Error('收银台组件未加载。');
    const {env,...options}=checkout;
    const target=await sdk.payments.redirectToCheckout(options);
    if(typeof target==='string'&&target){const url=new URL(target);const origin=env==='prod'?'https://checkout.airwallex.com':'https://checkout-demo.airwallex.com';if(url.origin!==origin||url.username||url.password)throw new Error('收银台地址无效。');location.assign(url.href);}
  }catch{status.textContent='收银台暂时不可用。请检查网络，返回订单列表核对后再试，不要重复创建订单。';button.disabled=false;}
});
