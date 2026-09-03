'use client';

import { useMemo, useState } from 'react';
import type { AppCardData } from '../components/dashboard/AppCard';
import {
  FleetTopologyBoard,
  type ApplicationGraph,
  type DeploymentSummary,
  type FleetReplica,
  type FleetTopologySnapshot,
  type RuntimeComponent,
} from '../components/dashboard/FleetTopologyBoard';
import type { FleetTotals } from '../components/dashboard/FleetStrip';

type CloudMode = 'home' | 'away' | 'rejoining';

const MODES: Record<CloudMode, { label: string; state: string; summary: string }> = {
  home: {
    label: 'At home',
    state: 'Everything is serving',
    summary: 'Home is coordinating every application. Carry-on is docked and ready to leave.',
  },
  away: {
    label: 'Away',
    state: 'Two places, one cloud',
    summary: 'Home keeps serving while Carry-on runs its admitted applications without a link.',
  },
  rejoining: {
    label: 'Rejoining',
    state: 'Verified changes are converging',
    summary: 'Signed state and content exchange before either site advances its checkpoint.',
  },
};

const DEPLOYMENTS: DeploymentSummary[] = [
  { name: 'family-hub', type: 'application-graph', activeSpecDigest: 'demo-family' },
  { name: 'shared-notes', type: 'application-graph', activeSpecDigest: 'demo-notes' },
  { name: 'media-room', type: 'application-graph', activeSpecDigest: 'demo-media' },
];

const HISTORY = {
  family: [10.8, 11.4, 10.9, 12.1, 11.8, 12.4, 12.7, 12.2, 12.6, 12.4],
  notes: [6.8, 7.2, 7.7, 7.5, 8.2, 8.0, 8.4, 8.1, 8.3, 8.1],
  media: [4.1, 4.8, 5.2, 5.8, 5.4, 6.0, 6.1, 5.9, 6.5, 6.3],
};

function component(
  name: string,
  role: string,
  options: {
    instances?: number;
    dependencies?: string[];
    mounts?: Record<string, { resource: string; readOnly: boolean }>;
    profile?: string;
  } = {},
): RuntimeComponent {
  return {
    name,
    displayName: name,
    role,
    desiredInstances: options.instances ?? 1,
    minimumReady: 1,
    dependencies: options.dependencies ?? [],
    interfaces: { http: { port: role === 'database' ? 5432 : 3000, protocol: 'tcp' } },
    mounts: options.mounts ?? {},
    source: options.profile
      ? { kind: 'image', reference: 'postgres:17' }
      : { kind: 'build', context: '.' },
    profile: options.profile ? { profile: options.profile } : undefined,
    blocked: false,
  };
}

function applicationGraph(
  name: string,
  components: RuntimeComponent[],
  resources: Array<[name: string, role: string, readOnly?: boolean]>,
): ApplicationGraph {
  const byName = Object.fromEntries(components.map((item) => [item.name, item]));
  const routeComponent = components[0]?.name ?? 'application';
  return {
    runtime: {
      applicationId: `app-${name}`,
      alias: name,
      siteId: 'site-home',
      specDigest: `demo-${name}`,
      ready: true,
      configuration: { missing: [] },
      execution: {
        componentOrder: components.map((item) => item.name),
        components: byName,
        services: {
          [`${routeComponent}-http`]: {
            id: `${routeComponent}-http`,
            component: routeComponent,
            interface: 'http',
            protocol: 'tcp',
            containerPort: 3000,
          },
        },
        routes: {
          public: {
            name: 'public',
            serviceId: `${routeComponent}-http`,
            hostname: `${name}.local`,
            path: '/',
            discoverable: true,
          },
        },
        volumeAttachments: resources.map(([resource, , readOnly = false]) => ({
          resource,
          consistencyGroup: name,
          ownership: 'application',
          backup: { policy: 'daily', retentionCopies: 7 },
          suitcase: { allowedDataModes: readOnly ? ['none'] : ['manual', 'automatic'] },
          component: routeComponent,
          mountPaths: [`/data/${resource}`],
          readOnly,
          desiredInstances: components[0]?.desiredInstances ?? 1,
        })),
        findings: [],
      },
      actual: {
        placements: components.map((item) => ({
          componentKey: item.name,
          desiredInstances: item.desiredInstances,
          state: 'ready',
        })),
        instances: components.flatMap((item) =>
          Array.from({ length: item.desiredInstances }, () => ({
            componentKey: item.name,
            status: 'running',
            health: 'healthy',
          })),
        ),
        volumes: resources.map(([resource]) => ({ resourceKey: resource, state: 'ready' })),
      },
    },
    spec: {
      metadata: { description: `${name} application boundary` },
      resources: Object.fromEntries(
        resources.map(([resource, role, readOnly = false]) => [
          resource,
          {
            displayName: resource,
            durability: 'durable',
            dataRole: role,
            access: readOnly ? 'read only' : 'single writer',
            consistencyGroup: name,
            ownership: 'application',
            backup: { policy: 'daily', retentionCopies: 7 },
            suitcase: { allowedDataModes: readOnly ? ['none'] : ['manual', 'automatic'] },
          },
        ]),
      ),
    },
    configuration: {
      siteId: 'site-home',
      ready: true,
      missing: [],
      configurationDigest: `demo-${name}-configuration`,
      declarations: {},
    },
    legacyEnvironment: [],
  };
}

const GRAPHS: Record<string, ApplicationGraph> = {
  'family-hub': applicationGraph(
    'family-hub',
    [
      component('web', 'application', {
        instances: 2,
        dependencies: ['database'],
        mounts: { uploads: { resource: 'uploads', readOnly: false } },
      }),
      component('database', 'database', {
        mounts: { data: { resource: 'database-data', readOnly: false } },
        profile: 'deploy.local/postgres@1',
      }),
    ],
    [
      ['uploads', 'files'],
      ['database-data', 'database'],
    ],
  ),
  'shared-notes': applicationGraph(
    'shared-notes',
    [
      component('application', 'application', {
        mounts: {
          notes: { resource: 'notes-data', readOnly: false },
          attachments: { resource: 'attachments', readOnly: false },
        },
      }),
    ],
    [
      ['notes-data', 'database'],
      ['attachments', 'files'],
    ],
  ),
  'media-room': applicationGraph(
    'media-room',
    [
      component('application', 'application', {
        mounts: {
          config: { resource: 'config', readOnly: false },
          library: { resource: 'library', readOnly: true },
        },
      }),
    ],
    [
      ['config', 'files'],
      ['library', 'media', true],
    ],
  ),
};

function replica(
  appId: string,
  siteId: string,
  mode: CloudMode,
  syncPolicy: FleetReplica['sync_policy'],
): FleetReplica {
  const rejoining = mode === 'rejoining' && siteId === 'site-carry-on';
  return {
    app_id: appId,
    site_id: siteId,
    runtime_status: 'running',
    sync_policy: syncPolicy,
    pending_changesets: rejoining ? 2 : 0,
    pending_blobs: rejoining ? 1 : 0,
    open_conflicts: 0,
    readiness: { readyOffline: true, runtimeReady: true, dataReady: !rejoining },
  };
}

function demoState(mode: CloudMode): {
  cards: AppCardData[];
  totals: FleetTotals;
  snapshot: FleetTopologySnapshot;
} {
  const rateScale = mode === 'away' ? 0.94 : mode === 'rejoining' ? 1.01 : 1;
  const cards: AppCardData[] = [
    {
      name: 'family-hub',
      status: 'running',
      severity: 'healthy',
      crashLooping: false,
      cpuPercent: 24,
      memUsageBytes: 858_993_459,
      memLimitBytes: 2_147_483_648,
      memPercent: 40,
      rps: 12.4 * rateScale,
      errPct: 0.02,
      p95: 42,
      requestsLastMin: Math.round(744 * rateScale),
      rpsHistory: HISTORY.family.map((value) => value * rateScale),
    },
    {
      name: 'shared-notes',
      status: 'running',
      severity: 'healthy',
      crashLooping: false,
      cpuPercent: 17,
      memUsageBytes: 536_870_912,
      memLimitBytes: 1_073_741_824,
      memPercent: 50,
      rps: 8.1 * rateScale,
      errPct: 0.04,
      p95: 58,
      requestsLastMin: Math.round(486 * rateScale),
      rpsHistory: HISTORY.notes.map((value) => value * rateScale),
    },
    {
      name: 'media-room',
      status: 'running',
      severity: 'healthy',
      crashLooping: false,
      cpuPercent: 11,
      memUsageBytes: 751_619_277,
      memLimitBytes: 2_147_483_648,
      memPercent: 35,
      rps: 6.3 * rateScale,
      errPct: 0,
      p95: 31,
      requestsLastMin: Math.round(378 * rateScale),
      rpsHistory: HISTORY.media.map((value) => value * rateScale),
    },
  ];
  const carryOnReplicas = [
    replica('app-family-hub', 'site-carry-on', mode, 'automatic'),
    replica('app-shared-notes', 'site-carry-on', mode, 'manual'),
  ];
  const homeReplicas = cards.map((card) =>
    replica(
      `app-${card.name}`,
      'site-home',
      mode,
      card.name === 'media-room' ? 'none' : 'automatic',
    ),
  );
  const totalRps = cards.reduce((sum, card) => sum + card.rps, 0);
  const requestsLastMin = cards.reduce((sum, card) => sum + card.requestsLastMin, 0);
  const totalMemUsageBytes = cards.reduce((sum, card) => sum + card.memUsageBytes, 0);
  const totalMemLimitBytes = cards.reduce((sum, card) => sum + card.memLimitBytes, 0);
  return {
    cards,
    totals: {
      apps: cards.length,
      running: cards.length,
      unhealthy: 0,
      totalRps,
      totalCpuPercent: 32,
      totalMemUsageBytes,
      totalMemLimitBytes,
      errorRatePct: mode === 'away' ? 0.04 : mode === 'rejoining' ? 0.03 : 0.02,
      requestsLastMin,
    },
    snapshot: {
      topology: {
        fleet: {
          id: 'fleet-home',
          name: 'Personal cloud',
          homeSiteId: 'site-home',
          protocolVersion: 1,
        },
        sites: [
          {
            id: 'site-home',
            node_id: 'node-home',
            name: 'Home',
            kind: 'home',
            mode: 'docked',
            platform: 'linux',
            architecture: 'arm64',
            revoked_at: null,
            replicas: homeReplicas,
          },
          {
            id: 'site-carry-on',
            node_id: 'node-carry-on',
            name: 'Carry-on',
            kind: 'suitcase',
            mode: mode === 'home' ? 'docked' : mode,
            platform: 'linux',
            architecture: 'arm64',
            revoked_at: null,
            replicas: carryOnReplicas,
          },
        ],
        applications: cards.map((card) => ({
          app_id: `app-${card.name}`,
          name: card.name,
          status: 'running',
          release_generation: 1,
          replica_count: card.name === 'media-room' ? 1 : 2,
          ready_replicas: card.name === 'media-room' ? 1 : 2,
        })),
        replicas: [...homeReplicas, ...carryOnReplicas],
        conflicts: [],
      },
      nodeFleet: {
        defaultNodeId: 'node-home',
        nodes: [
          {
            id: 'node-home',
            name: 'home-server',
            kind: 'coordinator',
            platform: 'linux',
            architecture: 'arm64',
            online: true,
            revokedAt: null,
            apps: cards.map((card) => ({ name: card.name, status: 'running' })),
          },
          {
            id: 'node-carry-on',
            name: 'carry-on',
            kind: 'agent',
            platform: 'linux',
            architecture: 'arm64',
            online: mode !== 'away',
            revokedAt: null,
            apps: cards.slice(0, 2).map((card) => ({ name: card.name, status: 'running' })),
          },
        ],
      },
      graphs: GRAPHS,
    },
  };
}

export function PublicCloudGraph() {
  const [mode, setMode] = useState<CloudMode>('home');
  const active = MODES[mode];
  const demo = useMemo(() => demoState(mode), [mode]);

  return (
    <section
      className="public-topology-showcase"
      data-audit-cloud-state={mode}
      aria-label="Interactive personal cloud topology"
    >
      <header className="public-topology-moment">
        <span>
          <small>Operating moment</small>
          <strong>{active.state}</strong>
          <p>{active.summary}</p>
        </span>
        <div className="public-topology-modes" role="tablist" aria-label="Cloud operating moment">
          {(Object.keys(MODES) as CloudMode[]).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={mode === key}
              data-audit-cloud-mode={key}
              onClick={() => setMode(key)}
            >
              {MODES[key].label}
            </button>
          ))}
        </div>
      </header>
      <FleetTopologyBoard
        cards={demo.cards}
        deployments={DEPLOYMENTS}
        totals={demo.totals}
        snapshot={demo.snapshot}
        variant="showcase"
      />
    </section>
  );
}
