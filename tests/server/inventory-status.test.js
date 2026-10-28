import test from 'node:test';
import assert from 'node:assert/strict';
import { inventoryStatus } from '../../public/inventory-status.js';

const now = Date.parse('2026-10-28T12:00:00Z');
const account = { id:'current', status:'active', assigned:false, expires_at:'2026-11-28T12:00:00Z', details:{name:'same@example.test',state:'available'} };

for (const {name, values, history, active, assignable, label} of [
  {name:'available lease', values:{}, history:false, active:true, assignable:true, label:'可分配'},
  {name:'assigned lease', values:{assigned:true}, history:false, active:true, assignable:false, label:'已分配'},
  {name:'limited but assignable lease', values:{details:{state:'limited'}}, history:false, active:true, assignable:true, label:'可分配'},
  {name:'released lease with a stale assignment', values:{status:'released',assigned:true}, history:true, active:false, assignable:false, label:'已释放'},
  {name:'released lease past its original expiry', values:{status:'released',expires_at:'2026-10-01T00:00:00Z'}, history:true, active:false, assignable:false, label:'已释放'},
  {name:'explicit expiry despite future timestamp', values:{status:'expired'}, history:true, active:false, assignable:false, label:'已到期'},
  {name:'elapsed expiry despite active upstream status', values:{expires_at:'2026-10-01T00:00:00Z',assigned:true}, history:true, active:false, assignable:false, label:'已到期'},
  {name:'exact expiry boundary', values:{expires_at:new Date(now).toISOString()}, history:true, active:false, assignable:false, label:'已到期'},
  {name:'last millisecond of validity', values:{expires_at:new Date(now+1).toISOString()}, history:false, active:true, assignable:true, label:'可分配'},
  {name:'temporary upstream failure', values:{details:{state:'unavailable'}}, history:false, active:true, assignable:false, label:'暂不可用'},
  {name:'assigned but temporarily unavailable', values:{assigned:true,details:{state:'unavailable'}}, history:false, active:true, assignable:false, label:'暂不可用'},
  {name:'expired detail is not an expired lease', values:{details:{state:'expired'}}, history:false, active:true, assignable:false, label:'暂不可用'},
  {name:'missing details', values:{details:null}, history:false, active:true, assignable:false, label:'暂不可用'},
  {name:'unrecognized upstream status', values:{status:'pending'}, history:false, active:false, assignable:false, label:'状态待核对'},
  {name:'missing upstream status', values:{status:undefined}, history:false, active:false, assignable:false, label:'状态待核对'},
  {name:'unknown assignment must not become assignable', values:{assigned:undefined}, history:false, active:true, assignable:false, label:'状态待核对'},
  {name:'missing expiry', values:{expires_at:undefined,assigned:true}, history:false, active:false, assignable:false, label:'有效期待核对'},
  {name:'null expiry', values:{expires_at:null}, history:false, active:false, assignable:false, label:'有效期待核对'},
  {name:'invalid expiry', values:{expires_at:'not-a-date'}, history:false, active:false, assignable:false, label:'有效期待核对'},
]) {
  test(`inventory classification: ${name}`, () => {
    const input={...account,...values},before=structuredClone(input),result=inventoryStatus(input,now);
    assert.deepEqual({history:result.history,active:result.active,assignable:result.assignable,label:result.label},{history,active,assignable,label});
    assert.deepEqual(input,before,'Classification must not mutate upstream records');
    if(!history&&!assignable&&label!=='已分配')assert.ok(result.reason,'Uncertain current records need an explanation');
  });
}

test('reallocation and same-name independent leases keep their own status and identity', () => {
  const rows=[{...account,id:'previous',status:'released'},{...account,id:'current'},{...account,id:'other-current'}];
  const states=rows.map(row=>inventoryStatus(row,now));
  assert.deepEqual(rows.filter((_,i)=>!states[i].history).map(row=>row.id),['current','other-current']);
  assert.deepEqual(rows.filter((_,i)=>states[i].history).map(row=>row.id),['previous']);
  assert.equal(states.filter(state=>state.assignable).length,2);
});
