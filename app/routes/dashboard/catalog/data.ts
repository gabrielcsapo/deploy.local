import { loadValidationCatalog } from '../../../../server/catalog/fixtures.ts';
import { planCatalogInstall } from '../../../../server/catalog/planner.ts';
import { preflightCatalogInstall } from '../../../../server/catalog/preflight.ts';
import type { CatalogTargetProfile } from '../../../../server/catalog/types.ts';
import type { CatalogUiRelease } from './ui-types.ts';

const REFERENCE_HOME_TARGET: CatalogTargetProfile = {
  siteId: 'reference-home',
  deployLocalVersion: '1.0.0',
  operatingSystem: 'linux',
  architecture: 'amd64',
  engine: 'docker-engine',
  engineVersion: '28.0.0',
  memoryMiB: 8192,
  storageMiB: 65536,
  cpuCores: 8,
  online: true,
  cachedArtifactDigests: [],
  capabilities: {
    catalogExecution: true,
    privilegedContainers: false,
    hostNetwork: false,
    lanDiscovery: true,
    hostPaths: [],
    devices: [],
    dockerSocket: false,
  },
};

export function catalogUiReleases(): CatalogUiRelease[] {
  return loadValidationCatalog().map((validated) => {
    const applicationName = validated.normalizedSpec.metadata.name || validated.release.id;
    const preflight = preflightCatalogInstall({
      release: validated,
      applicationName,
      target: REFERENCE_HOME_TARGET,
    });
    const installPlan = planCatalogInstall({
      release: validated,
      applicationName,
      target: REFERENCE_HOME_TARGET,
    });
    return {
      id: validated.release.id,
      release: validated.release.release,
      name: validated.release.metadata.name,
      summary: validated.release.metadata.summary,
      description: validated.release.metadata.description,
      categories: validated.release.metadata.categories,
      publisher: validated.release.publisher.name,
      trustTier: validated.release.publisher.trustTier,
      stage: validated.release.support.stage,
      supportScope: validated.release.support.scope,
      upstreamUrl: validated.release.metadata.upstreamUrl,
      supportUrl: validated.release.metadata.supportUrl,
      license: validated.release.metadata.license,
      trademarkNotice: validated.release.metadata.trademarkNotice,
      contentDigest: validated.release.contentDigest,
      signatureKeyId: validated.release.signature.keyId,
      promises: validated.release.compatibility.promises,
      deployLocalVersionRange: validated.release.compatibility.deployLocalVersion,
      target: validated.release.compatibility.target,
      graph: validated.normalizedSpec,
      security: validated.release.security,
      evidence: validated.release.support.evidence,
      questions: validated.release.questions,
      preflight,
      installPlan,
    };
  });
}
