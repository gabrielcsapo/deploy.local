import assert from 'node:assert/strict';
import test from 'node:test';
import { npmManifest, cargoManifest, extractLock } from './manifests.ts';
import { extractRust } from './rust.ts';
import { extractTypeScript } from './typescript.ts';

test('the TypeScript checker resolves lexical bindings and captures imports and exports', () => {
  const [file, broken] = extractTypeScript([
    {
      path: 'index.ts',
      text: `
      import type { Widget as Input } from 'components';
      import * as client from 'components/client';
      import start from './start.js';
      export { render as draw } from 'components';
      export * from './other';
      export * as helpers from './helpers';
      export { start };
      /** Start a widget. */
      export default function run(input: Input) {
        client.render(input);
        const result = start();
        return ({ result }) => result;
      }
      export namespace Store { export type Item = string; }
    `,
    },
    { path: 'broken.ts', text: '\nexport const nope = ;\n' },
  ]);
  assert.equal(file.coverage, 'symbols');
  const { definitions, occurrences, exports } = file.source!;
  assert.deepEqual(exports.map(({ name, scope }) => [...(scope ?? []), name].join('.')).sort(), [
    '*',
    'Store',
    'Store.Item',
    'default',
    'draw',
    'helpers',
    'start',
  ]);
  assert.equal(definitions.find(({ name }) => name === 'run')?.doc, 'Start a widget.');
  assert.equal(definitions.find(({ name }) => name === 'Item')?.kind, 'type');
  assert.equal(occurrences.filter(({ binding }) => binding?.name === 'Widget').length, 2);
  assert.ok(
    occurrences.some(
      ({ binding }) => binding?.member === 'render' && binding?.module === 'components/client',
    ),
  );
  const results = definitions.filter(({ name }) => name === 'result');
  assert.equal(results.length, 2);
  assert.equal(occurrences.filter(({ target }) => target === results[0].offset).length, 0);
  assert.equal(occurrences.filter(({ target }) => target === results[1].offset).length, 1);
  assert.equal(broken.coverage, 'skipped');
  assert.equal(broken.errorLine, 2);
  assert.match(broken.reason!, /Syntax error/);
  assert.match(broken.text!, /nope/);
});

test('Rust extracts public items, nested modules, grouped aliases and re-exports', () => {
  const input = `
    pub use dep::{Client as Http, api::{self, request}};
    pub mod nested {
      // Ignored: pub fn hidden_from_comment() {}
      /// A request handler.
      pub async fn handle() { super::Http::new(); }
      pub(crate) struct Internal;
      pub enum Mode { A }
      pub trait Handler {}
      pub type Output = i32;
      pub const TIMEOUT: u32 = 5;
      #[macro_export]
      macro_rules! event { () => {} }
      pub mod leaf;
    }
    const TEXT: &str = r##"pub fn string_only() {{""##;
    fn call() { request(); nested::handle(); }
  `;
  const file = extractRust(input);
  assert.equal(file.coverage, 'symbols');
  const { definitions, exports, occurrences } = file.source!;
  assert.deepEqual(
    exports.map(({ name }) => name),
    [
      'Http',
      'api',
      'request',
      'nested',
      'handle',
      'Mode',
      'Handler',
      'Output',
      'TIMEOUT',
      'event',
      'leaf',
    ],
  );
  assert.deepEqual(definitions.find(({ name }) => name === 'handle')?.scope, ['nested']);
  assert.equal(definitions.find(({ name }) => name === 'handle')?.doc, 'A request handler.');
  assert.deepEqual(definitions.find(({ name }) => name === 'event')?.scope, []);
  assert.ok(
    !definitions.some(({ name }) => name === 'hidden_from_comment' || name === 'string_only'),
  );
  assert.equal(
    occurrences.filter(
      ({ binding }) => binding?.module === 'dep::api' && binding.name === 'request',
    ).length,
    2,
  );
  assert.deepEqual(occurrences.find(({ binding }) => binding?.name === 'handle')?.binding, {
    module: 'nested',
    name: 'handle',
  });
  const broken = extractRust('pub mod nested {\n  pub fn {\n  }\n}');
  assert.equal(broken.coverage, 'skipped');
  assert.equal(broken.errorLine, 2);
  assert.match(broken.reason!, /Expected name/);
});

test('package extraction preserves entry points, aliases and lockfile importer versions', () => {
  const npm = npmManifest(
    JSON.stringify({
      name: 'demo',
      main: 'internal.js',
      exports: {
        '.': { types: './dist/main.d.ts', default: './dist/main.js' },
        './client': './src/client.ts',
      },
      bin: { demo: './cli.js' },
      dependencies: { fetch: 'npm:@owner/http@^2.0.0' },
    }),
  );
  assert.deepEqual(
    npm.entries.map(({ name, path, exposure }) => [name, path, exposure]),
    [
      ['.', './dist/main.d.ts', 'import'],
      ['.', './dist/main.js', 'import'],
      ['./client', './src/client.ts', 'import'],
      ['main', 'internal.js', 'entry'],
      ['demo', './cli.js', 'bin'],
    ],
  );
  assert.deepEqual(npm.dependencies, [
    { alias: 'fetch', name: '@owner/http', requirement: 'npm:@owner/http@^2.0.0' },
  ]);
  const cargo = cargoManifest(`[package]
name = "consumer"
version = "1.2.3"
[dependencies]
local = { package = "producer", version = "^1" }
[[bin]]
name = "other"
path = "cli.rs"
`);
  assert.deepEqual(cargo.dependencies, [{ alias: 'local', name: 'producer', requirement: '^1' }]);
  assert.ok(cargo.entries.some(({ name, path }) => name === 'other' && path === 'cli.rs'));
  const locked = extractLock(
    'pnpm-lock.yaml',
    `
lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      fetch:
        specifier: npm:@owner/http@^2.0.0
        version: '@owner/http@2.1.0'
packages:
  '@owner/http@2.1.0': {}
`,
  );
  assert.deepEqual(locked.versions['@owner/http'], ['2.1.0']);
});

test('JavaScript extracts CommonJS exports and require bindings', () => {
  const [file] = extractTypeScript([
    {
      path: 'main.cjs',
      text: `
    const { value: take } = require('value-module');
    const formatter = require('./format');
    function main(input) { return formatter.print(take(input)); }
    exports.main = main;
    module.exports.help = () => 'help';
  `,
    },
  ]);
  assert.equal(file.kind, 'JavaScript');
  assert.deepEqual(file.source?.exports.map(({ name }) => name).sort(), ['help', 'main']);
  assert.equal(
    file.source?.occurrences.filter(({ binding }) => binding?.name === 'value').length,
    2,
  );
  assert.ok(file.source?.occurrences.some(({ binding }) => binding?.member === 'print'));
});
