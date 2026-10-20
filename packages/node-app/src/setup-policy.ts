/** Only coordinator content and the exact bundled fallback page may run the setup bridge. */
export function trustedSetupOrigin(value: string, coordinator: string, localPage: string) {
  if (value === localPage) return true;
  try {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      url.origin === new URL(coordinator).origin &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
export function setupNavigation(
  value: string,
  coordinator: string,
  localPage: string,
  customPath?: string,
) {
  if (value === localPage) return true;
  if (!trustedSetupOrigin(value, coordinator, localPage)) return false;
  const path = new URL(value).pathname;
  return (
    path === '/dashboard/embed/computers' ||
    path.startsWith('/dashboard/embed/computers/') ||
    (!!customPath && path === new URL(customPath, coordinator).pathname)
  );
}
/** Logs are for diagnostics; local worker and node credentials must never appear in them. */
export function redactLogs(value: string, credentials: (string | undefined)[]) {
  let result = value;
  for (const credential of credentials)
    if (credential) result = result.replaceAll(credential, '[redacted]');
  return result
    .replace(/node_secret_[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(
      /((?:authorization|x-deploy-(?:token|node-secret|worker-token))\s*[:=]\s*)[^\r\n]+/gi,
      '$1[redacted]',
    );
}
