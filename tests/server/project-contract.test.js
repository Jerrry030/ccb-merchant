import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, realpathSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { parseDocument } from 'yaml';
import { loadConfig } from '../../src/config.js';
import { installCaddy } from '../../scripts/install-caddy.mjs';
import { inspectRepositoryEntry } from '../../scripts/check-repository.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

function toolFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'merchant-tooling-test-'));
  t.after(() => {
    const actual = realpathSync(directory), inside = relative(realpathSync(tmpdir()), actual);
    assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside) && basename(actual).startsWith('merchant-tooling-test-'));
    rmSync(actual, { recursive: true, force: true });
  });
  return directory;
}

test('test tools have exact versions, lockfile integrity and no production dependency promotion', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const node = readFileSync(join(root, '.node-version'), 'utf8').trim();
  assert.match(node, /^24\.\d+\.\d+$/);
  assert.ok(Number(node.split('.')[1]) >= 15);
  assert.equal(pkg.engines.node, '>=24.15.0 <25');
  for (const name of ['playwright', 'yaml']) {
    assert.match(pkg.devDependencies[name], /^\d+\.\d+\.\d+$/);
    assert.equal(pkg.dependencies[name], undefined);
    assert.equal(lock.packages[''].devDependencies[name], pkg.devDependencies[name]);
    assert.equal(lock.packages['node_modules/' + name].version, pkg.devDependencies[name]);
    assert.equal(lock.packages['node_modules/' + name].dev, true);
    assert.match(lock.packages['node_modules/' + name].integrity, /^sha512-/);
  }
  assert.equal(lock.packages['node_modules/playwright-core'].version, pkg.devDependencies.playwright);
  const browsers = JSON.parse(readFileSync(join(root, 'node_modules/playwright-core/browsers.json'), 'utf8'));
  assert.match(browsers.browsers.find(browser => browser.name === 'chromium').revision, /^\d+$/);
  const { caddy } = JSON.parse(readFileSync(join(root, 'tests/tools.json'), 'utf8'));
  assert.match(caddy.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(Object.keys(caddy.assets).sort(), ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64']);
  for (const [platform, asset] of Object.entries(caddy.assets)) {
    assert.ok(asset.archive.startsWith('caddy_' + caddy.version + '_'));
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
    assert.ok(asset.archive.endsWith(platform.startsWith('win32-') ? '.zip' : '.tar.gz'));
  }
  for (const file of readdirSync(join(root, 'tests/browser')).filter(file => file.endsWith('.test.mjs'))) {
    const source = readFileSync(join(root, 'tests/browser', file), 'utf8');
    assert.match(source, /import\s*\{\s*chromium\s*\}\s*from 'playwright'/, file);
    assert.doesNotMatch(source, /PLAYWRIGHT_MODULE|PLAYWRIGHT_EXECUTABLE_PATH|createRequire/, file);
  }
  assert.doesNotMatch(readFileSync(join(root, 'tests/proxy/caddy.test.js'), 'utf8'), /CADDY_BIN/);
});

test('Compose passes every production configuration key and preserves protected deployment defaults', () => {
  const parsed = parseDocument(readFileSync(join(root, 'compose.example.yml'), 'utf8'));
  assert.deepEqual(parsed.errors, []);
  const merchant = parsed.toJS().services.merchant, environment = merchant.environment;
  const sample = Object.fromEntries([...readFileSync(join(root, '.env.example'), 'utf8').matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)].map(match => [match[1], match[2].trim()]));
  assert.deepEqual(Object.keys(environment).sort(), Object.keys(sample).filter(name => name !== 'HOME_PREVIEW_SAMPLE').sort());
  const fixed = { HOST: '0.0.0.0', PORT: '8787', ALLOW_REMOTE: 'true', DATA_DIR: '/app/data' };
  for (const [name, value] of Object.entries(fixed)) assert.equal(String(environment[name]), value);
  assert.match(environment.PUBLIC_ORIGIN, /^\$\{PUBLIC_ORIGIN:\?.+\}$/);
  for (const [name, value] of Object.entries(sample)) {
    if (Object.hasOwn(fixed, name) || ['PUBLIC_ORIGIN', 'HOME_PREVIEW_SAMPLE'].includes(name)) continue;
    assert.equal(environment[name], '${' + name + ':-' + value + '}', name);
  }
  assert.deepEqual(merchant.ports, ['127.0.0.1:8787:8787']);
  assert.deepEqual(merchant.volumes, ['merchant-data:/app/data']);
  assert.equal(merchant.read_only, true);
  assert.deepEqual(merchant.cap_drop, ['ALL']);
  assert.deepEqual(merchant.security_opt, ['no-new-privileges:true']);
});

test('the newly forwarded settings use the real configuration validation and defaults', () => {
  const defaults = loadConfig({}, root);
  assert.deepEqual(defaults.upstreamAllowedOrigins, []);
  assert.equal(defaults.runtimeMaxInFlight, 8);
  assert.equal(defaults.reconcileIntervalMs, 10000);
  const config = loadConfig({ UPSTREAM_ALLOWED_ORIGINS: 'http://provider.example.invalid:8080', RUNTIME_MAX_IN_FLIGHT: '17', RECONCILE_INTERVAL_MS: '25000' }, root);
  assert.deepEqual(config.upstreamAllowedOrigins, ['http://provider.example.invalid:8080']);
  assert.equal(config.runtimeMaxInFlight, 17);
  assert.equal(config.reconcileIntervalMs, 25000);
  for (const [key, value] of [['RUNTIME_MAX_IN_FLIGHT', '0'], ['RUNTIME_MAX_IN_FLIGHT', '129'], ['RECONCILE_INTERVAL_MS', '0'], ['RECONCILE_INTERVAL_MS', '300001'], ['UPSTREAM_ALLOWED_ORIGINS', 'https://provider.example.invalid/path']]) {
    assert.throws(() => loadConfig({ [key]: value }, root), key);
  }
});

test('application CI runs separate mandatory suites with pinned actions and no deployment credentials', () => {
  const source = readFileSync(join(root, '.github/workflows/application.yml'), 'utf8');
  const parsed = parseDocument(source);
  assert.deepEqual(parsed.errors, []);
  const workflow = parsed.toJS();
  assert.deepEqual(Object.keys(workflow.on).sort(), ['pull_request', 'push', 'workflow_dispatch']);
  assert.deepEqual(workflow.on.push.branches, ['main']);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(Object.keys(workflow.jobs).sort(), ['browser', 'proxy', 'server']);
  assert.deepEqual(workflow.jobs.server.strategy.matrix.os, ['ubuntu-24.04', 'windows-2025']);
  assert.doesNotMatch(source, /pull_request_target|secrets\.|continue-on-error|npm publish|docker push/);
  for (const job of Object.values(workflow.jobs)) {
    assert.ok(job['timeout-minutes'] > 0 && job['timeout-minutes'] <= 20);
    const checkout = job.steps.find(step => step.uses?.startsWith('actions/checkout@'));
    const node = job.steps.find(step => step.uses?.startsWith('actions/setup-node@'));
    assert.equal(checkout.with['persist-credentials'], false);
    assert.equal(node.with['node-version-file'], '.node-version');
    assert.ok(job.steps.some(step => step.run === 'npm ci --ignore-scripts'));
    for (const step of job.steps.filter(step => step.uses)) assert.match(step.uses, /^actions\/(checkout|setup-node)@[a-f0-9]{40}$/);
  }
  assert.ok(workflow.jobs.server.steps.some(step => step.run === 'npm test'));
  assert.ok(workflow.jobs.server.steps.some(step => step.run === 'docker compose --env-file .env.example -f compose.example.yml config --quiet'));
  assert.ok(workflow.jobs.browser.steps.some(step => step.run === 'node node_modules/playwright/cli.js install --with-deps chromium'));
  assert.ok(workflow.jobs.browser.steps.some(step => step.run === 'npm run test:browser'));
  assert.ok(workflow.jobs.proxy.steps.some(step => step.run === 'node scripts/install-caddy.mjs'));
  assert.ok(workflow.jobs.proxy.steps.some(step => step.run === 'npm run test:proxy'));
  const security = parseDocument(readFileSync(join(root, '.github/workflows/repository-security.yml'), 'utf8')).toJS();
  assert.equal(security.jobs['repository-security'].steps.find(step => step.uses?.startsWith('actions/setup-node@')).with['node-version-file'], '.node-version');
});

test('documentation keeps valid local links, balanced examples and repository boundaries', () => {
  const files = ['README.md', 'AGENTS.md', ...readdirSync(join(root, 'docs'), { recursive: true }).filter(file => file.endsWith('.md')).map(file => join('docs', file)), ...readdirSync(join(root, 'tests'), { recursive: true }).filter(file => file.endsWith('.md')).map(file => join('tests', file))];
  for (const file of files) {
    const content = readFileSync(join(root, file), 'utf8');
    assert.deepEqual(inspectRepositoryEntry({ path: file, content }), [], file);
    assert.ok(content.endsWith('\n'), file + ': final newline');
    let fence = null;
    for (const line of content.split(/\r?\n/)) {
      const match = /^(`{3,}|~{3,})(.*)$/.exec(line);
      if (!match) continue;
      if (!fence) fence = match[1];
      else if (match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim()) fence = null;
    }
    assert.equal(fence, null, file + ': unclosed example');
    for (const match of content.matchAll(/^```json\r?\n([\s\S]*?)^```\s*$/gm)) assert.doesNotThrow(() => JSON.parse(match[1]), file + ': JSON example');
    const prose = content.replace(/^```[^\r\n]*\r?\n[\s\S]*?^```\s*$/gm, '');
    for (const match of prose.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      if (/^(https?:|mailto:)/.test(match[1])) continue;
      const [name, anchor] = match[1].split('#'), target = name ? resolve(root, dirname(file), decodeURIComponent(name)) : join(root, file);
      const inside = relative(root, target);
      assert.ok(!inside.startsWith('..') && !isAbsolute(inside) && existsSync(target), file + ': ' + match[1]);
      const realInside = relative(realpathSync(root), realpathSync(target));
      assert.ok(!realInside.startsWith('..') && !isAbsolute(realInside), file + ': escaped link');
      if (anchor) {
        const text = readFileSync(target, 'utf8').replace(/^```[^\r\n]*\r?\n[\s\S]*?^```\s*$/gm, '');
        const headings = new Set(), counts = new Map();
        for (const heading of text.matchAll(/^#{1,6}\s+(.+)$/gm)) {
          const slug = heading[1].trim().toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/\s/g, '-');
          const count = counts.get(slug) || 0; counts.set(slug, count + 1); headings.add(slug + (count ? '-' + count : ''));
        }
        assert.ok(headings.has(decodeURIComponent(anchor)), file + ': missing anchor ' + anchor);
      }
    }
  }
});

test('Caddy preparation refuses unknown platforms before any download', async t => {
  const directory = toolFixture(t); let requested = false;
  await assert.rejects(installCaddy({ directory, platform: 'unsupported', arch: 'x64', fetchArchive: async () => { requested = true; } }), /Unsupported Caddy test platform/);
  assert.equal(requested, false);
  assert.deepEqual(readdirSync(directory), []);
});

test('Caddy checksum failure preserves an existing tool and cleans only its own staging directory', async t => {
  const directory = toolFixture(t), bin = join(directory, 'node_modules/.bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'caddy'), 'existing fixture tool');
  let requested;
  await assert.rejects(installCaddy({ directory, platform: 'linux', arch: 'x64', fetchArchive: async url => { requested = url; return new Response('not the signed release archive'); } }), /SHA-256 mismatch/);
  assert.match(requested, /^https:\/\/github\.com\/caddyserver\/caddy\/releases\/download\/v[\d.]+\/caddy_[\d.]+_linux_amd64\.tar\.gz$/);
  assert.equal(readFileSync(join(bin, 'caddy'), 'utf8'), 'existing fixture tool');
  assert.deepEqual(readdirSync(bin), ['caddy']);
});

test('Caddy preparation rejects failed and oversized downloads without installing anything', async t => {
  const directory = toolFixture(t);
  await assert.rejects(installCaddy({ directory, platform: 'linux', arch: 'x64', fetchArchive: async () => new Response('unavailable', { status: 503 }) }), /HTTP 503/);
  await assert.rejects(installCaddy({ directory, platform: 'linux', arch: 'x64', fetchArchive: async () => ({ ok: true, body: (async function* () { yield { byteLength: 64 * 1024 * 1024 + 1 }; })() }) }), /download limit/);
  assert.deepEqual(readdirSync(join(directory, 'node_modules/.bin')), []);
});
