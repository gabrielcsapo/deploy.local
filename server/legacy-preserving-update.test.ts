import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  rmSync,
  existsSync,
  symlinkSync,
  chmodSync,
  copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { legacyHostIdentityDigest, restoreStoppedLegacyData } from './legacy-snapshot.mjs';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import {
  assertLegacyUpdateEligible,
  assertNoImplicitLegacyGraphAdoption,
  runLegacyPreservingUpdate,
  snapshotStoppedLegacyData,
  verifyLegacySnapshot,
  type LegacyUpdateOperations,
} from './legacy-preserving-update.ts';

test('Groffee graph upload fails before implicit legacy adoption; existing graphs and other applications are unaffected', () => {
  assert.throws(
    () =>
      assertNoImplicitLegacyGraphAdoption({
        name: 'groffee',
        containerName: 'deploy-sh-groffee',
        activeSpecDigest: null,
      }),
    { status: 409 },
  );
  assert.doesNotThrow(() =>
    assertNoImplicitLegacyGraphAdoption({
      name: 'groffee',
      containerName: 'deploy-sh-groffee',
      activeSpecDigest: 'graph',
    }),
  );
  assert.doesNotThrow(() =>
    assertNoImplicitLegacyGraphAdoption({
      name: 'other',
      containerName: 'deploy-sh-other',
      activeSpecDigest: null,
    }),
  );
});

test('real SQLite schema/data rollback passes integrity check after failed upgrade', async () => {
  const f = fixture();
  const databasePath = join(f.input.volumeDirectory, 'data', 'real.sqlite');
  try {
    const original = new DatabaseSync(databasePath);
    original.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE projects(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO projects VALUES(1, 'original');",
    );
    original.close();
    f.input.operations.verifyCandidate = async () => {
      const candidate = new DatabaseSync(databasePath);
      candidate.exec(
        "ALTER TABLE projects ADD COLUMN collaborator TEXT; UPDATE projects SET name='upgraded';",
      );
      candidate.close();
      throw new Error('failed upgrade');
    };
    await assert.rejects(runLegacyPreservingUpdate(f.input), /failed upgrade/);
    const restored = new DatabaseSync(databasePath);
    try {
      assert.equal(restored.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
      assert.equal(restored.prepare('SELECT name FROM projects').get()?.name, 'original');
      assert.throws(() => restored.prepare('SELECT collaborator FROM projects'));
    } finally {
      restored.close();
    }
  } finally {
    f.cleanup();
  }
});

test('ambiguous old-writer stop retains lock without starting any writer', async () => {
  const f = fixture();
  try {
    f.input.operations.stopPrevious = async () => {
      throw new Error('lost stop response');
    };
    await assert.rejects(runLegacyPreservingUpdate(f.input), /stop unconfirmed/);
    assert.equal(f.calls.includes('start-old'), false);
    assert.equal(f.calls.includes('start-new'), false);
    assert.ok(existsSync(join(f.input.recoveryRoot, 'legacy-update.lock')));
  } finally {
    f.cleanup();
  }
});

test('failed candidate that emptied data and SSH identity can still restore verified snapshot', async () => {
  const f = fixture();
  try {
    f.input.operations.verifyCandidate = async () => {
      rmSync(join(f.input.volumeDirectory, 'data', 'database.sqlite'));
      rmSync(join(f.input.volumeDirectory, 'data', 'database.sqlite-wal'));
      rmSync(join(f.input.volumeDirectory, '.ssh-host-keys', 'ssh_host_ed25519_key'));
      throw new Error('candidate removed data');
    };
    await assert.rejects(runLegacyPreservingUpdate(f.input), /candidate removed data/);
    assert.equal(
      readFileSync(join(f.input.volumeDirectory, 'data', 'database.sqlite'), 'utf8'),
      'synthetic database',
    );
    assert.equal(
      readFileSync(join(f.input.volumeDirectory, '.ssh-host-keys', 'ssh_host_ed25519_key'), 'utf8'),
      'synthetic host identity',
    );
  } finally {
    f.cleanup();
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'legacy-compat-test-'));
  const volumeDirectory = join(root, 'volumes');
  for (const path of ['data', 'uploads', '.ssh-host-keys'])
    mkdirSync(join(volumeDirectory, path), { recursive: true });
  writeFileSync(join(volumeDirectory, 'data', 'database.sqlite'), 'synthetic database');
  writeFileSync(join(volumeDirectory, 'data', 'database.sqlite-wal'), 'synthetic WAL');
  writeFileSync(join(volumeDirectory, 'uploads', 'upload'), 'synthetic upload');
  writeFileSync(
    join(volumeDirectory, '.ssh-host-keys', 'ssh_host_ed25519_key'),
    'synthetic host identity',
    { mode: 0o600 },
  );
  const runtime = {
    imageId: `sha256:${'a'.repeat(64)}`,
    containerId: 'synthetic-old',
    mounts: [
      ['data', '/app/data'],
      ['uploads', '/app/uploads'],
      ['.ssh-host-keys', '/etc/ssh'],
    ].map(([source, destination]) => ({
      source: join(volumeDirectory, source),
      destination,
      readOnly: false,
    })),
    ports: { '2223/tcp': [{ hostIp: '0.0.0.0', hostPort: '43210' }] },
    environment: ['EXTERNAL_URL=https://groffee.local'],
    settingsDigest: 'synthetic-settings',
  };
  const calls: string[] = [];
  let oldRunning = true;
  let newRunning = false;
  const operations: LegacyUpdateOperations = {
    async inspect() {
      calls.push('inspect');
      return structuredClone(runtime);
    },
    async build() {
      calls.push('build');
      assert.ok(oldRunning);
      return `sha256:${'b'.repeat(64)}`;
    },
    async stopPrevious() {
      calls.push('stop-old');
      oldRunning = false;
    },
    async startCandidate(_image, previous) {
      calls.push('start-new');
      assert.equal(oldRunning, false);
      assert.deepEqual(previous, runtime);
      newRunning = true;
    },
    async stopCandidate() {
      calls.push('stop-new');
      newRunning = false;
    },
    async verifyCandidate() {
      calls.push('verify-new');
      assert.ok(newRunning);
    },
    async commit() {
      calls.push('commit');
    },
    async startPrevious() {
      calls.push('start-old');
      assert.equal(newRunning, false);
      oldRunning = true;
    },
    async verifyPrevious() {
      calls.push('verify-old');
      assert.ok(oldRunning);
    },
  };
  return {
    root,
    calls,
    runtime,
    input: {
      administrator: true,
      owner: true,
      activeGraphDigest: null,
      nodeId: 'coordinator',
      volumeDirectory,
      recoveryRoot: join(root, 'recovery'),
      operations,
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('cold snapshot verifies every durable path and numeric permissions', async () => {
  const f = fixture();
  try {
    const snapshot = await runLegacyPreservingUpdate(f.input);
    verifyLegacySnapshot(snapshot);
    assert.deepEqual(f.calls, [
      'inspect',
      'build',
      'inspect',
      'stop-old',
      'start-new',
      'verify-new',
      'commit',
    ]);
    assert.equal(statSync(join(snapshot.directory, 'transaction.json')).mode & 0o777, 0o600);
    assert.ok(existsSync(join(snapshot.directory, 'data.tar')));
    assert.equal(existsSync(join(f.input.recoveryRoot, 'legacy-update.lock')), false);
  } finally {
    f.cleanup();
  }
});

for (const phase of ['startCandidate', 'verifyCandidate', 'commit'] as const) {
  test(`failure in ${phase} restores database, WAL, upload and SSH identity before old writer starts`, async () => {
    const f = fixture();
    try {
      f.input.operations[phase] = async () => {
        writeFileSync(join(f.input.volumeDirectory, 'data', 'database.sqlite'), 'new schema');
        writeFileSync(join(f.input.volumeDirectory, 'uploads', 'new-upload'), 'new');
        writeFileSync(
          join(f.input.volumeDirectory, '.ssh-host-keys', 'ssh_host_ed25519_key'),
          'changed',
        );
        throw new Error('synthetic failure');
      };
      await assert.rejects(runLegacyPreservingUpdate(f.input), /synthetic failure/);
      assert.equal(
        readFileSync(join(f.input.volumeDirectory, 'data', 'database.sqlite'), 'utf8'),
        'synthetic database',
      );
      assert.equal(
        readFileSync(join(f.input.volumeDirectory, 'data', 'database.sqlite-wal'), 'utf8'),
        'synthetic WAL',
      );
      assert.equal(
        readFileSync(join(f.input.volumeDirectory, 'uploads', 'upload'), 'utf8'),
        'synthetic upload',
      );
      assert.equal(existsSync(join(f.input.volumeDirectory, 'uploads', 'new-upload')), false);
      assert.equal(
        readFileSync(
          join(f.input.volumeDirectory, '.ssh-host-keys', 'ssh_host_ed25519_key'),
          'utf8',
        ),
        'synthetic host identity',
      );
      assert.equal(
        statSync(join(f.input.volumeDirectory, '.ssh-host-keys', 'ssh_host_ed25519_key')).mode &
          0o777,
        0o600,
      );
      assert.ok(f.calls.indexOf('stop-new') < f.calls.indexOf('start-old'));
      assert.ok(f.calls.includes('verify-old'));
    } finally {
      f.cleanup();
    }
  });
}

test('absent or empty data fails before build and is never manufactured', async () => {
  for (const missing of ['data', 'uploads', '.ssh-host-keys', 'data/database.sqlite']) {
    const f = fixture();
    try {
      rmSync(join(f.input.volumeDirectory, missing), { recursive: true });
      if (missing.includes('/'))
        rmSync(join(f.input.volumeDirectory, 'data', 'database.sqlite-wal'));
      await assert.rejects(runLegacyPreservingUpdate(f.input), /Missing|empty/);
      assert.equal(f.calls.includes('build'), false);
      assert.equal(existsSync(join(f.input.volumeDirectory, missing)), false);
    } finally {
      f.cleanup();
    }
  }
});

test('permission boundaries, graph, node movement, changed topology and SSH routing fail closed', () => {
  const f = fixture();
  try {
    const input = { ...f.input, runtime: f.runtime };
    for (const change of [
      { owner: false },
      { administrator: false },
      { activeGraphDigest: 'graph' },
      { nodeId: 'remote' },
      { runtime: { ...f.runtime, ports: {} } },
      { runtime: { ...f.runtime, mounts: [] } },
      { runtime: { ...f.runtime, imageId: 'latest' } },
    ])
      assert.throws(() => assertLegacyUpdateEligible({ ...input, ...change }));
    rmSync(join(f.input.volumeDirectory, 'uploads'), { recursive: true });
    symlinkSync('/tmp', join(f.input.volumeDirectory, 'uploads'));
    assert.throws(
      () => snapshotStoppedLegacyData(f.input.volumeDirectory, f.input.recoveryRoot),
      /Missing existing durable directory/,
    );
  } finally {
    f.cleanup();
  }
});

test('same-app concurrent call is rejected; sequential retry is allowed', async () => {
  const f = fixture();
  try {
    const build = f.input.operations.build;
    f.input.operations.build = async () => {
      await assert.rejects(runLegacyPreservingUpdate(f.input), { code: 'EEXIST' });
      throw new Error('synthetic build failure');
    };
    await assert.rejects(runLegacyPreservingUpdate(f.input), /synthetic build failure/);
    f.input.operations.build = build;
    await runLegacyPreservingUpdate(f.input);
  } finally {
    f.cleanup();
  }
});

test('runtime drift during build never stops old writer', async () => {
  const f = fixture();
  try {
    const build = f.input.operations.build;
    f.input.operations.build = async () => {
      const image = await build();
      f.runtime.settingsDigest = 'changed';
      return image;
    };
    await assert.rejects(runLegacyPreservingUpdate(f.input), /changed during build/);
    assert.equal(f.calls.includes('stop-old'), false);
  } finally {
    f.cleanup();
  }
});

test('corrupt snapshot fails verification before data removal', () => {
  const f = fixture();
  try {
    const snapshot = snapshotStoppedLegacyData(f.input.volumeDirectory, f.input.recoveryRoot);
    writeFileSync(join(snapshot.directory, 'data.tar'), 'corrupt');
    assert.throws(() => verifyLegacySnapshot(snapshot), /digest mismatch/);
    assert.equal(
      readFileSync(join(f.input.volumeDirectory, 'data', 'database.sqlite'), 'utf8'),
      'synthetic database',
    );
  } finally {
    f.cleanup();
  }
});

test('unconfirmed candidate stop retains recovery lock and does not restart old writer', async () => {
  const f = fixture();
  try {
    f.input.operations.verifyCandidate = async () => {
      throw new Error('health failure');
    };
    f.input.operations.stopCandidate = async () => {
      throw new Error('cannot stop');
    };
    await assert.rejects(runLegacyPreservingUpdate(f.input), /rollback incomplete/);
    assert.equal(f.calls.includes('start-old'), false);
    assert.ok(existsSync(join(f.input.recoveryRoot, 'legacy-update.lock')));
    await assert.rejects(runLegacyPreservingUpdate(f.input), { code: 'EEXIST' });
  } finally {
    f.cleanup();
  }
});

test('rollback durably flushes files and directories before the old writer is started', async () => {
  const f = fixture();
  const original = fs.fsyncSync;
  const originalOpen = fs.openSync;
  // Remember what each descriptor opened (portable, unlike reading /proc/self/fd).
  const opened = new Map<number, string>();
  fs.openSync = ((path: fs.PathLike, flags: fs.OpenMode = 'r', mode?: fs.Mode | null) => {
    const fd = originalOpen(path, flags, mode);
    opened.set(fd, resolve(String(path)));
    return fd;
  }) as typeof fs.openSync;
  const flushed = new Set<string>();
  fs.fsyncSync = (fd) => {
    flushed.add(opened.get(fd) ?? `fd ${fd}`);
    original(fd);
  };
  syncBuiltinESMExports();
  try {
    f.input.operations.verifyCandidate = async () => {
      flushed.clear();
      throw new Error('synthetic activation failure');
    };
    const start = f.input.operations.startPrevious;
    f.input.operations.startPrevious = async (previous) => {
      for (const relative of [
        'data/database.sqlite',
        'data/database.sqlite-wal',
        'uploads/upload',
        '.ssh-host-keys/ssh_host_ed25519_key',
        'data',
        'uploads',
        '.ssh-host-keys',
        '',
      ])
        assert.ok(
          flushed.has(join(f.input.volumeDirectory, relative)),
          `Not flushed before writer start: ${relative}`,
        );
      await start(previous);
    };
    await assert.rejects(runLegacyPreservingUpdate(f.input), /synthetic activation failure/);
  } finally {
    fs.fsyncSync = original;
    fs.openSync = originalOpen;
    syncBuiltinESMExports();
    f.cleanup();
  }
});

test('snapshot preserves in-root repository symlinks and rejects outside targets', () => {
  const f = fixture();
  try {
    symlinkSync('../uploads/upload', join(f.input.volumeDirectory, 'data', 'upload-link'));
    const snapshot = snapshotStoppedLegacyData(f.input.volumeDirectory, f.input.recoveryRoot);
    verifyLegacySnapshot(snapshot);
    symlinkSync(
      '/not-a-real-fixture-target',
      join(f.input.volumeDirectory, 'data', 'outside-link'),
    );
    assert.throws(
      () => snapshotStoppedLegacyData(f.input.volumeDirectory, f.input.recoveryRoot),
      /escaping durable symlink/,
    );
    rmSync(join(f.input.volumeDirectory, 'data', 'outside-link'));
    symlinkSync('../data', join(f.input.volumeDirectory, 'uploads', 'chain-link'));
    symlinkSync(
      '../uploads/chain-link/../../data',
      join(f.input.volumeDirectory, 'data', 'chain-escape'),
    );
    assert.throws(
      () => snapshotStoppedLegacyData(f.input.volumeDirectory, f.input.recoveryRoot),
      /escaping durable symlink/,
    );
    rmSync(join(f.input.volumeDirectory, 'data', 'chain-escape'));
    symlinkSync('../../outside', join(f.input.volumeDirectory, 'uploads', 'escape-link'));
    assert.throws(
      () => snapshotStoppedLegacyData(f.input.volumeDirectory, f.input.recoveryRoot),
      /escaping durable symlink/,
    );
  } finally {
    f.cleanup();
  }
});

test('data-host-key layout is fully snapshotted/restored with private ownership and identity digest', () => {
  const f = fixture();
  const key = join(f.input.volumeDirectory, 'data', 'ssh_host_ed25519_key');
  try {
    rmSync(join(f.input.volumeDirectory, '.ssh-host-keys', 'ssh_host_ed25519_key'));
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
    writeFileSync(
      join(f.input.volumeDirectory, '.ssh-host-keys', 'ssh_config'),
      'synthetic preserved config',
    );
    const identity = legacyHostIdentityDigest(f.input.volumeDirectory);
    const original = readFileSync(key);
    const metadata = statSync(key);
    const snapshot = snapshotStoppedLegacyData(f.input.volumeDirectory, f.input.recoveryRoot);
    verifyLegacySnapshot(snapshot);
    writeFileSync(key, 'changed synthetic key');
    writeFileSync(join(f.input.volumeDirectory, 'uploads', 'upload'), 'changed upload');
    restoreStoppedLegacyData(f.input.volumeDirectory, snapshot);
    assert.deepEqual(readFileSync(key), original);
    assert.equal(legacyHostIdentityDigest(f.input.volumeDirectory), identity);
    const restored = statSync(key);
    assert.deepEqual(
      [restored.uid, restored.gid, restored.mode],
      [metadata.uid, metadata.gid, metadata.mode],
    );
    assert.equal(
      readFileSync(join(f.input.volumeDirectory, 'uploads', 'upload'), 'utf8'),
      'synthetic upload',
    );
  } finally {
    f.cleanup();
  }
});

test('recognized host keys reject absent, empty, symlink, directory, insecure and malformed data layout', () => {
  const f = fixture();
  const key = join(f.input.volumeDirectory, 'data', 'ssh_host_ed25519_key');
  const separate = join(f.input.volumeDirectory, '.ssh-host-keys', 'ssh_host_ed25519_key');
  try {
    rmSync(separate);
    assert.throws(
      () => snapshotStoppedLegacyData(f.input.volumeDirectory, f.input.recoveryRoot),
      /Existing SSH host identity required/,
    );
    writeFileSync(key, '', { mode: 0o600 });
    assert.throws(
      () => snapshotStoppedLegacyData(f.input.volumeDirectory, f.input.recoveryRoot),
      /nonempty private regular file/,
    );
    rmSync(key);
    mkdirSync(key);
    assert.throws(
      () => snapshotStoppedLegacyData(f.input.volumeDirectory, f.input.recoveryRoot),
      /nonempty private regular file/,
    );
    rmSync(key, { recursive: true });
    symlinkSync('../database.sqlite', key);
    assert.throws(
      () => snapshotStoppedLegacyData(f.input.volumeDirectory, f.input.recoveryRoot),
      /nonempty private regular file/,
    );
    rmSync(key);
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
    chmodSync(key, 0o644);
    assert.throws(
      () => snapshotStoppedLegacyData(f.input.volumeDirectory, f.input.recoveryRoot),
      /nonempty private regular file/,
    );
    chmodSync(key, 0o600);
    copyFileSync(key, separate);
    chmodSync(separate, 0o644);
    assert.throws(
      () => legacyHostIdentityDigest(f.input.volumeDirectory),
      /nonempty private regular file/,
    );
    chmodSync(separate, 0o600);
    writeFileSync(separate, 'synthetic malformed key, never expose this content');
    assert.throws(
      () => legacyHostIdentityDigest(f.input.volumeDirectory),
      (error: Error) => error.message === 'Existing SSH host identity derivation failed',
    );
    rmSync(separate);
    writeFileSync(key, 'synthetic malformed data key');
    assert.throws(
      () => legacyHostIdentityDigest(f.input.volumeDirectory),
      (error: Error) => error.message === 'Existing SSH host identity derivation failed',
    );
  } finally {
    f.cleanup();
  }
});
