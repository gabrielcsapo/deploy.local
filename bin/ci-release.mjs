import {
  readFileSync,
  lstatSync,
  openSync,
  closeSync,
  fstatSync,
  constants,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';

export function ciAuth(env = process.env) {
  if (env.DEPLOY_AUTH_JSON && env.DEPLOY_AUTH_FILE)
    throw new Error('Choose one CI authentication source');
  let raw = env.DEPLOY_AUTH_JSON;
  if (env.DEPLOY_AUTH_FILE) {
    const path = resolve(env.DEPLOY_AUTH_FILE);
    const initial = lstatSync(path);
    if (
      !initial.isFile() ||
      initial.nlink !== 1 ||
      initial.mode & 0o077 ||
      initial.uid !== process.getuid?.() ||
      initial.size > 16384
    )
      throw new Error('CI authentication file must be an owner-only regular file');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const current = fstatSync(fd);
      if (
        current.ino !== initial.ino ||
        current.dev !== initial.dev ||
        current.mode & 0o077 ||
        current.uid !== initial.uid ||
        current.size > 16384
      )
        throw new Error('CI authentication file changed');
      raw = readFileSync(fd, 'utf8');
    } finally {
      closeSync(fd);
    }
  }
  try {
    if (!raw || raw.length > 16384) throw new Error();
    const c = JSON.parse(raw);
    const u = new URL(c.url);
    if (
      c.version !== 1 ||
      typeof c.username !== 'string' ||
      !/^ci_[a-f0-9]{64}$/.test(c.token) ||
      u.protocol !== 'https:' ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.pathname !== '/'
    )
      throw new Error();
    return { url: u.origin, username: c.username, token: c.token };
  } catch {
    throw new Error('Valid scoped CI authentication is required');
  }
}
export function sourceBundle(commit, dir = process.cwd()) {
  if (!/^[a-f0-9]{40}$/.test(commit || '')) throw new Error('A full source commit is required');
  const git = (...args) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (
    git('rev-parse', 'HEAD').trim() !== commit ||
    git('status', '--porcelain', '--untracked-files=all').trim()
  )
    throw new Error('Publish requires the clean exact source checkout');
  if (
    git('ls-files', '--stage')
      .split('\n')
      .some((line) => line.startsWith('160000 '))
  )
    throw new Error('Submodule source publishing is unsupported');
  const temporary = mkdtempSync(join(tmpdir(), 'deploy-ci-source-'));
  const tar = join(temporary, 'source.tar');
  try {
    git('archive', '--format=tar', '--output', tar, commit);
    const archiveDigest = 'sha256:' + createHash('sha256').update(readFileSync(tar)).digest('hex');
    execFileSync('gzip', ['-n', tar], { stdio: 'pipe' });
    const body = readFileSync(tar + '.gz');
    if (body.length > 500 * 1024 * 1024) throw new Error('Source bundle exceeds upload limit');
    return {
      body,
      archiveDigest,
      digest: 'sha256:' + createHash('sha256').update(body).digest('hex'),
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
export async function ciRequest(auth, path, options = {}, transport = fetch) {
  const url = new URL(path, auth.url);
  if (url.origin !== auth.url || !url.pathname.startsWith('/api/ci/releases'))
    throw new Error('Invalid scoped endpoint');
  const response = await transport(url, {
    ...options,
    redirect: 'error',
    signal: AbortSignal.timeout(120000),
    headers: { ...options.headers, 'x-deploy-ci-token': auth.token },
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(`CI request rejected (${response.status}); inspect owner release status`);
  return result;
}
export async function waitCiRelease(
  auth,
  id,
  timeoutMs = 1200000,
  request = ciRequest,
  pause = (ms) => new Promise((r) => setTimeout(r, ms)),
) {
  if (
    !/^[a-f0-9-]{36}$/.test(id || '') ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 0 ||
    timeoutMs > 3600000
  )
    throw new Error('Invalid release wait');
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const receipt = await request(auth, '/api/ci/releases/' + id);
    if (['healthy', 'failed', 'interrupted', 'superseded', 'cancelled'].includes(receipt.status))
      return receipt;
    if (Date.now() >= deadline) return { ...receipt, waitTimedOut: true };
    await pause(1000);
  }
}
export function assertCiReceipt(receipt, expected) {
  for (const [key, value] of Object.entries(expected))
    if (receipt[key] !== value)
      throw new Error('Release receipt does not match publication intent');
  if (!/^[a-f0-9-]{36}$/.test(receipt.releaseId || '')) throw new Error('Invalid release receipt');
  if (
    receipt.status === 'healthy' &&
    (!receipt.containerId || !/^sha256:[a-f0-9]{64}$/.test(receipt.imageDigest || ''))
  )
    throw new Error('Healthy receipt has no immutable runtime identity');
}
export async function runCiCli(command, positionals, values) {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0')
    throw new Error('CI publication requires certificate validation');
  const auth = ciAuth();
  if (values.url && new URL(values.url).origin !== auth.url)
    throw new Error('CLI URL must match scoped authentication URL');
  setDefaultCACertificates([...getCACertificates('default'), ...getCACertificates('system')]);
  let result;
  if (command === 'publish') {
    if (!values.application && !values.app) throw new Error('Application required');
    const archive = sourceBundle(values['source-commit']);
    if (archive.archiveDigest !== 'sha256:' + values['source-archive-sha256'])
      throw new Error('Tested source archive does not match checkout');
    const intent = {
      application: values.application || values.app,
      sourceArchiveDigest: archive.archiveDigest,
      sourceCommit: values['source-commit'],
      sourceDigest: archive.digest,
      idempotencyKey: values['idempotency-key'],
      expectedRelease: values['expected-release'],
    };
    result = await ciRequest(auth, '/api/ci/releases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(intent),
    });
    const expected = {
      application: intent.application,
      sourceCommit: intent.sourceCommit,
      sourceDigest: intent.sourceDigest,
      sourceArchiveDigest: intent.sourceArchiveDigest,
      predecessorReleaseId: intent.expectedRelease,
    };
    assertCiReceipt(result, expected);
    const releaseId = result.releaseId;
    if (result.status === 'accepted') {
      const form = new FormData();
      form.set('name', result.application);
      form.set('detached', '1');
      form.set('file', new Blob([archive.body]), 'source.tar.gz');
      await ciRequest(auth, '/api/ci/releases/' + result.releaseId + '/upload', {
        method: 'POST',
        body: form,
      });
    }
    if (values.wait)
      result = await waitCiRelease(
        auth,
        result.releaseId,
        Number(values['wait-timeout'] || 1200000),
      );
    assertCiReceipt(result, { ...expected, releaseId });
  } else {
    if (positionals[1] === 'head') result = await ciRequest(auth, '/api/ci/releases/head');
    else if (positionals[1] === 'status')
      result = await ciRequest(auth, '/api/ci/releases/' + values.release);
    else if (positionals[1] === 'wait')
      result = await waitCiRelease(auth, values.release, Number(values['wait-timeout'] || 1200000));
    else throw new Error('Usage: deploy release head|status|wait');
    if (result.application && result.application !== (values.application || values.app))
      throw new Error('Credential application does not match request');
  }
  const allowed = [
    'releaseId',
    'application',
    'sourceCommit',
    'sourceDigest',
    'sourceArchiveDigest',
    'predecessorReleaseId',
    'status',
    'containerId',
    'imageDigest',
    'failure',
    'createdAt',
    'updatedAt',
    'resolvedBy',
    'resolvedAt',
    'activeRelease',
    'requiresOwnerRecovery',
    'graphDigest',
    'waitTimedOut',
  ];
  const output = Object.fromEntries(
    Object.entries(result).filter(([key]) => allowed.includes(key)),
  );
  const serialized = JSON.stringify(output, null, 2);
  if (serialized.includes(auth.token)) throw new Error('Invalid secret-bearing response');
  console.log(serialized);
  if (result.status === 'failed' || result.status === 'cancelled') process.exitCode = 1;
  else if (result.status === 'interrupted' || result.status === 'superseded' || result.waitTimedOut)
    process.exitCode = 2;
}
