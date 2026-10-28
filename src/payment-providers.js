import { createHash, createHmac, createPrivateKey, createPublicKey, sign, verify, timingSafeEqual, randomBytes, randomUUID, createDecipheriv } from 'node:crypto';
import { paymentProviders } from '../public/payment-catalog.js';
import { HttpError } from './security.js';
import { upstreamFetch } from './upstream-network.js';

const ALIPAY='https://openapi.alipay.com/gateway.do', WX='https://api.mch.weixin.qq.com';
function badSignature() { throw new HttpError(400,'invalid_signature','Invalid payment notification signature.'); }
function mismatch() { throw new HttpError(409,'payment_mismatch','Payment identity, amount or signature did not match.'); }
function same(a,b) { const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&timingSafeEqual(x,y); }
function rsaKey(raw,provider,field) {
  const privatePart=field==='private_key';
  // SuixingPay's existing merchant signing keys may be 1024-bit. This does
  // not relax its 2048-bit platform verifier or Alipay/WeChat key requirements.
  const minimumBits=provider==='suixingpay'&&privatePart?1024:2048;
  const definition=paymentProviders[provider];
  const label=definition.title+'的'+definition.fields.find(item=>item.key===field).label;
  const labels=privatePart?['PRIVATE KEY','RSA PRIVATE KEY']:['PUBLIC KEY','RSA PUBLIC KEY'];
  let key;
  for(const encoding of labels) {
    try {
      const pem=raw?.trim().startsWith('-----BEGIN')?raw:'-----BEGIN '+encoding+'-----\n'+String(raw).replace(/\s/g,'')+'\n-----END '+encoding+'-----';
      key=privatePart?createPrivateKey(pem):createPublicKey(pem);
    } catch { continue; }
    break;
  }
  if(!key||key.asymmetricKeyType!=='rsa')throw new HttpError(400,'invalid_payment_key',label+'无法解析为 RSA 密钥，请检查填写的 PEM 或 Base64 格式。');
  if(!Number.isSafeInteger(key.asymmetricKeyDetails?.modulusLength)||key.asymmetricKeyDetails.modulusLength<minimumBits)throw new HttpError(400,'invalid_payment_key',label+'至少需要 '+minimumBits+' 位 RSA 密钥。');
  return key;
}
export function paymentAmount(value) {
  const text=String(value);
  if(!/^\d+(?:\.\d{1,2})?$/.test(text))mismatch();
  const [whole,fraction='']=text.split('.'),amount=Number(whole)*100+Number(fraction.padEnd(2,'0'));
  if(!Number.isSafeInteger(amount)||amount<1)mismatch();return amount;
}
function formFields(raw) {
  const values=Object.create(null);
  for(const pair of raw.split('&')) {
    if(!pair)continue;
    const index=pair.indexOf('='),decode=value=>decodeURIComponent(value.replace(/\+/g,' '));
    const key=decode(index<0?pair:pair.slice(0,index)),value=decode(index<0?'':pair.slice(index+1));
    if(Object.hasOwn(values,key))mismatch();values[key]=value;
  }
  return values;
}
// Preserve exact signed JSON ranges and reject duplicate keys at every depth.
export function paymentJSON(raw) {
  const value=JSON.parse(raw),fields=Object.create(null);let at=0;
  const space=()=>{while(at<raw.length&&/\s/.test(raw[at]))at++;};
  function string(){const start=at++;while(at<raw.length){if(raw[at]==='\\'){at+=2;continue;}if(raw[at++]==='"')return JSON.parse(raw.slice(start,at));}mismatch();}
  function scan(depth=0){
    if(depth>40)mismatch();space();
    if(raw[at]==='"'){string();return;}
    if(raw[at]==='{'){at++;space();const seen=new Set();if(raw[at]==='}'){at++;return;}
      while(at<raw.length){space();if(raw[at]!=='"')mismatch();const key=string();if(seen.has(key))mismatch();seen.add(key);space();if(raw[at++]!==':')mismatch();space();const start=at;scan(depth+1);if(depth===0)fields[key]=raw.slice(start,at);space();const end=raw[at++];if(end==='}')return;if(end!==',')mismatch();}mismatch();
    }
    if(raw[at]==='['){at++;space();if(raw[at]===']'){at++;return;}while(at<raw.length){scan(depth+1);space();const end=raw[at++];if(end===']')return;if(end!==',')mismatch();}mismatch();}
    const start=at;while(at<raw.length&&!/[\s,}\]]/.test(raw[at]))at++;if(start===at)mismatch();
  }
  scan();space();if(at!==raw.length)mismatch();return {value,fields};
}
function compact(raw){let out='',quoted=false;for(let i=0;i<raw.length;i++){const c=raw[i];if(quoted&&c==='\\'){out+=c+raw[++i];continue;}if(c==='"')quoted=!quoted;if(quoted||!/\s/.test(c))out+=c;}return out;}
function canonical(data,excluded=['sign','sign_type']){return Object.keys(data).filter(key=>!excluded.includes(key)&&data[key]!==''&&data[key]!=null).sort().map(key=>key+'='+data[key]).join('&');}
function suixingText(raw){const {fields}=paymentJSON(raw);return Object.keys(fields).filter(key=>key!=='sign').sort().map(key=>key+'='+(fields[key][0]==='"'?JSON.parse(fields[key]).trim():compact(fields[key]))).join('&');}
function validTime(raw,milliseconds=false){if(!/^\d{10,13}$/.test(String(raw)))badSignature();const time=Number(raw)/(milliseconds?1000:1);if(Math.abs(Date.now()/1000-time)>300)badSignature();}
function subjectText(value,limit) { let result='';for(const character of value){if(Buffer.byteLength(result+character)>limit)break;result+=character;}return result; }
function reference(value){if(typeof value!=='string'||!value||value.length>1000||/[\u0000-\u0020\u007f]/.test(value))mismatch();return value;}
function checkoutURL(value,provider,config){
  let url;try{url=new URL(value);}catch{mismatch();}
  if(url.protocol!=='https:'||url.username||url.password||url.href.length>4096)mismatch();
  if(provider==='stripe'&&url.origin!=='https://checkout.stripe.com')mismatch();
  if(provider==='easypay'&&url.origin!==new URL(config.api_base).origin)mismatch();
  return url.href;
}
export function validateProviderConfig(id,c,{allowMissingWebhook=false}={}) {
  const definition=paymentProviders[id];
  if(!definition||!c||typeof c!=='object')throw new HttpError(400,'invalid_provider_config','Unknown payment provider configuration.');
  for(const field of definition.fields)if(field.required&&!c[field.key]&&!(allowMissingWebhook&&id==='stripe'&&field.key==='webhook_secret'))throw new HttpError(400,'invalid_provider_config','Required payment credentials are missing.');
  if(['alipay','wxpay','suixingpay'].includes(id)){rsaKey(c.private_key,id,'private_key');rsaKey(c.public_key,id,'public_key');}
  if(id==='wxpay'&&(Buffer.byteLength(c.api_v3_key||'')!==32||![c.app_id,c.mch_id,c.cert_serial,c.public_key_id].every(value=>/^[A-Za-z0-9_-]+$/.test(value||''))))throw new HttpError(400,'invalid_provider_config','Invalid WeChat Pay API v3 key or merchant identifiers.');
  if(id==='airwallex'&&(!['https://api.airwallex.com/api/v1','https://api-demo.airwallex.com/api/v1'].includes(c.api_base)||c.currency!=='CNY'))throw new HttpError(400,'invalid_provider_config','Airwallex requires its official API origin and CNY settlement.');
  if(['easypay','suixingpay'].includes(id)){const url=new URL(c.api_base);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new HttpError(400,'invalid_provider_config','Payment API base must be HTTPS.');}
}

export class PaymentProvider {
  constructor(id,config,transport,origin){this.id=id;this.c=config;this.transport=transport;this.origin=origin;}
  async request(method,url,{body,headers={}}={}) {
    const options={method,headers,body,signal:AbortSignal.timeout(15000),redirect:'error'};
    const response=this.transport?await this.transport(url,options):await upstreamFetch({publicOrigin:this.origin,upstreamAllowedOrigins:[]},url,options);
    const chunks=[];let size=0;
    try{for await(const part of response.body||[]){size+=part.length;if(size>1048576)throw new Error('response limit');chunks.push(part);}}catch(error){await response.body?.cancel().catch(()=>{});throw error;}
    const raw=Buffer.concat(chunks).toString('utf8');
    if(!response.ok)throw new Error('provider request failed');
    return {raw,headers:response.headers,...paymentJSON(raw)};
  }
  async alipay(method,biz,extra={}) {
    const params={app_id:this.c.app_id,method,format:'JSON',charset:'utf-8',sign_type:'RSA2',timestamp:new Date(Date.now()+8*3600000).toISOString().slice(0,19).replace('T',' '),version:'1.0',biz_content:JSON.stringify(biz),...extra};
    params.sign=sign('RSA-SHA256',Buffer.from(canonical(params,['sign'])),rsaKey(this.c.private_key,this.id,'private_key')).toString('base64');
    const result=await this.request('POST',ALIPAY,{body:new URLSearchParams(params).toString(),headers:{'Content-Type':'application/x-www-form-urlencoded'}});
    const name=method.replaceAll('.','_')+'_response',data=result.value[name];
    if(!data||!result.value.sign||!verify('RSA-SHA256',Buffer.from(result.fields[name]),rsaKey(this.c.public_key,this.id,'public_key'),Buffer.from(result.value.sign,'base64')))mismatch();
    if(data.code!=='10000')throw new Error('Alipay business rejection');return data;
  }
  verifyWx(raw,headers) {
    const timestamp=headers.get('wechatpay-timestamp'),nonce=headers.get('wechatpay-nonce'),signature=headers.get('wechatpay-signature');
    validTime(timestamp);if(!nonce||headers.get('wechatpay-serial')!==this.c.public_key_id||!signature)mismatch();
    if(!verify('RSA-SHA256',Buffer.from(timestamp+'\n'+nonce+'\n'+raw+'\n'),rsaKey(this.c.public_key,this.id,'public_key'),Buffer.from(signature,'base64')))mismatch();
  }
  async wx(method,path,payload) {
    const body=payload?JSON.stringify(payload):'',timestamp=String(Math.floor(Date.now()/1000)),nonce=randomBytes(16).toString('hex');
    const signature=sign('RSA-SHA256',Buffer.from(method+'\n'+path+'\n'+timestamp+'\n'+nonce+'\n'+body+'\n'),rsaKey(this.c.private_key,this.id,'private_key')).toString('base64');
    const result=await this.request(method,WX+path,{body:body||undefined,headers:{'Content-Type':'application/json',Accept:'application/json',Authorization:'WECHATPAY2-SHA256-RSA2048 mchid="'+this.c.mch_id+'",nonce_str="'+nonce+'",timestamp="'+timestamp+'",serial_no="'+this.c.cert_serial+'",signature="'+signature+'"'}});
    this.verifyWx(result.raw,result.headers);return result.value;
  }
  verifySuixing(raw) {
    const data=paymentJSON(raw).value;
    if(!data.sign||(data.signType&&data.signType!==this.c.sign_type)||!verify(this.c.sign_type==='RSA2'?'RSA-SHA256':'RSA-SHA1',Buffer.from(suixingText(raw)),rsaKey(this.c.public_key,this.id,'public_key'),Buffer.from(data.sign,'base64')))mismatch();return data;
  }
  async suixing(path,reqData) {
    const envelope={reqData:Object.fromEntries(Object.entries(reqData).sort(([a],[b])=>a.localeCompare(b,'en'))),orgId:this.c.org_id,reqId:randomUUID().replaceAll('-',''),timestamp:new Date(Date.now()+8*3600000).toISOString().replace(/[-:T]/g,'').slice(0,14),version:'1.0',signType:this.c.sign_type};
    envelope.sign=sign(this.c.sign_type==='RSA2'?'RSA-SHA256':'RSA-SHA1',Buffer.from(suixingText(JSON.stringify(envelope))),rsaKey(this.c.private_key,this.id,'private_key')).toString('base64');
    const result=await this.request('POST',this.c.api_base.replace(/\/$/,'')+path,{body:JSON.stringify(envelope),headers:{'Content-Type':'application/json'}});
    const data=this.verifySuixing(result.raw);
    if(data.orgId!==this.c.org_id||data.reqId!==envelope.reqId||data.signType!==this.c.sign_type)mismatch();
    if(data.code!=='0000'||data.respData?.bizCode!=='0000')throw new Error('Suixing business rejection');return data.respData;
  }
  async airToken() {
    const result=await this.request('POST',this.c.api_base+'/authentication/login',{headers:{'Content-Type':'application/json','x-client-id':this.c.client_id,'x-api-key':this.c.api_key,...(this.c.account_id?{'x-login-as':this.c.account_id}:{})}});
    if(typeof result.value.token!=='string'||!result.value.token||result.value.token.length>8192||/\s/.test(result.value.token))mismatch();
    return result.value.token;
  }
  async create(order,{subject,clientIp,expiresAt}) {
    const c=this.c,id=order.id,amount=(order.amount_minor/100).toFixed(2),notify=this.origin+'/api/webhooks/'+this.id+'/'+id,returnUrl=this.origin+'/wallet?order='+id;
    switch(this.id){
      case 'stripe':{
        const body=new URLSearchParams({mode:'payment',client_reference_id:id,'metadata[order_id]':id,'metadata[user_id]':order.user_id,'line_items[0][price_data][currency]':'cny','line_items[0][price_data][product_data][name]':subject,'line_items[0][price_data][unit_amount]':String(order.amount_minor),'line_items[0][quantity]':'1',success_url:this.origin+'/'+(order.rental_id?'orders':'wallet')+'?order='+id,cancel_url:this.origin+'/'+(order.rental_id?'orders':'wallet')+'?order='+id,expires_at:String(expiresAt)});
        if(order.rental_id)body.set('payment_method_types[0]','card');
        const {value}=await this.request('POST','https://api.stripe.com/v1/checkout/sessions',{body:body.toString(),headers:{Authorization:'Bearer '+c.secret_key,'Content-Type':'application/x-www-form-urlencoded','Idempotency-Key':'merchant-order-'+id}});
        if(!/^cs_[A-Za-z0-9_]+$/.test(value.id||''))mismatch();
        this.observation(order,value);
        return {reference:value.id,url:checkoutURL(value.url,'stripe',c)};
      }
      case 'alipay':{
        const data=await this.alipay('alipay.trade.precreate',{out_trade_no:id,total_amount:amount,subject,timeout_express:Math.max(1,Math.ceil((expiresAt-Date.now()/1000)/60))+'m'},{notify_url:notify});
        if(data.out_trade_no!==id||!data.qr_code)mismatch();return {qr:data.qr_code};
      }
      case 'wxpay':{
        const data=await this.wx('POST','/v3/pay/transactions/native',{appid:c.app_id,mchid:c.mch_id,description:subjectText(subject,127),out_trade_no:id,notify_url:notify,time_expire:new Date(expiresAt*1000).toISOString(),amount:{total:order.amount_minor,currency:'CNY'}});
        if(!/^weixin:\/\/wxpay\/bizpayurl\?/.test(data.code_url||''))mismatch();return {qr:data.code_url};
      }
      case 'easypay':{
        const params={pid:c.pid,type:order.payment_method,out_trade_no:id,notify_url:notify,return_url:returnUrl,name:subject,money:amount,clientip:clientIp};
        const channel=c['cid_'+order.payment_method];if(channel)params.cid=channel;
        params.sign=createHash('md5').update(canonical(params)+c.pkey).digest('hex');params.sign_type='MD5';
        const base=c.api_base.replace(/\/(?:submit|mapi|api)\.php\/?$/i,'').replace(/\/$/,'');
        const {value}=await this.request('POST',base+'/mapi.php',{body:new URLSearchParams(params).toString(),headers:{'Content-Type':'application/x-www-form-urlencoded'}});
        if(value.code!==1||!value.trade_no||(!value.qrcode&&!value.payurl))throw new Error('EasyPay rejected');
        const result={reference:reference(value.trade_no)};
        if(value.qrcode)result.qr=value.qrcode.startsWith('/')?new URL(value.qrcode,base).href:value.qrcode;
        if(value.payurl){const url=new URL(value.payurl,base).href;try{result.url=checkoutURL(url,'easypay',c);}catch{if(!result.qr)result.qr=url;}}
        return result;
      }
      case 'suixingpay':{
        const data=await this.suixing(c.order_path,{mno:c.mch_id,ordNo:id,amt:amount,payType:order.payment_method==='alipay'?'ALIPAY':'WECHAT',subject,trmIp:c.terminal_ip,timeExpire:String(Math.min(1440,Math.ceil((expiresAt-Date.now()/1000)/60))),notifyUrl:notify,extend:id});
        if(data.ordNo!==id||(data.mno&&data.mno!==c.mch_id)||(data.amt&&paymentAmount(data.amt)!==order.amount_minor)||(data.payType&&data.payType!==(order.payment_method==='alipay'?'ALIPAY':'WECHAT'))||(data.extend&&data.extend!==id))mismatch();
        return {reference:reference(data.uuid),qr:checkoutURL(data.payUrl,'suixingpay',c)};
      }
      case 'airwallex':{
        const token=await this.airToken();
        const {value}=await this.request('POST',c.api_base+'/pa/payment_intents/create',{headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({request_id:id.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/,'$1-$2-$3-$4-$5'),amount:Number(amount),currency:'CNY',merchant_order_id:id,return_url:returnUrl,metadata:{order_id:id}})});
        this.observation(order,value);
        return {reference:reference(value.id),airwallex:{intent_id:reference(value.id),client_secret:reference(value.client_secret),currency:'CNY',country_code:c.country_code,env:c.api_base.includes('api-demo.')?'demo':'prod',successUrl:returnUrl}};
      }
      default:throw new Error('Unknown payment provider');
    }
  }
  observation(order,data) {
    const c=this.c;let id,ref,amount,currency='CNY',status='pending';
    switch(this.id){
      case 'stripe':
        id=data.metadata?.order_id;ref=data.id;amount=data.amount_total;currency=data.currency?.toUpperCase();
        if(data.mode!=='payment'||data.livemode!==c.secret_key.startsWith('sk_live_')||data.client_reference_id!==order.id||data.metadata?.user_id!==order.user_id)mismatch();
        status=data.payment_status==='paid'&&data.status==='complete'?'paid':data.status==='expired'?'expired':'pending';break;
      case 'alipay':id=data.out_trade_no;ref=data.trade_no||null;amount=paymentAmount(data.total_amount);if(data.app_id&&data.app_id!==c.app_id)mismatch();status=['TRADE_SUCCESS','TRADE_FINISHED'].includes(data.trade_status)?'paid':data.trade_status==='TRADE_CLOSED'?'expired':'pending';break;
      case 'wxpay':id=data.out_trade_no;ref=data.transaction_id||null;amount=data.amount?.total;currency=data.amount?.currency;if(data.appid!==c.app_id||data.mchid!==c.mch_id)mismatch();status=data.trade_state==='SUCCESS'?'paid':['CLOSED','PAYERROR'].includes(data.trade_state)?'expired':'pending';break;
      case 'easypay':id=data.out_trade_no;ref=data.trade_no;amount=paymentAmount(data.money);if(String(data.pid)!==c.pid||data.type!==order.payment_method)mismatch();status=data.status===1||data.trade_status==='TRADE_SUCCESS'?'paid':'pending';break;
      case 'suixingpay':id=data.ordNo;ref=data.uuid;amount=paymentAmount(data.oriTranAmt||data.amt);if((data.mno&&data.mno!==c.mch_id)||(data.orgId&&data.orgId!==c.org_id)||(data.currency&&data.currency!=='CNY')||data.payType!==(order.payment_method==='alipay'?'ALIPAY':'WECHAT')||data.extend!==order.id||(data.payWay&&data.payWay!=='00'))mismatch();status=data.tranSts==='SUCCESS'||data.bizCode==='0000'&&!data.tranSts?'paid':['FAIL','CLOSED','CANCELED'].includes(data.tranSts)?'expired':'pending';break;
      case 'airwallex':id=data.merchant_order_id;ref=data.id;amount=paymentAmount(data.amount);currency=data.currency;if(data.metadata?.order_id&&data.metadata.order_id!==order.id)mismatch();status=data.status==='SUCCEEDED'?'paid':data.status==='CANCELLED'?'expired':'pending';break;
    }
    if(id!==order.id||amount!==order.amount_minor||currency!=='CNY'||(order.provider_reference&&ref!==order.provider_reference)||status==='paid'&&!ref)mismatch();
    return {reference:ref?reference(ref):null,status};
  }
  async query(order,knownReference=order.provider_reference) {
    const c=this.c;let data;
    switch(this.id){
      case 'stripe':if(!knownReference)throw new HttpError(409,'payment_outcome_unknown','Wait for the signed notification; no confirmed session identity is known.');data=(await this.request('GET','https://api.stripe.com/v1/checkout/sessions/'+encodeURIComponent(knownReference),{headers:{Authorization:'Bearer '+c.secret_key}})).value;break;
      case 'alipay':data=await this.alipay('alipay.trade.query',{out_trade_no:order.id});break;
      case 'wxpay':data=await this.wx('GET','/v3/pay/transactions/out-trade-no/'+encodeURIComponent(order.id)+'?mchid='+encodeURIComponent(c.mch_id));break;
      case 'easypay':{
        const base=c.api_base.replace(/\/(?:submit|mapi|api)\.php\/?$/i,'').replace(/\/$/,'');
        data=(await this.request('POST',base+'/api.php',{body:new URLSearchParams({act:'order',pid:c.pid,key:c.pkey,out_trade_no:order.id}).toString(),headers:{'Content-Type':'application/x-www-form-urlencoded'}})).value;
        if(data.code!==1)throw new Error('EasyPay query failed');break;
      }
      case 'suixingpay':data=await this.suixing(c.query_path,{mno:c.mch_id,ordNo:order.id});if(data.payWay!=='00')mismatch();break;
      case 'airwallex':if(!knownReference)throw new HttpError(409,'payment_outcome_unknown','Wait for the signed payment-intent notification.');data=(await this.request('GET',c.api_base+'/pa/payment_intents/'+encodeURIComponent(knownReference),{headers:{Authorization:'Bearer '+await this.airToken()}})).value;break;
    }
    if(knownReference&&['stripe','airwallex'].includes(this.id)&&data.id!==knownReference)mismatch();return this.observation(order,data);
  }
  decodeWxNotification(raw,headers) {
    this.verifyWx(raw,headers);
    const event=paymentJSON(raw).value,eventId=reference(event.id);
    if(event.event_type!=='TRANSACTION.SUCCESS')return {eventId,data:null};
    const resource=event.resource;
    if(resource?.algorithm!=='AEAD_AES_256_GCM')mismatch();
    const bytes=Buffer.from(resource.ciphertext,'base64');if(bytes.length<17)mismatch();
    const decipher=createDecipheriv('aes-256-gcm',Buffer.from(this.c.api_v3_key),Buffer.from(resource.nonce));
    decipher.setAuthTag(bytes.subarray(-16));decipher.setAAD(Buffer.from(resource.associated_data||''));
    const rawData=Buffer.concat([decipher.update(bytes.subarray(0,-16)),decipher.final()]).toString('utf8');
    return {eventId,data:paymentJSON(rawData).value};
  }
  notification(raw,headers,order) {
    const c=this.c;let data,eventId;
    switch(this.id){
      case 'stripe':{
        const signature=headers.get('stripe-signature')||'',parts=signature.split(',').map(part=>part.trim().split('=')),times=parts.filter(([key])=>key==='t');
        if(times.length!==1)badSignature();const timestamp=times[0][1];validTime(timestamp);
        const expected=createHmac('sha256',c.webhook_secret).update(timestamp+'.').update(raw).digest('hex');
        if(!parts.some(([key,value])=>key==='v1'&&same(value,expected)))badSignature();
        const event=paymentJSON(raw).value;eventId=reference(event.id);
        if(event.livemode!==c.secret_key.startsWith('sk_live_'))badSignature();
        if(!['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed','checkout.session.expired'].includes(event.type))return null;
        data=event.data?.object;const observed=this.observation(order,data);
        return {...observed,eventId,eventType:event.type};
      }
      case 'alipay':case 'easypay':{
        data=formFields(raw);
        if(this.id==='alipay'){
          if(data.sign_type!=='RSA2'||data.app_id!==c.app_id||!verify('RSA-SHA256',Buffer.from(canonical(data)),rsaKey(c.public_key,this.id,'public_key'),Buffer.from(data.sign||'','base64')))mismatch();
        }else if(data.sign_type!=='MD5'||!same(data.sign||'',createHash('md5').update(canonical(data)+c.pkey).digest('hex')))mismatch();
        break;
      }
      case 'wxpay':{const decoded=this.decodeWxNotification(raw,headers);if(!decoded.data)return null;eventId=decoded.eventId;data=decoded.data;break;}
      case 'suixingpay':data=this.verifySuixing(raw);if(data.mno!==c.mch_id)mismatch();if(data.bizCode!=='0000')return null;break;
      case 'airwallex':{
        const timestamp=headers.get('x-timestamp'),signature=headers.get('x-signature');validTime(timestamp,String(timestamp).length===13);
        if(!same(signature?.toLowerCase()||'',createHmac('sha256',c.webhook_secret).update(timestamp).update(raw).digest('hex')))mismatch();
        const event=paymentJSON(raw).value;eventId=reference(event.id);if(!['payment_intent.succeeded','payment_intent.cancelled'].includes(event.name))return null;
        if(c.account_id&&event.account_id!==c.account_id&&event.account?.id!==c.account_id)mismatch();data=event.data?.object;break;
      }
    }
    return {...this.observation(order,data),eventId:eventId||createHash('sha256').update(raw).digest('hex')};
  }
  async test() {
    validateProviderConfig(this.id,this.c,{allowMissingWebhook:this.id==='stripe'});
    if(this.id==='stripe'){const {value}=await this.request('GET','https://api.stripe.com/v1/balance',{headers:{Authorization:'Bearer '+this.c.secret_key}});if(value.object!=='balance'||value.livemode!==this.c.secret_key.startsWith('sk_live_'))mismatch();return {ok:true,scope:'connection',live:value.livemode,webhook_verified:false};}
    if(this.id==='airwallex'){await this.airToken();return {ok:true,scope:'connection',webhook_verified:false};}
    return {ok:true,scope:'configuration',remote_verified:false,webhook_verified:false};
  }
}

export function notificationOrder(provider,raw) {
  if(['alipay','easypay'].includes(provider))return formFields(raw).out_trade_no;
  const data=paymentJSON(raw).value;
  if(provider==='stripe')return data.data?.object?.metadata?.order_id;
  if(provider==='airwallex')return data.data?.object?.merchant_order_id;
  if(provider==='suixingpay')return data.ordNo;
  return null; // WeChat's encrypted resource is selected by the order-specific notify URL.
}
