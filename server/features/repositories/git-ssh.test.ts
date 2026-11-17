import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import ssh2 from 'ssh2';
const { utils, Client } = ssh2;
const data = mkdtempSync(join(tmpdir(), 'deploy-ssh-'));
process.env.DEPLOY_DATA_DIR = data;
const { workspaceApi } = await import('../../workspace/api.ts');
const { list, get, save } = await import('../../workspace/store.ts');
const { parsePublicKey, addSshKey, deleteSshKey } = await import('./ssh-keys.ts');
const { sshHostKey, sshServerInfo, configuredSshPort } = await import('./ssh-host.ts');
const { startGitSshServer, parseGitCommand } = await import('./git-ssh.ts');
const { queueProject } = await import('./repositories.ts');
const { RepositoryRunner } = await import('./repository-runner.ts');
let ssh: Awaited<ReturnType<typeof startGitSshServer>>;
after(async () => {
  await ssh?.close();
  rmSync(data, { recursive: true, force: true });
});
let operation = 0;
async function api(path: string, body?: any, owner = 'alice', worker = false) {
  let status = 0;
  let result: any;
  const request = Object.assign(
    Readable.from(
      body ? [Buffer.from(JSON.stringify({ operationId: `ssh-${++operation}`, ...body }))] : [],
    ),
    {
      method: body ? 'POST' : 'GET',
      url: '/api' + path,
      headers: {},
    },
  );
  await workspaceApi(
    request as unknown as IncomingMessage,
    {
      writeHead(code: number) {
        status = code;
      },
      end(text: string) {
        result = JSON.parse(text);
      },
    } as ServerResponse,
    owner,
    worker ? 'worker' : undefined,
  );
  return { status, body: result };
}
function run(bin: string, args: string[], cwd = data, env = process.env) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '',
      stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
async function ok(bin: string, args: string[], cwd = data, env = process.env) {
  const result = await run(bin, args, cwd, env);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

test('public keys normalize, fingerprint, validate types and reject private/weak/malformed keys', () => {
  for (const [type, options] of [
    ['ed25519', {}],
    ['ecdsa', { bits: 256 }],
    ['ecdsa', { bits: 384 }],
    ['ecdsa', { bits: 521 }],
    ['rsa', { bits: 2048 }],
  ] as const) {
    const pair = utils.generateKeyPairSync(type as any, options as any);
    const normalized = parsePublicKey(`  ${pair.public} laptop  \n`);
    assert.equal(normalized.comment, 'laptop');
    assert.match(normalized.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
    assert.equal(parsePublicKey(normalized.publicKey).fingerprint, normalized.fingerprint);
    assert.throws(() => parsePublicKey(pair.private), /Private keys/);
  }
  assert.throws(
    () => parsePublicKey(utils.generateKeyPairSync('rsa', { bits: 1024 }).public),
    /2048/,
  );
  for (const input of [
    '',
    'ssh-ed25519 abc',
    'ssh-dss AAAA',
    'ssh-ed25519 !!!',
    '-----BEGIN ENCRYPTED PRIVATE KEY-----',
  ])
    assert.throws(() => parsePublicKey(input));
});

test('key ownership is global; API mutations replay, delete is scoped and workers are denied', async () => {
  const existingKeys = list('ssh-key', 'alice');
  const publicKey = utils.generateKeyPairSync('ed25519').public + ' test computer';
  const added = await api('/ssh-keys', { operationId: 'add-once', publicKey });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.equal(added.body.name, 'test computer');
  assert.equal(
    (await api('/ssh-keys', { operationId: 'add-once', publicKey })).body.id,
    added.body.id,
  );
  assert.equal(
    (await api('/ssh-keys', { operationId: 'add-once', publicKey, name: 'changed' })).status,
    409,
  );
  assert.equal((await api('/ssh-keys', { publicKey }, 'bob')).status, 409);
  assert.equal((await api('/ssh-keys', { publicKey, name: 'x'.repeat(81) })).status, 400);
  assert.equal((await api(`/ssh-keys/${added.body.id}/delete`, {}, 'bob')).status, 404);
  for (const [path, body] of [
    ['/ssh-keys', undefined],
    ['/ssh-keys', { publicKey }],
    [`/ssh-keys/${added.body.id}/delete`, {}],
  ] as const)
    assert.equal((await api(path, body, 'alice', true)).status, 403);
  assert.equal(
    (await api(`/ssh-keys/${added.body.id}/delete`, { operationId: 'delete-once' })).status,
    200,
  );
  assert.equal(
    (await api(`/ssh-keys/${added.body.id}/delete`, { operationId: 'delete-once' })).status,
    200,
  );
  assert.deepEqual(list('ssh-key', 'alice'), existingKeys);
  const reassigned = addSshKey('bob', { publicKey });
  deleteSshKey('bob', reassigned.id);
});

test('generated Ed25519 keys preserve a leading zero and work through the API', async () => {
  // Run in a fresh process so ssh2 captures the fixed crypto fixture at import time.
  // Seed 135 derives a real Ed25519 public key whose first byte is zero.
  const publicKey = await ok(
    process.execPath,
    [
      '-e',
      `
      const assert = require('node:assert/strict');
      const crypto = require('node:crypto');
      const seed = Buffer.alloc(32);
      seed.writeUInt32BE(135);
      const privateKey = crypto.createPrivateKey({
        key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
        format: 'der', type: 'pkcs8',
      });
      const publicKey = crypto.createPublicKey(privateKey);
      const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
      assert.equal(raw.length, 32);
      assert.equal(raw[0], 0);
      crypto.generateKeyPairSync = () => ({
        publicKey: publicKey.export({ format: 'der', type: 'spki' }),
        privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }),
      });
      const { utils } = require('ssh2');
      const pair = utils.generateKeyPairSync('ed25519');
      const key = utils.parseKey(pair.private);
      assert.ok(!(key instanceof Error), String(key));
      const blob = key.getPublicSSH();
      assert.equal(blob.readUInt32BE(15), 32);
      assert.deepEqual(blob.subarray(19), raw);
      const message = Buffer.from('leading-zero regression');
      assert.ok(crypto.verify(null, message, publicKey, key.sign(message)));
      console.log(pair.public);
    `,
    ],
    process.cwd(),
  );
  const added = await api('/ssh-keys', { publicKey }, 'leading-zero');
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.equal(added.body.publicKey, publicKey);
  assert.equal((await api('/ssh-keys', undefined, 'leading-zero')).body.keys[0].id, added.body.id);
  assert.equal((await api(`/ssh-keys/${added.body.id}/delete`, {}, 'leading-zero')).status, 200);
});

test('command grammar accepts Git paths and rejects shell syntax', () => {
  for (const path of ['home-gym.git', '/home-gym.git', '~/home-gym.git', 'home-gym', 'some-id']) {
    assert.ok(parseGitCommand(`git-upload-pack '${path}'`));
    assert.ok(parseGitCommand(`git receive-pack '${path}'`));
  }
  for (const command of [
    'sh',
    "git-upload-pack '../secret'",
    "git-upload-pack '/foo/bar'",
    "git-upload-pack 'repo'; whoami",
    'git-upload-pack --help',
    "git-upload-pack '$(whoami)'",
  ])
    assert.equal(parseGitCommand(command), null);
});

test('host identity persists with private permissions and disabled configuration', async () => {
  const first = sshHostKey();
  assert.equal(sshHostKey().fingerprint, first.fingerprint);
  assert.equal(statSync(join(data, 'ssh_host_ed25519_key')).mode & 0o777, 0o600);
  process.env.DEPLOY_SSH_PORT = '0';
  assert.equal(configuredSshPort(), 0);
  assert.equal(await startGitSshServer(), null);
  assert.deepEqual(sshServerInfo(), {
    enabled: false,
    port: null,
    hostFingerprints: [],
    knownHostsLine: '',
  });
  process.env.DEPLOY_SSH_PORT = 'invalid';
  const logs: string[] = [];
  assert.equal(await startGitSshServer({ log: (line) => logs.push(line) }), null);
  assert.match(logs[0], /DEPLOY_SSH_PORT/);
  delete process.env.DEPLOY_SSH_PORT;
  assert.equal(configuredSshPort(), 2222);
});

test('both transports queue only successful branch updates', async () => {
  const { PushResult } = await import('../../workspace/pipeline-triggers.ts');
  const push = new PushResult();
  const commits = ['a'.repeat(40), 'b'.repeat(40)];
  const command = (commit: string, ref: string) => {
    const body = `${'0'.repeat(40)} ${commit} ${ref}\n`;
    return (Buffer.byteLength(body) + 4).toString(16).padStart(4, '0') + body;
  };
  const input = Buffer.from(
    command(commits[0], 'refs/heads/accepted') +
      command(commits[1], 'refs/heads/rejected') +
      '0000',
  );
  for (let i = 0; i < input.length; i += 7) push.commands.feed(input.subarray(i, i + 7));
  push.feed(Buffer.from('unpack ok\nok refs/heads/acc'));
  push.feed(Buffer.from('epted\nng refs/heads/rejected denied\n'));
  push.queue('push-report', 'project');
  assert.deepEqual(
    list('pipeline-trigger-request', 'push-report').map(({ ref, commit }) => ({ ref, commit })),
    [{ ref: 'refs/heads/accepted', commit: commits[0] }],
  );
});

// Exercise the real SSH protocol without a TCP listener (also works in network sandboxes).
test('SSH protocol verifies signatures, rejects capabilities, and serves ready owner repositories', async () => {
  const { Duplex } = await import('node:stream');
  const { createGitSshTransport } = await import('./git-ssh.ts');
  const transport = createGitSshTransport(sshHostKey().privateKey);
  const pair = utils.generateKeyPairSync('ed25519');
  const added = addSshKey('memory', { publicKey: pair.public });
  const project = queueProject('memory', { name: 'memory-repo' });
  await new RepositoryRunner().tick();
  assert.equal(get('project', 'memory', project.id).repositoryStatus, 'ready');
  const clients: InstanceType<typeof Client>[] = [];
  function connect(privateKey: any, username = 'git', options: any = {}) {
    const streams: any[] = [];
    for (let i = 0; i < 2; i++)
      streams.push(
        Object.assign(
          new Duplex({
            read() {},
            write(chunk, _encoding, callback) {
              queueMicrotask(() => {
                streams[1 - i].push(chunk);
                callback();
              });
            },
            final(callback) {
              queueMicrotask(() => {
                streams[1 - i].push(null);
                callback();
              });
            },
            destroy(error, callback) {
              if (!streams[1 - i].destroyed) streams[1 - i].destroy();
              callback(error);
            },
          }),
          { setTimeout() {}, setNoDelay() {} },
        ),
      );
    const client = new Client();
    clients.push(client);
    return new Promise<InstanceType<typeof Client>>((resolve, reject) => {
      client.once('ready', () => resolve(client));
      client.on('error', reject);
      transport.attach(streams[0]);
      client.connect({ sock: streams[1], username, privateKey, readyTimeout: 3000, ...options });
    });
  }
  function exec(client: InstanceType<typeof Client>, command: string, options: any = {}) {
    return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      client.exec(command, options, (error, channel) => {
        if (error) return reject(error);
        let stdout = '',
          stderr = '';
        channel.on('data', (chunk: Buffer) => (stdout += chunk));
        channel.stderr.on('data', (chunk: Buffer) => (stderr += chunk));
        channel.once('close', (code: number) => resolve({ code, stdout, stderr }));
        channel.end('0000');
      });
    });
  }
  try {
    const client = await connect(pair.private);
    assert.ok(get('ssh-key', 'memory', added.id).lastUsedAt);
    const result = await exec(client, "git-upload-pack 'MEMORY-REPO.git'");
    assert.equal(result.code, 0);
    assert.match(result.stdout, /refs\/heads\/main/);
    const version2 = await exec(client, "git upload-pack '~/memory-repo.git'", {
      env: { GIT_PROTOCOL: 'version=2', GIT_CONFIG_COUNT: '100' },
    });
    assert.equal(version2.code, 0);
    assert.match(version2.stdout, /version 2/);
    const arbitrary = await exec(client, 'whoami');
    assert.equal(arbitrary.code, 1);
    assert.match(arbitrary.stderr, /Only git-upload-pack/);
    const unknown = await exec(client, "git-upload-pack 'private-other-owner'");
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /repository not found/);
    await assert.rejects(exec(client, "git-upload-pack 'memory-repo'", { pty: true }));
    await assert.rejects(
      new Promise((resolve, reject) =>
        client.forwardOut('127.0.0.1', 1234, '127.0.0.1', 80, (error, channel) =>
          error ? reject(error) : resolve(channel),
        ),
      ),
    );
    const forgedKey = utils.parseKey(utils.generateKeyPairSync('ed25519').private) as any;
    const knownKey = utils.parseKey(pair.private) as any;
    forgedKey.getPublicSSH = () => knownKey.getPublicSSH();
    await assert.rejects(connect(forgedKey), /authentication methods failed/);
    await assert.rejects(connect(pair.private, 'root'), /authentication methods failed/);
    // An unknown key is refused, not fatal: the client may hold the right key next.
    const stranger = utils.generateKeyPairSync('ed25519').private;
    await assert.rejects(connect(stranger), /authentication methods failed/);
    const second = await connect(undefined, 'git', {
      authHandler: [
        { type: 'publickey', username: 'git', key: stranger },
        { type: 'publickey', username: 'git', key: pair.private },
      ],
    });
    assert.equal((await exec(second, "git-upload-pack 'memory-repo.git'")).code, 0);
    // A client out of keys turns to keyboard-interactive, and is told what to do.
    const outOfKeys = { tryKeyboard: true };
    await assert.rejects(connect(stranger, 'git', outOfKeys), /Add this computer's SSH key/);
    deleteSshKey('memory', added.id);
    await assert.rejects(connect(pair.private, 'git', outOfKeys), /Add this computer's SSH key/);
  } finally {
    for (const client of clients) client.destroy();
    transport.close();
  }
});

for (const mode of ['tcp', 'stdio'] as const)
  test(`real SSH/Git (${mode}): trusted host, clone, push triggers, auth and session restrictions`, async () => {
    if (mode === 'tcp') {
      ssh = await startGitSshServer({ port: 0, host: '127.0.0.1', log: () => {} });
      assert.ok(ssh, 'TCP listener could not start');
    }
    const port = ssh?.port ?? 2222;
    const host = sshHostKey();
    assert.equal(sshHostKey().fingerprint, host.fingerprint);
    assert.equal(statSync(join(data, 'ssh_host_ed25519_key')).mode & 0o777, 0o600);
    const key = join(data, `client-${mode}`);
    await ok('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', key]);
    const added = await api('/ssh-keys', { publicKey: readFileSync(key + '.pub', 'utf8') });
    assert.equal(added.status, 200);
    assert.equal(
      added.body.fingerprint,
      (await ok('ssh-keygen', ['-lf', key + '.pub'])).split(' ')[1],
    );
    const info = (await api('/ssh-keys')).body.server;
    if (mode === 'tcp') {
      assert.equal(info.port, port);
      assert.deepEqual(info.hostFingerprints, [host.fingerprint]);
    }
    const hosts = join(data, 'known_hosts');
    writeFileSync(
      hosts,
      (mode === 'tcp'
        ? info.knownHostsLine.replace('[deploy.local]', '[127.0.0.1]')
        : `[127.0.0.1]:${port} ${host.publicKey}`) + '\n',
    );
    const sshArgs = [
      '-p',
      String(port),
      '-i',
      key,
      '-o',
      `UserKnownHostsFile=${hosts}`,
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'BatchMode=yes',
    ];
    if (mode === 'stdio')
      sshArgs.push(
        '-o',
        `ProxyCommand="${process.execPath}" "${resolve('server/workspace/fixtures/git-ssh-stdio.ts')}"`,
      );
    const env = {
      ...process.env,
      GIT_SSH_COMMAND: ['ssh', ...sshArgs]
        .map((part) => "'" + part.replaceAll("'", "'\\''") + "'")
        .join(' '),
    };
    const project = queueProject('alice', { name: `home-gym-${mode}` });
    const other = queueProject('bob', { name: `private-bob-${mode}` });
    const runner = new RepositoryRunner();
    await runner.tick();
    await runner.tick();
    assert.equal(get('project', 'alice', project.id).repositoryStatus, 'ready');
    const repoInfo = (await api(`/projects/${project.id}/repository`)).body;
    assert.equal(repoInfo.sshClonePath, `/home-gym-${mode}.git`);
    assert.equal(repoInfo.sshPort, mode === 'tcp' ? port : null);
    const url = `ssh://git@127.0.0.1:${port}`;
    await ok('git', ['clone', `${url}/home-gym-${mode}.git`, `clone-${mode}`], data, env);
    const clone = join(data, `clone-${mode}`);
    await ok('git', ['config', 'user.name', 'SSH test'], clone);
    await ok('git', ['config', 'user.email', 'ssh@example.invalid'], clone);
    writeFileSync(join(clone, 'pushed.txt'), 'pushed via SSH\n');
    await ok('git', ['add', '.'], clone);
    await ok('git', ['commit', '-m', 'SSH push'], clone);
    await ok('git', ['push', 'origin', 'HEAD'], clone, env);
    const commit = await ok('git', ['rev-parse', 'HEAD'], clone);
    assert.ok(
      list('pipeline-trigger-request', 'alice').some(
        (trigger) => trigger.projectId === project.id && trigger.commit === commit,
      ),
    );
    await ok(
      'git',
      ['clone', `${url}/HOME-GYM-${mode.toUpperCase()}.git`, `case-clone-${mode}`],
      data,
      env,
    );
    assert.equal(
      readFileSync(join(data, `case-clone-${mode}`, 'pushed.txt'), 'utf8'),
      'pushed via SSH\n',
    );
    for (const path of [`home-gym-${mode}`, `~/home-gym-${mode}.git`, project.id])
      await ok('git', ['ls-remote', `${url}/${path}`], data, env);
    const missing = await run('git', ['ls-remote', `${url}/missing.git`], data, env);
    for (const path of [`private-bob-${mode}`, other.id]) {
      const denied = await run('git', ['ls-remote', `${url}/${path}.git`], data, env);
      assert.notEqual(denied.code, 0);
      assert.match(denied.stderr, /repository not found/);
      assert.match(missing.stderr, /repository not found/);
    }
    assert.ok(get('ssh-key', 'alice', added.body.id).lastUsedAt);
    const shell = await run('ssh', [...sshArgs, '-T', 'git@127.0.0.1']);
    assert.equal(shell.code, 1);
    assert.match(shell.stderr, /interactive shells are disabled/);
    const arbitrary = await run('ssh', [...sshArgs, 'git@127.0.0.1', 'whoami']);
    assert.equal(arbitrary.code, 1);
    assert.match(arbitrary.stderr, /Only git-upload-pack/);
    assert.notEqual((await run('ssh', [...sshArgs, 'alice@127.0.0.1', 'whoami'])).code, 0);
    const unknown = join(data, `unknown-${mode}`);
    await ok('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', unknown]);
    const unknownArgs = sshArgs.map((arg) => (arg === key ? unknown : arg));
    // Scripts (BatchMode) never try keyboard-interactive, so they get OpenSSH's own refusal.
    const scripted = await run('ssh', [...unknownArgs, 'git@127.0.0.1', 'whoami']);
    assert.notEqual(scripted.code, 0);
    assert.match(scripted.stderr, /Permission denied \(publickey/);
    // An unknown key offered first does not stop the registered one that follows it.
    const both = await run('ssh', ['-i', unknown, ...sshArgs, 'git@127.0.0.1', 'whoami']);
    assert.equal(both.code, 1);
    assert.match(both.stderr, /Only git-upload-pack/);
    const asPerson = unknownArgs.map((arg) => (arg === 'BatchMode=yes' ? 'BatchMode=no' : arg));
    const rejected = await run('ssh', [...asPerson, 'git@127.0.0.1', 'whoami']);
    assert.notEqual(rejected.code, 0);
    assert.match(
      rejected.stderr,
      /Add this computer's SSH key in deploy\.local Settings > SSH keys/,
    );
    save('project', 'alice', {
      ...get('project', 'alice', project.id),
      repositoryStatus: 'preparing',
    });
    assert.match(
      (await run('git', ['ls-remote', `${url}/home-gym-${mode}.git`], data, env)).stderr,
      /Repository is not ready/,
    );
    await ssh?.close();
    ssh = null;
    process.env.DEPLOY_SSH_PORT = '0';
    assert.equal(await startGitSshServer(), null);
    assert.equal(sshServerInfo().enabled, false);
  });
