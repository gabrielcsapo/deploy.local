// Shared application services, configuration, and runtime read models.
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

export interface ApplicationOverviewData {
  runtime: RuntimeResponse | null;
  spec: DesiredSpec | null;
  configuration: ConfigurationResponse | null;
}
