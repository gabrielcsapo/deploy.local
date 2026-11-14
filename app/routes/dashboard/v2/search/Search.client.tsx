'use client';
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AgentAvatar } from '@/components/ui/v2/AgentAvatar';
import { Icon } from '@/components/ui';
import type { InboxItem } from '../../../../../shared/v2/contracts';
import { authenticatedFetch } from '../data/hooks';
import type { SidebarAgent } from '../data/sidebar';
import { reviewHref } from '../design/review-model';
import { projectPath } from '../projects/routing.ts';
import { newTaskIn } from '../start/chosen-project';
import {
  TEXT_MIN,
  byFile,
  codeCount,
  codeHref,
  matchParts,
  messageHref,
  nameHref,
  searchEvent,
  type SearchCodeResponse,
  type SearchKind,
  type SearchName,
  type SearchResponse,
  type SearchScope,
} from './model.ts';
import './search.css';

// The project page being looked at, so ⌘K and the magnifier start inside it.
let pageScope: SearchScope | null = null;
/** A project page says where it is; search opened from it starts in that project. */
export function useSearchScope(scope: SearchScope | null) {
  const { id, name, ref } = scope ?? {};
  useEffect(() => {
    if (!id || !name) return;
    const mine = { id, name, ref };
    pageScope = mine;
    return () => {
      if (pageScope === mine) pageScope = null;
    };
  }, [id, name, ref]);
}
export const currentSearchScope = () => pageScope;

type Row = {
  key: string;
  href?: string;
  select?: () => void;
  two?: boolean;
  lead?: ReactNode;
  body: ReactNode;
  ask?: boolean;
};
type Section = { key: string; label?: ReactNode; right?: string; rows: Row[] };

function Marked({ text, query }: { text: string; query: string }) {
  return (
    <>
      {matchParts(text, query).map((part, index) =>
        index % 2 ? (
          <mark key={index} className="v2-search-mark">
            {part}
          </mark>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        ),
      )}
    </>
  );
}

const nameGroups: { label: string; kinds: SearchName['kind'][] }[] = [
  { label: 'Projects and apps', kinds: ['project', 'app'] },
  { label: 'Tasks', kinds: ['task'] },
  { label: 'Agents', kinds: ['agent'] },
  { label: 'Computers', kinds: ['computer'] },
  { label: 'Pull requests', kinds: ['pull'] },
  { label: 'Issues', kinds: ['issue'] },
];

export function SearchBox({
  pathname,
  agents,
  waiting,
  formatTime,
}: {
  pathname: string;
  agents: SidebarAgent[];
  waiting: InboxItem[];
  formatTime: (value: string, style?: 'list') => string;
}) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<SearchScope | null>(null);
  const [kind, setKind] = useState<SearchKind | null>(null);
  const [text, setText] = useState('');
  const [found, setFound] = useState<{ key: string; data: SearchResponse } | null>(null);
  const [code, setCode] = useState<{ key: string; data: SearchCodeResponse } | null>(null);
  const [active, setActive] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const query = text.trim();
  const searchesText = [...query].length >= TEXT_MIN;
  const where = `${scope?.id ?? ''}\0${scope?.ref ?? ''}`;
  const namesKey = `${query}\0${where}`;
  const codeKey = `${namesKey}\0${kind === 'code' ? 'all' : 'few'}`;

  useEffect(() => {
    const show = (event: Event) => {
      const next = (event as CustomEvent<{ scope?: SearchScope }>).detail?.scope ?? null;
      setScope(next);
      setKind(null);
      setText('');
      setOpen(true);
    };
    const shortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== 'k')
        return;
      // On the Design page ⌘K asks an agent about the canvas.
      if (window.location.pathname === '/dashboard/design') return;
      event.preventDefault();
      show(new CustomEvent(searchEvent, { detail: { scope: pageScope ?? undefined } }));
    };
    window.addEventListener(searchEvent, show);
    window.addEventListener('keydown', shortcut);
    return () => {
      window.removeEventListener(searchEvent, show);
      window.removeEventListener('keydown', shortcut);
    };
  }, []);
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      element.showModal();
      input.current?.focus();
    } else if (!open && element.open) element.close();
  }, [open, mounted]);

  // Names, files and messages answer from what is stored, so they are asked for on every pause.
  useEffect(() => {
    if (!open || !query) return;
    const stop = new AbortController();
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ q: query });
      if (scope) params.set('project', scope.id);
      if (scope?.ref) params.set('ref', scope.ref);
      authenticatedFetch(`/api/search?${params}`, { signal: stop.signal })
        .then((response) => (response.ok ? (response.json() as Promise<SearchResponse>) : null))
        .then((data) => {
          if (data && !stop.signal.aborted) setFound({ key: namesKey, data });
        })
        .catch(() => {});
    }, 100);
    return () => {
      clearTimeout(timer);
      stop.abort();
    };
  }, [open, query, scope, namesKey]);
  // Code is read from the repositories, which takes longer; a new search cancels the last one.
  useEffect(() => {
    if (!open || !searchesText) return;
    const stop = new AbortController();
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ q: query, limit: kind === 'code' ? '200' : '3' });
      if (scope) params.set('project', scope.id);
      if (scope?.ref) params.set('ref', scope.ref);
      authenticatedFetch(`/api/search/code?${params}`, { signal: stop.signal })
        .then((response) => (response.ok ? (response.json() as Promise<SearchCodeResponse>) : null))
        .then((data) => {
          if (stop.signal.aborted) return;
          setCode({
            key: codeKey,
            data: data ?? {
              query,
              lines: 0,
              files: 0,
              projects: 0,
              truncated: false,
              items: [],
            },
          });
        })
        .catch(() => {});
    }, 250);
    return () => {
      clearTimeout(timer);
      stop.abort();
    };
  }, [open, query, searchesText, scope, kind, codeKey]);

  const names = found?.key === namesKey ? found.data : null;
  const codeNow = code?.key === codeKey ? code.data : null;
  const searchingCode = searchesText && !codeNow;
  const asker = agents[0];

  const sections = useMemo(() => {
    const result: Section[] = [];
    if (!query) return result;
    const mark = (value: string) => <Marked text={value} query={query} />;
    const meta = (value: string) => (value ? <span className="dl-meta">{value}</span> : null);
    const agentName = new Map(agents.map((agent) => [agent.id, agent.name]));
    const messageRow = (message: SearchResponse['messages']['items'][number]): Row => ({
      key: `message:${message.id}`,
      href: messageHref(message),
      two: true,
      lead: (
        <AgentAvatar
          avatar={agents.find((agent) => agent.id === message.agentId)?.avatar}
          id={message.agentId}
          size={28}
        />
      ),
      body: (
        <>
          <span className="v2-search-t">
            {message.title}
            {meta(
              `${message.taskId ? message.who : message.fromYou ? 'from you' : 'to you'} · ${formatTime(message.at, 'list')}`,
            )}
          </span>
          <span className="v2-search-snippet">{mark(message.snippet)}</span>
        </>
      ),
    });

    if (kind === 'code') {
      if (searchingCode) result.push({ key: 'code', label: 'Code', right: 'Searching…', rows: [] });
      for (const group of byFile(codeNow?.items ?? []))
        result.push({
          key: `file:${group.key}`,
          label: (
            <span>
              <span className="v2-search-path">{group.path}</span>
              {!scope && <span className="v2-search-in">{group.project}</span>}
            </span>
          ),
          right: String(group.items.length),
          rows: group.items.map((item) => ({
            key: `line:${group.key}:${item.line}`,
            href: codeHref(item, item.line, query),
            body: (
              <span className="v2-search-t v2-search-line">
                <span className="v2-search-n">{item.line}</span>
                {mark(item.text)}
              </span>
            ),
          })),
        });
      return result;
    }
    if (kind === 'messages') {
      result.push({
        key: 'messages',
        label: 'Messages',
        right: names ? String(names.messages.total) : undefined,
        rows: (names?.messages.items ?? []).map(messageRow),
      });
      return result;
    }

    const needle = query.toLowerCase();
    const decisions = waiting.filter((item) => item.title.toLowerCase().includes(needle));
    if (!scope && decisions.length)
      result.push({
        key: 'waiting',
        label: 'Waiting on you',
        rows: decisions.slice(0, 4).map((item) => ({
          key: `waiting:${item.id}`,
          href: item.id.startsWith('design:')
            ? reviewHref(item.id)
            : `/dashboard/inbox?item=${encodeURIComponent(item.id)}`,
          lead: <Icon name="attention" className="dl-attn" size={14} />,
          body: (
            <span className="v2-search-t">
              {mark(item.title)}
              {meta(
                [agentName.get(item.from ?? ''), formatTime(item.createdAt, 'list')]
                  .filter(Boolean)
                  .join(' · '),
              )}
            </span>
          ),
        })),
      });
    for (const group of nameGroups) {
      const rows = (names?.names ?? []).filter((name) => group.kinds.includes(name.kind));
      if (!rows.length) continue;
      result.push({
        key: group.label,
        label: group.label,
        rows: rows.map((name) => ({
          key: `${name.kind}:${name.projectId ?? ''}:${name.id}`,
          href: nameHref(name),
          lead:
            name.kind === 'project' ? (
              <Icon name="folder" />
            ) : name.kind === 'app' ? (
              <Icon name="apps" />
            ) : name.kind === 'task' ? (
              name.status === 'running' ? (
                <Icon name="running" className="dl-run" size={14} />
              ) : null
            ) : name.kind === 'agent' ? (
              <AgentAvatar
                avatar={agents.find((agent) => agent.id === name.id)?.avatar}
                id={name.id}
                size={20}
              />
            ) : name.kind === 'computer' ? (
              <Icon name="computer" />
            ) : name.kind === 'pull' ? (
              <Icon name="merge" />
            ) : (
              <Icon name="comment" />
            ),
          body: (
            <span className="v2-search-t">
              {mark(name.title)}
              {meta(
                name.kind === 'project'
                  ? 'Project'
                  : name.kind === 'app'
                    ? [name.appKind === 'worker' ? 'Worker' : 'Web app', scope ? '' : name.project]
                        .filter(Boolean)
                        .join(' · ')
                    : name.kind === 'task'
                      ? [name.agent, name.at ? formatTime(name.at, 'list') : '']
                          .filter(Boolean)
                          .join(' · ')
                      : name.kind === 'pull' || name.kind === 'issue'
                        ? [name.number ? `#${name.number}` : '', scope ? '' : name.project]
                            .filter(Boolean)
                            .join(' · ')
                        : '',
              )}
            </span>
          ),
        })),
      });
    }
    if (scope && names?.files?.total)
      result.push({
        key: 'files',
        label: 'Files',
        right: String(names.files.total),
        rows: names.files.items.slice(0, 5).map((file) => ({
          key: `file:${file.path}`,
          href: codeHref({ projectId: scope.id, ref: names.files!.ref, path: file.path }),
          lead: <Icon name="file" />,
          body: (
            <span className="v2-search-t">
              {mark(file.name)}
              {meta(file.directory)}
            </span>
          ),
        })),
      });
    if (searchingCode) result.push({ key: 'code', label: 'Code', right: 'Searching…', rows: [] });
    else if (codeNow?.lines)
      result.push({
        key: 'code',
        label: 'Code',
        right: [codeCount(codeNow), scope ? codeNow.ref : ''].filter(Boolean).join(' · '),
        rows: [
          ...codeNow.items.slice(0, 3).map((item): Row => ({
            key: `code:${item.projectId}:${item.path}:${item.line}`,
            href: codeHref(item, item.line, query),
            two: true,
            lead: <Icon name="file" />,
            body: (
              <>
                <span className="v2-search-t">
                  <span className="v2-search-path">
                    {item.path}:{item.line}
                  </span>
                  {!scope && meta(item.project)}
                </span>
                <span className="v2-search-snippet mono">{mark(item.text)}</span>
              </>
            ),
          })),
          ...(codeNow.lines > Math.min(3, codeNow.items.length)
            ? [
                {
                  key: 'code:all',
                  select: () => setKind('code'),
                  lead: null,
                  body: (
                    <>
                      <span className="v2-search-t v2-search-more">
                        Show all {codeNow.lines}
                        {codeNow.truncated ? '+' : ''} in code
                      </span>
                      <span className="dl-end">
                        <Icon name="chevron" size={14} />
                      </span>
                    </>
                  ),
                } satisfies Row,
              ]
            : []),
        ],
      });
    if (names?.messages.total)
      result.push({
        key: 'messages',
        label: 'Messages',
        right: String(names.messages.total),
        rows: [
          ...names.messages.items.slice(0, 2).map(messageRow),
          ...(names.messages.total > 2
            ? [
                {
                  key: 'messages:all',
                  select: () => setKind('messages'),
                  lead: null,
                  body: (
                    <>
                      <span className="v2-search-t v2-search-more">
                        Show all {names.messages.total} in messages
                      </span>
                      <span className="dl-end">
                        <Icon name="chevron" size={14} />
                      </span>
                    </>
                  ),
                } satisfies Row,
              ]
            : []),
        ],
      });
    const project = scope ?? names?.names.find((name) => name.kind === 'project');
    if (!scope && project)
      result.push({
        key: 'actions',
        label: 'Actions',
        rows: [
          {
            key: 'action:logs',
            href: `${projectPath(project.id)}/logs`,
            lead: <Icon name="list" />,
            body: (
              <span className="v2-search-t">
                Open {'title' in project ? project.title : project.name} logs
              </span>
            ),
          },
          {
            key: 'action:task',
            href: newTaskIn(project.id),
            lead: <Icon name="compose" />,
            body: (
              <>
                <span className="v2-search-t">
                  New task in {'title' in project ? project.title : project.name}
                </span>
                <span className="dl-end">
                  <span className="dl-kbd">⌘N</span>
                </span>
              </>
            ),
          },
        ],
      });
    return result;
  }, [query, kind, scope, names, codeNow, searchingCode, waiting, agents, formatTime]);

  const settled = !!names && !searchingCode;
  const nothing = !!query && settled && !sections.some((section) => section.rows.length);
  const askRow: Row | null =
    query && asker
      ? {
          key: 'ask',
          href: `/dashboard/agents/${encodeURIComponent(asker.id)}?ask=${encodeURIComponent(query)}`,
          ask: true,
          lead: <AgentAvatar avatar={asker.avatar} id={asker.id} size={28} />,
          body: (
            <>
              <span className="v2-search-t">
                Ask {asker.name} about "{query}"{scope ? ` in ${scope.name}` : ''}
              </span>
              <span className="dl-end">
                <span className="dl-kbd">⌘↵</span>
              </span>
            </>
          ),
        }
      : null;
  const shown: Section[] = [
    ...sections.filter((section) => section.rows.length || section.right === 'Searching…'),
    ...(askRow && !kind ? [{ key: 'ask', label: 'Ask', rows: [askRow] }] : []),
  ];
  const rows = shown.flatMap((section) => section.rows);
  const at = Math.min(active, Math.max(0, rows.length - 1));
  useEffect(() => setActive(0), [namesKey, kind]);
  useEffect(() => {
    list.current?.querySelector('.dl-nav.on')?.scrollIntoView({ block: 'nearest' });
  }, [at, shown.length]);

  const choose = (row: Row | undefined, element?: HTMLElement | null) => {
    if (!row) return;
    if (row.select) {
      row.select();
      input.current?.focus();
      return;
    }
    // The dashboard's link handler takes the click, so the page changes without a reload.
    (
      element ?? list.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(row.key)}"]`)
    )?.click();
  };

  if (!mounted) return null;
  let index = -1;
  return createPortal(
    <dialog
      ref={dialog}
      className="dl-dialog dl-modal v2-search"
      aria-label="Search"
      onCancel={(event) => {
        event.preventDefault();
        setOpen(false);
      }}
      onClose={() => setOpen(false)}
      onClick={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <div className="v2-search-box">
        <div className="v2-search-top">
          <Icon name="search" size={18} />
          {scope && <span className="v2-search-token">{scope.name}</span>}
          {kind && <span className="v2-search-token">{kind === 'code' ? 'Code' : 'Messages'}</span>}
          <input
            ref={input}
            className="v2-search-input"
            aria-label={scope ? `Search ${scope.name}` : 'Search'}
            role="combobox"
            aria-expanded={rows.length > 0}
            aria-controls="v2-search-results"
            autoComplete="off"
            spellCheck={false}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                if (rows.length)
                  setActive((at + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length);
              } else if (event.key === 'Enter') {
                event.preventDefault();
                choose(event.metaKey || event.ctrlKey ? (askRow ?? undefined) : rows[at]);
              } else if (
                event.key === 'Backspace' &&
                event.currentTarget.selectionStart === 0 &&
                event.currentTarget.selectionEnd === 0
              ) {
                // Before the words sit the tokens; Backspace takes the last one away.
                if (kind) setKind(null);
                else if (scope) setScope(null);
              }
            }}
          />
          <span className="dl-kbd">esc</span>
        </div>
        <div ref={list} id="v2-search-results" className="v2-search-body" role="listbox">
          {nothing && (
            <div className="v2-search-none" role="status">
              <b>Nothing matches “{query}”</b>
              <span className="dl-meta">
                {scope
                  ? `Looked in ${scope.name}: names, files, code${names?.files?.ref ? ` on ${names.files.ref}` : ''}, and messages.`
                  : 'Looked in names, in code on each project’s main branch, and in messages.'}
              </span>
            </div>
          )}
          {shown.map((section) => (
            <Fragment key={section.key}>
              {section.label && (
                <div className="dl-side-label v2-search-label">
                  {typeof section.label === 'string' ? <span>{section.label}</span> : section.label}
                  {section.right && <span>{section.right}</span>}
                </div>
              )}
              {section.rows.map((row) => {
                index++;
                const mine = index;
                return (
                  <a
                    key={row.key}
                    data-row={row.key}
                    role="option"
                    aria-selected={mine === at}
                    className={`dl-nav v2-search-row${row.two ? ' two' : ''}${mine === at ? ' on' : ''}`}
                    href={row.href ?? '#'}
                    onMouseMove={() => setActive(mine)}
                    onClick={(event) => {
                      if (row.select) {
                        event.preventDefault();
                        row.select();
                        input.current?.focus();
                      } else setOpen(false);
                    }}
                  >
                    <span className="dl-lead">{row.lead}</span>
                    {row.two ? <span className="v2-search-two">{row.body}</span> : row.body}
                    {mine === at && !row.ask && !row.select && (
                      <span className="dl-end">
                        <span className="dl-kbd">↵</span>
                      </span>
                    )}
                  </a>
                );
              })}
            </Fragment>
          ))}
        </div>
        <div className="dl-meta v2-search-foot">
          <span>↑↓ move</span>
          <span>{kind === 'code' ? '↵ open at this line' : '↵ open'}</span>
          <span className="v2-search-wide">
            {kind ? '⌫ all results' : scope ? '⌫ search everywhere' : '⌘↵ ask an agent'}
          </span>
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
