// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { isScriptModule, useClientPlugin } from './plugin-use-client.js';

type ResolveId = (
  this: { resolve: (source: string) => Promise<{ id: string } | null> },
  source: string,
  importer: string | undefined,
  options: Record<string, unknown>,
) => Promise<{ id: string } | null>;

async function resolveFromSsrImporter(resolvedId: string) {
  const plugin = useClientPlugin({ mode: 'auto' });
  const resolveId = plugin.resolveId as unknown as ResolveId;
  return resolveId.call(
    { resolve: async () => ({ id: resolvedId }) },
    './dependency',
    '/app/routes/page.client.tsx?ssr',
    {},
  );
}

describe('?ssr propagation in development', () => {
  it('follows imports into local script modules', async () => {
    expect((await resolveFromSsrImporter('/app/lib/util.ts'))?.id).toBe('/app/lib/util.ts?ssr');
    expect((await resolveFromSsrImporter('/app/lib/view.jsx'))?.id).toBe('/app/lib/view.jsx?ssr');
  });

  it('leaves JSON, CSS and other assets to their own transforms', async () => {
    for (const id of ['/app/data/icons.json', '/app/styles.css', '/app/logo.svg']) {
      expect((await resolveFromSsrImporter(id))?.id).toBe(id);
    }
  });

  it('recognises script modules by extension only', () => {
    expect(isScriptModule('/a/b.mts?v=1')).toBe(true);
    expect(isScriptModule('/a/b.json')).toBe(false);
  });
});
