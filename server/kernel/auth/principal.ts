/** Verified identity is not route authorization. Never fall back across credential kinds here. */
export type Principal =
  | { kind: 'person'; username: string }
  | { kind: 'admin'; username: string }
  | { kind: 'node'; nodeId: string }
  | { kind: 'worker'; owner: string; workerId: string }
  | { kind: 'run'; owner: string; taskId: string; runId: string }
  | { kind: 'ci'; username: string; application: string; credentialId: string }
  | { kind: 'device'; owner: string; deviceId: string }
  | { kind: 'grant'; grantKind: string; owner: string }
  | { kind: 'node-enrollment'; enrollmentId: string; name: string }
  | { kind: 'ssh'; owner: string; keyId: string }
  | { kind: 'package-key'; username: string; credential: string; scope: string }
  | { kind: 'package-computer'; username: string; computerId: string }
  | {
      kind: 'package-pipeline';
      owner: string;
      projectId: string;
      pipelineId: string;
      jobId: string;
      name: string;
      version: string;
      commit: string;
    }
  | {
      kind: 'upload';
      owner: string;
      application: string;
      taskId?: string;
      projectId?: string;
      pipelineId?: string;
    }
  | { kind: 'telemetry'; application: string; nodeId?: string; owner?: string }
  | { kind: 'copy'; owner: string; host: string }
  | { kind: 'supervisor' }
  | { kind: 'coordinator-switch' };

export type PrincipalOf<Kind extends Principal['kind']> = Extract<Principal, { kind: Kind }>;
