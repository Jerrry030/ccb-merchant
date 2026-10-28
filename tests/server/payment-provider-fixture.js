import assert from 'node:assert/strict';
import { generateKeyPairSync,sign,verify,createHash,createHmac,createCipheriv } from 'node:crypto';

// Synthetic merchants, independent protocol request verification and signed responses.
// This fixture never contacts a real provider and holds no live credentials.
export function providerFixture({merchantBits=2048}={}) {
  const merchant=generateKeyPairSync('rsa',{modulusLength:merchantBits}),platform=generateKeyPairSync('rsa',{modulusLength:2048});
  const privateKey=merchant.privateKey.export({format:'pem',type:'pkcs8'}),publicKey=platform.publicKey.export({format:'pem',type:'spki'});
  const configs={
    alipay:{enabled:true,app_id:'202610270001',private_key:privateKey,public_key:publicKey},
    wxpay:{enabled:true,app_id:'wxfixture',mch_id:'1900000001',private_key:privateKey,public_key:publicKey,public_key_id:'PUB_KEY_ID_FIXTURE',api_v3_key:'12345678901234567890123456789012',cert_serial:'ABCD1234'},
    easypay:{enabled:true,pid:'10001',pkey:'fixture-easypay-secret',api_base:'https://easy.example.test',cid_alipay:'1',cid_wxpay:'2'},
    suixingpay:{enabled:true,api_base:'https://suixing.example.test',org_id:'fixtureorg',mch_id:'fixturemerchant',terminal_ip:'203.0.113.8',private_key:privateKey,public_key:publicKey,sign_type:'RSA2',order_path:'/order/activePlusScan',query_path:'/query/tradeQuery'},
    airwallex:{enabled:true,client_id:'fixtureclient',api_key:'fixture-airwallex-key',webhook_secret:'fixture-airwallex-webhook',api_base:'https://api-demo.airwallex.com/api/v1',country_code:'CN',currency:'CNY',account_id:''},
  };
  const orders=new Map(),requests=[];let corruptSignature=false,dropCreate=false;
  function signedJSON(method,value){const text=JSON.stringify(value);return new Response('{"'+method.replaceAll('.','_')+'_response":'+text+',"sign":'+JSON.stringify(sign('RSA-SHA256',Buffer.from(text),platform.privateKey).toString('base64'))+'}',{headers:{'Content-Type':'application/json'}});}
  function wxResponse(value){const raw=JSON.stringify(value),timestamp=String(Math.floor(Date.now()/1000)),nonce='fixture-response-nonce';return new Response(raw,{headers:{'Content-Type':'application/json','Wechatpay-Timestamp':timestamp,'Wechatpay-Nonce':nonce,'Wechatpay-Serial':configs.wxpay.public_key_id,'Wechatpay-Signature':corruptSignature?'bad':sign('RSA-SHA256',Buffer.from(timestamp+'\n'+nonce+'\n'+raw+'\n'),platform.privateKey).toString('base64')}});}
  function suiResponse(req,data){const result={orgId:configs.suixingpay.org_id,reqId:req.reqId,signType:configs.suixingpay.sign_type,code:'0000',respData:data};const base=Object.keys(result).sort().map(key=>key+'='+(typeof result[key]==='object'?JSON.stringify(result[key]):result[key])).join('&');result.sign=corruptSignature?'bad':sign(configs.suixingpay.sign_type==='RSA'?'RSA-SHA1':'RSA-SHA256',Buffer.from(base),platform.privateKey).toString('base64');return Response.json(result);}
  function observation(provider,order) {
    const paid=order.paid,status=order.closed;
    if(provider==='alipay')return {code:'10000',out_trade_no:order.id,trade_no:'ali_'+order.id,total_amount:order.amount,trade_status:paid?'TRADE_SUCCESS':status?'TRADE_CLOSED':'WAIT_BUYER_PAY',...order.patch};
    if(provider==='wxpay')return {appid:configs.wxpay.app_id,mchid:configs.wxpay.mch_id,out_trade_no:order.id,...(paid?{transaction_id:'wx_'+order.id}:{}),amount:{total:order.minor,currency:'CNY'},trade_state:paid?'SUCCESS':status?'CLOSED':'NOTPAY',...order.patch};
    if(provider==='easypay')return {code:1,pid:configs.easypay.pid,type:order.method,out_trade_no:order.id,trade_no:'easy_'+order.id,money:order.amount,status:paid?1:0,...order.patch};
    if(provider==='suixingpay')return {bizCode:'0000',mno:configs.suixingpay.mch_id,orgId:configs.suixingpay.org_id,ordNo:order.id,uuid:'sui_'+order.id,oriTranAmt:order.amount,amt:order.amount,payType:order.method==='alipay'?'ALIPAY':'WECHAT',payWay:'00',extend:order.id,tranSts:paid?'SUCCESS':status?'CLOSED':'PAYING',...order.patch};
    return {id:'int_'+order.id,merchant_order_id:order.id,metadata:{order_id:order.id},amount:Number(order.amount),currency:'CNY',status:paid?'SUCCEEDED':status?'CANCELLED':'REQUIRES_PAYMENT_METHOD',...order.patch};
  }
  const transport=async(url,options)=>{
    requests.push({url,options});const u=new URL(url);let body=options.body?String(options.body):'',request;
    if(u.hostname==='openapi.alipay.com') {
      const params=Object.fromEntries(new URLSearchParams(body));const base=Object.keys(params).filter(k=>k!=='sign').sort().map(k=>k+'='+params[k]).join('&');assert.equal(verify('RSA-SHA256',Buffer.from(base),merchant.publicKey,Buffer.from(params.sign,'base64')),true);
      request=JSON.parse(params.biz_content);
      if(params.method==='alipay.trade.precreate'){orders.set(request.out_trade_no,{id:request.out_trade_no,amount:request.total_amount,minor:Math.round(Number(request.total_amount)*100),method:'alipay',notify:params.notify_url});if(dropCreate)throw new Error('fixture lost response');return signedJSON(params.method,{code:'10000',out_trade_no:request.out_trade_no,qr_code:'https://qr.alipay.com/'+request.out_trade_no});}
      return signedJSON(params.method,observation('alipay',orders.get(request.out_trade_no)));
    }
    if(u.hostname==='api.mch.weixin.qq.com'){
      const auth=Object.fromEntries([...options.headers.Authorization.matchAll(/(\w+)="([^"]+)"/g)].map(match=>[match[1],match[2]]));
      assert.equal(auth.mchid,configs.wxpay.mch_id);assert.equal(verify('RSA-SHA256',Buffer.from(options.method+'\n'+u.pathname+u.search+'\n'+auth.timestamp+'\n'+auth.nonce_str+'\n'+body+'\n'),merchant.publicKey,Buffer.from(auth.signature,'base64')),true);
      if(options.method==='POST'){request=JSON.parse(body);orders.set(request.out_trade_no,{id:request.out_trade_no,amount:(request.amount.total/100).toFixed(2),minor:request.amount.total,method:'wxpay',notify:request.notify_url});if(dropCreate)throw new Error('fixture lost response');return wxResponse({code_url:'weixin://wxpay/bizpayurl?pr='+request.out_trade_no});}
      return wxResponse(observation('wxpay',orders.get(u.pathname.split('/').at(-1))));
    }
    if(u.hostname==='easy.example.test'){
      const params=Object.fromEntries(new URLSearchParams(body));
      if(u.pathname==='/mapi.php'){
        const base=Object.keys(params).filter(k=>!['sign','sign_type'].includes(k)&&params[k]!=='').sort().map(k=>k+'='+params[k]).join('&');assert.equal(params.sign,createHash('md5').update(base+configs.easypay.pkey).digest('hex'));
        orders.set(params.out_trade_no,{id:params.out_trade_no,amount:params.money,minor:Math.round(Number(params.money)*100),method:params.type,notify:params.notify_url});if(dropCreate)throw new Error('fixture lost response');return Response.json({code:1,trade_no:'easy_'+params.out_trade_no,qrcode:'https://easy.example.test/qr/'+params.out_trade_no,payurl:'https://easy.example.test/pay/'+params.out_trade_no});
      }
      assert.equal(params.key,configs.easypay.pkey);assert.equal(params.pid,configs.easypay.pid);return Response.json(observation('easypay',orders.get(params.out_trade_no)));
    }
    if(u.hostname==='suixing.example.test'){
      request=JSON.parse(body);const base=Object.keys(request).filter(k=>k!=='sign').sort().map(k=>k+'='+(typeof request[k]==='object'?JSON.stringify(request[k]):request[k])).join('&');assert.equal(verify(configs.suixingpay.sign_type==='RSA'?'RSA-SHA1':'RSA-SHA256',Buffer.from(base),merchant.publicKey,Buffer.from(request.sign,'base64')),true);
      const d=request.reqData;if(u.pathname===configs.suixingpay.order_path){orders.set(d.ordNo,{id:d.ordNo,amount:d.amt,minor:Math.round(Number(d.amt)*100),method:d.payType==='ALIPAY'?'alipay':'wxpay',notify:d.notifyUrl});if(dropCreate)throw new Error('fixture lost response');return suiResponse(request,{bizCode:'0000',ordNo:d.ordNo,uuid:'sui_'+d.ordNo,mno:d.mno,amt:d.amt,payUrl:'https://suixing.example.test/pay/'+d.ordNo});}
      return suiResponse(request,observation('suixingpay',orders.get(d.ordNo)));
    }
    if(u.hostname==='api-demo.airwallex.com'){
      if(u.pathname.endsWith('/authentication/login')){assert.equal(options.headers['x-api-key'],configs.airwallex.api_key);return Response.json({token:'fixture-airwallex-access-token'});}
      assert.equal(options.headers.Authorization,'Bearer fixture-airwallex-access-token');
      if(u.pathname.endsWith('/create')){request=JSON.parse(body);assert.match(request.request_id,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);orders.set(request.merchant_order_id,{id:request.merchant_order_id,amount:Number(request.amount).toFixed(2),minor:Math.round(request.amount*100),method:'airwallex'});if(dropCreate)throw new Error('fixture lost response');return Response.json({...observation('airwallex',orders.get(request.merchant_order_id)),client_secret:'fixture-intent-secret'});}
      return Response.json(observation('airwallex',orders.get(u.pathname.split('/').at(-1).replace(/^int_/,''))));
    }
    throw new Error('Unexpected external URL in fixture');
  };
  function notification(provider,id,patch={}) {
    const order=orders.get(id);let data=observation(provider,{...order,paid:true,patch}),headers={},raw;
    if(provider==='alipay'||provider==='easypay'){
      if(provider==='alipay')data={app_id:configs.alipay.app_id,out_trade_no:id,trade_no:'ali_'+id,total_amount:order.amount,trade_status:'TRADE_SUCCESS',sign_type:'RSA2',...patch};
      else data={pid:configs.easypay.pid,type:order.method,out_trade_no:id,trade_no:'easy_'+id,money:order.amount,trade_status:'TRADE_SUCCESS',sign_type:'MD5',...patch};
      const base=Object.keys(data).filter(k=>k!=='sign_type').sort().map(k=>k+'='+data[k]).join('&');data.sign=provider==='alipay'?sign('RSA-SHA256',Buffer.from(base),platform.privateKey).toString('base64'):createHash('md5').update(base+configs.easypay.pkey).digest('hex');raw=new URLSearchParams(data).toString();headers['Content-Type']='application/x-www-form-urlencoded';
    } else if(provider==='wxpay'){
      const nonce='123456789012',aad='transaction',cipher=createCipheriv('aes-256-gcm',Buffer.from(configs.wxpay.api_v3_key),Buffer.from(nonce));cipher.setAAD(Buffer.from(aad));const encrypted=Buffer.concat([cipher.update(JSON.stringify(data)),cipher.final(),cipher.getAuthTag()]);
      raw=JSON.stringify({id:'evt_'+id,event_type:'TRANSACTION.SUCCESS',resource:{algorithm:'AEAD_AES_256_GCM',nonce,associated_data:aad,ciphertext:encrypted.toString('base64')}});
      const timestamp=String(Math.floor(Date.now()/1000));headers={'Wechatpay-Timestamp':timestamp,'Wechatpay-Nonce':'notify-nonce','Wechatpay-Serial':configs.wxpay.public_key_id,'Wechatpay-Signature':sign('RSA-SHA256',Buffer.from(timestamp+'\nnotify-nonce\n'+raw+'\n'),platform.privateKey).toString('base64')};
    }else if(provider==='suixingpay'){
      delete data.oriTranAmt;data.signType=configs.suixingpay.sign_type;const base=Object.keys(data).sort().map(k=>k+'='+data[k]).join('&');data.sign=sign(configs.suixingpay.sign_type==='RSA'?'RSA-SHA1':'RSA-SHA256',Buffer.from(base),platform.privateKey).toString('base64');raw=JSON.stringify(data);
    }else{
      raw=JSON.stringify({id:'evt_'+id,name:'payment_intent.succeeded',data:{object:data}});const timestamp=String(Date.now());headers={'x-timestamp':timestamp,'x-signature':createHmac('sha256',configs.airwallex.webhook_secret).update(timestamp+raw).digest('hex')};
    }
    return {raw,headers:{'Content-Type':'application/json',...headers},path:'/api/webhooks/'+provider+'/'+id};
  }
  return {configs,orders,requests,transport,notification,set dropCreate(value){dropCreate=value;},set corruptSignature(value){corruptSignature=value;}};
}
