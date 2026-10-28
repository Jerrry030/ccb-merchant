import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const privateDirectories = new Set(['.git', '.local-preview', 'node_modules', 'data', 'backups', 'coverage', 'artifacts']);
const privateExtension = /\.(?:sqlite(?:3)?(?:-(?:shm|wal))?|db(?:-(?:shm|wal))?|log|key|pem|p12|pfx|secret|bundle|bak|har|pcap(?:ng)?|zip|7z|tgz|tar(?:\.(?:gz|xz))?|exe|dll|so|dylib)$/i;
const documentRules = [
  ['machine-specific-path', /(?:\b[A-Za-z]:[\\/]|\/(?:Users|home|root)\/)[^\s`"'<>]+/],
  ['provider-admin-interface', /\/admin\/api\//],
  ['database-connection-string', /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\//i],
];

// This policy has one entry point; callers receive only locations/reasons, never file contents.
export function inspectRepositoryEntry({ path, mode = '100644', content = '' }) {
  const normalized = path.replaceAll('\\', '/');
  const parts = normalized.toLowerCase().split('/');
  const filename = parts.at(-1);
  const findings = [];
  if (!['100644', '100755'].includes(mode)) findings.push({ path, rule: 'non-regular-file' });
  if (parts.slice(0, -1).some(part => privateDirectories.has(part)) || privateExtension.test(filename) ||
      (normalized !== '.env.example' && /^\.env(?:\.|$)/i.test(filename)) ||
      /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|\.gitleaksignore)$/.test(filename) ||
      /^env[-_.](?:before|backup)/.test(filename) || /(?:^|[-_.])(?:backup|dump)(?:[-_.]|$)/.test(filename)) {
    findings.push({ path, rule: 'private-file-path' });
  }
  if (normalized === '.env.example') {
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      const assignment = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (assignment && /(?:^|_)(?:password|passwd|secret|token|key|credential)(?:_|$)/i.test(assignment[1]) &&
          !['', "''", '""'].includes(assignment[2])) findings.push({ path, line: index + 1, rule: 'populated-secret-template-field' });
    }
  }
  if (/\.md$/i.test(normalized)) {
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      for (const [rule, pattern] of documentRules) {
        if (pattern.test(line)) findings.push({ path, line: index + 1, rule });
      }
    }
  }
  return findings;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let scratch;
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== '--staged')) throw new Error('Usage: node scripts/check-repository.mjs [--staged]');
    const stagedOnly = args[0] === '--staged';
    const probe = spawnSync('gitleaks', ['version'], { encoding: 'utf8', windowsHide: true });
    if (probe.error || probe.status !== 0) throw new Error('Gitleaks is unavailable; install the documented scanner before continuing.');
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true }).trim();
    const gitOptions = { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 };
    if (!stagedOnly && execFileSync('git', ['rev-parse', '--is-shallow-repository'], gitOptions).trim() !== 'false') {
      throw new Error('Full-history checks require a non-shallow checkout.');
    }
    const entries = new Map();
    const index = execFileSync('git', ['ls-files', '--stage', '-z'], gitOptions);
    for (const record of index.split('\0').filter(Boolean)) {
      const match = /^(\d{6}) ([a-f0-9]+) ([0-3])\t([\s\S]+)$/.exec(record);
      if (!match || match[3] !== '0') throw new Error('Resolve the unmerged or invalid Git index before scanning.');
      entries.set(`${match[4]}\0${match[2]}`, { path: match[4], mode: match[1], oid: match[2] });
    }
    let commits = [];
    if (!stagedOnly) {
      commits = execFileSync('git', ['rev-list', '--all', '--reflog'], gitOptions).trim().split(/\r?\n/).filter(Boolean);
      for (const commit of commits) {
        const tree = execFileSync('git', ['ls-tree', '--full-tree', '-r', '-z', commit], gitOptions);
        for (const record of tree.split('\0').filter(Boolean)) {
          const match = /^(\d{6}) (?:blob|commit) ([a-f0-9]+)\t([\s\S]+)$/.exec(record);
          if (!match) throw new Error('Could not inspect a Git tree entry.');
          entries.set(`${match[3]}\0${match[2]}`, { path: match[3], mode: match[1], oid: match[2] });
        }
      }
    }
    const contents = new Map();
    const findings = [];
    for (const entry of entries.values()) {
      let content = '';
      if ((/\.md$/i.test(entry.path) || entry.path === '.env.example') && ['100644', '100755'].includes(entry.mode)) {
        if (!contents.has(entry.oid)) contents.set(entry.oid, execFileSync('git', ['cat-file', 'blob', entry.oid], { ...gitOptions, maxBuffer: 2 * 1024 * 1024 }));
        content = contents.get(entry.oid);
      }
      findings.push(...inspectRepositoryEntry({ ...entry, content }));
    }
    if (findings.length) {
      for (const finding of findings) console.error(`${finding.path}${finding.line ? `:${finding.line}` : ''}: ${finding.rule}`);
      throw new Error('Repository boundary checks failed. No file contents were printed.');
    }
    scratch = mkdtempSync(join(tmpdir(), 'ccb-merchant-security-'));
    const configPath = join(scratch, 'gitleaks.toml');
    const ignorePath = join(scratch, 'empty-ignore');
    writeFileSync(configPath, readFileSync(new URL('../.gitleaks.toml', import.meta.url)), { mode: 0o600 });
    writeFileSync(ignorePath, '', { mode: 0o600 });
    const common = ['--config', configPath, '--gitleaks-ignore-path', ignorePath, '--ignore-gitleaks-allow', '--redact=100', '--no-banner', '--no-color'];
    const scans = [['git', '--pre-commit', '--staged', ...common, root]];
    if (!stagedOnly && commits.length) scans.unshift(['git', '--log-opts=--all --reflog --full-history', ...common, root]);
    for (const command of scans) {
      const result = spawnSync('gitleaks', command, { cwd: root, stdio: 'inherit', windowsHide: true });
      if (result.error || result.status !== 0) throw new Error('Secret scan failed or found credentials. Review the redacted scanner result.');
    }
    console.log(`Repository security passed: ${stagedOnly ? 'index' : `${commits.length} commits and index`}, ${entries.size} file versions.`);
  } catch (error) {
    // Child-process failures can carry raw buffers; never serialize those buffers or arguments.
    console.error(error?.status !== undefined ? 'Git inspection failed; no complete scan result is available.' : error.message);
    process.exitCode = 1;
  } finally {
    if (scratch) {
      for (const name of ['gitleaks.toml', 'empty-ignore']) {
        try { unlinkSync(join(scratch, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      rmdirSync(scratch);
    }
  }
}
