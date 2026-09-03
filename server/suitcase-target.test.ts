import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  DEFAULT_CORE_IMAGE,
  DEFAULT_HELPER_IMAGE,
  DOCKER_SOCKET_WARNING,
  PHYSICAL_LOSS_WARNING,
  SUITCASE_SECURITY_WARNING,
  SuitcaseTargetManager,
  renderSuitcaseCompose,
  suitcaseAccessAdvice,
  type CommandResult,
} from '../lib/suitcase-target.ts';

const fixedId = '11111111-2222-4333-8444-555555555555';
const coreV1 = 'registry.example/core:v1';
const helperV1 = 'registry.example/helper:v1';
const coreV2 = 'registry.example/core:v2';
const helperV2 = 'registry.example/helper:v2';
const coreDigestV1 = `registry.example/core@sha256:${'1'.repeat(64)}`;
const helperDigestV1 = `registry.example/helper@sha256:${'2'.repeat(64)}`;
const coreDigestV2 = `registry.example/core@sha256:${'3'.repeat(64)}`;
const helperDigestV2 = `registry.example/helper@sha256:${'4'.repeat(64)}`;

function success(stdout = ''): CommandResult {
  return { code: 0, stdout, stderr: '' };
}

function releaseRunner(
  options: {
    failUpCall?: number;
    unresolved?: boolean;
    cosignFailure?: boolean;
  } = {},
): { runner: (command: string, args: string[]) => Promise<CommandResult>; calls: string[][] } {
  const calls: string[][] = [];
  let upCalls = 0;
  const digests = new Map([
    [coreV1, coreDigestV1],
    [helperV1, helperDigestV1],
    [coreV2, coreDigestV2],
    [helperV2, helperDigestV2],
  ]);
  return {
    calls,
    runner: async (command, args) => {
      calls.push([command, ...args]);
      if (command === 'cosign') {
        return options.cosignFailure
          ? { code: 1, stdout: '', stderr: 'signature rejected' }
          : success('verified\n');
      }
      if (args[0] === 'version') return success('26.1.4|linux|amd64\n');
      if (args[0] === 'info') return success(`4|${12 * 1024 ** 3}|/var/lib/docker|suitcase\n`);
      if (args[0] === 'compose' && args[1] === 'version') return success('2.35.1\n');
      if (args[0] === 'image' && args[1] === 'inspect') {
        return success(
          JSON.stringify(options.unresolved ? [] : [digests.get(String(args.at(-1)))]),
        );
      }
      if (args.includes('--status') && args.includes('--quiet')) return success('running\n');
      if (args.includes('up')) {
        upCalls += 1;
        if (upCalls === options.failUpCall) {
          return { code: 1, stdout: '', stderr: 'candidate health deadline exceeded' };
        }
      }
      if (args.includes('--format') && args.includes('json')) {
        return success('{"Service":"core","State":"running","Health":"healthy"}\n');
      }
      return success();
    },
  };
}

test('suitcase artifacts persist identity and generate inspectable sibling-container Compose', () => {
  const directory = mkdtempSync(join(tmpdir(), 'deploy-suitcase-artifacts-'));
  const manager = new SuitcaseTargetManager({
    directory,
    uuid: () => fixedId,
    now: () => new Date('2026-08-08T12:00:00.000Z'),
  });

  const first = manager.ensureArtifacts();
  const second = new SuitcaseTargetManager({
    directory,
    uuid: () => 'different',
  }).ensureArtifacts();

  assert.equal(first.target.targetId, fixedId);
  assert.equal(second.target.targetId, fixedId);
  assert.equal(second.target.createdAt, '2026-08-08T12:00:00.000Z');
  assert.match(first.compose, /restart: unless-stopped/);
  assert.match(first.compose, /\/var\/run\/docker\.sock:\/var\/run\/docker\.sock/);
  assert.match(first.compose, /profiles: \["helpers"\]/);
  assert.match(first.compose, /name: deploy-local-suitcase-state/);
  assert.match(first.compose, /name: deploy-local-suitcase-content/);
  assert.match(first.compose, /name: deploy-local-suitcase-build-cache/);
  assert.match(first.compose, /"8080:80"/);
  assert.match(first.compose, /DEPLOY_SUITCASE_CONTENT_VOLUME: deploy-local-suitcase-content/);
  assert.match(
    first.compose,
    /DEPLOY_SUITCASE_MEMBERSHIP_FILE: \/var\/lib\/deploy\.local\/fleet-membership\.json/,
  );
  assert.match(
    first.compose,
    /DEPLOY_SUITCASE_MEMBERSHIP_BOOTSTRAP_FILE: \/run\/deploy\.local\/suitcase-host\/fleet-membership\.json/,
  );
  assert.match(first.compose, new RegExp(`${directory}:/run/deploy\\.local/suitcase-host`));
  assert.equal(statSync(join(directory, 'target.json')).mode & 0o777, 0o600);
  assert.doesNotMatch(
    readFileSync(join(directory, 'target.env'), 'utf8'),
    /password|token|secret/i,
  );
  assert.doesNotMatch(DEFAULT_CORE_IMAGE, /:latest$/);
  assert.doesNotMatch(DEFAULT_HELPER_IMAGE, /:latest$/);
});

test('compose renderer quotes untrusted string fields', () => {
  const directory = mkdtempSync(join(tmpdir(), 'deploy-suitcase-quote-'));
  const manager = new SuitcaseTargetManager({
    directory,
    uuid: () => fixedId,
    coreImage: 'registry.example/core:v1',
    helperImage: 'registry.example/helper:v1',
  });
  const target = manager.ensureArtifacts().target;
  const compose = renderSuitcaseCompose(target);
  assert.match(compose, /image: "registry\.example\/core:v1"/);
  assert.match(compose, /deploy\.local\.target\.id: "11111111-2222-4333-8444-555555555555"/);
});

test('start, status, upgrade, and stop use Compose without deleting volumes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'deploy-suitcase-lifecycle-'));
  const calls: string[][] = [];
  const runner = async (command: string, args: string[]): Promise<CommandResult> => {
    assert.equal(command, 'docker');
    calls.push(args);
    if (args[0] === 'version') return success('26.1.4|linux|arm64\n');
    if (args[0] === 'info') return success(`4|${12 * 1024 ** 3}|/var/lib/docker|suitcase\n`);
    if (args[0] === 'compose' && args[1] === 'version') return success('2.35.1\n');
    if (args[0] === 'image' && args[1] === 'inspect') {
      return success(
        JSON.stringify([String(args.at(-1)).includes('helper') ? helperDigestV1 : coreDigestV1]),
      );
    }
    if (args.includes('--status') && args.includes('--quiet')) return success('');
    if (args.includes('--format') && args.includes('json')) {
      return success('{"Service":"core","State":"running","Health":"healthy"}\n');
    }
    return success();
  };
  const manager = new SuitcaseTargetManager({
    directory,
    uuid: () => fixedId,
    runner,
    portAvailable: async () => true,
    networkInterfaces: () => ({
      eth0: [
        {
          address: '192.168.50.2',
          netmask: '255.255.255.0',
          family: 'IPv4',
          mac: '',
          internal: false,
          cidr: '192.168.50.2/24',
        },
      ],
    }),
    platform: 'linux',
    coreImage: coreV1,
    helperImage: helperV1,
  });

  await assert.rejects(() => manager.start(), /--accept-docker-socket-risk/);
  const started = await manager.start({ acceptDockerSocketRisk: true });
  assert.equal(started.status.healthy, true);
  assert.equal(started.releaseState.active, 'a');
  assert.equal(started.releaseState.slots.a?.coreImage, coreDigestV1);
  assert.equal(started.releaseState.slots.a?.signatureVerification.status, 'not-configured');
  assert.equal(started.status.accessUrl, 'https://192.168.50.2:8443');
  assert.equal(started.securityWarning, SUITCASE_SECURITY_WARNING);
  assert.match(started.securityWarning, /does not encrypt powered-off Suitcase volumes/);
  assert.ok(calls.some((args) => args[0] === 'pull' && args[1] === coreV1));
  assert.ok(calls.some((args) => args[0] === 'pull' && args[1] === helperV1));
  assert.ok(calls.some((args) => args.includes('up') && args.includes('--wait')));

  const upgraded = await manager.upgrade({ acceptDockerSocketRisk: true });
  assert.equal(upgraded.activated, true);
  assert.equal(upgraded.releaseState.active, 'b');
  assert.equal(upgraded.releaseState.previous, 'a');
  assert.equal(upgraded.status.running, true);
  assert.ok(calls.some((args) => args.includes('--force-recreate')));

  const stopped = await manager.stop();
  assert.deepEqual(stopped.preservedVolumes, [
    'deploy-local-suitcase-state',
    'deploy-local-suitcase-content',
    'deploy-local-suitcase-build-cache',
  ]);
  const down = calls.find((args) => args.includes('down'));
  assert.ok(down);
  assert.equal(down.includes('-v'), false);
  assert.equal(down.includes('--volumes'), false);
});

test('upgrade commits digest-pinned A/B slots and explicit rollback swaps them', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'deploy-suitcase-ab-'));
  const fixture = releaseRunner();
  const common = {
    directory,
    uuid: () => fixedId,
    runner: fixture.runner,
    portAvailable: async () => true,
  };
  const first = new SuitcaseTargetManager({ ...common, coreImage: coreV1, helperImage: helperV1 });
  await first.start({ acceptDockerSocketRisk: true });

  const second = new SuitcaseTargetManager({ ...common, coreImage: coreV2, helperImage: helperV2 });
  const upgraded = await second.upgrade({ acceptDockerSocketRisk: true });
  assert.equal(upgraded.activated, true);
  assert.equal(upgraded.releaseState.active, 'b');
  assert.equal(upgraded.releaseState.previous, 'a');
  assert.equal(upgraded.releaseState.slots.a?.coreImage, coreDigestV1);
  assert.equal(upgraded.releaseState.slots.b?.coreImage, coreDigestV2);
  assert.match(readFileSync(join(directory, 'compose.yaml'), 'utf8'), new RegExp(coreDigestV2));
  assert.match(
    readFileSync(join(directory, 'compose.slot-a.yaml'), 'utf8'),
    new RegExp(coreDigestV1),
  );
  assert.match(
    readFileSync(join(directory, 'compose.slot-b.yaml'), 'utf8'),
    new RegExp(coreDigestV2),
  );

  const rolledBack = await second.rollback({ acceptDockerSocketRisk: true });
  assert.equal(rolledBack.activated, true);
  assert.equal(rolledBack.releaseState.active, 'a');
  assert.equal(rolledBack.releaseState.previous, 'b');
  assert.match(readFileSync(join(directory, 'compose.yaml'), 'utf8'), new RegExp(coreDigestV1));
});

test('failed candidate health automatically restores the active compose and release metadata', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'deploy-suitcase-health-rollback-'));
  const fixture = releaseRunner({ failUpCall: 2 });
  const common = {
    directory,
    uuid: () => fixedId,
    runner: fixture.runner,
    portAvailable: async () => true,
  };
  await new SuitcaseTargetManager({
    ...common,
    coreImage: coreV1,
    helperImage: helperV1,
  }).start({ acceptDockerSocketRisk: true });
  const upgraded = await new SuitcaseTargetManager({
    ...common,
    coreImage: coreV2,
    helperImage: helperV2,
  }).upgrade({ acceptDockerSocketRisk: true });

  assert.equal(upgraded.activated, false);
  assert.equal(upgraded.rolledBack, true);
  assert.equal(upgraded.releaseState.active, 'a');
  assert.equal(upgraded.releaseState.previous, null);
  assert.equal(upgraded.releaseState.lastAttempt?.result, 'restored-previous');
  assert.match(upgraded.failure ?? '', /candidate health deadline exceeded/);
  assert.match(readFileSync(join(directory, 'compose.yaml'), 'utf8'), new RegExp(coreDigestV1));
  assert.doesNotMatch(
    readFileSync(join(directory, 'target.json'), 'utf8'),
    new RegExp(coreDigestV2),
  );
});

test('failed explicit rollback leaves the current healthy slot active', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'deploy-suitcase-failed-explicit-rollback-'));
  const fixture = releaseRunner({ failUpCall: 3 });
  const common = {
    directory,
    uuid: () => fixedId,
    runner: fixture.runner,
    portAvailable: async () => true,
  };
  await new SuitcaseTargetManager({
    ...common,
    coreImage: coreV1,
    helperImage: helperV1,
  }).start({ acceptDockerSocketRisk: true });
  const current = new SuitcaseTargetManager({
    ...common,
    coreImage: coreV2,
    helperImage: helperV2,
  });
  await current.upgrade({ acceptDockerSocketRisk: true });
  const rollback = await current.rollback({ acceptDockerSocketRisk: true });

  assert.equal(rollback.activated, false);
  assert.equal(rollback.restoredCurrent, true);
  assert.equal(rollback.releaseState.active, 'b');
  assert.equal(rollback.releaseState.previous, 'a');
  assert.match(readFileSync(join(directory, 'compose.yaml'), 'utf8'), new RegExp(coreDigestV2));
});

test('activation fails closed when a tag cannot resolve unless development override is explicit', async () => {
  const rejectedFixture = releaseRunner({ unresolved: true });
  const rejected = new SuitcaseTargetManager({
    directory: mkdtempSync(join(tmpdir(), 'deploy-suitcase-unresolved-')),
    coreImage: coreV1,
    helperImage: helperV1,
    runner: rejectedFixture.runner,
    portAvailable: async () => true,
  });
  await assert.rejects(
    () => rejected.start({ acceptDockerSocketRisk: true }),
    /did not resolve to an immutable repository digest/,
  );

  const developmentFixture = releaseRunner({ unresolved: true });
  const development = new SuitcaseTargetManager({
    directory: mkdtempSync(join(tmpdir(), 'deploy-suitcase-mutable-dev-')),
    coreImage: coreV1,
    helperImage: helperV1,
    runner: developmentFixture.runner,
    portAvailable: async () => true,
    allowMutableImages: true,
  });
  const started = await development.start({ acceptDockerSocketRisk: true });
  assert.equal(started.releaseState.slots.a?.coreImage, coreV1);
  assert.equal(started.releaseState.slots.a?.signatureVerification.status, 'development-override');
});

test('cosign verification is recorded only after configured verification succeeds', async () => {
  const verifiedFixture = releaseRunner();
  const verified = new SuitcaseTargetManager({
    directory: mkdtempSync(join(tmpdir(), 'deploy-suitcase-signed-')),
    coreImage: coreV1,
    helperImage: helperV1,
    runner: verifiedFixture.runner,
    portAvailable: async () => true,
    cosignKey: '/trusted/suitcase.pub',
  });
  const started = await verified.start({ acceptDockerSocketRisk: true });
  assert.equal(started.releaseState.slots.a?.signatureVerification.status, 'verified');
  assert.equal(
    verifiedFixture.calls.filter((args) => args[0] === 'cosign' && args[1] === 'verify').length,
    2,
  );

  const failedFixture = releaseRunner({ cosignFailure: true });
  const failedDirectory = mkdtempSync(join(tmpdir(), 'deploy-suitcase-signature-failed-'));
  const failed = new SuitcaseTargetManager({
    directory: failedDirectory,
    coreImage: coreV1,
    helperImage: helperV1,
    runner: failedFixture.runner,
    portAvailable: async () => true,
    cosignKey: '/trusted/suitcase.pub',
  });
  await assert.rejects(
    () => failed.start({ acceptDockerSocketRisk: true }),
    /Cosign verification failed/,
  );
  assert.equal(existsSync(join(failedDirectory, 'releases.json')), false);

  const keylessFixture = releaseRunner();
  const keyless = new SuitcaseTargetManager({
    directory: mkdtempSync(join(tmpdir(), 'deploy-suitcase-keyless-signed-')),
    coreImage: coreV1,
    helperImage: helperV1,
    runner: keylessFixture.runner,
    portAvailable: async () => true,
    cosignCertificateIdentity:
      'https://github.com/deploy-local/deploy.local/.github/workflows/release.yml@refs/tags/v1.0.0',
    cosignCertificateOidcIssuer: 'https://token.actions.githubusercontent.com',
  });
  const keylessStarted = await keyless.start({ acceptDockerSocketRisk: true });
  assert.equal(keylessStarted.releaseState.slots.a?.signatureVerification.method, 'cosign-keyless');
  assert.ok(
    keylessFixture.calls.some(
      (args) => args[0] === 'cosign' && args.includes('--certificate-oidc-issuer'),
    ),
  );
});

test('core control executes inside the running suitcase instead of reading host membership', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'deploy-suitcase-control-'));
  const calls: string[][] = [];
  const manager = new SuitcaseTargetManager({
    directory,
    uuid: () => fixedId,
    runner: async (_command, args) => {
      calls.push(args);
      return success('{"siteId":"site-state","mode":"away"}\n');
    },
  });
  manager.ensureArtifacts();
  const result = await manager.control('mode', ['away']);
  assert.deepEqual(result, { siteId: 'site-state', mode: 'away' });
  assert.deepEqual(calls[0].slice(-7), [
    'exec',
    '-T',
    'core',
    'node',
    '/opt/deploy.local/dist/suitcase-control.js',
    'mode',
    'away',
  ]);
});

test('preflight rejects non-Linux engines and occupied published ports', async () => {
  const makeManager = (dockerVersion: string, portAvailable: (port: number) => Promise<boolean>) =>
    new SuitcaseTargetManager({
      directory: mkdtempSync(join(tmpdir(), 'deploy-suitcase-preflight-')),
      uuid: () => fixedId,
      portAvailable,
      runner: async (_command, args) => {
        if (args[0] === 'version') return success(dockerVersion);
        if (args[0] === 'info') return success(`4|${8 * 1024 ** 3}|/var/lib/docker|host\n`);
        if (args[0] === 'compose' && args[1] === 'version') return success('2.35.1\n');
        return success();
      },
    });

  await assert.rejects(
    () =>
      makeManager('26.1.4|windows|amd64\n', async () => true).start({
        acceptDockerSocketRisk: true,
      }),
    /Linux Docker engine/,
  );
  await assert.rejects(
    () =>
      makeManager('26.1.4|linux|amd64\n', async (port) => port !== 8443).start({
        acceptDockerSocketRisk: true,
      }),
    /HTTPS port 8443 is already in use/,
  );
});

test('preflight enforces the Compose version needed for health-aware startup', async () => {
  const manager = new SuitcaseTargetManager({
    directory: mkdtempSync(join(tmpdir(), 'deploy-suitcase-compose-version-')),
    uuid: () => fixedId,
    runner: async (_command, args) => {
      if (args[0] === 'version') return success('26.1.4|linux|amd64\n');
      if (args[0] === 'compose' && args[1] === 'version') return success('2.19.1\n');
      return success();
    },
  });
  await assert.rejects(
    () => manager.start({ acceptDockerSocketRisk: true }),
    /Docker Compose 2\.20 or newer/,
  );
});

test('offline access advice is explicit for macOS, Windows, and Linux', () => {
  const mac = suitcaseAccessAdvice('darwin', '192.168.2.1', 8443, 'auto');
  const windows = suitcaseAccessAdvice('win32', '192.168.137.1', 443, 'auto');
  const linux = suitcaseAccessAdvice('linux', undefined, 8443, 'auto');

  assert.equal(mac.url, 'https://192.168.2.1:8443');
  assert.match(mac.instructions.join(' '), /Internet Sharing/);
  assert.match(windows.instructions.join(' '), /Mobile hotspot/);
  assert.match(linux.instructions.join(' '), /NetworkManager/);
  assert.equal(linux.status, 'warn');
  assert.match(linux.instructions.join(' '), /localhost is only reachable on this host/);
});

test('diagnose reports failures without requiring a Docker daemon', async () => {
  const manager = new SuitcaseTargetManager({
    directory: mkdtempSync(join(tmpdir(), 'deploy-suitcase-diagnose-')),
    platform: 'darwin',
    runner: async () => ({ code: 127, stdout: '', stderr: 'docker: command not found' }),
    networkInterfaces: () => ({}),
  });
  const diagnostics = await manager.diagnose();
  assert.equal(diagnostics.ok, false);
  assert.equal(diagnostics.checks.find((check) => check.id === 'docker-engine')?.status, 'fail');
  assert.equal(diagnostics.checks.find((check) => check.id === 'target-files')?.status, 'warn');
  assert.equal(diagnostics.checks.find((check) => check.id === 'physical-loss')?.status, 'warn');
  assert.equal(
    diagnostics.checks.find((check) => check.id === 'physical-loss')?.detail,
    PHYSICAL_LOSS_WARNING,
  );
  assert.equal(
    diagnostics.checks.find((check) => check.id === 'docker-socket')?.detail,
    DOCKER_SOCKET_WARNING,
  );
  assert.match(diagnostics.accessInstructions.join(' '), /Internet Sharing/);
});

test('CLI compose creates a durable target without contacting Docker', () => {
  const directory = mkdtempSync(join(tmpdir(), 'deploy-suitcase-cli-'));
  const repository = resolve(import.meta.dirname, '..');
  const output = execFileSync(
    process.execPath,
    ['bin/deploy.js', 'suitcase', 'target', 'compose', '--target-dir', directory],
    { cwd: repository, encoding: 'utf8' },
  );
  assert.match(output, /name: deploy-local-suitcase/);
  assert.match(
    output,
    new RegExp(`Written to ${directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
  );
  assert.equal(JSON.parse(readFileSync(join(directory, 'target.json'), 'utf8')).schemaVersion, 1);
  const help = execFileSync(process.execPath, ['bin/deploy.js', '--help'], {
    cwd: repository,
    encoding: 'utf8',
  });
  assert.match(help, /Run and rollback an offline-capable Docker target/);
  assert.match(help, /--allow-mutable-images/);
  assert.match(help, /--cosign-key/);
});

test('portable release metadata declares multi-architecture OCI builds', () => {
  const repository = resolve(import.meta.dirname, '..');
  const release = JSON.parse(
    readFileSync(join(repository, 'docker/suitcase/release.json'), 'utf8'),
  );
  const buildScript = readFileSync(join(repository, 'docker/suitcase/build-images.mjs'), 'utf8');
  const coreEntrypoint = readFileSync(
    join(repository, 'docker/suitcase/core-entrypoint.sh'),
    'utf8',
  );
  assert.deepEqual(release.platforms, ['linux/amd64', 'linux/arm64']);
  assert.equal(release.runtimeProtocol, '1');
  assert.equal(release.artifacts.sbom, true);
  assert.equal(release.platformUpgrade.imageActivation, 'immutable-repository-digest');
  assert.equal(release.platformUpgrade.slots, 2);
  assert.equal(release.platformUpgrade.healthGated, true);
  assert.equal(release.platformUpgrade.automaticRestore, true);
  assert.match(buildScript, /linux\/amd64,linux\/arm64/);
  assert.match(buildScript, /--provenance=mode=max/);
  assert.match(buildScript, /--sbom=true/);
  assert.match(buildScript, /cosign/);
  assert.match(coreEntrypoint, /suitcase-target-id/);
  assert.match(coreEntrypoint, /identity mismatch/i);
});
