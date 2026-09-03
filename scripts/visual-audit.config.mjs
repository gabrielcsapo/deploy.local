export const VISUAL_AUDIT_VIEWPORTS = {
  desktop: { width: 1440, height: 1000 },
  mobile: { width: 390, height: 844, isMobile: true },
};

export const PUBLIC_VISUAL_AUDIT_FLOWS = [
  { id: 'public/home', title: 'Homepage', path: '/', session: 'anonymous' },
  {
    id: 'public/home-away',
    title: 'Homepage · Suitcase away',
    path: '/',
    session: 'anonymous',
    action: 'select-public-cloud-mode',
    actionValue: 'away',
  },
  {
    id: 'public/home-rejoining',
    title: 'Homepage · Suitcase rejoining',
    path: '/',
    session: 'anonymous',
    action: 'select-public-cloud-mode',
    actionValue: 'rejoining',
  },
  { id: 'public/discover', title: 'Public app discovery', path: '/discover', session: 'anonymous' },
  { id: 'public/changelog', title: 'Changelog', path: '/changelog', session: 'anonymous' },
  { id: 'docs/index', title: 'Documentation index', path: '/docs', session: 'anonymous' },
  {
    id: 'docs/mobile-navigation',
    title: 'Documentation mobile navigation',
    path: '/docs',
    session: 'anonymous',
    action: 'open-docs-navigation',
    viewports: ['mobile'],
  },
  { id: 'docs/deploying', title: 'Deploying guide', path: '/docs/deploying', session: 'anonymous' },
  {
    id: 'docs/configuration',
    title: 'Configuration guide',
    path: '/docs/configuration',
    session: 'anonymous',
  },
  { id: 'docs/managing', title: 'Managing guide', path: '/docs/managing', session: 'anonymous' },
  { id: 'docs/nodes', title: 'Nodes guide', path: '/docs/nodes', session: 'anonymous' },
  { id: 'docs/cli', title: 'CLI reference', path: '/docs/cli', session: 'anonymous' },
  {
    id: 'docs/architecture',
    title: 'Architecture guide',
    path: '/docs/architecture',
    session: 'anonymous',
  },
  { id: 'docs/roadmap', title: 'Roadmap', path: '/docs/roadmap', session: 'anonymous' },
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
  {
    id: 'operator/home-search',
    title: 'Homepage · cloud search',
    path: '/',
    action: 'open-home-search',
  },
  { id: 'dashboard/command-center', title: 'Command center', path: '/dashboard' },
  {
    id: 'dashboard/topology-zoom',
    title: 'Command center · trackpad zoom',
    path: '/dashboard',
    action: 'zoom-topology',
    viewports: ['desktop'],
  },
  {
    id: 'dashboard/signal-serving',
    title: 'Command center · serving detail',
    path: '/dashboard',
    action: 'open-signal-detail',
    actionValue: 'serving',
    viewports: ['desktop'],
  },
  {
    id: 'dashboard/signal-flow',
    title: 'Command center · request flow detail',
    path: '/dashboard',
    action: 'open-signal-detail',
    actionValue: 'flow',
    viewports: ['desktop'],
  },
  {
    id: 'dashboard/signal-health',
    title: 'Command center · request health detail',
    path: '/dashboard',
    action: 'open-signal-detail',
    actionValue: 'health',
  },
  {
    id: 'dashboard/signal-headroom',
    title: 'Command center · headroom detail',
    path: '/dashboard',
    action: 'open-signal-detail',
    actionValue: 'headroom',
    viewports: ['desktop'],
  },
  {
    id: 'dashboard/signal-continuity',
    title: 'Command center · continuity detail',
    path: '/dashboard',
    action: 'open-signal-detail',
    actionValue: 'continuity',
    viewports: ['desktop'],
  },
  {
    id: 'dashboard/command-palette',
    title: 'Command palette',
    path: '/dashboard',
    action: 'open-command-palette',
  },
  { id: 'dashboard/apps', title: 'Application inventory', path: '/dashboard/apps' },
  { id: 'dashboard/sites', title: 'Sites and suitcases', path: '/dashboard/sites' },
  { id: 'dashboard/machines', title: 'Machines', path: '/dashboard/nodes' },
  { id: 'dashboard/catalog', title: 'One-click catalog', path: '/dashboard/catalog' },
  {
    id: 'dashboard/catalog-import',
    title: 'Compose catalog import',
    path: '/dashboard/catalog/import',
  },
  { id: 'dashboard/activity', title: 'Fleet activity', path: '/dashboard/activity' },
  { id: 'dashboard/logs', title: 'Fleet logs', path: '/dashboard/logs' },
  { id: 'dashboard/discover', title: 'Shared applications', path: '/dashboard/discover' },
  { id: 'dashboard/settings', title: 'Server settings', path: '/dashboard/settings' },
];

export function commandCenterInteractionFlows(applicationName) {
  if (!applicationName) return [];
  return [
    {
      id: `dashboard/application-inspector/${applicationName}`,
      title: `${applicationName} inspector`,
      path: '/dashboard',
      action: 'select-application',
      applicationName,
    },
    {
      id: `dashboard/application-traffic/${applicationName}`,
      title: `${applicationName} traffic inspector`,
      path: '/dashboard',
      action: 'select-application-traffic',
      applicationName,
    },
    {
      id: `dashboard/application-configuration/${applicationName}`,
      title: `${applicationName} configuration inspector`,
      path: '/dashboard',
      action: 'select-application-configuration',
      applicationName,
    },
    {
      id: `dashboard/component-inspector/${applicationName}`,
      title: `${applicationName} component inspector`,
      path: '/dashboard',
      action: 'select-component',
      applicationName,
      optional: true,
    },
    {
      id: `dashboard/data-inspector/${applicationName}`,
      title: `${applicationName} durable data inspector`,
      path: '/dashboard',
      action: 'select-resource',
      applicationName,
      optional: true,
    },
  ];
}

export function applicationRouteFlows(applicationName) {
  const encoded = encodeURIComponent(applicationName);
  const root = `/dashboard/${encoded}`;
  return [
    {
      id: `application/${applicationName}/overview`,
      title: `${applicationName} overview`,
      path: root,
    },
    {
      id: `application/${applicationName}/releases`,
      title: `${applicationName} releases`,
      path: `${root}/releases`,
    },
    {
      id: `application/${applicationName}/traffic`,
      title: `${applicationName} traffic`,
      path: `${root}/traffic`,
    },
    {
      id: `application/${applicationName}/data`,
      title: `${applicationName} data`,
      path: `${root}/data`,
    },
    {
      id: `application/${applicationName}/activity`,
      title: `${applicationName} activity`,
      path: `${root}/activity`,
    },
    {
      id: `application/${applicationName}/logs`,
      title: `${applicationName} logs`,
      path: `${root}/logs`,
    },
    {
      id: `application/${applicationName}/terminal`,
      title: `${applicationName} terminal`,
      path: `${root}/terminal`,
    },
    {
      id: `application/${applicationName}/settings`,
      title: `${applicationName} settings`,
      path: `${root}/settings`,
    },
  ];
}

export function catalogDetailFlow(release) {
  if (!release?.id || !release?.release) return [];
  return [
    {
      id: `dashboard/catalog-detail/${release.id}/${release.release}`,
      title: `${release.name || release.id} catalog detail`,
      path: `/dashboard/catalog/${encodeURIComponent(release.id)}/${encodeURIComponent(release.release)}`,
    },
  ];
}
