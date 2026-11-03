import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('webfonts stay optional so a late Chinese subset cannot repaint headings', () => {
  const css = readFileSync(new URL('../../public/fonts.css', import.meta.url), 'utf8');
  const faces = css.match(/@font-face\s*\{/g) || [];
  assert.ok(faces.length >= 4);
  assert.equal(css.includes('font-display: swap'), false);
  assert.equal((css.match(/font-display:\s*optional/g) || []).length, faces.length);
  const app = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /settleFonts\(\);/);
  assert.match(app, /await settleFonts\([\s\S]*?renderAuth\(path\);/);
  assert.match(app, /await settleFonts\([\s\S]*?content = shell\(route\);/);
});
