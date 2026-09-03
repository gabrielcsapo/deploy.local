import { randomBytes } from 'node:crypto';
import type { ResolvedApplicationGraphRuntime } from './application-runtime.ts';
import type { AgentApplicationGraphPayload } from './agent-graph-runtime.ts';
import { DurableGraphRuntimeStore, type GraphRuntimeStateStore } from './graph-runtime-store.ts';

export interface AgentGraphPayloadInput {
  deploymentName: string;
  applicationId: string;
  siteId: string;
  writerSiteId: string | null;
  runtime: ResolvedApplicationGraphRuntime;
  runtimeVolumes?: readonly {
    component?: string;
    hostPath: string;
    containerPath: string;
    readOnly?: boolean;
  }[];
}

/**
 * Project the coordinator-admitted runtime into the encrypted agent-job envelope. Configuration
 * and generated profile values are intentionally included here, never in deploy.yaml or logs.
 */
export function createAgentGraphPayload(
  input: AgentGraphPayloadInput,
  state: Pick<GraphRuntimeStateStore, 'getOrCreateProfileValue'> = new DurableGraphRuntimeStore(),
): AgentApplicationGraphPayload {
  if (!input.runtime.ready || input.runtime.execution.blocked) {
    throw new Error('Only an admitted application graph can be sent to an execution agent');
  }
  const profileValues: Record<string, Record<string, string>> = {};
  const componentNames = Object.keys(input.runtime.execution.components);
  const runtimeVolumeMounts = (input.runtimeVolumes ?? []).map((mount) => {
    const component = mount.component || (componentNames.length === 1 ? componentNames[0] : '');
    if (!component || !input.runtime.execution.components[component]) {
      throw new Error(
        `Runtime mount ${JSON.stringify(mount.containerPath)} must select an application component`,
      );
    }
    return { ...mount, component };
  });
  for (const [componentName, component] of Object.entries(input.runtime.execution.components)) {
    if (!component.profile) continue;
    const values: Record<string, string> = {};
    for (const declaration of component.profile.provisionedValues) {
      values[declaration.name] = state.getOrCreateProfileValue({
        appId: input.applicationId,
        deploymentName: input.deploymentName,
        siteId: input.siteId,
        componentKey: componentName,
        key: declaration.name,
        secret: declaration.secret,
        create: () => generatedProfileValue(input.deploymentName, declaration.name),
      });
    }
    profileValues[componentName] = values;
  }
  return {
    version: 1,
    applicationId: input.applicationId,
    siteId: input.siteId,
    writerSiteId: input.writerSiteId,
    specDigest: input.runtime.execution.specDigest,
    configurationDigest: input.runtime.configurationDigest,
    spec: input.runtime.spec,
    execution: input.runtime.execution,
    configurationValues: input.runtime.configurationValues,
    componentEnvironment: input.runtime.componentEnvironment,
    profileValues,
    runtimeVolumeMounts,
  };
}

function generatedProfileValue(deploymentName: string, key: string): string {
  if (key === 'database') return safeIdentifier(deploymentName);
  if (key.endsWith('Username')) {
    const scope = key.slice(0, -'Username'.length) || 'app';
    return safeIdentifier(`${deploymentName}_${scope}`);
  }
  return randomBytes(32).toString('base64url');
}

function safeIdentifier(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'app'
  );
}
