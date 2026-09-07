import { validateCatalogBlueprint } from './blueprint.ts';
import { supportedBlueprintContents } from './supported-blueprints.ts';
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
const SUPPORTED_PUBLISHER_KEY_ID = 'deploy-local-supported-2026-09';
const SUPPORTED_PUBLISHER_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAr5S/wi/YdDpSr+gdLwf90oINJizCm7u/Rf4c5ipQo2E=
-----END PUBLIC KEY-----
`;

const supportedEnvelopes: Record<string, { contentDigest: `sha256:${string}`; signature: string }> =
  {
    'home-assistant@2026.8.0': {
      contentDigest: 'sha256:d1aa1ec9328c5bc8b110143688fbcd62f5bf885be97fe55e98ef968a322d7fe8',
      signature:
        'PueMdrlZ9NzAfQTBBJSQ1z9G/KP5swn1hJEheJmzTeB4YoHwxVMvhoQuuFPXt0XuPjGmyr2YmRubWwT8noXqBA==',
    },
    'jellyfin@10.11.0': {
      contentDigest: 'sha256:4a4c1dc6e73bc6089a75d8654be40560c352d938bacb86dcf9d876abff3bfdc4',
      signature:
        '9Fb485hnRolsoRG1MZQmGiTLGc6vJqQzThRZuSIwxoZznG+tSEH2n9t20jmPAnPhgiXJn+emyckvt7D9TM8DCQ==',
    },
    'nextcloud@32.0.0': {
      contentDigest: 'sha256:5ea4dbc713622512f4d9741817156fb86a7292108d57987b079b9a916360dbde',
      signature:
        'lAOdcK5SxDym0Ev2o2Q8m+0FV95PSCos+mrBvs7hj0qucg8WJeRQ1go8mKbC6RcVPHCcN2zM/Yk1dnlFgJtBCw==',
    },
    'vaultwarden@1.35.0': {
      contentDigest: 'sha256:cf32871a34fd6298a05c3d970fa0e1b58acf36f2e864cef212634e488d0b17ae',
      signature:
        'M2JkV+917VOMwGF2JNql+zzHEH2Zq2TUXdUPIw4HN2UuX/M0GgIePwEqk2aGVQQAEDZaLqAChPI7PCslC6ziCA==',
    },
    'gitea@1.24.0': {
      contentDigest: 'sha256:35f5dad2692b41872c2765baa2665ab0447ce84b2c7d5b22a4af6508ee457b53',
      signature:
        'BMpB+DI7E0P5TLrmhwXkT/kaBEja25NOBA7SXpqV2w3qW5/rLoAUSK+ZihAdC//WaK/To4/x3lHXSrlZjmqFAA==',
    },
    'uptime-kuma@2.0.0': {
      contentDigest: 'sha256:e6ac24c364f88d116072058b7fde52519ff85580300de61cd289e5ecc4488c05',
      signature:
        'rp2+VjL9Je0EuklGE9A/Mp+PGT1NdLyhXJaznVaJ/p3bpGfsdCSXVPAuIMkiBc0LCNGUVW0FIqpfBhHYCM5IDw==',
    },
    'pi-hole@2026.08.0': {
      contentDigest: 'sha256:35728bc07281b9efc5d1a38267f3cfe06bd7f0f76d2718cf099d42b9e55d80c1',
      signature:
        'HYI829Ek2oS9LjKOf2lUAMUkS7wZffbMrR6xvHY1fXgyEbnyklHKQSDPGy+gIH1XoO7ru1t3FCAwyNTXkbTrCg==',
    },
    'mealie@3.0.0': {
      contentDigest: 'sha256:51c253efec4aa133f0ed0ea670c92328b73222bbec199f7bd03d8c0311d12bc0',
      signature:
        'Q2ZGqhWLg5qPrrbvCjGLlngWtYmiD92LBkFCN7AXTdhkI4E1UjNHtCcAzu+3wciuNZJdJh1cvzX2l3WitjFXBw==',
    },
    'freshrss@1.27.0': {
      contentDigest: 'sha256:dc4de77195f3c90a77933d72d70d90722352e645a9eb573899142a091abcc4a8',
      signature:
        'ZGhFcbyykoW2UFdAfPzZjK4Cg3ieydYXaK00qMm6O9gcrfOwqf0Wd3BF6ij2lOizH099vCP/uZPjBY8AJ6EiDw==',
    },
    'audiobookshelf@2.29.0': {
      contentDigest: 'sha256:1e4d71923a814748ae6323a549f2dbabe4beaa2bd45c01b4a1c738835a498945',
      signature:
        '1WVYP77SGKySBA5hs6sX6kBl+V0R7E5k55fkq/Pd408MQ1YUUB+qbLqKv3nO+0jbUyyONe9BtD6upfKrbtg5DQ==',
    },
  };

const validationEnvelopes: Record<
  string,
  { contentDigest: `sha256:${string}`; signature: string }
> = {
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
    {
      keyId: SUPPORTED_PUBLISHER_KEY_ID,
      publisherId: 'deploy-local',
      trustTier: 'deploy-local',
      publicKeyPem: SUPPORTED_PUBLISHER_PUBLIC_KEY,
    },
  ],
  allowedTrustTiers: ['deploy-local'],
};

export const validationBlueprints: CatalogBlueprintRelease[] = validationBlueprintContents.map(
  (content) => {
    const envelope = validationEnvelopes[`${content.id}@${content.release}`];
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

export const supportedBlueprints: CatalogBlueprintRelease[] = supportedBlueprintContents.map(
  (content) => {
    const envelope = supportedEnvelopes[`${content.id}@${content.release}`];
    if (!envelope) throw new Error(`Missing signed envelope for ${content.id}@${content.release}`);
    return {
      ...content,
      contentDigest: envelope.contentDigest,
      signature: {
        algorithm: 'ed25519',
        keyId: SUPPORTED_PUBLISHER_KEY_ID,
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

export function loadSupportedCatalog(): ValidatedCatalogRelease[] {
  return supportedBlueprints.map((release) =>
    validateCatalogBlueprint(release, validationTrustStore),
  );
}
