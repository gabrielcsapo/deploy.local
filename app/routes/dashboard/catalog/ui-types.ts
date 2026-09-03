import type { ApplicationSpec } from '../../../../server/application-spec.ts';
import type { ApplicationChangePlan } from '../../../../server/application-plan.ts';
import type {
  CatalogEvidence,
  CatalogCompatibilityPromises,
  CatalogOperationPlan,
  CatalogPreflightResult,
  CatalogQuestion,
  CatalogSecurityGrant,
} from '../../../../server/catalog/types.ts';

export interface CatalogUiRelease {
  id: string;
  release: string;
  name: string;
  summary: string;
  description: string;
  categories: string[];
  publisher: string;
  trustTier: string;
  stage: string;
  supportScope: string;
  upstreamUrl?: string;
  supportUrl?: string;
  license: string;
  trademarkNotice?: string;
  contentDigest: string;
  signatureKeyId: string;
  promises: CatalogCompatibilityPromises;
  deployLocalVersionRange: string;
  target: {
    operatingSystems: string[];
    architectures: string[];
    engines: string[];
    minimumEngineVersion?: string;
    minimumMemoryMiB: number;
    minimumStorageMiB: number;
    minimumCpuCores: number;
  };
  graph: ApplicationSpec;
  security: CatalogSecurityGrant[];
  evidence: CatalogEvidence[];
  questions: CatalogQuestion[];
  preflight: CatalogPreflightResult;
  installPlan: CatalogOperationPlan;
}

export interface ComposeImportUiResult {
  status: 'ready' | 'review-required' | 'blocked';
  spec: ApplicationSpec | null;
  plan: ApplicationChangePlan | null;
  findings: Array<{
    path: string;
    disposition: 'translated' | 'ignored' | 'review-required' | 'blocking';
    summary: string;
    securitySensitive: boolean;
  }>;
  sourceOfTruth: 'deploy.yaml';
  note: string;
}
