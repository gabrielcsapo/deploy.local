import { test } from 'node:test';
import assert from 'node:assert/strict';
import { socketFromServerUnit } from './supervisor.ts';

test('DEPLOY_DATA_DIR in the server unit wins over its release working directory', () => {
  // As on SER: drop-ins move WorkingDirectory to each release but keep the data directory.
  assert.equal(
    socketFromServerUnit(
      'Environment=PATH=/usr/bin:/bin NODE_ENV=production DEPLOY_DATA_DIR=/home/u/Documents/deploy.local/.deploy-data\nWorkingDirectory=/home/u/.local/share/deploy.local/current\n',
    ),
    '/home/u/Documents/deploy.local/.deploy-data/supervisor.sock',
  );
  assert.equal(
    socketFromServerUnit(
      'Environment="DEPLOY_DATA_DIR=/srv/deploy data" NODE_ENV=production\nWorkingDirectory=/opt/x\n',
    ),
    '/srv/deploy data/supervisor.sock',
  );
});

test('without DEPLOY_DATA_DIR the socket is under the working directory, and nothing means null', () => {
  assert.equal(
    socketFromServerUnit('Environment=NODE_ENV=production\nWorkingDirectory=/opt/deploy/\n'),
    '/opt/deploy/.deploy-data/supervisor.sock',
  );
  assert.equal(socketFromServerUnit('Environment=\nWorkingDirectory=\n'), null);
  assert.equal(socketFromServerUnit(''), null);
});
