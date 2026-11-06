'use client';
import { useState } from 'react';
import { useLocation, useSearchParams } from 'react-flight-router/client';
import { Group, Head, Icon, IconButton, Setting, Tabs, Banner } from '@/components/ui';
import { useData } from '../projects/data';
import { useCoordinatorName } from '../data/hooks';
import './packages.css';
const base = '/dashboard/packages';
const packagePath = (name: string) => base + '/npm/' + encodeURIComponent(name);
const date = (value: string) =>
  new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
function Header({
  title,
  subtitle,
  project,
}: {
  title: string;
  subtitle?: string;
  project?: { id: string } | null;
}) {
  return (
    <Head
      title={title}
      subtitle={subtitle}
      menu={
        <IconButton
          icon="menu"
          label="Show sidebar"
          className="dl-menu-btn"
          onClick={() => window.dispatchEvent(new Event('deploy:v2-sidebar'))}
        />
      }
      actions={
        project ? (
          <a className="dl-btn secondary" href={'/dashboard/projects/' + project.id}>
            Open project
          </a>
        ) : undefined
      }
    />
  );
}
export default function Packages() {
  const { pathname } = useLocation();
  const [search] = useSearchParams();
  const name = pathname.startsWith(base + '/npm/')
    ? decodeURIComponent(pathname.slice((base + '/npm/').length))
    : null;
  return name ? (
    <PackagePage key={name} name={name} />
  ) : (
    <PackageList setup={search.get('tab') === 'setup'} />
  );
}
function PackageList({ setup }: { setup: boolean }) {
  const { data, error } = useData<any>('/api/v2/packages');
  return (
    <>
      <Header title="Packages" />
      <div className="dl-scroll">
        <div className="dl-page packages-page">
          <Tabs
            value={setup ? base + '?tab=setup' : base}
            items={[
              { label: 'Private', href: base, count: data?.packages.length },
              { label: 'Set up', href: base + '?tab=setup' },
            ]}
          />
          {error && <Banner kind="danger" title={error} />}
          {setup ? (
            <Setup />
          ) : (
            <>
              <Group>
                {data?.packages.map((pkg: any) => (
                  <a className="dl-item" href={packagePath(pkg.name)} key={pkg.id}>
                    <span className="dl-glyph plain">
                      <Icon name="package" size={12} />
                    </span>
                    <span className="dl-t">
                      <span className="dl-mono">{pkg.name}</span>
                      <span>
                        npm · {pkg.latest?.version} · from {pkg.project || pkg.created_by} ·
                        published by {pkg.latest?.publishedByYou ? 'you' : pkg.latest?.publishedBy}
                        {pkg.latest ? ', ' + date(pkg.latest.createdAt) : ''}
                      </span>
                    </span>
                    <span className="dl-c packages-count">
                      Used by {pkg.usedBy} {pkg.usedBy === 1 ? 'project' : 'projects'}
                    </span>
                    <span className="dl-chev">
                      <Icon name="chevron" size={14} />
                    </span>
                  </a>
                ))}
              </Group>
              <p className="dl-list-note">
                Only people signed in to deploy.local and its computers can install these. A version
                can be deprecated, never replaced.
              </p>
            </>
          )}
        </div>
      </div>
    </>
  );
}
function Setup() {
  const coordinator = useCoordinatorName();
  return (
    <>
      <section className="dl-section">
        <h2 className="dl-section-title">On your computer</h2>
        <Group>
          <div className="dl-inset">
            <Setting
              label="Sign in npm and pnpm"
              description={`Makes a package key from your deploy.local sign-in and trusts ${coordinator}’s certificate`}
            >
              <span className="dl-mono">deploy packages login</span>
            </Setting>
            <Setting
              label="Publish by hand"
              description="From the package’s folder, for a package with no pipeline"
            >
              <span className="dl-mono">deploy packages publish</span>
            </Setting>
          </div>
        </Group>
      </section>
      <section className="dl-section">
        <h2 className="dl-section-title">In a project</h2>
        <Group>
          <div className="dl-inset">
            <Setting
              label="Install from deploy.local"
              description="Writes this file. Commit it and everyone who clones the project installs from here."
            >
              <span className="dl-mono">deploy packages use</span>
            </Setting>
          </div>
        </Group>
        <pre className="dl-term">
          <span className="dl-muted"># .npmrc</span>
          {'\nregistry=https://deploy.local/npm/'}
        </pre>
        <p className="dl-list-note">
          Once it’s committed, anyone who can’t reach deploy.local can’t install the project,
          including you when you’re away from {coordinator}.{' '}
          <span className="dl-mono">deploy packages use --off</span> removes it. The file holds no
          key.
        </p>
      </section>
    </>
  );
}
function PackagePage({ name }: { name: string }) {
  const path = '/api/v2/packages/npm/' + encodeURIComponent(name);
  const { data, error } = useData<any>(path);
  const [all, setAll] = useState(false);
  const [allProjects, setAllProjects] = useState(false);
  const extra = data?.usedBy.slice(3) || [];
  const groupExtra =
    !allProjects &&
    extra.length > 1 &&
    extra.every((project: any) => project.versions.join(',') === extra[0].versions.join(','));
  return (
    <>
      <Header
        title={name}
        subtitle={
          'npm package' +
          (data?.project
            ? ' · from ' + data.project.name + (data.directory ? ', ' + data.directory : '')
            : '')
        }
        project={data?.project}
      />
      <div className="dl-scroll">
        <div className="dl-page packages-detail">
          {error && <Banner kind="danger" title={error} />}
          <section className="dl-section">
            <h2 className="dl-section-title">Install</h2>
            <Group>
              <div className="dl-inset">
                <Setting
                  label="Add it to a project"
                  description="Projects set up for deploy.local find it with no other changes"
                >
                  <span className="dl-mono">pnpm add {name}</span>
                  <IconButton
                    icon="copy"
                    label="Copy"
                    onClick={() => void navigator.clipboard.writeText('pnpm add ' + name)}
                  />
                </Setting>
                <Setting label="Registry" description="Where npm, pnpm and Yarn fetch it from">
                  <span className="dl-mono">https://deploy.local/npm/</span>
                </Setting>
              </div>
            </Group>
          </section>
          <section className="dl-section">
            <h2 className="dl-section-title">Versions</h2>
            <Group>
              <div className="dl-inset">
                {data?.versions.slice(0, all ? undefined : 3).map((version: any) => (
                  <Setting
                    key={version.version}
                    label={<span className="dl-mono">{version.version}</span>}
                    description={
                      <>
                        {version.publishedVia === 'import'
                          ? 'Brought over from npmjs.org'
                          : 'Published by ' +
                            (version.publishedByYou ? 'you' : version.publishedBy)}{' '}
                        · {date(version.createdAt)}
                        {version.deprecated ? ' · ' + version.deprecated : ''}
                      </>
                    }
                  >
                    {data.tags
                      .filter((tag: any) => tag.version === version.version)
                      .map((tag: any) => (
                        <span key={tag.tag} className="dl-tag">
                          {tag.tag}
                        </span>
                      ))}
                  </Setting>
                ))}
                {!all && data?.versions.length > 3 && (
                  <button className="dl-item" onClick={() => setAll(true)}>
                    <span className="dl-t">All {data.versions.length} versions</span>
                    <Icon name="chevron" />
                  </button>
                )}
              </div>
            </Group>
          </section>
          <section className="dl-section">
            <h2 className="dl-section-title">Used by</h2>
            <Group>
              {data?.usedBy.slice(0, groupExtra ? 3 : undefined).map((project: any) => (
                <a key={project.id} href={'/dashboard/projects/' + project.id} className="dl-item">
                  <span className="dl-glyph plain">
                    <Icon name="folder" size={12} />
                  </span>
                  <span className="dl-t">
                    <span>{project.name}</span>
                    <span>
                      {project.sameRepository
                        ? 'Same repository · always the version on main'
                        : 'From its lockfile on main'}
                    </span>
                  </span>
                  <span className="dl-c packages-count dl-mono">{project.versions.join(', ')}</span>
                  <span className="dl-chev">
                    <Icon name="chevron" size={14} />
                  </span>
                </a>
              ))}
              {groupExtra && (
                <button className="dl-item" onClick={() => setAllProjects(true)}>
                  <span className="dl-t">
                    <span>
                      {extra
                        .slice(0, -1)
                        .map((project: any) => project.name)
                        .join(', ')}{' '}
                      and {extra.at(-1).name}
                    </span>
                    <span>From their lockfiles on main</span>
                  </span>
                  <span className="dl-c packages-count dl-mono">
                    {extra[0].versions.join(', ')}
                  </span>
                  <span className="dl-chev">
                    <Icon name="chevron" size={14} />
                  </span>
                </button>
              )}
            </Group>
            <p className="dl-list-note">
              Projects update when someone merges the change. deploy.local does not open pull
              requests for new versions.
            </p>
          </section>
        </div>
      </div>
    </>
  );
}
