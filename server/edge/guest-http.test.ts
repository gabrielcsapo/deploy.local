import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import test from 'node:test';
import { guestHttpTarget } from './guest-http.ts';

function target(host: string, url: string, method = 'GET', headers = {}) {
  const req = { headers: { host, ...headers }, url, method } as IncomingMessage;
  return guestHttpTarget(req, { isShared: (name) => name === 'game' });
}

test('the guest directory and its built assets can load over HTTP', () => {
  for (const host of ['deploy.local', 'DEPLOY.LOCAL.:8080', '10.0.0.154', '[::1]:8080']) {
    for (const path of [
      '/?welcome',
      '/assets/app/routes/public-579.js',
      '/assets/hanken.ttf',
      '/fonts/inter.woff2',
    ]) {
      assert.equal(target(host, path), 'home');
    }
    for (const path of ['/signin', '/dashboard', '/assets/../signin']) {
      assert.notEqual(target(host, path), 'home');
    }
    assert.notEqual(target(host, '/', 'POST'), 'home');
  }
});

test('guest app routes include app-owned API paths and exclude private apps and previews', () => {
  for (const path of ['/', '/api/play', '/ws', '/app.js']) {
    assert.equal(target('GAME.local.:8080', path), 'app');
    assert.equal(target('game.deploy.local', path, 'POST'), 'app');
    assert.equal(target('private.local', path), 'https');
    assert.equal(target('copy-demo.game.deploy.local', path), 'https');
  }
});

test('the guest directory can read the catalog without sending browser credentials to the control API', () => {
  const browser = { origin: 'http://deploy.local' };
  assert.equal(target('deploy.local', '/api/apps-home', 'GET', browser), 'existing');
  assert.equal(target('deploy.local', '/api/login', 'POST', browser), 'https');
  assert.equal(
    target('deploy.local', '/api/auth/account', 'GET', { 'sec-fetch-site': 'same-origin' }),
    'https',
  );
  assert.equal(
    target('deploy.local', '/api/deployments', 'GET', { 'sec-fetch-mode': 'cors' }),
    'existing',
  );
});
