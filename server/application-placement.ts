import type { ApplicationSpec } from './application-spec.ts';
import type { RuntimeAdmissionFinding } from './component-profiles.ts';

export interface PlacementTargetEvidence {
  nodeId: string;
  kind: 'coordinator' | 'agent' | 'suitcase' | 'unknown';
  labels: Readonly<Record<string, string>>;
  source: string;
  observedAt: string | null;
}

export interface ComponentPlacementEvidence {
  component: string;
  nodeId: string | null;
  intent: ApplicationSpec['components'][string]['placement']['intent'];
  desiredInstances: number;
  requiredLabels: Readonly<Record<string, string>>;
  observedLabels: Readonly<Record<string, string | null>>;
  status: 'satisfied' | 'blocked';
  source: string;
  detail: string;
  observedAt: string | null;
}

export interface ApplicationPlacementAdmission {
  ready: boolean;
  findings: RuntimeAdmissionFinding[];
  evidence: ComponentPlacementEvidence[];
}

function stringMap(value: unknown, source: string): Record<string, string> {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${source} must be a JSON object containing string values`);
  }
  const labels: Record<string, string> = {};
  for (const [key, label] of Object.entries(value)) {
    if (!key || typeof label !== 'string' || !label) {
      throw new Error(`${source}.${key || '<empty>'} must be a non-empty string`);
    }
    labels[key] = label;
  }
  return Object.fromEntries(
    Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)),
  );
}

/** Explicit operator labels advertised by a coordinator, execution agent, or Suitcase target. */
export function configuredPlacementLabels(
  value = process.env.DEPLOY_NODE_LABELS,
): Record<string, string> {
  if (!value?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('DEPLOY_NODE_LABELS must be a JSON object containing string values');
  }
  return stringMap(parsed, 'DEPLOY_NODE_LABELS');
}

export function placementTargetFromFacts(input: {
  nodeId: string;
  kind?: string | null;
  platform?: string | null;
  architecture?: string | null;
  capabilities?: unknown;
  observedAt?: string | null;
  source: string;
}): PlacementTargetEvidence {
  let capabilities: Record<string, unknown> = {};
  try {
    const parsed =
      typeof input.capabilities === 'string' ? JSON.parse(input.capabilities) : input.capabilities;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      capabilities = parsed as Record<string, unknown>;
    }
  } catch {
    capabilities = {};
  }
  const custom = Object.fromEntries(
    Object.entries(stringMap(capabilities.labels, `${input.source}.capabilities.labels`)).filter(
      ([key]) => key !== 'platform' && key !== 'architecture' && !key.startsWith('deploy.local/'),
    ),
  );
  const kind =
    input.kind === 'coordinator' || input.kind === 'agent' || input.kind === 'suitcase'
      ? input.kind
      : 'unknown';
  const builtIn = Object.fromEntries(
    [
      ['deploy.local/node-id', input.nodeId],
      ['deploy.local/site-id', input.nodeId],
      ['deploy.local/node-kind', kind],
      ['deploy.local/platform', input.platform],
      ['deploy.local/architecture', input.architecture],
      ['platform', input.platform],
      ['architecture', input.architecture],
    ].filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[1]),
    ),
  );
  return {
    nodeId: input.nodeId,
    kind,
    // Reserved and hardware-derived facts cannot be forged by custom labels.
    labels: Object.fromEntries(
      Object.entries({ ...custom, ...builtIn }).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    source: input.source,
    observedAt: input.observedAt ?? null,
  };
}

function pointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

/**
 * v1 materializes an application's privately connected dependency closure on exactly one node.
 * Required labels are hard constraints on that selected local node. `spread` is deliberately
 * rejected until authenticated cross-node service discovery and scheduling exist.
 */
export function evaluateApplicationPlacement(input: {
  spec: ApplicationSpec;
  desiredInstances: Readonly<Record<string, number>>;
  target?: PlacementTargetEvidence | null;
}): ApplicationPlacementAdmission {
  const findings: RuntimeAdmissionFinding[] = [];
  const evidence: ComponentPlacementEvidence[] = [];
  for (const [componentName, component] of Object.entries(input.spec.components).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const desiredInstances = input.desiredInstances[componentName] ?? component.instances;
    const requiredLabels = component.placement.requiredLabels;
    const observedLabels = Object.fromEntries(
      Object.keys(requiredLabels)
        .sort()
        .map((key) => [key, input.target?.labels[key] ?? null]),
    );
    const blockers: string[] = [];
    if (component.placement.intent === 'spread') {
      const message = `Component ${JSON.stringify(componentName)} requests spread placement, but v1 materializes one node-local private dependency closure; cross-node scheduling and service discovery are not implemented`;
      blockers.push(message);
      findings.push({
        code: 'PLACEMENT_SPREAD_REQUIRES_CROSS_NODE_SCHEDULER',
        severity: 'error',
        path: `/components/${pointer(componentName)}/placement/intent`,
        message,
      });
    }
    if (Object.keys(requiredLabels).length > 0 && !input.target) {
      const message = `Component ${JSON.stringify(componentName)} requires node labels, but the selected local node has no authenticated placement evidence`;
      blockers.push(message);
      findings.push({
        code: 'PLACEMENT_TARGET_EVIDENCE_UNAVAILABLE',
        severity: 'error',
        path: `/components/${pointer(componentName)}/placement/requiredLabels`,
        message,
      });
    } else if (input.target) {
      for (const [key, expected] of Object.entries(requiredLabels)) {
        const actual = input.target.labels[key];
        if (actual === expected) continue;
        const message = `Component ${JSON.stringify(componentName)} requires node label ${JSON.stringify(key)}=${JSON.stringify(expected)}, but ${input.target.nodeId} reports ${actual === undefined ? 'no value' : JSON.stringify(actual)}`;
        blockers.push(message);
        findings.push({
          code: 'PLACEMENT_REQUIRED_LABEL_MISMATCH',
          severity: 'error',
          path: `/components/${pointer(componentName)}/placement/requiredLabels/${pointer(key)}`,
          message,
        });
      }
    }
    evidence.push({
      component: componentName,
      nodeId: input.target?.nodeId ?? null,
      intent: component.placement.intent,
      desiredInstances,
      requiredLabels,
      observedLabels,
      status: blockers.length > 0 ? 'blocked' : 'satisfied',
      source: input.target?.source ?? 'selected-local-node',
      detail:
        blockers.join('; ') ||
        `Component is admitted into the node-local private closure on ${input.target?.nodeId ?? 'the selected node'}`,
      observedAt: input.target?.observedAt ?? null,
    });
  }
  return {
    ready: findings.every((finding) => finding.severity !== 'error'),
    findings,
    evidence,
  };
}
