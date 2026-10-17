'use client';
import { Select } from '@/components/ui';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-flight-router/client';
import { stringify } from 'yaml';
import type {
  ApplicationOverviewData,
  ConfigurationResponse,
  DesiredSpec,
  RuntimeComponent,
  RuntimeResponse,
} from '../../../components/dashboard/application-models';
import { Button, TextField } from '../../../components/ui';
import { ErrorBanner } from '../../../components/LoadingState';
import { useDialogFocus } from '../../../components/useDialogFocus';
import { useWebSocket } from '../../../hooks/useWebSocket';
import { fetchBuildLogs } from '../../../actions/deployments';
import { ArrowLeftIcon, ExternalLinkIcon } from '../../../components/dashboard/icons';
import { WorkspaceIcon } from '../workspace-icon';
import { getAuth, useDetailContext } from './shared';
import './application-overview.css';

interface ActiveBuild {
  output: string;
  timestamp: string;
  phase: string;
}

const BUILD_PHASE_LABELS: Record<string, string> = {
  uploading: 'Uploading',
  'backing-up': 'Backing up',
  restoring: 'Restoring',
  building: 'Building',
  starting: 'Starting',
};

export function ApplicationOverview({
  name,
  deploymentStatus,
}: {
  name: string;
  deploymentStatus: string;
}) {
  const [application, setApplication] = useState<ApplicationOverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [runtimeUnavailable, setRuntimeUnavailable] = useState(false);
  const [desiredDigest, setDesiredDigest] = useState<string | null>(null);
  const [activeDigest, setActiveDigest] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [actionError, setActionError] = useState('');
  const [creating, setCreating] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const [activeBuild, setActiveBuild] = useState<ActiveBuild | null>(null);
  const { deployment } = useDetailContext();
  const [computers, setComputers] = useState<Array<{ id: string; name: string }>>([]);

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
    } catch {
      // Service status remains useful when deployment output is unavailable.
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
      setApplication({
        runtime,
        spec,
        configuration,
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
      } else if (event.type === 'deployment:status') {
        const status = typeof event.data.status === 'string' ? event.data.status : '';
        if (status in BUILD_PHASE_LABELS) {
          setActiveBuild((current) => ({
            output: current?.output ?? '',
            timestamp: current?.timestamp ?? new Date().toISOString(),
            phase: status,
          }));
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
    const auth = getAuth();
    if (!auth) return;
    let cancelled = false;
    fetch('/api/nodes', {
      headers: { 'x-deploy-username': auth.username, 'x-deploy-token': auth.token },
    })
      .then(async (response) => {
        if (!response.ok) return;
        const data = await response.json();
        if (!cancelled) setComputers(data.nodes ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [name]);

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
      await load();
    } catch (applyError) {
      setActionError(applyError instanceof Error ? applyError.message : String(applyError));
    } finally {
      setApplying(false);
    }
  }

  if (loading)
    return (
      <div className="application-overview ao-loading" role="status">
        Loading services…
      </div>
    );
  if (error || !application?.runtime)
    return (
      <ErrorBanner
        message={error || 'Application overview is unavailable'}
        action={
          <button className="btn btn-sm" onClick={() => void load()}>
            Retry overview
          </button>
        }
      />
    );

  const runtime = application.runtime;
  const nodeId = deployment.activeNodeId ?? deployment.desiredNodeId;
  const computer = computers.find((item) => item.id === nodeId)?.name ?? nodeId ?? 'Not assigned';
  const services = Object.entries(runtime.execution.components);
  const storage = Object.entries(application.spec?.resources ?? {});
  const activePhase = deploymentStatus in BUILD_PHASE_LABELS;
  return (
    <section className="application-overview" aria-label="Application resources">
      <header className="ao-heading">
        <div className="ao-actions">
          {application.spec && (
            <button type="button" className="btn btn-sm" onClick={() => setCreating(true)}>
              <WorkspaceIcon name="plus" /> Add service or storage
            </button>
          )}
        </div>
      </header>

      {actionError ? <ErrorBanner message={actionError} /> : null}
      {deploymentStatus === 'configuration-required' ? (
        <div className="ao-notice">
          <span>
            <strong>Configuration needed</strong>
            <small>Set the required values before deploying.</small>
          </span>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => setConfiguring(true)}
          >
            Configure
          </button>
        </div>
      ) : hasPendingRevision ? (
        <div className="ao-notice">
          <span>
            <strong>Changes ready to deploy</strong>
            <small>The saved configuration differs from the active version.</small>
          </span>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => void applyChanges()}
            disabled={applying || activePhase}
          >
            {applying ? 'Deploying…' : 'Deploy changes'}
          </button>
        </div>
      ) : null}

      {activeBuild ? <DeploymentProgress name={name} build={activeBuild} /> : null}
      {runtimeUnavailable && !activePhase ? (
        <p className="ao-muted" role="status">
          Live service status is unavailable. Showing saved configuration.
        </p>
      ) : null}

      <div className="ao-context">
        <span>
          <WorkspaceIcon name="computer" /> {computer}
        </span>
        <span>
          {services.length} service{services.length === 1 ? '' : 's'}
        </span>
        {activeDigest && (
          <Link to={`/dashboard/${encodeURIComponent(name)}/releases`} title={activeDigest}>
            Version {shortDigest(activeDigest)}
          </Link>
        )}
      </div>

      <section className="ao-section" aria-labelledby="ao-services-title">
        <header>
          <h3 id="ao-services-title">Services</h3>
          <span>Health</span>
        </header>
        <div className="ao-list">
          {services.map(([key, component]) => (
            <ServiceRow
              key={key}
              name={name}
              serviceKey={key}
              component={component}
              runtime={runtime}
              statusAvailable={!runtimeUnavailable}
            />
          ))}
          {!services.length && (
            <p className="ao-empty">No services configured. Add a service to run an application.</p>
          )}
        </div>
      </section>

      {storage.length > 0 && (
        <section className="ao-section" aria-labelledby="ao-storage-title">
          <header>
            <h3 id="ao-storage-title">Storage</h3>
            <span>Status</span>
          </header>
          <div className="ao-list">
            {storage.map(([key, resource]) => {
              const volume = runtime.actual?.volumes.find((item) => item.resourceKey === key);
              const usedBy = services
                .filter(([, service]) =>
                  Object.values(service.mounts ?? {}).some((mount) => mount.resource === key),
                )
                .map(([serviceKey]) => serviceKey);
              return (
                <details key={key} className="ao-storage">
                  <summary>
                    <WorkspaceIcon name="folder" />
                    <span className="ao-row-title">
                      <strong>{resource.displayName ?? key}</strong>
                      <small>
                        {usedBy.length
                          ? `Used by ${usedBy.join(', ')}`
                          : 'Not attached to a service'}
                      </small>
                    </span>
                    <span className="ao-status">{volume?.state ?? 'Configured'}</span>
                    <WorkspaceIcon name="chevron" className="ao-chevron" />
                  </summary>
                  <div className="ao-row-details">
                    <dl>
                      <div>
                        <dt>Persistence</dt>
                        <dd>{resource.durability}</dd>
                      </div>
                      <div>
                        <dt>Access</dt>
                        <dd>
                          {resource.access === 'singleWriter' ? 'Single writer' : resource.access}
                        </dd>
                      </div>
                      <div>
                        <dt>Backup</dt>
                        <dd>
                          {resource.backup?.policy === 'include'
                            ? `${resource.backup.retentionCopies} retained copies`
                            : 'Excluded'}
                        </dd>
                      </div>
                    </dl>
                  </div>
                </details>
              );
            })}
          </div>
        </section>
      )}

      {creating && application.spec ? (
        <CreatePalette
          name={name}
          spec={application.spec}
          onCreated={async () => {
            setCreating(false);
            await load();
          }}
          onClose={() => setCreating(false)}
        />
      ) : null}
      {configuring && application.configuration ? (
        <ConfigurationSetupPanel
          name={name}
          configuration={application.configuration}
          applying={applying}
          onRefresh={load}
          onDeploy={applyChanges}
          onClose={() => setConfiguring(false)}
        />
      ) : null}
    </section>
  );
}

function shortDigest(value: string) {
  return value.replace(/^sha256:/, '').slice(0, 10);
}

function ServiceRow({
  name,
  serviceKey,
  component,
  runtime,
  statusAvailable,
}: {
  name: string;
  serviceKey: string;
  component: RuntimeComponent;
  runtime: RuntimeResponse;
  statusAvailable: boolean;
}) {
  const instances =
    runtime.actual?.instances.filter(
      (item) => item.componentKey === serviceKey && item.status !== 'removed',
    ) ?? [];
  const healthy = instances.filter((item) => item.health === 'healthy').length;
  const ready = statusAvailable && instances.length > 0 && healthy >= component.minimumReady;
  const status = !statusAvailable
    ? 'Not available'
    : component.blocked
      ? 'Configuration needed'
      : ready
        ? 'Healthy'
        : instances.length
          ? `${healthy}/${component.desiredInstances} healthy`
          : 'Not running';
  const routes = Object.values(runtime.execution.routes ?? {}).filter(
    (route) => runtime.execution.services[route.serviceId]?.component === serviceKey,
  );
  return (
    <details className="ao-service">
      <summary>
        <WorkspaceIcon name="terminal" />
        <span className="ao-row-title">
          <strong>{component.displayName ?? serviceKey}</strong>
          <small>
            {routes.find((route) => route.hostname)?.hostname ?? sourceLabel(component)}
          </small>
        </span>
        <span className={`ao-status ${ready ? 'is-healthy' : ''}`}>
          <i aria-hidden />
          {status}
        </span>
        <WorkspaceIcon name="chevron" className="ao-chevron" />
      </summary>
      <div className="ao-row-details">
        <dl>
          <div>
            <dt>{component.source.kind === 'image' ? 'Image' : 'Build context'}</dt>
            <dd>{sourceLabel(component)}</dd>
          </div>
          <div>
            <dt>Instances</dt>
            <dd>
              {component.desiredInstances} configured{statusAvailable ? `, ${healthy} healthy` : ''}
            </dd>
          </div>
          <div>
            <dt>Ports</dt>
            <dd>
              {Object.entries(component.interfaces)
                .map(([key, endpoint]) => `${endpoint.port}/${endpoint.protocol} (${key})`)
                .join(', ') || 'No exposed ports'}
            </dd>
          </div>
          {component.dependencies.length > 0 && (
            <div>
              <dt>Starts after</dt>
              <dd>{component.dependencies.join(', ')}</dd>
            </div>
          )}
          {Object.keys(component.mounts ?? {}).length > 0 && (
            <div>
              <dt>Storage</dt>
              <dd>
                {Object.values(component.mounts)
                  .map((mount) => `${mount.resource}${mount.readOnly ? ' (read only)' : ''}`)
                  .join(', ')}
              </dd>
            </div>
          )}
          {routes.map((route) => (
            <div key={route.name}>
              <dt>{route.name}</dt>
              <dd>
                {route.hostname ? (
                  <a
                    href={`https://${route.hostname}${route.path}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {route.hostname}
                    {route.path} <ExternalLinkIcon />
                  </a>
                ) : (
                  route.path
                )}
              </dd>
            </div>
          ))}
          {instances.map((instance, index) => (
            <div key={index}>
              <dt>Instance {index + 1}</dt>
              <dd>
                {instance.status} / {instance.health}
              </dd>
            </div>
          ))}
        </dl>
        <nav aria-label={`${serviceKey} actions`}>
          <Link to={`/dashboard/${encodeURIComponent(name)}/logs`}>
            View logs <WorkspaceIcon name="chevron" />
          </Link>
          <Link to={`/dashboard/${encodeURIComponent(name)}/settings`}>
            Configuration <WorkspaceIcon name="chevron" />
          </Link>
        </nav>
      </div>
    </details>
  );
}

function DeploymentProgress({ name, build }: { name: string; build: ActiveBuild }) {
  return (
    <details className="ao-progress">
      <summary>
        <WorkspaceIcon name="terminal" />
        <strong>{BUILD_PHASE_LABELS[build.phase] ?? 'Deploying'}</strong>
        <span>View output</span>
        <WorkspaceIcon name="chevron" className="ao-chevron" />
      </summary>
      <pre>
        {build.output.split('\n').slice(-12).join('\n') || 'Waiting for deployment output…'}
      </pre>
      <Link to={`/dashboard/${encodeURIComponent(name)}/releases`}>
        View deployment history <WorkspaceIcon name="chevron" />
      </Link>
    </details>
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
            <WorkspaceIcon name="close" />
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
      <label htmlFor={`application-config-${fieldKey}`}>
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
          <Select
            id={`application-config-${fieldKey}`}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          >
            <option value="">Choose…</option>
            <option value="true">True</option>
            <option value="false">False</option>
          </Select>
        ) : (
          <input
            id={`application-config-${fieldKey}`}
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

/** Saved configuration remains useful when live runtime status is unavailable. */
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
    ['component' as const, 'Service', 'Run a container image'],
    ['resource' as const, 'Storage', 'Keep files across deployments'],
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
        throw new Error(plan.error || 'Unable to preview this application change');
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
      if (!saveResponse.ok)
        throw new Error(result.error || 'Unable to save this application change');
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
      setError(`Service ${componentKey} already exists.`);
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
        aria-labelledby="application-create-title"
      >
        {mode === 'menu' ? (
          <>
            <header className="ao-create-heading">
              <h3 id="application-create-title">Add to application</h3>
              <button type="button" onClick={onClose} aria-label="Close add menu">
                <WorkspaceIcon name="close" />
              </button>
            </header>
            <div>
              {choices.map(([choice, title, description]) => (
                <button key={choice} type="button" onClick={() => setMode(choice)}>
                  <span>
                    <strong>{title}</strong>
                    <small>{description}</small>
                  </span>
                  <WorkspaceIcon name="chevron" />
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
            <h3 id="application-create-title">
              {mode === 'component' ? 'New service' : 'New storage'}
            </h3>
            <TextField
              label="Name"
              autoFocus
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder={mode === 'component' ? 'worker' : 'uploads'}
            />
            {mode === 'component' ? (
              <>
                <label>
                  Service type
                  <Select
                    value={template}
                    onChange={(event) => setTemplate(event.target.value as typeof template)}
                  >
                    <option value="web">Web service</option>
                    <option value="worker">Worker</option>
                    <option value="service">Private service</option>
                    <option value="postgres">PostgreSQL + volume</option>
                  </Select>
                </label>
                <TextField
                  label="Container image"
                  value={image}
                  onChange={(event) => setImage(event.target.value)}
                  placeholder={template === 'postgres' ? 'postgres:16' : 'node:22-alpine'}
                />
              </>
            ) : null}
            {error ? <p className="text-danger">{error}</p> : null}
            <div className="ds-dialog-footer">
              <Button onClick={onClose} disabled={saving}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={saving || !key.trim()}>
                {saving ? 'Adding…' : mode === 'component' ? 'Add service' : 'Add storage'}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function sourceLabel(component: RuntimeComponent): string {
  return component.source.kind === 'image' ? component.source.reference : component.source.context;
}
