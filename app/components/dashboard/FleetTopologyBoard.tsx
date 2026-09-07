'use client';

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Link, useRouter } from 'react-flight-router/client';
import type { AppCardData, Severity } from './AppCard';
import type { FleetTotals } from './FleetStrip';
import { MiniSparkline } from './Sparkline';
import { getAuth, appUrl } from '../../routes/dashboard/detail/shared';
import { formatBytes } from '../../utils';
import { useDialogFocus } from '../useDialogFocus';

export interface DeploymentSummary {
  name: string;
  type: string;
  envVars?: string | null;
  activeSpecDigest?: string | null;
  desiredSpecDigest?: string | null;
}

export interface FleetReplica {
  app_id: string;
  site_id: string;
  runtime_status: string;
  sync_policy: 'automatic' | 'manual' | 'none';
  pending_changesets: number;
  pending_blobs: number;
  open_conflicts: number;
  readiness: { readyOffline?: boolean; runtimeReady?: boolean; dataReady?: boolean };
}

export interface FleetSite {
  id: string;
  node_id: string | null;
  name: string;
  kind: 'home' | 'suitcase';
  mode: 'docked' | 'away' | 'rejoining' | 'recovery' | 'revoked';
  platform: string | null;
  architecture: string | null;
  revoked_at: string | null;
  replicas: FleetReplica[];
}

export interface TopologyApplication {
  app_id: string;
  name: string;
  status: string | null;
  release_generation: number;
  replica_count: number;
  ready_replicas: number;
}

export interface FleetTopology {
  fleet: { id: string; name: string; homeSiteId: string; protocolVersion: number };
  sites: FleetSite[];
  applications: TopologyApplication[];
  replicas: FleetReplica[];
  conflicts: Array<{ id: string; app_id: string }>;
}

export interface FleetNode {
  id: string;
  name: string;
  kind: 'coordinator' | 'agent';
  platform: string | null;
  architecture: string | null;
  online: boolean;
  revokedAt: string | null;
  apps: Array<{ name: string; status: string }>;
}

export interface NodeFleet {
  defaultNodeId: string | null;
  nodes: FleetNode[];
}

export interface RuntimeComponent {
  name: string;
  displayName?: string;
  role: string;
  desiredInstances: number;
  minimumReady: number;
  dependencies: readonly string[];
  interfaces: Record<string, { port: number; protocol: string }>;
  mounts: Record<string, { resource: string; readOnly: boolean }>;
  source: { kind: 'image'; reference: string } | { kind: 'build'; context: string };
  profile?: { profile: string };
  blocked: boolean;
}

export interface RuntimeResponse {
  applicationId: string;
  alias: string;
  siteId: string;
  specDigest: string;
  ready: boolean;
  configuration: { missing: string[] };
  execution: {
    componentOrder: readonly string[];
    components: Record<string, RuntimeComponent>;
    services: Record<
      string,
      { id: string; component: string; interface: string; protocol: string; containerPort: number }
    >;
    routes: Record<
      string,
      { name: string; serviceId: string; hostname?: string; path: string; discoverable: boolean }
    >;
    volumeAttachments: Array<{
      resource: string;
      consistencyGroup: string;
      ownership: string;
      backup: { policy: string; retentionCopies: number };
      suitcase: { allowedDataModes: string[] };
      component: string;
      mountPaths: readonly string[];
      readOnly: boolean;
      desiredInstances: number;
    }>;
    findings: Array<{ code: string; severity: string; message: string }>;
  };
  actual: {
    placements: Array<{ componentKey: string; desiredInstances: number; state: string }>;
    instances: Array<{ componentKey: string; status: string; health: string }>;
    volumes: Array<{ resourceKey: string; state: string }>;
  } | null;
}

export interface DesiredSpec {
  metadata?: { description?: string };
  components?: Record<
    string,
    {
      displayName?: string;
      image?: string;
      build?: { context: string };
      role: string;
      instances: number;
      minimumReady: number;
      interfaces: Record<string, { port: number; protocol: string }>;
      mounts: Record<string, { resource: string; readOnly: boolean }>;
      dependsOn: string[];
      profile?: string;
    }
  >;
  resources: Record<
    string,
    {
      displayName?: string;
      durability: string;
      dataRole: string;
      access: string;
      consistencyGroup: string;
      ownership: string;
      backup: { policy: string; retentionCopies: number };
      suitcase: { allowedDataModes: string[] };
    }
  >;
  routes?: Record<string, { to: string; hostname?: string; path: string; discoverable: boolean }>;
}

export interface ConfigurationDeclaration {
  type: 'string' | 'secret' | 'boolean' | 'number' | 'integer' | 'url' | 'enum' | 'file';
  required: boolean;
  description?: string;
  default?: string | number | boolean | null;
  allowedValues?: Array<string | number | boolean | null>;
  scope: 'application' | 'site';
  configured: boolean;
  revision: number;
  updatedAt: string | null;
}

export interface ConfigurationResponse {
  siteId: string;
  ready: boolean;
  missing: string[];
  configurationDigest: string;
  declarations: Record<string, ConfigurationDeclaration>;
}

export interface ApplicationGraph {
  runtime: RuntimeResponse | null;
  spec: DesiredSpec | null;
  configuration: ConfigurationResponse | null;
}

type GraphSelection =
  | { kind: 'cloud'; id: 'cloud' }
  | { kind: 'gateway'; id: 'gateway' }
  | { kind: 'application'; appName: string }
  | { kind: 'component'; appName: string; componentName: string }
  | { kind: 'resource'; appName: string; resourceName: string }
  | { kind: 'site'; siteId: string }
  | { kind: 'machine'; nodeId: string }
  | {
      kind: 'edge';
      id: string;
      appName?: string;
      siteId?: string;
      edgeType: 'traffic' | 'placement';
    };

interface Point {
  x: number;
  y: number;
}

type SignalDetail = 'serving' | 'flow' | 'health' | 'headroom' | 'continuity';

type SafariGestureEvent = Event & {
  clientX?: number;
  clientY?: number;
  scale?: number;
};

interface ContextLayout {
  width: number;
  height: number;
  componentPositions: Record<string, Point>;
  resourcePositions: Record<string, Point>;
  routeTarget: string | null;
}

interface AppWorldLayout {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  internal: ContextLayout;
}

const WORLD_WIDTH = 1540;
const CONTEXT_WIDTH = 790;
const COMPONENT_WIDTH = 178;
const COMPONENT_HEIGHT = 62;
const SITE_WIDTH = 236;
const SEVERITY_TONE: Record<Severity, string> = {
  healthy: 'success',
  idle: 'neutral',
  building: 'warning',
  degraded: 'warning',
  down: 'danger',
};
const SEVERITY_ORDER: Record<Severity, number> = {
  down: 0,
  degraded: 1,
  building: 2,
  healthy: 3,
  idle: 4,
};

export interface FleetTopologySnapshot {
  topology: FleetTopology;
  nodeFleet: NodeFleet;
  graphs: Record<string, ApplicationGraph>;
}

type FleetTopologyVariant = 'dashboard' | 'showcase';

function authHeaders(): Record<string, string> {
  const auth = getAuth();
  return auth ? { 'x-deploy-username': auth.username, 'x-deploy-token': auth.token } : {};
}

function selectionKey(selection: GraphSelection): string {
  if (selection.kind === 'application') return `application:${selection.appName}`;
  if (selection.kind === 'component')
    return `component:${selection.appName}:${selection.componentName}`;
  if (selection.kind === 'resource')
    return `resource:${selection.appName}:${selection.resourceName}`;
  if (selection.kind === 'site') return `site:${selection.siteId}`;
  if (selection.kind === 'machine') return `machine:${selection.nodeId}`;
  if (selection.kind === 'edge') return `edge:${selection.id}`;
  return selection.kind;
}

function applicationLayout(graph: ApplicationGraph | undefined): ContextLayout {
  const runtime = graph?.runtime;
  const componentNames = runtime?.execution.componentOrder.length
    ? [...runtime.execution.componentOrder]
    : ['application'];
  const components = runtime?.execution.components ?? {};
  const services = runtime?.execution.services ?? {};
  const route = Object.values(runtime?.execution.routes ?? {})[0];
  const routeTarget = route
    ? (Object.values(services).find((service) => service.id === route.serviceId)?.component ?? null)
    : (componentNames[0] ?? null);

  const depth = new Map<string, number>();
  const visit = (name: string, nextDepth: number, seen = new Set<string>()) => {
    if (seen.has(name)) return;
    const current = depth.get(name) ?? -1;
    if (nextDepth <= current) return;
    depth.set(name, nextDepth);
    const nextSeen = new Set(seen).add(name);
    for (const dependency of components[name]?.dependencies ?? []) {
      visit(dependency, nextDepth + 1, nextSeen);
    }
  };
  if (routeTarget) visit(routeTarget, 0);
  for (const name of componentNames) if (!depth.has(name)) visit(name, 0);

  const maxComponentDepth = Math.max(0, ...depth.values());
  const resources = [
    ...new Set([
      ...Object.keys(graph?.spec?.resources ?? {}),
      ...(runtime?.execution.volumeAttachments ?? []).map((item) => item.resource),
    ]),
  ];
  const resourceDepth = maxComponentDepth + 1;
  const columnCount = Math.max(1, resourceDepth + (resources.length > 0 ? 1 : 0));
  const availableWidth = CONTEXT_WIDTH - 52 - COMPONENT_WIDTH;
  const columnStep = columnCount > 1 ? availableWidth / (columnCount - 1) : 0;
  const byDepth = new Map<number, string[]>();
  for (const name of componentNames) {
    const value = depth.get(name) ?? 0;
    byDepth.set(value, [...(byDepth.get(value) ?? []), name]);
  }

  const componentPositions: Record<string, Point> = {};
  for (const [value, names] of byDepth) {
    names.forEach((name, index) => {
      componentPositions[name] = { x: 24 + value * columnStep, y: 76 + index * 76 };
    });
  }
  const resourcePositions: Record<string, Point> = {};
  resources.forEach((name, index) => {
    resourcePositions[name] = { x: 24 + resourceDepth * columnStep, y: 76 + index * 76 };
  });
  const tallestColumn = Math.max(
    1,
    resources.length,
    ...Array.from(byDepth.values()).map((names) => names.length),
  );
  return {
    width: CONTEXT_WIDTH,
    height: Math.max(174, 104 + tallestColumn * 76),
    componentPositions,
    resourcePositions,
    routeTarget,
  };
}

export function FleetTopologyBoard({
  cards,
  deployments,
  totals,
  snapshot,
  variant = 'dashboard',
}: {
  cards: AppCardData[];
  deployments: DeploymentSummary[];
  totals: FleetTotals | null;
  snapshot?: FleetTopologySnapshot;
  variant?: FleetTopologyVariant;
}) {
  const isShowcase = variant === 'showcase';
  const { navigate } = useRouter();
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    originX: number;
    originY: number;
  } | null>(null);
  const viewRef = useRef({ x: 24, y: 24, zoom: 0.82 });
  const gestureRef = useRef<{
    zoom: number;
    worldX: number;
    worldY: number;
    cursorX: number;
    cursorY: number;
  } | null>(null);
  const [liveTopology, setLiveTopology] = useState<FleetTopology | null>(null);
  const [liveNodeFleet, setLiveNodeFleet] = useState<NodeFleet | null>(null);
  const [liveGraphs, setLiveGraphs] = useState<Record<string, ApplicationGraph>>({});
  const [liveLoading, setLiveLoading] = useState(true);
  const [refreshError, setRefreshError] = useState('');
  const [view, setView] = useState({ x: 24, y: 24, zoom: 0.82 });
  const [signalDetail, setSignalDetail] = useState<SignalDetail | null>(null);
  const [selectionHistory, setSelectionHistory] = useState<GraphSelection[]>([
    { kind: 'cloud', id: 'cloud' },
  ]);
  const [historyIndex, setHistoryIndex] = useState(0);
  // The graph is the command center's default context. Keep its full width
  // until the operator asks for detail by selecting something.
  const [inspectorOpen, setInspectorOpen] = useState(false);

  const topology = snapshot?.topology ?? liveTopology;
  const nodeFleet = snapshot?.nodeFleet ?? liveNodeFleet;
  const graphs = snapshot?.graphs ?? liveGraphs;
  const loading = snapshot ? false : liveLoading;

  const selection = selectionHistory[historyIndex] ?? ({ kind: 'cloud', id: 'cloud' } as const);
  const selectedKey = selectionKey(selection);

  const select = useCallback(
    (next: GraphSelection) => {
      if (selectionKey(next) === selectedKey) {
        if (!isShowcase) setInspectorOpen(true);
        return;
      }
      setSelectionHistory((current) => [...current.slice(0, historyIndex + 1), next]);
      setHistoryIndex((current) => current + 1);
      if (!isShowcase) setInspectorOpen(true);
    },
    [historyIndex, isShowcase, selectedKey],
  );

  const load = useCallback(async () => {
    try {
      const headers = authHeaders();
      const [topologyResponse, nodesResponse] = await Promise.all([
        fetch('/api/fleet/topology', { headers }),
        fetch('/api/nodes', { headers }),
      ]);
      if (!topologyResponse.ok) throw new Error('Fleet topology is temporarily unavailable');
      const nextTopology = (await topologyResponse.json()) as FleetTopology;
      setLiveTopology(nextTopology);
      if (nodesResponse.ok) setLiveNodeFleet((await nodesResponse.json()) as NodeFleet);

      const graphEntries = await Promise.all(
        deployments.map(async (deployment) => {
          const encoded = encodeURIComponent(deployment.name);
          const [runtimeResponse, specResponse, configurationResponse] = await Promise.all([
            fetch(`/api/deployments/${encoded}/application-runtime?revision=active`, { headers }),
            fetch(`/api/deployments/${encoded}/application-spec`, { headers }),
            fetch(`/api/deployments/${encoded}/configuration?revision=active`, { headers }),
          ]);
          const runtime = runtimeResponse.ok
            ? ((await runtimeResponse.json()) as RuntimeResponse)
            : null;
          const specBody = specResponse.ok
            ? ((await specResponse.json()) as {
                active?: DesiredSpec | null;
                desired?: DesiredSpec | null;
              })
            : null;
          const configuration = configurationResponse.ok
            ? ((await configurationResponse.json()) as ConfigurationResponse)
            : null;
          return [
            deployment.name,
            {
              runtime,
              spec: specBody?.active ?? specBody?.desired ?? null,
              configuration,
            },
          ] as const;
        }),
      );
      setLiveGraphs(Object.fromEntries(graphEntries));
      setRefreshError(nodesResponse.ok ? '' : 'Machine details are temporarily unavailable');
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : 'Fleet topology is unavailable');
    } finally {
      setLiveLoading(false);
    }
  }, [deployments]);

  useEffect(() => {
    if (snapshot) return;
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    return () => window.clearInterval(timer);
  }, [load, snapshot]);

  const refreshApplicationConfiguration = useCallback(async (applicationName: string) => {
    const response = await fetch(
      `/api/deployments/${encodeURIComponent(applicationName)}/configuration?revision=active`,
      { headers: authHeaders() },
    );
    if (!response.ok) throw new Error('Configuration readiness is temporarily unavailable');
    const configuration = (await response.json()) as ConfigurationResponse;
    setLiveGraphs((current) => ({
      ...current,
      [applicationName]: {
        ...(current[applicationName] ?? {
          runtime: null,
          spec: null,
        }),
        configuration,
      },
    }));
    return configuration;
  }, []);

  const sites = useMemo(
    () => topology?.sites.filter((site) => !site.revoked_at && site.mode !== 'revoked') ?? [],
    [topology],
  );
  const machines = useMemo(
    () => nodeFleet?.nodes.filter((node) => !node.revokedAt) ?? [],
    [nodeFleet],
  );
  const topologyApps = useMemo(
    () => new Map(topology?.applications.map((app) => [app.name, app]) ?? []),
    [topology],
  );
  const typeByApp = useMemo(
    () => new Map(deployments.map((deployment) => [deployment.name, deployment.type])),
    [deployments],
  );
  const appLayouts = useMemo(() => {
    let y = 72;
    return cards.map((card): AppWorldLayout => {
      const internal = applicationLayout(graphs[card.name]);
      const layout = {
        name: card.name,
        x: 356,
        y,
        width: internal.width,
        height: internal.height,
        internal,
      };
      y += internal.height + 44;
      return layout;
    });
  }, [cards, graphs]);
  const worldHeight = Math.max(
    660,
    (appLayouts.at(-1)?.y ?? 0) + (appLayouts.at(-1)?.height ?? 0) + 80,
    sites.length * 148 + 150,
  );
  const gatewayY = worldHeight / 2 - 64;
  const siteLayouts = useMemo(
    () =>
      sites.map((site, index) => ({
        site,
        x: 1260,
        y: ((index + 1) * worldHeight) / (sites.length + 1) - 58,
      })),
    [sites, worldHeight],
  );
  const attentionCount = cards.filter(
    (card) => card.severity === 'down' || card.severity === 'degraded',
  ).length;
  const conflictCount = topology?.conflicts.length ?? 0;
  const pendingSync =
    topology?.replicas.reduce(
      (sum, replica) => sum + Number(replica.pending_changesets) + Number(replica.pending_blobs),
      0,
    ) ?? 0;
  const memoryPercent =
    totals && totals.totalMemLimitBytes > 0
      ? (totals.totalMemUsageBytes / totals.totalMemLimitBytes) * 100
      : 0;
  const trafficHistory = useMemo(() => {
    const length = Math.max(0, ...cards.map((card) => card.rpsHistory.length));
    return Array.from({ length }, (_, index) =>
      cards.reduce((sum, card) => {
        const offset = length - card.rpsHistory.length;
        return sum + (card.rpsHistory[index - offset] ?? 0);
      }, 0),
    );
  }, [cards]);

  const fitGraph = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const availableWidth = rect.width - (inspectorOpen && rect.width > 900 ? 376 : 32);
    const zoom = Math.min(
      1,
      Math.max(0.34, Math.min(availableWidth / WORLD_WIDTH, rect.height / worldHeight)),
    );
    const nextView = {
      zoom,
      x: Math.max(16, (availableWidth - WORLD_WIDTH * zoom) / 2),
      y: Math.max(18, (rect.height - worldHeight * zoom) / 2),
    };
    viewRef.current = nextView;
    setView(nextView);
  }, [inspectorOpen, worldHeight]);

  useEffect(() => {
    if (!loading) requestAnimationFrame(fitGraph);
  }, [fitGraph, loading]);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const commitView = (next: { x: number; y: number; zoom: number }) => {
      viewRef.current = next;
      setView(next);
    };
    const zoomAt = (nextZoom: number, clientX: number, clientY: number) => {
      const rect = viewport.getBoundingClientRect();
      const cursorX = clientX - rect.left;
      const cursorY = clientY - rect.top;
      const current = viewRef.current;
      const worldX = (cursorX - current.x) / current.zoom;
      const worldY = (cursorY - current.y) / current.zoom;
      const zoom = Math.min(1.55, Math.max(0.32, nextZoom));
      commitView({
        zoom,
        x: cursorX - worldX * zoom,
        y: cursorY - worldY * zoom,
      });
    };
    const belongsToCanvas = (event: Event) => {
      const path = event.composedPath();
      if (!path.includes(viewport)) return false;
      return !path.some(
        (entry) =>
          entry instanceof HTMLElement &&
          (entry.classList.contains('cloud-inspector') ||
            entry.classList.contains('cloud-quick-dock')),
      );
    };
    const onWheel = (event: WheelEvent) => {
      if (!belongsToCanvas(event)) return;
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        const zoomDelta = Math.max(-32, Math.min(32, event.deltaY));
        zoomAt(viewRef.current.zoom * Math.exp(-zoomDelta * 0.008), event.clientX, event.clientY);
        return;
      }
      const current = viewRef.current;
      commitView({
        ...current,
        x: current.x - event.deltaX,
        y: current.y - event.deltaY,
      });
    };
    const onGestureStart = (rawEvent: Event) => {
      const event = rawEvent as SafariGestureEvent;
      if (!belongsToCanvas(event)) return;
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const cursorX = (event.clientX ?? rect.left + rect.width / 2) - rect.left;
      const cursorY = (event.clientY ?? rect.top + rect.height / 2) - rect.top;
      const current = viewRef.current;
      gestureRef.current = {
        zoom: current.zoom,
        worldX: (cursorX - current.x) / current.zoom,
        worldY: (cursorY - current.y) / current.zoom,
        cursorX,
        cursorY,
      };
    };
    const onGestureChange = (rawEvent: Event) => {
      const event = rawEvent as SafariGestureEvent;
      const gesture = gestureRef.current;
      if (!gesture) return;
      event.preventDefault();
      const zoom = Math.min(1.55, Math.max(0.32, gesture.zoom * (event.scale ?? 1)));
      commitView({
        zoom,
        x: gesture.cursorX - gesture.worldX * zoom,
        y: gesture.cursorY - gesture.worldY * zoom,
      });
    };
    const onGestureEnd = (event: Event) => {
      event.preventDefault();
      gestureRef.current = null;
    };

    // Capture at the window boundary. Chrome and Safari can reserve a pinch
    // for page zoom before a target listener runs; a non-passive capture
    // listener claims gestures that began on the topology canvas first.
    window.addEventListener('wheel', onWheel, { capture: true, passive: false });
    window.addEventListener('gesturestart', onGestureStart, { capture: true, passive: false });
    window.addEventListener('gesturechange', onGestureChange, { capture: true, passive: false });
    window.addEventListener('gestureend', onGestureEnd, { capture: true, passive: false });
    return () => {
      window.removeEventListener('wheel', onWheel, { capture: true });
      window.removeEventListener('gesturestart', onGestureStart, { capture: true });
      window.removeEventListener('gesturechange', onGestureChange, { capture: true });
      window.removeEventListener('gestureend', onGestureEnd, { capture: true });
    };
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button, a')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      originX: view.x,
      originY: view.y,
    };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setView((current) => ({
      ...current,
      x: drag.originX + event.clientX - drag.x,
      y: drag.originY + event.clientY - drag.y,
    }));
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  };

  const activeAppName =
    selection.kind === 'application' ||
    selection.kind === 'component' ||
    selection.kind === 'resource'
      ? selection.appName
      : selection.kind === 'edge'
        ? selection.appName
        : undefined;

  return (
    <section
      className={`cloud-command-surface ${isShowcase ? 'is-showcase' : ''}`}
      aria-labelledby="cloud-topology-title"
    >
      <SignalRail
        totals={totals}
        trafficHistory={trafficHistory}
        memoryPercent={memoryPercent}
        attention={attentionCount}
        pendingSync={pendingSync}
        conflicts={conflictCount}
        sites={sites.length}
        onOpen={setSignalDetail}
      />

      {signalDetail ? (
        <SignalDetailDialog
          detail={signalDetail}
          cards={cards}
          totals={totals}
          topology={topology}
          pendingSync={pendingSync}
          conflicts={conflictCount}
          linksEnabled={!isShowcase}
          onClose={() => setSignalDetail(null)}
        />
      ) : null}

      <div className="cloud-topology-toolbar">
        <div>
          <div className="flex items-center gap-2">
            <span className="fleet-live-dot" aria-hidden />
            <h2 id="cloud-topology-title">Live topology</h2>
            {loading ? <span className="cloud-loading-label">resolving graph…</span> : null}
          </div>
          <p>
            Follow traffic from ingress to applications and the places they run.
            {isShowcase ? ' Select anything to follow it.' : ' Select anything for context.'}
          </p>
        </div>
        <div className="cloud-toolbar-actions">
          {refreshError ? <span className="cloud-partial-view">△ {refreshError}</span> : null}
          <button
            type="button"
            aria-label="Previous selection"
            disabled={historyIndex === 0}
            onClick={() => setHistoryIndex((value) => Math.max(0, value - 1))}
          >
            ←
          </button>
          <button
            type="button"
            aria-label="Next selection"
            disabled={historyIndex >= selectionHistory.length - 1}
            onClick={() =>
              setHistoryIndex((value) => Math.min(selectionHistory.length - 1, value + 1))
            }
          >
            →
          </button>
          <span className="cloud-toolbar-separator" />
          <button
            type="button"
            aria-label="Zoom out"
            onClick={() =>
              setView((current) => ({ ...current, zoom: Math.max(0.32, current.zoom - 0.1) }))
            }
          >
            −
          </button>
          <button type="button" className="cloud-zoom-value" onClick={fitGraph}>
            {Math.round(view.zoom * 100)}%
          </button>
          <button
            type="button"
            aria-label="Zoom in"
            onClick={() =>
              setView((current) => ({ ...current, zoom: Math.min(1.55, current.zoom + 0.1) }))
            }
          >
            +
          </button>
        </div>
      </div>

      <div
        ref={viewportRef}
        className={`cloud-graph-viewport ${dragRef.current ? 'is-dragging' : ''}`}
        data-audit-topology-viewport
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div
          className="cloud-graph-world"
          style={
            {
              width: WORLD_WIDTH,
              height: worldHeight,
              transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.zoom})`,
            } as CSSProperties
          }
        >
          <span className="cloud-lane-label" style={{ left: 48, top: 34 }}>
            01 · ingress
          </span>
          <span className="cloud-lane-label" style={{ left: 356, top: 34 }}>
            02 · applications
          </span>
          <span className="cloud-lane-label" style={{ left: 1260, top: 34 }}>
            03 · places
          </span>

          <svg className="cloud-world-edges" viewBox={`0 0 ${WORLD_WIDTH} ${worldHeight}`}>
            <defs>
              <marker
                id="cloud-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" />
              </marker>
              <marker
                id="cloud-arrow-muted"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" />
              </marker>
            </defs>
            {appLayouts.map((layout) => {
              const card = cards.find((item) => item.name === layout.name)!;
              const target = layout.internal.routeTarget
                ? layout.internal.componentPositions[layout.internal.routeTarget]
                : undefined;
              const end = {
                x: layout.x + (target?.x ?? 18),
                y: layout.y + (target?.y ?? layout.height / 2) + COMPONENT_HEIGHT / 2,
              };
              return (
                <WorldEdge
                  key={`traffic-${layout.name}`}
                  id={`traffic-${layout.name}`}
                  from={{ x: 264, y: gatewayY + 64 }}
                  to={end}
                  label={`${formatRps(card.rps)} qps`}
                  active={
                    selectedKey === `edge:traffic-${layout.name}` || activeAppName === layout.name
                  }
                  flowing={card.rps > 0}
                  tone={card.errPct > 5 ? 'danger' : card.errPct > 1 ? 'warning' : 'flow'}
                  onSelect={() =>
                    select({
                      kind: 'edge',
                      id: `traffic-${layout.name}`,
                      appName: layout.name,
                      edgeType: 'traffic',
                    })
                  }
                />
              );
            })}
            {appLayouts.flatMap((layout) => {
              const topologyApp = topologyApps.get(layout.name);
              if (!topologyApp) return [];
              return siteLayouts.flatMap(({ site, x, y }) => {
                const placed =
                  site.kind === 'home' ||
                  site.replicas.some((replica) => replica.app_id === topologyApp.app_id);
                if (!placed) return [];
                const replica = site.replicas.find((item) => item.app_id === topologyApp.app_id);
                const edgeId = `placement-${layout.name}-${site.id}`;
                return [
                  <WorldEdge
                    key={edgeId}
                    id={edgeId}
                    from={{ x: layout.x + layout.width, y: layout.y + layout.height / 2 }}
                    to={{ x, y: y + 56 }}
                    label={placementLabel(site, replica)}
                    active={selectedKey === `edge:${edgeId}`}
                    muted
                    tone={
                      replica &&
                      (Number(replica.open_conflicts) > 0 || Number(replica.pending_changesets) > 0)
                        ? 'warning'
                        : 'muted'
                    }
                    onSelect={() =>
                      select({
                        kind: 'edge',
                        id: edgeId,
                        appName: layout.name,
                        siteId: site.id,
                        edgeType: 'placement',
                      })
                    }
                  />,
                ];
              });
            })}
          </svg>

          <button
            type="button"
            className={`cloud-gateway-node ${selectedKey === 'gateway' ? 'is-selected' : ''}`}
            style={{ left: 44, top: gatewayY }}
            onClick={() => select({ kind: 'gateway', id: 'gateway' })}
          >
            <span className="cloud-node-kicker">Internet + LAN</span>
            <span className="cloud-node-title">
              <strong>Home gateway</strong>
              <i className="tone-success">online</i>
            </span>
            <span className="cloud-node-copy">
              Routes traffic across {cards.length} applications
            </span>
            <span className="cloud-node-metrics">
              <b>{formatRps(totals?.totalRps ?? 0)} qps</b>
              <b>{totals?.errorRatePct.toFixed(1) ?? '—'}% errors</b>
            </span>
            <span className="cloud-node-capacity">
              <i style={{ width: `${Math.min(100, totals?.totalCpuPercent ?? 0)}%` }} />
            </span>
          </button>

          {appLayouts.map((layout) => {
            const card = cards.find((item) => item.name === layout.name)!;
            return (
              <ApplicationContext
                key={layout.name}
                layout={layout}
                card={card}
                type={typeByApp.get(layout.name) ?? 'application'}
                topology={topologyApps.get(layout.name)}
                graph={graphs[layout.name]}
                selection={selection}
                dimmed={Boolean(activeAppName && activeAppName !== layout.name)}
                onSelect={select}
              />
            );
          })}

          {siteLayouts.map(({ site, x, y }) => (
            <SiteNode
              key={site.id}
              site={site}
              machines={machines}
              x={x}
              y={y}
              selectedKey={selectedKey}
              onSelect={select}
            />
          ))}
        </div>

        <div className="cloud-canvas-help">
          <span>drag to move</span>
          <span>pinch to zoom</span>
          <span className="cloud-flow-key">
            <i /> live requests
          </span>
          <span className="cloud-placement-key">
            <i /> placement
          </span>
        </div>

        {isShowcase ? null : (
          <QuickDock
            selection={selection}
            onFit={fitGraph}
            navigate={navigate}
            onCommand={(appName) =>
              window.dispatchEvent(
                new CustomEvent('deploy:command-palette', {
                  detail: appName ? { appName } : undefined,
                }),
              )
            }
          />
        )}

        {!isShowcase && inspectorOpen ? (
          <Inspector
            selection={selection}
            cards={cards}
            graphs={graphs}
            topology={topology}
            sites={sites}
            machines={machines}
            totals={totals}
            onRefreshConfiguration={refreshApplicationConfiguration}
            onClose={() => setInspectorOpen(false)}
          />
        ) : !isShowcase ? (
          <button
            type="button"
            className="cloud-inspector-reopen"
            onClick={() => setInspectorOpen(true)}
          >
            Inspect selection
          </button>
        ) : null}
      </div>
    </section>
  );
}

function SignalRail({
  totals,
  trafficHistory,
  memoryPercent,
  attention,
  pendingSync,
  conflicts,
  sites,
  onOpen,
}: {
  totals: FleetTotals | null;
  trafficHistory: number[];
  memoryPercent: number;
  attention: number;
  pendingSync: number;
  conflicts: number;
  sites: number;
  onOpen: (detail: SignalDetail) => void;
}) {
  const headroom = Math.max(0, 100 - memoryPercent);
  return (
    <div className="cloud-signal-rail" aria-label="Personal cloud signals">
      <button
        type="button"
        className={`cloud-signal ${totals?.unhealthy ? 'tone-warning' : 'tone-success'}`}
        onClick={() => onOpen('serving')}
        aria-haspopup="dialog"
        data-audit-signal="serving"
      >
        <i className="cloud-signal-action" aria-hidden>
          inspect ↗
        </i>
        <span>Serving</span>
        <strong>{totals ? `${totals.running} / ${totals.apps} apps` : '—'}</strong>
        <small>{attention ? `${attention} need attention` : 'all applications available'}</small>
      </button>
      <button
        type="button"
        className="cloud-signal cloud-signal-flow"
        onClick={() => onOpen('flow')}
        aria-haspopup="dialog"
        data-audit-signal="flow"
      >
        <i className="cloud-signal-action" aria-hidden>
          inspect ↗
        </i>
        <span>Flow</span>
        <strong>{totals ? `${formatRps(totals.totalRps)} req/s` : '—'}</strong>
        <small>
          {totals
            ? `${totals.requestsLastMin.toLocaleString()} requests · last minute`
            : 'collecting traffic'}
        </small>
        <span className="cloud-signal-spark" aria-hidden>
          <MiniSparkline data={trafficHistory} width={150} height={36} gradient />
        </span>
      </button>
      <button
        type="button"
        className={`cloud-signal ${(totals?.errorRatePct ?? 0) > 1 ? 'tone-warning' : 'tone-success'}`}
        onClick={() => onOpen('health')}
        aria-haspopup="dialog"
        data-audit-signal="health"
      >
        <i className="cloud-signal-action" aria-hidden>
          inspect ↗
        </i>
        <span>Request health</span>
        <strong>{totals ? `${totals.errorRatePct.toFixed(1)}% errors` : '—'}</strong>
        <small>5xx · last 60 seconds</small>
      </button>
      <button
        type="button"
        className="cloud-signal"
        onClick={() => onOpen('headroom')}
        aria-haspopup="dialog"
        data-audit-signal="headroom"
      >
        <i className="cloud-signal-action" aria-hidden>
          inspect ↗
        </i>
        <span>Headroom</span>
        <strong>{totals ? `${headroom.toFixed(0)}% free` : '—'}</strong>
        <small>
          {totals
            ? `${formatBytes(totals.totalMemUsageBytes)} application memory`
            : 'collecting usage'}
        </small>
      </button>
      <button
        type="button"
        className={`cloud-signal ${conflicts ? 'tone-danger' : pendingSync ? 'tone-warning' : 'tone-success'}`}
        onClick={() => onOpen('continuity')}
        aria-haspopup="dialog"
        data-audit-signal="continuity"
      >
        <i className="cloud-signal-action" aria-hidden>
          inspect ↗
        </i>
        <span>Continuity</span>
        <strong>
          {conflicts
            ? `${conflicts} conflicts`
            : pendingSync
              ? `${pendingSync} queued`
              : `${sites} sites ready`}
        </strong>
        <small>
          {conflicts
            ? 'reconciliation needs review'
            : pendingSync
              ? 'changes are converging'
              : 'home and portable sites aligned'}
        </small>
      </button>
    </div>
  );
}

interface SignalDetailRow {
  name: string;
  detail: string;
  value: string;
  href?: string;
  tone?: 'success' | 'warning' | 'danger' | 'neutral';
}

function SignalDetailDialog({
  detail,
  cards,
  totals,
  topology,
  pendingSync,
  conflicts,
  linksEnabled,
  onClose,
}: {
  detail: SignalDetail;
  cards: AppCardData[];
  totals: FleetTotals | null;
  topology: FleetTopology | null;
  pendingSync: number;
  conflicts: number;
  linksEnabled: boolean;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogFocus(true, dialogRef, onClose);
  const content = signalDetailContent(detail, cards, totals, topology, pendingSync, conflicts);

  return (
    <div className="cloud-signal-modal-layer">
      <div className="cloud-signal-modal-backdrop" onClick={onClose} aria-hidden />
      <div
        ref={dialogRef}
        className="cloud-signal-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-audit-signal-modal={detail}
      >
        <header>
          <span>
            <small>Personal cloud · live signal</small>
            <strong id={titleId}>{content.title}</strong>
          </span>
          <button type="button" onClick={onClose} aria-label="Close signal details">
            ×
          </button>
        </header>
        <section className={`cloud-signal-modal-summary tone-${content.tone}`}>
          <span>{content.label}</span>
          <strong>{content.value}</strong>
          <p>{content.summary}</p>
        </section>
        <section className="cloud-signal-modal-breakdown">
          <div className="cloud-signal-modal-section-title">
            <span>{content.section}</span>
            <small>{content.rows.length} visible</small>
          </div>
          <div className="cloud-signal-modal-rows">
            {content.rows.length ? (
              content.rows.map((row) => {
                const body = (
                  <>
                    <span>
                      <strong>{row.name}</strong>
                      <small>{row.detail}</small>
                    </span>
                    <b className={`tone-${row.tone ?? 'neutral'}`}>{row.value}</b>
                  </>
                );
                return row.href && linksEnabled ? (
                  <Link key={`${row.name}-${row.href}`} to={row.href} onClick={onClose}>
                    {body}
                  </Link>
                ) : (
                  <div key={`${row.name}-${row.detail}`}>{body}</div>
                );
              })
            ) : (
              <p className="cloud-signal-modal-empty">No activity is present for this signal.</p>
            )}
          </div>
        </section>
        <footer>
          <span>Updated continuously from the command center</span>
          <button type="button" onClick={onClose}>
            Return to topology
          </button>
        </footer>
      </div>
    </div>
  );
}

function signalDetailContent(
  detail: SignalDetail,
  cards: AppCardData[],
  totals: FleetTotals | null,
  topology: FleetTopology | null,
  pendingSync: number,
  conflicts: number,
) {
  if (detail === 'serving') {
    const rows: SignalDetailRow[] = [...cards]
      .sort((left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity])
      .map((card) => ({
        name: card.name,
        detail: card.crashLooping
          ? 'restart loop detected'
          : `${card.requestsLastMin} requests · last minute`,
        value: card.status,
        href: `/dashboard/${encodeURIComponent(card.name)}`,
        tone:
          card.severity === 'down'
            ? 'danger'
            : card.severity === 'degraded' || card.severity === 'building'
              ? 'warning'
              : card.severity === 'healthy'
                ? 'success'
                : 'neutral',
      }));
    return {
      title: 'Serving applications',
      label: 'Available now',
      value: `${totals?.running ?? 0} / ${totals?.apps ?? cards.length}`,
      summary: totals?.unhealthy
        ? `${totals.unhealthy} application${totals.unhealthy === 1 ? '' : 's'} need an operator.`
        : 'Every admitted application is available through Home.',
      section: 'Application posture',
      rows,
      tone: totals?.unhealthy ? 'warning' : 'success',
    } as const;
  }
  if (detail === 'flow') {
    const rows: SignalDetailRow[] = [...cards]
      .sort((left, right) => right.rps - left.rps)
      .map((card) => ({
        name: card.name,
        detail: `${card.requestsLastMin.toLocaleString()} requests · ${card.p95 ? `${Math.round(card.p95)} ms p95` : 'latency pending'}`,
        value: `${formatRps(card.rps)} /s`,
        href: `/dashboard/${encodeURIComponent(card.name)}/requests`,
        tone: card.rps > 0 ? 'success' : 'neutral',
      }));
    return {
      title: 'Request flow',
      label: 'Crossing Home now',
      value: `${formatRps(totals?.totalRps ?? 0)} req/s`,
      summary: `${(totals?.requestsLastMin ?? 0).toLocaleString()} requests crossed the gateway in the last minute.`,
      section: 'Traffic by application',
      rows,
      tone: 'flow',
    } as const;
  }
  if (detail === 'health') {
    const rows: SignalDetailRow[] = [...cards]
      .sort(
        (left, right) => right.errPct - left.errPct || right.requestsLastMin - left.requestsLastMin,
      )
      .map((card) => ({
        name: card.name,
        detail: `${card.requestsLastMin.toLocaleString()} requests · last minute`,
        value: `${card.errPct.toFixed(1)}% errors`,
        href: `/dashboard/${encodeURIComponent(card.name)}/requests`,
        tone: card.errPct > 5 ? 'danger' : card.errPct > 1 ? 'warning' : 'success',
      }));
    const rate = totals?.errorRatePct ?? 0;
    return {
      title: 'Request health',
      label: '5xx rate · last 60 seconds',
      value: `${rate.toFixed(1)}%`,
      summary:
        rate > 1
          ? 'Failed requests are concentrated below. Open an application to inspect exact paths and traces.'
          : 'Requests are completing without a material server-error rate.',
      section: 'Errors by application',
      rows,
      tone: rate > 5 ? 'danger' : rate > 1 ? 'warning' : 'success',
    } as const;
  }
  if (detail === 'headroom') {
    const limit = totals?.totalMemLimitBytes ?? 0;
    const used = totals?.totalMemUsageBytes ?? 0;
    const free = limit > 0 ? Math.max(0, 100 - (used / limit) * 100) : 0;
    const rows: SignalDetailRow[] = [...cards]
      .sort((left, right) => right.memPercent - left.memPercent)
      .map((card) => ({
        name: card.name,
        detail: `${card.cpuPercent.toFixed(1)}% CPU · ${formatBytes(card.memUsageBytes)} used`,
        value: card.memLimitBytes ? `${card.memPercent.toFixed(0)}% memory` : 'limit not set',
        href: `/dashboard/${encodeURIComponent(card.name)}/resources`,
        tone: card.memPercent > 90 ? 'danger' : card.memPercent > 75 ? 'warning' : 'neutral',
      }));
    return {
      title: 'Application headroom',
      label: 'Memory remaining',
      value: limit > 0 ? `${free.toFixed(0)}% free` : 'Limits pending',
      summary: `${formatBytes(used)} is in use across application containers; host capacity is tracked separately.`,
      section: 'Runtime usage',
      rows,
      tone: free < 10 ? 'danger' : free < 25 ? 'warning' : 'success',
    } as const;
  }

  const siteRows: SignalDetailRow[] = (topology?.sites ?? []).map((site) => {
    const queued = site.replicas.reduce(
      (sum, replica) => sum + Number(replica.pending_changesets) + Number(replica.pending_blobs),
      0,
    );
    const siteConflicts = site.replicas.reduce(
      (sum, replica) => sum + Number(replica.open_conflicts),
      0,
    );
    return {
      name: site.name,
      detail: `${site.kind} · ${site.replicas.length} application${site.replicas.length === 1 ? '' : 's'}`,
      value: siteConflicts ? `${siteConflicts} conflicts` : queued ? `${queued} queued` : site.mode,
      href: '/dashboard/sites',
      tone: siteConflicts ? 'danger' : queued || site.mode === 'rejoining' ? 'warning' : 'success',
    };
  });
  return {
    title: 'Site continuity',
    label: 'Home and portable sites',
    value: conflicts
      ? `${conflicts} conflicts`
      : pendingSync
        ? `${pendingSync} queued`
        : `${topology?.sites.length ?? 0} ready`,
    summary: conflicts
      ? 'Reconciliation requires an administrator decision before every site can converge.'
      : pendingSync
        ? 'Attributable changes are waiting to exchange or finish applying.'
        : 'Every connected site is aligned with Home.',
    section: 'Site posture',
    rows: siteRows,
    tone: conflicts ? 'danger' : pendingSync ? 'warning' : 'success',
  } as const;
}

function WorldEdge({
  id,
  from,
  to,
  label,
  active,
  flowing = false,
  muted = false,
  tone,
  onSelect,
}: {
  id: string;
  from: Point;
  to: Point;
  label: string;
  active: boolean;
  flowing?: boolean;
  muted?: boolean;
  tone: 'flow' | 'warning' | 'danger' | 'muted';
  onSelect: () => void;
}) {
  const bend = Math.max(30, (to.x - from.x) * 0.46);
  const path = `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`;
  const labelX = from.x + (to.x - from.x) * 0.5;
  const labelY = from.y + (to.y - from.y) * 0.5 - 8;
  return (
    <g data-edge-id={id} className={`cloud-edge tone-${tone} ${active ? 'is-selected' : ''}`}>
      <path
        className="cloud-edge-line"
        d={path}
        markerEnd={`url(#${muted ? 'cloud-arrow-muted' : 'cloud-arrow'})`}
      />
      {flowing ? <path className="cloud-edge-pulse" d={path} /> : null}
      <path
        className="cloud-edge-hit"
        d={path}
        onClick={onSelect}
        role="button"
        tabIndex={0}
        aria-label={`Inspect ${label} connection`}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') onSelect();
        }}
      />
      <g
        className="cloud-edge-label"
        transform={`translate(${labelX} ${labelY})`}
        onClick={onSelect}
      >
        <rect
          x={-label.length * 3.15 - 7}
          y={-10}
          width={label.length * 6.3 + 14}
          height={20}
          rx={5}
        />
        <text textAnchor="middle" dominantBaseline="middle">
          {label}
        </text>
      </g>
    </g>
  );
}

function ApplicationContext({
  layout,
  card,
  type,
  topology,
  graph,
  selection,
  dimmed,
  onSelect,
}: {
  layout: AppWorldLayout;
  card: AppCardData;
  type: string;
  topology?: TopologyApplication;
  graph?: ApplicationGraph;
  selection: GraphSelection;
  dimmed: boolean;
  onSelect: (selection: GraphSelection) => void;
}) {
  const selected = selection.kind === 'application' && selection.appName === card.name;
  const runtime = graph?.runtime;
  const components = runtime?.execution.components ?? {};
  const resources = Object.keys(layout.internal.resourcePositions);
  const markerId = `context-arrow-${card.name.replace(/[^a-z0-9]/gi, '-')}`;
  const actualReady = (componentName: string) =>
    runtime?.actual?.instances.filter(
      (instance) =>
        instance.componentKey === componentName &&
        instance.status === 'running' &&
        (instance.health === 'healthy' || instance.health === 'none' || !instance.health),
    ).length ?? 0;

  return (
    <section
      className={`cloud-app-context tone-${SEVERITY_TONE[card.severity]} ${selected ? 'is-selected' : ''} ${dimmed ? 'is-dimmed' : ''}`}
      style={{ left: layout.x, top: layout.y, width: layout.width, height: layout.height }}
      aria-label={`${card.name} application boundary`}
      data-audit-app={card.name}
    >
      <button
        type="button"
        className="cloud-context-header"
        data-audit-target="application"
        onClick={() => onSelect({ kind: 'application', appName: card.name })}
      >
        <span className={`cloud-status-dot tone-${SEVERITY_TONE[card.severity]}`} aria-hidden />
        <span className="min-w-0">
          <strong>{card.name}</strong>
          <small>
            {type} · release {topology?.release_generation ?? '—'}
          </small>
        </span>
        <span className="cloud-context-traffic">
          <b>{formatRps(card.rps)} qps</b>
          <small>{card.p95 ? `${Math.round(card.p95)} ms p95` : 'latency pending'}</small>
        </span>
        <span className="cloud-context-open">Inspect →</span>
      </button>

      <svg className="cloud-context-edges" viewBox={`0 0 ${layout.width} ${layout.height}`}>
        <defs>
          <marker
            id={markerId}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="5"
            markerHeight="5"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" />
          </marker>
        </defs>
        {Object.entries(components).flatMap(([name, component]) =>
          component.dependencies.flatMap((dependency) => {
            const from = layout.internal.componentPositions[name];
            const to = layout.internal.componentPositions[dependency];
            if (!from || !to) return [];
            return [
              <InternalEdge
                key={`${name}-${dependency}`}
                from={{ x: from.x + COMPONENT_WIDTH, y: from.y + COMPONENT_HEIGHT / 2 }}
                to={{ x: to.x, y: to.y + COMPONENT_HEIGHT / 2 }}
                markerId={markerId}
              />,
            ];
          }),
        )}
        {Object.entries(components).flatMap(([name, component]) =>
          Object.values(component.mounts).flatMap((mount) => {
            const from = layout.internal.componentPositions[name];
            const to = layout.internal.resourcePositions[mount.resource];
            if (!from || !to) return [];
            return [
              <InternalEdge
                key={`${name}-${mount.resource}`}
                from={{ x: from.x + COMPONENT_WIDTH, y: from.y + COMPONENT_HEIGHT / 2 }}
                to={{ x: to.x, y: to.y + COMPONENT_HEIGHT / 2 }}
                markerId={markerId}
                data
              />,
            ];
          }),
        )}
      </svg>

      {Object.entries(layout.internal.componentPositions).map(([name, position]) => {
        const component = components[name];
        const desired = component?.desiredInstances ?? 1;
        const ready = runtime?.actual ? actualReady(name) : card.severity === 'down' ? 0 : desired;
        const componentSelected =
          selection.kind === 'component' &&
          selection.appName === card.name &&
          selection.componentName === name;
        return (
          <button
            key={name}
            type="button"
            className={`cloud-component-node ${componentSelected ? 'is-selected' : ''} ${component?.blocked ? 'tone-danger' : ''}`}
            style={{ left: position.x, top: position.y }}
            data-audit-target="component"
            data-audit-component={name}
            onClick={() => onSelect({ kind: 'component', appName: card.name, componentName: name })}
          >
            <span>
              {component?.role ?? 'application'} · {desired}{' '}
              {desired === 1 ? 'instance' : 'instances'}
            </span>
            <strong>{component?.displayName || name}</strong>
            <small>
              {ready}/{desired} ready
              {component?.profile ? ` · ${component.profile.profile.split('@')[0]}` : ''}
            </small>
          </button>
        );
      })}

      {resources.map((name) => {
        const position = layout.internal.resourcePositions[name];
        const resource = graph?.spec?.resources[name];
        const attachment = runtime?.execution.volumeAttachments.find(
          (item) => item.resource === name,
        );
        const resourceSelected =
          selection.kind === 'resource' &&
          selection.appName === card.name &&
          selection.resourceName === name;
        return (
          <button
            key={name}
            type="button"
            className={`cloud-resource-node ${resourceSelected ? 'is-selected' : ''}`}
            style={{ left: position.x, top: position.y }}
            data-audit-target="resource"
            data-audit-resource={name}
            onClick={() => onSelect({ kind: 'resource', appName: card.name, resourceName: name })}
          >
            <span>
              {resource?.dataRole || 'volume'} · {resource?.durability || 'durable'}
            </span>
            <strong>{resource?.displayName || name}</strong>
            <small>
              {attachment?.readOnly ? 'read only' : resource?.access || 'single writer'}
            </small>
          </button>
        );
      })}
    </section>
  );
}

function InternalEdge({
  from,
  to,
  markerId,
  data = false,
}: {
  from: Point;
  to: Point;
  markerId: string;
  data?: boolean;
}) {
  const bend = Math.max(18, Math.abs(to.x - from.x) * 0.42);
  return (
    <path
      className={data ? 'is-data' : ''}
      d={`M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`}
      markerEnd={`url(#${markerId})`}
    />
  );
}

function SiteNode({
  site,
  machines,
  x,
  y,
  selectedKey,
  onSelect,
}: {
  site: FleetSite;
  machines: FleetNode[];
  x: number;
  y: number;
  selectedKey: string;
  onSelect: (selection: GraphSelection) => void;
}) {
  const siteMachines = machines.filter(
    (machine) =>
      machine.id === site.node_id || (site.kind === 'home' && machine.kind === 'coordinator'),
  );
  const pending = site.replicas.reduce(
    (sum, replica) => sum + Number(replica.pending_changesets) + Number(replica.pending_blobs),
    0,
  );
  const conflicts = site.replicas.reduce((sum, replica) => sum + Number(replica.open_conflicts), 0);
  const tone =
    conflicts > 0 || site.mode === 'recovery'
      ? 'danger'
      : pending > 0 || site.mode === 'rejoining'
        ? 'warning'
        : site.kind === 'suitcase' && site.mode === 'away'
          ? 'accent'
          : 'success';
  return (
    <div
      className={`cloud-site-node tone-${tone} ${selectedKey === `site:${site.id}` ? 'is-selected' : ''}`}
      style={{ left: x, top: y, width: SITE_WIDTH }}
      data-audit-site={site.id}
    >
      <button type="button" onClick={() => onSelect({ kind: 'site', siteId: site.id })}>
        <span className="cloud-node-kicker">
          {site.kind === 'home' ? 'Home site' : `Suitcase · ${site.mode}`}
        </span>
        <span className="cloud-node-title">
          <strong>{site.name}</strong>
          <i className={`tone-${tone}`}>{site.mode === 'docked' ? 'connected' : site.mode}</i>
        </span>
        <span className="cloud-node-copy">
          {site.replicas.length} portable{' '}
          {site.replicas.length === 1 ? 'application' : 'applications'}
          {pending ? ` · ${pending} queued` : ''}
        </span>
      </button>
      {siteMachines.length ? (
        <div className="cloud-site-machines">
          {siteMachines.slice(0, 3).map((machine) => (
            <button
              key={machine.id}
              type="button"
              className={selectedKey === `machine:${machine.id}` ? 'is-selected' : ''}
              data-audit-machine={machine.id}
              onClick={() => onSelect({ kind: 'machine', nodeId: machine.id })}
            >
              <i className={machine.online ? 'tone-success' : 'tone-danger'} />
              {machine.name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function QuickDock({
  selection,
  onFit,
  navigate,
  onCommand,
}: {
  selection: GraphSelection;
  onFit: () => void;
  navigate: (to: string) => void;
  onCommand: (appName?: string) => void;
}) {
  const appName =
    selection.kind === 'application' ||
    selection.kind === 'component' ||
    selection.kind === 'resource'
      ? selection.appName
      : selection.kind === 'edge'
        ? selection.appName
        : undefined;
  const context = appName || (selection.kind === 'site' ? 'Suitcase site' : 'Personal cloud');
  return (
    <nav className="cloud-quick-dock" aria-label="Context actions">
      <span className="cloud-dock-context">{context}</span>
      <button type="button" onClick={() => onCommand(appName)} title="Open the command palette">
        <CommandIcon />
        Command
      </button>
      <button
        type="button"
        disabled={!appName}
        onClick={() => appName && navigate(`/dashboard/${encodeURIComponent(appName)}/terminal`)}
        title={appName ? `Open ${appName} terminal` : 'Select an application first'}
      >
        <TerminalGlyph />
        Terminal
      </button>
      <button
        type="button"
        disabled={!appName}
        onClick={() => appName && navigate(`/dashboard/${encodeURIComponent(appName)}/logs`)}
      >
        <LogsGlyph />
        Logs
      </button>
      <button type="button" onClick={onFit} title="Fit the entire cloud graph">
        <FitGlyph />
        Fit
      </button>
    </nav>
  );
}

function Inspector({
  selection,
  cards,
  graphs,
  topology,
  sites,
  machines,
  totals,
  onRefreshConfiguration,
  onClose,
}: {
  selection: GraphSelection;
  cards: AppCardData[];
  graphs: Record<string, ApplicationGraph>;
  topology: FleetTopology | null;
  sites: FleetSite[];
  machines: FleetNode[];
  totals: FleetTotals | null;
  onRefreshConfiguration: (applicationName: string) => Promise<ConfigurationResponse>;
  onClose: () => void;
}) {
  const [tab, setTab] = useState('overview');
  const key = selectionKey(selection);
  useEffect(() => setTab('overview'), [key]);

  const appName =
    selection.kind === 'application' ||
    selection.kind === 'component' ||
    selection.kind === 'resource'
      ? selection.appName
      : selection.kind === 'edge'
        ? selection.appName
        : undefined;
  const card = appName ? cards.find((item) => item.name === appName) : undefined;
  const graph = appName ? graphs[appName] : undefined;
  const component =
    selection.kind === 'component'
      ? graph?.runtime?.execution.components[selection.componentName]
      : undefined;
  const resource =
    selection.kind === 'resource' ? graph?.spec?.resources[selection.resourceName] : undefined;
  const site =
    selection.kind === 'site' ? sites.find((item) => item.id === selection.siteId) : undefined;
  const machine =
    selection.kind === 'machine'
      ? machines.find((item) => item.id === selection.nodeId)
      : undefined;

  const descriptor = inspectorDescriptor(
    selection,
    card,
    component,
    resource,
    site,
    machine,
    topology,
  );
  const tabs = inspectorTabs(selection);
  return (
    <aside
      className="cloud-inspector"
      aria-label={`${descriptor.title} details`}
      data-audit-inspector={selection.kind}
    >
      <header className="cloud-inspector-header">
        <span className={`cloud-inspector-icon tone-${descriptor.tone}`} aria-hidden>
          {descriptor.glyph}
        </span>
        <span className="min-w-0">
          <small>{descriptor.kicker}</small>
          <strong>{descriptor.title}</strong>
          <span>{descriptor.subtitle}</span>
        </span>
        <button type="button" onClick={onClose} aria-label="Close details">
          ×
        </button>
      </header>
      <div className="cloud-inspector-tabs" role="tablist">
        {tabs.map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={tab === item}
            className={tab === item ? 'is-active' : ''}
            onClick={() => setTab(item)}
          >
            {item}
          </button>
        ))}
      </div>
      <div className="cloud-inspector-body">
        <InspectorBody
          tab={tab}
          selection={selection}
          card={card}
          graph={graph}
          component={component}
          resource={resource}
          site={site}
          machine={machine}
          topology={topology}
          totals={totals}
          onRefreshConfiguration={onRefreshConfiguration}
        />
      </div>
      <InspectorActions selection={selection} appName={appName} />
    </aside>
  );
}

function InspectorBody({
  tab,
  selection,
  card,
  graph,
  component,
  resource,
  site,
  machine,
  topology,
  totals,
  onRefreshConfiguration,
}: {
  tab: string;
  selection: GraphSelection;
  card?: AppCardData;
  graph?: ApplicationGraph;
  component?: RuntimeComponent;
  resource?: DesiredSpec['resources'][string];
  site?: FleetSite;
  machine?: FleetNode;
  topology: FleetTopology | null;
  totals: FleetTotals | null;
  onRefreshConfiguration: (applicationName: string) => Promise<ConfigurationResponse>;
}) {
  if (selection.kind === 'cloud') {
    return (
      <>
        <InspectorSection title="Operating posture">
          <InspectorMetricGrid
            values={[
              ['Applications', `${totals?.running ?? 0}/${totals?.apps ?? 0}`],
              ['Traffic', `${formatRps(totals?.totalRps ?? 0)}/s`],
              ['Sites', String(topology?.sites.length ?? 0)],
              ['Errors', `${totals?.errorRatePct.toFixed(1) ?? '—'}%`],
            ]}
          />
        </InspectorSection>
        <InspectorSection title="What this graph means">
          <p>
            Traffic enters through Home, crosses an application boundary, then reaches its
            components and durable data. Placement lines show where the complete boundary can run.
          </p>
        </InspectorSection>
      </>
    );
  }
  if (selection.kind === 'gateway') {
    return (
      <>
        <InspectorSection title={tab === 'traffic' ? 'Live traffic' : 'Gateway posture'}>
          <InspectorMetricGrid
            values={[
              ['Requests', `${formatRps(totals?.totalRps ?? 0)}/s`],
              ['Last minute', (totals?.requestsLastMin ?? 0).toLocaleString()],
              ['5xx errors', `${totals?.errorRatePct.toFixed(1) ?? '—'}%`],
              ['App CPU', `${totals?.totalCpuPercent.toFixed(0) ?? '—'}%`],
            ]}
          />
        </InspectorSection>
        <InspectorSection title="Routing scope">
          <p>
            {topology?.applications.length ?? 0} application routes currently terminate inside this
            personal cloud.
          </p>
        </InspectorSection>
      </>
    );
  }
  if (selection.kind === 'application' && card) {
    if (tab === 'traffic') {
      return (
        <InspectorSection title="Request flow">
          <InspectorMetricGrid
            values={[
              ['Requests', `${formatRps(card.rps)}/s`],
              ['p95', card.p95 ? `${Math.round(card.p95)} ms` : '—'],
              ['Errors', `${card.errPct.toFixed(1)}%`],
              ['Last minute', card.requestsLastMin.toLocaleString()],
            ]}
          />
          <div className="cloud-inspector-spark">
            <MiniSparkline data={card.rpsHistory} width={300} height={70} gradient />
          </div>
        </InspectorSection>
      );
    }
    if (tab === 'runtime') {
      return (
        <InspectorSection title="Components">
          <InspectorList
            values={Object.values(graph?.runtime?.execution.components ?? {}).map((item) => [
              item.displayName || item.name,
              `${item.desiredInstances} desired · ${item.role}`,
            ])}
            empty="No runtime components are available."
          />
        </InspectorSection>
      );
    }
    if (tab === 'data') {
      return (
        <InspectorSection title="Durable resources">
          <InspectorList
            values={Object.entries(graph?.spec?.resources ?? {}).map(([name, item]) => [
              item.displayName || name,
              `${item.dataRole} · ${item.durability}`,
            ])}
            empty="No durable resources are declared."
          />
        </InspectorSection>
      );
    }
    if (tab === 'config') {
      return (
        <ApplicationConfigurationInspector
          applicationName={selection.appName}
          graph={graph}
          onRefresh={onRefreshConfiguration}
        />
      );
    }
    return (
      <>
        <InspectorSection title="Application posture">
          <InspectorMetricGrid
            values={[
              ['Status', card.status],
              ['Traffic', `${formatRps(card.rps)}/s`],
              ['CPU', `${card.cpuPercent.toFixed(1)}%`],
              ['Memory', `${card.memPercent.toFixed(0)}%`],
            ]}
          />
        </InspectorSection>
        <InspectorSection title="Boundary">
          <p>
            {Object.keys(graph?.runtime?.execution.components ?? {}).length || 1} components and{' '}
            {Object.keys(graph?.spec?.resources ?? {}).length} durable resources move together as
            one application context.
          </p>
        </InspectorSection>
      </>
    );
  }
  if (selection.kind === 'component' && component) {
    return (
      <>
        <InspectorSection title="Runtime intent">
          <InspectorMetricGrid
            values={[
              ['Instances', String(component.desiredInstances)],
              ['Minimum ready', String(component.minimumReady)],
              ['Role', component.role],
              ['Interfaces', String(Object.keys(component.interfaces).length)],
            ]}
          />
        </InspectorSection>
        <InspectorSection title="Connections">
          <InspectorList
            values={[
              ...component.dependencies.map((name) => [name, 'dependency'] as [string, string]),
              ...Object.entries(component.mounts).map(
                ([path, mount]) =>
                  [mount.resource, `${mount.readOnly ? 'read only' : 'read/write'} · ${path}`] as [
                    string,
                    string,
                  ],
              ),
            ]}
            empty="This component has no declared dependencies."
          />
        </InspectorSection>
        <InspectorSection title="Source">
          <p>
            {component.source.kind === 'image'
              ? component.source.reference
              : `Build from ${component.source.context}`}
          </p>
        </InspectorSection>
      </>
    );
  }
  if (selection.kind === 'resource') {
    const modes = resource?.suitcase.allowedDataModes ?? [];
    return (
      <>
        <InspectorSection title="Data contract">
          <InspectorMetricGrid
            values={[
              ['Role', resource?.dataRole ?? 'volume'],
              ['Durability', resource?.durability ?? 'durable'],
              ['Access', resource?.access ?? 'singleWriter'],
              ['Owner', resource?.ownership ?? 'application'],
            ]}
          />
        </InspectorSection>
        <InspectorSection title="Suitcase continuity">
          <p>
            {modes.length
              ? modes.join(' · ')
              : 'No portable data mode is declared for this resource.'}
          </p>
        </InspectorSection>
        <InspectorSection title="Recovery">
          <p>
            Backup policy: {resource?.backup.policy ?? 'not declared'} ·{' '}
            {resource?.backup.retentionCopies ?? 0} retained copies.
          </p>
        </InspectorSection>
      </>
    );
  }
  if (selection.kind === 'site' && site) {
    const queued = site.replicas.reduce(
      (sum, item) => sum + Number(item.pending_changesets) + Number(item.pending_blobs),
      0,
    );
    const conflicts = site.replicas.reduce((sum, item) => sum + Number(item.open_conflicts), 0);
    return (
      <>
        <InspectorSection title={tab === 'sync' ? 'Reconciliation' : 'Site posture'}>
          <InspectorMetricGrid
            values={[
              ['Mode', site.mode],
              ['Applications', String(site.replicas.length)],
              ['Queued', String(queued)],
              ['Conflicts', String(conflicts)],
            ]}
          />
        </InspectorSection>
        <InspectorSection title="Target">
          <p>
            {[site.platform, site.architecture].filter(Boolean).join(' · ') ||
              'Home-managed Docker runtime'}
          </p>
        </InspectorSection>
        {tab === 'readiness' ? (
          <InspectorNotice>
            Offline readiness combines runtime, artifact, configuration, data, and local access
            evidence. A green site is safe to grab and go.
          </InspectorNotice>
        ) : null}
      </>
    );
  }
  if (selection.kind === 'machine' && machine) {
    return (
      <>
        <InspectorSection title="Machine posture">
          <InspectorMetricGrid
            values={[
              ['Connection', machine.online ? 'online' : 'offline'],
              ['Kind', machine.kind],
              ['Applications', String(machine.apps.length)],
              ['Default target', machine.kind === 'coordinator' ? 'Home' : 'Agent'],
            ]}
          />
        </InspectorSection>
        <InspectorSection title="Runtime">
          <p>
            {[machine.platform, machine.architecture].filter(Boolean).join(' · ') ||
              'Capabilities pending'}
          </p>
        </InspectorSection>
        <InspectorSection title="Applications">
          <InspectorList
            values={machine.apps.map((item) => [item.name, item.status])}
            empty="No applications reported on this machine."
          />
        </InspectorSection>
      </>
    );
  }
  if (selection.kind === 'edge') {
    const placementSite = selection.siteId
      ? topology?.sites.find((item) => item.id === selection.siteId)
      : undefined;
    return (
      <>
        <InspectorSection
          title={selection.edgeType === 'traffic' ? 'Request flow' : 'Placement relationship'}
        >
          <InspectorMetricGrid
            values={
              selection.edgeType === 'traffic' && card
                ? [
                    ['Rate', `${formatRps(card.rps)}/s`],
                    ['p95', card.p95 ? `${Math.round(card.p95)} ms` : '—'],
                    ['Errors', `${card.errPct.toFixed(1)}%`],
                    ['Requests', card.requestsLastMin.toLocaleString()],
                  ]
                : [
                    ['Application', selection.appName ?? '—'],
                    ['Site', placementSite?.name ?? '—'],
                    ['Mode', placementSite?.mode ?? '—'],
                    ['Kind', placementSite?.kind ?? '—'],
                  ]
            }
          />
        </InspectorSection>
        <InspectorSection title="How to read it">
          <p>
            {selection.edgeType === 'traffic'
              ? 'Width is kept quiet so low-volume apps remain readable; the label is the exact current request rate and the moving trace shows active traffic.'
              : 'This edge is shown only when the fleet reports the application at that site. It is placement evidence, not an inferred relationship.'}
          </p>
        </InspectorSection>
      </>
    );
  }
  return <InspectorNotice>Live details for this selection are still resolving.</InspectorNotice>;
}

function ApplicationConfigurationInspector({
  applicationName,
  graph,
  onRefresh,
}: {
  applicationName: string;
  graph?: ApplicationGraph;
  onRefresh: (applicationName: string) => Promise<ConfigurationResponse>;
}) {
  const configuration = graph?.configuration;

  if (!configuration) {
    return (
      <>
        <InspectorSection title="Configuration">
          <p>This application has no v1 configuration contract yet.</p>
        </InspectorSection>
        <InspectorNotice>
          Redeploy from a deploy.yaml manifest to declare typed settings, required startup gates,
          and secret-safe inputs here.
        </InspectorNotice>
      </>
    );
  }

  const declarations = Object.entries(configuration.declarations).sort(([left], [right]) =>
    left.localeCompare(right),
  );

  return (
    <>
      <InspectorSection title="Configuration readiness">
        <div className="cloud-config-readiness">
          <span className={configuration.ready ? 'tone-success' : 'tone-warning'}>
            {configuration.ready ? 'Ready to start' : `${configuration.missing.length} missing`}
          </span>
          <small>{configuration.siteId}</small>
        </div>
        <p>
          The manifest names each setting and its validation rules. Stored values stay on this
          deploy.local site; secret contents are never returned to the browser.
        </p>
      </InspectorSection>

      {declarations.length ? (
        <section className="cloud-config-list" aria-label="Application configuration">
          {declarations.map(([key, declaration]) => (
            <ConfigurationSetting
              key={key}
              applicationName={applicationName}
              configuration={configuration}
              name={key}
              declaration={declaration}
              onRefresh={onRefresh}
            />
          ))}
        </section>
      ) : (
        <InspectorNotice>
          This application does not require any administrator-supplied settings.
        </InspectorNotice>
      )}
    </>
  );
}

function ConfigurationSetting({
  applicationName,
  configuration,
  name,
  declaration,
  onRefresh,
}: {
  applicationName: string;
  configuration: ConfigurationResponse;
  name: string;
  declaration: ConfigurationDeclaration;
  onRefresh: (applicationName: string) => Promise<ConfigurationResponse>;
}) {
  const initialValue =
    declaration.type === 'boolean'
      ? 'true'
      : declaration.allowedValues?.[0] === undefined
        ? ''
        : String(declaration.allowedValues[0]);
  const [value, setValue] = useState(initialValue);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage('');
    setError('');
    try {
      const parsedValue = parseConfigurationValue(declaration, value);
      const response = await fetch(
        `/api/deployments/${encodeURIComponent(applicationName)}/configuration/${encodeURIComponent(name)}?siteId=${encodeURIComponent(configuration.siteId)}&revision=active`,
        {
          method: 'PUT',
          headers: {
            ...authHeaders(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ value: parsedValue, siteId: configuration.siteId }),
        },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Unable to save ${name}`);
      }
      await onRefresh(applicationName);
      setValue(initialValue);
      setMessage('Saved');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : `Unable to save ${name}`);
    } finally {
      setSaving(false);
    }
  }

  const inputId = `cloud-config-${applicationName}-${name}`;
  return (
    <article className="cloud-config-setting">
      <header>
        <span>
          <code>{name}</code>
          <small>
            {declaration.type} · {declaration.scope}
          </small>
        </span>
        <strong className={declaration.configured ? 'tone-success' : 'tone-warning'}>
          {declaration.configured ? 'configured' : declaration.required ? 'required' : 'optional'}
        </strong>
      </header>
      <p>
        {declaration.description ||
          (declaration.required ? 'Required before this application starts.' : 'Optional setting.')}
      </p>
      <form onSubmit={(event) => void save(event)}>
        <label htmlFor={inputId} className="sr-only">
          {declaration.configured ? `Replace ${name}` : `Set ${name}`}
        </label>
        {declaration.allowedValues?.length ? (
          <select id={inputId} value={value} onChange={(event) => setValue(event.target.value)}>
            {declaration.allowedValues.map((option) => (
              <option key={String(option)} value={String(option)}>
                {String(option)}
              </option>
            ))}
          </select>
        ) : declaration.type === 'boolean' ? (
          <select id={inputId} value={value} onChange={(event) => setValue(event.target.value)}>
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        ) : (
          <input
            id={inputId}
            type={declaration.type === 'secret' ? 'password' : 'text'}
            inputMode={
              declaration.type === 'number' || declaration.type === 'integer'
                ? 'decimal'
                : undefined
            }
            value={value}
            placeholder={declaration.configured ? 'Replace stored value' : 'Set value'}
            autoComplete="off"
            onChange={(event) => setValue(event.target.value)}
          />
        )}
        <button type="submit" disabled={saving || value === ''}>
          {saving ? 'Saving…' : declaration.configured ? 'Replace' : 'Save'}
        </button>
      </form>
      {message ? <small className="cloud-config-feedback tone-success">{message}</small> : null}
      {error ? <small className="cloud-config-feedback tone-danger">{error}</small> : null}
    </article>
  );
}

function parseConfigurationValue(
  declaration: ConfigurationDeclaration,
  value: string,
): string | number | boolean {
  if (declaration.type === 'boolean') return value === 'true';
  if (declaration.type === 'number' || declaration.type === 'integer') {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error('Enter a valid number');
    if (declaration.type === 'integer' && !Number.isInteger(number)) {
      throw new Error('Enter a whole number');
    }
    return number;
  }
  return value;
}

function InspectorActions({ selection, appName }: { selection: GraphSelection; appName?: string }) {
  if (appName) {
    const encoded = encodeURIComponent(appName);
    return (
      <footer className="cloud-inspector-actions">
        <Link to={`/dashboard/${encoded}/terminal`}>
          <TerminalGlyph /> Terminal
        </Link>
        <Link to={`/dashboard/${encoded}/logs`}>
          <LogsGlyph /> Logs
        </Link>
        <Link to={`/dashboard/${encoded}/releases`}>Releases</Link>
        <Link to={`/dashboard/${encoded}/settings`}>Settings</Link>
        <a href={appUrl(appName)} target="_blank" rel="noopener noreferrer">
          Open app ↗
        </a>
      </footer>
    );
  }
  if (selection.kind === 'site') {
    return (
      <footer className="cloud-inspector-actions">
        <Link to="/dashboard/sites">Open site controls</Link>
        <Link to="/dashboard/activity">Activity</Link>
      </footer>
    );
  }
  if (selection.kind === 'machine') {
    return (
      <footer className="cloud-inspector-actions">
        <Link to="/dashboard/nodes">Open machine controls</Link>
        <Link to="/dashboard/logs">Fleet logs</Link>
      </footer>
    );
  }
  return (
    <footer className="cloud-inspector-actions">
      <Link to="/dashboard/activity">Recent activity</Link>
      <Link to="/dashboard/settings">Cloud settings</Link>
    </footer>
  );
}

function InspectorSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="cloud-inspector-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function InspectorMetricGrid({ values }: { values: Array<[string, string]> }) {
  return (
    <div className="cloud-inspector-metrics">
      {values.map(([label, value]) => (
        <div key={label}>
          <small>{label}</small>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}

function InspectorList({ values, empty }: { values: Array<[string, string]>; empty: string }) {
  if (!values.length) return <p>{empty}</p>;
  return (
    <div className="cloud-inspector-list">
      {values.map(([name, detail], index) => (
        <div key={`${name}-${index}`}>
          <strong>{name}</strong>
          <span>{detail}</span>
        </div>
      ))}
    </div>
  );
}

function InspectorNotice({ children }: { children: React.ReactNode }) {
  return <div className="cloud-inspector-notice">{children}</div>;
}

function inspectorTabs(selection: GraphSelection): string[] {
  if (selection.kind === 'application') return ['overview', 'traffic', 'runtime', 'data', 'config'];
  if (selection.kind === 'gateway') return ['overview', 'traffic', 'routes'];
  if (selection.kind === 'site') return ['overview', 'apps', 'sync', 'readiness'];
  if (selection.kind === 'machine') return ['overview', 'apps', 'capacity'];
  if (selection.kind === 'resource') return ['overview', 'attachments', 'continuity', 'backups'];
  if (selection.kind === 'component') return ['overview', 'runtime', 'connections', 'config'];
  if (selection.kind === 'edge') return ['overview', 'flow', 'errors', 'events'];
  return ['overview'];
}

function inspectorDescriptor(
  selection: GraphSelection,
  card?: AppCardData,
  component?: RuntimeComponent,
  resource?: DesiredSpec['resources'][string],
  site?: FleetSite,
  machine?: FleetNode,
  topology?: FleetTopology | null,
) {
  if (selection.kind === 'application')
    return {
      kicker: 'Application context',
      title: selection.appName,
      subtitle: `${card?.status ?? 'resolving'} · ${formatRps(card?.rps ?? 0)} qps`,
      tone: SEVERITY_TONE[card?.severity ?? 'idle'],
      glyph: 'A',
    };
  if (selection.kind === 'component')
    return {
      kicker: `${selection.appName} · component`,
      title: component?.displayName || selection.componentName,
      subtitle: `${component?.role ?? 'runtime'} · ${component?.desiredInstances ?? '—'} desired`,
      tone: component?.blocked ? 'danger' : 'success',
      glyph: 'C',
    };
  if (selection.kind === 'resource')
    return {
      kicker: `${selection.appName} · data`,
      title: resource?.displayName || selection.resourceName,
      subtitle: `${resource?.dataRole ?? 'volume'} · ${resource?.durability ?? 'durable'}`,
      tone: 'accent',
      glyph: 'D',
    };
  if (selection.kind === 'site')
    return {
      kicker: site?.kind === 'suitcase' ? 'Portable site' : 'Home site',
      title: site?.name || 'Site',
      subtitle: site?.mode || 'resolving',
      tone:
        site?.mode === 'recovery' ? 'danger' : site?.mode === 'rejoining' ? 'warning' : 'success',
      glyph: 'S',
    };
  if (selection.kind === 'machine')
    return {
      kicker: 'Execution machine',
      title: machine?.name || 'Machine',
      subtitle: machine?.online ? 'connected' : 'offline',
      tone: machine?.online ? 'success' : 'danger',
      glyph: 'M',
    };
  if (selection.kind === 'edge')
    return {
      kicker: selection.edgeType === 'traffic' ? 'Request connection' : 'Placement connection',
      title:
        selection.edgeType === 'traffic'
          ? `${selection.appName} traffic`
          : `${selection.appName} placement`,
      subtitle: 'live graph evidence',
      tone: selection.edgeType === 'traffic' ? 'flow' : 'accent',
      glyph: '→',
    };
  if (selection.kind === 'gateway')
    return {
      kicker: 'Home ingress',
      title: 'Home gateway',
      subtitle: `${topology?.applications.length ?? 0} application routes`,
      tone: 'flow',
      glyph: 'G',
    };
  return {
    kicker: 'Personal cloud',
    title: topology?.fleet.name || 'Home command center',
    subtitle: 'One connected deployment system',
    tone: 'flow',
    glyph: '◆',
  };
}

function placementLabel(site: FleetSite, replica?: FleetReplica): string {
  if (site.kind === 'home') return 'serving at home';
  if (!replica) return site.mode;
  if (Number(replica.open_conflicts) > 0) return `${replica.open_conflicts} conflicts`;
  const pending = Number(replica.pending_changesets) + Number(replica.pending_blobs);
  if (pending > 0) return `${pending} syncing`;
  if (replica.readiness?.readyOffline) return 'ready offline';
  return replica.runtime_status || site.mode;
}

function formatRps(value: number): string {
  return value < 1 ? value.toFixed(2) : value < 100 ? value.toFixed(1) : value.toFixed(0);
}

function CommandIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M8 9h8M8 13h5M5 4h14v15H5z" />
    </svg>
  );
}
function TerminalGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="m6 8 4 4-4 4M12 16h6" />
    </svg>
  );
}
function LogsGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M6 7h12M6 12h12M6 17h8" />
    </svg>
  );
}
function FitGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M9 5H5v4M15 5h4v4M9 19H5v-4M15 19h4v-4" />
    </svg>
  );
}
