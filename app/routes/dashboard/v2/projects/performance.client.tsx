'use client';
import { useRouter, useSearchParams } from 'react-flight-router/client';
import { Action, Banner, Group, Icon, Item, Seg, Setting, Skeleton } from '@/components/ui';
import { useData } from './data';
import { projectSegment } from './routing';
import { formatCount, formatWhen } from './requests';
import {
  barPosition,
  errorLocation,
  errorOccurrences,
  performanceHref,
  performanceRange,
  performanceRanges,
  performanceState,
  periodWords,
  percent,
  prefetchRate,
  quietExperience,
  rangeDescription,
  rating,
  releaseEvidence,
  releaseVerdict,
  serverPhases,
  serverSegments,
  seenAgo,
  timing,
  waterfallScale,
  type PageExperience,
  type PerformanceData,
  type PerformanceError,
  type PerformanceRange,
  type PerformanceRoute,
  type TimingSegment,
} from './performance';
import './performance.css';

function Legend() {
  return (
    <div className="dl-waterfall-legend dl-meta" aria-label="Timing colors">
      {serverPhases.map(({ phase, label }) => (
        <span key={phase}>
          <i data-phase={phase} aria-hidden="true" />
          {label}
        </span>
      ))}
    </div>
  );
}
function Axis({ scale }: { scale: number }) {
  return (
    <div className="dl-item" data-axis-labels>
      {[0, scale / 2, scale].map((value) => (
        <span className="dl-meta" key={value}>
          {timing(value)}
        </span>
      ))}
    </div>
  );
}
function TimingBar({
  segments,
  scale,
  marker,
  label,
  tails = false,
}: {
  segments: TimingSegment[];
  scale: number;
  marker?: number | null;
  label: string;
  tails?: boolean;
}) {
  return (
    <span className="dl-bar" role="img" aria-label={label}>
      {segments.map((part) => (
        <span
          key={part.phase}
          data-phase={part.phase}
          title={`${part.label}: ${timing(part.p50)}`}
          style={barPosition(part.start, part.p50, scale)}
        />
      ))}
      {tails &&
        segments
          .filter((part) => part.p95 > part.p50)
          .map((part) => (
            <span
              key={`${part.phase}-tail`}
              data-phase={part.phase}
              data-tail
              style={barPosition(part.start + part.p50, part.p95 - part.p50, scale)}
            />
          ))}
      {marker != null && <i style={{ left: barPosition(marker, 0, scale).left }} />}
    </span>
  );
}
function RouteRow({ route, scale }: { route: PerformanceRoute; scale: number }) {
  const segments = serverSegments(route.phases);
  const summary = (
    <>
      <span className="dl-t">
        <span>{route.route}</span>
        <span className="perf-facts">
          <span>
            {formatCount(route.requests)} {route.requests === 1 ? 'request' : 'requests'}
          </span>
          <span>p50 {timing(route.p50)}</span>
          <span>p95 {timing(route.p95)}</span>
          <span>{percent(route.errorRate)} errors</span>
        </span>
        {segments.length > 0 && (
          <span className="dl-waterfall" data-waterfall="compact">
            <TimingBar
              segments={segments}
              scale={scale}
              marker={route.p95}
              label={`${route.route}: ${segments.map((part) => `${part.label} ${timing(part.p50)}`).join(', ')}; route p95 ${timing(route.p95)}, scale 0 to ${timing(scale)}`}
            />
          </span>
        )}
      </span>
    </>
  );
  if (!segments.length) return <div className="dl-item">{summary}</div>;
  return (
    <details>
      <summary className="dl-item">
        {summary}
        <Icon name="chevron" className="dl-chev" />
      </summary>
      <div className="perf-detail">
        <div className="dl-waterfall" data-waterfall="route">
          <div data-timing-part="server">
            <h3 className="dl-section-title">On the server</h3>
            <Legend />
            <Axis scale={scale} />
            {segments.map((part) => (
              <div className="dl-item" data-timing-row key={part.phase}>
                <span>{part.label}</span>
                <span
                  className="dl-meta"
                  data-duration
                  aria-label={`p50 / p95: ${timing(part.p50)} / ${timing(part.p95)}`}
                >
                  {timing(part.p50)} / {timing(part.p95)}
                </span>
                <TimingBar
                  segments={[part]}
                  scale={scale}
                  tails
                  label={`${part.label}: p50 ${timing(part.p50)}, p95 ${timing(part.p95)}`}
                />
              </div>
            ))}
            <p className="dl-list-note" data-waterfall-note>
              Typical request. The lighter end is where the slowest 5 in 100 finish.
            </p>
          </div>
        </div>
      </div>
    </details>
  );
}
function Rating({
  metric,
  value,
}: {
  metric: 'lcp' | 'inp' | 'cls' | 'ttfb';
  value: number | null;
}) {
  const word = rating(metric, value);
  return (
    <span className={`perf-rating ${word?.toLowerCase().replace(' ', '-') ?? ''}`}>
      {word ?? 'Unavailable'}
    </span>
  );
}
function ExperienceMetrics({ page }: { page: PageExperience }) {
  const prefetch = prefetchRate(page);
  return (
    <>
      <Item
        title={
          <>
            Largest paint <span className="dl-meta">LCP</span>
          </>
        }
        description="Main content appears"
        end={<Rating metric="lcp" value={page.lcp} />}
      />
      <Item
        title={
          <>
            Interaction delay <span className="dl-meta">INP</span>
          </>
        }
        description="Page responds to input"
        end={
          <>
            {timing(page.inp)}
            {page.inp !== null && (
              <>
                {' '}
                · <Rating metric="inp" value={page.inp} />
              </>
            )}
          </>
        }
      />
      <Item
        title={
          <>
            Layout shift <span className="dl-meta">CLS</span>
          </>
        }
        description="Content moves unexpectedly"
        end={
          <>
            {page.cls === null ? 'Unavailable' : Number(page.cls.toFixed(3))}
            {page.cls !== null && (
              <>
                {' '}
                · <Rating metric="cls" value={page.cls} />
              </>
            )}
          </>
        }
      />
      <Item
        title={
          <>
            First byte <span className="dl-meta">TTFB</span>
          </>
        }
        description="Browser starts receiving the page"
        end={<Rating metric="ttfb" value={page.ttfb} />}
      />
      {prefetch !== null && (
        <Item
          title="Already prefetched"
          description="Clicks that found the next page ready"
          end={percent(prefetch)}
        />
      )}
    </>
  );
}
function PageExperiences({ data }: { data: PerformanceData }) {
  if (!data.pageExperience.length) return null;
  if (quietExperience(data))
    return (
      <>
        {data.pageExperience.map((page, index) => (
          <section className="dl-section" key={page.route}>
            <h2 className="dl-section-title">Page experience · {page.route}</h2>
            <Group>
              {index === 0 ? (
                <ExperienceMetrics page={page} />
              ) : (
                <>
                  <Item
                    title="All measured Web Vitals are Good"
                    description={`Largest paint Good · interaction delay ${timing(page.inp)} · layout shift ${page.cls}`}
                  />
                  <Item
                    title={
                      <>
                        First byte <span className="dl-meta">TTFB</span>
                      </>
                    }
                    description="p75"
                    end={<Rating metric="ttfb" value={page.ttfb} />}
                  />
                  {prefetchRate(page) !== null && (
                    <Item
                      title="Already prefetched"
                      description="Clicks that found the next page ready"
                      end={percent(prefetchRate(page))}
                    />
                  )}
                </>
              )}
            </Group>
            {index === 0 && (
              <p className="dl-list-note">
                At p75, 3 in 4 visits are at least this good. Ratings follow Google’s Core Web
                Vitals.
              </p>
            )}
          </section>
        ))}
      </>
    );
  return (
    <section className="dl-section">
      <h2 className="dl-section-title">Page experience</h2>
      <Group>
        {data.pageExperience.map((page) => (
          <details key={page.route}>
            <summary className="dl-item">
              <span className="dl-t">
                <span>{page.route}</span>
                <span>
                  Interaction delay {timing(page.inp)} · layout shift{' '}
                  {page.cls === null ? 'Unavailable' : Number(page.cls.toFixed(3))}
                </span>
              </span>
              <span className="dl-c">
                Largest paint · <Rating metric="lcp" value={page.lcp} />
              </span>
              <Icon name="chevron" className="dl-chev" />
            </summary>
            <div className="perf-detail">
              <Group>
                <ExperienceMetrics page={page} />
              </Group>
            </div>
          </details>
        ))}
      </Group>
      <p className="dl-list-note">Browser ratings are p75. API routes have no page experience.</p>
    </section>
  );
}
function ErrorDetail({ error, from, to }: { error: PerformanceError; from: number; to: number }) {
  const where = errorLocation(error.where);
  const occurrences = errorOccurrences(error, from, to);
  return (
    <>
      <section className="dl-section">
        <h2 className="dl-section-title">This error</h2>
        <Group>
          <Setting label="Where">{where.charAt(0).toUpperCase() + where.slice(1)}</Setting>
          <Setting label="Route">{error.route}</Setting>
          {occurrences !== null && (
            <Setting label="Occurrences" description="In the selected range">
              {formatCount(occurrences)}
            </Setting>
          )}
          <Setting label="First seen" description="Since this group was first recorded">
            {formatWhen(error.firstSeen)}
          </Setting>
          <Setting label="Last seen">{formatWhen(error.lastSeen)}</Setting>
          <Setting label="Fingerprint">
            <span className="dl-mono">{error.fingerprint}</span>
          </Setting>
        </Group>
        <p className="dl-list-note">
          Grouped by fingerprint, so repeated reports of the same error stay together.
        </p>
      </section>
      <section className="dl-section">
        <h2 className="dl-section-title">Latest message</h2>
        <Group>
          <Item
            title={`${error.name}: ${error.message}`}
            description={`${formatWhen(error.lastSeen)}${error.build ? ` · ${error.build}` : ''}`}
          />
        </Group>
      </section>
      {error.stack && (
        <section className="dl-section">
          <h2 className="dl-section-title">Latest stack</h2>
          <pre className="perf-stack">{error.stack}</pre>
        </section>
      )}
    </>
  );
}
function Releases({ releases }: { releases: PerformanceData['releases'] }) {
  if (!releases.length) return null;
  return (
    <section className="dl-section">
      <h2 className="dl-section-title">Releases</h2>
      <Group>
        {releases.map((release) => {
          const verdict = releaseVerdict(release.comparison);
          const evidence = releaseEvidence(release.comparison);
          return (
            <div key={release.id}>
              <Item
                title={`${release.id.slice(0, 7)}${verdict ? ` · ${verdict}` : ''}`}
                description={`${formatWhen(release.at)}${evidence ? ` · ${evidence}` : ''}`}
              />
              {release.comparison?.routes.map((route) => {
                const before = serverSegments(route.before.phases);
                const after = serverSegments(route.after.phases);
                if (!before.length || !after.length) return null;
                const scale = waterfallScale([route.before, route.after]);
                return (
                  <div key={route.route}>
                    <div className="dl-waterfall" data-waterfall="comparison">
                      <Legend />
                      <Axis scale={scale} />
                      {[
                        { label: 'Before', segments: before },
                        { label: 'After', segments: after },
                      ].map(({ label, segments }) => (
                        <div className="dl-item" data-timing-row key={label}>
                          <span className="dl-meta">
                            {label} · {timing(segments.reduce((sum, part) => sum + part.p50, 0))}
                          </span>
                          <TimingBar
                            scale={scale}
                            segments={segments}
                            label={`${label}: ${segments.map((part) => `${part.label} ${timing(part.p50)}`).join(', ')}`}
                          />
                        </div>
                      ))}
                    </div>
                    <p className="dl-list-note" data-waterfall-note>
                      {route.route} · Data loading: {timing(before[1].p50)} → {timing(after[1].p50)}
                      .
                    </p>
                  </div>
                );
              })}
            </div>
          );
        })}
      </Group>
      <p className="dl-list-note">Each release uses the 24 hours before it as its baseline.</p>
    </section>
  );
}

export function PerformanceView({
  app,
  address,
  base,
  range,
  errorId,
  data,
  error,
  refresh,
  onRange,
}: {
  app: string;
  address?: string;
  base: string;
  range: PerformanceRange;
  errorId?: string;
  data?: PerformanceData;
  error: string;
  refresh: () => void;
  onRange: (range: PerformanceRange) => void;
}) {
  const selected = data?.errors.find((entry) => entry.fingerprint === errorId);
  const state = data ? performanceState(data) : undefined;
  const scale = data ? waterfallScale(data.routes) : 1;
  const hasWaterfalls = data?.routes.some((route) => serverSegments(route.phases).length);
  return (
    <div className="v2-performance">
      <div className="dl-page-head">
        <div className="dl-t">
          <h1 className="dl-title">{selected?.message ?? 'Performance'}</h1>
          {selected ? (
            <span className="dl-meta">
              {app} · error group · last {periodWords(range)}
            </span>
          ) : (
            address && <span className="dl-meta">{new URL(address).host}</span>
          )}
        </div>
        {errorId && (
          <a className="dl-btn secondary" href={performanceHref(base, range)}>
            Back to performance
          </a>
        )}
      </div>
      <div className="perf-toolbar">
        {!selected && <span className="dl-meta">{rangeDescription(range)}</span>}
        <Seg
          label="Time range"
          value={range}
          options={performanceRanges}
          onChange={(value) => onRange(value as PerformanceRange)}
        />
      </div>
      {error && (
        <Banner
          title="Performance is unavailable"
          action={<Action onClick={refresh}>Retry</Action>}
        />
      )}
      {!data && !error && (
        <section className="dl-section">
          <h2 className="dl-section-title">Routes</h2>
          <Skeleton rows={5} label="Loading performance" />
        </section>
      )}
      {data && errorId && !selected && <Banner title="This error is unavailable" />}
      {selected ? (
        <ErrorDetail error={selected} from={data!.from} to={data!.to} />
      ) : (
        data && (
          <>
            {state === 'empty' ? (
              <>
                <section className="dl-section">
                  <h2 className="dl-section-title">Routes</h2>
                  <Group>
                    <Item
                      title="Nothing to measure yet"
                      description={`Routes, page experience and errors will appear when requests arrive. No requests in the selected ${periodWords(range)}.`}
                    />
                  </Group>
                  {range !== '7d' && (
                    <p className="dl-list-note">Choose a longer range to see earlier traffic.</p>
                  )}
                </section>
                {range !== '7d' && (
                  <Action onClick={() => onRange(range === '1h' ? '24h' : '7d')}>
                    Show {range === '1h' ? '24 hours' : '7 days'}
                  </Action>
                )}
              </>
            ) : (
              <>
                {state === 'totals' ? (
                  <p className="dl-list-note">
                    react-flight-router 0.13 adds route waterfalls, page experience, grouped errors
                    and release comparisons. Request totals stay in Requests.
                  </p>
                ) : (
                  <>
                    {data.routes.length > 0 && (
                      <section className="dl-section">
                        <h2 className="dl-section-title">Routes</h2>
                        <p className="dl-section-sub">
                          p50 is typical; 95 in 100 requests finish within p95.
                        </p>
                        <Group>
                          {hasWaterfalls && <Legend />}
                          {data.routes.map((route) => (
                            <RouteRow key={route.route} route={route} scale={scale} />
                          ))}
                        </Group>
                        {hasWaterfalls && (
                          <p className="dl-list-note">
                            Typical server time on a 0–{timing(scale)} scale. The marker shows where
                            95 in 100 finish.
                          </p>
                        )}
                      </section>
                    )}
                    <PageExperiences data={data} />
                    <section className="dl-section">
                      <h2 className="dl-section-title">Errors</h2>
                      <Group>
                        {data.errors.length ? (
                          data.errors.map((entry) => {
                            const occurrences = errorOccurrences(entry, data.from, data.to);
                            return (
                              <Item
                                key={entry.fingerprint}
                                title={entry.message}
                                description={`${occurrences === null ? '' : `${formatCount(occurrences)} times · `}${errorLocation(entry.where)} · ${entry.route}`}
                                end={seenAgo(entry.lastSeen)}
                                href={performanceHref(base, range, entry.fingerprint)}
                              />
                            );
                          })
                        ) : (
                          <Item
                            title={`No errors in ${range === '1h' ? 'this hour' : `these ${periodWords(range)}`}`}
                            description={
                              data.summary.requests > 0 && data.pageExperience.length > 0
                                ? 'Requests and browser visits were recorded.'
                                : undefined
                            }
                          />
                        )}
                      </Group>
                      {data.errors.length > 0 && (
                        <p className="dl-list-note">
                          Same errors are grouped together. Browser errors can occur without a
                          failed request.
                        </p>
                      )}
                    </section>
                  </>
                )}
                {state !== 'totals' && <Releases releases={data.releases} />}
              </>
            )}
          </>
        )
      )}
    </div>
  );
}
function PerformanceRead({
  app,
  range,
  ...props
}: {
  app: string;
  range: PerformanceRange;
  address?: string;
  base: string;
  errorId?: string;
  onRange: (range: PerformanceRange) => void;
}) {
  const resource = useData<PerformanceData>(
    `/api/v2/apps/${projectSegment(app)}/performance?range=${range}`,
  );
  return <PerformanceView app={app} range={range} {...props} {...resource} />;
}
export function AppPerformance({
  app,
  address,
  base,
}: {
  app: string;
  address?: string;
  base: string;
}) {
  const [params] = useSearchParams();
  const { navigate } = useRouter();
  const range = performanceRange(params.get('range'));
  const errorId = params.get('error') ?? undefined;
  return (
    <PerformanceRead
      key={`${app}/${range}`}
      app={app}
      address={address}
      base={base}
      range={range}
      errorId={errorId}
      onRange={(next) => navigate(performanceHref(base, next, errorId), { replace: true })}
    />
  );
}
