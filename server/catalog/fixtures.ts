import { validateCatalogBlueprint } from './blueprint.ts';
import { validationBlueprintContents } from './validation-blueprints.ts';
import type {
  CatalogBlueprintRelease,
  CatalogTrustStore,
  ValidatedCatalogRelease,
} from './types.ts';

export const VALIDATION_PUBLISHER_KEY_ID = 'deploy-local-validation-2026-08-graph';
export const VALIDATION_PUBLISHER_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAFNcOiSuiLBJ6Lgvss43sN98dh73+6PbtutbGspqN7es=
-----END PUBLIC KEY-----
`;

const envelopes: Record<string, { contentDigest: `sha256:${string}`; signature: string }> = {
  'volume-app-fixture@1.0.0-validation.1': {
    contentDigest: 'sha256:6d89f9939bada1b922a16f516115d3c676c005fae8bf215f4c7e01aacc3fb87b',
    signature:
      'XUFVSOBBvgJYqB26FTnKk4qnijMl0QltYBLRK2E70t2RzI6qWxupuiiQV35/CvqrsQv4WDmAejZEtfmqEpP0Dg==',
  },
  'home-assistant-container@2026.8.0-validation.1': {
    contentDigest: 'sha256:1ab41592d595dfc8ed1d3ca73df9231bd04692b1c38a4bfd73030ef43a2ac988',
    signature:
      'TqVzhQo/QhASyIKcm92d2Ih1ZLtCPjzkBmKHl2gmsovzmicMRVHIednqzGw5nGOvsednvClUfnM5yhqgDw8qBw==',
  },
  'postgres-service-graph-fixture@1.0.0-validation.1': {
    contentDigest: 'sha256:3a0feedcc15d4e2e0e2b8e97b7cfc8682c36ba14fdca7ebeecab59a3c1a47175',
    signature:
      'QZeQOI3hz/BtOQYnksf8wKh3ii44MSC6oWwnJa0f+j6e/BgCux5eO3RzNZG6q65ySICgiGnREJLMVX0Dh4EhCQ==',
  },
  'volume-app-fixture@1.1.0-validation.1': {
    contentDigest: 'sha256:9a8ea904d288b857ec4ab2d0612fe740f30eb038a2815c59e9ac926bd974b319',
    signature:
      'zDsgWlDw06qHC0BOla+zstG/Buz2SPUlTZLosyO7dyY3iuPNkwKDB9MGYvv1ekJbzjIIijOp5wccUgyn/s8oCw==',
  },
  'postgres-service-graph-fixture@1.1.0-validation.1': {
    contentDigest: 'sha256:bc0d67dc895b3be88dcba68181226b979e3f4a085af332601c90ca942f0862bc',
    signature:
      'Pjl998S3Oj0M58qi6suztF8EIL0TJZnIWmm4a+omS0AozwxJ4hBMENuxJnWYdabkYNrXn4e+9hbpeB2IA2XdAA==',
  },
};

export const validationTrustStore: CatalogTrustStore = {
  keys: [
    {
      keyId: VALIDATION_PUBLISHER_KEY_ID,
      publisherId: 'deploy-local',
      trustTier: 'deploy-local',
      publicKeyPem: VALIDATION_PUBLISHER_PUBLIC_KEY,
    },
  ],
  allowedTrustTiers: ['deploy-local'],
};

export const validationBlueprints: CatalogBlueprintRelease[] = validationBlueprintContents.map(
  (content) => {
    const envelope = envelopes[`${content.id}@${content.release}`];
    if (!envelope) throw new Error(`Missing signed envelope for ${content.id}@${content.release}`);
    return {
      ...content,
      contentDigest: envelope.contentDigest,
      signature: {
        algorithm: 'ed25519',
        keyId: VALIDATION_PUBLISHER_KEY_ID,
        value: envelope.signature,
      },
    };
  },
);

export function loadValidationCatalog(): ValidatedCatalogRelease[] {
  return validationBlueprints.map((release) =>
    validateCatalogBlueprint(release, validationTrustStore),
  );
}
