// A protocol fixture, not a second OAuth implementation. All state is isolated
// per observed adjacent source and every accepted intent keeps its original ID.
export function custodyProvider(){
 const operations=new Map(),accounts=new Map();let lost=false;
 const onCore=({req,url,body,json,res})=>{
  const origin=req.headers['x-ccb-origin']||'',key=id=>origin+'|'+id,path=url.pathname;
  if(path==='/access/v1/account-intake'){json({available:true,environments:[{id:'private-env',name:'Singapore',region:'SG',timezone:'Asia/Singapore',platforms:['Windows/x64'],egress_id:'PRIVATE_PROXY'}]});return true;}
  let match=path.match(/^\/access\/v1\/account-authorizations\/([^/]+)(\/complete)?$/);
  if(match){
   const id=match[1];let a=operations.get(key(id));
   if(req.method==='PUT'){
    if(!a){a={id,status:'pending',auth_url:'https://example.invalid/authorize?state=fixture-state',intent:body};operations.set(key(id),a);}
    else if(JSON.stringify(a.intent)!==JSON.stringify(body)){json({code:'conflict'},409);return true;}
    if(lost){lost=false;res.destroy();return true;}
   }
   if(!a){json({code:'not_found'},404);return true;}
   if(match[2]){if(!body.callback_url?.includes('state=fixture-state')){json({code:'invalid'},400);return true;}a.status='success';a.account_id='managed-'+id;accounts.set(key(a.account_id),{id:a.account_id,name:a.intent.name,status:'active',platform:'Windows/x64',environment_id:'private-env',resource_id:'resource-'+origin,account_lease_id:'lease-'+id,revision:1});}
   if(req.method==='DELETE'){if(a.status==='success'){json({code:'conflict'},409);return true;}a.status='cancelled';}
   const {intent,...view}=a;if(a.status!=='pending')delete view.auth_url;json({authorization:view,ok:true});return true;
  }
  if(path==='/access/v1/managed-accounts'){json({accounts:[...accounts.entries()].filter(([k])=>k.startsWith(origin+'|')).map(([,v])=>v),next_cursor:'',limit:500});return true;}
  match=path.match(/^\/access\/v1\/managed-accounts\/([^/]+)$/);
  if(match){const a=accounts.get(key(match[1]));if(!a){json({code:'not_found'},404);return true;}if(req.method!=='GET'){if(body.expected_revision!==a.revision){json({code:'conflict'},409);return true;}a.status=req.method==='DELETE'?'closed':body.status;a.revision++;}json({account:a,ok:true});return true;}
  return false;
 };
 return {onCore,operations,accounts,set loseResponse(value){lost=value;}};
}
