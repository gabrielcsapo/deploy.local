import { pipelinePackageIdentity } from './pipeline-auth.ts';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { authenticate, isAdmin } from '../store.ts';
import { decryptSecret, encryptSecret, loadOrCreateSecretKey } from '../secrets.ts';
// Loaded once at service startup, never written in a request.
const computerSecret = loadOrCreateSecretKey();
import { event } from '../workspace/store.ts';
import { db, fail, now, recentlyUsed } from './store.ts';
export type Identity = {
  username: string;
  publish: boolean;
  admin: boolean;
  credential: string;
  computer?: boolean;
  pipeline?: {
    projectId: string;
    pipelineId: string;
    name: string;
    version: string;
    commit: string;
    pullNumber?: number;
  };
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function audit(identity: Identity, action: string, name: string, req?: IncomingMessage) {
  event(identity.username, '', null, 'package.' + action, {
    name,
    credential: identity.credential,
    from: req?.socket.remoteAddress || 'local',
  });
}
export function listKeys(username: string) {
  return db()
    .prepare(
      'SELECT id,label,scope,last_used_at AS lastUsedAt,created_at AS createdAt FROM package_keys WHERE username=? ORDER BY created_at',
    )
    .all(username);
}
export function createKey(username: string, label: string, scope: string) {
  if (
    typeof label !== 'string' ||
    !label.trim() ||
    [...label].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    label.length > 100 ||
    !['install', 'publish'].includes(scope)
  )
    fail('A label and install or publish scope are required');
  const key = 'dlp_' + randomBytes(32).toString('base64url'),
    id = randomUUID();
  db()
    .prepare(
      'INSERT INTO package_keys(id,username,hash,label,scope,created_at) VALUES(?,?,?,?,?,?)',
    )
    .run(id, username, hash(key), label.trim(), scope, now());
  return { id, key, label: label.trim(), scope };
}
export function registryIdentity(req: IncomingMessage): Identity | null {
  if (req.headers['x-deploy-agent-token']) return null;
  const authorization = req.headers.authorization || '';
  const token = authorization.replace(/^Bearer /i, '');
  if (/^dlp_[A-Za-z0-9_-]{43}$/.test(token)) {
    const pipeline = pipelinePackageIdentity(token);
    if (pipeline) return pipeline;
    const computer = db()
      .prepare('SELECT username,computer_id,last_used_at FROM package_computer_keys WHERE hash=?')
      .get(hash(token)) as any;
    if (computer) {
      if (!recentlyUsed(computer.last_used_at))
        db()
          .prepare('UPDATE package_computer_keys SET last_used_at=? WHERE hash=?')
          .run(now(), hash(token));
      return {
        username: computer.username,
        publish: false,
        admin: false,
        credential: 'computer:' + computer.computer_id,
        computer: true,
      };
    }
    const key = db()
      .prepare('SELECT id,username,scope,last_used_at FROM package_keys WHERE hash=?')
      .get(hash(token)) as
      | { id: string; username: string; scope: string; last_used_at: string | null }
      | undefined;
    if (!key) return null;
    if (!recentlyUsed(key.last_used_at))
      db().prepare('UPDATE package_keys SET last_used_at=? WHERE id=?').run(now(), key.id);
    return {
      username: key.username,
      publish: key.scope === 'publish',
      admin: isAdmin(key.username),
      credential: 'package-key:' + key.id,
    };
  }
  if (authorization.startsWith('Basic ')) {
    const decoded = Buffer.from(authorization.slice(6), 'base64').toString(),
      split = decoded.indexOf(':');
    const username = decoded.slice(0, split),
      password = decoded.slice(split + 1);
    if (split > 0 && authenticate(username, password))
      return { username, publish: true, admin: isAdmin(username), credential: 'cli-session' };
  }
  return null;
}
export function canPublish(identity: Identity, owner?: string) {
  if (identity.pipeline) return;
  if (identity.computer)
    fail(
      "Tasks can't publish. Set the version in the pull request; the pipeline publishes it when it merges.",
      403,
    );
  if (!identity.publish) fail('This package key can only install.', 403);
  if (owner && owner !== identity.username && !identity.admin)
    fail('Only the publisher or an admin can publish this package.', 403);
}

/** Separate from enrollment credentials; never listed by the personal keys API. */
export function computerPackageKey(username: string, computerId: string) {
  const address = JSON.stringify(['package-computer', username, computerId]);
  return db()
    .transaction(() => {
      const row = db()
        .prepare('SELECT envelope FROM package_computer_keys WHERE username=? AND computer_id=?')
        .get(username, computerId) as any;
      if (row) return decryptSecret(row.envelope, computerSecret, address);
      const key = 'dlp_' + randomBytes(32).toString('base64url');
      db()
        .prepare(
          'INSERT INTO package_computer_keys(username,computer_id,hash,envelope,created_at) VALUES(?,?,?,?,?)',
        )
        .run(username, computerId, hash(key), encryptSecret(key, computerSecret, address), now());
      return key;
    })
    .immediate();
}
export function revokeComputerPackageKey(username: string, computerId: string) {
  db()
    .prepare('DELETE FROM package_computer_keys WHERE username=? AND computer_id=?')
    .run(username, computerId);
}
