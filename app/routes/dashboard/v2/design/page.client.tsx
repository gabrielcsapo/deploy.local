'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-flight-router/client';
import { Action, Empty, Icon, type IconName } from '@/components/ui';
import type { Project } from '../../../../../shared/v2/contracts';
import { getAuth } from '../../detail/shared';
import { useInbox } from '../data/hooks';
import { request, useData } from '../projects/data';
import {
  AgentPanel,
  AskPopover,
  OverlayBar,
  useAsks,
  type Change,
  type OverlayMode,
} from './Agent';
import {
  DesignCanvas,
  layerElement,
  type Drawn,
  rectOf,
  type AgentPresence,
  type Selection,
  type Tool,
  type View,
} from './Canvas';
import { CommentsPanel, useComments } from './Comments';
import {
  bounds,
  fit,
  boardName,
  nameOf,
  type LayerChange,
  readTokens,
  sections as readSections,
  type Design,
  type Tokens,
} from './model';
import {
  AssetsPanel,
  ComponentPanel,
  useLibrary,
  type Component,
  type DropTarget,
  type Placing,
} from './Assets';
import { DesignMenu, LeftPanel, RightPanel, useChanges, type LayerEdit } from './Panels';
import './style.css';

const noTokens: Tokens = { colors: [], textStyles: [] };

/** Keep the page's place in the URL without a navigation, so a link opens the same board. */
function remember(values: Record<string, string | null>) {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(values))
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  window.history.replaceState(window.history.state, '', url);
}

export default function DesignPage() {
  const [params] = useSearchParams();
  const inbox = useInbox();
  const waiting = inbox.items.filter((item) => item.state === 'waiting');
  // Read after hydration: the server has no browser storage.
  const [owner, setOwner] = useState('');
  useEffect(() => setOwner(getAuth()?.username ?? ''), []);
  const projects = useData<{ projects: Project[] }>('/api/v2/projects');
  const [projectId, setProjectId] = useState(params.get('project') ?? '');
  const project =
    projects.data?.projects.find((item) => item.id === projectId) ?? projects.data?.projects[0];
  const [ref, setRef] = useState(params.get('ref') ?? 'HEAD');
  const designPath = project
    ? `/api/v2/projects/${encodeURIComponent(project.id)}/design?ref=${encodeURIComponent(ref)}`
    : undefined;
  const design = useData<Design>(designPath);
  // An agent's design branch, shown over yours: Mine, Overlay (its version, changes outlined), Agent's.
  const [taskId, setTaskId] = useState(params.get('task') ?? '');
  const [mode, setMode] = useState<OverlayMode>('overlay');
  const [poll, setPoll] = useState(0);
  const projectApi = project ? `/api/v2/projects/${encodeURIComponent(project.id)}/design` : '';
  const agentDesign = useData<Design>(
    project && taskId ? `${projectApi}?task=${encodeURIComponent(taskId)}&v=${poll}` : undefined,
  );
  const agentChanges = useData<{ files: Change[] }>(
    project && taskId
      ? `${projectApi}/changes?task=${encodeURIComponent(taskId)}&v=${poll}`
      : undefined,
  );
  const { asks } = useAsks(project?.id, poll);
  const ask = asks.find((item) => item.id === taskId);
  useEffect(() => {
    if (!taskId) return;
    // The agent commits as it works; look for new commits while its branch is open.
    const timer = window.setInterval(() => setPoll((n) => n + 1), 10000);
    return () => window.clearInterval(timer);
  }, [taskId]);
  const [lastAgent, setLastAgent] = useState<Design | undefined>();
  useEffect(() => {
    if (agentDesign.data) setLastAgent(agentDesign.data);
  }, [agentDesign.data]);
  const [lastChanges, setLastChanges] = useState<Change[]>([]);
  useEffect(() => {
    if (agentChanges.data) setLastChanges(agentChanges.data.files);
  }, [agentChanges.data]);
  const overlay = Boolean(taskId && ask);
  const shown = overlay && mode !== 'mine' && lastAgent ? lastAgent : design.data;
  const canvas = shown?.canvas ?? null;
  // Your own edits make new commits, but the boards on screen already show them, so the canvas
  // keeps the commit it opened and loads only the boards you edited from their latest commit.
  const ownCommits = useRef(new Set<string>());
  const [frameCommit, setFrameCommit] = useState<string>();
  const [boardSrc, setBoardSrc] = useState(new Map<string, { base: string; reload: number }>());
  useEffect(() => {
    if (!shown || ownCommits.current.has(shown.commit)) return;
    ownCommits.current.clear();
    setFrameCommit(shown.commit);
    setBoardSrc(new Map());
  }, [shown]);
  const filesAt = (commit: string) =>
    `/api/v2/projects/${encodeURIComponent(project!.id)}/design/files/${commit}`;
  const base = project && shown && frameCommit ? filesAt(frameCommit) : null;
  const agentBoards = useMemo(
    () =>
      new Set(
        overlay && mode === 'overlay'
          ? lastChanges
              .filter((change) => change.path.startsWith('design/boards/'))
              .map((change) => change.path.slice('design/boards/'.length))
          : [],
      ),
    [overlay, mode, lastChanges],
  );
  // The layers an agent's branch changed, outlined and labelled while its overlay shows.
  const agentLayers = useMemo(() => {
    const byBoard = new Map<string, LayerChange[]>();
    if (overlay && mode === 'overlay')
      for (const change of lastChanges)
        if (change.path.startsWith('design/boards/') && change.layers?.length)
          byBoard.set(
            change.path.slice('design/boards/'.length),
            change.layers.filter((layer) => layer.change !== 'removed'),
          );
    return byBoard;
  }, [overlay, mode, lastChanges]);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [accepting, setAccepting] = useState(false);
  const [tab, setTab] = useState<'edit' | 'comments'>('edit');
  const [commentFocus, setCommentFocus] = useState(0);
  const { comments, refresh: refreshComments } = useComments(project?.id);
  const [asking, setAsking] = useState(false);
  // Agents working on this design right now: a light poll of the coordinator's presence.
  const [agents, setAgents] = useState<AgentPresence[]>([]);
  useEffect(() => {
    if (!projectApi) return;
    let live = true;
    const look = () =>
      request<{ agents: AgentPresence[] }>(`${projectApi}/presence`)
        .then((value) => live && setAgents(value.agents))
        .catch(() => undefined);
    look();
    const timer = window.setInterval(look, 3000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [projectApi]);
  const proposals = useData<{ proposals: { id: string; state: string; boards: string[] }[] }>(
    project ? `${projectApi}/proposals?v=${poll}` : undefined,
  );
  const [proposing, setProposing] = useState(false);
  const inReview = proposals.data?.proposals.some(
    (item) =>
      item.state === 'waiting' &&
      item.id.startsWith(`design:${project?.id}:${ref.replaceAll('/', '~')}:`),
  );
  const tokensData = useData<unknown>(base ? `${base}/ds/deploy-local/tokens.json` : undefined);
  const tokens = useMemo(
    () => (tokensData.data ? readTokens(tokensData.data) : noTokens),
    [tokensData.data],
  );
  const changes = useChanges(project?.id, ref, design.data?.commit);
  const changed = useMemo(
    () =>
      new Set(
        changes
          .filter((change) => change.path.startsWith('design/boards/'))
          .map((change) => change.path.slice('design/boards/'.length)),
      ),
    [changes],
  );
  const sections = useMemo(() => (canvas ? readSections(canvas) : []), [canvas]);
  const [sectionId, setSectionId] = useState(params.get('page') ?? '');
  const section = sections.find((item) => item.id === sectionId) ?? sections[0] ?? null;
  const [selection, setSelection] = useState<Selection>(
    params.get('board') ? { board: params.get('board')!, layer: params.get('layer') } : null,
  );
  const [view, setView] = useState<View>({ x: 0, y: 0, z: 0.25 });
  const [tool, setTool] = useState<Tool>('move');
  const [menu, setMenu] = useState(false);
  const [narrowMenu, setNarrowMenu] = useState(false);
  // Figma's Minimize UI: hide both panels for more canvas.
  const [minimized, setMinimized] = useState(false);
  const [revision, setRevision] = useState(0);
  const frames = useRef(new Map<string, HTMLIFrameElement>());
  const stage = useRef<HTMLDivElement>(null);

  const fitTo = useCallback(
    (files: string[]) => {
      const host = stage.current?.querySelector('.dz-canvas');
      if (!canvas || !host) return;
      const box = bounds(canvas, files);
      const framed = fit(box, host.clientWidth, host.clientHeight);
      // A whole section can be too big to read; open at a readable zoom on its first boards.
      setView(framed.z >= 0.2 ? framed : { z: 0.25, x: 48 - box.x * 0.25, y: 72 - box.y * 0.25 });
    },
    [canvas],
  );
  // Open on the page's boards, or the board a link named.
  const fitted = useRef('');
  useEffect(() => {
    if (!canvas || !section) return;
    const key = `${frameCommit}:${section.id}`;
    if (fitted.current === key) return;
    fitted.current = key;
    const named = selection && canvas.boards[selection.board] ? [selection.board] : section.boards;
    requestAnimationFrame(() => fitTo(named));
  }, [canvas, section, frameCommit, selection, fitTo]);

  const select = useCallback((next: Selection) => {
    setSelection(next);
    if (next) setPicked(null);
    setAsking(false);
    remember({ board: next?.board ?? null, layer: next?.layer ?? null });
  }, []);
  const pickWithTool = useCallback(
    (next: Selection) => {
      select(next);
      if (tool === 'comment' && next) {
        setTab('comments');
        setCommentFocus((n) => n + 1);
      }
    },
    [select, tool],
  );
  const openTask = (id: string) => {
    setTaskId(id);
    setMode('overlay');
    setSkipped(new Set());
    setTab('edit');
    setPoll((n) => n + 1);
    remember({ task: id });
  };
  const closeTask = () => {
    setTaskId('');
    setLastAgent(undefined);
    setLastChanges([]);
    remember({ task: null });
  };
  const accept = async (paths?: string[]) => {
    if (!project || !taskId) return;
    setAccepting(true);
    try {
      const result = await request<{ branch: string; accepted: string[] }>(`${projectApi}/accept`, {
        method: 'POST',
        body: JSON.stringify({ task: taskId, into: ref, paths }),
      });
      setRef(result.branch);
      remember({ ref: result.branch });
      design.refresh();
      const left = lastChanges.filter((change) => !result.accepted.includes(change.path));
      if (!left.length || !paths) closeTask();
      else setPoll((n) => n + 1);
    } catch (failure) {
      window.alert((failure as Error).message);
    } finally {
      setAccepting(false);
    }
  };
  // Edits apply to the board on screen at once, then commit one after another to the design
  // branch; the first edit on main starts a branch, so main only changes through review.
  const editable = Boolean(project && design.data && !(overlay && mode !== 'mine'));
  const head = useRef<{ ref: string; commit: string } | null>(null);
  useEffect(() => {
    if (design.data) head.current = { ref, commit: design.data.commit };
  }, [design.data, ref]);
  const queue = useRef(Promise.resolve());
  const reload = (board: string, commit: string) =>
    setBoardSrc((current) =>
      new Map(current).set(board, {
        base: filesAt(commit),
        reload: (current.get(board)?.reload ?? 0) + 1,
      }),
    );
  /** One request after another on the design branch, each on top of the last. */
  const send = <T extends { branch: string; commit: string }>(
    path: '/edit' | '/canvas',
    body: object,
    done: (result: T) => void,
    failed?: (at: { ref: string; commit: string }) => void,
  ) => {
    queue.current = queue.current.then(async () => {
      const at = head.current;
      if (!at) return;
      try {
        const result = await request<T>(`${projectApi}${path}`, {
          method: 'POST',
          body: JSON.stringify({
            ...body,
            ref: at.ref,
            expect: at.ref.startsWith('design/') ? at.commit : undefined,
          }),
        });
        ownCommits.current.add(result.commit);
        head.current = { ref: result.branch, commit: result.commit };
        done(result);
        if (result.branch !== at.ref) {
          setRef(result.branch);
          remember({ ref: result.branch });
        }
        design.refresh();
      } catch (failure) {
        failed?.(at);
        window.alert((failure as Error).message);
      }
    });
  };
  const edit = (board: string, layer: string, edits: LayerEdit[]) => {
    const element = layerElement(frames, board, layer);
    if (element)
      for (const change of edits)
        if (change.op === 'text') element.textContent = change.text;
        else if (change.op === 'style')
          if (change.value === null) element.style.removeProperty(change.prop);
          else element.style.setProperty(change.prop, change.value);
    setRevision((n) => n + 1);
    send<{ branch: string; commit: string }>(
      '/edit',
      { board, edits: edits.map((change) => ({ ...change, layer })) },
      (result) => {
        // A reset cannot be shown before the server works it out, so that board loads again.
        if (edits.some((change) => change.op === 'revert')) reload(board, result.commit);
        else
          setBoardSrc((current) =>
            new Map(current).set(board, {
              base: filesAt(result.commit),
              reload: current.get(board)?.reload ?? 0,
            }),
          );
      },
      // Put the board back as it is on the branch.
      (at) => reload(board, at.commit),
    );
  };
  // What the drawing tools made: a layer in a board, a new board, or a sticky note.
  const [retypeNext, setRetypeNext] = useState<{ board: string; layer: string } | null>(null);
  const draw = (drawn: Drawn) => {
    setTool('move');
    if ('board' in drawn)
      return send<{ branch: string; commit: string; layers: string[] }>(
        '/edit',
        { board: drawn.board, edits: [{ op: 'insert', shape: drawn.shape }] },
        (result) => {
          reload(drawn.board, result.commit);
          const layer = result.layers[0];
          if (!layer) return;
          select({ board: drawn.board, layer });
          if (drawn.shape.kind === 'text') setRetypeNext({ board: drawn.board, layer });
        },
      );
    if (drawn.canvas === 'board')
      return send<{ branch: string; commit: string; made: string }>(
        '/canvas',
        { op: 'board', x: drawn.x, y: drawn.y, kind: drawn.kind },
        (result) => {
          reload(result.made, result.commit);
          select({ board: result.made, layer: null });
        },
      );
    send('/canvas', { op: 'note', x: drawn.x, y: drawn.y, text: drawn.text }, () => undefined);
  };
  const editNote = (id: string, text: string) =>
    send('/canvas', text ? { op: 'note', id, text } : { op: 'remove-note', id }, () => undefined);
  const removeLayer = (board: string, layer: string) => {
    select(null);
    send('/edit', { board, edits: [{ op: 'remove', layer }] }, (result) =>
      reload(board, result.commit),
    );
  };
  // Assets: a component picked to look at, or being dragged onto a board.
  const assets = useLibrary(projectApi, ref, design.data?.commit);
  const [picked, setPicked] = useState<{
    component: Component;
    props: Record<string, string>;
  } | null>(null);
  const [placing, setPlacing] = useState<Placing | null>(null);
  const [dropping, setDropping] = useState<DropTarget | null>(null);
  const dropAt = useRef<DropTarget | null>(null);
  const place = (component: Component, props: Record<string, string>, target: DropTarget) =>
    send<{ branch: string; commit: string; layers: string[] }>(
      '/edit',
      {
        board: target.board,
        edits: [
          {
            op: 'insert',
            parent: target.parent ?? undefined,
            index: target.index,
            component: { id: component.id, props, x: target.x, y: target.y },
          },
        ],
      },
      (result) => {
        reload(target.board, result.commit);
        const layer = result.layers[0];
        if (layer) select({ board: target.board, layer });
      },
    );
  const dragComponent = (component: Component, event: React.PointerEvent) => {
    const props = picked?.component.id === component.id ? picked.props : {};
    const start = { x: event.clientX, y: event.clientY };
    let moving = false;
    let cancelled = false;
    const move = (next: PointerEvent) => {
      // A click picks the component; a drag of a few pixels starts placing it.
      if (!moving && Math.hypot(next.clientX - start.x, next.clientY - start.y) < 4) return;
      if (!moving && !editable) return;
      moving = true;
      setPicked({ component, props });
      setPlacing({ component, props, x: next.clientX, y: next.clientY });
    };
    const keys = (next: KeyboardEvent) => {
      if (next.key === 'Escape') {
        cancelled = true;
        up();
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', keys);
      if (!moving) return;
      setPlacing(null);
      const target = dropAt.current;
      if (target && !cancelled) place(component, props, target);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', keys);
  };
  const inAssets = placing ?? picked;
  const componentPanel =
    inAssets && assets?.library ? (
      <ComponentPanel
        component={inAssets.component}
        library={assets.library}
        props={inAssets.props}
        setProps={(props) => setPicked({ component: inAssets.component, props })}
        target={placing ? dropping : null}
        usage={assets.usage[inAssets.component.id] ?? []}
        sections={sections}
      />
    ) : undefined;
  const [shape, setShape] = useState<'rectangle' | 'ellipse' | 'line'>('rectangle');
  const [shapeMenu, setShapeMenu] = useState(false);

  const chooseSection = (id: string) => {
    setSectionId(id);
    remember({ page: id, board: null, layer: null });
    setSelection(null);
    const next = sections.find((item) => item.id === id);
    if (next) requestAnimationFrame(() => fitTo(next.boards));
  };
  const chooseRef = (next: string) => {
    setRef(next);
    setMenu(false);
    remember({ ref: next === 'HEAD' ? null : next });
  };
  const newBranch = async () => {
    setMenu(false);
    const name = window.prompt('Name the design branch', '');
    if (!name || !project) return;
    try {
      const { branch } = await request<{ branch: { name: string } }>(
        `/api/v2/projects/${encodeURIComponent(project.id)}/design/branches`,
        { method: 'POST', body: JSON.stringify({ name, from: design.data?.commit ?? 'HEAD' }) },
      );
      chooseRef(branch.name);
      design.refresh();
    } catch (error) {
      window.alert((error as Error).message);
    }
  };

  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement ||
        (event.target as HTMLElement).isContentEditable
      )
        return;
      if (event.key === 'v' || event.key === 'V') setTool('move');
      if (event.key === 'h' || event.key === 'H') setTool('hand');
      if (editable && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const drawingKeys: Record<string, Tool> = {
          r: 'rectangle',
          o: 'ellipse',
          l: 'line',
          t: 'text',
          p: 'pen',
          f: 'frame',
          s: 'sticky',
        };
        const next = drawingKeys[event.key.toLowerCase()];
        if (next) {
          setTool(next);
          if (next === 'rectangle' || next === 'ellipse' || next === 'line') setShape(next);
        }
        if ((event.key === 'Delete' || event.key === 'Backspace') && selection?.layer)
          removeLayer(selection.board, selection.layer);
      }
      if ((event.key === 'c' || event.key === 'C') && !event.metaKey && !event.ctrlKey)
        setTool('comment');
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey) && selection) {
        event.preventDefault();
        setAsking(true);
      }
      if (event.key === 'Escape') {
        select(null);
        setTool('move');
        setShapeMenu(false);
      }
      if (event.key === '\\' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setMinimized((value) => !value);
      }
      if (event.shiftKey && event.key === '!' && section) fitTo(section.boards);
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
    // removeLayer changes with every render; the listener is added again with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, fitTo, select, selection, editable]);

  const shapes = { rectangle: 'Rectangle', ellipse: 'Ellipse', line: 'Line' } as const;
  const shapeKeys = { rectangle: 'R', ellipse: 'O', line: 'L' } as const;
  const tools: {
    id: string;
    tool?: Tool;
    icon: IconName;
    label: string;
    menu?: boolean;
    ready?: boolean;
  }[] = [
    { id: 'move', tool: 'move', icon: 'move', label: 'Move  V', menu: true, ready: true },
    { id: 'frame', tool: 'frame', icon: 'frame', label: 'Frame  F', menu: true, ready: editable },
    {
      id: 'shape',
      tool: shape,
      icon: shape === 'rectangle' ? 'shape' : shape,
      label: `${shapes[shape]}  ${shapeKeys[shape]}`,
      menu: true,
      ready: editable,
    },
    { id: 'pen', tool: 'pen', icon: 'pen', label: 'Pen  P', menu: true, ready: editable },
    { id: 'text', tool: 'text', icon: 'text', label: 'Text  T', ready: editable },
    { id: 'sticky', tool: 'sticky', icon: 'sticky', label: 'Sticky note  S', ready: editable },
    { id: 'comment', tool: 'comment', icon: 'comment', label: 'Comment  C', ready: true },
    { id: 'ask', icon: 'spark', label: 'Ask an agent  ⌘K', ready: true },
  ];

  const propose =
    ref.startsWith('design/') && changes.length && project
      ? {
          state: (proposing ? 'busy' : inReview ? 'in-review' : 'ready') as
            | 'ready'
            | 'busy'
            | 'in-review',
          note: inReview
            ? 'Waiting on you: approve it there or in the task'
            : `Ask to approve ${ref}`,
          run: async () => {
            setProposing(true);
            try {
              await request(`${projectApi}/propose`, {
                method: 'POST',
                body: JSON.stringify({ ref }),
              });
              setPoll((n) => n + 1);
            } catch (failure) {
              window.alert((failure as Error).message);
            } finally {
              setProposing(false);
            }
          },
        }
      : null;
  const nameFor = (board: string, layer: string) =>
    nameOf(frames.current.get(board)?.contentDocument, layer);
  // The ask box opens under the selection, kept inside the canvas.
  const askPosition = () => {
    const host = stage.current?.querySelector('.dz-stage') as HTMLElement | null;
    const width = host?.clientWidth ?? 800;
    const box =
      selection && canvas ? rectOf(frames, canvas, selection.board, selection.layer) : null;
    if (!box) return { left: Math.max(12, width / 2 - 190), top: 80 };
    const left = Math.min(Math.max(12, box.x * view.z + view.x), width - 392);
    const top = Math.min((box.y + box.h) * view.z + view.y + 12, (host?.clientHeight ?? 600) - 300);
    return { left, top: Math.max(12, top) };
  };
  const inReviewBoards = new Set(
    (proposals.data?.proposals ?? [])
      .filter((item) => item.state === 'waiting')
      .flatMap((item) => item.boards ?? []),
  );
  const agentAt = new Map<string, Set<string | null>>();
  for (const agent of agents) {
    const here = agentAt.get(agent.board) ?? new Set<string | null>();
    here.add(agent.layer);
    agentAt.set(agent.board, here);
  }
  const empty = projects.data && !projects.data.projects.length;
  return (
    <div
      className={`dz${selection || inAssets ? ' has-selection' : ''}${asking ? ' asking' : ''}${minimized ? ' minimized' : ''}`}
      ref={stage}
    >
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700&display=swap"
      />
      <div className="dz-narrow-bar">
        <a className="dl-icon-btn" href="/dashboard" aria-label="Back to deploy.local">
          <Icon name="back" />
        </a>
        <span className="dz-narrow-menu">
          <button
            type="button"
            className="dz-mark"
            aria-label="deploy.local menu"
            aria-haspopup="menu"
            aria-expanded={narrowMenu}
            onClick={() => setNarrowMenu(!narrowMenu)}
          >
            <span className="dz-narrow-title">Designs</span>
            <Icon name="down" size={12} />
            {waiting.length > 0 && <span className="dz-badge">{waiting.length}</span>}
          </button>
          <DesignMenu
            open={narrowMenu}
            onClose={() => setNarrowMenu(false)}
            waiting={waiting}
            branches={design.data?.branches ?? []}
            current={ref}
            onRef={(next) => {
              setNarrowMenu(false);
              chooseRef(next);
            }}
            onNewBranch={() => {
              setNarrowMenu(false);
              void newBranch();
            }}
          />
        </span>
        <label className="dz-narrow-page">
          <Icon name="layers" size={13} />
          <select
            value={section?.id ?? ''}
            onChange={(event) => chooseSection(event.target.value)}
            aria-label="Page"
          >
            {sections.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
          <Icon name="down" size={12} />
        </label>
        <span className="dl-grow" />
        {propose && (
          <Action
            variant="primary"
            disabled={propose.state === 'in-review'}
            loading={propose.state === 'busy'}
            onClick={propose.run}
          >
            {propose.state === 'in-review' ? 'In review' : 'Propose'}
          </Action>
        )}
      </div>
      {minimized && (
        <button
          type="button"
          className="dz-restore"
          aria-label="Show panels  ⌘\\"
          title="Show panels  ⌘\\"
          onClick={() => setMinimized(false)}
        >
          <span className="dl-mark">d</span>
          <Icon name="panel" size={14} />
        </button>
      )}
      <LeftPanel
        projects={projects.data?.projects ?? []}
        project={project}
        onProject={(id) => {
          setProjectId(id);
          setRef('HEAD');
          setSelection(null);
          remember({ project: id, ref: null, board: null, layer: null, page: null });
        }}
        design={design.data}
        current={ref}
        sections={sections}
        section={section}
        onSection={chooseSection}
        selection={selection}
        select={select}
        base={base}
        boardSrc={boardSrc}
        changed={changed}
        waiting={waiting}
        menu={menu}
        setMenu={setMenu}
        onRef={chooseRef}
        onNewBranch={newBranch}
        inReview={inReviewBoards}
        agentAt={agentAt}
        onHide={() => setMinimized(true)}
        assets={
          <AssetsPanel
            library={assets ? assets.library : undefined}
            files={base}
            picked={inAssets?.component.id ?? null}
            onPick={(component) => {
              select(null);
              setPicked({ component, props: {} });
            }}
            onDrag={dragComponent}
          />
        }
      />
      <div className="dz-stage">
        {empty ? (
          <Empty title="No projects yet">
            Add a project with a design/ folder to see its boards here.
          </Empty>
        ) : design.error ? (
          <Empty title="Couldn’t open the design">{design.error}</Empty>
        ) : design.data && !canvas ? (
          <Empty title="This project has no design yet">
            Add design/canvas.json and boards in design/boards to see them here.
          </Empty>
        ) : canvas && base ? (
          <DesignCanvas
            canvas={canvas}
            section={section}
            base={base}
            view={view}
            setView={setView}
            tool={tool}
            selection={selection}
            select={pickWithTool}
            frames={frames}
            revision={revision}
            onFrameLoad={() => setRevision((n) => n + 1)}
            agentBoards={agentBoards}
            agentLayers={agentLayers}
            inReview={inReviewBoards}
            agents={agents}
            boardSrc={boardSrc}
            onEditText={
              editable
                ? (board, layer, text) => edit(board, layer, [{ op: 'text', text }])
                : undefined
            }
            onDraw={editable ? draw : undefined}
            onNote={editable ? editNote : undefined}
            retypeNext={retypeNext}
            onRetyped={() => setRetypeNext(null)}
            placing={placing}
            onTarget={(target) => {
              dropAt.current = target;
              setDropping(target);
            }}
            owner={owner}
            designFiles={base}
          />
        ) : (
          <div className="dz-loading">Loading the design…</div>
        )}
        {overlay && ask && (
          <OverlayBar
            ask={ask}
            mode={mode}
            setMode={setMode}
            changes={lastChanges.filter((change) => !skipped.has(change.path)).length}
            busy={accepting}
            onAccept={() => {
              const kept = lastChanges.filter((change) => !skipped.has(change.path));
              void accept(
                kept.length === lastChanges.length ? undefined : kept.map((change) => change.path),
              );
            }}
            onDiscard={closeTask}
          />
        )}
        {asking && selection && project && design.data && (
          <AskPopover
            projectId={project.id}
            designRef={ref}
            selection={selection}
            target={
              selection.layer
                ? nameFor(selection.board, selection.layer)
                : boardName(selection.board)
            }
            comments={
              comments.filter(
                (comment) =>
                  !comment.resolved &&
                  comment.board === selection.board &&
                  (!selection.layer || comment.layer === selection.layer),
              ).length
            }
            position={askPosition()}
            onClose={() => setAsking(false)}
            onAsked={(id) => {
              setAsking(false);
              openTask(id);
            }}
          />
        )}
        <div className="dz-toolbar" role="toolbar" aria-label="Tools">
          {tools.map((item, index) => (
            <span key={item.id} className="dz-tool-wrap">
              {index === 6 && <i className="dz-sep" />}
              <button
                type="button"
                className={`dz-tool${item.tool && tool === item.tool ? ' on' : ''}`}
                aria-label={item.label}
                aria-pressed={Boolean(item.tool && tool === item.tool)}
                title={item.label}
                disabled={!item.ready}
                onClick={() => {
                  setShapeMenu(false);
                  if (item.id === 'ask') return selection && setAsking(true);
                  if (item.tool) setTool(item.tool);
                }}
              >
                <Icon name={item.icon} size={18} />
              </button>
              {item.menu && (
                <button
                  type="button"
                  className="dz-tool-more"
                  aria-label={
                    item.id === 'move' ? 'Hand  H' : item.id === 'shape' ? 'Shapes' : item.label
                  }
                  aria-expanded={item.id === 'shape' ? shapeMenu : undefined}
                  title={item.id === 'move' ? 'Hand  H' : undefined}
                  disabled={item.id === 'shape' ? !editable : item.id !== 'move'}
                  onClick={() =>
                    item.id === 'shape'
                      ? setShapeMenu((open) => !open)
                      : setTool(tool === 'hand' ? 'move' : 'hand')
                  }
                >
                  <Icon name={item.id === 'move' && tool === 'hand' ? 'hand' : 'down'} size={10} />
                </button>
              )}
              {item.id === 'shape' && shapeMenu && (
                <div className="dz-shape-menu" role="menu" aria-label="Shapes">
                  {(['rectangle', 'ellipse', 'line'] as const).map((name) => (
                    <button
                      key={name}
                      type="button"
                      role="menuitemradio"
                      aria-checked={shape === name}
                      className={shape === name ? 'on' : ''}
                      onClick={() => {
                        setShape(name);
                        setTool(name);
                        setShapeMenu(false);
                      }}
                    >
                      <Icon name={name === 'rectangle' ? 'shape' : name} size={14} />
                      {shapes[name]}
                      <kbd>{shapeKeys[name]}</kbd>
                    </button>
                  ))}
                </div>
              )}
            </span>
          ))}
          <i className="dz-sep" />
          <a
            className={`dz-tool${selection ? '' : ' disabled'}`}
            aria-label="View the board’s HTML"
            title="View the board’s HTML"
            href={
              selection && base
                ? `${boardSrc.get(selection.board)?.base ?? base}/boards/${encodeURIComponent(selection.board)}`
                : undefined
            }
            target="_blank"
            rel="noreferrer"
          >
            <Icon name="code" size={18} />
          </a>
        </div>
      </div>
      <RightPanel
        project={project}
        design={design.data}
        canvas={canvas}
        section={section}
        selection={selection}
        frames={frames}
        tokens={tokens}
        revision={revision}
        view={view}
        onZoom={(zoom) => {
          const host = stage.current?.querySelector('.dz-canvas');
          if (zoom === 'fit') return section && fitTo(section.boards);
          if (!host) return;
          const cx = host.clientWidth / 2;
          const cy = host.clientHeight / 2;
          setView((current) => ({
            z: zoom,
            x: cx - ((cx - current.x) * zoom) / current.z,
            y: cy - ((cy - current.y) * zoom) / current.z,
          }));
        }}
        changes={changes}
        select={select}
        owner={owner}
        tab={tab}
        setTab={setTab}
        commentCount={comments.filter((comment) => !comment.resolved).length}
        onAsk={() => setAsking(true)}
        propose={propose}
        agents={agents}
        onComment={() => {
          setTab('comments');
          setCommentFocus((n) => n + 1);
        }}
        htmlHref={
          selection && base
            ? `${boardSrc.get(selection.board)?.base ?? base}/boards/${encodeURIComponent(selection.board)}`
            : null
        }
        onEdit={editable ? edit : undefined}
        component={componentPanel}
        comments={
          project ? (
            <CommentsPanel
              projectId={project.id}
              commit={shown?.commit}
              selection={selection}
              select={select}
              comments={comments}
              refresh={refreshComments}
              focus={commentFocus}
              nameFor={nameFor}
            />
          ) : null
        }
        agent={
          overlay && ask && project ? (
            <AgentPanel
              projectId={project.id}
              ask={ask}
              changes={lastChanges}
              canvas={canvas}
              skipped={skipped}
              setSkipped={setSkipped}
              busy={accepting}
              onAccept={(paths) => void accept(paths)}
              onDiscard={closeTask}
              select={select}
              nameFor={nameFor}
            />
          ) : null
        }
      />
      <div className={`dz-sheet-scrim${selection ? ' on' : ''}`} onClick={() => select(null)} />
    </div>
  );
}
