import type { ApplicationSpec } from './application-spec.ts';
import type {
  ComponentLifecycleProfile,
  ComponentProfileContext,
  ComponentProfilePlan,
  RuntimeAdmissionFinding,
} from './component-profiles.ts';

export const POSTGRES_PROFILE_ID = 'deploy.local/postgres@1';

const SUPPORTED_MAJORS = new Set([14, 15, 16, 17, 18]);

const PROVISION_SCOPED_ROLES = [
  'sh',
  '-ec',
  `psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1 <<SQL
DO \\$deploy\\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$DEPLOY_APP_USER') THEN
    EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', '$DEPLOY_APP_USER', '$DEPLOY_APP_PASSWORD');
  ELSE
    EXECUTE format('ALTER ROLE %I LOGIN PASSWORD %L', '$DEPLOY_APP_USER', '$DEPLOY_APP_PASSWORD');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$DEPLOY_MIGRATION_USER') THEN
    EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', '$DEPLOY_MIGRATION_USER', '$DEPLOY_MIGRATION_PASSWORD');
  ELSE
    EXECUTE format('ALTER ROLE %I LOGIN PASSWORD %L', '$DEPLOY_MIGRATION_USER', '$DEPLOY_MIGRATION_PASSWORD');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$DEPLOY_BACKUP_USER') THEN
    EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', '$DEPLOY_BACKUP_USER', '$DEPLOY_BACKUP_PASSWORD');
  ELSE
    EXECUTE format('ALTER ROLE %I LOGIN PASSWORD %L', '$DEPLOY_BACKUP_USER', '$DEPLOY_BACKUP_PASSWORD');
  END IF;
END
\\$deploy\\$;
REASSIGN OWNED BY "$DEPLOY_BACKUP_USER" TO "$DEPLOY_MIGRATION_USER";
GRANT CONNECT ON DATABASE "$POSTGRES_DB" TO "$DEPLOY_APP_USER", "$DEPLOY_MIGRATION_USER", "$DEPLOY_BACKUP_USER";
GRANT CREATE ON DATABASE "$POSTGRES_DB" TO "$DEPLOY_MIGRATION_USER", "$DEPLOY_BACKUP_USER";
GRANT USAGE ON SCHEMA public TO "$DEPLOY_APP_USER";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "$DEPLOY_APP_USER";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "$DEPLOY_APP_USER";
GRANT CREATE, USAGE ON SCHEMA public TO "$DEPLOY_MIGRATION_USER", "$DEPLOY_BACKUP_USER";
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO "$DEPLOY_MIGRATION_USER", "$DEPLOY_BACKUP_USER";
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO "$DEPLOY_MIGRATION_USER", "$DEPLOY_BACKUP_USER";
GRANT pg_read_all_data TO "$DEPLOY_BACKUP_USER";
ALTER DEFAULT PRIVILEGES FOR ROLE "$POSTGRES_USER" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "$DEPLOY_APP_USER";
ALTER DEFAULT PRIVILEGES FOR ROLE "$POSTGRES_USER" IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO "$DEPLOY_APP_USER";
ALTER DEFAULT PRIVILEGES FOR ROLE "$DEPLOY_MIGRATION_USER" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "$DEPLOY_APP_USER";
ALTER DEFAULT PRIVILEGES FOR ROLE "$DEPLOY_MIGRATION_USER" IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO "$DEPLOY_APP_USER";
SQL`,
] as const;

const VERIFY_SCOPED_ROLES = [
  'sh',
  '-ec',
  `test "$(psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --tuples-only --no-align --command "SELECT CASE WHEN (SELECT count(*) FROM pg_roles WHERE rolname IN ('$DEPLOY_APP_USER', '$DEPLOY_MIGRATION_USER', '$DEPLOY_BACKUP_USER')) = 3 AND has_database_privilege('$DEPLOY_APP_USER', '$POSTGRES_DB', 'CONNECT') AND has_schema_privilege('$DEPLOY_APP_USER', 'public', 'USAGE') AND has_database_privilege('$DEPLOY_MIGRATION_USER', '$POSTGRES_DB', 'CREATE') AND has_database_privilege('$DEPLOY_BACKUP_USER', '$POSTGRES_DB', 'CREATE') AND pg_has_role('$DEPLOY_BACKUP_USER', 'pg_read_all_data', 'MEMBER') THEN 1 ELSE 0 END")" = "1"`,
] as const;

function postgresMajor(image: string | undefined, evidence: ComponentProfileContext['evidence']) {
  const evidenced = evidence?.postgresMajor;
  if (typeof evidenced === 'number' && Number.isInteger(evidenced)) return evidenced;
  if (!image) return undefined;
  const tag = image.match(/(?:^|\/)postgres:(\d+)(?:[.-]|$)/i);
  return tag ? Number(tag[1]) : undefined;
}

function postgresPlan(major: number | undefined): ComponentProfilePlan {
  return {
    profile: POSTGRES_PROFILE_ID,
    capabilities: ['provision', 'generated-bindings', 'health', 'backup', 'restore', 'upgrade'],
    generatedBindings: [
      {
        name: 'database',
        interface: 'postgres',
        protocol: 'postgres',
        scope: 'runtime',
        fields: ['host', 'port', 'database', 'username', 'password', 'url'],
        connection: {
          scheme: 'postgres',
          databaseValue: 'database',
          usernameValue: 'appUsername',
          passwordValue: 'appPassword',
        },
      },
      {
        name: 'database-migration',
        interface: 'postgres',
        protocol: 'postgres',
        scope: 'migration',
        fields: ['host', 'port', 'database', 'username', 'password', 'url'],
        connection: {
          scheme: 'postgres',
          databaseValue: 'database',
          usernameValue: 'migrationUsername',
          passwordValue: 'migrationPassword',
        },
      },
      {
        name: 'database-backup-restore',
        interface: 'postgres',
        protocol: 'postgres',
        scope: 'backup-restore',
        fields: ['host', 'port', 'database', 'username', 'password', 'url'],
        connection: {
          scheme: 'postgres',
          databaseValue: 'database',
          usernameValue: 'backupUsername',
          passwordValue: 'backupPassword',
        },
      },
    ],
    provisionedValues: [
      {
        name: 'database',
        environment: 'POSTGRES_DB',
        secret: false,
        generated: true,
      },
      {
        name: 'ownerUsername',
        environment: 'POSTGRES_USER',
        secret: false,
        generated: true,
      },
      {
        name: 'ownerPassword',
        environment: 'POSTGRES_PASSWORD',
        secret: true,
        generated: true,
      },
      {
        name: 'appUsername',
        environment: 'DEPLOY_APP_USER',
        secret: false,
        generated: true,
      },
      {
        name: 'appPassword',
        environment: 'DEPLOY_APP_PASSWORD',
        secret: true,
        generated: true,
      },
      {
        name: 'migrationUsername',
        environment: 'DEPLOY_MIGRATION_USER',
        secret: false,
        generated: true,
      },
      {
        name: 'migrationPassword',
        environment: 'DEPLOY_MIGRATION_PASSWORD',
        secret: true,
        generated: true,
      },
      {
        name: 'backupUsername',
        environment: 'DEPLOY_BACKUP_USER',
        secret: false,
        generated: true,
      },
      {
        name: 'backupPassword',
        environment: 'DEPLOY_BACKUP_PASSWORD',
        secret: true,
        generated: true,
      },
    ],
    health: { command: ['pg_isready', '-U', '${POSTGRES_USER}'], interface: 'postgres' },
    operations: [
      {
        id: 'logical-export',
        command: [
          'sh',
          '-ec',
          'PGPASSWORD="$DEPLOY_BACKUP_PASSWORD" pg_dump --username "$DEPLOY_BACKUP_USER" --format=custom --file="${OUTPUT}" "$POSTGRES_DB"',
        ],
        requiresQuiescence: false,
        destructive: false,
        output: 'logical-archive',
        workflow: 'logical-backup',
        artifact: {
          containerPath: '/tmp/deploy-profile-backup.dump',
          format: 'postgresql-custom-archive',
          mediaType: 'application/vnd.postgresql.custom-archive',
        },
      },
      {
        id: 'verified-restore',
        command: [
          'sh',
          '-ec',
          'PGPASSWORD="$DEPLOY_BACKUP_PASSWORD" pg_restore --username "$DEPLOY_BACKUP_USER" --exit-on-error --no-owner --no-acl --dbname="$POSTGRES_DB" "${INPUT}"',
        ],
        requiresQuiescence: true,
        destructive: true,
        output: 'none',
        workflow: 'logical-restore',
        artifact: {
          containerPath: '/tmp/deploy-profile-restore.dump',
          format: 'postgresql-custom-archive',
          mediaType: 'application/vnd.postgresql.custom-archive',
        },
      },
      {
        id: 'major-upgrade',
        command: [
          'sh',
          '-ec',
          'PGPASSWORD="$DEPLOY_BACKUP_PASSWORD" pg_restore --username "$DEPLOY_BACKUP_USER" --exit-on-error --no-owner --no-acl --dbname="$POSTGRES_DB" "${INPUT}"',
        ],
        requiresQuiescence: true,
        destructive: true,
        output: 'none',
        workflow: 'logical-major-upgrade',
        artifact: {
          containerPath: '/tmp/deploy-profile-upgrade.dump',
          format: 'postgresql-custom-archive',
          mediaType: 'application/vnd.postgresql.custom-archive',
        },
      },
      {
        id: 'rollback',
        command: [],
        requiresQuiescence: true,
        destructive: true,
        output: 'none',
        workflow: 'logical-rollback',
      },
      {
        id: 'readiness',
        command: ['pg_isready', '-U', '${POSTGRES_USER}'],
        requiresQuiescence: false,
        destructive: false,
        output: 'health-result',
      },
    ],
    provisioning: {
      command: PROVISION_SCOPED_ROLES,
      verificationCommand: VERIFY_SCOPED_ROLES,
    },
    managedData: {
      resourceRole: 'database',
      mountPath: '/var/lib/postgresql/data',
    },
    ...(major === undefined
      ? {}
      : {
          versionIdentity: {
            value: String(major),
            imagePattern: '(?:^|/)postgres:(\\d+)(?:[.-]|$)',
          },
        }),
    dataMobility: 'logical-export',
    supportsDisconnectedMultiWriter: false,
    backup: {
      format: 'postgresql-custom-archive',
      portable: true,
      verification: 'restore-and-readiness-check',
      defaultRetain: 7,
    },
    versionTransitions: {
      sameMajor: 'rolling-image-update',
      major: 'logical-export-restore-required',
      unknown: 'blocked',
    },
    metadata: {
      engine: 'postgresql',
      profileVersion: 1,
      ...(major === undefined ? {} : { majorVersion: major }),
      majorUpgradeRequiresLogicalRestore: true,
    },
  };
}

function finding(
  componentName: string,
  code: string,
  message: string,
  suffix = '',
): RuntimeAdmissionFinding {
  return {
    code,
    severity: 'error',
    path: `/components/${componentName}${suffix}`,
    message,
  };
}

function validatePostgres(context: ComponentProfileContext): RuntimeAdmissionFinding[] {
  const { componentName, component, spec } = context;
  const findings: RuntimeAdmissionFinding[] = [];
  const major = postgresMajor(component.image, context.evidence);

  if (component.instances !== 1) {
    findings.push(
      finding(
        componentName,
        'POSTGRES_SINGLE_WRITER_INSTANCE_REQUIRED',
        'The PostgreSQL v1 profile requires exactly one component instance; replicas need a future replication-aware profile',
        '/instances',
      ),
    );
  }
  if (component.build) {
    findings.push(
      finding(
        componentName,
        'POSTGRES_IMAGE_EVIDENCE_REQUIRED',
        'A profiled PostgreSQL component must use an inspected image with known major-version evidence',
        '/build',
      ),
    );
  }
  if (major === undefined) {
    findings.push(
      finding(
        componentName,
        'POSTGRES_MAJOR_UNKNOWN',
        'The PostgreSQL image major version could not be established from its tag or immutable image evidence',
        '/image',
      ),
    );
  } else if (!SUPPORTED_MAJORS.has(major)) {
    findings.push(
      finding(
        componentName,
        'POSTGRES_MAJOR_UNSUPPORTED',
        `PostgreSQL major ${major} is outside the v1 profile support window (${[...SUPPORTED_MAJORS].join(', ')})`,
        '/image',
      ),
    );
  }

  const postgresInterfaces = Object.entries(component.interfaces).filter(
    ([, item]) => item.protocol === 'postgres',
  );
  if (postgresInterfaces.length !== 1 || postgresInterfaces[0][0] !== 'postgres') {
    findings.push(
      finding(
        componentName,
        'POSTGRES_INTERFACE_REQUIRED',
        'The PostgreSQL v1 profile requires one interface named "postgres" using the postgres protocol',
        '/interfaces',
      ),
    );
  }

  const writableDatabaseMounts = Object.entries(component.mounts).filter(([, mount]) => {
    const resource = spec.resources[mount.resource];
    return !mount.readOnly && resource?.dataRole === 'database';
  });
  if (writableDatabaseMounts.length !== 1) {
    findings.push(
      finding(
        componentName,
        'POSTGRES_DATA_VOLUME_REQUIRED',
        'The PostgreSQL v1 profile requires exactly one writable database volume',
        '/mounts',
      ),
    );
  } else {
    const [, mount] = writableDatabaseMounts[0];
    const resource = spec.resources[mount.resource];
    if (resource.durability !== 'durable' || resource.access !== 'singleWriter') {
      findings.push({
        code: 'POSTGRES_DURABLE_SINGLE_WRITER_REQUIRED',
        severity: 'error',
        path: `/resources/${mount.resource}`,
        message: 'A profiled PostgreSQL data volume must be durable and singleWriter',
      });
    }
  }

  return findings;
}

export const postgresComponentProfile: ComponentLifecycleProfile = {
  id: POSTGRES_PROFILE_ID,
  plan(context) {
    const major = postgresMajor(context.component.image, context.evidence);
    return { plan: postgresPlan(major), findings: validatePostgres(context) };
  },
};

/** Major changes are data transitions, not ordinary image rolls. */
export function planPostgresVersionTransition(
  from: ApplicationSpec['components'][string],
  to: ApplicationSpec['components'][string],
): 'none' | 'rolling-image-update' | 'logical-export-restore-required' | 'blocked-unknown-major' {
  const fromMajor = postgresMajor(from.image, undefined);
  const toMajor = postgresMajor(to.image, undefined);
  if (from.image === to.image) return 'none';
  if (fromMajor === undefined || toMajor === undefined) return 'blocked-unknown-major';
  return fromMajor === toMajor ? 'rolling-image-update' : 'logical-export-restore-required';
}
