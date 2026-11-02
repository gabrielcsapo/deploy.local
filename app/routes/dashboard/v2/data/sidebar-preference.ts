export function sidebarKind(pathname: string) {
  if (pathname === '/dashboard/design') return 'design';
  if (/^\/dashboard\/tasks\/[^/]+\/changes\/?$/.test(pathname)) return 'changes';
  if (/^\/dashboard\/projects\/[^/]+\/code(?:\/|$)/.test(pathname)) return 'code';
  return 'pages';
}

export function sidebarCollapsed(kind: ReturnType<typeof sidebarKind>) {
  try {
    const saved = localStorage.getItem(`deploy.sidebar.${kind}`);
    if (saved === 'true' || saved === 'false') return saved === 'true';
  } catch {
    // Private browsing and server rendering still get the page's default.
  }
  return kind !== 'pages';
}
