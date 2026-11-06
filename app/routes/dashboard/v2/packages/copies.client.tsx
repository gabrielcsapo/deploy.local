'use client';
import { useEffect, useRef } from 'react';
import { Banner, Group, Icon, Setting } from '@/components/ui';
import { useData } from '../projects/data';
import { useCoordinatorName } from '../data/hooks';
const date = (value: string) =>
  new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
export function Copies() {
  const { data, error, refresh } = useData<any>('/api/v2/packages/cache');
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    const timer = setInterval(() => refreshRef.current(), 60000);
    return () => clearInterval(timer);
  }, []);
  const coordinator = useCoordinatorName();
  const source = data?.sources[0];
  const problems = data?.projects.filter((p: any) => p.missing || p.removed.length) || [];
  const ready =
    data?.projects.filter((p: any) => !p.missing && !p.removed.length && p.checkedAt) || [];
  const names =
    ready
      .slice(0, 3)
      .map((p: any) => p.name)
      .join(', ') + (ready.length > 3 ? ` and ${ready.length - 3} more` : '');
  const storage = data?.storage;
  if (!data) return error ? <Banner kind="danger" title={error} /> : null;
  return (
    <>
      {error && <Banner kind="danger" title={error} />}
      {source && !source.reachable && (
        <Banner title="npmjs.org can’t be reached">{`Since ${new Date(source.downSince).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}. Installs use deploy.local’s copies, and anything missing below has to wait. deploy.local tries again every minute.`}</Banner>
      )}
      <section className="dl-section">
        <h2 className="dl-section-title">Sources</h2>
        <Group>
          <div className="dl-inset">
            <Setting
              label="npmjs.org"
              description={
                source?.reachable
                  ? 'Checked ' +
                    (source.checkedAt
                      ? Math.max(
                          1,
                          Math.floor((Date.now() - Date.parse(source.checkedAt)) / 60000),
                        ) + ' min ago'
                      : 'just now')
                  : `${source?.copiesServed || 0} installs served from the copy`
              }
            >
              <span className={`dl-status ${source?.reachable ? '' : 'attention'}`}>
                <span className="dl-dot" />
                {source?.reachable ? 'Reachable' : 'Unreachable'}
              </span>
            </Setting>
          </div>
        </Group>
      </section>
      <section className="dl-section">
        <h2 className="dl-section-title">Packages kept</h2>
        <Group>
          {problems.map((project: any) => (
            <a className="dl-item" href={'/dashboard/projects/' + project.id} key={project.id}>
              <span className="dl-glyph plain">
                <Icon name="folder" size={12} />
              </span>
              <span className="dl-t">
                <span>{project.name}</span>
                <span>
                  {project.removed.length
                    ? `npmjs.org removed ${project.removed[0].name} ${project.removed[0].version} on ${date(project.removed[0].removedAt)} · its lockfile still asks for it`
                    : `${project.missing} npm packages added on main were never fetched · fetches them when npmjs.org is back`}
                </span>
              </span>
              <span className="dl-c packages-count">
                {project.removed.length ? 'Removed' : `${project.missing} missing`}
              </span>
              <span className="dl-chev">
                <Icon name="chevron" size={14} />
              </span>
            </a>
          ))}
          {!!ready.length && (
            <div className="dl-item">
              <span className="dl-glyph plain">
                <Icon name="folder" size={12} />
              </span>
              <span className="dl-t">
                <span>
                  {ready.length} {problems.length ? 'other ' : ''}
                  {ready.length === 1 ? 'project' : 'projects'}
                </span>
                <span>{names} · every locked package is kept</span>
              </span>
            </div>
          )}
        </Group>
        <p className="dl-list-note">
          Checked against each project’s lockfile on main and the release that is live. App builds
          also need their Docker image, which deploy.local doesn’t keep.
        </p>
      </section>
      <section className="dl-section">
        <h2 className="dl-section-title">Storage</h2>
        <Group>
          <div className="dl-inset">
            <Setting
              label={`Kept on ${coordinator}`}
              description="In deploy.local’s data folder, beside its repositories"
            >
              <span>
                {((storage?.bytes || 0) / 1024 ** 3).toFixed(1)} GB of{' '}
                {(storage?.limit || 20 * 1024 ** 3) / 1024 ** 3} GB
              </span>
            </Setting>
            <Setting
              label="Keeps"
              description={`Anything installed in the last ${storage?.days || 90} days, and everything a live release or rollback needs`}
            >
              <span>{storage?.days || 90} days</span>
            </Setting>
          </div>
        </Group>
        <p className="dl-list-note">
          {storage?.pinnedOverLimit
            ? 'Pinned files alone exceed the limit. They are kept. '
            : storage?.pressure
              ? 'Past 90% the oldest unpinned files go first. '
              : ''}
          Private packages are backed up with deploy.local. This copy is not: it can be fetched
          again.
        </p>
      </section>
    </>
  );
}
