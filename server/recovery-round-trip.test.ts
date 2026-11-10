// The whole backup promise, from a running data directory to a replacement one: everything is real
// (workspace store, recovery worker, restore), and the replacement is read by a separate process
// the way a restarted server would read it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const passphrase = 'round trip passphrase';
const owner = 'admin';
const providerAddress = 'deploy.local/test/provider-connection';
const projectAddress = ['admin', 'project-1', 'app', 'API_TOKEN'] as const;

let root: string;
let home: string;
let store: typeof import('./store.ts');
let recovery: typeof import('./recovery-bundle.ts');
let localSite: typeof import('./local-site.ts');
let secrets: typeof import('./secrets.ts');
let certs: typeof import('./certs.ts');

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'deploy-recovery-round-trip-'));
  home = join(root, 'home');
  process.env.DEPLOY_DATA_DIR = home;
  delete process.env.DEPLOY_SECRET_KEY;
  store = await import('./store.ts');
  recovery = await import('./recovery-bundle.ts');
  localSite = await import('./local-site.ts');
  secrets = await import('./secrets.ts');
  certs = await import('./certs.ts');
  localSite.ensureLocalIdentity('Round trip fleet');
  certs.ensureCerts();
  secrets.loadOrCreateSecretKey();
});

after(() => {
  store._resetDb();
  delete process.env.DEPLOY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

/** Rewrites a bundle in the shape older releases made: same format, one file fewer. */
function withoutFile(bundlePath: string, path: string) {
  const aad = Buffer.from('deploy.local/home-recovery/v1');
  const envelope = JSON.parse(readFileSync(bundlePath, 'utf8'));
  const { N, r, p } = envelope.kdf;
  const key = scryptSync(passphrase, Buffer.from(envelope.kdf.salt, 'base64url'), 32, {
    N,
    r,
    p,
    maxmem: 64 * 1024 * 1024,
  });
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(envelope.encryption.nonce, 'base64url'),
  );
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(envelope.encryption.tag, 'base64url'));
  const payload = JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
      decipher.final(),
    ]).toString(),
  );
  const count = payload.files.length;
  payload.files = payload.files.filter((file: { path: string }) => file.path !== path);
  assert.equal(payload.files.length, count - 1, `The bundle should have held ${path}`);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
  envelope.encryption.nonce = nonce.toString('base64url');
  envelope.encryption.tag = cipher.getAuthTag().toString('base64url');
  envelope.ciphertext = ciphertext.toString('base64url');
  writeFileSync(bundlePath, JSON.stringify(envelope));
}

describe('Home recovery round trip', () => {
  it('restores a bundle made before workspace.db was included, and says what is missing', async (t) => {
    const bundlePath = join(root, 'older.bundle');
    await recovery.createRecoveryBundle({ outputPath: bundlePath, passphrase });
    withoutFile(bundlePath, 'workspace/workspace.db');
    assert.ok(recovery.verifyRecoveryBundle({ bundlePath, passphrase }));
    const warn = t.mock.method(console, 'warn', () => {});
    const replacement = join(root, 'older-replacement');
    recovery.restoreRecoveryBundle({
      bundlePath,
      passphrase,
      destinationDataDirectory: replacement,
    });
    assert.equal(existsSync(join(replacement, 'workspace', 'workspace.db')), false);
    assert.match(String(warn.mock.calls[0]?.arguments[0]), /no workspace\/workspace\.db.*tasks/);
  });

  it('refuses with a clear error when the databases and keys are too big for a bundle', async () => {
    const large = join(home, 'identities', 'large-sparse');
    writeFileSync(large, '');
    truncateSync(large, 128 * 1024 * 1024 + 1);
    const outputPath = join(root, 'too-big.bundle');
    try {
      await assert.rejects(
        recovery.createRecoveryBundle({ outputPath, passphrase }),
        /Recovery bundle not created: .* over the 128 MB .* identities\/large-sparse 129 MB/,
      );
    } finally {
      rmSync(large);
    }
    assert.equal(existsSync(outputPath), false);
  });

  it('refuses live databases too big for a bundle before copying any of them', async () => {
    const requests = join(home, 'requests.db');
    const size = statSync(requests).size;
    truncateSync(requests, 2 * 1024 * 1024 * 1024);
    const outputPath = join(root, 'too-big-live.bundle');
    const started = Date.now();
    try {
      await assert.rejects(
        recovery.createRecoveryBundle({ outputPath, passphrase }),
        /Recovery bundle not created: .* over the 128 MB .* requests\.db 2048 MB/,
      );
    } finally {
      truncateSync(requests, size);
    }
    assert.ok(Date.now() - started < 1000, 'Nothing was copied first');
    assert.equal(existsSync(outputPath), false);
  });

  it('carries workspace.db through a bundle made while it has uncommitted WAL pages', async () => {
    const workspace = await import('./workspace/store.ts');
    const key = secrets.loadOrCreateSecretKey();

    // Checkpointed rows, then committed rows that stay in the WAL.
    workspace.save('task', owner, { id: 'task-checkpointed', title: 'In the main file' });
    workspace.db.pragma('wal_checkpoint(TRUNCATE)');
    workspace.db.pragma('wal_autocheckpoint = 0');
    workspace.save('task', owner, { id: 'task-in-wal', title: 'Only in the WAL' });
    workspace.save('run', owner, { id: 'run-in-wal', taskId: 'task-in-wal', status: 'succeeded' });
    workspace.event(owner, 'task-in-wal', 'run-in-wal', 'chat.message', { text: 'Hello' });
    workspace.save('provider-connection', owner, {
      id: 'provider-1',
      secret: secrets.encryptSecret('provider api key', key, providerAddress),
    });

    // Proof the fixture is what it claims: without the WAL, the main file has none of that.
    const workspaceFile = join(home, 'workspace', 'workspace.db');
    const mainFileOnly = join(root, 'main-file-only.db');
    copyFileSync(workspaceFile, mainFileOnly);
    const fileCopy = new Database(mainFileOnly, { readonly: true });
    assert.deepEqual(
      fileCopy.prepare('SELECT id FROM records').all(),
      [{ id: 'task-checkpointed' }],
      'A file copy of workspace.db would lose everything still in the WAL',
    );
    fileCopy.close();

    // A deploy.db secret, so restored secrets are checked in both databases.
    store
      .getSqlite()!
      .prepare(
        `INSERT INTO project_configuration
          (owner, project_id, app, key, value_type, value, updated_at, updated_by)
         VALUES (?, ?, ?, ?, 'secret', ?, ?, ?)`,
      )
      .run(
        ...projectAddress,
        secrets.encryptSecret(
          'project token',
          key,
          secrets.projectSecretAddress(...projectAddress),
        ),
        new Date().toISOString(),
        owner,
      );

    // The other small irreplaceable files.
    const { sshHostKey } = await import('./workspace/ssh-host.ts');
    const hostKey = sshHostKey().privateKey;
    const journal = secrets.encryptSecret('{"phase":"staging"}', key, 'release:r1');
    mkdirSync(join(home, 'project-releases', 'journals'), { recursive: true });
    writeFileSync(join(home, 'project-releases', 'journals', 'r1.json'), journal);
    writeFileSync(join(home, 'project-releases', 'journals', 'r2.json.tmp'), 'half written');

    // A transaction left open across the bundle, big enough to spill into the WAL uncommitted.
    const writer = new Database(workspaceFile);
    const walFile = `${workspaceFile}-wal`;
    const committedWal = statSync(walFile).size;
    writer.pragma('cache_size = 5');
    writer.exec('BEGIN IMMEDIATE');
    const insert = writer.prepare(`INSERT INTO records VALUES ('task', ?, ?, ?)`);
    for (let index = 0; index < 100; index += 1)
      insert.run(`task-uncommitted-${index}`, owner, JSON.stringify({ text: 'x'.repeat(16_384) }));
    assert.ok(
      statSync(walFile).size > committedWal + 512 * 1024,
      'The open transaction must have uncommitted pages in the WAL',
    );

    const bundlePath = join(root, 'home.bundle');
    let created;
    try {
      created = await recovery.createRecoveryBundle({ outputPath: bundlePath, passphrase });
    } finally {
      writer.exec('ROLLBACK');
      writer.close();
    }

    assert.ok(recovery.verifyRecoveryBundle({ bundlePath, passphrase, bundleId: created.id }));
    assert.equal(
      recovery.rehearseRecoveryBundle({ bundleId: created.id, bundlePath, passphrase }).passed,
      true,
    );

    const replacement = join(root, 'replacement');
    mkdirSync(replacement);
    recovery.restoreRecoveryBundle({
      bundlePath,
      passphrase,
      destinationDataDirectory: replacement,
    });

    const restoredFile = join(replacement, 'workspace', 'workspace.db');
    assert.equal(statSync(restoredFile).mode & 0o777, 0o600);
    assert.equal(existsSync(`${restoredFile}-wal`), false, 'The restored file stands alone');
    assert.deepEqual(readFileSync(join(replacement, 'ssh_host_ed25519_key')), hostKey);
    assert.equal(
      readFileSync(join(replacement, 'project-releases', 'journals', 'r1.json'), 'utf8'),
      journal,
    );
    assert.equal(
      existsSync(join(replacement, 'project-releases', 'journals', 'r2.json.tmp')),
      false,
    );

    // Read back through the real modules in their own process, as a restarted server would.
    const module = (path: string) => pathToFileURL(join(import.meta.dirname, path)).href;
    const reader = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `const workspace = await import(${JSON.stringify(module('workspace/store.ts'))});
         const secrets = await import(${JSON.stringify(module('secrets.ts'))});
         const { getSqlite } = await import(${JSON.stringify(module('store.ts'))});
         const key = secrets.loadOrCreateSecretKey();
         const provider = workspace.get('provider-connection', ${JSON.stringify(owner)}, 'provider-1');
         const project = getSqlite()
           .prepare("SELECT value FROM project_configuration WHERE key = 'API_TOKEN'")
           .get();
         console.log(JSON.stringify({
           tasks: workspace.list('task', ${JSON.stringify(owner)}).map((task) => task.id),
           runs: workspace.list('run', ${JSON.stringify(owner)}).map((run) => run.id),
           chat: workspace.events(${JSON.stringify(owner)}).map((event) => event.payload.text),
           providerKey: secrets.decryptSecret(provider.secret, key, ${JSON.stringify(providerAddress)}),
           projectToken: secrets.decryptSecret(
             project.value,
             key,
             secrets.projectSecretAddress(...${JSON.stringify(projectAddress)}),
           ),
         }));`,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, DEPLOY_DATA_DIR: replacement },
      },
    );
    assert.equal(reader.status, 0, reader.stderr);
    assert.deepEqual(JSON.parse(reader.stdout.trim().split('\n').at(-1)!), {
      tasks: ['task-checkpointed', 'task-in-wal'],
      runs: ['run-in-wal'],
      chat: ['Hello'],
      providerKey: 'provider api key',
      projectToken: 'project token',
    });

    // The same directory, partly lost: the failure is loud, and no key replaces the original.
    const restoredKey = join(replacement, 'secrets', 'master.key');
    rmSync(restoredKey);
    assert.throws(() => secrets.loadOrCreateSecretKey(replacement), {
      code: 'DEPLOY_SECRET_KEY_MISSING',
    });
    assert.equal(existsSync(restoredKey), false);
  });
});
