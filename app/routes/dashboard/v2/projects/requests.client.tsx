'use client';
import { appWarning } from '../computers/traffic';
import { useSince } from '../computers/diagnostics.client';
import { useProjectFormatting } from './formatting.ts';
import { useEffect, useState, type PointerEvent } from 'react';
import { useRouter, useSearchParams } from 'react-flight-router/client';
import {
  Action,
  Banner,
  Empty,
  Group,
  Icon,
  Item,
  Seg,
  Setting,
  Skeleton,
  Status,
  Term,
} from '@/components/ui';
import { useData } from './data';
import { projectSegment } from './routing';
import {
  chartBucket,
  chartKeyBucket,
  errorRateLine,
  formatBytes,
  formatCount,
  formatDuration,
  pathLine,
  rangeWords,
  requestRanges,
  requestShows,
  requestsHref,
  savedText,
  type RequestDetail,
  type RequestList,
  type RequestRange,
  type RequestShow,
  type RequestSummary,
} from './requests';

const api = (app: string) => `/api/apps/${projectSegment(app)}/requests`;

function StatusCode({ status, children }: { status: number; children?: string }) {
  return status >= 500 ? (
    <Status kind="failed">{children ?? String(status)}</Status>
  ) : (
    <>{children ?? status}</>
  );
}

function Chart({ summary }: { summary: RequestSummary }) {
  const { chartReadout, chartTicks, peakWhen } = useProjectFormatting();
  const points = summary.series.points;
  const [bucket, setBucket] = useState<number | null>(null);
  const selectedPoint = bucket === null ? undefined : points[bucket];
  const clearBucket = () => setBucket(null);
  const pointAt = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    ) {
      clearBucket();
      return;
    }
    setBucket(chartBucket((event.clientX - bounds.left) / bounds.width, points.length));
  };
  const top = Math.max(1, ...points.map((point) => point.perMinute));
  const x = (index: number) => (points.length > 1 ? (index / (points.length - 1)) * 800 : 0);
  const y = (value: number) => 138 - (value / top) * 128;
  const line = (value: (point: (typeof points)[number]) => number) =>
    points.map((point, index) => `${index ? 'L' : 'M'}${x(index)} ${y(value(point))}`).join(' ');
  const span = summary.to - summary.from;
  return (
    <div className="dl-stat v2-requests-chart">
      <span className="v2-requests-legend">
        <span className="dl-meta">
          <span className="v2-requests-key" />
          Requests a minute
        </span>
        <span className="dl-meta">
          <span className="v2-requests-key error" />
          Server errors
        </span>
        <span
          className={selectedPoint || summary.peak ? 'dl-meta v2-requests-peak' : 'dl-sr'}
          aria-live="polite"
        >
          {selectedPoint
            ? chartReadout(selectedPoint)
            : summary.peak
              ? `Peak ${formatCount(summary.peak.perMinute)} a minute ${peakWhen(summary.peak.at)}`
              : ''}
        </span>
      </span>
      <svg
        viewBox="0 0 800 140"
        preserveAspectRatio="none"
        width="100%"
        height="140"
        role="img"
        aria-label={`Requests and server errors over ${rangeWords(summary.range)}`}
        tabIndex={0}
        onPointerDown={pointAt}
        onPointerMove={pointAt}
        onPointerLeave={clearBucket}
        onPointerCancel={clearBucket}
        onPointerUp={(event) => {
          if (event.pointerType === 'touch') clearBucket();
        }}
        onBlur={clearBucket}
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(event.key)) return;
          event.preventDefault();
          setBucket((current) => chartKeyBucket(event.key, current, points.length));
        }}
      >
        <path d="M0 20H800M0 60H800M0 100H800" className="v2-requests-grid" />
        {summary.releases.map((release) => (
          <path
            key={release.id}
            d={`M${((release.at - summary.from) / span) * 800} 0V140`}
            className="v2-requests-release"
          >
            <title>{release.label ?? 'A release'}</title>
          </path>
        ))}
        <path d={line((point) => point.perMinute)} className="v2-requests-line" />
        <path d={line((point) => point.serverErrorsPerMinute)} className="v2-requests-line error" />
        {selectedPoint && bucket !== null && (
          <g aria-hidden="true">
            <path d={`M${x(bucket)} 0V140`} className="v2-requests-guide" />
            <path d={`M${x(bucket)} ${y(selectedPoint.perMinute)}h0`} className="v2-requests-dot" />
            <path
              d={`M${x(bucket)} ${y(selectedPoint.serverErrorsPerMinute)}h0`}
              className="v2-requests-dot error"
            />
          </g>
        )}
      </svg>
      <span className="v2-requests-ticks">
        {chartTicks(summary.from, summary.to, summary.range).map((tick, index) => (
          <span key={index} className="dl-meta">
            {tick}
          </span>
        ))}
      </span>
    </div>
  );
}

/** The Requests tab of a web app: volume, errors, slow paths and every request. */
export function AppRequests({
  app,
  address,
  base,
}: {
  app: string;
  address?: string;
  base: string;
}) {
  const { errorsLine, formatRowTime } = useProjectFormatting();
  const [params] = useSearchParams();
  const { navigate } = useRouter();
  const range = (
    requestRanges.some((entry) => entry.value === params.get('range')) ? params.get('range') : '24h'
  ) as RequestRange;
  const show = (
    requestShows.some((entry) => entry.value === params.get('show')) ? params.get('show') : 'all'
  ) as RequestShow;
  const path = params.get('path') ?? '';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const go = (next: { range?: RequestRange; path?: string; show?: RequestShow; page?: number }) =>
    navigate(requestsHref(base, { range, path, show, ...next }), { replace: true });
  const summary = useData<RequestSummary>(`${api(app)}/summary?range=${range}`);
  const list = useData<RequestList>(
    `${api(app)}?range=${range}&show=${show}&page=${page}&path=${encodeURIComponent(path)}`,
  );
  const [filter, setFilter] = useState(path);
  useEffect(() => setFilter(path), [path]);
  useEffect(() => {
    if (filter === path) return;
    const timer = setTimeout(
      () => navigate(requestsHref(base, { range, path: filter, show }), { replace: true }),
      300,
    );
    return () => clearTimeout(timer);
  }, [filter, path, base, range, show, navigate]);
  const data = summary.data;
  const since = useSince();
  const warning = data?.repeating ? appWarning(data.repeating, since) : null;
  const link = (options: { path: string; show?: RequestShow }) =>
    `${requestsHref(base, { range, ...options })}#every-request`;
  const rows = list.data?.rows ?? [];
  const first = list.data && list.data.total ? (list.data.page - 1) * list.data.pageSize + 1 : 0;
  const last = list.data ? first + rows.length - (rows.length ? 1 : 0) : 0;
  return (
    <>
      <div className="dl-page-head v2-requests-head">
        <div className="dl-t">
          <span className="dl-meta">
            Every request to {address ? new URL(address).host : app}, kept for 90 days
          </span>
        </div>
        <span className="dl-end">
          <Seg
            label="Time range"
            value={range}
            options={requestRanges}
            onChange={(value) => go({ range: value as RequestRange, page: 1 })}
          />
        </span>
      </div>
      {summary.error && (
        <Banner
          title="Requests are unavailable"
          action={<Action onClick={summary.refresh}>Retry</Action>}
        >
          {summary.error}
        </Banner>
      )}
      {!data && !summary.error && <Skeleton rows={3} />}
      {warning && (
        <Banner title={warning.title} icon="update">
          {warning.text}
        </Banner>
      )}
      {data && (
        <>
          <div className="dl-stats v2-requests-stats">
            <div className="dl-stat">
              <span className="dl-meta">Requests</span>
              <span className="dl-v">{formatCount(data.total)}</span>
              <span className="dl-meta">{formatCount(data.perMinuteNow)} a minute now</span>
            </div>
            <div className="dl-stat">
              <span className="dl-meta">Server errors</span>
              <span className={`dl-v ${data.serverErrors ? 'v2-requests-bad' : ''}`}>
                {formatCount(data.serverErrors)}
              </span>
              <span className="dl-meta">{errorRateLine(data)}</span>
            </div>
            <div className="dl-stat">
              <span className="dl-meta">p95 response</span>
              <span className="dl-v">{data.total ? formatDuration(data.p95) : 'None'}</span>
              <span className="dl-meta">
                {data.total ? `Median ${formatDuration(data.p50)}` : 'No requests yet'}
              </span>
            </div>
            <div className="dl-stat">
              <span className="dl-meta">Data sent</span>
              <span className="dl-v">{formatBytes(data.sentBytes)}</span>
              <span className="dl-meta">{formatBytes(data.receivedBytes)} received</span>
            </div>
          </div>
          <section className="dl-section">
            <h2 className="dl-section-title">Requests and server errors</h2>
            <p className="dl-section-sub">{errorsLine(data)}</p>
            <Chart key={`${data.from}:${data.to}`} summary={data} />
          </section>
          <div className="dl-cols">
            <section className="dl-section">
              <h2 className="dl-section-title">Slowest paths</h2>
              <p className="dl-section-sub">By p95 response time</p>
              <Group>
                {data.slowest.map((entry) => (
                  <Item
                    key={`${entry.method} ${entry.path}`}
                    title={
                      <span className="dl-mono dl-truncate">{`${entry.method} ${entry.path}`}</span>
                    }
                    description={`${formatCount(entry.count)} request${entry.count === 1 ? '' : 's'}${
                      entry.noAnswer ? ` · ${formatCount(entry.noAnswer)} got no answer` : ''
                    }`}
                    end={formatDuration(entry.p95)}
                    href={link({ path: entry.filter })}
                  />
                ))}
                {!data.slowest.length && <Item title={`No requests in ${rangeWords(range)}`} />}
              </Group>
            </section>
            <section className="dl-section">
              <h2 className="dl-section-title">Most server errors</h2>
              <p className="dl-section-sub">
                {formatCount(data.serverErrors)} in {rangeWords(range)}
              </p>
              <Group>
                {data.errorPaths.map((entry) => (
                  <Item
                    key={`${entry.method} ${entry.path}`}
                    title={
                      <span className="dl-mono dl-truncate">{`${entry.method} ${entry.path}`}</span>
                    }
                    description={`${entry.status}${entry.reason ? ` · ${entry.reason}` : ''}`}
                    end={formatCount(entry.count)}
                    href={link({ path: entry.filter, show: 'server' })}
                  />
                ))}
                {!data.errorPaths.length && <Item title="No server errors" />}
              </Group>
            </section>
          </div>
        </>
      )}
      <section className="dl-section" id="every-request">
        <h2 className="dl-section-title">Every request</h2>
        <p className="dl-section-sub">
          Newest first. Open one to see who sent it and, for server errors, what was sent and what
          came back.
        </p>
        <div className="v2-requests-filters">
          <label className="dl-field">
            <Icon name="search" />
            <input
              type="text"
              placeholder="Filter by path, like /api/workouts"
              aria-label="Filter by path"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </label>
          <Seg
            label="Show"
            value={show}
            options={requestShows}
            onChange={(value) => go({ show: value as RequestShow, page: 1 })}
          />
        </div>
        {list.error && (
          <Banner
            title="The list is unavailable"
            action={<Action onClick={list.refresh}>Retry</Action>}
          >
            {list.error}
          </Banner>
        )}
        {!list.data && !list.error && <Skeleton rows={5} />}
        {list.data && !rows.length && (
          <Empty title={`No requests in ${rangeWords(range)}`}>
            {path || show !== 'all' ? 'Nothing matches this filter.' : undefined}
          </Empty>
        )}
        {list.data && rows.length > 0 && (
          <>
            <div className="dl-group dl-table-wrap">
              <table className="dl-table v2-requests-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th className="v2-requests-wide">Request</th>
                    <th>Status</th>
                    <th className="v2-requests-num">Took</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td>{formatRowTime(row.at)}</td>
                      <td className="dl-name v2-requests-wide">
                        <a className="dl-mono" href={`${base}/${row.id}`}>
                          {`${row.method} ${row.path}${row.query ?? ''}`}
                        </a>
                      </td>
                      <td>
                        <StatusCode status={row.status} />
                      </td>
                      <td className="v2-requests-num">
                        {formatDuration(row.duration, row.duration >= 1000)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="v2-requests-pages">
              <span className="dl-meta">
                {formatCount(first)}–{formatCount(last)} of {formatCount(list.data.total)}
              </span>
              <span className="dl-end">
                <Action disabled={page <= 1} onClick={() => go({ page: page - 1 })}>
                  Newer
                </Action>
                <Action disabled={last >= list.data.total} onClick={() => go({ page: page + 1 })}>
                  Older
                </Action>
              </span>
            </div>
          </>
        )}
      </section>
    </>
  );
}

/** One request opened: who sent it and, for a server error, what was sent and what came back. */
export function AppRequest({
  app,
  detail,
  base,
  logs,
}: {
  app: string;
  detail: { data?: RequestDetail; error: string; refresh: () => void };
  base: string;
  logs: string;
}) {
  const { formatRequestTime } = useProjectFormatting();
  if (detail.error)
    return (
      <Banner
        title="This request is unavailable"
        action={<Action onClick={detail.refresh}>Retry</Action>}
      >
        {detail.error}
      </Banner>
    );
  if (!detail.data) return <Skeleton rows={4} />;
  const { request, capture, path } = detail.data;
  const seconds = Math.floor(request.duration / 1000);
  const failure =
    request.failure === 'timeout'
      ? {
          title: `${app} did not answer within ${seconds} s`,
          text: 'deploy.local stopped waiting and sent a 502.',
          back: `Nothing. ${app} kept the connection open for ${seconds} s without sending headers.`,
        }
      : request.failure === 'refused'
        ? {
            title: `${app} refused the connection`,
            text: 'deploy.local could not reach it and sent a 502.',
            back: `Nothing. ${app} refused the connection.`,
          }
        : request.failure === 'error'
          ? {
              title: `The connection to ${app} failed`,
              text: 'deploy.local sent a 502.',
              back: `Nothing. The connection to ${app} failed.`,
            }
          : null;
  const target = `${request.method} ${request.path}${request.query ?? ''}`;
  return (
    <>
      <div className="dl-page-head">
        <div className="dl-t">
          <h1 className="dl-title v2-request-title">{target}</h1>
          <span className="dl-meta v2-request-meta">
            <StatusCode status={request.status}>
              {`${request.status}${request.reason ? ` · ${request.reason}` : ''}`}
            </StatusCode>
            {formatRequestTime(request.at)}
            {request.release && (
              <>
                {' · release '}
                <span className="dl-mono">{request.release}</span>
              </>
            )}
          </span>
        </div>
        <span className="dl-end">
          <a className="dl-btn secondary" href={logs}>
            Logs
          </a>
        </span>
      </div>
      {failure && (
        <Banner title={failure.title} icon="attention">
          {failure.text} The app's own error, if it logged one, is in Logs.
        </Banner>
      )}
      <section className="dl-section">
        <h2 className="dl-section-title">Who sent it</h2>
        <Group>
          <Setting label="From">
            <span className="dl-mono">{request.ip || 'Unavailable'}</span>
          </Setting>
          {request.username && <Setting label="Signed in as">{request.username}</Setting>}
          {request.browser && <Setting label="Browser">{request.browser}</Setting>}
          {request.referrer && (
            <Setting label="Came from">
              <span className="dl-mono dl-truncate">
                {request.referrer.replace(/^https?:\/\//, '')}
              </span>
            </Setting>
          )}
        </Group>
      </section>
      {request.status >= 500 && capture && (
        <>
          <section className="dl-section">
            <h2 className="dl-section-title">What was sent</h2>
            <p className="dl-section-sub">
              Saved because it ended in a server error. Kept for 14 days; cookies and authorization
              headers are hidden.
            </p>
            <Term className="wrap">{savedText(target, capture.request)}</Term>
          </section>
          <section className="dl-section">
            <h2 className="dl-section-title">What came back</h2>
            <Term className="wrap">
              {capture.response
                ? savedText(String(request.status), capture.response)
                : (failure?.back ?? 'Nothing.')}
            </Term>
          </section>
        </>
      )}
      {request.status >= 500 && !capture && (
        <section className="dl-section">
          <h2 className="dl-section-title">What was sent</h2>
          <p className="dl-section-sub">
            Not saved. deploy.local saves up to 30 server errors a minute for each app and keeps
            them for 14 days.
          </p>
        </section>
      )}
      <section className="dl-section">
        <h2 className="dl-section-title">This path in the last 24 hours</h2>
        <Group>
          <Item
            title={
              <span className="dl-mono dl-truncate">{`${request.method} ${request.path}`}</span>
            }
            description={pathLine(path)}
            end={`All ${formatCount(path.count)}`}
            href={`${requestsHref(base, { path: request.path })}#every-request`}
          />
        </Group>
      </section>
    </>
  );
}
