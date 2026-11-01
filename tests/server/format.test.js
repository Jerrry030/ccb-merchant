import test from 'node:test';
import assert from 'node:assert/strict';
import { resetRemaining } from '../../public/format.js';

const now = Date.parse('2026-11-01T12:00:00+08:00');

test('quota reset time uses days above 24h and minutes below', () => {
  assert.equal(resetRemaining('2026-11-14T18:30:40+08:00', now), '13d 6h后重置');
  assert.equal(resetRemaining('2026-11-02T12:10:00+08:00', now), '1d 0h后重置');
  assert.equal(resetRemaining('2026-11-02T12:00:00+08:00', now), '1d 0h后重置');
  assert.equal(resetRemaining('2026-11-02T11:59:00+08:00', now), '23h 59min后重置');
  assert.equal(resetRemaining('2026-11-01T17:32:40+08:00', now), '5h 32min后重置');
  assert.equal(resetRemaining('2026-11-01T12:32:00+08:00', now), '0h 32min后重置');
  assert.equal(resetRemaining('2026-11-01T12:00:30+08:00', now), '0h 0min后重置');
  assert.equal(resetRemaining('2026-11-01T12:00:00+08:00', now), '已重置');
  assert.equal(resetRemaining('2026-11-01T11:00:00+08:00', now), '已重置');
  assert.equal(resetRemaining('not-a-date', now), '—');
  assert.equal(resetRemaining('', now), '—');
});
