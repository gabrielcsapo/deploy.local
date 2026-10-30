// Render the actual route modules without a coordinator, database or Docker.
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { build } = createRequire(import.meta.resolve('vite'))('esbuild');
export async function buildDocs() {
  const directory = mkdtempSync(join(tmpdir(), 'deploy-docs-render-'));
  const routeSource = readFileSync(resolve('app/routes.ts'), 'utf8');
  const docsRoutes = routeSource.slice(
    routeSource.indexOf("id: 'docs',"),
    routeSource.indexOf("id: 'dashboard',"),
  );
  const entries = [
    ...docsRoutes.matchAll(/id: 'docs-([^']+)'[\s\S]*?component: \(\) => import\('([^']+)'\)/g),
  ]
    .filter((match) => match[2].startsWith('./routes/docs/'))
    .map((match, index) => ({
      path: match[1] === 'index' ? '/docs' : `/docs/${match[1]}`,
      module: './app/' + match[2].slice(2).replace(/\.js$/, '.tsx'),
      name: `Page${index}`,
    }));
  const imports = entries.map((entry) => `import ${entry.name} from '${entry.module}';`).join('\n');
  const mapping = `const pages = {${entries.map((entry) => `${JSON.stringify(entry.path)}: ${entry.name}`).join(',')}};`;
  const common = {
    bundle: true,
    jsx: 'automatic',
    logLevel: 'silent',
    absWorkingDir: process.cwd(),
  };
  try {
    await build({
      ...common,
      platform: 'node',
      format: 'cjs',
      outfile: join(directory, 'server.cjs'),
      loader: { '.css': 'empty' },
      stdin: {
        resolveDir: process.cwd(),
        loader: 'tsx',
        contents: `
        import { createElement } from 'react';
        import { renderToStaticMarkup } from 'react-dom/server';
        export { docs, docPath, searchDocs, groups, cliInstallCommands } from './app/routes/docs/content.tsx';
        ${imports}\n${mapping}
        export const paths = Object.keys(pages);
        export function render(path) { return pages[path] ? renderToStaticMarkup(createElement(pages[path])) : null; }
      `,
      },
    });
    const client = await build({
      ...common,
      platform: 'browser',
      format: 'esm',
      outfile: join(directory, 'client.js'),
      write: false,
      // The public header bundles its typeface; inline it so the fixture stays self-contained.
      loader: { '.ttf': 'dataurl' },
      stdin: {
        resolveDir: process.cwd(),
        loader: 'tsx',
        contents: `
        import { createElement } from 'react';
        import { hydrateRoot } from 'react-dom/client';
        ${imports}\n${mapping}
        const Page = pages[window.location.pathname.replace(/\\/$/, '')];
        if (Page) hydrateRoot(document.getElementById('docs-root'), createElement(Page));
      `,
      },
    });
    const rendered = require(join(directory, 'server.cjs'));
    return {
      ...rendered,
      js: client.outputFiles.find((file) => file.path.endsWith('.js')).text,
      css:
        readFileSync(resolve('app/design-tokens.css'), 'utf8') +
        '\n' +
        client.outputFiles.find((file) => file.path.endsWith('.css')).text,
      close: () => rmSync(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
