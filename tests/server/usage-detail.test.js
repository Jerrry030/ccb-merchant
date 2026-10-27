import test from 'node:test';
import assert from 'node:assert/strict';
import { usageDetail } from '../../public/usage-detail.js';

test('token detail splits cache creation and sums every class once', () => {
  const detail = usageDetail({
    usage_complete: true,
    cost_usd: 0.088959,
    usage: { input_tokens: 3617, output_tokens: 925, cache_creation_input_tokens: 48276, cache_creation_5m: 48276, cache_creation_1h: 0, cache_read_input_tokens: 110907 },
  });
  assert.deepEqual(detail.tokens, [
    { label: '输入 Token', tokens: 3617 },
    { label: '输出 Token', tokens: 925 },
    { label: '缓存创建', tokens: 48276, tag: '5m' },
    { label: '缓存读取 Token', tokens: 110907 },
  ]);
  assert.equal(detail.totalTokens, 163725);
  assert.equal(detail.cost, 0.088959);
});

test('cache creation shows both durations and any remainder', () => {
  const detail = usageDetail({ usage_complete: true, cost_usd: 1, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 100, cache_creation_5m: 40, cache_creation_1h: 50 } });
  assert.deepEqual(detail.tokens, [
    { label: '缓存创建', tokens: 40, tag: '5m' },
    { label: '缓存创建', tokens: 50, tag: '1h' },
    { label: '缓存创建', tokens: 10 },
  ]);
  assert.equal(detail.totalTokens, 100);
});

test('an inconsistent cache split stays on the recorded total', () => {
  const detail = usageDetail({ usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 100, cache_creation_5m: 80, cache_creation_1h: 50 } });
  assert.deepEqual(detail.tokens, [{ label: '缓存创建', tokens: 100 }]);
});

test('missing or negative token classes are not treated as zero', () => {
  const detail = usageDetail({ usage_complete: true, cost_usd: 2, usage: { input_tokens: 5, output_tokens: -1, cache_creation_5m: 7, cache_creation_1h: 11 } });
  assert.equal(detail.totalTokens, null);
});

test('incomplete usage keeps the saved total but does not describe a split', () => {
  const detail = usageDetail({ usage_complete: false, cost_usd: 4.2, usage: { input_tokens: 30, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
  assert.equal(detail.totalTokens, 35);
  assert.equal(detail.cost, 4.2);
});
