import assert from 'node:assert/strict';
import { password } from './fixtures.js';

// Synthetic business data shared by HTTP and shipped-browser regressions.
export async function seedAdminWorkflow(f, admin) {
  const users=[];
  for(const [email,display_name] of [['alice@example.test','星河设计'],['bob@example.test','北辰开发']]) {
    const response=await f.request('POST','/api/admin/users',{email,display_name,password,role:'member'},admin);
    assert.equal(response.status,201);users.push(response.data.user);
  }
  for(let i=0;i<2;i++) {
    const account=f.state.inventory[i];
    const result=await f.request('POST','/api/admin/grants',{user_id:users[i].id,resource_id:account.resource_id,account_lease_id:account.id,expected_account_revision:account.revision,expires_at:new Date(Date.now()+(i?20:2)*86400000).toISOString()},admin);
    assert.equal(result.status,201);
  }
  f.state.inventory[2].details.state='unavailable';
  f.state.inventory[3].expires_at=new Date(Date.now()+5*86400000).toISOString();
  f.state.inventory[4].status='released';
  const saved=await f.request('POST','/api/admin/plans',{name:'测试月租',resource_id:'resource-1',duration_days:30,amount_minor:9900,status:'active'},admin);
  assert.equal(saved.status,201);
  const now=new Date().toISOString();
  const insertRental=f.store.db.prepare("INSERT INTO rentals(id,user_id,request_id,plan_id,plan_revision,name,resource_id,duration_days,amount_minor,currency,payment_method,platform,status,created_at,updated_at) VALUES(?,?,?,?,1,'测试月租','resource-1',30,9900,'CNY','wallet','MacOS/arm64',?,?,?)");
  for(const [id,status,user] of [['r-review','review',users[0]],['r-refund','refund_pending',users[0]],['r-done','fulfilled',users[0]],['r-bob','review',users[1]]]) insertRental.run(id,user.id,id,saved.data.plan.id,status,now,now);
  const insertOrder=f.store.db.prepare("INSERT INTO orders(id,user_id,amount_minor,currency,status,created_at,updated_at) VALUES(?,?,9900,'CNY',?,?,?)");
  for(const status of ['creating','pending','unknown','paid']) insertOrder.run('pay-'+status,users[0].id,status,now,now);
  insertOrder.run('pay-bob',users[1].id,'unknown',now,now);
  return {alice:users[0],bob:users[1],plan:saved.data.plan};
}
