import { nodeRuntimeEnvironment } from './node-runtime.ts';
import { coordinationTools } from './coordination-tools.ts';
import { trustEnvironment } from './tls-trust.ts';
import { workerEntry } from './worker-entry.ts';
// The worker's configured model belongs only to its compatible endpoint. Subscription
// defaults must be left unset so the provider chooses its own entitled default.
export function agentModelEnvironment(run: any, environment: NodeJS.ProcessEnv = process.env) {
  return {
    DEPLOY_MODEL_NAME:
      run.model || (run.adapter === 'compatible' ? environment.DEPLOY_MODEL_NAME : undefined),
    DEPLOY_MODEL_EFFORT: run.effort || undefined,
  };
}
export function agentLaunch(run: any) {
  const env = { DEPLOY_AGENT_INSTRUCTIONS: run.agentContext || '' };

  if (run.adapter === 'compatible')
    return {
      executable: process.execPath,
      args: workerEntry('compatible-agent'),
      env,
      instructionDelivery: 'compatible-system-message',
    };
  if (run.adapter === 'claude')
    return {
      executable: process.execPath,
      args: workerEntry('claude-agent'),
      env,
      instructionDelivery: 'claude-append-system-prompt',
    };
  const trust = Object.entries({ ...trustEnvironment(), ...nodeRuntimeEnvironment() });
  const args = [
    'exec',
    '--json',
    '-c',
    `developer_instructions=${JSON.stringify(run.agentContext || '')}`,
    // Managed workers use a private CODEX_HOME instead of importing desktop configuration.
    ...(process.env.DEPLOY_MANAGED_WORKER === '1' ? [] : ['--ignore-user-config']),
    '--sandbox',
    'workspace-write',
    '-c',
    'approval_policy="never"',
    '-c',
    `mcp_servers.deploy.command=${JSON.stringify(process.execPath)}`,
    '-c',
    `mcp_servers.deploy.args=${JSON.stringify(workerEntry('mcp'))}`,
    '-c',
    'mcp_servers.deploy.env_vars=["DEPLOY_AGENT_URL","DEPLOY_AGENT_TOKEN"]',
    ...(trust.length
      ? [
          '-c',
          `mcp_servers.deploy.env={${trust.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(',')}}`,
        ]
      : []),
    '-c',
    'mcp_servers.deploy.tool_timeout_sec=1860', // 30-minute approval plus transport margin.
    // This first-party tool set is scoped by the coordinator's per-run credential.
    // Do not change approval behavior for any other configured MCP server.
    ...coordinationTools.flatMap((t) => [
      '-c',
      `mcp_servers.deploy.tools.${t.name}.approval_mode="approve"`,
    ]),
    ...(run.model ? ['--model', run.model] : []),
    ...(run.effort ? ['-c', `model_reasoning_effort=${JSON.stringify(run.effort)}`] : []),
  ];
  if (run.sessionId) args.push('resume', run.sessionId);
  args.push(...(run.imagePaths || []).flatMap((path: string) => ['-i', path]));
  args.push('-');
  return {
    executable: process.env.DEPLOY_CODEX_BIN || 'codex',
    args,
    env: {},
    instructionDelivery: 'codex-developer-instructions',
  };
}
export { operatingManual as coordinationInstructions } from './agent-context.ts';
