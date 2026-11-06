export const VISUAL_AUDIT_VIEWPORTS = {
  desktop: { width: 1440, height: 1000 },
  mobile: { width: 375, height: 812, isMobile: true, hasTouch: true },
};

export const PUBLIC_VISUAL_AUDIT_FLOWS = [
  { id: 'public/home', title: 'Homepage', path: '/', session: 'anonymous' },
  { id: 'public/changelog', title: 'Changelog', path: '/changelog', session: 'anonymous' },
  { id: 'docs/index', title: 'Documentation index', path: '/docs', session: 'anonymous' },
  { id: 'docs/cli', title: 'CLI reference', path: '/docs/cli', session: 'anonymous' },
  {
    id: 'docs/architecture',
    title: 'Architecture guide',
    path: '/docs/architecture',
    session: 'anonymous',
  },
  {
    id: 'docs/troubleshooting',
    title: 'Troubleshooting guide',
    path: '/docs/troubleshooting',
    session: 'anonymous',
  },
  { id: 'auth/login', title: 'Operator sign in', path: '/dashboard', session: 'anonymous' },
];

export const DASHBOARD_VISUAL_AUDIT_FLOWS = [
  { id: 'operator/home', title: 'Homepage · signed in', path: '/' },
  { id: 'dashboard/machines', title: 'Computers', path: '/dashboard/computers' },
  { id: 'dashboard/settings', title: 'Server settings', path: '/dashboard/settings' },
  { id: 'dashboard/tasks', title: 'Tasks', path: '/dashboard' },
];
