import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { decryptSecret, encryptSecret, loadOrCreateSecretKey, secretAddress } from './secrets.ts';

const directories: string[] = [];

afterEach(() => {
  delete process.env.DEPLOY_SECRET_KEY;
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('application secret envelopes', () => {
  it('round-trips without embedding plaintext', () => {
    const key = randomBytes(32);
    const address = secretAddress('notes', 'adminPassword');
    const envelope = encryptSecret('correct horse battery staple', key, address);

    assert.equal(envelope.includes('correct horse'), false);
    assert.equal(decryptSecret(envelope, key, address), 'correct horse battery staple');
  });

  it('binds ciphertext to one configuration address', () => {
    const key = randomBytes(32);
    const envelope = encryptSecret('password', key, secretAddress('notes', 'adminPassword'));

    assert.throws(
      () => decryptSecret(envelope, key, secretAddress('other-app', 'adminPassword')),
      /authenticate|Unsupported state/i,
    );
  });

  it('creates and reuses an owner-only key file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'deploy-secret-key-'));
    directories.push(directory);

    const first = loadOrCreateSecretKey(directory);
    const second = loadOrCreateSecretKey(directory);
    const path = join(directory, 'secrets', 'master.key');

    assert.equal(first.length, 32);
    assert.deepEqual(second, first);
    assert.deepEqual(readFileSync(path), first);
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
  });
});

describe('a missing master.key', () => {
  const dataDirectory = () => {
    const directory = mkdtempSync(join(tmpdir(), 'deploy-secret-key-'));
    directories.push(directory);
    return directory;
  };
  const database = (directory: string, file: string, ...statements: string[]) => {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    const sqlite = new Database(join(directory, file));
    sqlite.pragma('journal_mode = WAL');
    for (const statement of statements) sqlite.exec(statement);
    return sqlite;
  };
  const keyPath = (directory: string) => join(directory, 'secrets', 'master.key');
  const refuses = (directory: string, evidence: RegExp) => {
    assert.throws(
      () => loadOrCreateSecretKey(directory),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'DEPLOY_SECRET_KEY_MISSING');
        assert.ok(error.message.includes(keyPath(directory)), error.message);
        assert.match(error.message, evidence);
        assert.match(error.message, /backup or a recovery bundle/);
        assert.match(error.message, /DEPLOY_SECRET_KEY/);
        return true;
      },
    );
    assert.equal(existsSync(keyPath(directory)), false, 'No new key is created');
  };

  it('creates a key when databases exist but nothing is encrypted', () => {
    const directory = dataDirectory();
    database(
      directory,
      'deploy.db',
      'CREATE TABLE project_configuration(value_type TEXT, deleted INTEGER)',
      "INSERT INTO project_configuration VALUES ('variable',0), ('secret',1)",
      'CREATE TABLE agent_jobs(payload TEXT)',
      `INSERT INTO agent_jobs VALUES ('{"legacy":"plain json"}')`,
    ).close();
    database(
      directory,
      'workspace/workspace.db',
      'CREATE TABLE records(kind TEXT, data TEXT)',
      `INSERT INTO records VALUES ('provider-connection','{"id":"local"}'), ('task','{"secret":"not one"}')`,
    ).close();
    assert.equal(loadOrCreateSecretKey(directory).length, 32);
  });

  const stores: Array<[string, RegExp, string, string[]]> = [
    [
      'application secrets',
      /deploy\.db \(application secrets\)/,
      'deploy.db',
      [
        'CREATE TABLE application_configuration_values(value_type TEXT)',
        "INSERT INTO application_configuration_values VALUES ('secret')",
      ],
    ],
    [
      'project secrets',
      /deploy\.db \(project secrets\)/,
      'deploy.db',
      [
        'CREATE TABLE project_configuration(value_type TEXT, deleted INTEGER)',
        "INSERT INTO project_configuration VALUES ('secret',0)",
      ],
    ],
    [
      'component secrets',
      /deploy\.db \(component secrets\)/,
      'deploy.db',
      [
        'CREATE TABLE component_profile_values(secret INTEGER)',
        'INSERT INTO component_profile_values VALUES (1)',
      ],
    ],
    [
      'worker job payloads',
      /deploy\.db \(worker job payloads\)/,
      'deploy.db',
      ['CREATE TABLE agent_jobs(payload TEXT)', "INSERT INTO agent_jobs VALUES ('v1:a:b:c')"],
    ],
    [
      'computer package keys',
      /deploy\.db \(computer package keys\)/,
      'deploy.db',
      [
        'CREATE TABLE package_computer_keys(envelope TEXT)',
        "INSERT INTO package_computer_keys VALUES ('v1:a:b:c')",
      ],
    ],
    [
      'provider keys',
      /workspace\/workspace\.db \(provider keys/,
      'workspace/workspace.db',
      [
        'CREATE TABLE records(kind TEXT, data TEXT)',
        `INSERT INTO records VALUES ('provider-connection','{"secret":"v1:a:b:c"}')`,
      ],
    ],
    [
      'managed worker tokens',
      /workspace\/workspace\.db \(provider keys and managed worker tokens/,
      'workspace/workspace.db',
      [
        'CREATE TABLE records(kind TEXT, data TEXT)',
        `INSERT INTO records VALUES ('managed-worker','{"secret":"v1:a:b:c"}')`,
      ],
    ],
  ];
  for (const [name, evidence, file, statements] of stores) {
    it(`refuses to create a key over ${name}`, () => {
      const directory = dataDirectory();
      database(directory, file, ...statements).close();
      refuses(directory, evidence);
    });
  }

  it('sees encrypted rows that are still only in the WAL of a running database', () => {
    const directory = dataDirectory();
    const sqlite = database(directory, 'workspace/workspace.db', 'PRAGMA wal_autocheckpoint = 0');
    try {
      sqlite.exec(`CREATE TABLE records(kind TEXT, data TEXT);
        INSERT INTO records VALUES ('managed-worker','{"secret":"v1:a:b:c"}')`);
      refuses(directory, /workspace\.db/);
    } finally {
      sqlite.close();
    }
  });

  it('refuses over encrypted release journals and receipts', () => {
    const journals = dataDirectory();
    mkdirSync(join(journals, 'project-releases', 'journals'), { recursive: true });
    writeFileSync(join(journals, 'project-releases', 'journals', 'release.json'), 'v1:a:b:c');
    refuses(journals, /release journals/);

    const receipts = dataDirectory();
    mkdirSync(join(receipts, 'project-releases', 'a1b2'), { recursive: true });
    writeFileSync(join(receipts, 'project-releases', 'a1b2', 'receipt.json'), 'v1:a:b:c');
    refuses(receipts, /release receipts/);
  });

  it('refuses when a database cannot be read, because it cannot be ruled out', () => {
    const directory = dataDirectory();
    writeFileSync(join(directory, 'deploy.db'), 'this was never a database, or no longer is one');
    refuses(directory, /deploy\.db \(could not be read/);
  });

  it('starts from DEPLOY_SECRET_KEY without the file', () => {
    const directory = dataDirectory();
    database(
      directory,
      'deploy.db',
      'CREATE TABLE agent_jobs(payload TEXT)',
      "INSERT INTO agent_jobs VALUES ('v1:a:b:c')",
    ).close();
    const key = randomBytes(32);
    process.env.DEPLOY_SECRET_KEY = key.toString('hex');
    assert.deepEqual(loadOrCreateSecretKey(directory), key);
    assert.equal(existsSync(keyPath(directory)), false);
  });

  it('accepts the new key the message tells the owner how to create', () => {
    const directory = dataDirectory();
    database(
      directory,
      'deploy.db',
      'CREATE TABLE agent_jobs(payload TEXT)',
      "INSERT INTO agent_jobs VALUES ('v1:a:b:c')",
    ).close();
    let message = '';
    try {
      loadOrCreateSecretKey(directory);
    } catch (error) {
      message = (error as Error).message;
    }
    const command = message.match(/create a new key yourself with: (.+)\. Then/)?.[1];
    assert.ok(command, message);
    execSync(command);
    assert.equal(loadOrCreateSecretKey(directory).length, 32);
    assert.equal(statSync(keyPath(directory)).mode & 0o777, 0o600);
  });

  it('knows every store a caller encrypts into', () => {
    // A new encrypted store must join encryptedDataEvidence in secrets.ts, then this list.
    const root = resolve(import.meta.dirname);
    const callers = (readdirSync(root, { recursive: true }) as string[])
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .filter((file) => /\bencryptSecret\(/.test(readFileSync(join(root, file), 'utf8')))
      .sort();
    assert.deepEqual(callers, [
      'application-configuration.ts',
      'features/agents/provider-connections.ts',
      'features/releases/releases-journal.ts',
      'features/repositories/projects.ts',
      'graph-runtime-store.ts',
      'packages/keys.ts',
      'secrets.ts',
      'store/agent-jobs.ts',
      'v2/releases-worker.ts',
      'v2/settings.ts',
      'workspace/managed-worker.ts',
    ]);
  });
});
