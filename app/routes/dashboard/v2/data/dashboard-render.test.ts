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
    '/api/v2/auth/account': { username: 'owner', name: 'Owner', welcomed: true, hasPasskey: true },
    '/api/v2/agents': { agents: [agent], timezone: 'America/New_York' },
    '/api/v2/agents/keeper/conversation': {
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
    '/api/v2/approvals': { rules: [], suggestions: [] },
    '/api/v2/projects': { projects: [] },
    '/api/v2/computers': {
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
    '/api/v2/computers/models': models,
    '/api/v2/package-keys': { keys: [] },
    '/api/v2/backups': { backups: [], restores: [], schedules: [] },
    '/api/v2/devices': {
      devices: [{ id: 'phone', name: 'My phone', createdAt: '2026-11-12T23:30:00Z' }],
    },
    '/api/workspace/ssh-keys': {
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
    '/api/v2/inbox?state=waiting': { items: [], cursor: 1 },
    '/api/v2/inbox?state=answered': { items: [], cursor: 1 },
    '/api/catalog': {
      releases: [{ id: 'reader', name: 'Reader', summary: 'Read feeds', release: '1' }],
    },
    '/api/catalog/reader/1': { release: { application: { resources: {} } } },
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
