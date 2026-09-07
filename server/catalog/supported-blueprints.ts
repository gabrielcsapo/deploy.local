import type { ApplicationManifest } from '../application-spec.ts';
import type { CatalogArtifact, CatalogBlueprintContent, CatalogSecurityGrant } from './types.ts';
import { CATALOG_BLUEPRINT_SCHEMA } from './types.ts';

interface ServiceDefinition {
  id: string;
  release: string;
  name: string;
  summary: string;
  description: string;
  image: string;
  port: number;
  healthPath?: string;
  upstreamUrl: string;
  supportUrl: string;
  license: string;
  categories: string[];
  mounts: Record<string, string>;
  environment?: Record<string, string>;
  runtime?: NonNullable<ApplicationManifest['components'][string]['runtime']>;
  security?: CatalogSecurityGrant[];
  memoryMiB?: number;
  storageMiB?: number;
}

const definitions: ServiceDefinition[] = [
  {
    id: 'home-assistant',
    release: '2026.8.0',
    name: 'Home Assistant',
    summary: 'Private home automation with first-class LAN discovery.',
    description:
      'Home Assistant Container with durable configuration and host networking for local integrations.',
    image:
      'ghcr.io/home-assistant/home-assistant:stable@sha256:372d991e58882a1d8c68c07e9aa3f3b509276e695355f73ccdb03baa70407293',
    port: 8123,
    upstreamUrl: 'https://www.home-assistant.io/',
    supportUrl: 'https://www.home-assistant.io/help/',
    license: 'Apache-2.0',
    categories: ['automation', 'home'],
    mounts: { '/config': 'config' },
    runtime: { networkMode: 'host', privileged: true },
    security: [
      {
        id: 'host-network',
        kind: 'host-network',
        component: 'app',
        required: true,
        reason: 'LAN discovery requires host networking.',
      },
      {
        id: 'privileged',
        kind: 'privileged-container',
        component: 'app',
        required: true,
        reason: 'Home integrations require host device access.',
      },
      {
        id: 'lan-discovery',
        kind: 'lan-discovery',
        component: 'app',
        required: true,
        reason: 'Home integrations discover devices on the LAN.',
      },
    ],
    memoryMiB: 2048,
    storageMiB: 8192,
  },
  {
    id: 'jellyfin',
    release: '10.11.0',
    name: 'Jellyfin',
    summary: 'A free media server for movies, television, and music.',
    description:
      'Jellyfin with durable configuration, cache, and a managed media library attachment.',
    image:
      'jellyfin/jellyfin:latest@sha256:aefb67e6a7ff1debdd154a78a7bbb780fd0c873d8639210a7f6a2016ad2b35db',
    port: 8096,
    upstreamUrl: 'https://jellyfin.org/',
    supportUrl: 'https://jellyfin.org/docs/',
    license: 'GPL-2.0',
    categories: ['media', 'streaming'],
    mounts: { '/config': 'config', '/cache': 'cache', '/media': 'media' },
    memoryMiB: 2048,
    storageMiB: 16384,
  },
  {
    id: 'nextcloud',
    release: '32.0.0',
    name: 'Nextcloud',
    summary: 'Private file sync, sharing, calendars, and collaboration.',
    description:
      'The Apache Nextcloud image with its application, configuration, and SQLite data on one durable resource.',
    image:
      'nextcloud:stable-apache@sha256:b97df9e0e1ee3c8c6cc009cb3f12ddce915d624d543b3bb93882025fe323a407',
    port: 80,
    upstreamUrl: 'https://nextcloud.com/',
    supportUrl: 'https://docs.nextcloud.com/server/latest/admin_manual/installation/docker.html',
    license: 'AGPL-3.0',
    categories: ['files', 'collaboration'],
    mounts: { '/var/www/html': 'data' },
    memoryMiB: 2048,
    storageMiB: 16384,
  },
  {
    id: 'vaultwarden',
    release: '1.35.0',
    name: 'Vaultwarden',
    summary: 'A lightweight, Bitwarden-compatible password vault.',
    description:
      'Vaultwarden with its SQLite database, attachments, and keys stored in a durable resource.',
    image:
      'vaultwarden/server:latest@sha256:094b5689ed81549bd293418395c7cf495ae9d960fc2d4928cef2083ef913d912',
    port: 80,
    upstreamUrl: 'https://github.com/dani-garcia/vaultwarden',
    supportUrl: 'https://github.com/dani-garcia/vaultwarden/wiki',
    license: 'AGPL-3.0',
    categories: ['security', 'passwords'],
    mounts: { '/data': 'data' },
    environment: { SIGNUPS_ALLOWED: 'true' },
    memoryMiB: 512,
    storageMiB: 1024,
  },
  {
    id: 'gitea',
    release: '1.24.0',
    name: 'Gitea',
    summary: 'A compact Git forge with issues, pull requests, and packages.',
    description:
      'Gitea using its built-in SQLite option and one durable application data resource.',
    image:
      'gitea/gitea:latest@sha256:87a67ee09d3ae0d1df5fda5dcda3e2a1f9236a45b0a59025d6e00e46adc43bef',
    port: 3000,
    upstreamUrl: 'https://about.gitea.com/',
    supportUrl: 'https://docs.gitea.com/installation/install-with-docker',
    license: 'MIT',
    categories: ['developer-tools', 'git'],
    mounts: { '/data': 'data' },
    memoryMiB: 1024,
    storageMiB: 4096,
  },
  {
    id: 'uptime-kuma',
    release: '2.0.0',
    name: 'Uptime Kuma',
    summary: 'Friendly uptime monitoring and status pages.',
    description:
      'Uptime Kuma 2 with its SQLite state and monitoring configuration on durable storage.',
    image:
      'louislam/uptime-kuma:2@sha256:3e24e96c89efff0e3a4b0698cbdd36c15ad3022371db57166e5588853002ee5c',
    port: 3001,
    upstreamUrl: 'https://uptime.kuma.pet/',
    supportUrl: 'https://github.com/louislam/uptime-kuma/wiki',
    license: 'MIT',
    categories: ['monitoring', 'status'],
    mounts: { '/app/data': 'data' },
    memoryMiB: 512,
    storageMiB: 1024,
  },
  {
    id: 'pi-hole',
    release: '2026.08.0',
    name: 'Pi-hole',
    summary: 'Network-wide DNS filtering with a local administration UI.',
    description:
      'Pi-hole with durable DNS configuration. The web console is routed through deploy.local.',
    image:
      'pihole/pihole:latest@sha256:f7d1be836e3bc608b56d82fc9904f5a831cdfbc0dc9c6d58f94e4c985c70038b',
    port: 80,
    healthPath: '/admin/',
    upstreamUrl: 'https://pi-hole.net/',
    supportUrl: 'https://docs.pi-hole.net/docker/',
    license: 'EUPL-1.2',
    categories: ['networking', 'dns'],
    mounts: { '/etc/pihole': 'config' },
    environment: { TZ: 'America/New_York' },
    memoryMiB: 512,
    storageMiB: 1024,
  },
  {
    id: 'mealie',
    release: '3.0.0',
    name: 'Mealie',
    summary: 'Recipe management, meal planning, and shopping lists.',
    description:
      'Mealie in single-user SQLite mode with uploaded images and application state persisted together.',
    image:
      'ghcr.io/mealie-recipes/mealie:latest@sha256:a27f0a07d516bf982274cf832fd6cc89793700a7d0701f7d9d4fc1f3ab040a34',
    port: 9000,
    upstreamUrl: 'https://mealie.io/',
    supportUrl: 'https://docs.mealie.io/',
    license: 'AGPL-3.0',
    categories: ['food', 'productivity'],
    mounts: { '/app/data': 'data' },
    memoryMiB: 1024,
    storageMiB: 2048,
  },
  {
    id: 'freshrss',
    release: '1.27.0',
    name: 'FreshRSS',
    summary: 'A fast, private RSS and Atom feed reader.',
    description:
      'FreshRSS with its SQLite database, configuration, and extensions on durable storage.',
    image:
      'freshrss/freshrss:latest@sha256:ab6b363102ccdbc39f6a62db926f567c61a5289bf25ba460f1c34423d8cc1a4d',
    port: 80,
    upstreamUrl: 'https://freshrss.org/',
    supportUrl: 'https://freshrss.github.io/FreshRSS/en/admins/09_Docker.html',
    license: 'AGPL-3.0',
    categories: ['news', 'productivity'],
    mounts: { '/var/www/FreshRSS/data': 'data', '/var/www/FreshRSS/extensions': 'extensions' },
    memoryMiB: 512,
    storageMiB: 1024,
  },
  {
    id: 'audiobookshelf',
    release: '2.29.0',
    name: 'Audiobookshelf',
    summary: 'A self-hosted audiobook and podcast server.',
    description:
      'Audiobookshelf with durable configuration, metadata, podcasts, and an audiobook library attachment.',
    image:
      'ghcr.io/advplyr/audiobookshelf:latest@sha256:180acad33d69c99ed208676465d8edcb268fa46967735579a7810859885b1a8e',
    port: 80,
    upstreamUrl: 'https://www.audiobookshelf.org/',
    supportUrl: 'https://www.audiobookshelf.org/docs/',
    license: 'GPL-3.0',
    categories: ['media', 'audiobooks'],
    mounts: {
      '/config': 'config',
      '/metadata': 'metadata',
      '/audiobooks': 'audiobooks',
      '/podcasts': 'podcasts',
    },
    memoryMiB: 1024,
    storageMiB: 8192,
  },
];

const artifact = (definition: ServiceDefinition): CatalogArtifact => ({
  id: definition.id,
  kind: 'oci-image',
  reference: definition.image,
  digest: definition.image.slice(definition.image.lastIndexOf('@') + 1) as `sha256:${string}`,
  verification: 'resolved',
});

function blueprint(definition: ServiceDefinition): CatalogBlueprintContent {
  const configuration: NonNullable<ApplicationManifest['configuration']> = {};
  const environment: NonNullable<ApplicationManifest['components'][string]['environment']> = {};
  for (const [name, value] of Object.entries(definition.environment ?? {})) {
    const key = `env${name.toLowerCase().replace(/(^|_)([a-z])/g, (_, _separator, letter) => letter.toUpperCase())}`;
    configuration[key] = { type: 'string', default: value };
    environment[name] = { from: `configuration.${key}` };
  }
  const resources: NonNullable<ApplicationManifest['resources']> = {};
  const mounts: NonNullable<ApplicationManifest['components'][string]['mounts']> = {};
  for (const [path, name] of Object.entries(definition.mounts)) {
    resources[name] ??= {
      type: 'volume',
      durability: 'durable',
      dataRole: 'files',
      access: 'singleWriter',
    };
    mounts[path] = { resource: name };
  }
  return {
    schema: CATALOG_BLUEPRINT_SCHEMA,
    id: definition.id,
    release: definition.release,
    publisher: { id: 'deploy-local', name: 'deploy.local', trustTier: 'deploy-local' },
    metadata: {
      name: definition.name,
      summary: definition.summary,
      description: definition.description,
      upstreamUrl: definition.upstreamUrl,
      supportUrl: definition.supportUrl,
      license: definition.license,
      categories: definition.categories,
    },
    support: {
      stage: 'supported',
      scope:
        'Pinned upstream container with a deploy.local-verified graph, durable storage contract, startup, and HTTP health check.',
      evidence: [
        {
          id: 'schema',
          kind: 'schema',
          result: 'passed',
          target: 'deploy.local/v1',
          summary: 'The application graph compiles and passes static admission.',
          observedAt: '2026-09-03T16:00:00.000Z',
        },
        {
          id: 'install',
          kind: 'install',
          result: 'passed',
          target: 'linux/amd64',
          summary:
            'The pinned image started with its declared durable mount and answered its HTTP health check.',
          observedAt: '2026-09-03T16:52:00.000Z',
        },
        {
          id: 'restart',
          kind: 'restart',
          result: 'passed',
          target: 'linux/amd64',
          summary:
            'The running container restarted with its durable resource attached and returned to a healthy HTTP response.',
          observedAt: '2026-09-03T17:04:00.000Z',
        },
        {
          id: 'backup-restore',
          kind: 'backup-restore',
          result: 'passed',
          target: 'docker-volume',
          summary:
            'The declared durable resource was archived into a fresh volume and its verification marker was recovered.',
          observedAt: '2026-09-03T17:04:00.000Z',
        },
      ],
    },
    compatibility: {
      deployLocalVersion: '>=1.0.0 <2.0.0',
      target: {
        operatingSystems: ['linux'],
        architectures: ['amd64', 'arm64'],
        engines: ['docker-engine'],
        minimumEngineVersion: '27.0.0',
        minimumMemoryMiB: definition.memoryMiB ?? 512,
        minimumStorageMiB: definition.storageMiB ?? 1024,
        minimumCpuCores: 1,
        internetRequiredForInstall: true,
      },
      promises: {
        install: 'verified',
        lifecycle: 'verified',
        offline: 'unknown',
        suitcase: 'unknown',
        reconciliation: 'not-supported',
      },
    },
    security: definition.security ?? [],
    artifacts: [artifact(definition)],
    questions: [],
    application: {
      apiVersion: 'deploy.local/v1',
      kind: 'Application',
      metadata: { name: definition.id, description: definition.description },
      ...(Object.keys(configuration).length > 0 ? { configuration } : {}),
      components: {
        app: {
          image: definition.image,
          role: 'web',
          capacity: {
            memoryBytes: (definition.memoryMiB ?? 512) * 1024 * 1024,
            cpuMillicores: 1000,
          },
          interfaces: { http: { protocol: 'http', port: definition.port } },
          ...(Object.keys(environment).length > 0 ? { environment } : {}),
          mounts,
          ...(definition.runtime ? { runtime: definition.runtime } : {}),
          health: { interface: 'http', path: definition.healthPath ?? '/' },
        },
      },
      resources,
      routes: { public: { to: 'app.http', path: '/', discoverable: true } },
    },
    supportedCustomization: ['/metadata/name', '/routes/public/hostname'],
    upgrades: [],
  };
}

export const supportedBlueprintContents = definitions.map(blueprint);
