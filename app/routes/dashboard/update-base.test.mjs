import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const entry = `
import React, {useCallback, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {TaskPublish} from './app/routes/dashboard/task-publish.client.tsx';
import './app/design-tokens.css';
import './app/motion.css';
import './app/components/ui/ui.css';
import './app/routes/dashboard/task-publish.css';
function Fixture() {
  const [task, setTask] = useState({id:'task', projectId:'project', title:'Update the app', revision:0});
  const api = useCallback(async (path, body) => {
    const result = await window.handleAPI(path, body);
    setTask(task => ({...task, baseUpdate: body ? result : result.task.baseUpdate}));
    return result;
  }, []);
  return <div className="project-workspace"><TaskPublish task={task} pulls={[]} diff={{patch:'complete', hasUnpublishedChanges:true}} busy={false} api={api} published={() => {}} /></div>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;

test('Update from main supports keyboard, conflict resolution, abort and error recovery at desktop and phone widths', async () => {
  const bundle = await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: { '@': resolve('app') } },
    plugins: [
      react(),
      {
        name: 'update-base-browser-test',
        resolveId(id) {
          if (id === 'update-base-browser-test') return resolve('update-base-browser-test.tsx');
        },
        load(id) {
          if (id === resolve('update-base-browser-test.tsx')) return entry;
        },
      },
    ],
    build: {
      write: false,
      rollupOptions: { input: 'update-base-browser-test', output: { inlineDynamicImports: true } },
    },
  });
  const script = bundle.output.find((item) => item.type === 'chunk').code;
  const css = bundle.output
    .filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'))
    .map((item) => item.source)
    .join('\n');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script type="module">${script.replaceAll('</script', '<\\/script')}</script></body></html>`;
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      let operation = null;
      let fail = false;
      const calls = [];
      await page.exposeFunction('handleAPI', async (_path, body) => {
        if (!body) return { task: { baseUpdate: operation } };
        calls.push(body.action);
        if (fail) throw new Error('Task computer is unavailable; retry the update.');
        operation = {
          status:
            body.action === 'update' ? 'queued' : body.action === 'abort' ? 'aborted' : 'succeeded',
          targetBranch: 'main',
          conflicts: [],
        };
        return operation;
      });
      await page.route('http://update-base.test/', (route) =>
        route.fulfill({ contentType: 'text/html', body: html }),
      );
      await page.goto('http://update-base.test/');
      const update = page.getByRole('button', { name: 'Update from main', exact: true });
      await update.focus();
      assert.equal(await update.evaluate((element) => element === document.activeElement), true);
      await page.keyboard.press('Enter');
      await page
        .getByRole('button', { name: 'Updating from main…' })
        .waitFor({ timeout: 5000 })
        .catch(async (error) => {
          throw new Error(
            error.message +
              '\n' +
              (await page.locator('body').innerText()) +
              '\nCalls: ' +
              JSON.stringify(calls) +
              '\nErrors: ' +
              JSON.stringify(errors),
          );
        });
      operation = {
        status: 'conflicted',
        targetBranch: 'main',
        conflicts: ['server/workspace/service.ts'],
      };
      await page
        .getByRole('status')
        .filter({ hasText: 'Resolve conflicts: server/workspace/service.ts' })
        .waitFor();
      assert.equal(
        await page.getByRole('button', { name: 'Publish as pull request' }).isDisabled(),
        true,
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      if (process.env.DEPLOY_TEST_ARTIFACTS) {
        mkdirSync(process.env.DEPLOY_TEST_ARTIFACTS, { recursive: true });
        await page.screenshot({
          path: join(process.env.DEPLOY_TEST_ARTIFACTS, `update-conflicts-${width}.png`),
          fullPage: true,
        });
      }
      await page.getByRole('button', { name: 'Continue update' }).click();
      await page.getByRole('status').filter({ hasText: 'Up to date with main.' }).waitFor();
      assert.equal(
        await page.getByRole('button', { name: 'Publish as pull request' }).isDisabled(),
        false,
      );
      await page.getByRole('button', { name: 'Update from main', exact: true }).click();
      await page.getByRole('button', { name: 'Abort update' }).click();
      await page
        .getByRole('status')
        .filter({ hasText: 'Update aborted; workspace restored.' })
        .waitFor();
      fail = true;
      await page.getByRole('button', { name: 'Update from main', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'Task computer is unavailable' }).waitFor();
      fail = false;
      await page.getByRole('button', { name: 'Update from main', exact: true }).click();
      await page.getByRole('button', { name: 'Abort update' }).click();
      await page
        .getByRole('status')
        .filter({ hasText: 'Update aborted; workspace restored.' })
        .waitFor();
      assert.deepEqual(calls, [
        'update',
        'continue',
        'update',
        'abort',
        'update',
        'update',
        'abort',
      ]);
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});
