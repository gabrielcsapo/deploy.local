const KNOWN: Record<string, string> = {
  'github.com': 'GitHub',
  'gitlab.com': 'GitLab',
  'bitbucket.org': 'Bitbucket',
  'codeberg.org': 'Codeberg',
};

/** "GitHub" for git@github.com:you/app.git or https://github.com/you/app; null for folders and other hosts. */
export function remoteHostName(remote: string) {
  const host =
    /^[\w.-]+@([\w.-]+):/.exec(remote)?.[1] ??
    (() => {
      try {
        return new URL(remote).hostname;
      } catch {
        return '';
      }
    })();
  return KNOWN[host.toLowerCase()] ?? null;
}
