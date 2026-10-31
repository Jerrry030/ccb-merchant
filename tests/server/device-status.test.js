import test from 'node:test';
import assert from 'node:assert/strict';
import {deviceStatus} from '../../public/device-status.js';
const now=Date.parse('2026-10-31T00:00:00Z');
for(const [name,device,state,editable] of [
 ['approved is authorization, not online',{state:'approved',last_seen:'2000-01-01',expires_at:'2026-11-01'},'approved',true],
 ['expired at boundary',{state:'approved',expires_at:'2026-10-31'},'expired',false],
 ['pending expires',{state:'pending',expires_at:'2026-10-30'},'expired',false],
 ['revocation takes precedence',{state:'revoked',expires_at:'2026-10-30'},'revoked',false],
 ['cancelled',{state:'cancelled'},'cancelled',false],
 ['missing deadline is not invented',{state:'approved'},'approved',true],
 ['unknown state fails closed',{state:'unexpected'},'unknown',false],
])test('device status: '+name,()=>{const result=deviceStatus(device,now);assert.equal(result.state,state);assert.equal(result.editable,editable);assert.doesNotMatch(result.label,/在线|离线/);});
