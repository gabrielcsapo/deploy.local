'use client';

import { Children, type FormEvent, useId, useState } from 'react';
import type {
  ApplicationSpec,
  ComponentRole,
  ConfigurationType,
  ExecutionScope,
  InterfaceProtocol,
} from '../../../../server/application-spec.ts';

type Component = ApplicationSpec['components'][string];
type Resource = ApplicationSpec['resources'][string];

interface StructuredGraphEditorProps {
  value: ApplicationSpec;
  disabled: boolean;
  onChange: (next: ApplicationSpec) => void;
}

const KEY_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const INTERFACE_PROTOCOLS: InterfaceProtocol[] = [
  'http',
  'https',
  'tcp',
  'udp',
  'postgres',
  'redis',
];

export function StructuredGraphEditor({ value, disabled, onChange }: StructuredGraphEditorProps) {
  const titleId = useId();
  const [componentKey, setComponentKey] = useState('');
  const [componentTemplate, setComponentTemplate] = useState<ComponentTemplate>('web');
  const [resourceKey, setResourceKey] = useState('');
  const [jobKey, setJobKey] = useState('');
  const [configurationKey, setConfigurationKey] = useState('');
  const [addError, setAddError] = useState('');
  const componentEntries = Object.entries(value.components);
  const resourceEntries = Object.entries(value.resources);
  const jobEntries = Object.entries(value.jobs);
  const configurationEntries = Object.entries(value.configuration);
  const isSimple = componentEntries.length === 1;

  function change(mutator: (draft: ApplicationSpec) => void) {
    const draft = structuredClone(value);
    mutator(draft);
    onChange(draft);
  }

  function addComponent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAddError('');
    const preferredKey =
      componentTemplate === 'postgres' ? componentKey || 'postgres' : componentKey;
    const error = keyError(preferredKey, value.components, 'component');
    if (error) {
      setAddError(error);
      return;
    }

    change((draft) => {
      if (componentTemplate === 'postgres') {
        const databaseKey = uniqueKey('database', draft.resources);
        draft.resources[databaseKey] = defaultResource('database');
        draft.components[preferredKey] = defaultComponent('postgres', databaseKey);
      } else {
        draft.components[preferredKey] = defaultComponent(componentTemplate);
      }
    });
    setComponentKey('');
  }

  function addResource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAddError('');
    const error = keyError(resourceKey, value.resources, 'resource');
    if (error) {
      setAddError(error);
      return;
    }
    change((draft) => {
      draft.resources[resourceKey] = defaultResource('files');
    });
    setResourceKey('');
  }

  function addJob(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAddError('');
    const error = keyError(jobKey, value.jobs, 'job');
    if (error) {
      setAddError(error);
      return;
    }
    const firstComponent = Object.keys(value.components)[0];
    if (!firstComponent) {
      setAddError('Add a component before adding a lifecycle job.');
      return;
    }
    change((draft) => {
      draft.jobs[jobKey] = {
        component: firstComponent,
        command: ['sh', '-c', 'true'],
        environment: {},
        execution: 'perSite',
        beforeTraffic: false,
      };
    });
    setJobKey('');
  }

  function addConfiguration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAddError('');
    const normalized = configurationKey.trim();
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(normalized)) {
      setAddError('Configuration keys start with a letter and use letters, numbers, - or _.');
      return;
    }
    if (Object.hasOwn(value.configuration, normalized)) {
      setAddError(`Configuration ${normalized} already exists.`);
      return;
    }
    change((draft) => {
      draft.configuration[normalized] = {
        type: 'string',
        required: true,
        scope: 'application',
      };
    });
    setConfigurationKey('');
  }

  return (
    <div className="space-y-4" aria-labelledby={titleId}>
      <div className="rounded-lg border border-accent/25 bg-accent/5 p-3 sm:p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h4 id={titleId} className="text-sm font-semibold text-text">
              {isSimple ? 'One-component application' : 'Application structure'}
            </h4>
            <p className="mt-1 max-w-2xl text-[11px] text-text-secondary">
              {isSimple
                ? 'Keep the straightforward app you already have, or add a worker, service, database, resource, or job when it earns a place in the graph.'
                : 'Edit stable components and the named relationships between them. Nothing changes at runtime until this draft is previewed, saved, and applied.'}
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5 font-mono text-[10px] text-text-tertiary">
            <GraphChip count={componentEntries.length} label="component" />
            <GraphChip count={resourceEntries.length} label="resource" />
            <GraphChip count={jobEntries.length} label="job" />
          </div>
        </div>
      </div>

      <EditorSection
        title="Components and instances"
        description="Each card is one stable runtime group; changing its count does not create extra graph nodes."
      >
        <div className="space-y-2">
          {componentEntries.map(([key, component]) => (
            <ComponentEditor
              key={key}
              name={key}
              component={component}
              allComponents={Object.keys(value.components)}
              resources={value.resources}
              disabled={disabled}
              initiallyOpen={isSimple}
              onChange={(next) =>
                change((draft) => {
                  draft.components[key] = next;
                })
              }
              onRemove={() =>
                change((draft) => {
                  delete draft.components[key];
                  for (const candidate of Object.values(draft.components)) {
                    candidate.dependsOn = candidate.dependsOn.filter((item) => item !== key);
                  }
                })
              }
            />
          ))}
        </div>
        <form
          className="mt-3 grid gap-2 rounded-lg border border-dashed border-border p-3 sm:grid-cols-[minmax(9rem,1fr)_minmax(10rem,1fr)_auto]"
          onSubmit={addComponent}
        >
          <FieldLabel label="New component key">
            <input
              className="input h-9 text-xs"
              value={componentKey}
              onChange={(event) => setComponentKey(event.target.value)}
              placeholder={componentTemplate === 'postgres' ? 'postgres' : 'worker'}
              disabled={disabled}
            />
          </FieldLabel>
          <FieldLabel label="Starting shape">
            <select
              className="input h-9 text-xs"
              value={componentTemplate}
              onChange={(event) => setComponentTemplate(event.target.value as ComponentTemplate)}
              disabled={disabled}
            >
              <option value="web">Web component</option>
              <option value="worker">Worker</option>
              <option value="service">Private service</option>
              <option value="postgres">Managed PostgreSQL + volume</option>
            </select>
          </FieldLabel>
          <button type="submit" className="btn btn-sm self-end text-xs" disabled={disabled}>
            {componentTemplate === 'postgres' ? 'Add PostgreSQL' : 'Add component'}
          </button>
        </form>
      </EditorSection>

      <div className="grid gap-4 xl:grid-cols-2">
        <EditorSection
          title="Resources"
          description="Volumes remain stable graph resources even when their containers change."
        >
          <div className="space-y-2">
            {resourceEntries.map(([key, resource]) => (
              <ResourceEditor
                key={key}
                name={key}
                resource={resource}
                disabled={disabled}
                onChange={(next) =>
                  change((draft) => {
                    draft.resources[key] = next;
                  })
                }
                onRemove={() =>
                  change((draft) => {
                    delete draft.resources[key];
                  })
                }
              />
            ))}
            {resourceEntries.length === 0 && (
              <EmptyEditorState>No persistent or rebuildable resources.</EmptyEditorState>
            )}
          </div>
          <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={addResource}>
            <FieldLabel label="New resource key" className="min-w-40 flex-1">
              <input
                className="input h-9 text-xs"
                value={resourceKey}
                onChange={(event) => setResourceKey(event.target.value)}
                placeholder="uploads"
                disabled={disabled}
              />
            </FieldLabel>
            <button type="submit" className="btn btn-sm text-xs" disabled={disabled}>
              Add volume
            </button>
          </form>
        </EditorSection>

        <EditorSection
          title="Lifecycle jobs"
          description="Jobs run with a component and can gate traffic, migrations, or site startup."
        >
          <div className="space-y-2">
            {jobEntries.map(([key, job]) => (
              <JobEditor
                key={key}
                name={key}
                job={job}
                components={Object.keys(value.components)}
                disabled={disabled}
                onChange={(next) =>
                  change((draft) => {
                    draft.jobs[key] = next;
                  })
                }
                onRemove={() =>
                  change((draft) => {
                    delete draft.jobs[key];
                  })
                }
              />
            ))}
            {jobEntries.length === 0 && <EmptyEditorState>No lifecycle jobs.</EmptyEditorState>}
          </div>
          <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={addJob}>
            <FieldLabel label="New job key" className="min-w-40 flex-1">
              <input
                className="input h-9 text-xs"
                value={jobKey}
                onChange={(event) => setJobKey(event.target.value)}
                placeholder="migrate"
                disabled={disabled}
              />
            </FieldLabel>
            <button type="submit" className="btn btn-sm text-xs" disabled={disabled}>
              Add job
            </button>
          </form>
        </EditorSection>
      </div>

      <EditorSection
        title="Administrator configuration"
        description="Declare the values components may bind to. Secret values stay server-side and never enter this manifest."
      >
        <div className="grid gap-2 md:grid-cols-2">
          {configurationEntries.map(([key, declaration]) => (
            <div key={key} className="rounded-md border border-border/80 bg-bg/30 p-3">
              <div className="flex items-center justify-between gap-2">
                <code className="text-xs font-semibold text-text">{key}</code>
                <button
                  type="button"
                  className="text-[10px] text-text-tertiary hover:text-danger"
                  onClick={() =>
                    change((draft) => {
                      delete draft.configuration[key];
                    })
                  }
                  disabled={disabled}
                >
                  Remove from draft
                </button>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <FieldLabel label="Type">
                  <select
                    className="input h-8 text-[11px]"
                    value={declaration.type}
                    onChange={(event) =>
                      change((draft) => {
                        draft.configuration[key].type = event.target.value as ConfigurationType;
                      })
                    }
                    disabled={disabled}
                  >
                    {[
                      'string',
                      'secret',
                      'boolean',
                      'number',
                      'integer',
                      'url',
                      'enum',
                      'file',
                    ].map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </select>
                </FieldLabel>
                <FieldLabel label="Scope">
                  <select
                    className="input h-8 text-[11px]"
                    value={declaration.scope}
                    onChange={(event) =>
                      change((draft) => {
                        draft.configuration[key].scope = event.target.value as
                          | 'application'
                          | 'site';
                      })
                    }
                    disabled={disabled}
                  >
                    <option value="application">Application</option>
                    <option value="site">Per site</option>
                  </select>
                </FieldLabel>
              </div>
              <label className="mt-2 flex items-center gap-2 text-[11px] text-text-secondary">
                <input
                  type="checkbox"
                  checked={declaration.required}
                  onChange={(event) =>
                    change((draft) => {
                      draft.configuration[key].required = event.target.checked;
                    })
                  }
                  disabled={disabled}
                />
                Required before start
              </label>
            </div>
          ))}
        </div>
        <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={addConfiguration}>
          <FieldLabel label="New configuration key" className="min-w-48 flex-1">
            <input
              className="input h-9 text-xs"
              value={configurationKey}
              onChange={(event) => setConfigurationKey(event.target.value)}
              placeholder="adminPassword"
              disabled={disabled}
            />
          </FieldLabel>
          <button type="submit" className="btn btn-sm text-xs" disabled={disabled}>
            Declare value
          </button>
        </form>
      </EditorSection>

      {addError && (
        <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">
          {addError}
        </p>
      )}
    </div>
  );
}

function ComponentEditor({
  name,
  component,
  allComponents,
  resources,
  disabled,
  initiallyOpen,
  onChange,
  onRemove,
}: {
  name: string;
  component: Component;
  allComponents: string[];
  resources: ApplicationSpec['resources'];
  disabled: boolean;
  initiallyOpen: boolean;
  onChange: (next: Component) => void;
  onRemove: () => void;
}) {
  const [bindingName, setBindingName] = useState('');
  const [bindingFrom, setBindingFrom] = useState('');
  const [mountPath, setMountPath] = useState('');
  const [mountResource, setMountResource] = useState(Object.keys(resources)[0] ?? '');
  const [interfaceName, setInterfaceName] = useState('');
  const [interfacePort, setInterfacePort] = useState('3000');
  const [interfaceProtocol, setInterfaceProtocol] = useState<InterfaceProtocol>('http');
  const [open, setOpen] = useState(initiallyOpen);
  const readyLabel = `${component.minimumReady}/${component.instances}`;
  const isPostgres = component.profile === 'deploy.local/postgres@1';

  function patch(mutator: (draft: Component) => void) {
    const draft = structuredClone(component);
    mutator(draft);
    onChange(draft);
  }

  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="group rounded-lg border border-border/80 bg-bg/30"
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 px-3 py-3 marker:hidden">
        <span
          className={`h-2.5 w-2.5 shrink-0 rounded-full ${isPostgres ? 'bg-accent' : 'bg-success'}`}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <code className="text-xs font-semibold text-text">{name}</code>
            <span className="badge bg-bg-active text-text-secondary">{component.role}</span>
            {isPostgres && <span className="badge badge-accent">Managed PostgreSQL</span>}
          </span>
          <span className="mt-1 block truncate text-[10px] text-text-tertiary">
            {component.image ?? `build ${component.build?.context ?? '.'}`} · ready contract{' '}
            {readyLabel}
          </span>
        </span>
        <span className="font-mono text-[10px] text-text-tertiary group-open:hidden">Edit</span>
        <span className="hidden font-mono text-[10px] text-text-tertiary group-open:inline">
          Close
        </span>
      </summary>
      <div className="space-y-4 border-t border-border/80 p-3">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <FieldLabel label="Display name">
            <input
              className="input h-9 text-xs"
              value={component.displayName ?? ''}
              onChange={(event) =>
                patch((draft) => {
                  draft.displayName = event.target.value || undefined;
                })
              }
              placeholder={name}
              disabled={disabled}
            />
          </FieldLabel>
          <FieldLabel label="Role">
            <select
              className="input h-9 text-xs"
              value={component.role}
              onChange={(event) =>
                patch((draft) => {
                  draft.role = event.target.value as ComponentRole;
                })
              }
              disabled={disabled}
            >
              <option value="web">Web</option>
              <option value="worker">Worker</option>
              <option value="service">Service</option>
            </select>
          </FieldLabel>
          <FieldLabel label="Instances">
            <input
              className="input h-9 text-xs"
              type="number"
              min={1}
              max={256}
              value={component.instances}
              onChange={(event) => {
                const instances = Math.max(1, Number(event.target.value) || 1);
                patch((draft) => {
                  draft.instances = instances;
                  draft.minimumReady = Math.min(draft.minimumReady, instances);
                });
              }}
              disabled={disabled || isPostgres}
              title={
                isPostgres ? 'The PostgreSQL v1 profile supports exactly one instance.' : undefined
              }
            />
          </FieldLabel>
          <FieldLabel label="Minimum ready">
            <input
              className="input h-9 text-xs"
              type="number"
              min={1}
              max={component.instances}
              value={component.minimumReady}
              onChange={(event) =>
                patch((draft) => {
                  draft.minimumReady = Math.max(
                    1,
                    Math.min(component.instances, Number(event.target.value) || 1),
                  );
                })
              }
              disabled={disabled}
            />
          </FieldLabel>
        </div>

        <div className="grid gap-2 sm:grid-cols-[9rem_minmax(0,1fr)]">
          <FieldLabel label="Source">
            <select
              className="input h-9 text-xs"
              value={component.image ? 'image' : 'build'}
              onChange={(event) =>
                patch((draft) => {
                  if (event.target.value === 'image') {
                    draft.image = 'busybox:latest';
                    delete draft.build;
                  } else {
                    draft.build = { context: '.', ignore: [] };
                    delete draft.image;
                  }
                })
              }
              disabled={disabled || isPostgres}
            >
              <option value="image">Container image</option>
              <option value="build">Build context</option>
            </select>
          </FieldLabel>
          <FieldLabel label={component.image ? 'Image reference' : 'Build context'}>
            <input
              className="input h-9 font-mono text-xs"
              value={component.image ?? component.build?.context ?? '.'}
              onChange={(event) =>
                patch((draft) => {
                  if (draft.image !== undefined) draft.image = event.target.value;
                  else if (draft.build) draft.build.context = event.target.value;
                })
              }
              disabled={disabled}
            />
          </FieldLabel>
        </div>

        <fieldset>
          <legend className="text-[10px] font-medium text-text-tertiary">Dependencies</legend>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {allComponents
              .filter((candidate) => candidate !== name)
              .map((candidate) => (
                <label
                  key={candidate}
                  className="flex items-center gap-1.5 rounded-md border border-border/80 bg-bg px-2 py-1.5 text-[11px] text-text-secondary"
                >
                  <input
                    type="checkbox"
                    checked={component.dependsOn.includes(candidate)}
                    onChange={(event) =>
                      patch((draft) => {
                        draft.dependsOn = event.target.checked
                          ? [...new Set([...draft.dependsOn, candidate])]
                          : draft.dependsOn.filter((item) => item !== candidate);
                      })
                    }
                    disabled={disabled}
                  />
                  {candidate}
                </label>
              ))}
            {allComponents.length === 1 && (
              <span className="text-[11px] text-text-tertiary">
                No other components to depend on.
              </span>
            )}
          </div>
        </fieldset>

        <div className="grid gap-3 xl:grid-cols-3">
          <RelationEditor title="Interfaces" empty="No private interface.">
            {Object.entries(component.interfaces).map(([key, item]) => (
              <RelationRow key={key} label={key} detail={`${item.protocol}:${item.port}`}>
                <button
                  type="button"
                  className="text-text-tertiary hover:text-danger"
                  onClick={() =>
                    patch((draft) => {
                      delete draft.interfaces[key];
                    })
                  }
                  disabled={disabled || (isPostgres && key === 'postgres')}
                  aria-label={`Remove ${key} interface from ${name}`}
                >
                  ×
                </button>
              </RelationRow>
            ))}
            <div className="grid grid-cols-[1fr_5rem_6rem_auto] gap-1 border-t border-border/70 pt-2">
              <input
                className="input h-8 min-w-0 text-[10px]"
                value={interfaceName}
                onChange={(event) => setInterfaceName(event.target.value)}
                placeholder="http"
                aria-label={`New interface name for ${name}`}
                disabled={disabled}
              />
              <input
                className="input h-8 min-w-0 text-[10px]"
                type="number"
                value={interfacePort}
                onChange={(event) => setInterfacePort(event.target.value)}
                aria-label={`New interface port for ${name}`}
                disabled={disabled}
              />
              <select
                className="input h-8 min-w-0 text-[10px]"
                value={interfaceProtocol}
                onChange={(event) => setInterfaceProtocol(event.target.value as InterfaceProtocol)}
                aria-label={`New interface protocol for ${name}`}
                disabled={disabled}
              >
                {INTERFACE_PROTOCOLS.map((protocol) => (
                  <option key={protocol}>{protocol}</option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-sm px-2 text-[10px]"
                onClick={() => {
                  if (
                    !KEY_PATTERN.test(interfaceName) ||
                    Object.hasOwn(component.interfaces, interfaceName)
                  )
                    return;
                  const port = Number(interfacePort);
                  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return;
                  patch((draft) => {
                    draft.interfaces[interfaceName] = { protocol: interfaceProtocol, port };
                  });
                  setInterfaceName('');
                }}
                disabled={disabled}
              >
                Add
              </button>
            </div>
          </RelationEditor>

          <RelationEditor title="Environment bindings" empty="No declared bindings.">
            {Object.entries(component.environment).map(([key, binding]) => (
              <RelationRow key={key} label={key} detail={`← ${binding.from}`}>
                <button
                  type="button"
                  className="text-text-tertiary hover:text-danger"
                  onClick={() =>
                    patch((draft) => {
                      delete draft.environment[key];
                    })
                  }
                  disabled={disabled}
                  aria-label={`Remove ${key} binding from ${name}`}
                >
                  ×
                </button>
              </RelationRow>
            ))}
            <div className="grid grid-cols-[1fr_1fr_auto] gap-1 border-t border-border/70 pt-2">
              <input
                className="input h-8 min-w-0 text-[10px]"
                value={bindingName}
                onChange={(event) => setBindingName(event.target.value)}
                placeholder="DATABASE_URL"
                aria-label={`New environment name for ${name}`}
                disabled={disabled}
              />
              <input
                className="input h-8 min-w-0 text-[10px]"
                value={bindingFrom}
                onChange={(event) => setBindingFrom(event.target.value)}
                placeholder="postgres.postgres"
                aria-label={`New environment source for ${name}`}
                disabled={disabled}
              />
              <button
                type="button"
                className="btn btn-sm px-2 text-[10px]"
                onClick={() => {
                  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(bindingName) || !bindingFrom.trim()) return;
                  patch((draft) => {
                    draft.environment[bindingName] = { from: bindingFrom.trim() };
                  });
                  setBindingName('');
                  setBindingFrom('');
                }}
                disabled={disabled}
              >
                Bind
              </button>
            </div>
          </RelationEditor>

          <RelationEditor title="Volume mounts" empty="No attached volume.">
            {Object.entries(component.mounts).map(([path, mount]) => (
              <RelationRow
                key={path}
                label={mount.resource}
                detail={`at ${path}${mount.readOnly ? ' · read only' : ''}`}
              >
                <button
                  type="button"
                  className="text-text-tertiary hover:text-danger"
                  onClick={() =>
                    patch((draft) => {
                      delete draft.mounts[path];
                    })
                  }
                  disabled={disabled || (isPostgres && path === '/var/lib/postgresql/data')}
                  aria-label={`Remove ${mount.resource} mount from ${name}`}
                >
                  ×
                </button>
              </RelationRow>
            ))}
            <div className="grid grid-cols-[1fr_1fr_auto] gap-1 border-t border-border/70 pt-2">
              <input
                className="input h-8 min-w-0 text-[10px]"
                value={mountPath}
                onChange={(event) => setMountPath(event.target.value)}
                placeholder="/data"
                aria-label={`New mount path for ${name}`}
                disabled={disabled}
              />
              <select
                className="input h-8 min-w-0 text-[10px]"
                value={mountResource}
                onChange={(event) => setMountResource(event.target.value)}
                aria-label={`New mount resource for ${name}`}
                disabled={disabled}
              >
                <option value="">Choose volume</option>
                {Object.keys(resources).map((key) => (
                  <option key={key}>{key}</option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-sm px-2 text-[10px]"
                onClick={() => {
                  if (!mountPath.startsWith('/') || !Object.hasOwn(resources, mountResource))
                    return;
                  patch((draft) => {
                    draft.mounts[mountPath] = { resource: mountResource, readOnly: false };
                  });
                  setMountPath('');
                }}
                disabled={disabled || Object.keys(resources).length === 0}
              >
                Mount
              </button>
            </div>
          </RelationEditor>
        </div>

        <div className="flex justify-end border-t border-border/70 pt-3">
          <button
            type="button"
            className="text-[11px] text-text-tertiary hover:text-danger"
            onClick={onRemove}
            disabled={disabled}
          >
            Remove {name} from draft
          </button>
        </div>
      </div>
    </details>
  );
}

function ResourceEditor({
  name,
  resource,
  disabled,
  onChange,
  onRemove,
}: {
  name: string;
  resource: Resource;
  disabled: boolean;
  onChange: (next: Resource) => void;
  onRemove: () => void;
}) {
  function patch(mutator: (draft: Resource) => void) {
    const draft = structuredClone(resource);
    mutator(draft);
    onChange(draft);
  }
  return (
    <div className="rounded-md border border-border/80 bg-bg/30 p-3">
      <div className="flex items-center justify-between gap-2">
        <code className="text-xs font-semibold text-text">{name}</code>
        <button
          type="button"
          className="text-[10px] text-text-tertiary hover:text-danger"
          onClick={onRemove}
          disabled={disabled}
        >
          Remove from draft
        </button>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-1.5">
        <FieldLabel label="Data role">
          <select
            className="input h-8 text-[10px]"
            value={resource.dataRole}
            onChange={(event) =>
              patch((draft) => {
                draft.dataRole = event.target.value as Resource['dataRole'];
              })
            }
            disabled={disabled}
          >
            <option value="files">Files</option>
            <option value="database">Database</option>
            <option value="cache">Cache</option>
          </select>
        </FieldLabel>
        <FieldLabel label="Durability">
          <select
            className="input h-8 text-[10px]"
            value={resource.durability}
            onChange={(event) =>
              patch((draft) => {
                draft.durability = event.target.value as Resource['durability'];
              })
            }
            disabled={disabled}
          >
            <option value="durable">Durable</option>
            <option value="rebuildable">Rebuildable</option>
            <option value="ephemeral">Ephemeral</option>
          </select>
        </FieldLabel>
        <FieldLabel label="Access">
          <select
            className="input h-8 text-[10px]"
            value={resource.access}
            onChange={(event) =>
              patch((draft) => {
                draft.access = event.target.value as Resource['access'];
              })
            }
            disabled={disabled}
          >
            <option value="singleWriter">Single writer</option>
            <option value="multipleReaders">Multiple readers</option>
            <option value="sharedWriters">Shared writers</option>
          </select>
        </FieldLabel>
      </div>
    </div>
  );
}

function JobEditor({
  name,
  job,
  components,
  disabled,
  onChange,
  onRemove,
}: {
  name: string;
  job: ApplicationSpec['jobs'][string];
  components: string[];
  disabled: boolean;
  onChange: (next: ApplicationSpec['jobs'][string]) => void;
  onRemove: () => void;
}) {
  const [bindingName, setBindingName] = useState('');
  const [bindingFrom, setBindingFrom] = useState('');
  function patch(mutator: (draft: ApplicationSpec['jobs'][string]) => void) {
    const draft = structuredClone(job);
    mutator(draft);
    onChange(draft);
  }
  return (
    <div className="rounded-md border border-border/80 bg-bg/30 p-3">
      <div className="flex items-center justify-between gap-2">
        <code className="text-xs font-semibold text-text">{name}</code>
        <button
          type="button"
          className="text-[10px] text-text-tertiary hover:text-danger"
          onClick={onRemove}
          disabled={disabled}
        >
          Remove from draft
        </button>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <FieldLabel label="Runs with">
          <select
            className="input h-8 text-[10px]"
            value={job.component}
            onChange={(event) =>
              patch((draft) => {
                draft.component = event.target.value;
              })
            }
            disabled={disabled}
          >
            {components.map((component) => (
              <option key={component}>{component}</option>
            ))}
          </select>
        </FieldLabel>
        <FieldLabel label="Execution">
          <select
            className="input h-8 text-[10px]"
            value={job.execution}
            onChange={(event) =>
              patch((draft) => {
                draft.execution = event.target.value as ExecutionScope;
              })
            }
            disabled={disabled}
          >
            <option value="perInstance">Per instance</option>
            <option value="perSite">Once per site</option>
            <option value="writerSite">Writer site</option>
          </select>
        </FieldLabel>
      </div>
      <FieldLabel label="Command" className="mt-2">
        <input
          className="input h-8 font-mono text-[10px]"
          value={job.command.join(' ')}
          onChange={(event) =>
            patch((draft) => {
              draft.command = event.target.value.trim().split(/\s+/).filter(Boolean);
            })
          }
          disabled={disabled}
        />
      </FieldLabel>
      <div className="mt-2 rounded-md border border-border/70 bg-bg/25 p-2.5">
        <p className="font-mono text-[9px] uppercase tracking-wider text-text-tertiary">
          Job bindings
        </p>
        <div className="mt-2 space-y-1">
          {Object.entries(job.environment).map(([key, binding]) => (
            <RelationRow key={key} label={key} detail={`← ${binding.from}`}>
              <button
                type="button"
                className="text-text-tertiary hover:text-danger"
                onClick={() =>
                  patch((draft) => {
                    delete draft.environment[key];
                  })
                }
                disabled={disabled}
                aria-label={`Remove ${key} binding from ${name}`}
              >
                ×
              </button>
            </RelationRow>
          ))}
          {Object.keys(job.environment).length === 0 && (
            <p className="py-1 text-[10px] text-text-tertiary">No declared bindings.</p>
          )}
          <div className="grid grid-cols-[1fr_1fr_auto] gap-1 border-t border-border/70 pt-2">
            <input
              className="input h-8 min-w-0 text-[10px]"
              value={bindingName}
              onChange={(event) => setBindingName(event.target.value)}
              placeholder="DATABASE_URL"
              aria-label={`New environment name for ${name}`}
              disabled={disabled}
            />
            <input
              className="input h-8 min-w-0 text-[10px]"
              value={bindingFrom}
              onChange={(event) => setBindingFrom(event.target.value)}
              placeholder="postgres.postgres"
              aria-label={`New environment source for ${name}`}
              disabled={disabled}
            />
            <button
              type="button"
              className="btn btn-sm px-2 text-[10px]"
              onClick={() => {
                if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(bindingName) || !bindingFrom.trim()) return;
                patch((draft) => {
                  draft.environment[bindingName] = { from: bindingFrom.trim() };
                });
                setBindingName('');
                setBindingFrom('');
              }}
              disabled={disabled}
            >
              Bind
            </button>
          </div>
        </div>
      </div>
      <label className="mt-2 flex items-center gap-2 text-[11px] text-text-secondary">
        <input
          type="checkbox"
          checked={job.beforeTraffic}
          onChange={(event) =>
            patch((draft) => {
              draft.beforeTraffic = event.target.checked;
            })
          }
          disabled={disabled}
        />
        Complete before traffic
      </label>
    </div>
  );
}

function EditorSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border/80 bg-bg/20 p-3 sm:p-4">
      <h4 className="text-[10px] font-mono uppercase tracking-wider text-text-tertiary">{title}</h4>
      <p className="mt-1 text-[11px] text-text-secondary">{description}</p>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function RelationEditor({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children: React.ReactNode;
}) {
  const items = Children.toArray(children);
  const content = items.slice(0, -1);
  const form = items.at(-1);
  return (
    <section className="rounded-md border border-border/70 bg-bg/25 p-2.5">
      <h5 className="font-mono text-[9px] uppercase tracking-wider text-text-tertiary">{title}</h5>
      <div className="mt-2 space-y-1">
        {content.length > 0 ? (
          content
        ) : (
          <p className="py-1 text-[10px] text-text-tertiary">{empty}</p>
        )}
        {form}
      </div>
    </section>
  );
}

function RelationRow({
  label,
  detail,
  children,
}: {
  label: string;
  detail: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 rounded bg-bg px-2 py-1.5 font-mono text-[9px]">
      <span className="min-w-0 flex-1 truncate text-text-secondary" title={`${label} ${detail}`}>
        <strong className="font-semibold text-text">{label}</strong> {detail}
      </span>
      {children}
    </div>
  );
}

function FieldLabel({
  label,
  className = '',
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1 block text-[9px] font-mono uppercase tracking-wider text-text-tertiary">
        {label}
      </span>
      {children}
    </label>
  );
}

function GraphChip({ count, label }: { count: number; label: string }) {
  return (
    <span className="rounded-md border border-border/80 bg-bg px-2 py-1">
      {count} {count === 1 ? label : `${label}s`}
    </span>
  );
}

function EmptyEditorState({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-dashed border-border px-3 py-3 text-[11px] text-text-tertiary">
      {children}
    </p>
  );
}

type ComponentTemplate = 'web' | 'worker' | 'service' | 'postgres';

function defaultComponent(template: ComponentTemplate, databaseResource?: string): Component {
  const base: Component = {
    role: template === 'web' ? 'web' : template === 'worker' ? 'worker' : 'service',
    instances: 1,
    minimumReady: 1,
    rollout: { strategy: 'rolling', maxSurge: 1, maxUnavailable: 0, schemaOverlap: 'compatible' },
    siteOverrides: { allowed: false, minimum: 1, maximum: 256 },
    capacity: {},
    placement: { intent: 'coLocate', requiredLabels: {} },
    interfaces: {},
    environment: {},
    configurationFiles: {},
    mounts: {},
    dependsOn: [],
    runtime: {
      gpus: false,
      privileged: false,
      privilegedDocker: false,
      networkMode: 'private',
      devices: [],
      runArgs: [],
      networks: [],
    },
  };
  if (template === 'web') {
    base.image = 'nginx:alpine';
    base.interfaces.http = { protocol: 'http', port: 80 };
    base.health = { interface: 'http', path: '/' };
  } else if (template === 'worker') {
    base.image = 'busybox:latest';
    base.command = ['sh', '-c', 'while true; do sleep 3600; done'];
  } else if (template === 'postgres') {
    base.image = 'postgres:18';
    base.profile = 'deploy.local/postgres@1';
    base.interfaces.postgres = { protocol: 'postgres', port: 5432 };
    base.mounts['/var/lib/postgresql/data'] = { resource: databaseResource!, readOnly: false };
    base.health = { interface: 'postgres' };
  } else {
    base.image = 'busybox:latest';
    base.command = ['sh', '-c', 'while true; do sleep 3600; done'];
  }
  return base;
}

function defaultResource(dataRole: Resource['dataRole']): Resource {
  return {
    type: 'volume',
    durability: dataRole === 'cache' ? 'rebuildable' : 'durable',
    dataRole,
    access: 'singleWriter',
    consistencyGroup: 'default',
    ownership: 'application',
    backup: { policy: dataRole === 'cache' ? 'exclude' : 'include', retentionCopies: 7 },
    suitcase: { allowedDataModes: ['site-local'] },
  };
}

function keyError(key: string, record: Record<string, unknown>, kind: string): string {
  if (!KEY_PATTERN.test(key))
    return `${kind[0].toUpperCase()}${kind.slice(1)} keys start with a letter and use lowercase letters, numbers, or hyphens.`;
  if (Object.hasOwn(record, key))
    return `${kind[0].toUpperCase()}${kind.slice(1)} ${key} already exists.`;
  return '';
}

function uniqueKey(preferred: string, record: Record<string, unknown>): string {
  if (!Object.hasOwn(record, preferred)) return preferred;
  let suffix = 2;
  while (Object.hasOwn(record, `${preferred}-${suffix}`)) suffix += 1;
  return `${preferred}-${suffix}`;
}
