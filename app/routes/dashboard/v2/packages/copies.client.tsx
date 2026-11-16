'use client';
import { bytes, count, keptPath } from './kept-model';
import { useEffect, useRef } from 'react';
import { Banner, Group, Icon, Setting } from '@/components/ui';
import { useData } from '../projects/data';
import { useCoordinatorName } from '../data/hooks';
import { useProjectFormatting } from '../projects/formatting';
export function Copies() {
  const { now, localeDate, formatTime } = useProjectFormatting();
  const date = (value: string) =>
    localeDate(value, { month: 'short', day: 'numeric' }, false, 'en-US');
  const { data, error, refresh } = useData<any>('/api/packages/cache');
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    const timer = setInterval(() => refreshRef.current(), 60000);
    return () => clearInterval(timer);
  }, []);
  const coordinator = useCoordinatorName();
  const problems = data?.projects.filter((p: any) => p.missing || p.removed.length) || [];
  const ready =
    data?.projects.filter((p: any) => !p.missing && !p.removed.length && p.checkedAt) || [];
  const names =
    ready
      .slice(0, 3)
      .map((p: any) => p.name)
      .join(', ') + (ready.length > 3 ? ` and ${ready.length - 3} more` : '');
  const storage = data?.storage;
  const kept = data?.kept;
  if (!data)
    return error ? (
      <Banner kind="danger" title={error} />
    ) : (
      <p className="dl-list-note">Counting…</p>
    );
  return (
    <>
      {error && <Banner kind="danger" title={error} />}
      {data.sources
        .filter((s: any) => !s.reachable)
        .map((s: any) => (
          <Banner
            key={s.name}
            title={`${s.name} can’t be reached`}
          >{`Since ${formatTime(s.downSince, 'clock')}. Installs use deploy.local’s copies, and anything missing below has to wait. deploy.local tries again every minute.`}</Banner>
        ))}
      <section className="dl-section">
        <h2 className="dl-section-title">Sources</h2>
        <Group>
          <div className="dl-inset">
            {data.sources.map((source: any) => (
              <Setting
                key={source.name}
                label={source.name}
                description={
                  source.reachable
                    ? 'Checked ' +
                      (source.checkedAt
                        ? Math.max(1, Math.floor((now - Date.parse(source.checkedAt)) / 60000)) +
                          ' min ago'
                        : 'just now')
                    : `${source.copiesServed || 0} installs served from the copy`
                }
              >
                <span className={`dl-status ${source.reachable ? '' : 'attention'}`}>
                  <span className="dl-dot" />
                  {source.reachable ? 'Reachable' : 'Unreachable'}
                </span>
              </Setting>
            ))}
          </div>
        </Group>
      </section>
      <section className="dl-section">
        <h2 className="dl-section-title">Projects</h2>
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
                <span>{names} · every locked package and crate is kept</span>
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
        <h2 className="dl-section-title">What’s kept</h2>
        <Group>
          <div className="dl-inset">
            <Setting
              label={`On ${coordinator}`}
              description={`npm ${bytes(storage.ecosystems.npm || 0)} · Cargo ${bytes(storage.ecosystems.cargo || 0)}`}
            >
              <span>
                {bytes(storage.bytes)} of {bytes(storage.limit)}
              </span>
            </Setting>
            <Setting
              label="Needed by projects"
              description="Locked on main or in a live release. Never removed."
            >
              <span>{bytes(storage.pinned)}</span>
            </Setting>
            {kept.idle.versions ? (
              <a className="dl-setting" href={keptPath + '?time=idle'}>
                <span className="dl-t">
                  <span>Not installed in 30 days</span>
                  <span>{count(kept.idle.versions)} versions no project needs</span>
                </span>
                <span className="dl-v">
                  {bytes(kept.idle.bytes)}
                  <span className="dl-chev">
                    <Icon name="chevron" size={14} />
                  </span>
                </span>
              </a>
            ) : (
              <Setting
                label="Not installed in 30 days"
                description="Everything was installed in the last 30 days"
              >
                <span>{bytes(0)}</span>
              </Setting>
            )}
            <a className="dl-setting" href={keptPath}>
              <span className="dl-t">
                <span>Everything kept</span>
                <span>{count(kept.versions)} versions. Search, sort and filter them.</span>
              </span>
              <span className="dl-v">
                {count(kept.packages)} packages
                <span className="dl-chev">
                  <Icon name="chevron" size={14} />
                </span>
              </span>
            </a>
            <Setting
              label="Removes on its own"
              description="Anything no project needs, once it goes unused this long"
            >
              <span>{storage.days} days</span>
            </Setting>
          </div>
        </Group>
        <p className="dl-list-note">
          This copy isn’t backed up. Anything removed is fetched again the next time something
          installs it.
        </p>
      </section>
    </>
  );
}
