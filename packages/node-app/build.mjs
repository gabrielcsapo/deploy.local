import { createRequire } from 'node:module';
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const here = resolve(root, 'packages/node-app');
const out = resolve(here, 'dist');
const require = createRequire(resolve(root, 'package.json'));
const { build } = createRequire(require.resolve('vite'))('esbuild');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(resolve(root, 'LICENSE'), resolve(here, 'LICENSE'));
const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: ['electron', 'playwright'],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
};
await build({
  ...common,
  entryPoints: [resolve(here, 'src/main.ts')],
  outfile: resolve(out, 'main.js'),
});
await build({
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron'],
  entryPoints: [resolve(here, 'src/preload.ts')],
  outfile: resolve(out, 'preload.cjs'),
});
await build({
  bundle: true,
  platform: 'browser',
  format: 'esm',
  entryPoints: [resolve(here, 'src/setup.ts')],
  outfile: resolve(out, 'setup.js'),
});
for (const name of ['remote-worker', 'compatible-agent', 'claude-agent', 'mcp'])
  await build({
    ...common,
    entryPoints: [resolve(root, `server/workspace/${name}.ts`)],
    outfile: resolve(out, `workspace-${name}.js`),
  });
cpSync(resolve(root, 'native/Linux/desktop-helper.py'), resolve(out, 'desktop-helper.py'));
cpSync(resolve(here, 'src/setup.html'), resolve(out, 'setup.html'));
// Playwright's runtime loads its own files dynamically; ship the installed packages, never browsers or a Mac binary.
for (const name of ['playwright', 'playwright-core']) {
  const path =
    name === 'playwright'
      ? require.resolve('playwright/package.json')
      : createRequire(require.resolve('playwright')).resolve('playwright-core/package.json');
  cpSync(dirname(path), resolve(out, 'node_modules', name), {
    recursive: true,
    filter: (file) => !/(?:_mac\.sh|\.ps1|\.exe)$/.test(file),
  });
}
const tokens = JSON.parse(readFileSync(resolve(root, 'app/design-tokens.json'), 'utf8'));
const palette = tokens.color.light;
writeFileSync(
  resolve(out, 'setup.css'),
  `:root{color-scheme:light;font-family:${tokens.fontFamily};font-size:${tokens.type.body}px;color:${palette.text};background:${palette.canvas}}body{margin:${tokens.size.workspaceInset}px}h1{font-size:${tokens.type.title}px}h2{font-size:${tokens.type.section}px}label{display:block;margin-block:1em .5em}input:not([type=checkbox]){box-sizing:border-box;width:100%;padding:.7em;border:1px solid ${palette.line};border-radius:.5em;color:inherit;background:${palette.field};font:inherit}button{margin-block:1em;padding:.7em 1em;border:0;border-radius:.5em;background:${palette.action};color:${palette.onAction};font:inherit}a{color:${palette.secondary};text-decoration:underline;text-underline-offset:3px}a:hover{color:${palette.text}}li{margin-block:1em;overflow-wrap:anywhere}code{font-family:${tokens.fontMono}}[role=alert]{color:${palette.danger}}:focus-visible{outline:2px solid ${palette.accent};outline-offset:3px}`,
);
console.log('Built Linux Node service JavaScript and Linux helper (no macOS app or helper).');
