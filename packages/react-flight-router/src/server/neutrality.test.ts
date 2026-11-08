// @vitest-environment node
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('keeps application-specific telemetry names out of source and built output', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const forbidden = ['DEP' + 'LOY_', '__DEP' + 'LOY', '/__dep' + 'loy'];
  const violations: string[] = [];
  function scan(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (entry.isFile()) {
        const contents = readFileSync(path, 'utf8');
        if (forbidden.some((name) => contents.includes(name)))
          violations.push(relative(root, path));
      }
    }
  }
  for (const directory of ['src', 'dist']) {
    expect(
      existsSync(resolve(root, directory)),
      `${directory} must exist; run pnpm build first`,
    ).toBe(true);
    scan(resolve(root, directory));
  }
  expect(violations).toEqual([]);
});
