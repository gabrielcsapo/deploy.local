import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RouterProvider } from 'react-flight-router/client';
import { DataSeeds, type DataSeed } from './seeds';
import { InboxProvider } from './hooks';
import Computers from '../computers/page.client';
import Agents from '../agents/page.client';
import Settings from '../settings/page.client';
import Account from '../start/account.client';
import Home from '../start/home.client';
import Start from '../start/page.client';
import Inbox from '../inbox/page.client';
import Backups from '../settings/backups/page.client';
import type { ComponentType } from 'react';

const at = Date.parse('2026-11-13T02:00:00Z');
const agent = {
  id: 'keeper',
  name: 'Keeper',
  job: 'Check the dashboard',
  computers: [],
  looksAfter: [],
  schedule: { enabled: false, time: '08:00' },
  apps: [],
  triggers: [],
};
const models = { choices: [], local: [], defaults: {}, providers: [] };
const seed: DataSeed = {
  owner: 'owner',
  at,
  origin: 'https://deploy.test',
  timeZone: 'America/New_York',
  cursor: 1,
  data: {
    '/api/auth/account': { username: 'owner', name: 'Owner', welcomed: true, hasPasskey: true },
    '/api/agents': { agents: [agent], timezone: 'America/New_York' },
    '/api/agents/keeper/conversation': {
      events: [
        {
          id: 'reply',
          kind: 'reply',
          at: '2026-11-12T23:30:00Z',
          agent: 'keeper',
          paragraphs: ['Ready for review'],
        },
      ],
      tracking: { running: [], runs: [], items: [] },
    },
    '/api/approvals': { rules: [], suggestions: [] },
    '/api/projects': { projects: [] },
    '/api/computers': {
      computers: [
        {
          id: 'coordinator',
          name: 'My computer',
          roles: ['coordinator'],
          supportedRoles: ['coordinator'],
          workerIds: [],
          online: true,
          doing: [],
        },
      ],
    },
    '/api/model-settings': models,
    '/api/package-keys': { keys: [] },
    '/api/backups': { backups: [], restores: [], schedules: [] },
    '/api/devices': {
      devices: [{ id: 'phone', name: 'My phone', createdAt: '2026-11-12T23:30:00Z' }],
    },
    '/api/ssh-keys': {
      keys: [
        {
          id: 'key',
          name: 'Laptop',
          type: 'ed25519',
          fingerprint: 'fixture',
          createdAt: '2026-11-12T23:30:00Z',
          lastUsedAt: '2026-11-13T00:30:00Z',
        },
      ],
      server: { enabled: false, port: null, hostFingerprints: [], knownHostsLine: '' },
    },
    '/api/inbox?state=waiting': { items: [], cursor: 1 },
    '/api/inbox?state=answered': { items: [], cursor: 1 },
    '/api/catalog': {
      releases: [{ id: 'reader', name: 'Reader', summary: 'Read feeds', release: '1' }],
    },
    '/api/catalog/releases/reader/1': { release: { application: { resources: {} } } },
  },
};
function render(component: ComponentType, path: string, value: DataSeed | null = seed) {
  return renderToStaticMarkup(
    h(RouterProvider, {
      initialUrl: path,
      initialSegments: {},
      initialParams: {},
      createFromReadableStream: async () => undefined,
      callServer: async () => undefined,
      children: h(DataSeeds, {
        seed: value ?? undefined,
        children: h(InboxProvider, { children: h(component) }),
      }),
    }),
  );
}
test('safe dashboard pages render their seeded content before effects, with stable hydration clocks', () => {
  const previous = process.env.TZ;
  try {
    for (const [component, path, text] of [
      [Home, '/dashboard', 'What should we build?'],
      [Computers, '/dashboard/computers', 'My computer'],
      [Computers, '/dashboard/computers/models', 'Models'],
      [Agents, '/dashboard/agents/keeper', 'Ready for review'],
      [Agents, '/dashboard/agents/keeper/tune', 'Keeper'],
      [Agents, '/dashboard/agents/new', 'Agents'],
      [Settings, '/dashboard/settings', 'Appearance'],
      [Settings, '/dashboard/settings/approvals', 'Keeper'],
      [Account, '/dashboard/settings/account', 'Laptop'],
      [Account, '/dashboard/settings/devices', 'My phone'],
      [Backups, '/dashboard/settings/backups', 'Backups'],
      [Inbox, '/dashboard/inbox', 'Waiting on you'],
      [Start, '/dashboard/discover', 'Reader'],
      [Start, '/dashboard/discover/reader', 'Install Reader'],
    ] as [ComponentType, string, string][]) {
      process.env.TZ = 'UTC';
      const html = render(component, path);
      assert.ok(html.includes(text), `${path} contains its first data`);
      assert.doesNotMatch(html, /class="[^"]*\bdl-skel(?:eton)?\b/, path);
      process.env.TZ = 'Pacific/Honolulu';
      assert.equal(
        render(component, path),
        html,
        `${path} has the same first render in another timezone`,
      );
    }
    // Explicitly remove the seed for the unauthenticated/client-only path.
    assert.match(render(Computers, '/dashboard/computers', null), /dl-skel/);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('Waiting on you groups decisions by what you must do, one compact row and one action each', () => {
  const minutes = (count: number) => new Date(at - count * 60000).toISOString();
  const base = { text: '', from: 'warden', actions: [], state: 'waiting' as const };
  const items = [
    {
      ...base,
      id: 'rollback:forma:r1',
      kind: 'rollback',
      title: 'Roll back forma?',
      text: 'The release to imac did not finish.',
      fromName: 'Warden',
      projectId: 'forma',
      projectName: 'forma',
      createdAt: minutes(17),
      actions: [
        { id: 'rollback', label: 'Roll back', primary: true },
        { id: 'keep', label: 'Keep release' },
      ],
    },
    {
      ...base,
      id: 'design:forma:upload-history:abc',
      kind: 'other',
      title: 'Show upload history in Media sources',
      text: 'Changed 2 boards on design/upload-history.',
      fromName: 'Gabriel',
      projectId: 'forma',
      projectName: 'forma',
      createdAt: minutes(60),
      actions: [{ id: 'approve', label: 'Approve design', primary: true }],
    },
    {
      ...base,
      id: 'question:q',
      kind: 'question',
      title: 'Choose where to publish release notes',
      fromName: 'Release notes writer',
      taskId: 'task',
      createdAt: minutes(40),
    },
  ];
  const html = render(Inbox, '/dashboard/inbox', {
    ...seed,
    data: { ...seed.data, '/api/inbox?state=waiting': { items, cursor: 1 } },
  });
  const labels = [...html.matchAll(/class="dl-group-label">([^<]+)<span class="dl-n">(\d+)/g)];
  assert.deepEqual(
    labels.map((match) => `${match[1]} ${match[2]}`),
    ['Decide now 1', 'Review designs 1', 'Answer 1'],
  );
  // The risky decision is a raised card with both choices inline.
  assert.match(
    html,
    /class="dl-asks-risk"[\s\S]*Roll back forma\?[\s\S]*forma · Warden asked · 17 min ago[\s\S]*Roll back<\/button>[\s\S]*Keep release<\/button>/,
  );
  // Every other item is one row: kind mark, the change in words, one line of context, one action.
  assert.match(
    html,
    /dl-tile k-design[\s\S]*Show upload history in Media sources<\/b><span>forma · Gabriel · 1 hour ago<\/span>[\s\S]*>Review<\/a>/,
  );
  assert.match(
    html,
    /dl-tile k-question[\s\S]*Release notes writer · in a task · 40 min ago[\s\S]*>Answer<\/a>/,
  );
  assert.doesNotMatch(html, /Also changed/);
  // Answered stays one link away, beside the title.
  assert.match(
    html,
    /<h1 class="dl-display">Waiting on you<\/h1><a href="\/dashboard\/inbox\?tab=answered">Answered<\/a>/,
  );
  // At wide widths the first row opens beside the list.
  assert.match(html, /class="dl-asks-row on"[^>]*>[\s\S]*Show upload history/);
  assert.match(html, /class="dl-asks-detail"/);
});
