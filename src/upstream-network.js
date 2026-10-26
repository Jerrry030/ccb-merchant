import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP, BlockList } from 'node:net';
import { Readable } from 'node:stream';
import { HttpError } from './security.js';

const privateIPs=new BlockList();
for(const [ip,bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.168.0.0',16],['192.0.0.0',24],['198.18.0.0',15],['224.0.0.0',4],['240.0.0.0',4]]) privateIPs.addSubnet(ip,bits,'ipv4');
for(const [ip,bits] of [['::',128],['::1',128],['fc00::',7],['fe80::',10],['ff00::',8]]) privateIPs.addSubnet(ip,bits,'ipv6');
const forbiddenIPs=new BlockList();
for(const [ip,bits] of [['0.0.0.0',8],['169.254.0.0',16],['224.0.0.0',4],['240.0.0.0',4]])forbiddenIPs.addSubnet(ip,bits,'ipv4');
for(const [ip,bits] of [['::',128],['fe80::',10],['ff00::',8],['64:ff9b::',96],['64:ff9b:1::',48],['2002::',16]])forbiddenIPs.addSubnet(ip,bits,'ipv6');

// DNS answers are checked then pinned to the socket. A second lookup cannot
// redirect a verified public hostname into the local network. No redirects,
// cookies, system proxy credentials or environment-driven forward proxy.
export async function upstreamFetch(config,target,options={}) {
 let url;try{url=new URL(target);}catch{throw new HttpError(400,'invalid_upstream','Invalid upstream URL.');}
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash||url.origin===config.publicOrigin)throw new HttpError(400,'invalid_upstream','Invalid or self-referencing upstream.');
 const allowed=config.upstreamAllowedOrigins.includes(url.origin);
 if(url.protocol!=='https:'&&!allowed)throw new HttpError(400,'upstream_target_blocked','HTTP/private targets require an operator-approved exact origin.');
 const host=url.hostname.replace(/^\[|\]$/g,'');
 const resolving=isIP(host)?Promise.resolve([{address:host,family:isIP(host)}]):lookup(host,{all:true,verbatim:true});
 let cancel;
 const stopped=options.signal?new Promise((_,reject)=>{cancel=()=>reject(new Error('aborted'));if(options.signal.aborted)cancel();else options.signal.addEventListener('abort',cancel,{once:true});}):new Promise(()=>{});
 let addresses;try{addresses=await Promise.race([resolving,stopped]);}finally{if(cancel)options.signal.removeEventListener('abort',cancel);}
 if(!addresses.length||addresses.some(a=>(a.family===6&&a.address.toLowerCase().startsWith('::ffff:'))||forbiddenIPs.check(a.address,a.family===6?'ipv6':'ipv4')||(!allowed&&privateIPs.check(a.address,a.family===6?'ipv6':'ipv4'))))throw new HttpError(400,'upstream_target_blocked','Resolved address is not allowed by the server network policy.');
 const selected=addresses[0];
 return await new Promise((resolve,reject)=>{
  const request=(url.protocol==='https:'?httpsRequest:httpRequest)(url,{method:options.method||'GET',headers:options.headers,signal:options.signal,agent:false,maxHeaderSize:16384,
   lookup:(_name,opts,cb)=>opts.all?cb(null,[selected]):cb(null,selected.address,selected.family)},response=>{
    const headers=new Headers();for(const [name,value] of Object.entries(response.headers))for(const item of Array.isArray(value)?value:[value])if(item!==undefined)headers.append(name,item);
    if(response.statusCode>=300&&response.statusCode<400){response.destroy();reject(new HttpError(503,'upstream_redirect_rejected','Upstream redirects are not followed.'));return;}
    const body=[204,205,304].includes(response.statusCode)?null:Readable.toWeb(response);
    resolve(new Response(body,{status:response.statusCode,headers}));
  });
  request.on('error',reject);request.end(options.body);
 });
}

export async function readUpstreamJSON(response,max=4*1024*1024){
 const chunks=[];let size=0;
 try {for await(const chunk of response.body){size+=chunk.length;if(size>max)throw new Error('response limit');chunks.push(chunk);}}
 catch(error){await response.body?.cancel().catch(()=>{});throw error;}
 return JSON.parse(Buffer.concat(chunks).toString('utf8'),(key,value,context)=>key==='id'&&typeof value==='number'&&!Number.isSafeInteger(value)&&/^\d+$/.test(context.source||'')?context.source:value);
}
