'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-flight-router/client';
import { stringify } from 'yaml';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import type {
  ApplicationGraph,
  ConfigurationResponse,
  DesiredSpec,
  RuntimeComponent,
  RuntimeResponse,
} from '../../../components/dashboard/FleetTopologyBoard';
import { ErrorBanner } from '../../../components/LoadingState';
import { useDialogFocus } from '../../../components/useDialogFocus';
import { useWebSocket } from '../../../hooks/useWebSocket';
import { fetchBuildLogs } from '../../../actions/deployments';
import { ArrowLeftIcon } from '../../../components/dashboard/icons';
import { getAuth } from './shared';

type CanvasSelection =
  | { kind: 'component'; key: string }
  | { kind: 'resource'; key: string }
  | null;

interface Point {
  x: number;
  y: number;
}

interface CanvasLayout {
  components: Record<string, Point>;
  resources: Record<string, Point>;
}

const CARD_WIDTH = 270;
const CARD_HEIGHT = 138;
const COLUMN_GAP = 96;
const ROW_GAP = 34;

interface ActiveBuild {
  output: string;
  timestamp: string;
  phase: string;
}

interface WorkspaceNodeData extends Record<string, unknown> {
  kind: 'component' | 'resource';
  key: string;
  title: string;
  subtitle: string;
  status: string;
  statusTone: 'success' | 'warning' | 'neutral';
  role?: string;
  instances?: number;
  ports?: number;
}

type WorkspaceFlowNode = Node<WorkspaceNodeData, 'service' | 'resource'>;

const BUILD_PHASES = ['uploading', 'backing-up', 'restoring', 'building', 'starting'] as const;
const BUILD_PHASE_LABELS: Record<string, string> = {
  uploading: 'Upload',
  'backing-up': 'Backup',
  restoring: 'Restore',
  building: 'Build',
  starting: 'Deploy',
};

export function ApplicationWorkspaceCanvas({
  name,
  deploymentStatus,
}: {
  name: string;
  deploymentStatus: string;
}) {
  const [graph, setGraph] = useState<ApplicationGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [runtimeUnavailable, setRuntimeUnavailable] = useState(false);
  const [desiredDigest, setDesiredDigest] = useState<string | null>(null);
  const [activeDigest, setActiveDigest] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [actionError, setActionError] = useState('');
  const [selection, setSelection] = useState<CanvasSelection>(null);
  const [creating, setCreating] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const [canvasHasPendingChanges, setCanvasHasPendingChanges] = useState(false);
  const [activeBuild, setActiveBuild] = useState<ActiveBuild | null>(null);
  const [buildPanelOpen, setBuildPanelOpen] = useState(true);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(920);

  const loadBuild = useCallback(async () => {
    const auth = getAuth();
    if (!auth) return;
    try {
      const response = await fetchBuildLogs(auth.username, auth.token, name, 1);
      const activeLog = response.logs.find((log) => log.status === 'building');
      const next =
        (response.activeBuild as ActiveBuild | null) ??
        (activeLog
          ? {
              output: activeLog.output,
              timestamp: activeLog.timestamp,
              phase: deploymentStatus in BUILD_PHASE_LABELS ? deploymentStatus : 'building',
            }
          : deploymentStatus in BUILD_PHASE_LABELS
            ? {
                output: '',
                timestamp: new Date().toISOString(),
                phase: deploymentStatus,
              }
            : null);
      setActiveBuild(next);
      if (next) setBuildPanelOpen(true);
    } catch {
      // Build context is additive; the canvas remains useful if it is unavailable.
    }
  }, [deploymentStatus, name]);

  const load = useCallback(async () => {
    const auth = getAuth();
    if (!auth) return;
    const headers = {
      'x-deploy-username': auth.username,
      'x-deploy-token': auth.token,
    };
    try {
      const encoded = encodeURIComponent(name);
      const [runtimeResponse, specResponse, configurationResponse] = await Promise.all([
        fetch(`/api/deployments/${encoded}/application-runtime?revision=active`, { headers }),
        fetch(`/api/deployments/${encoded}/application-spec`, { headers }),
        fetch(`/api/deployments/${encoded}/configuration?revision=desired`, { headers }),
      ]);
      const specBody = specResponse.ok
        ? ((await specResponse.json()) as {
            active?: DesiredSpec | null;
            desired?: DesiredSpec | null;
            activeDigest?: string | null;
            desiredDigest?: string | null;
          })
        : null;
      const spec = specBody?.desired ?? specBody?.active ?? null;
      const pendingRevision = Boolean(
        specBody?.desiredDigest && specBody.desiredDigest !== specBody.activeDigest,
      );
      const runtime =
        runtimeResponse.ok && !pendingRevision
          ? ((await runtimeResponse.json()) as RuntimeResponse)
          : spec
            ? runtimeFromSpec(name, spec)
            : null;
      if (!runtime) throw new Error('Application workspace is unavailable');
      const configuration = configurationResponse.ok
        ? ((await configurationResponse.json()) as ConfigurationResponse)
        : null;
      setGraph({
        runtime,
        spec,
        configuration,
        legacyEnvironment: [],
      });
      setRuntimeUnavailable(!runtimeResponse.ok || pendingRevision);
      setDesiredDigest(specBody?.desiredDigest ?? null);
      setActiveDigest(specBody?.activeDigest ?? null);
      setError('');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [name]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    void loadBuild();
    const timer = window.setInterval(() => void loadBuild(), 3_000);
    return () => window.clearInterval(timer);
  }, [loadBuild]);

  const buildChannels = useMemo(() => [`deployment:${name}`], [name]);
  const handleBuildEvent = useCallback(
    (event: { type: string; deploymentName?: string; data: Record<string, unknown> }) => {
      if (event.deploymentName && event.deploymentName !== name) return;
      if (event.type === 'build:output') {
        const line = typeof event.data.line === 'string' ? event.data.line : '';
        const timestamp =
          typeof event.data.timestamp === 'string'
            ? event.data.timestamp
            : new Date().toISOString();
        setActiveBuild((current) => ({
          phase: current?.phase ?? 'building',
          timestamp: current?.timestamp ?? timestamp,
          output: `${current?.output ?? ''}${current?.output ? '\n' : ''}${line}`,
        }));
        setBuildPanelOpen(true);
      } else if (event.type === 'deployment:status') {
        const status = typeof event.data.status === 'string' ? event.data.status : '';
        if (status in BUILD_PHASE_LABELS) {
          setActiveBuild((current) => ({
            output: current?.output ?? '',
            timestamp: current?.timestamp ?? new Date().toISOString(),
            phase: status,
          }));
          setBuildPanelOpen(true);
        } else if (status === 'running' || status === 'failed') {
          void loadBuild();
        }
      } else if (event.type === 'build:complete') {
        void loadBuild();
      }
    },
    [loadBuild, name],
  );
  useWebSocket(buildChannels, handleBuildEvent);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(([entry]) => setViewportWidth(entry.contentRect.width));
    observer.observe(viewport);
    setViewportWidth(viewport.clientWidth);
    return () => observer.disconnect();
  }, [loading]);

  const layout = useMemo(() => createCanvasLayout(graph, viewportWidth), [graph, viewportWidth]);
  const flowElements = useMemo(() => createFlowElements(graph, layout), [graph, layout]);
  const [nodes, setNodes, onNodesChange] = useNodesState<WorkspaceFlowNode>(flowElements.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(flowElements.edges);
  useEffect(
    () =>
      setNodes((current) =>
        flowElements.nodes.map((next) => {
          const existing = current.find((node) => node.id === next.id);
          return existing ? { ...next, position: existing.position } : next;
        }),
      ),
    [flowElements.nodes, setNodes],
  );
  useEffect(() => setEdges(flowElements.edges), [flowElements.edges, setEdges]);
  const hasPendingRevision = Boolean(desiredDigest && desiredDigest !== activeDigest);

  async function applyChanges() {
    const auth = getAuth();
    if (!auth || !desiredDigest) return;
    setApplying(true);
    setActionError('');
    try {
      const response = await fetch(
        `/api/deployments/${encodeURIComponent(name)}/application-apply`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-deploy-username': auth.username,
            'x-deploy-token': auth.token,
          },
          body: JSON.stringify({ expectedDesiredDigest: desiredDigest }),
        },
      );
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error || 'Unable to deploy these changes');
      setCanvasHasPendingChanges(false);
      await load();
    } catch (applyError) {
      setActionError(applyError instanceof Error ? applyError.message : String(applyError));
    } finally {
      setApplying(false);
    }
  }

  if (loading) {
    return (
      <div
        className="application-workspace-canvas is-loading"
        aria-label="Loading application canvas"
      />
    );
  }
  if (error || !graph?.runtime)
    return <ErrorBanner message={error || 'Application workspace is unavailable'} />;

  const runtime = graph.runtime;
  return (
    <section className="application-workspace" aria-labelledby="application-workspace-title">
      <header className="application-workspace-header">
        <div>
          <span className="command-kicker">Architecture</span>
          <h2 id="application-workspace-title" className="sr-only">
            {name} architecture
          </h2>
        </div>
        <div className="application-workspace-header-actions">
          {deploymentStatus === 'configuration-required' ? (
            <button
              type="button"
              className="application-configuration-cta"
              onClick={() => setConfiguring(true)}
            >
              <i aria-hidden /> Configure to continue
            </button>
          ) : (
            <span className={runtime.ready ? 'tone-success' : 'tone-warning'}>
              <i aria-hidden />{' '}
              {runtimeUnavailable
                ? 'Preparing release'
                : runtime.ready
                  ? 'Online'
                  : 'Needs configuration'}
            </span>
          )}
          {hasPendingRevision && canvasHasPendingChanges ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => void applyChanges()}
              disabled={applying}
            >
              {applying ? 'Deploying…' : 'Deploy changes'}
            </button>
          ) : null}
          <button type="button" className="btn btn-sm" onClick={() => setCreating(true)}>
            <span aria-hidden>＋</span> Add
          </button>
        </div>
      </header>

      {actionError ? <ErrorBanner message={actionError} /> : null}

      <div ref={viewportRef} className="application-canvas-viewport">
        <ReactFlow<WorkspaceFlowNode, Edge>
          nodes={nodes}
          edges={edges}
          nodeTypes={WORKSPACE_NODE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={(_, node) => setSelection({ kind: node.data.kind, key: node.data.key })}
          fitView
          fitViewOptions={{ padding: 0.24, maxZoom: 1 }}
          minZoom={0.35}
          maxZoom={1.5}
          nodesConnectable={false}
          edgesReconnectable={false}
          deleteKeyCode={null}
          proOptions={{ hideAttribution: true }}
          aria-label={`${name} application topology`}
        >
          <Background
            id="application-grid"
            variant={BackgroundVariant.Dots}
            gap={24}
            size={1}
            color="rgb(111 102 129 / 0.28)"
            bgColor="#0d0c15"
          />
          <Controls position="bottom-left" showInteractive={false} />
        </ReactFlow>
        {activeBuild ? (
          buildPanelOpen ? (
            <BuildProgressPanel
              name={name}
              build={activeBuild}
              onClose={() => setBuildPanelOpen(false)}
            />
          ) : (
            <button
              type="button"
              className="application-build-pill"
              onClick={() => setBuildPanelOpen(true)}
            >
              <i aria-hidden /> {BUILD_PHASE_LABELS[activeBuild.phase] ?? 'Deploying'}
            </button>
          )
        ) : null}
      </div>

      {selection ? (
        <WorkspaceDetail
          name={name}
          graph={graph}
          selection={selection}
          onClose={() => setSelection(null)}
        />
      ) : null}
      {creating && graph.spec ? (
        <CreatePalette
          name={name}
          spec={graph.spec}
          onCreated={async () => {
            setCreating(false);
            setCanvasHasPendingChanges(true);
            await load();
          }}
          onClose={() => setCreating(false)}
        />
      ) : null}
      {configuring && graph.configuration ? (
        <ConfigurationSetupPanel
          name={name}
          configuration={graph.configuration}
          applying={applying}
          onRefresh={load}
          onDeploy={applyChanges}
          onClose={() => setConfiguring(false)}
        />
      ) : null}
    </section>
  );
}

function ConfigurationSetupPanel({
  name,
  configuration,
  applying,
  onRefresh,
  onDeploy,
  onClose,
}: {
  name: string;
  configuration: ConfigurationResponse;
  applying: boolean;
  onRefresh: () => Promise<void>;
  onDeploy: () => Promise<void>;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(true, dialogRef, onClose);
  const declarations = Object.entries(configuration.declarations).sort(
    ([leftKey, left], [rightKey, right]) =>
      Number(right.required && !right.configured) - Number(left.required && !left.configured) ||
      leftKey.localeCompare(rightKey),
  );

  return (
    <div className="workspace-detail-layer">
      <button
        type="button"
        className="workspace-detail-backdrop"
        onClick={onClose}
        aria-label="Close configuration"
      />
      <div
        ref={dialogRef}
        className="application-configuration-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="application-configuration-title"
      >
        <header>
          <div>
            <span className="command-kicker">Finish deployment</span>
            <h3 id="application-configuration-title">Configure {name}</h3>
            <p>Values stay on this deploy.local site. Secret contents are never returned.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close configuration">
            ×
          </button>
        </header>
        <div className="application-configuration-fields">
          {declarations.map(([key, declaration]) => (
            <InlineConfigurationField
              key={key}
              name={name}
              siteId={configuration.siteId}
              fieldKey={key}
              declaration={declaration}
              onSaved={onRefresh}
            />
          ))}
        </div>
        <footer>
          <span className={configuration.ready ? 'tone-success' : 'tone-warning'}>
            {configuration.ready
              ? 'Configuration ready'
              : `${configuration.missing.length} required value${configuration.missing.length === 1 ? '' : 's'} remaining`}
          </span>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!configuration.ready || applying}
            onClick={() => void onDeploy()}
          >
            {applying ? 'Deploying…' : 'Continue deployment'}
          </button>
        </footer>
      </div>
    </div>
  );
}

function InlineConfigurationField({
  name,
  siteId,
  fieldKey,
  declaration,
  onSaved,
}: {
  name: string;
  siteId: string;
  fieldKey: string;
  declaration: ConfigurationResponse['declarations'][string];
  onSaved: () => Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const auth = getAuth();
    if (!auth || !value) return;
    setSaving(true);
    setError('');
    try {
      const parsedValue =
        declaration.type === 'boolean'
          ? value === 'true'
          : declaration.type === 'number' || declaration.type === 'integer'
            ? Number(value)
            : value;
      const response = await fetch(
        `/api/deployments/${encodeURIComponent(name)}/configuration/${encodeURIComponent(fieldKey)}?siteId=${encodeURIComponent(siteId)}&revision=desired`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'x-deploy-username': auth.username,
            'x-deploy-token': auth.token,
          },
          body: JSON.stringify({ value: parsedValue, siteId }),
        },
      );
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error || `Unable to save ${fieldKey}`);
      setValue('');
      await onSaved();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : `Unable to save ${fieldKey}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="application-configuration-field" onSubmit={(event) => void save(event)}>
      <label htmlFor={`canvas-config-${fieldKey}`}>
        <span>
          <strong>{fieldKey}</strong>
          <small>{declaration.description}</small>
        </span>
        <em className={declaration.configured ? 'tone-success' : 'tone-warning'}>
          {declaration.configured ? 'Configured' : declaration.required ? 'Required' : 'Optional'}
        </em>
      </label>
      <div>
        {declaration.type === 'boolean' ? (
          <select
            id={`canvas-config-${fieldKey}`}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          >
            <option value="">Choose…</option>
            <option value="true">True</option>
            <option value="false">False</option>
          </select>
        ) : (
          <input
            id={`canvas-config-${fieldKey}`}
            type={declaration.type === 'secret' ? 'password' : 'text'}
            value={value}
            placeholder={declaration.configured ? 'Replace stored value' : 'Enter value'}
            autoComplete="off"
            onChange={(event) => setValue(event.target.value)}
          />
        )}
        <button type="submit" disabled={!value || saving}>
          {saving ? 'Saving…' : declaration.configured ? 'Replace' : 'Save'}
        </button>
      </div>
      {error ? <small className="tone-danger">{error}</small> : null}
    </form>
  );
}

function BuildProgressPanel({
  name,
  build,
  onClose,
}: {
  name: string;
  build: ActiveBuild;
  onClose: () => void;
}) {
  const activeIndex = Math.max(
    0,
    BUILD_PHASES.indexOf(build.phase as (typeof BUILD_PHASES)[number]),
  );
  const output = build.output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-7);

  return (
    <aside className="application-build-panel" aria-label="Deployment progress" aria-live="polite">
      <header>
        <div>
          <span className="application-build-eyebrow">Deploying {name}</span>
          <strong>{BUILD_PHASE_LABELS[build.phase] ?? 'Preparing release'}</strong>
        </div>
        <button type="button" onClick={onClose} aria-label="Minimize deployment progress">
          −
        </button>
      </header>
      <div className="application-build-phases" aria-label="Deployment stages">
        {BUILD_PHASES.map((phase, index) => (
          <span
            key={phase}
            className={
              index < activeIndex ? 'is-complete' : index === activeIndex ? 'is-active' : ''
            }
          >
            <i aria-hidden /> {BUILD_PHASE_LABELS[phase]}
          </span>
        ))}
      </div>
      <div className="application-build-output">
        {output.length ? (
          output.map((line, index) => <code key={`${index}-${line}`}>{line}</code>)
        ) : (
          <code>Waiting for build output…</code>
        )}
      </div>
      <footer>
        <span>Live from the application canvas</span>
        <Link to={`/dashboard/${encodeURIComponent(name)}/build`}>Open full logs ↗</Link>
      </footer>
    </aside>
  );
}

/**
 * Keep the architecture useful when a development process cannot resolve
 * production-owned secrets. The immutable spec is sufficient to draw the
 * services, routes, dependencies, and volumes; only live health is omitted.
 */
function runtimeFromSpec(name: string, spec: DesiredSpec): RuntimeResponse {
  const components = Object.fromEntries(
    Object.entries(spec.components ?? {}).map(([componentName, component]) => [
      componentName,
      {
        name: componentName,
        displayName: component.displayName,
        role: component.role,
        desiredInstances: component.instances,
        minimumReady: component.minimumReady,
        dependencies: component.dependsOn,
        interfaces: component.interfaces,
        mounts: component.mounts,
        source: component.image
          ? ({ kind: 'image', reference: component.image } as const)
          : ({ kind: 'build', context: component.build?.context ?? '.' } as const),
        profile: component.profile ? { profile: component.profile } : undefined,
        blocked: false,
      },
    ]),
  );
  const services = Object.fromEntries(
    Object.entries(spec.components ?? {}).flatMap(([componentName, component]) =>
      Object.entries(component.interfaces).map(([interfaceName, endpoint]) => {
        const id = `${componentName}.${interfaceName}`;
        return [
          id,
          {
            id,
            component: componentName,
            interface: interfaceName,
            protocol: endpoint.protocol,
            containerPort: endpoint.port,
          },
        ];
      }),
    ),
  );
  const routes = Object.fromEntries(
    Object.entries(spec.routes ?? {}).map(([routeName, route]) => [
      routeName,
      {
        name: routeName,
        serviceId: route.to,
        hostname: route.hostname,
        path: route.path,
        discoverable: route.discoverable,
      },
    ]),
  );

  return {
    applicationId: name,
    alias: name,
    siteId: 'coordinator',
    specDigest: '',
    ready: false,
    configuration: { missing: [] },
    execution: {
      componentOrder: Object.keys(components),
      components,
      services,
      routes,
      volumeAttachments: [],
      findings: [],
    },
    actual: null,
  };
}

function ServiceFlowNode({ data }: NodeProps<WorkspaceFlowNode>) {
  return (
    <button type="button" className="application-service-card">
      <Handle type="target" position={Position.Left} className="application-flow-handle" />
      <span className="application-service-card-title">
        <ServiceGlyph role={data.role ?? 'service'} />
        <strong>{data.title}</strong>
      </span>
      <small>{data.subtitle}</small>
      <span className={`application-service-health tone-${data.statusTone}`}>
        <i aria-hidden /> {data.status}
      </span>
      <span className="application-service-meta">
        <span>
          {data.instances} {data.instances === 1 ? 'instance' : 'instances'}
        </span>
        <span>
          {data.ports} {data.ports === 1 ? 'port' : 'ports'}
        </span>
      </span>
      <Handle type="source" position={Position.Right} className="application-flow-handle" />
    </button>
  );
}

function ResourceFlowNode({ data }: NodeProps<WorkspaceFlowNode>) {
  return (
    <button type="button" className="application-service-card is-resource">
      <Handle type="target" position={Position.Left} className="application-flow-handle" />
      <span className="application-service-card-title">
        <ResourceGlyph />
        <strong>{data.title}</strong>
      </span>
      <small>{data.subtitle}</small>
      <span className={`application-service-health tone-${data.statusTone}`}>
        <i aria-hidden /> {data.status}
      </span>
      <span className="application-volume-foot">▱ {data.key}</span>
    </button>
  );
}

const WORKSPACE_NODE_TYPES = {
  service: ServiceFlowNode,
  resource: ResourceFlowNode,
};

function WorkspaceDetail({
  name,
  graph,
  selection,
  onClose,
}: {
  name: string;
  graph: ApplicationGraph;
  selection: Exclude<CanvasSelection, null>;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<'overview' | 'runtime' | 'network'>('overview');
  useDialogFocus(true, dialogRef, onClose);
  const component =
    selection.kind === 'component' ? graph.runtime?.execution.components[selection.key] : null;
  const resource = selection.kind === 'resource' ? graph.spec?.resources[selection.key] : null;
  const instances =
    graph.runtime?.actual?.instances.filter(
      (instance) => instance.componentKey === selection.key && instance.status !== 'removed',
    ) ?? [];

  return (
    <div className="workspace-detail-layer">
      <button
        type="button"
        className="workspace-detail-backdrop"
        onClick={onClose}
        aria-label="Close details"
      />
      <div
        ref={dialogRef}
        className="workspace-detail"
        role="dialog"
        aria-modal="true"
        aria-label={`${selection.key} details`}
      >
        <header>
          <span>
            {component ? <ServiceGlyph role={component.role} /> : <ResourceGlyph />}
            <strong>{component?.displayName ?? resource?.displayName ?? selection.key}</strong>
          </span>
          <button type="button" onClick={onClose} aria-label="Close details">
            ×
          </button>
        </header>
        <nav aria-label="Detail sections">
          {(['overview', 'runtime', 'network'] as const).map((item) => (
            <button
              key={item}
              type="button"
              className={tab === item ? 'is-active' : ''}
              onClick={() => setTab(item)}
            >
              {item === 'network' ? 'Connections' : item[0].toUpperCase() + item.slice(1)}
            </button>
          ))}
        </nav>
        <div className="workspace-detail-body">
          {tab === 'overview' ? (
            <>
              <DetailFacts
                facts={
                  component
                    ? [
                        ['Role', component.role],
                        ['Source', sourceLabel(component)],
                        ['Desired', `${component.desiredInstances} instances`],
                        ['Minimum ready', String(component.minimumReady)],
                      ]
                    : [
                        ['Data role', resource?.dataRole ?? 'resource'],
                        ['Durability', resource?.durability ?? '—'],
                        ['Access', resource?.access ?? '—'],
                        ['Ownership', resource?.ownership ?? '—'],
                      ]
                }
              />
              {component && component.dependencies.length ? (
                <DetailSection title="Depends on">
                  <div className="workspace-detail-chips">
                    {component.dependencies.map((item) => (
                      <span key={item}>{item}</span>
                    ))}
                  </div>
                </DetailSection>
              ) : null}
            </>
          ) : null}
          {tab === 'runtime' ? (
            <DetailSection title="Instances">
              {instances.length ? (
                instances.map((instance, index) => (
                  <div key={`${instance.componentKey}-${index}`} className="workspace-instance-row">
                    <span>
                      <strong>{instance.componentKey}</strong>
                      <small>{instance.status}</small>
                    </span>
                    <b className={instance.health === 'healthy' ? 'tone-success' : 'tone-warning'}>
                      {instance.health}
                    </b>
                  </div>
                ))
              ) : (
                <p className="workspace-detail-empty">No materialized instances.</p>
              )}
            </DetailSection>
          ) : null}
          {tab === 'network' ? (
            <DetailSection title="Interfaces">
              {component && Object.entries(component.interfaces).length ? (
                Object.entries(component.interfaces).map(([key, value]) => (
                  <div key={key} className="workspace-instance-row">
                    <span>
                      <strong>{key}</strong>
                      <small>{value.protocol}</small>
                    </span>
                    <b>{value.port}</b>
                  </div>
                ))
              ) : (
                <p className="workspace-detail-empty">No network interfaces.</p>
              )}
            </DetailSection>
          ) : null}
        </div>
        <footer>
          {component ? (
            <Link to={`/dashboard/${name}/logs`}>Logs</Link>
          ) : (
            <Link to={`/dashboard/${name}/data`}>Data</Link>
          )}
          {component ? <Link to={`/dashboard/${name}/terminal`}>Console</Link> : null}
          <Link to={`/dashboard/${name}/settings`}>Settings</Link>
        </footer>
      </div>
    </div>
  );
}

function CreatePalette({
  name,
  spec,
  onCreated,
  onClose,
}: {
  name: string;
  spec: DesiredSpec;
  onCreated: () => Promise<void>;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(true, dialogRef, onClose);
  const [mode, setMode] = useState<'menu' | 'component' | 'resource'>('menu');
  const [key, setKey] = useState('');
  const [template, setTemplate] = useState<'web' | 'worker' | 'service' | 'postgres'>('web');
  const [image, setImage] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const choices: Array<readonly ['component' | 'resource', string, string]> = [
    ['component' as const, 'Component', 'Add a runnable service'],
    ['resource' as const, 'Data resource', 'Attach durable application data'],
  ];

  async function save(next: DesiredSpec) {
    const auth = getAuth();
    if (!auth) return;
    setSaving(true);
    setError('');
    try {
      const manifest = stringify(next, { lineWidth: 0 });
      const planResponse = await fetch(
        `/api/deployments/${encodeURIComponent(name)}/application-plan`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-deploy-username': auth.username,
            'x-deploy-token': auth.token,
          },
          body: JSON.stringify({ manifest }),
        },
      );
      const plan = (await planResponse.json()) as { error?: string; parentDigest?: string };
      if (!planResponse.ok || !plan.parentDigest) {
        throw new Error(plan.error || 'Unable to preview this graph change');
      }
      const saveResponse = await fetch(
        `/api/deployments/${encodeURIComponent(name)}/application-spec`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'x-deploy-username': auth.username,
            'x-deploy-token': auth.token,
          },
          body: JSON.stringify({
            manifest,
            expectedParentDigest: plan.parentDigest,
            confirmDestructive: false,
          }),
        },
      );
      const result = (await saveResponse.json()) as { error?: string };
      if (!saveResponse.ok) throw new Error(result.error || 'Unable to save this graph change');
      await onCreated();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function addComponent(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const componentKey = key.trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(componentKey)) {
      setError('Use a lowercase name beginning with a letter.');
      return;
    }
    if (spec.components?.[componentKey]) {
      setError(`Component ${componentKey} already exists.`);
      return;
    }
    const next = structuredClone(spec);
    next.components ??= {};
    next.resources ??= {};
    const isPostgres = template === 'postgres';
    const resourceKey = `${componentKey}-data`;
    if (isPostgres) {
      next.resources[resourceKey] = {
        displayName: `${componentKey} data`,
        durability: 'durable',
        dataRole: 'database',
        access: 'singleWriter',
        consistencyGroup: resourceKey,
        ownership: 'application',
        backup: { policy: 'include', retentionCopies: 7 },
        suitcase: { allowedDataModes: ['follows-one-site'] },
      };
    }
    next.components[componentKey] = {
      displayName: componentKey,
      image: image.trim() || (isPostgres ? 'postgres:16' : 'node:22-alpine'),
      role: template === 'web' ? 'web' : template === 'worker' ? 'worker' : 'service',
      instances: 1,
      minimumReady: 1,
      interfaces:
        template === 'worker'
          ? {}
          : {
              [isPostgres ? 'postgres' : 'http']: {
                port: isPostgres ? 5432 : 3000,
                protocol: isPostgres ? 'postgres' : 'http',
              },
            },
      mounts: isPostgres ? { data: { resource: resourceKey, readOnly: false } } : {},
      dependsOn: [],
    };
    await save(next);
  }

  async function addResource(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const resourceKey = key.trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(resourceKey)) {
      setError('Use a lowercase name beginning with a letter.');
      return;
    }
    if (spec.resources[resourceKey]) {
      setError(`Resource ${resourceKey} already exists.`);
      return;
    }
    const next = structuredClone(spec);
    next.resources[resourceKey] = {
      displayName: resourceKey,
      durability: 'durable',
      dataRole: 'files',
      access: 'singleWriter',
      consistencyGroup: resourceKey,
      ownership: 'application',
      backup: { policy: 'include', retentionCopies: 7 },
      suitcase: { allowedDataModes: ['follows-one-site'] },
    };
    await save(next);
  }

  return (
    <div className="workspace-create-layer">
      <button
        type="button"
        className="workspace-detail-backdrop"
        onClick={onClose}
        aria-label="Close create menu"
      />
      <div
        ref={dialogRef}
        className="workspace-create"
        role="dialog"
        aria-modal="true"
        aria-label="Add to application"
      >
        {mode === 'menu' ? (
          <>
            <input
              autoFocus
              placeholder="What would you like to add?"
              aria-label="Filter resources"
            />
            <div>
              {choices.map(([choice, title, description]) => (
                <button key={choice} type="button" onClick={() => setMode(choice)}>
                  <span>
                    <strong>{title}</strong>
                    <small>{description}</small>
                  </span>
                  <b aria-hidden>›</b>
                </button>
              ))}
            </div>
          </>
        ) : (
          <form
            className="workspace-create-form"
            onSubmit={mode === 'component' ? addComponent : addResource}
          >
            <button
              type="button"
              className="workspace-create-back"
              onClick={() => setMode('menu')}
              aria-label="Back to add menu"
              title="Back"
            >
              <ArrowLeftIcon />
            </button>
            <h3>{mode === 'component' ? 'New component' : 'New data resource'}</h3>
            <label>
              Name
              <input
                autoFocus
                value={key}
                onChange={(event) => setKey(event.target.value)}
                placeholder={mode === 'component' ? 'worker' : 'uploads'}
              />
            </label>
            {mode === 'component' ? (
              <>
                <label>
                  Starting shape
                  <select
                    value={template}
                    onChange={(event) => setTemplate(event.target.value as typeof template)}
                  >
                    <option value="web">Web service</option>
                    <option value="worker">Worker</option>
                    <option value="service">Private service</option>
                    <option value="postgres">PostgreSQL + volume</option>
                  </select>
                </label>
                <label>
                  Container image
                  <input
                    value={image}
                    onChange={(event) => setImage(event.target.value)}
                    placeholder={template === 'postgres' ? 'postgres:16' : 'node:22-alpine'}
                  />
                </label>
              </>
            ) : null}
            {error ? <p className="text-danger">{error}</p> : null}
            <button type="submit" className="btn btn-primary" disabled={saving || !key.trim()}>
              {saving ? 'Adding…' : mode === 'component' ? 'Add component' : 'Add resource'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

function DetailFacts({ facts }: { facts: Array<[string, string]> }) {
  return (
    <div className="workspace-detail-facts">
      {facts.map(([label, value]) => (
        <div key={label}>
          <small>{label}</small>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="workspace-detail-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function ServiceGlyph({ role }: { role: string }) {
  return (
    <span className="workspace-glyph" aria-hidden>
      {role === 'database' ? 'DB' : role.slice(0, 2).toUpperCase()}
    </span>
  );
}

function ResourceGlyph() {
  return (
    <span className="workspace-glyph is-resource" aria-hidden>
      ▱
    </span>
  );
}

function sourceLabel(component: RuntimeComponent): string {
  return component.source.kind === 'image' ? component.source.reference : component.source.context;
}

function createFlowElements(
  graph: ApplicationGraph | null,
  layout: CanvasLayout,
): { nodes: WorkspaceFlowNode[]; edges: Edge[] } {
  const runtime = graph?.runtime;
  if (!runtime) return { nodes: [], edges: [] };
  const componentNames = runtime.execution.componentOrder.length
    ? [...runtime.execution.componentOrder]
    : Object.keys(runtime.execution.components);
  const nodes: WorkspaceFlowNode[] = componentNames.map((componentName) => {
    const component = runtime.execution.components[componentName];
    const instances =
      runtime.actual?.instances.filter(
        (instance) => instance.componentKey === componentName && instance.status !== 'removed',
      ) ?? [];
    const ready = instances.filter((instance) => instance.health === 'healthy').length;
    const route = Object.values(runtime.execution.routes ?? {}).find((candidate) => {
      const service = runtime.execution.services[candidate.serviceId];
      return service?.component === componentName;
    });
    const online = ready >= component.minimumReady;
    return {
      id: `component:${componentName}`,
      type: 'service',
      position: layout.components[componentName] ?? { x: 0, y: 0 },
      data: {
        kind: 'component',
        key: componentName,
        title: component.displayName ?? componentName,
        subtitle: route?.hostname ?? sourceLabel(component),
        status: online ? 'Online' : `${ready}/${component.desiredInstances} ready`,
        statusTone: online ? 'success' : 'warning',
        role: component.role,
        instances: component.desiredInstances,
        ports: Object.keys(component.interfaces).length,
      },
    };
  });
  for (const [resourceName, resource] of Object.entries(graph?.spec?.resources ?? {})) {
    const volume = runtime.actual?.volumes.find(
      (candidate) => candidate.resourceKey === resourceName,
    );
    const attached = volume?.state === 'ready';
    nodes.push({
      id: `resource:${resourceName}`,
      type: 'resource',
      position: layout.resources[resourceName] ?? { x: 0, y: 0 },
      data: {
        kind: 'resource',
        key: resourceName,
        title: resource.displayName ?? resourceName,
        subtitle: `${resource.dataRole} · ${resource.durability}`,
        status: attached ? 'Attached' : 'Declared',
        statusTone: attached ? 'success' : 'neutral',
      },
    });
  }

  const edgeStyle = { stroke: 'rgb(138 129 156 / 0.48)', strokeWidth: 1.2 };
  const edges: Edge[] = [];
  for (const componentName of componentNames) {
    const component = runtime.execution.components[componentName];
    for (const dependency of component.dependencies) {
      edges.push({
        id: `dependency:${componentName}:${dependency}`,
        source: `component:${componentName}`,
        target: `component:${dependency}`,
        type: 'smoothstep',
        markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
        style: edgeStyle,
      });
    }
    for (const mount of Object.values(component.mounts ?? {})) {
      edges.push({
        id: `mount:${componentName}:${mount.resource}`,
        source: `component:${componentName}`,
        target: `resource:${mount.resource}`,
        type: 'default',
        markerEnd: { type: MarkerType.ArrowClosed, width: 11, height: 11 },
        style: { ...edgeStyle, stroke: 'rgb(105 143 155 / 0.46)' },
      });
    }
  }
  return { nodes, edges };
}

function createCanvasLayout(graph: ApplicationGraph | null, viewportWidth = 920): CanvasLayout {
  const components = graph?.runtime?.execution.components ?? {};
  const componentNames = graph?.runtime?.execution.componentOrder.length
    ? [...graph.runtime.execution.componentOrder]
    : Object.keys(components);
  const resources = Object.keys(graph?.spec?.resources ?? {});
  const depth = new Map<string, number>();
  const resolveDepth = (name: string, seen = new Set<string>()): number => {
    if (depth.has(name)) return depth.get(name)!;
    if (seen.has(name)) return 0;
    const dependencies = components[name]?.dependencies ?? [];
    const value = dependencies.length
      ? 1 + Math.max(...dependencies.map((item) => resolveDepth(item, new Set(seen).add(name))))
      : 0;
    depth.set(name, value);
    return value;
  };
  componentNames.forEach((name) => resolveDepth(name));
  if (componentNames.length === 1 && viewportWidth >= 650) {
    const width = Math.max(650, viewportWidth);
    const gap = Math.max(54, Math.min(110, width * 0.1));
    const groupWidth = CARD_WIDTH * 2 + gap;
    const componentX = Math.max(38, (width - groupWidth) / 2);
    const resourceX = componentX + CARD_WIDTH + gap;
    const resourceHeight =
      resources.length * CARD_HEIGHT + Math.max(0, resources.length - 1) * ROW_GAP;
    const resourceStart = Math.max(92, 250 - resourceHeight / 2);
    return {
      components: { [componentNames[0]]: { x: componentX, y: 180 } },
      resources: Object.fromEntries(
        resources.map((name, index) => [
          name,
          { x: resourceX, y: resourceStart + index * (CARD_HEIGHT + ROW_GAP) },
        ]),
      ),
    };
  }
  if (viewportWidth < 650 && componentNames.length === 1) {
    const width = Math.max(310, viewportWidth);
    const centeredX = Math.max(20, (width - CARD_WIDTH) / 2);
    const componentPositions = { [componentNames[0]]: { x: centeredX, y: 54 } };
    const resourcePositions = Object.fromEntries(
      resources.map((name, index) => [
        name,
        { x: centeredX, y: 250 + index * (CARD_HEIGHT + ROW_GAP) },
      ]),
    );
    return {
      components: componentPositions,
      resources: resourcePositions,
    };
  }
  const columns = new Map<number, string[]>();
  componentNames.forEach((name) => {
    const column = depth.get(name) ?? 0;
    columns.set(column, [...(columns.get(column) ?? []), name]);
  });
  const componentPositions: Record<string, Point> = {};
  for (const [column, names] of columns) {
    names.forEach((name, index) => {
      componentPositions[name] = {
        x: 88 + column * (CARD_WIDTH + COLUMN_GAP),
        y: 86 + index * (CARD_HEIGHT + ROW_GAP),
      };
    });
  }
  const maxDepth = Math.max(0, ...depth.values());
  const resourcePositions: Record<string, Point> = {};
  resources.forEach((name, index) => {
    resourcePositions[name] = {
      x: 88 + (maxDepth + 1) * (CARD_WIDTH + COLUMN_GAP),
      y: 86 + index * (CARD_HEIGHT + ROW_GAP),
    };
  });
  return {
    components: componentPositions,
    resources: resourcePositions,
  };
}
