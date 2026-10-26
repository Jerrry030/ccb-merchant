import { loadConfig } from './config.js';
import { createMerchant } from './server.js';

try {
  const config=loadConfig();
  const {server,store,reconciler}=createMerchant(config,{onError:code=>console.error(code)});
  server.on('error',()=>{ console.error('Merchant listener failed. Check bind address and port.'); process.exitCode=1; store.db.close(); });
  server.listen(config.port,config.host,()=>{
    console.log(`CCB Merchant listening on ${config.host}:${config.port}; public origin ${config.publicOrigin}`);
    if(store.db.prepare("SELECT 1 FROM settings WHERE key='setup_hash'").get()) console.log(`One-time setup secret saved outside public root: ${store.setupFile}. Read it locally; do not publish it.`);
  });
  let stopping=false;
  for(const signal of ['SIGINT','SIGTERM']) process.on(signal,async()=>{
    if(stopping) return; stopping=true;
    await reconciler.stop();
    server.close(()=>{store.db.close(); process.exitCode=0;});
    const timer=setTimeout(()=>server.closeAllConnections(),10000); timer.unref();
  });
} catch {
  // URL parsers and transports can include supplied values in error objects: never print them.
  console.error('Merchant startup failed. Check private configuration and data-directory permissions.');
  process.exitCode=1;
}
