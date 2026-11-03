import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { desktopTargets, parseDesktopRelease } from '../../public/desktop-releases.js';
const catalog = () => ({ product: 'ACCB', version: '0.1.1', source_commit: 'a'.repeat(40), files: desktopTargets.map(target => ({ target: target.id, name: 'Anthropic-ccb-0.1.1-' + target.suffix, size: 1234, sha256: 'b'.repeat(64) })) });
test('ACCB downloads use finite system choices and same-origin versioned paths', () => {
  const value = catalog(); value.files[0].url = 'https://untrusted.example/download';
  const parsed = parseDesktopRelease(value);
  assert.equal(parsed.files.length, 4);
  assert.equal(parsed.files[0].href, '/downloads/accb/0.1.1/Anthropic-ccb-0.1.1-windows-x64-setup.exe');
  assert.deepEqual(parsed.files.map(file => file.id), desktopTargets.map(target => target.id));
  assert.deepEqual(parseDesktopRelease({ product: 'ACCB', version: null, files: [] }), { version: null, files: [] });
});
test('invalid or ambiguous release metadata never becomes a download link', () => {
  for (const mutate of [value => value.version = '../../private', value => value.product = 'CCB Code', value => value.source_commit = '', value => value.files[0].target = 'unknown', value => value.files[0].name = '../secret.exe', value => value.files[0].sha256 = '', value => value.files[0].size = -1, value => value.files[0].size = 0.1, value => value.files[0].size = 2147483649, value => value.files[1] = value.files[0], value => value.files.push(value.files[0])]) {
    const value = catalog(); mutate(value); assert.throws(() => parseDesktopRelease(value));
  }
  for (const value of [null, {}, { product: 'ACCB', files: null }]) assert.throws(() => parseDesktopRelease(value));
});

test('published catalog and supported release targets exclude the withdrawn Windows portable target', () => {
  const expected = ['windows-x64-setup', 'mac-arm64', 'mac-x64', 'linux-x64'];
  assert.deepEqual(desktopTargets.map(target => target.id), expected);
  const published = JSON.parse(readFileSync(new URL('../../public/accb-releases.json', import.meta.url), 'utf8'));
  assert.deepEqual(parseDesktopRelease(published).files.map(file => file.id), expected);
  const retired = catalog();
  retired.files = [{ target: 'win-x64', name: 'Anthropic-ccb-0.1.1-win-x64.zip', size: 1234, sha256: 'b'.repeat(64) }];
  assert.throws(() => parseDesktopRelease(retired), /Invalid ACCB artifact/);
});
