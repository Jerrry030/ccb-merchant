import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { fixture } from './fixtures.js';

test('approved auth background is served as exact WebP bytes by the real application', async t => {
  const f = await fixture(t,{publicDir:fileURLToPath(new URL('../../public',import.meta.url)),withoutCore:true});
  const expected = await readFile(new URL('../../public/auth-mist-lake.webp',import.meta.url));
  assert.equal(expected.subarray(0,4).toString('ascii'),'RIFF');
  assert.equal(expected.subarray(8,12).toString('ascii'),'WEBP');
  const response = await fetch(f.config.publicOrigin + '/auth-mist-lake.webp');
  assert.equal(response.status,200);
  assert.equal(response.headers.get('content-type'),'image/webp');
  assert.equal(response.headers.get('content-length'),String(expected.length));
  assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  assert.equal(response.headers.get('set-cookie'),null);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),expected);
  const head = await fetch(f.config.publicOrigin + '/auth-mist-lake.webp',{method:'HEAD'});
  assert.equal(head.status,200);
  assert.equal(head.headers.get('content-type'),'image/webp');
  assert.equal(head.headers.get('content-length'),String(expected.length));
  assert.equal((await head.arrayBuffer()).byteLength,0);
  const missing = await fetch(f.config.publicOrigin + '/missing-auth-background.webp');
  assert.equal(missing.status,404);
  assert.equal(f.state.requests.length,0,'serving the artwork never contacts the upstream');
});
