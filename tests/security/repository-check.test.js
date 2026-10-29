import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { inspectRepositoryEntry } from '../../scripts/check-repository.mjs';

const checker = fileURLToPath(new URL('../../scripts/check-repository.mjs', import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'merchant-repository-policy-'));
  t.after(() => {
    const path = realpathSync(root), parent = realpathSync(tmpdir()), within = relative(parent, path);
    assert.ok(within && !within.startsWith('..') && !isAbsolute(within));
    assert.ok(basename(path).startsWith('merchant-repository-policy-'));
    rmSync(path, { recursive: true, force: true });
  });
  const options = { cwd: root, stdio: 'pipe', windowsHide: true };
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], options);
  execFileSync('git', ['config', '--local', 'user.name', 'Security fixture'], options);
  execFileSync('git', ['config', '--local', 'user.email', 'fixture@example.invalid'], options);
  execFileSync('git', ['config', '--local', 'commit.gpgsign', 'false'], options);
  execFileSync('git', ['config', '--local', 'core.hooksPath', '.disabled-hooks'], options);
  writeFileSync(join(root, 'README.md'), '# Synthetic merchant fixture\n');
  execFileSync('git', ['add', '--', 'README.md'], options);
  execFileSync('git', ['commit', '--quiet', '-m', 'Initialize isolated fixture'], options);
  return root;
}

test('private files are denied while ordinary source and the example env remain allowed', () => {
  for (const path of ['.env', '.env.production', 'nested/.env.example', 'data/setup.secret', '.local-preview/config.yml', 'backups/snapshot.txt', 'src/provider.key', 'capture.har', 'archive.bundle', 'account.sqlite-wal', 'env-before-change.txt', '.gitleaksignore', 'capture.pcapng', 'tests/browser/artifacts/view.png']) {
    assert.ok(inspectRepositoryEntry({ path }).some(x => x.rule === 'private-file-path'), path);
  }
  for (const path of ['.env.example', '.gitleaks.toml', '.github/workflows/repository-security.yml', '.githooks/pre-commit', 'src/schema.sql', 'public/app.js', 'docs/API-CONTRACT.md']) {
    assert.deepEqual(inspectRepositoryEntry({ path }), [], path);
  }
});

test('documentation rejects machine-specific paths and provider admin instructions without echoing contents', () => {
  const content = '# Notes\nRead C:\\work\\private\\settings.yml\nUse /admin/api/internal-example\npostgresql://example.invalid/database\n';
  const findings = inspectRepositoryEntry({ path: 'docs/operations.md', content });
  assert.deepEqual(findings.map(x => [x.line, x.rule]), [[2, 'machine-specific-path'], [3, 'provider-admin-interface'], [4, 'database-connection-string']]);
  assert.equal(JSON.stringify(findings).includes('settings.yml'), false);
  assert.deepEqual(inspectRepositoryEntry({ path: 'docs/API-CONTRACT.md', content: 'GET /api/admin/inventory\nGET /access/v1/accounts' }), []);
});

test('the allowed environment template cannot contain even a low-entropy password', () => {
  assert.deepEqual(inspectRepositoryEntry({ path: '.env.example', content: 'PORT=8787\nUPSTREAM_API_KEY=\nSMTP_PASSWORD=""\n' }), []);
  const findings = inspectRepositoryEntry({ path: '.env.example', content: 'PORT=8787\nSMTP_PASSWORD=example-password\n' });
  assert.deepEqual(findings, [{ path: '.env.example', line: 2, rule: 'populated-secret-template-field' }]);
});

test('symlinks and submodules cannot introduce unreviewed files', () => {
  for (const mode of ['120000', '160000']) assert.ok(inspectRepositoryEntry({ path: 'public/asset', mode }).some(x => x.rule === 'non-regular-file'));
});

test('Docker context is an explicit source-only allowlist, with hidden inputs excluded last', () => {
  const rules = readFileSync(new URL('../../.dockerignore', import.meta.url), 'utf8').split(/\r?\n/).map(x => x.trim()).filter(x => x && !x.startsWith('#'));
  assert.deepEqual(rules, ['**', '!Dockerfile', '!package.json', '!package-lock.json', '!src/', 'src/**', '!src/*.js', '!src/*.sql', '!public/', 'public/**', '!public/*.html', '!public/*.js', '!public/*.css', '!public/*.svg', '!public/auth-mist-lake.webp', 'src/*/**', 'public/*/**', '!public/fonts/', '!public/fonts/*.woff2', '**/.*']);
});

test('security workflow uses complete checkout and immutable actions, not privileged PR execution', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/repository-security.yml', import.meta.url), 'utf8');
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /contents: read/);
  assert.equal(workflow.includes('pull_request_target'), false);
  const actions = [...workflow.matchAll(/uses:\s*([^\s#]+)/g)].map(x => x[1]);
  assert.equal(actions.length, 2);
  assert.ok(actions.every(x => /@[a-f0-9]{40}$/.test(x)));
  assert.match(workflow, /sha256sum --check --strict/);
});

test('clean committed history and index pass the real scanner', t => {
  const root = fixture(t);
  const result = spawnSync(process.execPath, [checker], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /1 commits and index/);
});

test('staged secret cannot be hidden by an unstaged clean replacement', t => {
  const root = fixture(t), secret = 'ccbk_' + randomBytes(32).toString('hex');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/settings.js'), `export const credential = '${secret}';\n`);
  execFileSync('git', ['add', '--', 'src/settings.js'], { cwd: root, stdio: 'pipe' });
  writeFileSync(join(root, 'src/settings.js'), 'export const credential = null;\n');
  const result = spawnSync(process.execPath, [checker, '--staged'], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Secret scan failed/);
  assert.equal((result.stdout + result.stderr).includes(secret), false);
});

test('test directories and inline allow comments do not hide new credentials', t => {
  const root = fixture(t), secret = 'ccbm_' + randomBytes(32).toString('hex');
  mkdirSync(join(root, 'tests'));
  writeFileSync(join(root, 'tests/sample.js'), `const credential = '${secret}'; // gitleaks:allow\n`);
  execFileSync('git', ['add', '--', 'tests/sample.js'], { cwd: root, stdio: 'pipe' });
  const result = spawnSync(process.execPath, [checker, '--staged'], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Secret scan failed/);
  assert.equal((result.stdout + result.stderr).includes(secret), false);
});

test('force-adding an ignored-style private file fails before printing its contents', t => {
  const root = fixture(t), secret = randomBytes(24).toString('hex');
  writeFileSync(join(root, '.env'), `PRIVATE_VALUE=${secret}\n`);
  execFileSync('git', ['add', '--force', '--', '.env'], { cwd: root, stdio: 'pipe' });
  const result = spawnSync(process.execPath, [checker, '--staged'], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /private-file-path/);
  assert.equal((result.stdout + result.stderr).includes(secret), false);
});

test('secrets deleted in a later commit remain blocked by full-history scanning', t => {
  const root = fixture(t), secret = 'ccbk_' + randomBytes(32).toString('hex');
  const options = { cwd: root, stdio: 'pipe' };
  writeFileSync(join(root, 'settings.js'), `const credential = '${secret}';\n`);
  execFileSync('git', ['add', '--', 'settings.js'], options);
  execFileSync('git', ['commit', '--quiet', '-m', 'Add synthetic credential'], options);
  writeFileSync(join(root, 'settings.js'), 'const credential = null;\n');
  execFileSync('git', ['add', '--', 'settings.js'], options);
  execFileSync('git', ['commit', '--quiet', '-m', 'Remove synthetic credential'], options);
  const result = spawnSync(process.execPath, [checker], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Secret scan failed/);
  assert.equal((result.stdout + result.stderr).includes(secret), false);
});

test('removed internal documentation remains blocked until its history is cleaned', t => {
  const root = fixture(t), options = { cwd: root, stdio: 'pipe' };
  writeFileSync(join(root, 'README.md'), '# Synthetic fixture\n/admin/api/internal-example\n');
  execFileSync('git', ['add', '--', 'README.md'], options);
  execFileSync('git', ['commit', '--quiet', '-m', 'Add synthetic private instructions'], options);
  writeFileSync(join(root, 'README.md'), '# Synthetic fixture\n');
  execFileSync('git', ['add', '--', 'README.md'], options);
  execFileSync('git', ['commit', '--quiet', '-m', 'Remove private instructions from latest tree'], options);
  const result = spawnSync(process.execPath, [checker], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /provider-admin-interface/);
});

test('a shallow checkout cannot claim full-history coverage', t => {
  const root = fixture(t), shallow = join(root, 'shallow');
  execFileSync('git', ['clone', '--quiet', '--depth', '1', pathToFileURL(root).href, shallow], { stdio: 'pipe' });
  const result = spawnSync(process.execPath, [checker], { cwd: shallow, encoding: 'utf8', windowsHide: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /non-shallow checkout/);
});

test('missing scanner fails closed rather than reporting success', t => {
  const root = fixture(t);
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  environment.PATH = '';
  const result = spawnSync(process.execPath, [checker, '--staged'], { cwd: root, env: environment, encoding: 'utf8', windowsHide: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Gitleaks is unavailable/);
  assert.equal(result.stdout.includes('security passed'), false);
});
