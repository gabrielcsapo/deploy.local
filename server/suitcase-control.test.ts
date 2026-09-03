import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('core control mutates authoritative named-state membership only', () => {
  const root = mkdtempSync(join(tmpdir(), 'deploy-suitcase-control-'));
  const state = join(root, 'state');
  const host = join(root, 'host-membership.json');
  const authoritative = join(state, 'fleet-membership.json');
  const localKeys = generateKeyPairSync('ed25519');
  const homeKeys = generateKeyPairSync('ed25519');
  const localPublic = localKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const membership = {
    schemaVersion: 1,
    targetId: 'target-control',
    coordinatorUrl: 'https://home.test',
    siteId: 'site_control',
    fleetId: 'fleet_control',
    homeSiteId: 'site_home',
    credential: 'site_secret_control',
    protocolVersion: 1,
    name: 'Control Suitcase',
    defaultDataPolicy: 'none',
    accessMode: 'existing-lan',
    securityProfile: 'isolated',
    publicKey: localPublic,
    privateKey: localKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    siteKeys: {
      site_control: localPublic,
      site_home: homeKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    },
    mode: 'away',
    nextOriginSequence: 1,
    acknowledgedLocalSequence: 0,
    cursors: {},
    outbox: [],
    inbox: [],
    projectedEventIds: [],
    outgoingArtifacts: [],
    pairedAt: '2026-08-08T12:00:00.000Z',
  };
  mkdirSync(state);
  writeFileSync(authoritative, JSON.stringify(membership));
  writeFileSync(host, JSON.stringify(membership));
  const repository = resolve(import.meta.dirname, '..');
  try {
    const output = execFileSync(
      process.execPath,
      ['server/suitcase-control-main.ts', 'candidate', 'app_notes', 'restart'],
      {
        cwd: repository,
        encoding: 'utf8',
        env: {
          ...process.env,
          DEPLOY_DATA_DIR: state,
          DEPLOY_SUITCASE: '1',
          DEPLOY_SUITCASE_MEMBERSHIP_FILE: authoritative,
          DEPLOY_SUITCASE_MEMBERSHIP_BOOTSTRAP_FILE: host,
        },
      },
    );
    const event = JSON.parse(output) as { originSiteId: string; payload: { command: string } };
    assert.equal(event.originSiteId, 'site_control');
    assert.equal(event.payload.command, 'restart');
    const savedState = JSON.parse(readFileSync(authoritative, 'utf8')) as { outbox: unknown[] };
    const savedHost = JSON.parse(readFileSync(host, 'utf8')) as { outbox: unknown[] };
    assert.equal(savedState.outbox.length, 1);
    assert.equal(savedHost.outbox.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
