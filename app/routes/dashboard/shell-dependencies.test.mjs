import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Use the bundler already installed with the test runner, without writing build output.
const require = createRequire(import.meta.url);
const { build } = require(require.resolve('esbuild', { paths: [require.resolve('tsx')] }));
const root = fileURLToPath(new URL('../../../', import.meta.url));

test('dashboard shell defers sign-in and excludes account, QR and SSH settings', async () => {
  const { metafile } = await build({
    absWorkingDir: root,
    stdin: {
      contents: `export { V2Layout } from './app/routes/dashboard/v2-layout.client';
        export { AuthErrorBoundary } from './app/components/AuthErrorBoundary';
        export { SessionExpired } from './app/routes/dashboard/v2/start/SessionExpired';`,
      resolveDir: root,
      sourcefile: 'shell-entry.tsx',
      loader: 'tsx',
    },
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    metafile: true,
    outdir: path.join(root, 'dist/shell-test'),
    external: ['react', 'react-dom', 'react-dom/*', 'react-flight-router/*'],
    plugins: [
      {
        name: 'omit-css',
        setup(b) {
          b.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'css' }));
        },
      },
    ],
  });
  const visited = new Set();
  const initialInputs = new Set();
  function visit(file) {
    if (visited.has(file)) return;
    visited.add(file);
    const output = metafile.outputs[file];
    for (const [name, input] of Object.entries(output.inputs))
      if (input.bytesInOutput) initialInputs.add(name);
    for (const entry of output.imports)
      if (!entry.external && entry.kind !== 'dynamic-import') visit(entry.path);
  }
  const entry = Object.entries(metafile.outputs).find(
    ([, output]) => output.entryPoint === 'shell-entry.tsx',
  );
  assert.ok(entry);
  visit(entry[0]);
  assert.doesNotMatch(
    [...initialInputs].join('\n'),
    /qrcode|simplewebauthn|account\.client|ssh-keys\.client|v2-public\/page\.client|start\/page\.client/,
  );
  assert.ok(
    Object.values(metafile.outputs).some((output) =>
      output.entryPoint?.endsWith('SessionExpiredDialog.tsx'),
    ),
    'sign-in is still available as a lazy chunk',
  );
  assert.match(
    Object.keys(metafile.inputs).join('\n'),
    /simplewebauthn/,
    'the lazy sign-in retains passkey support',
  );
});
