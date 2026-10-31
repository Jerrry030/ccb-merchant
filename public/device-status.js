// Device authorization is not live presence. Expiration is derived only from
// an observed deadline, never from the time of the last request.
export function deviceStatus(device,now=Date.now()) {
 let state=device.state;
 if(['approved','pending'].includes(state)&&Number.isFinite(Date.parse(device.expires_at))&&Date.parse(device.expires_at)<=now)state='expired';
 const labels={approved:'已授权',pending:'待确认',expired:'已到期',revoked:'已撤销',cancelled:'已取消'};
 if(!Object.hasOwn(labels,state))state='unknown';
 return {state,label:labels[state]||'状态未知',tone:state==='approved'?'good':['pending','expired','unknown'].includes(state)?'warn':'',editable:state==='approved',revocable:!['revoked','cancelled'].includes(state)};
}
