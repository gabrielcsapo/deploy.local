import { Link, Outlet, useLocation } from 'react-router';

const NAV = [
  {
    heading: 'Getting Started',
    links: [
      { to: '/docs', label: 'Introduction' },
      { to: '/docs/deploying', label: 'Deploying Apps' },
      { to: '/docs/configuration', label: 'Configuration' },
    ],
  },
  {
    heading: 'Reference',
    links: [
      { to: '/docs/cli', label: 'CLI' },
      { to: '/docs/architecture', label: 'Architecture' },
    ],
  },
];

export default function DocsLayout() {
  const { pathname } = useLocation();

  return (
    <div className="max-w-7xl mx-auto px-6 flex gap-10 py-8">
      <aside className="w-48 shrink-0 max-md:hidden">
        <nav className="sticky top-8">
          {NAV.map((section) => (
            <div key={section.heading}>
              <p className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-3">
                {section.heading}
              </p>
              <ul className="flex flex-col gap-1 mb-6 list-none p-0">
                {section.links.map((link) => (
                  <li key={link.to}>
                    <Link
                      to={link.to}
                      className={`block text-sm px-2 py-1 rounded-md transition-colors no-underline ${
                        pathname === link.to
                          ? 'text-text bg-bg-hover'
                          : 'text-text-secondary hover:text-text hover:bg-bg-hover'
                      }`}
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </aside>
      <main className="flex-1 min-w-0">
        <Outlet />
      </main>
    </div>
  );
}
