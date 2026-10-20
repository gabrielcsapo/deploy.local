// Agent CLIs start the deploy MCP server with a filtered environment. Carry the
// worker's own TLS trust so a coordinator behind a private CA stays reachable.
// These values are paths and flags, never credentials.
const trustVariables = [
  'NODE_EXTRA_CA_CERTS',
  'NODE_USE_SYSTEM_CA',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
];
export function trustEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  execArgv: string[] = process.execArgv,
): Record<string, string> {
  const trust: Record<string, string> = {};
  for (const name of trustVariables) if (environment[name]) trust[name] = environment[name]!;
  if (
    execArgv.includes('--use-system-ca') ||
    /--use-system-ca\b/.test(environment.NODE_OPTIONS || '')
  )
    trust.NODE_USE_SYSTEM_CA = '1';
  return trust;
}
