import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { execFileSync, execFile, spawnSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LegacyDockerUpdate, type LegacyDockerOptions } from './legacy-docker-update.ts';
import { startProxies, stopProxies } from './tcp-proxy.ts';

const asyncExec = promisify(execFile);
const enabled = process.env.DEPLOY_LEGACY_DOCKER_TESTS === '1';
const docker = (...args: string[]) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DOCKER_BUILDKIT: '0' },
  }).trim();
async function port() {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

function program(version: number, fail = false) {
  return `import fs from 'node:fs'; import http from 'node:http'; import {spawn,execFileSync} from 'node:child_process'; import {DatabaseSync} from 'node:sqlite';
fs.mkdirSync('/run/sshd',{recursive:true}); fs.mkdirSync('/root/.ssh',{recursive:true,mode:0o700});fs.copyFileSync('/app/data/client.pub','/root/.ssh/authorized_keys');fs.chmodSync('/root/.ssh/authorized_keys',0o600);fs.chownSync('/root/.ssh/authorized_keys',0,0);fs.chownSync('/root/.ssh',0,0);
if(!fs.existsSync('/app/data/repo.git')){execFileSync('git',['init','--bare','/app/data/repo.git']); const blob=execFileSync('git',['--git-dir=/app/data/repo.git','hash-object','-w','--stdin'],{input:'fixture repository'}).toString().trim();const tree=execFileSync('git',['--git-dir=/app/data/repo.git','mktree'],{input:'100644 blob '+blob+'\\tREADME\\n'}).toString().trim();const commit=execFileSync('git',['--git-dir=/app/data/repo.git','commit-tree',tree],{input:'fixture commit',env:{...process.env,GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'}}).toString().trim();execFileSync('git',['--git-dir=/app/data/repo.git','update-ref','refs/heads/main',commit]);}
const db=new DatabaseSync('/app/data/real.sqlite');db.exec('CREATE TABLE IF NOT EXISTS projects(name TEXT)');if(!db.prepare('SELECT * FROM projects').get())db.exec("INSERT INTO projects VALUES('original')");${version > 1 ? `db.exec("UPDATE projects SET name='upgraded'");fs.writeFileSync('/app/uploads/candidate.txt','new upload');` : ''}db.close();
const ssh=spawn('/fixture/lib/ld-linux-x86-64.so.2',['--library-path','/fixture/lib','/fixture/sshd','-D','-e','-f','/app/data/sshd_config'],{stdio:'inherit'});ssh.on('exit',()=>process.exit(3));
http.createServer((req,res)=>{res.statusCode=${fail ? 503 : 200};res.end('fixture-${version}')}).listen(3000,'0.0.0.0');
`;
}

const leakedFixtures: Array<() => void> = [];
after(() => {
  for (const cleanup of leakedFixtures) {
    try {
      cleanup();
    } catch {}
  }
});
async function fixture(layout: 'separate' | 'data' = 'separate') {
  const root = mkdtempSync(join(tmpdir(), 'deploy-legacy-docker-'));
  const id = randomUUID().slice(0, 8);
  const name = `deploy-legacy-fixture-${id}`;
  const network = `${name}-network`;
  leakedFixtures.push(() => {
    for (const candidate of docker('ps', '-a', '--format', '{{.Names}}')
      .split('\n')
      .filter((n) => n === name || n.startsWith(name + '-legacy-') || n === name + '-writer'))
      docker('rm', '-f', candidate);
    try {
      docker('network', 'rm', network);
    } catch {}
    docker(
      'run',
      '--rm',
      '--network',
      'none',
      '--entrypoint',
      'sh',
      '--mount',
      `type=bind,source=${root},target=/fixture-data`,
      'sha256:a8c97b6eb4e4725ae6ae88f80dbea1f8e92422d1fc8e9ab3b51e0e9456aea61d',
      '-c',
      'rm -rf /fixture-data/*',
    );
    for (const tag of docker('images', '--format', '{{.Repository}}:{{.Tag}}')
      .split('\n')
      .filter((t) => t.startsWith(name + ':')))
      docker('image', 'rm', tag);
    stopProxies(name);
    rmSync(root, { recursive: true, force: true });
  });
  const volumeDirectory = join(root, 'volumes');
  for (const directory of ['data', 'uploads', '.ssh-host-keys'])
    mkdirSync(join(volumeDirectory, directory), { recursive: true });
  execFileSync('ssh-keygen', [
    '-q',
    '-t',
    'ed25519',
    '-N',
    '',
    '-f',
    join(volumeDirectory, layout === 'data' ? 'data' : '.ssh-host-keys', 'ssh_host_ed25519_key'),
  ]);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(root, 'client')]);
  copyFileSync(join(root, 'client.pub'), join(volumeDirectory, 'data', 'client.pub'));
  writeFileSync(
    join(volumeDirectory, 'data', 'sshd_config'),
    `Port 2223\nListenAddress 0.0.0.0\nHostKey ${layout === 'data' ? '/app/data' : '/etc/ssh'}/ssh_host_ed25519_key\nPidFile /run/sshd.pid\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\nAuthorizedKeysFile /root/.ssh/authorized_keys\nStrictModes yes\n`,
  );
  if (layout === 'data')
    writeFileSync(
      join(volumeDirectory, '.ssh-host-keys', 'ssh_config'),
      '# synthetic legacy client config\n',
    );
  writeFileSync(join(volumeDirectory, 'data', 'marker'), 'never manufacture empty storage');
  const context = join(root, 'context');
  mkdirSync(context);
  mkdirSync(join(context, 'lib'));
  copyFileSync('/usr/sbin/sshd', join(context, 'sshd'));
  const libraries = execFileSync('ldd', ['/usr/sbin/sshd'], { encoding: 'utf8' })
    .split('\n')
    .flatMap((line) => line.match(/(?:=>\s+)?(\/[^\s]+)\s+\(/)?.[1] ?? []);
  for (const library of libraries)
    copyFileSync(library, join(context, 'lib', library.split('/').at(-1)!));
  mkdirSync(join(context, 'openssh'));
  for (const executable of ['sshd-session', 'sshd-auth']) {
    const source = '/usr/lib/openssh/' + executable;
    if (!existsSync(source)) continue;
    copyFileSync(source, join(context, executable));
    const deps = execFileSync('ldd', [source], { encoding: 'utf8' })
      .split('\n')
      .flatMap((line) => line.match(/(?:=>\s+)?(\/[^\s]+)\s+\(/)?.[1] ?? []);
    for (const dependency of deps)
      copyFileSync(dependency, join(context, 'lib', dependency.split('/').at(-1)!));
    const wrapper = join(context, 'openssh', executable);
    writeFileSync(
      wrapper,
      `#!/bin/sh\nexec /fixture/lib/ld-linux-x86-64.so.2 --library-path /fixture/lib /fixture/${executable} "$@"\n`,
    );
    chmodSync(wrapper, 0o755);
  }
  const baseTag = `${name}:base`;
  docker('tag', 'sha256:a8c97b6eb4e4725ae6ae88f80dbea1f8e92422d1fc8e9ab3b51e0e9456aea61d', baseTag);
  // The fixture never uses the production container or its mounts. The local
  // immutable image supplies Node/Git/tar; host sshd is copied into this image.
  writeFileSync(
    join(context, 'Dockerfile'),
    `FROM ${baseTag}\nCOPY . /fixture\nCOPY openssh/ /usr/lib/openssh/\nRUN echo "sshd:x:104:65534:sshd:/run/sshd:/usr/sbin/nologin" >> /etc/passwd && sed -i 's/^root:[^:]*:/root::/' /etc/shadow\nENTRYPOINT ["node","/fixture/server.mjs"]\n`,
  );
  const tags: string[] = [baseTag];
  function build(version: number, fail = false) {
    writeFileSync(join(context, 'server.mjs'), program(version, fail));
    const tag = `${name}:${version}${fail ? '-fail' : ''}`;
    tags.push(tag);
    docker('build', '--network', 'none', '-q', '-t', tag, context);
    return docker('image', 'inspect', '--format', '{{.Id}}', tag);
  }
  const firstImage = build(1);
  const secondImage = build(2);
  const failedImage = build(3, true);
  const httpPort = await port();
  const sshPort = await port();
  const publicPort = await port();
  docker('network', 'create', '--label', 'com.groffee.egress=restricted', network);
  docker(
    'run',
    '-d',
    '--name',
    name,
    '--network',
    network,
    '--restart',
    'unless-stopped',
    '-p',
    `127.0.0.1:${httpPort}:3000`,
    '-p',
    `127.0.0.1:${sshPort}:2223`,
    '-e',
    'EXTERNAL_URL=https://groffee.local',
    '--mount',
    `type=bind,source=${join(volumeDirectory, 'data')},target=/app/data`,
    '--mount',
    `type=bind,source=${join(volumeDirectory, 'uploads')},target=/app/uploads`,
    '--mount',
    `type=bind,source=${join(volumeDirectory, '.ssh-host-keys')},target=/etc/ssh`,
    firstImage,
  );
  startProxies(name, [{ container: publicPort, host: sshPort, protocol: 'tcp' }]);
  const oldId = docker('inspect', '--format', '{{.Id}}', name);
  const commits: string[] = [];
  const options: LegacyDockerOptions = {
    containerName: name,
    volumeDirectory,
    recoveryRoot: join(root, 'recovery'),
    httpPort,
    publicSshPort: publicPort,
    administrator: true,
    owner: true,
    nodeId: 'coordinator',
    activeGraphDigest: null,
    metadata: {
      containerId: oldId,
      extraPorts: JSON.stringify([{ container: 2223, host: sshPort, protocol: 'tcp' }]),
    },
    sourceDigest: 'fixture-v2',
    build: async () => secondImage,
    commit: async (containerId) => {
      commits.push(containerId);
    },
    restoreMetadata: async (_metadata, containerId) => {
      commits.push(containerId);
    },
  };
  const adapter = new LegacyDockerUpdate(options);
  const ssh = [
    '-i',
    join(root, 'client'),
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `UserKnownHostsFile=${join(root, 'known-hosts')}`,
  ];
  async function gitRead() {
    if (!existsSync(join(root, 'known-hosts'))) {
      const scan = await asyncExec(
        'ssh-keyscan',
        ['-T', '3', '-t', 'ed25519', '-p', String(publicPort), '127.0.0.1'],
        { timeout: 10000 },
      );
      writeFileSync(join(root, 'known-hosts'), scan.stdout);
    }
    const result = await asyncExec(
      'git',
      [
        '-c',
        `core.sshCommand=ssh ${ssh.map((arg) => "'" + arg.replaceAll("'", "'\\''") + "'").join(' ')}`,
        'ls-remote',
        `ssh://root@127.0.0.1:${publicPort}/app/data/repo.git`,
      ],
      { timeout: 10000 },
    );
    return result.stdout;
  }
  // Wait for initial HTTP and SSH without reading any production service.
  try {
    const deadline = Date.now() + 20_000;
    while (true) {
      try {
        await adapter.preflight();
        await gitRead();
        break;
      } catch (error) {
        if (Date.now() > deadline) {
          const logs = spawnSync('docker', ['logs', name], { encoding: 'utf8' });
          throw new Error(
            `Fixture startup failed: ${logs.stdout} ${logs.stderr} ${docker('inspect', '--format', '{{json .State}} {{json .NetworkSettings.Ports}} {{json .Config.Entrypoint}}', name)}`,
            { cause: error },
          );
        }
        await new Promise((done) => setTimeout(done, 250));
      }
    }
  } catch (error) {
    docker('rm', '-f', name);
    docker('network', 'rm', network);
    stopProxies(name);
    throw error;
  }
  return {
    root,
    name,
    options,
    adapter,
    oldId,
    firstImage,
    secondImage,
    failedImage,
    gitRead,
    commits,
    registerTag(tag: string) {
      tags.push(tag);
    },
    context,
    cleanup() {
      stopProxies(name);
      const names = docker('ps', '-a', '--format', '{{.Names}}')
        .split('\n')
        .filter(
          (value) =>
            value === name || value.startsWith(`${name}-legacy-`) || value === `${name}-writer`,
        );
      for (const value of names) docker('rm', '-f', value);
      docker('network', 'rm', network);

      // Root-owned synthetic files are removed by a disposable, restricted helper.
      docker(
        'run',
        '--rm',
        '--network',
        'none',
        '--entrypoint',
        'sh',
        '--mount',
        `type=bind,source=${root},target=/fixture-data`,
        firstImage,
        '-c',
        'rm -rf /fixture-data/*',
      );
      for (const tag of tags) docker('image', 'rm', tag);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test(
  'real Docker code update preserves root ownership, restricted network, public SSH trust and Git; explicit rollback restores data',
  { skip: !enabled, timeout: 180_000 },
  async () => {
    const f = await fixture();
    try {
      const originalOwnership = statSync(join(f.options.volumeDirectory, 'data', 'real.sqlite'));
      const refs = await f.gitRead();
      assert.ok(refs.includes('refs/heads/main'));
      const result = await f.adapter.update();
      assert.equal(result.unchanged, false);
      assert.equal(docker('inspect', '--format', '{{.Image}}', f.name), f.secondImage);
      assert.equal(await f.gitRead(), refs);
      assert.equal((await f.adapter.update()).unchanged, true);
      const current = readFileSync(
        join(f.options.volumeDirectory, 'uploads', 'candidate.txt'),
        'utf8',
      );
      assert.equal(current, 'new upload');
      await f.adapter.recover(true);
      assert.equal(docker('inspect', '--format', '{{.Id}}', f.name), f.oldId);
      assert.equal(docker('inspect', '--format', '{{.Image}}', f.name), f.firstImage);
      assert.equal(await f.gitRead(), refs);
      assert.equal(existsSync(join(f.options.volumeDirectory, 'uploads', 'candidate.txt')), false);
      const restoredOwnership = statSync(join(f.options.volumeDirectory, 'data', 'real.sqlite'));
      assert.deepEqual(
        [restoredOwnership.uid, restoredOwnership.gid, restoredOwnership.mode],
        [originalOwnership.uid, originalOwnership.gid, originalOwnership.mode],
      );
      assert.equal((await f.adapter.recover(true)).unchanged, true);
      assert.equal(f.adapter.status().locked, false);
    } finally {
      f.cleanup();
    }
  },
);

test(
  'a committed but stopped release can roll back without requiring candidate health',
  { skip: !enabled, timeout: 180_000 },
  async () => {
    const f = await fixture();
    try {
      const refs = await f.gitRead();
      await f.adapter.update();
      docker('stop', f.name);
      await f.adapter.recover(true);
      assert.equal(docker('inspect', '--format', '{{.Id}}', f.name), f.oldId);
      assert.equal(await f.gitRead(), refs);
      assert.equal(existsSync(join(f.options.volumeDirectory, 'uploads', 'candidate.txt')), false);
      assert.equal(f.adapter.status().locked, false);
    } finally {
      f.cleanup();
    }
  },
);

test(
  'process death during a root restore fences its orphan helper before repeating recovery',
  { skip: !enabled, timeout: 180_000 },
  async () => {
    const f = await fixture();
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const refs = await f.gitRead();
      await f.adapter.update();
      const serializable = {
        ...f.options,
        build: undefined,
        commit: undefined,
        restoreMetadata: undefined,
      };
      const marker = join(f.options.recoveryRoot, 'helper-restoring');
      const driver = join(f.root, 'mid-helper.mjs');
      // This fault exists only in this disposable test process. Pause after the
      // helper has removed candidate data, before it extracts the old archive.
      const needle =
        "  execFileSync(\n    'tar',\n    ['--numeric-owner', '-xpf', join(snapshot.directory, 'data.tar'), '-C', volumeDirectory],";
      const pause =
        "  writeFileSync('/recovery/helper-restoring','ready');\n  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,600000);\n";
      writeFileSync(
        driver,
        `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const write=fs.writeFileSync;fs.writeFileSync=(path,value,...rest)=>{if(typeof path==='string'&&path.endsWith('.mjs')&&path.includes('/helper-')&&typeof value==='string'&&value.includes('const action="restore"')){if(!value.includes(${JSON.stringify(needle)}))throw new Error('Restore failpoint not found');value=value.replace(${JSON.stringify(needle)},${JSON.stringify(pause)}+${JSON.stringify(needle)});}return write(path,value,...rest)};syncBuiltinESMExports();const{LegacyDockerUpdate}=await import(${JSON.stringify(new URL('./legacy-docker-update.ts', import.meta.url).href)});const adapter=new LegacyDockerUpdate({...${JSON.stringify(serializable)},build:async()=>{throw new Error('No build in recovery')},commit:async()=>{},restoreMetadata:async()=>{}});await adapter.recover(true);`,
      );
      child = spawn(process.execPath, [driver], { stdio: 'ignore' });
      const deadline = Date.now() + 30_000;
      while (!existsSync(marker)) {
        if (child.exitCode !== null)
          throw new Error('Recovery driver exited before helper failpoint');
        if (Date.now() > deadline) throw new Error('No mid-helper failpoint');
        await new Promise((done) => setTimeout(done, 100));
      }
      const records = readFileSync(join(f.options.recoveryRoot, 'journal.json'), 'utf8');
      assert.ok(records.includes('rolling-back'));
      child.kill('SIGKILL');
      await new Promise((done) => child!.once('exit', done));
      assert.equal(f.adapter.status().locked, true);
      assert.equal(existsSync(join(f.options.volumeDirectory, 'data', 'real.sqlite')), false);
      await f.adapter.recover();
      assert.equal(docker('inspect', '--format', '{{.Id}}', f.name), f.oldId);
      assert.equal(await f.gitRead(), refs);
      assert.equal(existsSync(join(f.options.volumeDirectory, 'uploads', 'candidate.txt')), false);
      assert.equal(f.adapter.status().locked, false);
      assert.equal((await f.adapter.recover()).unchanged, true);
    } finally {
      if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      f.cleanup();
    }
  },
);

test(
  'real Docker failed HTTP health rolls back full data and same SSH route without concurrent writers',
  { skip: !enabled, timeout: 180_000 },
  async () => {
    const f = await fixture();
    try {
      const refs = await f.gitRead();
      f.options.build = async () => f.failedImage;
      await assert.rejects(f.adapter.update(), /health verification failed/);
      assert.equal(docker('inspect', '--format', '{{.Id}}', f.name), f.oldId);
      assert.equal(await f.gitRead(), refs);
      assert.equal(existsSync(join(f.options.volumeDirectory, 'uploads', 'candidate.txt')), false);
      assert.equal(f.adapter.status().locked, false);
    } finally {
      f.cleanup();
    }
  },
);

test(
  'real process crash after candidate health recovers old writer, snapshot and public Git route',
  { skip: !enabled, timeout: 180_000 },
  async () => {
    const f = await fixture();
    try {
      const refs = await f.gitRead();
      const driver = join(f.root, 'crash.mjs');
      const serializable = {
        ...f.options,
        build: undefined,
        commit: undefined,
        restoreMetadata: undefined,
      };
      writeFileSync(
        driver,
        `import {LegacyDockerUpdate} from ${JSON.stringify(new URL('./legacy-docker-update.ts', import.meta.url).href)};const adapter=new LegacyDockerUpdate({...${JSON.stringify(serializable)},build:async()=>${JSON.stringify(f.secondImage)},commit:async()=>process.exit(99),restoreMetadata:async()=>{}});await adapter.update();`,
      );
      const child = spawn(process.execPath, [driver], { stdio: 'ignore' });
      const code = await new Promise((done) => child.once('exit', done));
      assert.equal(code, 99);
      assert.equal(f.adapter.status().locked, true);
      assert.equal(f.adapter.status().phase, 'ready');
      await f.adapter.recover();
      assert.equal(docker('inspect', '--format', '{{.Id}}', f.name), f.oldId);
      assert.equal(await f.gitRead(), refs);
      assert.equal(existsSync(join(f.options.volumeDirectory, 'uploads', 'candidate.txt')), false);
      assert.equal(f.adapter.status().locked, false);
    } finally {
      f.cleanup();
    }
  },
);

test(
  'supported CLI to authenticated API to real Docker update and rollback preserves Git/data and controller metadata',
  { skip: !enabled, timeout: 180_000 },
  async () => {
    const f = await fixture();
    let child: ReturnType<typeof spawn> | undefined;
    const controller = join(f.root, 'controller');
    const tag = `${f.name}:api`;
    f.registerTag(tag);
    f.options.recoveryRoot = join(controller, 'legacy-updates', 'groffee');
    writeFileSync(join(f.context, 'server.mjs'), program(2));
    // Use the real release declaration, including required graph configuration
    // and managed data. Code-only admission validates but never activates it.
    writeFileSync(
      join(f.context, 'deploy.yaml'),
      readFileSync(
        '/home/gabrielcsapo/Documents/Codex/2026-10-11/task-2/groffee-release/deploy.yaml',
      ),
    );
    const driver = join(f.root, 'api-driver.mjs');
    const serializable = {
      ...f.options,
      build: undefined,
      commit: undefined,
      restoreMetadata: undefined,
    };
    writeFileSync(
      driver,
      `import{createServer}from'node:http';import{execFileSync}from'node:child_process';import*as store from${JSON.stringify(new URL('./store.ts', import.meta.url).href)};import{apiMiddleware}from${JSON.stringify(new URL('./api.ts', import.meta.url).href)};import{legacyUpdateService}from${JSON.stringify(new URL('./legacy-update-service.ts', import.meta.url).href)};import{LegacyDockerUpdate}from${JSON.stringify(new URL('./legacy-docker-update.ts', import.meta.url).href)};
const login=store.registerUser('fixture-owner','synthetic-fixture-password');store.ensureCoordinatorNode();store.setDefaultNode('coordinator');store.saveDeployment({name:'groffee',username:'fixture-owner',type:'docker',containerName:'deploy-sh-groffee',containerId:${JSON.stringify(f.oldId)},port:${f.options.httpPort},extraPorts:${JSON.stringify(f.options.metadata.extraPorts)},directory:${JSON.stringify(f.context)},activeNodeId:'coordinator',desiredNodeId:'coordinator'});store.updateDeploymentStatus('groffee','running');
const factory=(...args)=>{const admitted=legacyUpdateService(...args);return new LegacyDockerUpdate({...admitted.options,...${JSON.stringify(serializable)},metadata:admitted.options.metadata,sourceDigest:admitted.options.sourceDigest,guard:admitted.options.guard,build:async()=>{if(!args[2])throw new Error('No uploaded build context');execFileSync('docker',['build','--network','none','-q','-t',${JSON.stringify(tag)},args[2]],{env:{...process.env,DOCKER_BUILDKIT:'0'},stdio:['ignore','pipe','pipe']});return execFileSync('docker',['image','inspect','--format','{{.Id}}',${JSON.stringify(tag)}],{encoding:'utf8'}).trim()},commit:admitted.options.commit,restoreMetadata:admitted.options.restoreMetadata});};const handler=apiMiddleware({legacyUpdateService:factory});
const server=createServer((req,res)=>{if(req.url==='/fixture/state'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(store.getDeployment('groffee')));return;}if(req.url==='/fixture/resume'){factory('groffee','fixture-owner').resumeCommitted().then(()=>res.end('ok'),error=>{res.writeHead(500);res.end(error.message)});return;}handler(req,res,()=>{res.writeHead(404);res.end();});});server.on('upgrade',(_req,socket)=>socket.destroy());server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port,token:login.token})));`,
    );
    try {
      const refs = await f.gitRead();
      child = spawn(process.execPath, [driver], {
        cwd: process.cwd(),
        env: { ...process.env, DEPLOY_DATA_DIR: controller },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr!.on('data', (chunk) => (stderr += chunk.toString()));
      const connection = await new Promise<{ port: number; token: string }>((done, fail) => {
        let output = '';
        const timer = setTimeout(
          () => fail(new Error('Real fixture API did not start: ' + stderr)),
          10000,
        );
        child!.stdout!.on('data', (chunk) => {
          output += chunk.toString();
          for (const line of output.split('\n')) {
            try {
              const value = JSON.parse(line);
              if (value.port) {
                clearTimeout(timer);
                done(value);
                return;
              }
            } catch {}
          }
        });
        child!.once('exit', () => {
          clearTimeout(timer);
          fail(new Error('Real fixture API exited: ' + stderr));
        });
      });
      const home = join(f.root, 'cli-home');
      mkdirSync(home);
      writeFileSync(
        join(home, '.deployrc'),
        JSON.stringify({ username: 'fixture-owner', token: connection.token }),
        { mode: 0o600 },
      );
      const url = `http://127.0.0.1:${connection.port}`;
      const cli = (...args: string[]) =>
        asyncExec(
          process.execPath,
          [
            new URL('../bin/deploy.js', import.meta.url).pathname,
            'legacy',
            ...args,
            '-a',
            'groffee',
            '--url',
            url,
          ],
          {
            cwd: f.context,
            env: { ...process.env, HOME: home },
            timeout: 90_000,
            maxBuffer: 2 * 1024 * 1024,
          },
        );
      await cli('update', '--confirm-downtime');
      const status = JSON.parse((await cli('status')).stdout);
      assert.equal(status.phase, 'committed');
      assert.equal(status.imageId, docker('inspect', '--format', '{{.Image}}', f.name));
      assert.ok(status.snapshot.archiveDigest);
      const current = await (await fetch(url + '/fixture/state')).json();
      assert.equal(current.containerId, docker('inspect', '--format', '{{.Id}}', f.name));
      assert.ok(current.sourceArtifactDigest.startsWith('sha256:'));
      assert.equal(current.activeSpecDigest, null);
      assert.equal(await f.gitRead(), refs);
      const id = current.containerId;
      await cli('update', '--confirm-downtime');
      assert.equal(docker('inspect', '--format', '{{.Id}}', f.name), id);
      docker('stop', f.name);
      assert.equal((await fetch(url + '/fixture/resume', { method: 'POST' })).status, 200);
      assert.equal(docker('inspect', '--format', '{{.Id}}', f.name), id);
      await cli('rollback', '--confirm-downtime', '--confirm-data-loss');
      const restored = await (await fetch(url + '/fixture/state')).json();
      assert.equal(restored.containerId, f.oldId);
      assert.equal(restored.sourceArtifactDigest, null);
      assert.equal(restored.activeSpecDigest, null);
      assert.equal(restored.directory, f.context);
      const rollbackStatus = JSON.parse((await cli('status')).stdout);
      assert.equal(rollbackStatus.phase, 'rolled-back');
      assert.equal(rollbackStatus.imageId, f.firstImage);
      assert.equal(await f.gitRead(), refs);
      assert.equal(existsSync(join(f.options.volumeDirectory, 'uploads', 'candidate.txt')), false);
    } finally {
      if (child?.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await new Promise((done) => child!.once('exit', done));
      }
      f.cleanup();
    }
  },
);

test(
  'shared writable ancestors, symlink ancestors and late writers fail closed',
  { skip: !enabled, timeout: 180_000 },
  async () => {
    const f = await fixture();
    const writer = f.name + '-writer';
    const start = (source: string, readonly = false) =>
      docker(
        'run',
        '-d',
        '--name',
        writer,
        '--network',
        'none',
        '--entrypoint',
        'sh',
        '--mount',
        `type=bind,source=${source},target=/workspace${readonly ? ',readonly' : ''}`,
        f.firstImage,
        '-c',
        'sleep 600',
      );
    const remove = () => docker('rm', '-f', writer);
    try {
      const refs = await f.gitRead();
      const alias = join(f.root, 'alias');
      symlinkSync(f.options.volumeDirectory, alias);
      for (const source of [
        f.options.volumeDirectory,
        alias,
        join(f.options.volumeDirectory, 'data', 'repo.git'),
      ]) {
        let built = false;
        f.options.build = async () => {
          built = true;
          return f.secondImage;
        };
        start(source);
        await assert.rejects(
          new LegacyDockerUpdate(f.options).update(),
          /Another running container/,
        );
        assert.equal(built, false);
        assert.equal(docker('inspect', '--format', '{{.Id}}', f.name), f.oldId);
        assert.equal(docker('inspect', '--format', '{{.State.Running}}', writer), 'true');
        assert.equal(await f.gitRead(), refs);
        remove();
      }
      start(f.options.volumeDirectory, true);
      await new LegacyDockerUpdate(f.options).preflight();
      remove();
      f.options.build = async () => {
        start(f.options.volumeDirectory);
        return f.secondImage;
      };
      await assert.rejects(new LegacyDockerUpdate(f.options).update(), /Another running container/);
      assert.equal(docker('inspect', '--format', '{{.Id}}', f.name), f.oldId);
      assert.equal(await f.gitRead(), refs);
      assert.equal(docker('inspect', '--format', '{{.State.Running}}', writer), 'true');
      remove();
      f.options.build = async () => f.secondImage;
      const adapter = new LegacyDockerUpdate(f.options);
      await adapter.update();
      start(f.options.volumeDirectory);
      await assert.rejects(adapter.recover(true), /lock retained/);
      assert.equal(adapter.status().locked, true);
      assert.equal(docker('inspect', '--format', '{{.State.Running}}', writer), 'true');
      assert.equal(existsSync(join(f.options.volumeDirectory, 'uploads', 'candidate.txt')), true);
      remove();
      await adapter.recover();
      assert.equal(adapter.status().locked, false);
      assert.equal(docker('inspect', '--format', '{{.Id}}', f.name), f.oldId);
      assert.equal(existsSync(join(f.options.volumeDirectory, 'uploads', 'candidate.txt')), false);
      assert.equal(await f.gitRead(), refs);
    } finally {
      f.cleanup();
    }
  },
);

test(
  'real Docker data-host-key layout preserves active identity, private mode, Git and cold rollback',
  { skip: !enabled, timeout: 180_000 },
  async () => {
    const f = await fixture('data');
    try {
      const originalOwnership = statSync(join(f.options.volumeDirectory, 'data', 'real.sqlite'));
      const key = join(f.options.volumeDirectory, 'data', 'ssh_host_ed25519_key');
      const originalKey = readFileSync(key);
      const originalKeyOwnership = statSync(key);
      assert.equal(
        existsSync(join(f.options.volumeDirectory, '.ssh-host-keys', 'ssh_host_ed25519_key')),
        false,
      );
      const refs = await f.gitRead();
      assert.ok(refs.includes('refs/heads/main'));
      const result = await f.adapter.update();
      assert.equal(result.unchanged, false);
      assert.equal(docker('inspect', '--format', '{{.Image}}', f.name), f.secondImage);
      assert.equal(await f.gitRead(), refs);
      assert.equal((await f.adapter.update()).unchanged, true);
      const current = readFileSync(
        join(f.options.volumeDirectory, 'uploads', 'candidate.txt'),
        'utf8',
      );
      assert.equal(current, 'new upload');
      await f.adapter.recover(true);
      assert.equal(docker('inspect', '--format', '{{.Id}}', f.name), f.oldId);
      assert.equal(docker('inspect', '--format', '{{.Image}}', f.name), f.firstImage);
      assert.equal(await f.gitRead(), refs);
      assert.equal(existsSync(join(f.options.volumeDirectory, 'uploads', 'candidate.txt')), false);
      const restoredOwnership = statSync(join(f.options.volumeDirectory, 'data', 'real.sqlite'));
      assert.deepEqual(
        [restoredOwnership.uid, restoredOwnership.gid, restoredOwnership.mode],
        [originalOwnership.uid, originalOwnership.gid, originalOwnership.mode],
      );
      assert.deepEqual(readFileSync(key), originalKey);
      const restoredKeyOwnership = statSync(key);
      assert.deepEqual(
        [restoredKeyOwnership.uid, restoredKeyOwnership.gid, restoredKeyOwnership.mode],
        [originalKeyOwnership.uid, originalKeyOwnership.gid, originalKeyOwnership.mode],
      );
      assert.equal((await f.adapter.recover(true)).unchanged, true);
      assert.equal(f.adapter.status().locked, false);
    } finally {
      f.cleanup();
    }
  },
);

test(
  'real Docker data-host-key failed activation restores full data and public SSH identity',
  { skip: !enabled, timeout: 180_000 },
  async () => {
    const f = await fixture('data');
    try {
      const refs = await f.gitRead();
      f.options.build = async () => f.failedImage;
      await assert.rejects(f.adapter.update(), /health verification failed/);
      assert.equal(docker('inspect', '--format', '{{.Id}}', f.name), f.oldId);
      assert.equal(await f.gitRead(), refs);
      assert.equal(existsSync(join(f.options.volumeDirectory, 'uploads', 'candidate.txt')), false);
      assert.equal(f.adapter.status().locked, false);
    } finally {
      f.cleanup();
    }
  },
);

test(
  'real Docker data-host-key admission rejects missing persisted key and active identity drift before stopping writer',
  { skip: !enabled, timeout: 180_000 },
  async () => {
    const f = await fixture('data');
    const key = join(f.options.volumeDirectory, 'data', 'ssh_host_ed25519_key');
    try {
      const original = readFileSync(key);
      const refs = await f.gitRead();
      const replacement = join(f.root, 'replacement-key');
      execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', replacement]);
      rmSync(key);
      await assert.rejects(f.adapter.update(), /Existing SSH host identity required/);
      assert.equal(
        docker('inspect', '--format', '{{.Id}} {{.State.Running}}', f.name),
        f.oldId + ' true',
      );
      assert.equal(f.commits.length, 0);
      writeFileSync(key, original, { mode: 0o600 });
      copyFileSync(replacement, key);
      await assert.rejects(f.adapter.update(), /Legacy HTTP\/SSH health verification failed/);
      assert.equal(
        docker('inspect', '--format', '{{.Id}} {{.State.Running}}', f.name),
        f.oldId + ' true',
      );
      assert.equal(f.commits.length, 0);
      assert.equal(f.adapter.status().locked, false);
      writeFileSync(key, original, { mode: 0o600 });
      await f.adapter.preflight();
      assert.equal(await f.gitRead(), refs);
    } finally {
      f.cleanup();
    }
  },
);
