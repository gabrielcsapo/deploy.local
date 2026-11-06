// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  realpathSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, resolve, join } from 'path';
import { fileURLToPath } from 'url';
import { build } from './build-orchestrator.js';
import { moduleStylesheets, stylesheetOrder } from './route-css.js';

it('preserves the last occurrence of each legacy sheet, including interleaved duplicates', () => {
  expect(stylesheetOrder(['a', 'b', 'a', 'c', 'b'])).toEqual(['a', 'c', 'b']);
});

it('walks cyclic static graphs and transitive manifest chunks without borrowing sibling CSS', () => {
  const graph = new Map([
    ['/app/route.ts', new Set(['/app/shared.ts', '/app/page.css'])],
    ['/app/shared.ts', new Set(['/app/route.ts'])],
    ['/app/other.ts', new Set(['/app/other.css'])],
  ]);
  expect(
    moduleStylesheets(
      graph,
      {
        'shared.ts': { file: 'shared.js', imports: ['chunk'] },
        chunk: { file: 'chunk.js', css: ['shared.css'] },
        'page.css': { file: 'page.css' },
        'other.css': { file: 'other.css' },
      },
      '/app',
      ['/page.css', '/other.css', '/shared.css'],
    )['route.ts'],
  ).toEqual(['/page.css', '/shared.css']);
});

describe('production stylesheet build', () => {
  it('maps resolved RSC/client graphs, aliases, CSS modules, lazy clients and boundary facades', async () => {
    const appRoot = realpathSync(mkdtempSync(join(tmpdir(), 'rfr-css-build-')));
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const write = (name: string, text: string) => {
      const file = join(appRoot, name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    };
    try {
      symlinkSync(resolve(packageRoot, '../../node_modules'), join(appRoot, 'node_modules'));
      write('package.json', '{"type":"module"}');
      write(
        'vite.config.ts',
        `export default {resolve:{alias:{'@shared':${JSON.stringify(join(appRoot, 'shared'))}}}}`,
      );
      write(
        'app/routes.ts',
        `export const routes = [{id:'root',path:'',component:()=>import('./root'),error:()=>import('./error'),notFound:()=>import('./missing'),children:[{id:'a',path:'a',component:()=>import('./a')},{id:'b',path:'b',component:()=>import('./b')}]}];`,
      );
      write('app/root.ts', `import './root.css'; export default function Root(){ return null; }`);
      write(
        'app/a.ts',
        `import A from './a.client'; import '@shared/server.css'; export default function Page(){return A;}`,
      );
      write(
        'app/a.client.ts',
        `'use client'; import css from './a.module.css'; export const lazy=()=>import('./lazy'); export default function A(){return css.page;}`,
      );
      write('app/lazy.ts', `import './lazy.css'; export default function Lazy(){return null;}`);
      for (const name of ['b', 'error', 'missing'])
        write(
          `app/${name}.ts`,
          `import './${name}.css'; export default function Page(){return null;}`,
        );
      for (const name of ['root', 'a.module', 'lazy', 'b', 'error', 'missing'])
        write(`app/${name}.css`, `.page {color:${name === 'b' ? 'blue' : 'red'}}`);
      write('shared/server.css', '.server {display:grid}');
      await build({ appRoot, outDir: join(appRoot, 'dist') });
      const meta = JSON.parse(readFileSync(join(appRoot, 'dist/build-meta.json'), 'utf8'));
      const vm = JSON.parse(readFileSync(join(appRoot, 'dist/client/.vite/manifest.json'), 'utf8'));
      const css = (key: string): string[] => {
        const entry = vm[key];
        if (!entry) throw new Error(`${key}: ${Object.keys(vm).join(', ')}`);
        return entry.file.endsWith('.css')
          ? ['/' + entry.file]
          : (entry.css ?? []).map((f: string) => '/' + f);
      };
      expect(meta.cssModules['app/a.ts']).toEqual(
        expect.arrayContaining([
          ...css('app/a.client.ts'),
          ...css('app/lazy.css'),
          ...css('shared/server.css'),
        ]),
      );
      expect(meta.cssModules['app/a.ts']).not.toContain(css('app/b.css')[0]);
      expect(meta.cssModules['app/root.ts']).toEqual(css('app/root.css'));
      const entry = await import(join(appRoot, 'dist/server/rsc-entry.js'));
      for (const load of [
        entry.routes[0].component,
        entry.routes[0].error,
        entry.routes[0].notFound,
        entry.routes[0].children[0].component,
      ]) {
        const module = await load();
        expect(meta.cssModules[module.__flight_css_id]).toBeDefined();
      }
    } finally {
      rmSync(appRoot, { recursive: true, force: true });
    }
  });
});
