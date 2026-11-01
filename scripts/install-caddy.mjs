import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, lstatSync, existsSync, realpathSync, chmodSync, renameSync, rmSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const { caddy } = JSON.parse(readFileSync(new URL('../tests/tools.json', import.meta.url), 'utf8'));

// Preparing a test dependency is explicit; tests themselves never download tools.
export async function installCaddy({ directory = project, platform = process.platform, arch = process.arch, fetchArchive = fetch } = {}) {
  const asset = caddy.assets[`${platform}-${arch}`];
  if (!asset) throw new Error(`Unsupported Caddy test platform: ${platform}-${arch}`);
  if (!/^\d+\.\d+\.\d+$/.test(caddy.version) || !/^caddy_[\d.]+_[a-z0-9_]+\.(?:tar\.gz|zip)$/.test(asset.archive) || !/^[a-f0-9]{64}$/.test(asset.sha256)) {
    throw new Error('Invalid pinned Caddy artifact');
  }
  const root = realpathSync(directory);
  let bin = root;
  for (const name of ['node_modules', '.bin']) {
    bin = join(bin, name);
    if (existsSync(bin) && (!lstatSync(bin).isDirectory() || lstatSync(bin).isSymbolicLink())) throw new Error('Test tool directory must be an ordinary directory');
    mkdirSync(bin, { recursive: true });
  }
  const staging = mkdtempSync(join(bin, '.caddy-install-'));
  try {
    const response = await fetchArchive(`https://github.com/caddyserver/caddy/releases/download/v${caddy.version}/${asset.archive}`, { signal: AbortSignal.timeout(120000) });
    if (!response.ok || !response.body) {
      await response.body?.cancel?.();
      throw new Error(`Caddy download failed (HTTP ${response.status})`);
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 64 * 1024 * 1024) throw new Error('Caddy archive exceeds the download limit');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error('Caddy archive SHA-256 mismatch; nothing installed');
    const archive = join(staging, asset.archive), name = platform === 'win32' ? 'caddy.exe' : 'caddy';
    writeFileSync(archive, bytes, { flag: 'wx' });
    const unpack = spawnSync('tar', ['-xf', archive, '-C', staging, name], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    if (unpack.error || unpack.status !== 0) throw new Error('Caddy extraction failed; a working tar executable is required');
    const extracted = join(staging, name), stat = lstatSync(extracted);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > 128 * 1024 * 1024) throw new Error('Invalid extracted Caddy binary');
    chmodSync(extracted, 0o755);
    const version = spawnSync(extracted, ['version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (version.error || version.status !== 0 || version.stdout.trim().split(/\s+/)[0] !== `v${caddy.version}`) throw new Error('Extracted Caddy version does not match the pin');
    const executable = join(bin, name);
    if (existsSync(executable) && (!lstatSync(executable).isFile() || lstatSync(executable).isSymbolicLink())) throw new Error('Refusing to replace a non-regular test tool');
    renameSync(extracted, executable);
    return { version: caddy.version, executable };
  } finally {
    const actual = realpathSync(staging), inside = relative(realpathSync(bin), actual);
    if (!inside || inside.startsWith('..') || isAbsolute(inside) || !basename(actual).startsWith('.caddy-install-')) throw new Error('Refusing cleanup outside the Caddy installation staging directory');
    rmSync(actual, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error('Usage: node scripts/install-caddy.mjs');
    const installed = await installCaddy();
    console.log(`Caddy ${installed.version} verified and installed in ${relative(project, installed.executable)}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
