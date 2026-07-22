import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { readDeployConfig } from './deploy-config.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function config(value: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-config-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'deploy.json'), JSON.stringify(value));
  return readDeployConfig(dir);
}

describe('deploy.json cache policy', () => {
  it('applies safe defaults', () => {
    assert.deepEqual(config({ cache: { paths: ['/assets/*'] } }).cache, {
      enabled: true,
      maxAge: 60,
      paths: ['/assets/*'],
      maxObjectBytes: 2 * 1024 * 1024,
    });
  });

  it('rejects relative paths and excessive object sizes', () => {
    assert.throws(() => config({ cache: { paths: ['assets/*'] } }), /absolute path patterns/);
    assert.throws(
      () => config({ cache: { paths: ['/'], maxObjectBytes: 20 * 1024 * 1024 } }),
      /maxObjectBytes/,
    );
  });
});

describe('deploy.json Docker options', () => {
  it('parses declarative networks and exact run arguments', () => {
    assert.deepEqual(
      config({
        docker: {
          networks: [
            {
              name: 'groffee-ci',
              subnet: '172.30.0.0/24',
              labels: { 'com.groffee.egress': 'restricted' },
            },
          ],
          runArgs: ['--dns', '172.30.0.10'],
        },
      }).docker,
      {
        networks: [
          {
            name: 'groffee-ci',
            driver: undefined,
            subnet: '172.30.0.0/24',
            labels: { 'com.groffee.egress': 'restricted' },
          },
        ],
        runArgs: ['--dns', '172.30.0.10'],
      },
    );
  });

  it('rejects invalid networks and lifecycle overrides', () => {
    assert.throws(
      () => config({ docker: { networks: [{ name: '../unsafe' }] } }),
      /name is invalid/,
    );
    assert.throws(() => config({ docker: { runArgs: ['--name', 'other'] } }), /reserved argument/);
  });
});
