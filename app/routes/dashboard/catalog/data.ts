import { loadSupportedCatalog } from '../../../../server/catalog/fixtures.ts';
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
    privilegedContainers: true,
    hostNetwork: true,
    lanDiscovery: true,
    hostPaths: [],
    devices: [],
    dockerSocket: true,
  },
};

const CATALOG_PRESENTATION: Record<string, { icon: string; source: string }> = {
  'home-assistant': {
    icon: 'home-assistant',
    source: 'https://github.com/home-assistant/core',
  },
  jellyfin: { icon: 'jellyfin', source: 'https://github.com/jellyfin/jellyfin' },
  nextcloud: { icon: 'nextcloud', source: 'https://github.com/nextcloud/server' },
  vaultwarden: {
    icon: 'vaultwarden',
    source: 'https://github.com/dani-garcia/vaultwarden',
  },
  gitea: { icon: 'gitea', source: 'https://github.com/go-gitea/gitea' },
  'uptime-kuma': {
    icon: 'uptime-kuma',
    source: 'https://github.com/louislam/uptime-kuma',
  },
  'pi-hole': { icon: 'pi-hole', source: 'https://github.com/pi-hole/pi-hole' },
  mealie: { icon: 'mealie', source: 'https://github.com/mealie-recipes/mealie' },
  freshrss: { icon: 'freshrss', source: 'https://github.com/FreshRSS/FreshRSS' },
  audiobookshelf: {
    icon: 'audiobookshelf',
    source: 'https://github.com/advplyr/audiobookshelf',
  },
};

export function catalogUiReleases(): CatalogUiRelease[] {
  return loadSupportedCatalog().map((validated) => {
    const presentation = CATALOG_PRESENTATION[validated.release.id];
    if (!presentation) throw new Error(`Missing catalog presentation for ${validated.release.id}`);
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
      iconUrl: `https://raw.githubusercontent.com/selfhst/icons/main/svg/${presentation.icon}.svg`,
      sourceUrl: presentation.source,
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
