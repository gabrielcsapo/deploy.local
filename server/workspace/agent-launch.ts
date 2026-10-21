import { applicationDeploymentInstructions } from './application-deployment-instructions.ts';
import { shippingInstructions } from './shipping-instructions.ts';
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
  if (run.adapter === 'compatible')
    return { executable: process.execPath, args: workerEntry('compatible-agent') };
  if (run.adapter === 'claude')
    return { executable: process.execPath, args: workerEntry('claude-agent') };
  const trust = Object.entries({ ...trustEnvironment(), ...nodeRuntimeEnvironment() });
  const args = [
    'exec',
    '--json',
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
  return { executable: process.env.DEPLOY_CODEX_BIN || 'codex', args };
}
const baseCoordinationInstructions =
  '\n\nDeploy.local coordination: When you produce an image or video the user should see, call deploy_attach. Recording (deploy_record guidance): for iOS simulator use xcrun simctl io <device> recordVideo --codec=h264 out.mp4, stop with SIGINT, then deploy_attach. For web use Playwright context recordVideo, close the context to finalize the file, then deploy_attach. Use the deploy tools to discover computers and dispatch authorized builds or checks. Capture a checkpoint after edits, run jobs on suitable online computers, and collect actual results. Jobs use isolated copies and do not merge edits back. Keep this task as the shared conversation. Do not claim queued jobs have passed. Use distinct operationId strings for mutations and reuse them only for identical retries. When missing user information blocks progress, use deploy_ask_user so the user can answer from any client and this turn can continue. Questions do not grant computer access; use deploy_control for its separate approval.';

export const coordinationInstructions =
  baseCoordinationInstructions + shippingInstructions + applicationDeploymentInstructions;
