/** The HTTPS address, and the SSH one when this server runs SSH. */
export function cloneAddresses(
  repository: { clonePath?: string; sshClonePath?: string; sshPort?: number | null },
  projectId: string,
  origin: string,
) {
  const base = origin || 'http://localhost';
  const https = new URL(repository.clonePath || `/api/git/${projectId}`, base).href;
  const port = repository.sshPort;
  const ssh =
    port && repository.sshClonePath && origin
      ? `ssh://git@${new URL(origin).hostname}${port === 22 ? '' : `:${port}`}${repository.sshClonePath}`
      : null;
  return { https, ssh };
}

/** The label beside Download ZIP: the branch or tag, or a short commit. */
export function archiveLabel(ref: string) {
  const name = ref.replace(/^refs\/(heads|tags)\//, '');
  return /^[a-f0-9]{40}$/.test(name) ? name.slice(0, 7) : name;
}
