import {
  readFile,
  writeFile,
  mkdir,
  chmod,
  rm,
  mkdtemp,
  readdir,
  stat,
  lstat,
} from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { getCACertificates } from 'node:tls';

const optionalRead = (path) =>
  readFile(path, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
export function updateNpmrc(text, values, retired = []) {
  const keys = new Set(Object.keys(values));
  const lines = text
    .split(/\r?\n/)
    .filter((line) => !keys.has(line.split('=', 1)[0].trim()) && !retired.includes(line.trim()));
  while (lines.at(-1) === '') lines.pop();
  return [...lines, ...Object.entries(values).map(([key, value]) => key + '=' + value), ''].join(
    '\n',
  );
}
async function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let output = '',
      errors = '';
    child.stdout.on('data', (chunk) => {
      output = (output + chunk).slice(-100000);
    });
    child.stderr.on('data', (chunk) => {
      errors = (errors + chunk).slice(-100000);
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(output.trim()) : reject(new Error(`${command} failed: ${errors}`)),
    );
  });
}
async function packedFileCount(file) {
  return new Promise((done, reject) => {
    const child = spawn('tar', ['-tzf', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let count = 0;
    child.stdout.on('data', (chunk) => {
      for (const byte of chunk) if (byte === 10) count++;
    });
    child.stderr.resume();
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? done(count) : reject(new Error('Could not inspect the packed tarball.')),
    );
  });
}
export async function runPackages(
  args,
  flags,
  {
    serverUrl,
    config,
    api,
    prompt,
    home = homedir(),
    cwd = process.cwd(),
    print = console.log,
    packCommand = 'pnpm',
  },
) {
  const origin = new URL(serverUrl);
  if (origin.hostname === 'registry.npmjs.org' || origin.username || origin.password)
    throw new Error('Use your deploy.local coordinator address.');
  const registry = new URL('/npm/', origin).href;
  const authLine = '//' + origin.host + '/npm/:_authToken';
  const userRc = join(home, '.npmrc'),
    projectRc = join(cwd, '.npmrc');
  const command = args[0] || 'list';
  if (command === 'list') {
    const { packages } = await api('/api/packages');
    if (flags.json) return print(JSON.stringify(packages));
    for (const pkg of packages)
      print(
        `${pkg.name}  ${pkg.latest?.version || ''}  npm · from ${pkg.project || pkg.created_by}`,
      );
    return;
  }
  if (command === 'copies') {
    if (args[1] === 'fetch') {
      const result = await api('/api/packages/cache/warm', {
        method: 'POST',
        body: JSON.stringify(flags.project ? { projectId: flags.project } : {}),
      });
      print(flags.json ? JSON.stringify(result) : `Queued ${result.queued} projects.`);
      return;
    }
    const result = await api('/api/packages/cache');
    if (flags.json) return print(JSON.stringify(result));
    for (const source of result.sources)
      print(`${source.name}  ${source.reachable ? 'Reachable' : 'Unreachable · Using copies'}`);
    for (const project of result.projects)
      print(
        `${project.name}  ${project.removed.length ? 'Removed' : project.missing ? project.missing + ' missing' : project.checkedAt ? 'every locked package is kept' : 'Not checked yet'}`,
      );
    print(
      `${(result.storage.bytes / 1024 ** 3).toFixed(1)} GB of ${result.storage.limit / 1024 ** 3} GB · ${result.storage.days} days`,
    );
    return;
  }
  const registryKey = '//' + origin.host + '/npm/';
  const ca = join(home, '.deploy', 'packages', 'ca.crt');
  // Older logins wrote these. A global cafile replaces the public roots, so npmjs.org stops working.
  const retired = [`cafile=${ca}`, `${registryKey}:always-auth=true`];
  async function writeUserRc(values) {
    if ((await lstat(userRc).catch(() => null))?.isSymbolicLink())
      throw new Error(
        '~/.npmrc is a symbolic link. Keep package credentials in a private user file.',
      );
    await writeFile(userRc, updateNpmrc(await optionalRead(userRc), values, retired), {
      mode: 0o600,
    });
    await chmod(userRc, 0o600);
  }
  /** Saves the coordinator's certificate and scopes it to this registry. Needs no sign-in. */
  async function trustValues() {
    if (origin.protocol !== 'https:') return { values: {}, inKeychain: false };
    // Download the CA over the already-validated coordinator connection, never an insecure bootstrap.
    const response = await fetch(new URL('/ca.crt', origin));
    if (!response.ok) throw new Error('Could not read the coordinator certificate.');
    const certificate = await response.text();
    if (!certificate.includes('-----BEGIN CERTIFICATE-----'))
      throw new Error('Invalid coordinator certificate.');
    const inKeychain =
      process.platform === 'darwin' &&
      getCACertificates('system').some((root) => root.trim() === certificate.trim());
    await mkdir(join(home, '.deploy', 'packages'), { recursive: true, mode: 0o700 });
    await writeFile(ca, certificate, { mode: 0o600 });
    // Scoped to this registry, like the token. pnpm honors it; npm reads NODE_EXTRA_CA_CERTS.
    return { values: { [`${registryKey}:cafile`]: ca }, inKeychain };
  }
  function printTrust(values, inKeychain) {
    print(
      '  ✓ Trusts the coordinator’s certificate         ' +
        (inKeychain
          ? 'already in your keychain'
          : values[`${registryKey}:cafile`] || 'HTTP connection · no certificate'),
    );
    const usesSystemRoots =
      inKeychain &&
      (process.env.NODE_USE_SYSTEM_CA === '1' ||
        (process.env.NODE_OPTIONS ?? '').includes('--use-system-ca'));
    if (
      origin.protocol === 'https:' &&
      !usesSystemRoots &&
      process.env.NODE_EXTRA_CA_CERTS !== ca
    ) {
      print('  ! npm needs this in your shell profile, pnpm is ready:');
      print(`    export NODE_EXTRA_CA_CERTS=${ca}`);
    }
  }
  if (command === 'trust') {
    const { values, inKeychain } = await trustValues();
    await writeUserRc(values);
    printTrust(values, inKeychain);
    print(`    Installs from ${registry} need no sign-in. To publish: deploy packages login`);
    return;
  }
  if (command === 'login') {
    if (!config.username || !config.token) throw new Error('Run deploy login first.');
    if ((await lstat(userRc).catch(() => null))?.isSymbolicLink())
      throw new Error(
        '~/.npmrc is a symbolic link. Keep package credentials in a private user file.',
      );
    const key = await api('/api/package-keys', {
      method: 'POST',
      body: JSON.stringify({ label: flags.name || hostname(), scope: 'publish' }),
    });
    const trust = await trustValues();
    const values = { [authLine]: key.key, ...trust.values };
    await writeUserRc(values);
    print(`  ✓ Package key for ${config.username}         ${key.label} · can publish`);
    print(`  ✓ npm and pnpm                     ~/.npmrc · ${registry}`);
    printTrust(values, trust.inKeychain);
    return;
  }
  if (command === 'use') {
    if (resolve(projectRc) === resolve(userRc)) throw new Error('Run this in a project folder.');
    const text = await optionalRead(projectRc),
      line = `registry=${registry}`;
    if (flags.off) {
      const next = text
        .split(/\r?\n/)
        .filter((value) => value.trim() !== line)
        .join('\n');
      if (next.trim()) await writeFile(projectRc, next);
      else await rm(projectRc, { force: true });
      print('  ✓ Removed deploy.local from .npmrc');
      return;
    }
    if (
      /^\s*registry\s*=/m.test(text) &&
      !text.split(/\r?\n/).some((value) => value.trim() === line)
    )
      throw new Error(
        '.npmrc already chooses another registry. Remove that line before running deploy packages use.',
      );
    await writeFile(projectRc, updateNpmrc(text, { registry }));
    print('  ✓ Wrote .npmrc');
    print('    Commit it so everyone installs from deploy.local.');
    print('    Anyone who can’t reach deploy.local can’t install this project.');
    print('    Undo: deploy packages use --off');
    return;
  }
  const rc = await optionalRead(userRc);
  const key = rc
    .split(/\r?\n/)
    .find((line) => line.startsWith(authLine + '='))
    ?.slice(authLine.length + 1);
  const authorization = key
    ? `Bearer ${key}`
    : config.username && config.token
      ? 'Basic ' + Buffer.from(`${config.username}:${config.token}`).toString('base64')
      : null;
  if (!authorization) throw new Error('Run deploy packages login.');
  async function registryRequest(path, options = {}) {
    const response = await fetch(registry + path, {
      ...options,
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
        ...options.headers,
      },
      redirect: 'error',
    });
    const body = await response.json();
    if (!response.ok)
      throw Object.assign(new Error(body.reason || body.error), { status: response.status });
    return body;
  }
  if (command === 'deprecate') {
    if (!args[1] || args[2] === undefined)
      throw new Error('deploy packages deprecate <name>@<range> "<message>"');
    // Let npm's own semver implementation select the range and use its protocol.
    const env = { ...process.env, NPM_CONFIG_REGISTRY: registry, NPM_CONFIG_USERCONFIG: userRc };
    if (!key) throw new Error('Run deploy packages login.');
    await run('npm', ['deprecate', args[1], args[2], '--registry', registry], { cwd, env });
    print(`  ✓ Deprecated ${args[1]}`);
    return;
  }
  if (command !== 'publish') throw new Error('Unknown packages command. Run deploy --help.');
  const packageText = await optionalRead(join(cwd, 'package.json'));
  if (!packageText) {
    if (await optionalRead(join(cwd, 'Cargo.toml'))) throw new Error("Cargo isn't available yet.");
    throw new Error('Run this in a folder with package.json.');
  }
  const pkg = JSON.parse(packageText);
  if (pkg.private) throw new Error('This package is marked private.');
  const tag = flags.tag || 'latest';
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,99}$/.test(tag)) throw new Error('Invalid dist-tag.');
  if (flags.claim && (await api('/api/user')).role !== 'admin')
    throw new Error('Only an admin can claim a name from npmjs.org.');
  const work = await mkdtemp(join(cwd, '.deploy-package-'));
  try {
    await run(packCommand, ['pack', '--pack-destination', work], { cwd });
    const filename = (await readdir(work)).find((file) => file.endsWith('.tgz'));
    if (!filename) throw new Error('pnpm pack did not write a tarball.');
    const file = join(work, filename),
      size = (await stat(file)).size;
    if (size > 200 * 1024 * 1024) throw new Error('Tarball exceeds 200 MB.');
    // Read the packed manifest, whose workspace: dependencies pnpm has resolved.
    const manifest = JSON.parse(await run('tar', ['-xOf', file, 'package/package.json']));
    if (!manifest.repository) {
      const remote = await run('git', ['remote', 'get-url', 'origin'], { cwd }).catch(() => '');
      if (remote) manifest.repository = { type: 'git', url: remote };
    }
    const sha512 = createHash('sha512'),
      sha1 = createHash('sha1');
    for await (const chunk of createReadStream(file)) {
      sha512.update(chunk);
      sha1.update(chunk);
    }
    manifest.dist = { integrity: 'sha512-' + sha512.digest('base64'), shasum: sha1.digest('hex') };
    print(`${manifest.name} · npm · ${manifest.version}`);
    print(
      `  ✓ Packed ${await packedFileCount(file)} files                  ${Math.ceil(size / 1024)} KB · pnpm pack`,
    );
    const doc = await registryRequest(encodeURIComponent(manifest.name)).catch((error) => {
      if (error.status === 404) return null;
      throw error;
    });
    if (doc?.versions?.[manifest.version])
      throw new Error(
        `${manifest.version} is already published. Nothing changed.\n  Versions are never replaced. Set a new version in package.json.`,
      );
    print(`  ✓ Checked the version is new       ${manifest.version} is not on deploy.local`);
    let bringOver = false;
    if (flags.claim) {
      // A dry run never claims or imports anything. The server enforces admin permission.
      if (!flags['dry-run'] && doc?.versions && Object.keys(doc.versions).length)
        bringOver = /^y(es)?$/i.test(
          await prompt(
            'Bring over every existing version from npmjs.org as Brought over versions? [y/N] ',
          ),
        );
    }
    if (flags['dry-run']) {
      print('  ✓ Dry run. Nothing published.');
      return;
    }
    const docPrefix =
      JSON.stringify({
        name: manifest.name,
        versions: { [manifest.version]: manifest },
        'dist-tags': { [tag]: manifest.version },
      }).slice(0, -1) +
      ',"_attachments":{' +
      JSON.stringify(filename) +
      ':{"content_type":"application/octet-stream","length":' +
      size +
      ',"data":"';
    async function* body() {
      yield docPrefix;
      let carry = Buffer.alloc(0);
      for await (const chunk of createReadStream(file)) {
        const joined = Buffer.concat([carry, chunk]),
          count = joined.length - (joined.length % 3);
        yield joined.subarray(0, count).toString('base64');
        carry = joined.subarray(count);
      }
      if (carry.length) yield carry.toString('base64');
      yield '"}}}';
    }
    const started = performance.now();
    await registryRequest(encodeURIComponent(manifest.name), {
      method: 'PUT',
      body: Readable.from(body()),
      duplex: 'half',
      headers: {
        'x-deploy-package-claim': String(!!flags.claim),
        'x-deploy-package-import': String(bringOver),
      },
    });
    print(
      `  ✓ Published                        by you · ${((performance.now() - started) / 1000).toFixed(1)} s`,
    );
    print(`✓ ${manifest.name} ${manifest.version} is on deploy.local`);
    print(`  ${origin.origin}/packages/npm/${encodeURIComponent(manifest.name)}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
