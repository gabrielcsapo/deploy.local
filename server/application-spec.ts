import { createHash } from 'node:crypto';
import { isAlias, parseDocument, stringify, visit } from 'yaml';

export const APPLICATION_API_VERSION = 'deploy.local/v1' as const;
export const APPLICATION_KIND = 'Application' as const;

const MAX_MANIFEST_BYTES = 1024 * 1024;
const NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const CONFIGURATION_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROFILE_PATTERN = /^[a-z0-9.-]+\/[a-z0-9.-]+@\d+$/;
const RESERVED_MAPPING_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

type JsonScalar = string | number | boolean | null;
type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };
type StringMap = Record<string, string>;

export type ConfigurationType =
  | 'string'
  | 'secret'
  | 'boolean'
  | 'number'
  | 'integer'
  | 'url'
  | 'enum'
  | 'file';
export type ConfigurationScope = 'application' | 'site';
export type ComponentRole = 'web' | 'worker' | 'service';
export type InterfaceProtocol = 'http' | 'https' | 'tcp' | 'udp' | 'postgres' | 'redis';
export type ExecutionScope = 'perInstance' | 'perSite' | 'writerSite';
export type ReconciliationConflictPolicy = 'collect' | 'prefer-home' | 'prefer-suitcase';
export type RolloutStrategy = 'rolling' | 'recreate' | 'maintenance';
export type SchemaOverlapContract = 'compatible' | 'incompatible';
export type PlacementIntent = 'coLocate' | 'spread';
export type SuitcaseDataMode = 'syncs-across-sites' | 'follows-one-site' | 'site-local';

export interface ApplicationManifest {
  $schema?: string;
  apiVersion: typeof APPLICATION_API_VERSION;
  kind: typeof APPLICATION_KIND;
  metadata?: {
    name?: string;
    description?: string;
    labels?: StringMap;
  };
  configuration?: Record<string, ConfigurationDeclaration>;
  components: Record<string, ComponentManifest>;
  resources?: Record<string, VolumeResourceManifest>;
  routes?: Record<string, RouteManifest>;
  jobs?: Record<string, JobManifest>;
}

export interface ConfigurationDeclaration {
  type: ConfigurationType;
  required?: boolean;
  description?: string;
  default?: JsonScalar;
  allowedValues?: JsonScalar[];
  scope?: ConfigurationScope;
}

export interface ComponentManifest {
  displayName?: string;
  image?: string;
  build?: BuildManifest;
  role?: ComponentRole;
  instances?: number;
  minimumReady?: number;
  rollout?: {
    strategy?: RolloutStrategy;
    maxSurge?: number;
    maxUnavailable?: number;
    schemaOverlap?: SchemaOverlapContract;
  };
  siteOverrides?: {
    allowed?: boolean;
    minimum?: number;
    maximum?: number;
  };
  capacity?: {
    memoryBytes?: number;
    cpuMillicores?: number;
    ephemeralStorageBytes?: number;
    buildMemoryBytes?: number;
  };
  placement?: {
    intent?: PlacementIntent;
    requiredLabels?: StringMap;
  };
  profile?: string;
  command?: string[];
  interfaces?: Record<string, InterfaceManifest>;
  environment?: Record<string, ValueReference>;
  /** Server-side values projected as read-only files at absolute container paths. */
  configurationFiles?: Record<string, ValueReference>;
  mounts?: Record<string, VolumeMountManifest>;
  dependsOn?: string[];
  health?: HealthManifest;
  runtime?: RuntimeManifest;
}

export interface BuildManifest {
  context: string;
  dockerfile?: string;
  target?: string;
  ignore?: string[];
}

export interface InterfaceManifest {
  port: number;
  protocol: InterfaceProtocol;
}

export interface ValueReference {
  from: string;
}

export interface VolumeMountManifest {
  resource: string;
  readOnly?: boolean;
}

export interface HealthManifest {
  interface: string;
  path?: string;
}

export interface RuntimeManifest {
  gpus?: boolean;
  /** Full host privilege. Separate from privilegedDocker, which grants only the Docker socket. */
  privileged?: boolean;
  privilegedDocker?: boolean;
  networkMode?: 'private' | 'host';
  devices?: Array<{
    hostPath: string;
    containerPath?: string;
    permissions?: 'r' | 'rw' | 'rwm';
  }>;
  runArgs?: string[];
  networks?: Array<{
    name: string;
    driver?: string;
    subnet?: string;
    labels?: StringMap;
  }>;
}

export interface VolumeResourceManifest {
  type: 'volume';
  displayName?: string;
  durability?: 'durable' | 'ephemeral' | 'rebuildable';
  dataRole?: 'files' | 'database' | 'cache';
  access?: 'singleWriter' | 'multipleReaders' | 'sharedWriters';
  consistencyGroup?: string;
  ownership?: 'application' | 'external';
  backup?: {
    policy?: 'include' | 'exclude' | 'required';
    retentionCopies?: number;
  };
  suitcase?: {
    allowedDataModes?: SuitcaseDataMode[];
  };
  source?: {
    type: 'bind';
    hostPath: string;
  };
  /** Optional analyzer guidance; it never bypasses structural safety validation. */
  reconciliation?: {
    excludeTables?: string[];
    excludePaths?: string[];
    conflictPolicy?: ReconciliationConflictPolicy;
  };
}

export interface RouteManifest {
  to: string;
  hostname?: string;
  path?: string;
  discoverable?: boolean;
  cache?: {
    enabled?: boolean;
    maxAge?: number;
    paths?: string[];
    maxObjectBytes?: number;
  };
}

export interface JobManifest {
  component: string;
  command: string[];
  environment?: Record<string, ValueReference>;
  execution?: ExecutionScope;
  beforeTraffic?: boolean;
}

/**
 * The canonical, fully-defaulted representation stored with a release.
 * Actual configuration and secret values are deliberately not part of this object.
 */
export interface ApplicationSpec {
  apiVersion: typeof APPLICATION_API_VERSION;
  kind: typeof APPLICATION_KIND;
  metadata: {
    name?: string;
    description?: string;
    labels: StringMap;
  };
  configuration: Record<
    string,
    {
      type: ConfigurationType;
      required: boolean;
      description?: string;
      default?: JsonScalar;
      allowedValues?: JsonScalar[];
      scope: ConfigurationScope;
    }
  >;
  components: Record<
    string,
    {
      displayName?: string;
      image?: string;
      build?: {
        context: string;
        dockerfile?: string;
        target?: string;
        ignore: string[];
      };
      role: ComponentRole;
      instances: number;
      minimumReady: number;
      rollout: {
        strategy: RolloutStrategy;
        maxSurge: number;
        maxUnavailable: number;
        schemaOverlap: SchemaOverlapContract;
      };
      siteOverrides: {
        allowed: boolean;
        minimum: number;
        maximum: number;
      };
      capacity: {
        memoryBytes?: number;
        cpuMillicores?: number;
        ephemeralStorageBytes?: number;
        buildMemoryBytes?: number;
      };
      placement: {
        intent: PlacementIntent;
        requiredLabels: StringMap;
      };
      profile?: string;
      command?: string[];
      interfaces: Record<string, InterfaceManifest>;
      environment: Record<string, ValueReference>;
      configurationFiles?: Record<string, ValueReference>;
      mounts: Record<string, { resource: string; readOnly: boolean }>;
      dependsOn: string[];
      health?: HealthManifest;
      runtime: {
        gpus: boolean;
        privileged: boolean;
        privilegedDocker: boolean;
        networkMode: 'private' | 'host';
        devices: Array<{
          hostPath: string;
          containerPath: string;
          permissions: 'r' | 'rw' | 'rwm';
        }>;
        runArgs: string[];
        networks: Array<{
          name: string;
          driver?: string;
          subnet?: string;
          labels: StringMap;
        }>;
      };
    }
  >;
  resources: Record<
    string,
    {
      type: 'volume';
      displayName?: string;
      durability: 'durable' | 'ephemeral' | 'rebuildable';
      dataRole: 'files' | 'database' | 'cache';
      access: 'singleWriter' | 'multipleReaders' | 'sharedWriters';
      consistencyGroup: string;
      ownership: 'application' | 'external';
      backup: {
        policy: 'include' | 'exclude' | 'required';
        retentionCopies: number;
      };
      suitcase: {
        allowedDataModes: SuitcaseDataMode[];
      };
      source?: { type: 'bind'; hostPath: string };
      reconciliation?: {
        excludeTables: string[];
        excludePaths: string[];
        conflictPolicy: ReconciliationConflictPolicy;
      };
    }
  >;
  routes: Record<
    string,
    {
      to: string;
      hostname?: string;
      path: string;
      discoverable: boolean;
      cache?: {
        enabled: boolean;
        maxAge: number;
        paths: string[];
        maxObjectBytes: number;
      };
    }
  >;
  jobs: Record<
    string,
    {
      component: string;
      command: string[];
      environment: Record<string, ValueReference>;
      execution: ExecutionScope;
      beforeTraffic: boolean;
    }
  >;
}

export interface CompiledApplicationSpec {
  spec: ApplicationSpec;
  canonicalJson: string;
  digest: `sha256:${string}`;
}

/** Revalidate a canonical revision loaded from durable storage. */
export function parseStoredApplicationSpec(normalizedSpec: string): ApplicationSpec {
  return compileApplicationManifest(JSON.parse(normalizedSpec)).spec;
}

export class ApplicationManifestError extends Error {
  readonly issues: readonly string[];

  constructor(issues: string[] | string) {
    const list = Array.isArray(issues) ? issues : [issues];
    super(list.length === 1 ? list[0] : `Invalid deploy.yaml:\n- ${list.join('\n- ')}`);
    this.name = 'ApplicationManifestError';
    this.issues = list;
  }
}

export function parseApplicationManifest(
  source: string,
  sourceName = 'deploy.yaml',
): ApplicationManifest {
  if (Buffer.byteLength(source, 'utf8') > MAX_MANIFEST_BYTES) {
    throw new ApplicationManifestError(`${sourceName} exceeds the 1 MiB manifest limit`);
  }

  const document = parseDocument(source, {
    version: '1.2',
    schema: 'core',
    customTags: [],
    resolveKnownTags: false,
    merge: false,
    strict: true,
    stringKeys: true,
    uniqueKeys: true,
    prettyErrors: true,
  });

  if (document.errors.length > 0 || document.warnings.length > 0) {
    const messages = [...document.errors, ...document.warnings].map(
      (error) => `${sourceName}: ${error.message}`,
    );
    throw new ApplicationManifestError(messages);
  }

  if (document.directives?.yaml.version !== '1.2') {
    throw new ApplicationManifestError(`${sourceName}: only YAML 1.2 documents are supported`);
  }
  if (Object.keys(document.directives?.tags ?? {}).some((tag) => tag !== '!!')) {
    throw new ApplicationManifestError(
      `${sourceName}: custom YAML tag directives are not supported`,
    );
  }

  let forbiddenYamlFeature: string | undefined;
  visit(document, {
    Node(_key, node) {
      if (isAlias(node)) forbiddenYamlFeature = 'aliases are not supported';
      else if (node.anchor) forbiddenYamlFeature = 'anchors are not supported';
      if (forbiddenYamlFeature) return visit.BREAK;
    },
  });
  if (forbiddenYamlFeature) {
    throw new ApplicationManifestError(`${sourceName}: YAML ${forbiddenYamlFeature}`);
  }

  const value = document.toJS({ maxAliasCount: 0 }) as unknown;
  return validateApplicationManifest(value, sourceName);
}

export function compileDeployYaml(source: string, sourceName = 'deploy.yaml') {
  return compileApplicationManifest(parseApplicationManifest(source, sourceName));
}

export function compileApplicationManifest(manifest: ApplicationManifest): CompiledApplicationSpec {
  // Validate programmatically-created manifests through the same path as parsed YAML.
  const input = validateApplicationManifest(manifest, 'application manifest');
  const configuration: ApplicationSpec['configuration'] = {};
  const components: ApplicationSpec['components'] = {};
  const resources: ApplicationSpec['resources'] = {};
  const routes: ApplicationSpec['routes'] = {};
  const jobs: ApplicationSpec['jobs'] = {};

  for (const name of sortedKeys(input.configuration ?? {})) {
    const declaration = input.configuration![name];
    configuration[name] = omitUndefined({
      type: declaration.type,
      required: declaration.required ?? false,
      description: declaration.description,
      default: declaration.default,
      allowedValues: declaration.allowedValues
        ? [...declaration.allowedValues].sort(compareJsonScalars)
        : undefined,
      scope: declaration.scope ?? 'application',
    });
  }

  for (const name of sortedKeys(input.components)) {
    const component = input.components[name];
    const instances = component.instances ?? 1;
    // Preserve the pre-v1 simple-application behavior: an omitted rollout contract
    // is a one-at-a-time, health-gated replacement. Authors that need stop-before-
    // start semantics can opt into recreate or maintenance explicitly.
    const rolloutStrategy = component.rollout?.strategy ?? 'rolling';
    components[name] = omitUndefined({
      displayName: component.displayName,
      image: component.image,
      build: component.build
        ? omitUndefined({
            context: component.build.context,
            dockerfile: component.build.dockerfile,
            target: component.build.target,
            ignore: [...(component.build.ignore ?? [])],
          })
        : undefined,
      role: component.role ?? 'service',
      instances,
      minimumReady: component.minimumReady ?? 1,
      rollout: {
        strategy: rolloutStrategy,
        maxSurge: component.rollout?.maxSurge ?? (rolloutStrategy === 'rolling' ? 1 : 0),
        maxUnavailable:
          component.rollout?.maxUnavailable ?? (rolloutStrategy === 'rolling' ? 0 : instances),
        schemaOverlap:
          component.rollout?.schemaOverlap ??
          (rolloutStrategy === 'rolling' ? 'compatible' : 'incompatible'),
      },
      siteOverrides: {
        allowed: component.siteOverrides?.allowed ?? false,
        minimum: component.siteOverrides?.minimum ?? 1,
        maximum: component.siteOverrides?.maximum ?? 256,
      },
      capacity: omitUndefined({
        memoryBytes: component.capacity?.memoryBytes,
        cpuMillicores: component.capacity?.cpuMillicores,
        ephemeralStorageBytes: component.capacity?.ephemeralStorageBytes,
        buildMemoryBytes: component.capacity?.buildMemoryBytes,
      }),
      placement: {
        intent: component.placement?.intent ?? 'coLocate',
        requiredLabels: sortedStringMap(component.placement?.requiredLabels ?? {}),
      },
      profile: component.profile,
      command: component.command ? [...component.command] : undefined,
      interfaces: sortedRecord(component.interfaces ?? {}, (value) => ({ ...value })),
      environment: sortedRecord(component.environment ?? {}, (value) => ({ ...value })),
      configurationFiles: sortedRecord(component.configurationFiles ?? {}, (value) => ({
        ...value,
      })),
      mounts: sortedRecord(component.mounts ?? {}, (value) => ({
        resource: value.resource,
        readOnly: value.readOnly ?? false,
      })),
      dependsOn: [...(component.dependsOn ?? [])].sort(),
      health: component.health ? { ...component.health } : undefined,
      runtime: {
        gpus: component.runtime?.gpus ?? false,
        privileged: component.runtime?.privileged ?? false,
        privilegedDocker: component.runtime?.privilegedDocker ?? false,
        networkMode: component.runtime?.networkMode ?? 'private',
        devices: (component.runtime?.devices ?? []).map((device) => ({
          hostPath: device.hostPath,
          containerPath: device.containerPath ?? device.hostPath,
          permissions: device.permissions ?? 'rwm',
        })),
        runArgs: [...(component.runtime?.runArgs ?? [])],
        networks: (component.runtime?.networks ?? []).map((network) =>
          omitUndefined({
            name: network.name,
            driver: network.driver,
            subnet: network.subnet,
            labels: sortedStringMap(network.labels ?? {}),
          }),
        ),
      },
    });
  }

  for (const name of sortedKeys(input.resources ?? {})) {
    const resource = input.resources![name];
    const durability = resource.durability ?? 'durable';
    resources[name] = omitUndefined({
      type: 'volume' as const,
      displayName: resource.displayName,
      durability,
      dataRole: resource.dataRole ?? 'files',
      access: resource.access ?? 'singleWriter',
      consistencyGroup: resource.consistencyGroup ?? 'application',
      ownership: resource.ownership ?? 'application',
      backup: {
        policy: resource.backup?.policy ?? (durability === 'durable' ? 'include' : 'exclude'),
        retentionCopies: resource.backup?.retentionCopies ?? 1,
      },
      suitcase: {
        allowedDataModes: [
          ...(resource.suitcase?.allowedDataModes ?? [
            'syncs-across-sites',
            'follows-one-site',
            'site-local',
          ]),
        ].sort(),
      },
      source: resource.source ? { ...resource.source } : undefined,
      reconciliation: resource.reconciliation
        ? {
            excludeTables: [...(resource.reconciliation.excludeTables ?? [])].sort(),
            excludePaths: [...(resource.reconciliation.excludePaths ?? [])].sort(),
            conflictPolicy: resource.reconciliation.conflictPolicy ?? 'collect',
          }
        : undefined,
    });
  }

  for (const name of sortedKeys(input.routes ?? {})) {
    const route = input.routes![name];
    routes[name] = omitUndefined({
      to: route.to,
      hostname: route.hostname,
      path: route.path ?? '/',
      discoverable: route.discoverable ?? false,
      cache: route.cache
        ? {
            enabled: route.cache.enabled ?? true,
            maxAge: route.cache.maxAge ?? 60,
            paths: [...(route.cache.paths ?? [])].sort(),
            maxObjectBytes: route.cache.maxObjectBytes ?? 2 * 1024 * 1024,
          }
        : undefined,
    });
  }

  for (const name of sortedKeys(input.jobs ?? {})) {
    const job = input.jobs![name];
    jobs[name] = {
      component: job.component,
      command: [...job.command],
      environment: sortedRecord(job.environment ?? {}, (value) => ({ ...value })),
      execution: job.execution ?? 'perSite',
      beforeTraffic: job.beforeTraffic ?? false,
    };
  }

  const metadata = input.metadata ?? {};
  const spec: ApplicationSpec = {
    apiVersion: APPLICATION_API_VERSION,
    kind: APPLICATION_KIND,
    metadata: omitUndefined({
      name: metadata.name,
      description: metadata.description,
      labels: sortedStringMap(metadata.labels ?? {}),
    }),
    configuration,
    components,
    resources,
    routes,
    jobs,
  };

  return compiled(spec);
}

export function canonicalApplicationJson(spec: ApplicationSpec): string {
  return JSON.stringify(canonicalize(spec));
}

/** Export a normalized revision without any server-side configuration values. */
export function renderDeployYaml(spec: ApplicationSpec): string {
  return stringify(spec, { lineWidth: 0, sortMapEntries: true });
}

const REPOSITORY_BASE_DIRECTIVE = /^\s*#\s*deploy\.local\/base:\s*(sha256:[a-f0-9]{64})\s*$/m;

/**
 * Read the optimistic-concurrency base carried by a repository deploy.yaml.
 *
 * The value deliberately lives in a YAML comment: ancestry is revision metadata,
 * not application semantics, so it must not participate in the normalized spec
 * digest. An exported manifest can therefore be committed byte-for-byte and still
 * normalize to the exact UI-authored revision it represents.
 */
export function parseRepositoryBaseDigest(source: string): `sha256:${string}` | null {
  const match = source.match(REPOSITORY_BASE_DIRECTIVE);
  return (match?.[1] as `sha256:${string}` | undefined) ?? null;
}

/** Export a repository-ready manifest authored against one exact revision. */
export function renderRepositoryDeployYaml(spec: ApplicationSpec, baseDigest: string): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(baseDigest)) {
    throw new Error('Repository base digest must be a canonical sha256 digest');
  }
  return `# deploy.local/base: ${baseDigest}\n${renderDeployYaml(spec)}`;
}

export function applicationSpecDigest(spec: ApplicationSpec): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalApplicationJson(spec)).digest('hex')}`;
}

function compiled(spec: ApplicationSpec): CompiledApplicationSpec {
  const canonicalJson = canonicalApplicationJson(spec);
  return {
    spec,
    canonicalJson,
    digest: `sha256:${createHash('sha256').update(canonicalJson).digest('hex')}`,
  };
}

function validateApplicationManifest(value: unknown, sourceName: string): ApplicationManifest {
  const issues: string[] = [];
  const root = record(value, sourceName, issues);
  unknownFields(
    root,
    [
      '$schema',
      'apiVersion',
      'kind',
      'metadata',
      'configuration',
      'components',
      'resources',
      'routes',
      'jobs',
    ],
    sourceName,
    issues,
  );

  if (root.apiVersion !== APPLICATION_API_VERSION) {
    issues.push(`${sourceName}.apiVersion must be "${APPLICATION_API_VERSION}"`);
  }
  if (root.kind !== APPLICATION_KIND) {
    issues.push(`${sourceName}.kind must be "${APPLICATION_KIND}"`);
  }
  if (root.$schema !== undefined) string(root.$schema, `${sourceName}.$schema`, issues);

  const metadata = validateMetadata(root.metadata, `${sourceName}.metadata`, issues);
  const configuration = validateConfigurationMap(
    root.configuration,
    `${sourceName}.configuration`,
    issues,
  );
  const components = validateComponentMap(root.components, `${sourceName}.components`, issues);
  const resources = validateResourceMap(root.resources, `${sourceName}.resources`, issues);
  const routes = validateRouteMap(root.routes, `${sourceName}.routes`, issues);
  const jobs = validateJobMap(root.jobs, `${sourceName}.jobs`, issues);

  validateGraphReferences(
    { configuration, components, resources, routes, jobs },
    sourceName,
    issues,
  );
  if (issues.length > 0) throw new ApplicationManifestError(issues);

  return omitUndefined({
    $schema: root.$schema as string | undefined,
    apiVersion: APPLICATION_API_VERSION,
    kind: APPLICATION_KIND,
    metadata,
    configuration,
    components,
    resources,
    routes,
    jobs,
  });
}

function validateMetadata(value: unknown, path: string, issues: string[]) {
  if (value === undefined) return undefined;
  const input = record(value, path, issues);
  unknownFields(input, ['name', 'description', 'labels'], path, issues);
  if (input.name !== undefined) validateName(input.name, `${path}.name`, issues);
  if (input.description !== undefined)
    nonEmptyString(input.description, `${path}.description`, issues);
  const labels =
    input.labels === undefined ? undefined : stringMap(input.labels, `${path}.labels`, issues);
  return omitUndefined({
    name: input.name as string | undefined,
    description: input.description as string | undefined,
    labels,
  });
}

function validateConfigurationMap(value: unknown, path: string, issues: string[]) {
  if (value === undefined) return undefined;
  const input = record(value, path, issues);
  const output: NonNullable<ApplicationManifest['configuration']> = {};
  for (const [key, raw] of Object.entries(input)) {
    if (!CONFIGURATION_NAME_PATTERN.test(key)) {
      issues.push(`${path} has invalid configuration name "${key}"`);
    }
    if (RESERVED_MAPPING_KEYS.has(key)) {
      issues.push(`${path} uses reserved configuration name "${key}"`);
    }
    const itemPath = `${path}.${key}`;
    const declaration = record(raw, itemPath, issues);
    unknownFields(
      declaration,
      ['type', 'required', 'description', 'default', 'allowedValues', 'scope'],
      itemPath,
      issues,
    );
    enumeration(
      declaration.type,
      ['string', 'secret', 'boolean', 'number', 'integer', 'url', 'enum', 'file'],
      `${itemPath}.type`,
      issues,
    );
    if (declaration.required !== undefined)
      boolean(declaration.required, `${itemPath}.required`, issues);
    if (declaration.description !== undefined)
      nonEmptyString(declaration.description, `${itemPath}.description`, issues);
    if (declaration.scope !== undefined)
      enumeration(declaration.scope, ['application', 'site'], `${itemPath}.scope`, issues);

    const type = declaration.type as ConfigurationType;
    if (declaration.default !== undefined) {
      if (type === 'secret')
        issues.push(`${itemPath}.default is not allowed for secret configuration`);
      else validateConfigurationValue(declaration.default, type, `${itemPath}.default`, issues);
    }
    let allowedValues: JsonScalar[] | undefined;
    if (declaration.allowedValues !== undefined) {
      if (type === 'secret') {
        issues.push(`${itemPath}.allowedValues is not allowed for secret configuration`);
      } else if (
        !Array.isArray(declaration.allowedValues) ||
        declaration.allowedValues.length === 0
      ) {
        issues.push(`${itemPath}.allowedValues must be a non-empty array`);
      } else {
        allowedValues = declaration.allowedValues as JsonScalar[];
        allowedValues.forEach((item, index) =>
          validateConfigurationValue(item, type, `${itemPath}.allowedValues[${index}]`, issues),
        );
        if (
          new Set(allowedValues.map((item) => JSON.stringify(item))).size !== allowedValues.length
        ) {
          issues.push(`${itemPath}.allowedValues must not contain duplicates`);
        }
        if (
          declaration.default !== undefined &&
          !allowedValues.some((item) => Object.is(item, declaration.default))
        ) {
          issues.push(`${itemPath}.default must be included in allowedValues`);
        }
      }
    }
    if (type === 'enum' && !allowedValues) {
      issues.push(`${itemPath}.allowedValues is required for enum configuration`);
    }
    output[key] = omitUndefined({
      type,
      required: declaration.required as boolean | undefined,
      description: declaration.description as string | undefined,
      default: declaration.default as JsonScalar | undefined,
      allowedValues,
      scope: declaration.scope as ConfigurationScope | undefined,
    });
  }
  return output;
}

function validateComponentMap(value: unknown, path: string, issues: string[]) {
  const input = record(value, path, issues);
  if (Object.keys(input).length === 0) issues.push(`${path} must define at least one component`);
  const output: ApplicationManifest['components'] = {};
  for (const [key, raw] of Object.entries(input)) {
    validateName(key, `${path} key`, issues);
    if (key === 'configuration')
      issues.push(`${path} uses reserved component name "configuration"`);
    const itemPath = `${path}.${key}`;
    const component = record(raw, itemPath, issues);
    unknownFields(
      component,
      [
        'displayName',
        'image',
        'build',
        'role',
        'instances',
        'minimumReady',
        'rollout',
        'siteOverrides',
        'capacity',
        'placement',
        'profile',
        'command',
        'interfaces',
        'environment',
        'configurationFiles',
        'mounts',
        'dependsOn',
        'health',
        'runtime',
      ],
      itemPath,
      issues,
    );
    if (component.displayName !== undefined)
      nonEmptyString(component.displayName, `${itemPath}.displayName`, issues);
    if ((component.image === undefined) === (component.build === undefined)) {
      issues.push(`${itemPath} must define exactly one of image or build`);
    }
    if (component.image !== undefined) nonEmptyString(component.image, `${itemPath}.image`, issues);
    const build = validateBuild(component.build, `${itemPath}.build`, issues);
    if (component.role !== undefined)
      enumeration(component.role, ['web', 'worker', 'service'], `${itemPath}.role`, issues);
    if (component.instances !== undefined)
      integer(component.instances, `${itemPath}.instances`, issues, 1, 256);
    const desiredInstances =
      typeof component.instances === 'number' && Number.isInteger(component.instances)
        ? component.instances
        : 1;
    if (component.minimumReady !== undefined) {
      integer(component.minimumReady, `${itemPath}.minimumReady`, issues, 0, desiredInstances);
    }
    const rollout = validateRollout(
      component.rollout,
      `${itemPath}.rollout`,
      desiredInstances,
      issues,
    );
    const siteOverrides = validateSiteOverrides(
      component.siteOverrides,
      `${itemPath}.siteOverrides`,
      desiredInstances,
      issues,
    );
    const capacity = validateCapacity(component.capacity, `${itemPath}.capacity`, issues);
    const placement = validatePlacement(component.placement, `${itemPath}.placement`, issues);
    if (component.profile !== undefined) {
      nonEmptyString(component.profile, `${itemPath}.profile`, issues);
      if (typeof component.profile === 'string' && !PROFILE_PATTERN.test(component.profile)) {
        issues.push(`${itemPath}.profile must use the form "provider/profile@version"`);
      }
    }
    const command =
      component.command === undefined
        ? undefined
        : stringArray(component.command, `${itemPath}.command`, issues, false);
    const interfaces = validateInterfaceMap(component.interfaces, `${itemPath}.interfaces`, issues);
    const environment = validateReferenceMap(
      component.environment,
      `${itemPath}.environment`,
      issues,
    );
    const configurationFiles = validateConfigurationFileMap(
      component.configurationFiles,
      `${itemPath}.configurationFiles`,
      issues,
    );
    const mounts = validateMountMap(component.mounts, `${itemPath}.mounts`, issues);
    if (configurationFiles && mounts) {
      for (const filePath of Object.keys(configurationFiles)) {
        for (const mountPath of Object.keys(mounts)) {
          if (
            filePath === mountPath ||
            filePath.startsWith(`${mountPath.replace(/\/$/, '')}/`) ||
            mountPath.startsWith(`${filePath.replace(/\/$/, '')}/`)
          ) {
            issues.push(
              `${itemPath} configuration file ${JSON.stringify(filePath)} overlaps volume mount ${JSON.stringify(mountPath)}`,
            );
          }
        }
      }
    }
    const dependsOn =
      component.dependsOn === undefined
        ? undefined
        : stringArray(component.dependsOn, `${itemPath}.dependsOn`, issues, true);
    if (dependsOn && new Set(dependsOn).size !== dependsOn.length) {
      issues.push(`${itemPath}.dependsOn must not contain duplicates`);
    }
    const health = validateHealth(component.health, `${itemPath}.health`, issues);
    const runtime = validateRuntime(component.runtime, `${itemPath}.runtime`, issues);
    output[key] = omitUndefined({
      displayName: component.displayName as string | undefined,
      image: component.image as string | undefined,
      build,
      role: component.role as ComponentRole | undefined,
      instances: component.instances as number | undefined,
      minimumReady: component.minimumReady as number | undefined,
      rollout,
      siteOverrides,
      capacity,
      placement,
      profile: component.profile as string | undefined,
      command,
      interfaces,
      environment,
      configurationFiles,
      mounts,
      dependsOn,
      health,
      runtime,
    });
  }
  return output;
}

function validateRollout(
  value: unknown,
  path: string,
  instances: number,
  issues: string[],
): ComponentManifest['rollout'] {
  if (value === undefined) return undefined;
  const input = record(value, path, issues);
  unknownFields(input, ['strategy', 'maxSurge', 'maxUnavailable', 'schemaOverlap'], path, issues);
  if (input.strategy !== undefined)
    enumeration(input.strategy, ['rolling', 'recreate', 'maintenance'], `${path}.strategy`, issues);
  if (input.maxSurge !== undefined) integer(input.maxSurge, `${path}.maxSurge`, issues, 0, 256);
  if (input.maxUnavailable !== undefined)
    integer(input.maxUnavailable, `${path}.maxUnavailable`, issues, 0, instances);
  if (input.schemaOverlap !== undefined) {
    enumeration(
      input.schemaOverlap,
      ['compatible', 'incompatible'],
      `${path}.schemaOverlap`,
      issues,
    );
  }
  const strategy = input.strategy as RolloutStrategy | undefined;
  const schemaOverlap = input.schemaOverlap as SchemaOverlapContract | undefined;
  if (strategy === 'rolling' && schemaOverlap !== 'compatible') {
    issues.push(
      `${path}.schemaOverlap must be "compatible" for rolling releases because old and new revisions overlap`,
    );
  }
  if (strategy === 'rolling' && input.maxSurge === 0 && input.maxUnavailable === 0) {
    issues.push(`${path} rolling release must allow maxSurge or maxUnavailable`);
  }
  return omitUndefined({
    strategy,
    maxSurge: input.maxSurge as number | undefined,
    maxUnavailable: input.maxUnavailable as number | undefined,
    schemaOverlap,
  });
}

function validateSiteOverrides(
  value: unknown,
  path: string,
  instances: number,
  issues: string[],
): ComponentManifest['siteOverrides'] {
  if (value === undefined) return undefined;
  const input = record(value, path, issues);
  unknownFields(input, ['allowed', 'minimum', 'maximum'], path, issues);
  if (input.allowed !== undefined) boolean(input.allowed, `${path}.allowed`, issues);
  if (input.minimum !== undefined) integer(input.minimum, `${path}.minimum`, issues, 1, 256);
  if (input.maximum !== undefined) integer(input.maximum, `${path}.maximum`, issues, 1, 256);
  const minimum = typeof input.minimum === 'number' ? input.minimum : 1;
  const maximum = typeof input.maximum === 'number' ? input.maximum : 256;
  if (minimum > maximum) issues.push(`${path}.minimum must not exceed maximum`);
  if (instances < minimum || instances > maximum) {
    issues.push(`${path} bounds must include the default instances count ${instances}`);
  }
  return omitUndefined({
    allowed: input.allowed as boolean | undefined,
    minimum: input.minimum as number | undefined,
    maximum: input.maximum as number | undefined,
  });
}

function validateCapacity(
  value: unknown,
  path: string,
  issues: string[],
): ComponentManifest['capacity'] {
  if (value === undefined) return undefined;
  const input = record(value, path, issues);
  unknownFields(
    input,
    ['memoryBytes', 'cpuMillicores', 'ephemeralStorageBytes', 'buildMemoryBytes'],
    path,
    issues,
  );
  for (const field of ['memoryBytes', 'ephemeralStorageBytes', 'buildMemoryBytes'] as const) {
    if (input[field] !== undefined)
      integer(input[field], `${path}.${field}`, issues, 1, Number.MAX_SAFE_INTEGER);
  }
  if (input.cpuMillicores !== undefined)
    integer(input.cpuMillicores, `${path}.cpuMillicores`, issues, 1, 1_000_000);
  return omitUndefined({
    memoryBytes: input.memoryBytes as number | undefined,
    cpuMillicores: input.cpuMillicores as number | undefined,
    ephemeralStorageBytes: input.ephemeralStorageBytes as number | undefined,
    buildMemoryBytes: input.buildMemoryBytes as number | undefined,
  });
}

function validatePlacement(
  value: unknown,
  path: string,
  issues: string[],
): ComponentManifest['placement'] {
  if (value === undefined) return undefined;
  const input = record(value, path, issues);
  unknownFields(input, ['intent', 'requiredLabels'], path, issues);
  if (input.intent !== undefined)
    enumeration(input.intent, ['coLocate', 'spread'], `${path}.intent`, issues);
  const requiredLabels =
    input.requiredLabels === undefined
      ? undefined
      : stringMap(input.requiredLabels, `${path}.requiredLabels`, issues);
  return omitUndefined({
    intent: input.intent as PlacementIntent | undefined,
    requiredLabels,
  });
}

function validateBuild(value: unknown, path: string, issues: string[]) {
  if (value === undefined) return undefined;
  const input = record(value, path, issues);
  unknownFields(input, ['context', 'dockerfile', 'target', 'ignore'], path, issues);
  nonEmptyString(input.context, `${path}.context`, issues);
  if (input.dockerfile !== undefined)
    nonEmptyString(input.dockerfile, `${path}.dockerfile`, issues);
  if (input.target !== undefined) nonEmptyString(input.target, `${path}.target`, issues);
  const ignore =
    input.ignore === undefined
      ? undefined
      : stringArray(input.ignore, `${path}.ignore`, issues, true);
  return omitUndefined({
    context: input.context as string,
    dockerfile: input.dockerfile as string | undefined,
    target: input.target as string | undefined,
    ignore,
  });
}

function validateInterfaceMap(value: unknown, path: string, issues: string[]) {
  if (value === undefined) return undefined;
  const input = record(value, path, issues);
  const output: NonNullable<ComponentManifest['interfaces']> = {};
  for (const [key, raw] of Object.entries(input)) {
    validateName(key, `${path} key`, issues);
    const itemPath = `${path}.${key}`;
    const item = record(raw, itemPath, issues);
    unknownFields(item, ['port', 'protocol'], itemPath, issues);
    integer(item.port, `${itemPath}.port`, issues, 1, 65535);
    enumeration(
      item.protocol,
      ['http', 'https', 'tcp', 'udp', 'postgres', 'redis'],
      `${itemPath}.protocol`,
      issues,
    );
    output[key] = { port: item.port as number, protocol: item.protocol as InterfaceProtocol };
  }
  return output;
}

function validateReferenceMap(value: unknown, path: string, issues: string[]) {
  if (value === undefined) return undefined;
  const input = record(value, path, issues);
  const output: Record<string, ValueReference> = {};
  for (const [key, raw] of Object.entries(input)) {
    if (!ENVIRONMENT_NAME_PATTERN.test(key) || RESERVED_MAPPING_KEYS.has(key))
      issues.push(`${path} has invalid variable name "${key}"`);
    const itemPath = `${path}.${key}`;
    const item = record(raw, itemPath, issues);
    unknownFields(item, ['from'], itemPath, issues);
    nonEmptyString(item.from, `${itemPath}.from`, issues);
    output[key] = { from: item.from as string };
  }
  return output;
}

function validateConfigurationFileMap(value: unknown, path: string, issues: string[]) {
  if (value === undefined) return undefined;
  const input = record(value, path, issues);
  const output: Record<string, ValueReference> = {};
  for (const [target, raw] of Object.entries(input)) {
    absolutePath(target, `${path} key`, issues);
    if (target === '/' || target.endsWith('/')) {
      issues.push(`${path} target ${JSON.stringify(target)} must name a file`);
    }
    const itemPath = `${path}[${JSON.stringify(target)}]`;
    const item = record(raw, itemPath, issues);
    unknownFields(item, ['from'], itemPath, issues);
    nonEmptyString(item.from, `${itemPath}.from`, issues);
    if (typeof item.from === 'string' && !item.from.startsWith('configuration.')) {
      issues.push(`${itemPath}.from must reference declared configuration`);
    }
    output[target] = { from: item.from as string };
  }
  return output;
}

function validateMountMap(value: unknown, path: string, issues: string[]) {
  if (value === undefined) return undefined;
  const input = record(value, path, issues);
  const output: Record<string, VolumeMountManifest> = {};
  for (const [key, raw] of Object.entries(input)) {
    if (!key.startsWith('/')) issues.push(`${path} mount path "${key}" must be absolute`);
    const itemPath = `${path}[${JSON.stringify(key)}]`;
    const item = record(raw, itemPath, issues);
    unknownFields(item, ['resource', 'readOnly'], itemPath, issues);
    validateName(item.resource, `${itemPath}.resource`, issues);
    if (item.readOnly !== undefined) boolean(item.readOnly, `${itemPath}.readOnly`, issues);
    output[key] = omitUndefined({
      resource: item.resource as string,
      readOnly: item.readOnly as boolean | undefined,
    });
  }
  return output;
}

function validateHealth(value: unknown, path: string, issues: string[]) {
  if (value === undefined) return undefined;
  const input = record(value, path, issues);
  unknownFields(input, ['interface', 'path'], path, issues);
  validateName(input.interface, `${path}.interface`, issues);
  if (input.path !== undefined) absolutePath(input.path, `${path}.path`, issues);
  return omitUndefined({
    interface: input.interface as string,
    path: input.path as string | undefined,
  });
}

function validateRuntime(value: unknown, path: string, issues: string[]) {
  if (value === undefined) return undefined;
  const input = record(value, path, issues);
  unknownFields(
    input,
    ['gpus', 'privileged', 'privilegedDocker', 'networkMode', 'devices', 'runArgs', 'networks'],
    path,
    issues,
  );
  if (input.gpus !== undefined) boolean(input.gpus, `${path}.gpus`, issues);
  if (input.privileged !== undefined) boolean(input.privileged, `${path}.privileged`, issues);
  if (input.privilegedDocker !== undefined)
    boolean(input.privilegedDocker, `${path}.privilegedDocker`, issues);
  if (input.networkMode !== undefined)
    enumeration(input.networkMode, ['private', 'host'], `${path}.networkMode`, issues);
  let devices: RuntimeManifest['devices'];
  if (input.devices !== undefined) {
    if (!Array.isArray(input.devices)) issues.push(`${path}.devices must be an array`);
    else {
      devices = input.devices.map((raw, index) => {
        const itemPath = `${path}.devices[${index}]`;
        const item = record(raw, itemPath, issues);
        unknownFields(item, ['hostPath', 'containerPath', 'permissions'], itemPath, issues);
        absolutePath(item.hostPath, `${itemPath}.hostPath`, issues);
        if (item.containerPath !== undefined) {
          absolutePath(item.containerPath, `${itemPath}.containerPath`, issues);
        }
        if (item.permissions !== undefined) {
          enumeration(item.permissions, ['r', 'rw', 'rwm'], `${itemPath}.permissions`, issues);
        }
        return omitUndefined({
          hostPath: item.hostPath as string,
          containerPath: item.containerPath as string | undefined,
          permissions: item.permissions as 'r' | 'rw' | 'rwm' | undefined,
        });
      });
    }
  }
  const runArgs =
    input.runArgs === undefined
      ? undefined
      : stringArray(input.runArgs, `${path}.runArgs`, issues, true);
  validateRuntimeRunArgs(runArgs ?? [], `${path}.runArgs`, issues);
  let networks: RuntimeManifest['networks'];
  if (input.networks !== undefined) {
    if (!Array.isArray(input.networks)) issues.push(`${path}.networks must be an array`);
    else {
      networks = input.networks.map((raw, index) => {
        const itemPath = `${path}.networks[${index}]`;
        const item = record(raw, itemPath, issues);
        unknownFields(item, ['name', 'driver', 'subnet', 'labels'], itemPath, issues);
        nonEmptyString(item.name, `${itemPath}.name`, issues);
        if (item.driver !== undefined) nonEmptyString(item.driver, `${itemPath}.driver`, issues);
        if (item.subnet !== undefined) nonEmptyString(item.subnet, `${itemPath}.subnet`, issues);
        const labels =
          item.labels === undefined
            ? undefined
            : stringMap(item.labels, `${itemPath}.labels`, issues);
        return omitUndefined({
          name: item.name as string,
          driver: item.driver as string | undefined,
          subnet: item.subnet as string | undefined,
          labels,
        });
      });
    }
  }
  return omitUndefined({
    gpus: input.gpus as boolean | undefined,
    privileged: input.privileged as boolean | undefined,
    privilegedDocker: input.privilegedDocker as boolean | undefined,
    networkMode: input.networkMode as 'private' | 'host' | undefined,
    devices,
    runArgs,
    networks,
  });
}

const SAFE_RUNTIME_RUN_ARGS = new Map<string, 0 | 1>([
  ['--dns', 1],
  ['--dns-search', 1],
  ['--dns-option', 1],
  ['--label', 1],
  ['-l', 1],
  ['--read-only', 0],
  ['--init', 0],
  ['--stop-signal', 1],
  ['--stop-timeout', 1],
]);

function validateRuntimeRunArgs(args: readonly string[], path: string, issues: string[]): void {
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    const separator = argument.indexOf('=');
    const flag = separator === -1 ? argument : argument.slice(0, separator);
    const arity = SAFE_RUNTIME_RUN_ARGS.get(flag);
    if (arity === undefined) {
      issues.push(
        `${path} cannot use Docker argument ${JSON.stringify(flag)}; use typed runtime fields for ports, mounts, networks, environment, devices, privilege, GPU, and resource limits`,
      );
      continue;
    }
    if (arity === 0) {
      if (separator !== -1) issues.push(`${path} argument ${JSON.stringify(flag)} takes no value`);
      continue;
    }
    const value = separator === -1 ? args[index + 1] : argument.slice(separator + 1);
    if (!value || (separator === -1 && value.startsWith('-'))) {
      issues.push(`${path} argument ${JSON.stringify(flag)} requires a value`);
      continue;
    }
    if (separator === -1) index++;
    if (
      (flag === '--label' || flag === '-l') &&
      value.split('=', 1)[0].toLowerCase().startsWith('deploy-sh.')
    ) {
      issues.push(
        `${path} cannot override reserved Docker label ${JSON.stringify(value.split('=', 1)[0])}`,
      );
    }
  }
}

function validateResourceMap(value: unknown, path: string, issues: string[]) {
  if (value === undefined) return undefined;
  const input = record(value, path, issues);
  const output: NonNullable<ApplicationManifest['resources']> = {};
  for (const [key, raw] of Object.entries(input)) {
    validateName(key, `${path} key`, issues);
    const itemPath = `${path}.${key}`;
    const item = record(raw, itemPath, issues);
    unknownFields(
      item,
      [
        'type',
        'displayName',
        'durability',
        'dataRole',
        'access',
        'consistencyGroup',
        'ownership',
        'backup',
        'suitcase',
        'source',
        'reconciliation',
      ],
      itemPath,
      issues,
    );
    enumeration(item.type, ['volume'], `${itemPath}.type`, issues);
    if (item.displayName !== undefined)
      nonEmptyString(item.displayName, `${itemPath}.displayName`, issues);
    if (item.durability !== undefined)
      enumeration(
        item.durability,
        ['durable', 'ephemeral', 'rebuildable'],
        `${itemPath}.durability`,
        issues,
      );
    if (item.dataRole !== undefined)
      enumeration(item.dataRole, ['files', 'database', 'cache'], `${itemPath}.dataRole`, issues);
    if (item.access !== undefined)
      enumeration(
        item.access,
        ['singleWriter', 'multipleReaders', 'sharedWriters'],
        `${itemPath}.access`,
        issues,
      );
    if (item.consistencyGroup !== undefined)
      validateName(item.consistencyGroup, `${itemPath}.consistencyGroup`, issues);
    if (item.ownership !== undefined)
      enumeration(item.ownership, ['application', 'external'], `${itemPath}.ownership`, issues);
    let backup: VolumeResourceManifest['backup'];
    if (item.backup !== undefined) {
      const contract = record(item.backup, `${itemPath}.backup`, issues);
      unknownFields(contract, ['policy', 'retentionCopies'], `${itemPath}.backup`, issues);
      if (contract.policy !== undefined)
        enumeration(
          contract.policy,
          ['include', 'exclude', 'required'],
          `${itemPath}.backup.policy`,
          issues,
        );
      if (contract.retentionCopies !== undefined)
        integer(contract.retentionCopies, `${itemPath}.backup.retentionCopies`, issues, 0, 1024);
      if (contract.policy === 'required' && contract.retentionCopies === 0) {
        issues.push(`${itemPath}.backup.retentionCopies must be positive when backup is required`);
      }
      backup = omitUndefined({
        policy: contract.policy as 'include' | 'exclude' | 'required' | undefined,
        retentionCopies: contract.retentionCopies as number | undefined,
      });
    }
    let suitcase: VolumeResourceManifest['suitcase'];
    if (item.suitcase !== undefined) {
      const contract = record(item.suitcase, `${itemPath}.suitcase`, issues);
      unknownFields(contract, ['allowedDataModes'], `${itemPath}.suitcase`, issues);
      let allowedDataModes: SuitcaseDataMode[] | undefined;
      if (contract.allowedDataModes !== undefined) {
        if (!Array.isArray(contract.allowedDataModes) || contract.allowedDataModes.length === 0) {
          issues.push(`${itemPath}.suitcase.allowedDataModes must be a non-empty array`);
        } else {
          allowedDataModes = contract.allowedDataModes as SuitcaseDataMode[];
          allowedDataModes.forEach((mode, index) =>
            enumeration(
              mode,
              ['syncs-across-sites', 'follows-one-site', 'site-local'],
              `${itemPath}.suitcase.allowedDataModes[${index}]`,
              issues,
            ),
          );
          if (new Set(allowedDataModes).size !== allowedDataModes.length) {
            issues.push(`${itemPath}.suitcase.allowedDataModes must not contain duplicates`);
          }
        }
      }
      suitcase = omitUndefined({ allowedDataModes });
    }
    let source: VolumeResourceManifest['source'];
    if (item.source !== undefined) {
      const sourceInput = record(item.source, `${itemPath}.source`, issues);
      unknownFields(sourceInput, ['type', 'hostPath'], `${itemPath}.source`, issues);
      enumeration(sourceInput.type, ['bind'], `${itemPath}.source.type`, issues);
      absolutePath(sourceInput.hostPath, `${itemPath}.source.hostPath`, issues);
      source = { type: 'bind', hostPath: sourceInput.hostPath as string };
    }
    if (item.ownership === 'external' && !source) {
      issues.push(`${itemPath}.ownership "external" requires an explicit bind source`);
    }
    if (item.ownership === 'external' && backup?.policy === 'required') {
      issues.push(`${itemPath}.backup cannot be required for externally owned data`);
    }
    let reconciliation: VolumeResourceManifest['reconciliation'];
    if (item.reconciliation !== undefined) {
      const guidance = record(item.reconciliation, `${itemPath}.reconciliation`, issues);
      unknownFields(
        guidance,
        ['excludeTables', 'excludePaths', 'conflictPolicy'],
        `${itemPath}.reconciliation`,
        issues,
      );
      const excludeTables =
        guidance.excludeTables === undefined
          ? undefined
          : stringArray(
              guidance.excludeTables,
              `${itemPath}.reconciliation.excludeTables`,
              issues,
              true,
            );
      const excludePaths =
        guidance.excludePaths === undefined
          ? undefined
          : stringArray(
              guidance.excludePaths,
              `${itemPath}.reconciliation.excludePaths`,
              issues,
              true,
            );
      for (const [index, path] of (excludePaths ?? []).entries()) {
        if (path.startsWith('/') || path.split('/').includes('..')) {
          issues.push(
            `${itemPath}.reconciliation.excludePaths[${index}] must be a relative path without ".."`,
          );
        }
      }
      if (guidance.conflictPolicy !== undefined) {
        enumeration(
          guidance.conflictPolicy,
          ['collect', 'prefer-home', 'prefer-suitcase'],
          `${itemPath}.reconciliation.conflictPolicy`,
          issues,
        );
      }
      reconciliation = omitUndefined({
        excludeTables,
        excludePaths,
        conflictPolicy: guidance.conflictPolicy as ReconciliationConflictPolicy | undefined,
      });
    }
    output[key] = omitUndefined({
      type: 'volume' as const,
      displayName: item.displayName as string | undefined,
      durability: item.durability as VolumeResourceManifest['durability'],
      dataRole: item.dataRole as VolumeResourceManifest['dataRole'],
      access: item.access as VolumeResourceManifest['access'],
      consistencyGroup: item.consistencyGroup as string | undefined,
      ownership: item.ownership as VolumeResourceManifest['ownership'],
      backup,
      suitcase,
      source,
      reconciliation,
    });
  }
  return output;
}

function validateRouteMap(value: unknown, path: string, issues: string[]) {
  if (value === undefined) return undefined;
  const input = record(value, path, issues);
  const output: NonNullable<ApplicationManifest['routes']> = {};
  for (const [key, raw] of Object.entries(input)) {
    validateName(key, `${path} key`, issues);
    const itemPath = `${path}.${key}`;
    const item = record(raw, itemPath, issues);
    unknownFields(item, ['to', 'hostname', 'path', 'discoverable', 'cache'], itemPath, issues);
    nonEmptyString(item.to, `${itemPath}.to`, issues);
    if (item.hostname !== undefined) nonEmptyString(item.hostname, `${itemPath}.hostname`, issues);
    if (item.path !== undefined) absolutePath(item.path, `${itemPath}.path`, issues);
    if (item.discoverable !== undefined)
      boolean(item.discoverable, `${itemPath}.discoverable`, issues);
    const cache = validateCache(item.cache, `${itemPath}.cache`, issues);
    output[key] = omitUndefined({
      to: item.to as string,
      hostname: item.hostname as string | undefined,
      path: item.path as string | undefined,
      discoverable: item.discoverable as boolean | undefined,
      cache,
    });
  }
  return output;
}

function validateCache(value: unknown, path: string, issues: string[]) {
  if (value === undefined) return undefined;
  const input = record(value, path, issues);
  unknownFields(input, ['enabled', 'maxAge', 'paths', 'maxObjectBytes'], path, issues);
  if (input.enabled !== undefined) boolean(input.enabled, `${path}.enabled`, issues);
  if (input.maxAge !== undefined) integer(input.maxAge, `${path}.maxAge`, issues, 1, 86400);
  const paths =
    input.paths === undefined ? undefined : stringArray(input.paths, `${path}.paths`, issues, true);
  paths?.forEach((item, index) => absolutePath(item, `${path}.paths[${index}]`, issues));
  if (input.maxObjectBytes !== undefined)
    integer(input.maxObjectBytes, `${path}.maxObjectBytes`, issues, 1024, 16 * 1024 * 1024);
  return omitUndefined({
    enabled: input.enabled as boolean | undefined,
    maxAge: input.maxAge as number | undefined,
    paths,
    maxObjectBytes: input.maxObjectBytes as number | undefined,
  });
}

function validateJobMap(value: unknown, path: string, issues: string[]) {
  if (value === undefined) return undefined;
  const input = record(value, path, issues);
  const output: NonNullable<ApplicationManifest['jobs']> = {};
  for (const [key, raw] of Object.entries(input)) {
    validateName(key, `${path} key`, issues);
    const itemPath = `${path}.${key}`;
    const item = record(raw, itemPath, issues);
    unknownFields(
      item,
      ['component', 'command', 'environment', 'execution', 'beforeTraffic'],
      itemPath,
      issues,
    );
    validateName(item.component, `${itemPath}.component`, issues);
    const command = stringArray(item.command, `${itemPath}.command`, issues, false);
    const environment = validateReferenceMap(item.environment, `${itemPath}.environment`, issues);
    if (item.execution !== undefined)
      enumeration(
        item.execution,
        ['perInstance', 'perSite', 'writerSite'],
        `${itemPath}.execution`,
        issues,
      );
    if (item.beforeTraffic !== undefined)
      boolean(item.beforeTraffic, `${itemPath}.beforeTraffic`, issues);
    output[key] = omitUndefined({
      component: item.component as string,
      command,
      environment,
      execution: item.execution as ExecutionScope | undefined,
      beforeTraffic: item.beforeTraffic as boolean | undefined,
    });
  }
  return output;
}

function validateGraphReferences(
  graph: Pick<
    ApplicationManifest,
    'configuration' | 'components' | 'resources' | 'routes' | 'jobs'
  >,
  sourceName: string,
  issues: string[],
) {
  const components = graph.components;
  const configuration = graph.configuration ?? {};
  const resources = graph.resources ?? {};

  const validateValueReference = (reference: ValueReference, path: string) => {
    if (typeof reference.from !== 'string') return;
    const parts = reference.from.split('.');
    if (parts.length !== 2) {
      issues.push(`${path}.from must reference "configuration.name" or "component.interface"`);
      return;
    }
    const [owner, member] = parts;
    if (owner === 'configuration') {
      if (!hasOwn(configuration, member))
        issues.push(`${path}.from references unknown configuration "${member}"`);
    } else if (!hasOwn(components, owner)) {
      issues.push(`${path}.from references unknown component "${owner}"`);
    } else if (!hasOwn(components[owner].interfaces ?? {}, member)) {
      issues.push(`${path}.from references unknown interface "${reference.from}"`);
    }
  };

  for (const [componentName, component] of Object.entries(components)) {
    for (const [variable, reference] of Object.entries(component.environment ?? {})) {
      validateValueReference(
        reference,
        `${sourceName}.components.${componentName}.environment.${variable}`,
      );
    }
    for (const [target, reference] of Object.entries(component.configurationFiles ?? {})) {
      validateValueReference(
        reference,
        `${sourceName}.components.${componentName}.configurationFiles[${JSON.stringify(target)}]`,
      );
    }
    for (const dependency of component.dependsOn ?? []) {
      if (!hasOwn(components, dependency)) {
        issues.push(
          `${sourceName}.components.${componentName}.dependsOn references unknown component "${dependency}"`,
        );
      } else if (dependency === componentName) {
        issues.push(`${sourceName}.components.${componentName} cannot depend on itself`);
      }
    }
    for (const [mountPath, mount] of Object.entries(component.mounts ?? {})) {
      if (!hasOwn(resources, mount.resource)) {
        issues.push(
          `${sourceName}.components.${componentName}.mounts[${JSON.stringify(mountPath)}] references unknown resource "${mount.resource}"`,
        );
      }
    }
    if (component.health && !hasOwn(component.interfaces ?? {}, component.health.interface)) {
      issues.push(
        `${sourceName}.components.${componentName}.health references unknown local interface "${component.health.interface}"`,
      );
    }
  }

  for (const [routeName, route] of Object.entries(graph.routes ?? {})) {
    if (typeof route.to !== 'string') continue;
    const target = resolveInterfaceReference(route.to, components);
    if (!target) {
      issues.push(
        `${sourceName}.routes.${routeName}.to references unknown interface "${route.to}"`,
      );
    } else if (target.protocol !== 'http' && target.protocol !== 'https') {
      issues.push(`${sourceName}.routes.${routeName}.to must reference an HTTP or HTTPS interface`);
    }
  }

  for (const [jobName, job] of Object.entries(graph.jobs ?? {})) {
    if (!hasOwn(components, job.component)) {
      issues.push(
        `${sourceName}.jobs.${jobName}.component references unknown component "${job.component}"`,
      );
    }
    for (const [variable, reference] of Object.entries(job.environment ?? {})) {
      validateValueReference(reference, `${sourceName}.jobs.${jobName}.environment.${variable}`);
    }
  }

  validateDependencyCycles(components, sourceName, issues);
}

function validateDependencyCycles(
  components: ApplicationManifest['components'],
  sourceName: string,
  issues: string[],
) {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visitComponent = (componentName: string, path: string[]): void => {
    if (visiting.has(componentName)) {
      const cycleStart = path.indexOf(componentName);
      issues.push(
        `${sourceName}.components contains a dependency cycle: ${[
          ...path.slice(cycleStart),
          componentName,
        ].join(' -> ')}`,
      );
      return;
    }
    if (visited.has(componentName)) return;
    visiting.add(componentName);
    for (const dependency of components[componentName]?.dependsOn ?? []) {
      if (hasOwn(components, dependency)) {
        visitComponent(dependency, [...path, componentName]);
      }
    }
    visiting.delete(componentName);
    visited.add(componentName);
  };

  for (const componentName of Object.keys(components)) visitComponent(componentName, []);
}

function resolveInterfaceReference(
  reference: string,
  components: ApplicationManifest['components'],
): InterfaceManifest | undefined {
  const parts = reference.split('.');
  if (parts.length !== 2) return undefined;
  if (!hasOwn(components, parts[0])) return undefined;
  const interfaces = components[parts[0]].interfaces ?? {};
  return hasOwn(interfaces, parts[1]) ? interfaces[parts[1]] : undefined;
}

function validateConfigurationValue(
  value: unknown,
  type: ConfigurationType,
  path: string,
  issues: string[],
) {
  if (
    (type === 'string' || type === 'secret' || type === 'file' || type === 'enum') &&
    typeof value !== 'string'
  )
    issues.push(`${path} must be a string`);
  else if (type === 'url') {
    if (typeof value !== 'string') issues.push(`${path} must be a URL string`);
    else {
      try {
        const parsed = new URL(value);
        if (!parsed.protocol || !parsed.hostname) issues.push(`${path} must be an absolute URL`);
      } catch {
        issues.push(`${path} must be an absolute URL`);
      }
    }
  } else if (type === 'boolean' && typeof value !== 'boolean')
    issues.push(`${path} must be a boolean`);
  else if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
    issues.push(`${path} must be a finite number`);
  } else if (type === 'integer' && !Number.isSafeInteger(value)) {
    issues.push(`${path} must be a safe integer`);
  }
}

function record(value: unknown, path: string, issues: string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    issues.push(`${path} must be an object`);
    return {};
  }
  return value as Record<string, unknown>;
}

function unknownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: string[],
) {
  const fields = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!fields.has(key)) issues.push(`${path} has unknown field "${key}"`);
  }
}

function validateName(value: unknown, path: string, issues: string[]) {
  if (typeof value !== 'string' || !NAME_PATTERN.test(value) || RESERVED_MAPPING_KEYS.has(value)) {
    issues.push(`${path} must match ${NAME_PATTERN}`);
  }
}

function string(value: unknown, path: string, issues: string[]) {
  if (typeof value !== 'string') issues.push(`${path} must be a string`);
}

function nonEmptyString(value: unknown, path: string, issues: string[]) {
  if (typeof value !== 'string' || value.length === 0)
    issues.push(`${path} must be a non-empty string`);
}

function absolutePath(value: unknown, path: string, issues: string[]) {
  if (typeof value !== 'string' || !value.startsWith('/'))
    issues.push(`${path} must be an absolute path`);
}

function boolean(value: unknown, path: string, issues: string[]) {
  if (typeof value !== 'boolean') issues.push(`${path} must be a boolean`);
}

function integer(value: unknown, path: string, issues: string[], minimum: number, maximum: number) {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    issues.push(`${path} must be an integer between ${minimum} and ${maximum}`);
  }
}

function enumeration(value: unknown, values: readonly string[], path: string, issues: string[]) {
  if (typeof value !== 'string' || !values.includes(value)) {
    issues.push(`${path} must be one of ${values.map((item) => JSON.stringify(item)).join(', ')}`);
  }
}

function stringArray(
  value: unknown,
  path: string,
  issues: string[],
  allowEmpty: boolean,
): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    issues.push(`${path} must be ${allowEmpty ? 'an' : 'a non-empty'} array of strings`);
    return [];
  }
  value.forEach((item, index) => nonEmptyString(item, `${path}[${index}]`, issues));
  return value.filter((item): item is string => typeof item === 'string');
}

function stringMap(value: unknown, path: string, issues: string[]): StringMap {
  const input = record(value, path, issues);
  const output: StringMap = {};
  for (const [key, item] of Object.entries(input)) {
    if (!key || RESERVED_MAPPING_KEYS.has(key)) {
      issues.push(`${path} has invalid key "${key}"`);
      continue;
    }
    if (typeof item !== 'string') issues.push(`${path}.${key} must be a string`);
    else output[key] = item;
  }
  return output;
}

function sortedKeys(value: object) {
  return Object.keys(value).sort();
}

function hasOwn(value: object, key: PropertyKey) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function sortedRecord<T, U>(
  value: Record<string, T>,
  transform: (value: T) => U,
): Record<string, U> {
  const output: Record<string, U> = {};
  for (const key of sortedKeys(value)) output[key] = transform(value[key]);
  return output;
}

function sortedStringMap(value: StringMap): StringMap {
  return sortedRecord(value, (item) => item);
}

function compareJsonScalars(left: JsonScalar, right: JsonScalar) {
  const leftJson = JSON.stringify(left);
  const rightJson = JSON.stringify(right);
  return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
}

function omitUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function canonicalize(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError('ApplicationSpec cannot contain non-finite numbers');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    const output: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined)
        throw new TypeError(`ApplicationSpec cannot contain undefined at "${key}"`);
      output[key] = canonicalize(item);
    }
    return output;
  }
  throw new TypeError(`ApplicationSpec cannot contain ${typeof value} values`);
}
