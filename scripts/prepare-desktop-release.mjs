// Publish metadata only after all five local release files have been verified.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopTargets, parseDesktopRelease } from '../public/desktop-releases.js';
const [directory, version, source] = process.argv.slice(2);
if (!directory || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version || '') || !/^[a-f0-9]{40}$/.test(source || '')) throw new Error('Usage: node scripts/prepare-desktop-release.mjs ARTIFACT_DIRECTORY VERSION SOURCE_COMMIT');
const manifest = { product: 'ACCB', version, source_commit: source, files: [] };
for (const target of desktopTargets) {
  const name = 'Anthropic-ccb-' + version + '-' + target.suffix;
  const file = resolve(directory, name), info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0) throw new Error('Invalid release file: ' + name);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  manifest.files.push({ target: target.id, name, size: info.size, sha256: hash.digest('hex') });
}
parseDesktopRelease(manifest);
const output = resolve(dirname(fileURLToPath(import.meta.url)), '../public/accb-releases.json');
await writeFile(output, JSON.stringify(manifest, null, 2) + '\n');
console.log('Verified ' + manifest.files.length + ' ACCB artifacts; wrote public/accb-releases.json.');
