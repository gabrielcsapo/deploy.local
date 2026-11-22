'use client';
import { Fragment, useMemo, useRef, useState, type CSSProperties } from 'react';
// Keep distinct event offsets visible even when both round to the same whole second.
function formatDuration(ms: number) {
  if (ms >= 1000) return Number((ms / 1000).toFixed(2)) + ' s';
  return Number(ms.toFixed(ms < 10 ? 2 : 0)) + ' ms';
}
import { timeline, visibleRows, type TraceDetail } from './trace-model';
import './request-trace.css';

export function TraceWaterfall({ data }: { data: TraceDetail }) {
  const model = useMemo(() => timeline(data), [data]);
  const [picked, pick] = useState<string>();
  const [focus, setFocus] = useState<string>();
  const [collapsed, collapse] = useState(new Set<string>());
  const [sheet, showSheet] = useState(false);
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const closeButton = useRef<HTMLButtonElement>(null);
  const rows = visibleRows(model, focus, collapsed);
  const root = model.children.get('')?.[0] ?? model.all[0];
  if (!root) return null;
  const selected = model.byId.get(picked ?? '') ?? root;
  const focused = model.byId.get(focus ?? '');
  const start = Math.min(...model.all.map((r) => r.start)),
    end = Math.max(...model.all.map((r) => r.end));
  const origin = focused?.start ?? start,
    range = Math.max(0.001, (focused?.end ?? end) - origin);
  const services = [...new Set(model.all.map((r) => r.service))];
  const colors = ['--ds-accent', '--ds-active', '--ds-success', '--ds-warning'];
  const color = (service: string) =>
    'var(' + colors[services.indexOf(service) % colors.length] + ')';
  const errors = model.all.filter((r) => r.status === 'Error');
  function select(id: string) {
    pick(id);
    showSheet(true);
    if (window.matchMedia('(max-width:760px)').matches)
      requestAnimationFrame(() => closeButton.current?.focus());
  }
  function close() {
    showSheet(false);
    refs.current.get(selected.id)?.focus();
  }
  return (
    <section className="dl-section traceview">
      <div className="tracehead">
        <h2 className="dl-section-title">Trace waterfall</h2>
        <div className="legend">
          {services.map((s) => (
            <span key={s}>
              <i style={{ background: color(s) }} />
              {s}
            </span>
          ))}
        </div>
      </div>
      <div className="tracebox">
        <div className="tracetop">
          <div>
            <strong>{focused?.name ?? root.name}</strong>
            <p>
              {focus ? 'Focused span' : model.partial ? 'Partial trace' : 'Full trace'} ·{' '}
              {rows.length} spans · {formatDuration(range)}
            </p>
          </div>
          <div className="tracetools">
            {focus && (
              <button className="tracebtn" onClick={() => setFocus(undefined)}>
                Full trace
              </button>
            )}
            {errors.length > 0 && (
              <button
                className="tracebtn"
                onClick={() => {
                  setFocus(undefined);
                  collapse(new Set());
                  select(
                    errors[(errors.findIndex((r) => r.id === selected.id) + 1) % errors.length].id,
                  );
                }}
              >
                <b className="erricon">!</b> Next error
              </button>
            )}
          </div>
        </div>
        <div className="tracebody">
          <div className="plot">
            <div className="axis">
              <span>Operation</span>
              <div className="ticks">
                {[0, 1, 2, 3, 4].map((t) => (
                  <span key={t}>{formatDuration((range * t) / 4)}</span>
                ))}
              </div>
              <span>Duration</span>
            </div>
            {rows.map(({ row, depth }) => (
              <div
                key={row.id}
                className={'spanrow' + (row.id === selected.id ? ' chosen' : '')}
                style={
                  {
                    '--depth': Math.min(depth, 8),
                    '--service': color(row.service),
                    '--start':
                      Math.min(100, Math.max(0, ((row.start - origin) / range) * 100)) + '%',
                    '--length':
                      Math.max(
                        0,
                        ((Math.min(origin + range, row.end) - Math.max(origin, row.start)) /
                          range) *
                          100,
                      ) + '%',
                  } as CSSProperties
                }
              >
                <div className="spanlabel">
                  {model.children.has(row.id) ? (
                    <button
                      className="branch"
                      aria-label={(collapsed.has(row.id) ? 'Expand ' : 'Collapse ') + row.name}
                      aria-expanded={!collapsed.has(row.id)}
                      onClick={() =>
                        collapse((prev) => {
                          const next = new Set(prev);
                          if (!next.delete(row.id)) next.add(row.id);
                          return next;
                        })
                      }
                    >
                      {collapsed.has(row.id) ? '›' : '⌄'}
                    </button>
                  ) : (
                    <span className="leaf" />
                  )}
                  <button
                    className="spanpick"
                    ref={(el) => {
                      if (el) refs.current.set(row.id, el);
                      else refs.current.delete(row.id);
                    }}
                    aria-pressed={row.id === selected.id}
                    onClick={() => select(row.id)}
                  >
                    {row.name}
                  </button>
                </div>
                <button
                  tabIndex={-1}
                  aria-label={'Inspect ' + row.name}
                  className="lane"
                  onClick={() => select(row.id)}
                >
                  <i className="spanbar">
                    {row.status === 'Error' && <b className="error-end">!</b>}
                  </i>
                </button>
                <span className="spanvalue">{formatDuration(row.end - row.start)}</span>
              </div>
            ))}
          </div>
          <aside
            className={'inspect' + (sheet ? ' open' : '')}
            aria-label="Selected span"
            onKeyDown={(e) => {
              if (e.key === 'Escape') close();
            }}
          >
            <div className="inshead">
              <span className="svc">
                <i style={{ background: color(selected.service) }} />
                {selected.service}
              </span>
              <button className="tracebtn close-sheet" ref={closeButton} onClick={close}>
                Close
              </button>
            </div>
            <h3>{selected.name}</h3>
            <div className="timing">{formatDuration(selected.end - selected.start)}</div>
            <p className="ins-share">
              {(((selected.end - selected.start) / Math.max(0.001, end - start)) * 100).toFixed(1)}%
              of trace
            </p>
            <dl>
              <dt>Status</dt>
              <dd>{selected.status}</dd>
              <dt>Started at</dt>
              <dd>{formatDuration(selected.start - start)}</dd>
              <dt>Parent</dt>
              <dd>
                {selected.parent ? (model.byId.get(selected.parent)?.name ?? 'Unrecorded') : 'Root'}
              </dd>
            </dl>
            <section className="ins-group">
              <h4>Attributes</h4>
              {Object.keys(selected.attributes).length ? (
                <dl className="attrlist">
                  {Object.entries(selected.attributes).map(([key, val]) => (
                    <Fragment key={key}>
                      <dt>{key}</dt>
                      <dd>{String(val)}</dd>
                    </Fragment>
                  ))}
                </dl>
              ) : (
                <p className="ins-empty">No attributes recorded.</p>
              )}
            </section>
            <section className="ins-group">
              <h4>Events</h4>
              {selected.events.length ? (
                <ol className="ins-events">
                  {selected.events.map((e, i) => (
                    <li key={i}>
                      <time>+{formatDuration(e.at - selected.start)}</time>
                      <span>
                        {e.name}
                        {Object.entries(e.attributes ?? {}).map(([key, val]) => (
                          <small className="event-field" key={key}>
                            {key} = {String(val)}
                          </small>
                        ))}
                      </span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="ins-empty">No events recorded.</p>
              )}
            </section>
            <button
              className="tracebtn"
              onClick={() => {
                setFocus(selected.id);
                collapse(new Set());
                close();
              }}
            >
              Focus span
            </button>
          </aside>
        </div>
      </div>
    </section>
  );
}
