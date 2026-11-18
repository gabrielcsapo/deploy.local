'use client';
import { useSearchParams, useRouter } from 'react-flight-router/client';
import { Action, Banner, Empty, Seg, Skeleton } from '@/components/ui';
import type { RepeatingSender, TrafficResponse } from '../../../../../shared/v2/contracts';
import { useData } from '../projects/data';
import { useProjectFormatting } from '../projects/formatting';
import {
  formatBytes,
  formatCount,
  formatWhen,
  requestRanges,
  type RequestRange,
} from '../projects/requests';
import { sparkPoints } from '../projects/presentation';
import { projectPath, projectSegment } from '../projects/routing';
import { pace, senderName, share, trafficWarnings } from './traffic';

const base = '/dashboard/computers/diagnostics';

/** “since Nov 12 at 7:41 PM”, or “before Nov 10” when it was already going as far back as is read. */
export function useSince() {
  const { now, timeZone } = useProjectFormatting();
  return (sender: RepeatingSender) =>
    sender.sinceOrEarlier
      ? `before ${new Date(sender.since).toLocaleDateString('en-US', { timeZone, month: 'short', day: 'numeric' })}`
      : formatWhen(sender.since, now, false, timeZone);
}

/** Diagnostics → Traffic: everything through deploy.local, by app and by sender. Admins only. */
export function Diagnostics() {
  const [params] = useSearchParams();
  const { navigate } = useRouter();
  const { chartTicks } = useProjectFormatting();
  const since = useSince();
  const range = (
    requestRanges.some((entry) => entry.value === params.get('range')) ? params.get('range') : '24h'
  ) as RequestRange;
  const traffic = useData<TrafficResponse>(`/api/diagnostics/traffic?range=${range}`);
  const data = traffic.data;
  const day = data ? data.sendersWindowMs === 86_400_000 : false;
  const dayRequests =
    data && day && data.range === '24h'
      ? data.requests
      : (data?.repeating.reduce((sum, sender) => sum + sender.requests / sender.appShare, 0) ?? 0);
  const long = !!data && data.to - data.from > data.sendersWindowMs;
  const requestsOf = (app: string) =>
    `${projectPath(data?.apps.find((entry) => entry.name === app)?.project ?? `app:${app}`)}/apps/${projectSegment(app)}/requests`;
  return (
    <>
      <div className="dl-page-head v2-requests-head">
        <div className="dl-t">
          <span className="dl-meta">Everything that came through deploy.local to your apps.</span>
        </div>
        <span className="dl-end">
          <Seg
            label="Time range"
            value={range}
            options={requestRanges}
            onChange={(value) => navigate(`${base}?range=${value}`, { replace: true })}
          />
        </span>
      </div>
      {traffic.error && (
        <Banner
          title="Traffic is unavailable"
          action={<Action onClick={traffic.refresh}>Retry</Action>}
        >
          {traffic.error}
        </Banner>
      )}
      {!data && !traffic.error && <Skeleton rows={4} />}
      {data &&
        trafficWarnings(data, dayRequests, since, formatBytes).map((warning) => (
          <Banner key={warning.key} title={warning.title} icon="update">
            {warning.text}
          </Banner>
        ))}
      {data && (
        <>
          <div className="dl-stats v2-requests-stats">
            <div className="dl-stat">
              <span className="dl-meta">Requests</span>
              <span className="dl-v">{formatCount(data.requests)}</span>
              <span className="dl-meta">{formatCount(data.perMinuteNow)} a minute now</span>
            </div>
            <div className="dl-stat">
              <span className="dl-meta">From one sender</span>
              <span className={`dl-v ${data.repeating.length ? 'v2-traffic-warn' : ''}`}>
                {data.topSender ? share(data.topSender.share) : 'None'}
              </span>
              <span className="dl-meta">
                {data.topSender
                  ? `${senderName(data.topSender)}${long ? ' · last 24 hours' : ''}`
                  : 'No requests yet'}
              </span>
            </div>
            <div className="dl-stat">
              <span className="dl-meta">Data sent</span>
              <span className="dl-v">{formatBytes(data.sentBytes)}</span>
              <span className="dl-meta">
                {formatBytes(data.receivedBytes)} received{long ? ' · last 24 hours' : ''}
              </span>
            </div>
            <div className="dl-stat">
              <span className="dl-meta">Server errors</span>
              <span className={`dl-v ${data.serverErrors ? 'v2-requests-bad' : ''}`}>
                {formatCount(data.serverErrors)}
              </span>
              <span className="dl-meta">
                {data.requests
                  ? `${((100 * data.serverErrors) / data.requests).toFixed(2).replace(/\.?0+$/, '')}%`
                  : 'No requests yet'}
              </span>
            </div>
          </div>
          <section className="dl-section">
            <h2 className="dl-section-title">Requests a minute</h2>
            <p className="dl-section-sub">
              Every app together. A level line through the night is a script, not people.
            </p>
            <div className="dl-stat">
              <svg
                className="dl-spark v2-traffic-chart"
                viewBox="0 0 110 40"
                preserveAspectRatio="none"
                role="img"
                aria-label="Requests a minute over the range"
              >
                <polyline
                  points={sparkPoints(data.series.points.map((point) => point.perMinute))}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
              <span className="v2-traffic-ticks">
                {chartTicks(data.from, data.to, data.range).map((tick, index) => (
                  <span className="dl-meta" key={index}>
                    {tick}
                  </span>
                ))}
              </span>
            </div>
          </section>
          {data.repeating.length > 0 && (
            <section className="dl-section">
              <h2 className="dl-section-title">Repeating senders</h2>
              <p className="dl-section-sub">
                One address asking one route for most of its requests, at a steady pace, for over an
                hour. Counted over the last 24 hours.
              </p>
              <div className="dl-group dl-table-wrap">
                <table className="dl-table v2-traffic-table">
                  <thead>
                    <tr>
                      <th className="dl-name">Sender</th>
                      <th className="v2-traffic-wide">Asks</th>
                      <th className="v2-traffic-num">Requests</th>
                      <th className="v2-traffic-num dl-hide-mid">Of that route</th>
                      <th className="v2-traffic-num dl-hide-mid">Pace</th>
                      <th className="v2-traffic-num">Since</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.repeating.map((sender) => (
                      <tr key={`${sender.app} ${sender.address} ${sender.route}`}>
                        <td className="dl-name">
                          <span className="v2-traffic-two">
                            <span>{senderName(sender)}</span>
                            <span className="dl-meta">
                              {[sender.computer ? sender.address : '', sender.agent]
                                .filter(Boolean)
                                .join(' · ')}
                            </span>
                          </span>
                        </td>
                        <td>
                          <span className="v2-traffic-two">
                            <a href={requestsOf(sender.app)}>{sender.app}</a>
                            <span className="dl-mono dl-meta">{sender.route}</span>
                          </span>
                        </td>
                        <td className="v2-traffic-num">{formatCount(sender.requests)}</td>
                        <td className="v2-traffic-num dl-hide-mid">{share(sender.routeShare)}</td>
                        <td className="v2-traffic-num dl-hide-mid">
                          {pace(sender.perMinute).replace(/^e/, 'E')}
                        </td>
                        <td className="v2-traffic-num">{since(sender)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          <section className="dl-section">
            <h2 className="dl-section-title">By app</h2>
            <p className="dl-section-sub">
              Busiest first. Top sender is the address that sent the most
              {long ? ' in the last 24 hours' : ''}, named when it is one of your computers.
            </p>
            {data.apps.length ? (
              <div className="dl-group dl-table-wrap">
                <table className="dl-table v2-traffic-table">
                  <thead>
                    <tr>
                      <th className="dl-name v2-traffic-wide">App</th>
                      <th className="v2-traffic-num">Requests</th>
                      <th className="v2-traffic-num dl-hide-mid">A minute now</th>
                      <th className="v2-traffic-num dl-hide-mid">Sent</th>
                      <th className="v2-traffic-num">Top sender</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.apps.map((app) => (
                      <tr key={app.name}>
                        <td className="dl-name">
                          <a href={requestsOf(app.name)}>{app.name}</a>
                        </td>
                        <td className="v2-traffic-num">{formatCount(app.requests)}</td>
                        <td className="v2-traffic-num dl-hide-mid">
                          {formatCount(app.perMinuteNow)}
                        </td>
                        <td className="v2-traffic-num dl-hide-mid">
                          {app.sentBytes === null ? '' : formatBytes(app.sentBytes)}
                        </td>
                        <td className="v2-traffic-num">
                          {app.topSender ? (
                            <span className={app.topSender.repeating ? 'dl-warn' : ''}>
                              {senderName(app.topSender)} · {share(app.topSender.share)}
                            </span>
                          ) : (
                            ''
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty title="No apps yet">Traffic shows here once an app is running.</Empty>
            )}
          </section>
        </>
      )}
    </>
  );
}
