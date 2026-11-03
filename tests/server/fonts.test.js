import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const publicRoot = new URL('../../public/',import.meta.url);

test('all page typography uses installed fonts, never asynchronous webfont faces', () => {
  const base = readFileSync(new URL('base.css',publicRoot),'utf8');
  assert.match(base,/--font-sans:\s*system-ui,/);
  assert.match(base,/--font-serif:[^;]*"Songti SC"[^;]*"SimSun"/);
  assert.match(base,/--font-mono:\s*ui-monospace,/);
  for (const file of readdirSync(publicRoot).filter(name=>name.endsWith('.css'))) {
    const css = readFileSync(new URL(file,publicRoot),'utf8');
    assert.doesNotMatch(css,/@font-face|\.woff2?\b|Source Serif 4|Noto Serif SC|Instrument Sans|JetBrains Mono/,file+' must not introduce downloadable faces');
  }
});

test('SPA and standalone checkout do not request font stylesheets or block rendering on font preheating', () => {
  for (const file of readdirSync(publicRoot).filter(name=>/\.(html|js)$/.test(name))) {
    const source = readFileSync(new URL(file,publicRoot),'utf8');
    assert.doesNotMatch(source,/fonts\.css|as=["']font["']|document\.fonts\.(?:load|ready)|\bFontFace\b/,file+' must render with the shared system font stack');
  }
});
