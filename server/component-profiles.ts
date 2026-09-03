import type { ApplicationSpec } from './application-spec.ts';

export type RuntimeFindingSeverity = 'error' | 'warning';

export interface RuntimeAdmissionFinding {
  code: string;
  severity: RuntimeFindingSeverity;
  path: string;
  message: string;
}

export type ComponentProfileCapability =
  | 'provision'
  | 'generated-bindings'
  | 'health'
  | 'backup'
  | 'restore'
  | 'upgrade';

export interface GeneratedBindingContract {
  /** Stable binding name exposed to dependent components. */
  name: string;
  interface: string;
  protocol: string;
  /** Runtime containers, lifecycle jobs, and profile operations receive separate authority. */
  scope?: 'runtime' | 'migration' | 'backup-restore';
  fields: readonly string[];
  connection?: {
    scheme: string;
    databaseValue: string;
    usernameValue: string;
    passwordValue: string;
  };
}

export interface ProfileProvisionedValueContract {
  name: string;
  environment: string;
  secret: boolean;
  generated: boolean;
}

export interface ProfileLifecycleOperation {
  id: string;
  command: readonly string[];
  requiresQuiescence: boolean;
  destructive: boolean;
  output: 'none' | 'logical-archive' | 'health-result';
  workflow?:
    | 'command'
    | 'logical-backup'
    | 'logical-restore'
    | 'logical-major-upgrade'
    | 'logical-rollback';
  artifact?: {
    containerPath: string;
    format: string;
    mediaType: string;
  };
}

export interface ComponentProfilePlan {
  profile: string;
  capabilities: readonly ComponentProfileCapability[];
  generatedBindings: readonly GeneratedBindingContract[];
  provisionedValues: readonly ProfileProvisionedValueContract[];
  health?: {
    command: readonly string[];
    interface: string;
  };
  operations: readonly ProfileLifecycleOperation[];
  /** Idempotent role/schema preparation performed before a profiled instance is admitted. */
  provisioning?: {
    command: readonly string[];
    verificationCommand: readonly string[];
  };
  /** Profile-owned logical data boundary used by staged restore and volume activation. */
  managedData?: {
    resourceRole: ApplicationSpec['resources'][string]['dataRole'];
    mountPath: string;
  };
  /** Generic version identity used to require an explicit profile transition. */
  versionIdentity?: {
    value: string;
    imagePattern: string;
  };
  /** Profiles describe promises; they do not change the ordinary container executor. */
  dataMobility: 'ordinary-volume' | 'logical-export';
  supportsDisconnectedMultiWriter: boolean;
  backup?: {
    format: string;
    portable: boolean;
    verification: string;
    defaultRetain: number;
  };
  versionTransitions?: {
    sameMajor: 'rolling-image-update';
    major: 'logical-export-restore-required';
    unknown: 'blocked';
  };
  metadata: Readonly<Record<string, string | number | boolean>>;
}

export interface ComponentProfileContext {
  applicationId: string;
  componentName: string;
  component: ApplicationSpec['components'][string];
  spec: ApplicationSpec;
  /** Optional immutable evidence gathered by an image inspector. */
  evidence?: Readonly<Record<string, string | number | boolean>>;
}

export interface ComponentLifecycleProfile {
  readonly id: string;
  plan(context: ComponentProfileContext): {
    plan: ComponentProfilePlan;
    findings: RuntimeAdmissionFinding[];
  };
}

export class ComponentProfileRegistry {
  readonly #profiles = new Map<string, ComponentLifecycleProfile>();

  constructor(profiles: readonly ComponentLifecycleProfile[] = []) {
    for (const profile of profiles) this.register(profile);
  }

  register(profile: ComponentLifecycleProfile): this {
    if (this.#profiles.has(profile.id)) {
      throw new Error(
        `Component lifecycle profile ${JSON.stringify(profile.id)} is already registered`,
      );
    }
    this.#profiles.set(profile.id, profile);
    return this;
  }

  get(id: string): ComponentLifecycleProfile | undefined {
    return this.#profiles.get(id);
  }

  ids(): string[] {
    return [...this.#profiles.keys()].sort();
  }
}
