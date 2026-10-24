import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { resolve } from 'node:path';

const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {TerminalView} from './app/routes/dashboard/terminal.client.tsx';
import {ActivityRail, useActivityRail} from './app/routes/dashboard/task-activity-rail.client.tsx';
import './app/design-tokens.css';
import './app/motion.css';
import './app/native-workspace.css';
import './app/components/ui/ui.css';
import './app/routes/dashboard/terminal.css';
import '@xterm/xterm/css/xterm.css';
localStorage.setItem('deploy-sh-auth', JSON.stringify({username:'test', token:'fixture'}));
function Fixture() {
  const rail = useActivityRail('task');
  return <><button data-split-toggle="terminal" onClick={() => rail.toggle('terminal')}>Open Terminal</button><div className="ds-split-specimen" style={{height:600}}><ActivityRail rail={rail} jobs={[]}>
  {rail.tab === 'terminal' && <TerminalView taskId="task" workerId="worker" name="Test computer" />}
  </ActivityRail></div></>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;

test('Terminal tab renders unavailable states and Enable recovery at desktop and phone widths', async () => {
  const bundle = await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: { '@': resolve('app') } },
    plugins: [
      react(),
      {
        name: 'task-terminal-test',
        resolveId(id) {
          if (id === 'task-terminal-test') return resolve('task-terminal-test.tsx');
        },
        load(id) {
          if (id === resolve('task-terminal-test.tsx')) return entry;
        },
      },
    ],
    build: {
      write: false,
      rollupOptions: { input: 'task-terminal-test', output: { inlineDynamicImports: true } },
    },
  });
  const script = bundle.output.find((item) => item.type === 'chunk').code;
  const css = bundle.output
    .filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'))
    .map((item) => item.source)
    .join('\n');
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script type="module">${script.replaceAll('</script', '<\\/script')}</script></body></html>`;
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      let status = {
        name: 'Test computer',
        supported: true,
        taskSupported: true,
        enabled: false,
        online: true,
        locallyDisabled: false,
        recent: [],
      };
      let enabled = false;
      await page.route('http://task-terminal.test/', (route) =>
        route.fulfill({ contentType: 'text/html', body: html }),
      );
      await page.route('**/api/workspace/computers/worker/terminal', (route) => {
        if (route.request().method() === 'POST') {
          enabled = true;
          status = { ...status, enabled: true, online: false };
        }
        return route.fulfill({ json: status });
      });
      await page.goto('http://task-terminal.test/');
      await page.getByRole('button', { name: 'Open Terminal', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Terminal access is disabled' }).waitFor();
      await page.getByRole('button', { name: 'Enable terminal access', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Computer is offline' }).waitFor();
      assert.equal(enabled, true);
      status = { ...status, online: true, taskSupported: false };
      await page.getByRole('button', { name: 'Open a new session' }).click();
      await page
        .getByRole('status')
        .filter({ hasText: 'Update deploy.local on Test computer' })
        .waitFor();
      await page.getByRole('button', { name: 'Close task panel' }).click();
      assert.equal(
        await page.getByRole('button', { name: 'Open Terminal', exact: true }).isVisible(),
        true,
      );
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});
