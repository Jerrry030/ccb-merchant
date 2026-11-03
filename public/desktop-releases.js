// The public download contract contains file identities, never caller-supplied URLs.
export const desktopTargets = [
  { id: 'windows-x64-setup', label: 'Windows x64', detail: '安装程序', suffix: 'windows-x64-setup.exe' },
  { id: 'mac-arm64', label: 'macOS Apple Silicon', detail: 'M 系列芯片 · ZIP', suffix: 'mac-arm64.zip' },
  { id: 'mac-x64', label: 'macOS Intel', detail: 'Intel 芯片 · ZIP', suffix: 'mac-x64.zip' },
  { id: 'linux-x64', label: 'Linux x64', detail: 'ZIP', suffix: 'linux-x64.zip' },
];
export function parseDesktopRelease(value) {
  if (!value || value.product !== 'ACCB' || !Array.isArray(value.files) || value.files.length > desktopTargets.length) throw new Error('Invalid ACCB catalog');
  if (value.version === null && value.files.length === 0) return { version: null, files: [] };
  if (typeof value.version !== 'string' || value.version.length > 80 || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(value.version) || !/^[a-f0-9]{40}$/.test(value.source_commit || '')) throw new Error('Invalid ACCB version');
  const seen = new Set();
  const files = value.files.map(file => {
    const target = desktopTargets.find(target => target.id === file?.target);
    if (!target || seen.has(target.id) || file.name !== 'Anthropic-ccb-' + value.version + '-' + target.suffix || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > 2147483648 || !/^[a-f0-9]{64}$/.test(file.sha256 || '')) throw new Error('Invalid ACCB artifact');
    seen.add(target.id);
    return { ...target, name: file.name, size: file.size, sha256: file.sha256, href: '/downloads/accb/' + value.version + '/' + file.name };
  });
  return { version: value.version, source_commit: value.source_commit, files };
}
