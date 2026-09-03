import { isAlias, parseDocument, visit } from 'yaml';
import {
  emptyApplicationSpec,
  planApplicationChange,
  type ApplicationChangePlan,
} from '../application-plan.ts';
import {
  compileApplicationManifest,
  type ApplicationManifest,
  type ApplicationSpec,
  type ComponentManifest,
} from '../application-spec.ts';

export type ComposeImportDisposition = 'translated' | 'ignored' | 'review-required' | 'blocking';

export interface ComposeImportFinding {
  path: string;
  disposition: ComposeImportDisposition;
  summary: string;
  securitySensitive: boolean;
}

export interface ComposeImportResult {
  status: 'ready' | 'review-required' | 'blocked';
  spec: ApplicationSpec | null;
  plan: ApplicationChangePlan | null;
  findings: ComposeImportFinding[];
  sourceOfTruth: 'deploy.yaml';
  note: string;
}

export function importDockerCompose(
  source: string,
  applicationName = 'compose-import',
): ComposeImportResult {
  const findings: ComposeImportFinding[] = [];
  const document = parseDocument(source, {
    version: '1.2',
    schema: 'core',
    merge: false,
    strict: true,
    stringKeys: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    return blockedResult(
      [...document.errors, ...document.warnings].map((error) => ({
        path: '$',
        disposition: 'blocking' as const,
        summary: error.message,
        securitySensitive: false,
      })),
    );
  }
  let alias = false;
  visit(document, {
    Node(_key, node) {
      if (isAlias(node) || node.anchor) {
        alias = true;
        return visit.BREAK;
      }
    },
  });
  if (alias) {
    return blockedResult([
      {
        path: '$',
        disposition: 'blocking',
        summary: 'YAML anchors and aliases are not accepted by the strict Compose importer.',
        securitySensitive: false,
      },
    ]);
  }

  const root = asRecord(document.toJS({ maxAliasCount: 0 }));
  if (!root) return blockedResult([blocking('$', 'Compose document must be an object.')]);
  const services = asRecord(root.services);
  if (!services || Object.keys(services).length === 0) {
    return blockedResult([blocking('$.services', 'Compose document must define services.')]);
  }

  const manifest: ApplicationManifest = {
    apiVersion: 'deploy.local/v1',
    kind: 'Application',
    metadata: { name: applicationName, description: 'Strict Docker Compose import' },
    configuration: {},
    components: {},
    resources: {},
    routes: {},
  };
  const declaredVolumes = translateTopLevelVolumes(root.volumes, manifest, findings);
  const declaredNetworks = translateTopLevelNetworks(root.networks, findings);

  for (const [field, value] of Object.entries(root)) {
    if (field === 'services' || field === 'volumes' || field === 'networks') continue;
    if (field === 'name' || field === 'version') {
      findings.push({
        path: `$.${field}`,
        disposition: 'ignored',
        summary: `${field} is recorded in this report but deploy.local uses the requested application identity and v1 schema.`,
        securitySensitive: false,
      });
    } else if (field === 'secrets' || field === 'configs') {
      const declarations = asRecord(value);
      if (!declarations) {
        findings.push(blocking(`$.${field}`, `Compose ${field} must be an object.`, true));
        continue;
      }
      for (const key of Object.keys(declarations)) {
        findings.push(
          blocking(
            `$.${field}.${key}`,
            `Compose ${field} must be converted to declared deploy.local configuration and scoped bindings.`,
            true,
          ),
        );
      }
      if (Object.keys(declarations).length === 0) {
        findings.push(ignored(`$.${field}`, `Empty Compose ${field} section.`));
      }
    } else if (field.startsWith('x-')) {
      findings.push(ignored(`$.${field}`, 'Compose extension metadata is not runtime state.'));
    } else {
      findings.push(blocking(`$.${field}`, `Unsupported top-level Compose field ${field}.`));
    }
  }

  for (const [serviceName, rawService] of Object.entries(services)) {
    const path = `$.services.${serviceName}`;
    const service = asRecord(rawService);
    if (!service) {
      findings.push(blocking(path, 'Service must be an object.'));
      continue;
    }
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(serviceName)) {
      findings.push(
        blocking(
          path,
          'Service name must already be a deploy.local-safe lowercase name; names are never rewritten silently.',
        ),
      );
      continue;
    }
    const component: ComponentManifest = {};
    translateServiceIdentity(service, path, component, findings);
    translateCommand(service, path, component, findings);
    translateEnvironment(service, path, manifest, component, findings);
    translateVolumes(service, path, declaredVolumes, component, findings);
    translatePorts(service, path, component, findings);
    translateDependencies(service, path, component, findings);
    translateHealth(service, path, component, findings);
    translateNetworks(service, path, declaredNetworks, component, findings);
    translateSecurityAndUnsupported(service, path, component, findings);
    manifest.components[serviceName] = component;
  }

  let spec: ApplicationSpec | null = null;
  try {
    spec = compileApplicationManifest(manifest).spec;
  } catch (error) {
    findings.push(blocking('$', `Normalized graph is invalid: ${(error as Error).message}`));
  }

  const status = findings.some((finding) => finding.disposition === 'blocking')
    ? 'blocked'
    : findings.some((finding) => finding.disposition === 'review-required')
      ? 'review-required'
      : 'ready';
  return {
    status,
    spec,
    plan: spec
      ? planApplicationChange(emptyApplicationSpec(applicationName), spec, {
          source: 'compose-import',
        })
      : null,
    findings,
    sourceOfTruth: 'deploy.yaml',
    note: 'Compose is import input only. Resolve every blocking/review item, then persist and run the normalized deploy.yaml graph.',
  };
}

function translateTopLevelVolumes(
  raw: unknown,
  manifest: ApplicationManifest,
  findings: ComposeImportFinding[],
): Set<string> {
  const volumes = asRecord(raw) ?? {};
  const names = new Set<string>();
  for (const [name, value] of Object.entries(volumes)) {
    const path = `$.volumes.${name}`;
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(name)) {
      findings.push(blocking(path, 'Named volume must use a deploy.local-safe lowercase name.'));
      continue;
    }
    const options = value === null ? {} : asRecord(value);
    if (!options) {
      findings.push(blocking(path, 'Named volume definition must be an object or null.'));
      continue;
    }
    const unsupported = Object.keys(options).filter(
      (field) => field !== 'driver' && !field.startsWith('x-'),
    );
    if (options.driver !== undefined && options.driver !== 'local') {
      findings.push(
        blocking(`${path}.driver`, 'Only the local named-volume driver can be translated.'),
      );
    }
    for (const field of unsupported) {
      findings.push(blocking(`${path}.${field}`, `Unsupported named-volume field ${field}.`));
    }
    for (const field of Object.keys(options).filter((key) => key.startsWith('x-'))) {
      findings.push(ignored(`${path}.${field}`, 'Volume extension metadata is not runtime state.'));
    }
    names.add(name);
    manifest.resources![name] = {
      type: 'volume',
      durability: 'durable',
      dataRole: 'files',
      access: 'singleWriter',
    };
    findings.push(translated(path, 'Named volume translated to a durable single-writer resource.'));
  }
  return names;
}

function translateTopLevelNetworks(
  raw: unknown,
  findings: ComposeImportFinding[],
): Map<string, { name: string; driver?: string }> {
  const networks = asRecord(raw) ?? {};
  const output = new Map<string, { name: string; driver?: string }>();
  for (const [name, value] of Object.entries(networks)) {
    const path = `$.networks.${name}`;
    const options = value === null ? {} : asRecord(value);
    if (!options) {
      findings.push(blocking(path, 'Network definition must be an object or null.'));
      continue;
    }
    if (options.external === true) {
      findings.push(
        blocking(`${path}.external`, 'External networks require explicit host-level review.', true),
      );
    } else if (options.external === false) {
      findings.push(
        ignored(`${path}.external`, 'Explicit non-external network matches the private default.'),
      );
    }
    if (options.driver !== undefined && options.driver !== 'bridge') {
      findings.push(blocking(`${path}.driver`, 'Only private bridge networks can be translated.'));
    }
    for (const field of Object.keys(options)) {
      if (field === 'driver' || field === 'external') continue;
      if (field.startsWith('x-')) findings.push(ignored(`${path}.${field}`, 'Extension metadata.'));
      else findings.push(blocking(`${path}.${field}`, `Unsupported network field ${field}.`));
    }
    output.set(name, { name, ...(options.driver === 'bridge' ? { driver: 'bridge' } : {}) });
    findings.push(translated(path, 'Network translated to an application-private network.'));
  }
  return output;
}

function translateServiceIdentity(
  service: Record<string, unknown>,
  path: string,
  component: ComponentManifest,
  findings: ComposeImportFinding[],
) {
  if (typeof service.image === 'string') {
    component.image = service.image;
    findings.push(
      translated(`${path}.image`, 'Image reference translated without tag resolution.'),
    );
    if (!/@sha256:[a-f0-9]{64}$/.test(service.image)) {
      findings.push({
        path: `${path}.image`,
        disposition: 'review-required',
        summary:
          'Image is not digest-pinned; resolve it before saving an immutable deployment graph.',
        securitySensitive: true,
      });
    }
  } else if (service.image !== undefined) {
    findings.push(blocking(`${path}.image`, 'Image must be a string reference.'));
  }
  if (service.build !== undefined) {
    if (typeof service.build === 'string') {
      component.build = { context: service.build };
      findings.push(translated(`${path}.build`, 'Build context translated.'));
    } else {
      const build = asRecord(service.build);
      if (!build || typeof build.context !== 'string') {
        findings.push(blocking(`${path}.build`, 'Build requires a string context.'));
      } else {
        component.build = {
          context: build.context,
          ...(typeof build.dockerfile === 'string' ? { dockerfile: build.dockerfile } : {}),
          ...(typeof build.target === 'string' ? { target: build.target } : {}),
        };
        for (const field of Object.keys(build)) {
          if (!['context', 'dockerfile', 'target'].includes(field)) {
            findings.push(blocking(`${path}.build.${field}`, `Unsupported build field ${field}.`));
          }
        }
        findings.push(
          translated(`${path}.build`, 'Build context, Dockerfile, and target translated.'),
        );
      }
    }
  }
  if ((service.image === undefined) === (service.build === undefined)) {
    findings.push(blocking(path, 'Service must declare exactly one of image or build.'));
  }
}

function translateCommand(
  service: Record<string, unknown>,
  path: string,
  component: ComponentManifest,
  findings: ComposeImportFinding[],
) {
  if (service.command === undefined) return;
  if (
    Array.isArray(service.command) &&
    service.command.every((value) => typeof value === 'string')
  ) {
    component.command = service.command as string[];
    findings.push(translated(`${path}.command`, 'Exec-form command translated exactly.'));
  } else {
    findings.push(
      blocking(
        `${path}.command`,
        'Shell-form commands are ambiguous; use an explicit string array.',
      ),
    );
  }
}

function translateEnvironment(
  service: Record<string, unknown>,
  path: string,
  manifest: ApplicationManifest,
  component: ComponentManifest,
  findings: ComposeImportFinding[],
) {
  if (service.environment === undefined) return;
  const environment = asRecord(service.environment);
  if (!environment) {
    findings.push(blocking(`${path}.environment`, 'Only mapping-form environment is supported.'));
    return;
  }
  component.environment = {};
  for (const [variable, raw] of Object.entries(environment)) {
    const valuePath = `${path}.environment.${variable}`;
    const match =
      typeof raw === 'string' ? raw.match(/^\$\{([A-Za-z][A-Za-z0-9_-]{0,63})\}$/) : null;
    if (!match) {
      findings.push(
        blocking(
          valuePath,
          'Environment literals and ambiguous interpolation must become declared server-side configuration.',
          true,
        ),
      );
      continue;
    }
    const key = match[1];
    manifest.configuration![key] ??= {
      type: looksSecret(variable) ? 'secret' : 'string',
      required: true,
      description: `Imported from Compose environment ${variable}`,
    };
    component.environment[variable] = { from: `configuration.${key}` };
    findings.push(
      translated(valuePath, `Exact interpolation translated to declared configuration ${key}.`),
    );
  }
}

function translateVolumes(
  service: Record<string, unknown>,
  path: string,
  declared: Set<string>,
  component: ComponentManifest,
  findings: ComposeImportFinding[],
) {
  if (service.volumes === undefined) return;
  if (!Array.isArray(service.volumes)) {
    findings.push(blocking(`${path}.volumes`, 'Only short-form volume arrays are supported.'));
    return;
  }
  component.mounts = {};
  service.volumes.forEach((raw, index) => {
    const itemPath = `${path}.volumes[${index}]`;
    if (typeof raw !== 'string') {
      findings.push(blocking(itemPath, 'Long-form volume mounts are not supported yet.'));
      return;
    }
    const [source, target, option, ...extra] = raw.split(':');
    if (!source || !target || extra.length > 0 || !target.startsWith('/')) {
      findings.push(blocking(itemPath, 'Volume mount must be name:/absolute/path[:ro].'));
      return;
    }
    if (source.startsWith('.') || source.startsWith('/') || source.includes('/')) {
      findings.push({
        path: itemPath,
        disposition: 'review-required',
        summary: `Host bind mount ${source} requires explicit path and data-ownership approval.`,
        securitySensitive: true,
      });
      return;
    }
    if (!declared.has(source)) {
      findings.push(blocking(itemPath, `Named volume ${source} is not declared at the top level.`));
      return;
    }
    if (option !== undefined && option !== 'ro') {
      findings.push(blocking(itemPath, `Unsupported volume option ${option}.`));
      return;
    }
    component.mounts![target] = { resource: source, readOnly: option === 'ro' };
    findings.push(translated(itemPath, 'Named volume mount translated.'));
  });
}

function translatePorts(
  service: Record<string, unknown>,
  path: string,
  component: ComponentManifest,
  findings: ComposeImportFinding[],
) {
  if (service.ports === undefined) return;
  if (!Array.isArray(service.ports)) {
    findings.push(blocking(`${path}.ports`, 'Only short-form port arrays are supported.'));
    return;
  }
  component.interfaces ??= {};
  service.ports.forEach((raw, index) => {
    const itemPath = `${path}.ports[${index}]`;
    const match = String(raw).match(/^(?:\d+:)?(\d+)(?:\/(tcp|udp))?$/);
    if (!match) {
      findings.push(blocking(itemPath, 'Port must be [published:]target[/tcp|udp].'));
      return;
    }
    const port = Number(match[1]);
    const protocol = (match[2] ?? 'tcp') as 'tcp' | 'udp';
    component.interfaces![`port-${port}`] = { port, protocol };
    findings.push({
      path: itemPath,
      disposition: 'review-required',
      summary:
        'Container port translated to a private interface, but Compose host publication is not preserved. Declare an HTTP route or an approved TCP/UDP exposure.',
      securitySensitive: true,
    });
  });
}

function translateDependencies(
  service: Record<string, unknown>,
  path: string,
  component: ComponentManifest,
  findings: ComposeImportFinding[],
) {
  if (service.depends_on === undefined) return;
  if (
    Array.isArray(service.depends_on) &&
    service.depends_on.every((value) => typeof value === 'string')
  ) {
    component.dependsOn = service.depends_on as string[];
    findings.push(translated(`${path}.depends_on`, 'Dependency identities translated.'));
    return;
  }
  const dependencies = asRecord(service.depends_on);
  if (!dependencies) {
    findings.push(blocking(`${path}.depends_on`, 'depends_on must be an array or mapping.'));
    return;
  }
  component.dependsOn = Object.keys(dependencies);
  for (const [name, raw] of Object.entries(dependencies)) {
    const options = asRecord(raw);
    if (!options) {
      findings.push(
        blocking(`${path}.depends_on.${name}`, 'Dependency options must be an object.'),
      );
      continue;
    }
    const condition = options.condition;
    if (condition !== undefined && condition !== 'service_started') {
      findings.push({
        path: `${path}.depends_on.${name}.condition`,
        disposition: 'review-required',
        summary: `${String(condition)} needs an explicit deploy.local health or lifecycle gate.`,
        securitySensitive: false,
      });
    } else {
      findings.push(translated(`${path}.depends_on.${name}`, 'Dependency identity translated.'));
    }
    for (const field of Object.keys(options)) {
      if (field !== 'condition') {
        findings.push(
          blocking(
            `${path}.depends_on.${name}.${field}`,
            `Unsupported dependency option ${field}.`,
          ),
        );
      }
    }
  }
}

function translateHealth(
  service: Record<string, unknown>,
  path: string,
  component: ComponentManifest,
  findings: ComposeImportFinding[],
) {
  if (service.healthcheck === undefined) return;
  findings.push({
    path: `${path}.healthcheck`,
    disposition: 'review-required',
    summary:
      'Compose command health checks require an explicit deploy.local interface/path health contract; no check was silently dropped.',
    securitySensitive: false,
  });
  if (component.interfaces && Object.keys(component.interfaces).length === 1) {
    findings.push({
      path: `${path}.healthcheck`,
      disposition: 'review-required',
      summary: `Candidate interface is ${Object.keys(component.interfaces)[0]}, but protocol and path need administrator review.`,
      securitySensitive: false,
    });
  }
}

function translateNetworks(
  service: Record<string, unknown>,
  path: string,
  declared: Map<string, { name: string; driver?: string }>,
  component: ComponentManifest,
  findings: ComposeImportFinding[],
) {
  if (service.networks === undefined) return;
  const serviceNetworkMap = Array.isArray(service.networks)
    ? undefined
    : asRecord(service.networks);
  const names = Array.isArray(service.networks)
    ? service.networks
    : Object.keys(serviceNetworkMap ?? {});
  if (!names.every((value) => typeof value === 'string')) {
    findings.push(blocking(`${path}.networks`, 'Service networks must name top-level networks.'));
    return;
  }
  component.runtime ??= {};
  component.runtime.networks = [];
  for (const name of names as string[]) {
    const network = declared.get(name);
    if (!network) findings.push(blocking(`${path}.networks`, `Network ${name} is not declared.`));
    else component.runtime.networks.push(network);
    if (serviceNetworkMap) {
      const options = serviceNetworkMap[name];
      if (options !== null) {
        const optionRecord = asRecord(options);
        if (!optionRecord) {
          findings.push(
            blocking(
              `${path}.networks.${name}`,
              'Service network options must be an object or null.',
            ),
          );
        } else {
          for (const field of Object.keys(optionRecord)) {
            findings.push(
              blocking(
                `${path}.networks.${name}.${field}`,
                `Unsupported service network option ${field}.`,
              ),
            );
          }
        }
      }
    }
  }
  findings.push(translated(`${path}.networks`, 'Private network membership translated.'));
}

function translateSecurityAndUnsupported(
  service: Record<string, unknown>,
  path: string,
  component: ComponentManifest,
  findings: ComposeImportFinding[],
) {
  const handled = new Set([
    'image',
    'build',
    'command',
    'environment',
    'volumes',
    'ports',
    'depends_on',
    'healthcheck',
    'networks',
  ]);
  for (const [field, value] of Object.entries(service)) {
    if (handled.has(field)) continue;
    const fieldPath = `${path}.${field}`;
    if (field === 'privileged' && value === true) {
      component.runtime ??= {};
      component.runtime.privilegedDocker = true;
      findings.push({
        path: fieldPath,
        disposition: 'review-required',
        summary: 'Privileged mode translated but requires explicit administrator approval.',
        securitySensitive: true,
      });
    } else if (field === 'restart') {
      findings.push(
        ignored(
          fieldPath,
          'deploy.local owns restart/reconciliation policy; Compose value is recorded here.',
        ),
      );
    } else if (field.startsWith('x-')) {
      findings.push(ignored(fieldPath, 'Compose extension metadata is not runtime state.'));
    } else if (
      [
        'network_mode',
        'devices',
        'device_cgroup_rules',
        'cap_add',
        'cap_drop',
        'user',
        'pid',
        'ipc',
      ].includes(field)
    ) {
      findings.push({
        path: fieldPath,
        disposition: 'review-required',
        summary: `${field} changes the host/security boundary and requires an explicit deploy.local grant.`,
        securitySensitive: true,
      });
    } else {
      findings.push(blocking(fieldPath, `Unsupported service field ${field}.`));
    }
  }
}

function looksSecret(variable: string): boolean {
  return /(PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY)$/i.test(variable);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function translated(path: string, summary: string): ComposeImportFinding {
  return { path, disposition: 'translated', summary, securitySensitive: false };
}

function ignored(path: string, summary: string): ComposeImportFinding {
  return { path, disposition: 'ignored', summary, securitySensitive: false };
}

function blocking(path: string, summary: string, securitySensitive = false): ComposeImportFinding {
  return { path, disposition: 'blocking', summary, securitySensitive };
}

function blockedResult(findings: ComposeImportFinding[]): ComposeImportResult {
  return {
    status: 'blocked',
    spec: null,
    plan: null,
    findings,
    sourceOfTruth: 'deploy.yaml',
    note: 'Compose import did not produce a runnable graph.',
  };
}
