import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// Render the real decision/card; replace only the inbox subscription with a saved item.
test('design decisions use one preview card and keep answered history and other decisions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'design-chat-history-'));
  const output = join(root, 'render.mjs');
  const esbuild = createRequire(import.meta.resolve('vite'))('esbuild');
  try {
    await esbuild.build({
      stdin: {
        contents: `
          import React from 'react';
          import { renderToStaticMarkup } from 'react-dom/server';
          import { InboxDecision } from './app/routes/dashboard/v2/inbox/InboxDecision';
          import { DesignCard } from './app/routes/dashboard/v2/design/Review';
          import { Conversation } from './app/routes/dashboard/v2/conversation/Conversation';
          import { setItem } from 'fixture-inbox';
          export function render(item) { setItem(item); return renderToStaticMarkup(React.createElement(InboxDecision, {itemId: item.id})); }
          export function fallback(item, events) { return renderToStaticMarkup(React.createElement(DesignCard, {projectId: 'p', taskId: 't', design: {api: '/api/test', proposal: item}, events})); }
          export function history(item, events) { setItem(item); return renderToStaticMarkup(React.createElement(Conversation, {events})); }
        `,
        resolveDir: process.cwd(),
        loader: 'tsx',
      },
      outfile: output,
      bundle: true,
      platform: 'node',
      format: 'esm',
      loader: { '.css': 'empty' },
      banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
      plugins: [
        {
          name: 'fixture-inbox',
          setup(build: any) {
            build.onResolve({ filter: /^fixture-inbox$/ }, () => ({
              path: 'fixture-inbox',
              namespace: 'fixture',
            }));
            build.onResolve({ filter: /^\.\.\/data\/hooks$/ }, (args: any) =>
              args.importer.endsWith('/inbox/InboxDecision.tsx')
                ? { path: 'fixture-inbox', namespace: 'fixture' }
                : undefined,
            );
            build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
              contents: `export { useAgentName } from ${JSON.stringify(resolve('app/routes/dashboard/v2/data/hooks.tsx'))}; let item; export function setItem(value) { item = value; } export function useInbox() { return {items: [item], loading: false, answer() {}, retry() {}}; }`,
              loader: 'js',
              resolveDir: process.cwd(),
            }));
          },
        },
      ],
      logLevel: 'silent',
    });
    const { render, fallback, history } = await import(pathToFileURL(output).href);
    const item = {
      id: 'design:p:b:c',
      title: 'Welcome: ask first',
      from: 'agent',
      projectId: 'p',
      taskId: 't',
      kind: 'other',
      state: 'waiting',
      createdAt: new Date().toISOString(),
      actions: [{ id: 'approve', label: 'Approve design' }],
    };
    const html = render(item);
    assert.equal((html.match(/aria-label="Design change"/g) ?? []).length, 1);
    assert.doesNotMatch(html, /dl-approval-head/);
    assert.match(html, /Before · main/);
    assert.match(html, /After · this task/);
    assert.match(html, /Review<\/a>/);
    assert.match(html, /Open in Design/);
    assert.match(html, /dashboard\/design\?review=design%3Ap%3Ab%3Ac/);
    const events = [{ kind: 'decision', id: 'd', at: item.createdAt, inboxItemId: item.id }];
    assert.equal(fallback(item, events), '');
    assert.match(fallback(item, []), /aria-label="Design change"/);
    const answered = {
      ...item,
      state: 'answered',
      answer: { actionId: 'approve', by: 'Gabriel', on: 'web', at: item.createdAt },
    };
    assert.match(render(answered), /aria-label="Design change"/);
    assert.match(render(answered), /Approved/);
    assert.doesNotMatch(render(answered), /starts building|is building it/);
    assert.equal(fallback(answered, events), '');
    const older = history(answered, [
      { ...events[0], at: '2020-01-01T12:00:00Z' },
      { kind: 'reply', id: 'reply', agent: 'agent', at: item.createdAt, paragraphs: ['Updated'] },
    ]);
    assert.match(older, /<details class="dl-chat-history">/);
    assert.match(older, /aria-label="Design change"/);
    assert.ok(older.indexOf('aria-label="Design change"') > older.indexOf('</details>'));
    const question = {
      ...item,
      id: 'question:q',
      kind: 'question',
      text: 'Which one?',
      actions: [{ id: 'answer', label: 'Answer' }],
    };
    assert.match(render(question), /Which one\?/);
    assert.doesNotMatch(render(question), /aria-label="Design change"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
