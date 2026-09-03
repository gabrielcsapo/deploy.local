import { randomUUID } from 'node:crypto';
import { emptyApplicationSpec, planApplicationChange } from '../application-plan.ts';
import { compileApplicationManifest } from '../application-spec.ts';
import { catalogContentDigest } from './canonical.ts';
import { preflightCatalogInstall, type CatalogPreflightInput } from './preflight.ts';
import type {
  CatalogInstallation,
  CatalogOperationPlan,
  CatalogOperationStep,
  ValidatedCatalogRelease,
} from './types.ts';

export function planCatalogInstall(input: CatalogPreflightInput): CatalogOperationPlan {
  const preflight = preflightCatalogInstall(input);
  const changePlan = planApplicationChange(
    emptyApplicationSpec(input.applicationName),
    preflight.normalizedSpec,
    catalogPlanningContext(input.target),
  );
  const blockers = preflight.findings.filter((finding) => finding.severity === 'blocking');
  blockers.push(...sharedPlanBlockers(changePlan));
  return {
    planId: randomUUID(),
    operation: 'install',
    blueprintId: input.release.release.id,
    toRelease: input.release.release.release,
    targetSiteId: input.target.siteId,
    ready: preflight.ready && !changePlan.blocked,
    requiresApproval: input.release.release.security.length > 0 || changePlan.requiresApproval,
    destructive: changePlan.destructive,
    blockers,
    steps: installSteps(input.release),
    changePlan,
    normalizedSpec: preflight.normalizedSpec,
    note: 'This is a non-mutating install plan. Runtime and catalog state remain unchanged.',
  };
}

export function planCatalogUpgrade(input: {
  installation: CatalogInstallation;
  current: ValidatedCatalogRelease;
  target: ValidatedCatalogRelease;
  preflight: Omit<CatalogPreflightInput, 'release' | 'applicationName'>;
}): CatalogOperationPlan {
  const { installation, current, target } = input;
  const blockers = [] as CatalogOperationPlan['blockers'];
  const upgradePath = target.release.upgrades.find(
    (candidate) => candidate.fromRelease === installation.release,
  );
  if (installation.mode !== 'managed') {
    blockers.push({
      id: 'installation-not-managed',
      dimension: 'release',
      severity: 'blocking',
      summary: `A ${installation.mode} installation does not receive curated upgrades.`,
      remediation:
        'Install the target as a new managed application or maintain the local blueprint.',
    });
  }
  if (current.release.contentDigest !== installation.blueprintDigest) {
    blockers.push({
      id: 'installed-blueprint-digest-mismatch',
      dimension: 'release',
      severity: 'blocking',
      summary: 'The recorded installation no longer matches its signed source release.',
    });
  }
  if (!upgradePath) {
    blockers.push({
      id: 'upgrade-path-missing',
      dimension: 'release',
      severity: 'blocking',
      summary: `Release ${target.release.release} does not declare an upgrade from ${installation.release}.`,
      remediation: 'Choose a declared intermediate release or detach/derive the application.',
    });
  }
  const unsupportedDrift = installation.driftedAddresses.filter(
    (address) =>
      !current.release.supportedCustomization.some((prefix) => pointerContains(prefix, address)),
  );
  if (unsupportedDrift.length > 0) {
    blockers.push({
      id: 'unsupported-drift',
      dimension: 'release',
      severity: 'blocking',
      summary: `Unsupported graph drift must be resolved before upgrade: ${unsupportedDrift.join(', ')}.`,
      remediation: 'Derive a local blueprint or detach from the catalog to preserve this graph.',
    });
  }

  const targetPreflight = preflightCatalogInstall({
    ...input.preflight,
    release: target,
    applicationName: installation.applicationName,
  });
  blockers.push(...targetPreflight.findings.filter((finding) => finding.severity === 'blocking'));
  const currentSpec = namedSpec(current.normalizedSpec, installation.applicationName);
  const changePlan = planApplicationChange(
    currentSpec,
    targetPreflight.normalizedSpec,
    catalogPlanningContext(input.preflight.target),
  );
  blockers.push(...sharedPlanBlockers(changePlan));
  const steps: CatalogOperationStep[] = [
    {
      id: 'preflight',
      phase: 'preflight',
      summary: 'Revalidate the target, pinned artifacts, security grants, and configuration.',
      destructive: false,
      rollback: 'No mutation has occurred.',
    },
    ...(upgradePath?.recoveryPointRequired
      ? [
          {
            id: 'recovery-point',
            phase: 'recovery-point' as const,
            summary: 'Create and verify the release-declared recovery point.',
            destructive: false,
            rollback: 'Abort before replacing any component if verification fails.',
          },
        ]
      : []),
    ...(upgradePath?.migrationJobs ?? []).map((job) => ({
      id: `migration-${job}`,
      phase: 'migrate' as const,
      summary: `Run gated migration job ${job}.`,
      destructive: true,
      rollback:
        upgradePath?.rollback === 'supported'
          ? 'Restore the verified recovery point and previous pinned release.'
          : 'Rollback is limited by the declared migration boundary.',
    })),
    {
      id: 'materialize-target',
      phase: 'materialize',
      summary: 'Materialize the target pinned graph without moving traffic.',
      destructive: false,
      rollback: 'Keep the current healthy release active.',
    },
    {
      id: 'health-target',
      phase: 'health',
      summary: 'Admit traffic only after target release health succeeds.',
      destructive: false,
      rollback: 'Keep or restore the current endpoint set.',
    },
    {
      id: 'commit-target',
      phase: 'commit',
      summary: 'Commit the new release and retain its declared rollback boundary.',
      destructive: false,
      rollback: 'Use the recorded recovery point while the support window remains open.',
    },
  ];
  return {
    planId: randomUUID(),
    operation: 'upgrade',
    installationId: installation.id,
    blueprintId: target.release.id,
    fromRelease: installation.release,
    toRelease: target.release.release,
    targetSiteId: installation.siteId,
    ready: blockers.length === 0,
    requiresApproval: true,
    destructive: changePlan.destructive || steps.some((step) => step.destructive),
    blockers,
    steps,
    changePlan,
    normalizedSpec: targetPreflight.normalizedSpec,
    note: 'This plan does not execute the upgrade. A runtime transaction must verify every gate.',
  };
}

export function planCatalogDetach(input: {
  installation: CatalogInstallation;
  current: ValidatedCatalogRelease;
  currentSpec?: CatalogOperationPlan['normalizedSpec'];
}): CatalogOperationPlan {
  return ownershipPlan(input, 'detach');
}

export function planCatalogDerive(input: {
  installation: CatalogInstallation;
  current: ValidatedCatalogRelease;
  localBlueprintId: string;
  currentSpec?: CatalogOperationPlan['normalizedSpec'];
}): CatalogOperationPlan {
  return ownershipPlan(input, 'derive', input.localBlueprintId);
}

function ownershipPlan(
  input: {
    installation: CatalogInstallation;
    current: ValidatedCatalogRelease;
    currentSpec?: CatalogOperationPlan['normalizedSpec'];
  },
  operation: 'detach' | 'derive',
  localBlueprintId?: string,
): CatalogOperationPlan {
  const spec = compileApplicationManifest(input.currentSpec ?? input.current.normalizedSpec).spec;
  const changePlan = planApplicationChange(spec, spec, {
    source: 'catalog',
    targetSiteId: input.installation.siteId,
  });
  const blockers = [] as CatalogOperationPlan['blockers'];
  if (input.installation.mode !== 'managed') {
    blockers.push({
      id: 'installation-already-unmanaged',
      dimension: 'release',
      severity: 'blocking',
      summary: `Installation is already ${input.installation.mode}.`,
    });
  }
  if (
    !input.currentSpec &&
    (input.installation.currentSpecDigest !== input.installation.installedSpecDigest ||
      input.installation.driftedAddresses.length > 0)
  ) {
    blockers.push({
      id: 'current-graph-required',
      dimension: 'release',
      severity: 'blocking',
      summary: 'The application graph has drifted and its current revision was not provided.',
      remediation: 'Load the exact current ApplicationSpec before planning detach or derivation.',
    });
  }
  if (operation === 'derive' && !localBlueprintId?.match(/^[a-z][a-z0-9.-]{0,127}$/)) {
    blockers.push({
      id: 'local-blueprint-id-invalid',
      dimension: 'configuration',
      severity: 'blocking',
      summary: 'A derived blueprint needs a valid local blueprint ID.',
    });
  }
  return {
    planId: randomUUID(),
    operation,
    installationId: input.installation.id,
    blueprintId: input.installation.blueprintId,
    fromRelease: input.installation.release,
    toRelease: input.installation.release,
    ...(localBlueprintId ? { localBlueprintId } : {}),
    targetSiteId: input.installation.siteId,
    ready: blockers.length === 0,
    requiresApproval: true,
    destructive: false,
    blockers,
    steps: [
      {
        id: 'preserve-graph',
        phase: 'materialize',
        summary: 'Preserve the exact current normalized graph and application data.',
        destructive: false,
        rollback: 'No runtime or data mutation occurs.',
      },
      {
        id: 'change-ownership',
        phase: 'commit',
        summary:
          operation === 'derive'
            ? `Create local blueprint ${localBlueprintId} and end curated upgrade ownership.`
            : 'End curated upgrade ownership while retaining the ordinary application.',
        destructive: false,
        rollback: 'Reattachment requires an explicit compatible signed-release plan.',
      },
    ],
    changePlan,
    normalizedSpec: spec,
    note:
      operation === 'derive'
        ? `The derived blueprint digest will be ${catalogContentDigest({ localBlueprintId, spec })}; runtime and data remain unchanged.`
        : 'Detaching preserves runtime and data but permanently stops automatic curated upgrade offers.',
  };
}

function namedSpec(
  spec: CatalogOperationPlan['normalizedSpec'],
  name: string,
): CatalogOperationPlan['normalizedSpec'] {
  return compileApplicationManifest({
    ...spec,
    metadata: { ...spec.metadata, name },
  }).spec;
}

function catalogPlanningContext(target: CatalogPreflightInput['target']) {
  return {
    source: 'catalog' as const,
    targetSiteId: target.siteId,
    targetSiteKind: target.siteKind,
    ...(target.siteKind === 'suitcase' ? { suitcaseSiteIds: [target.siteId] } : {}),
  };
}

function sharedPlanBlockers(
  plan: ReturnType<typeof planApplicationChange>,
): CatalogOperationPlan['blockers'] {
  return plan.actions
    .filter((item) => item.blocked)
    .map((item) => ({
      id: `graph-plan:${item.address}`,
      dimension: 'release' as const,
      severity: 'blocking' as const,
      summary: item.reason,
    }));
}

function installSteps(release: ValidatedCatalogRelease): CatalogOperationStep[] {
  const migrationJobs = Object.entries(release.normalizedSpec.jobs).filter(
    ([, job]) => job.beforeTraffic,
  );
  return [
    {
      id: 'preflight',
      phase: 'preflight',
      summary: 'Verify the exact signed release, target, capacity, configuration, and grants.',
      destructive: false,
      rollback: 'No mutation has occurred.',
    },
    {
      id: 'materialize',
      phase: 'materialize',
      summary: 'Fetch pinned artifacts and create isolated resources without admitting traffic.',
      destructive: false,
      rollback: 'Remove new runtime objects; retain or quarantine data by administrator choice.',
    },
    {
      id: 'configure',
      phase: 'configure',
      summary: 'Store declared values separately and project only scoped bindings.',
      destructive: false,
      rollback: 'Remove the uncommitted configuration revision.',
    },
    ...migrationJobs.map(([name]) => ({
      id: `migration-${name}`,
      phase: 'migrate' as const,
      summary: `Run before-traffic job ${name}.`,
      destructive: true,
      rollback: 'Use the blueprint-declared recovery boundary; never report healthy on failure.',
    })),
    {
      id: 'health',
      phase: 'health',
      summary: 'Wait for the full dependency graph and routes to become healthy.',
      destructive: false,
      rollback: 'Keep traffic closed and present retry, retain-data, or cleanup choices.',
    },
    {
      id: 'commit',
      phase: 'commit',
      summary: 'Commit the installation record only after health admission.',
      destructive: false,
      rollback: 'No catalog installation exists until this atomic commit.',
    },
  ];
}

function pointerContains(allowed: string, actual: string): boolean {
  return actual === allowed || actual.startsWith(`${allowed}/`);
}
