// Shared by the installed task worker and desktop shell. Keep this in src so Electron's
// existing package files include it alongside worker.mjs.
import { accessSync, constants, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, delimiter } from 'node:path';
import { homedir } from 'node:os';

/** Resolve nvm's default alias without starting a shell or sourcing user startup files. */
function defaultNodeBin(home) {
  const nvm = join(home, '.nvm');
  try {
    let version = 'default';
    const seen = new Set();
    while (!/^v?\d+(\.\d+){0,2}$/.test(version) && !['node', 'stable'].includes(version)) {
      if (
        seen.has(version) ||
        !/^[\w.*/-]+$/.test(version) ||
        version.split('/').some((part) => !part || part === '.' || part === '..')
      )
        return [];
      seen.add(version);
      version = readFileSync(join(nvm, 'alias', version), 'utf8').trim();
    }
    const prefix = version.replace(/^v/, '').split('.');
    const versions = readdirSync(join(nvm, 'versions/node'))
      .filter((name) => /^v\d+\.\d+\.\d+$/.test(name))
      .map((name) => ({ name, parts: name.slice(1).split('.').map(Number) }))
      .filter(({ parts }) =>
        version === 'node'
          ? true
          : version === 'stable'
            ? parts[0] % 2 === 0
            : prefix.every((part, index) => Number(part) === parts[index]),
      )
      .sort(
        (a, b) => b.parts[0] - a.parts[0] || b.parts[1] - a.parts[1] || b.parts[2] - a.parts[2],
      );
    if (!versions.length) return [];
    const bin = join(nvm, 'versions/node', versions[0].name, 'bin');
    accessSync(join(bin, 'node'), constants.X_OK);
    return [bin];
  } catch {
    return [];
  }
}

export function servicePath(
  providerPaths = [],
  environmentPath = process.env.PATH || '',
  home = homedir(),
) {
  return [
    ...new Set([
      ...providerPaths.filter(Boolean).map((path) => dirname(path)),
      ...defaultNodeBin(home),
      join(home, '.local/bin'),
      join(home, '.npm-global/bin'),
      join(home, '.cargo/bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
      ...environmentPath.split(delimiter).filter((path) => path.startsWith('/')),
    ]),
  ].join(':');
}

export function discoverProviderPaths(path = process.env.PATH || '') {
  return ['codex', 'claude'].flatMap((name) => {
    const candidate = path
      .split(delimiter)
      .filter((dir) => dir.startsWith('/'))
      .map((dir) => join(dir, name))
      .find((file) => {
        try {
          accessSync(file, constants.X_OK);
          return true;
        } catch {
          return false;
        }
      });
    // Keep both a shim's directory and its real installation directory available.
    return candidate ? [candidate, realpathSync(candidate)] : [];
  });
}
