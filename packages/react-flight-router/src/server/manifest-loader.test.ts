import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadManifests } from './manifest-loader.js';
import { generateBootstrapScript } from '../shared/bootstrap-script.js';

const directories: string[] = [];

function build(
  overrides: { client?: object; ssr?: object; actions?: object; css?: string[] } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'rfr-manifests-'));
  directories.push(directory);
  const write = (name: string, value: unknown) =>
    writeFileSync(join(directory, name), JSON.stringify(value));
  write('rsc-client-manifest.json', overrides.client ?? { a: { id: 'assets/a-1.js' } });
  write('ssr-manifest.json', overrides.ssr ?? {});
  write('server-actions-manifest.json', overrides.actions ?? {});
  write('build-meta.json', {
    clientEntryUrl: '/assets/entry-same.js',
    cssFiles: overrides.css ?? ['/assets/a.css'],
  });
  return loadManifests(directory).buildId;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

describe('buildId', () => {
  it('is the same for the same build', () => {
    expect(build()).toBe(build());
  });

  it('changes when a chunk changes, even though the entry file keeps its name', () => {
    expect(build({ client: { a: { id: 'assets/a-2.js' } } })).not.toBe(build());
  });

  it('changes when styles or server actions change', () => {
    expect(build({ css: ['/assets/b.css'] })).not.toBe(build());
    expect(build({ actions: { x: { id: 'x' } } })).not.toBe(build());
  });

  it('stays when only the server side changes, so open pages are left alone', () => {
    expect(build({ ssr: { moduleMap: { a: {} } } })).toBe(build());
  });
});

describe('generateBootstrapScript', () => {
  it('tells the page its build', () => {
    expect(generateBootstrapScript({}, true, 'abc')).toContain('window.__RSC_BUILD__ = "abc";');
    expect(generateBootstrapScript({}, false, 'abc')).toContain('window.__RSC_BUILD__ = "abc";');
  });

  it('says nothing in dev mode', () => {
    expect(generateBootstrapScript()).not.toContain('__RSC_BUILD__');
  });
});
