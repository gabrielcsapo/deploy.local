import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getCachedResponse,
  isPublicCacheable,
  pathMatchesCacheConfig,
  putCachedResponse,
} from './response-cache.ts';

describe('edge response cache policy', () => {
  const config = {
    enabled: true,
    maxAge: 60,
    paths: ['/assets/*', '/api/public'],
    maxObjectBytes: 1024,
  };

  it('matches exact and prefix paths only', () => {
    assert.equal(pathMatchesCacheConfig('/assets/app.js', config), true);
    assert.equal(pathMatchesCacheConfig('/api/public', config), true);
    assert.equal(pathMatchesCacheConfig('/api/private', config), false);
  });

  it('requires an explicitly public response without cookies or unsafe Vary', () => {
    assert.equal(isPublicCacheable({ 'cache-control': 'public, max-age=60' }), true);
    assert.equal(isPublicCacheable({ 'cache-control': 'private, max-age=60' }), false);
    assert.equal(isPublicCacheable({ 'cache-control': 'public', 'set-cookie': 'sid=x' }), false);
    assert.equal(isPublicCacheable({ 'cache-control': 'public', vary: 'Origin' }), false);
    assert.equal(isPublicCacheable({ 'cache-control': 'public', vary: 'Accept-Encoding' }), true);
  });

  it('expires cached responses', () => {
    putCachedResponse('fresh', {
      status: 200,
      headers: {},
      body: Buffer.from('ok'),
      storedAt: Date.now(),
      expiresAt: Date.now() + 1000,
    });
    putCachedResponse('expired', {
      status: 200,
      headers: {},
      body: Buffer.from('old'),
      storedAt: 0,
      expiresAt: 1,
    });
    assert.equal(getCachedResponse('fresh')?.body.toString(), 'ok');
    assert.equal(getCachedResponse('expired'), null);
  });
});
