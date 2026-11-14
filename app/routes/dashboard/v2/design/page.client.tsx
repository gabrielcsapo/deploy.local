'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-flight-router/client';
import { Skeleton, Action, Dialog, Empty, Field, Icon, type IconName } from '@/components/ui';
import type { Project } from '../../../../../shared/v2/contracts';
import { getAuth } from '../../detail/shared';
import { useInbox } from '../data/hooks';
import { useDataSeed, readSeeded } from '../data/seeds';
import {
  designPanelHidden,
  rememberDesignPanel,
  type DesignPanel,
} from '../data/sidebar-preference';
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
import { CommentsPanel, useComments, type Comment } from './Comments';
import {
  bounds,
  fit,
  boardName,
  nameOf,
  type LayerChange,
  readTokens,
  isMark,
  sectionAt,
  sections as readSections,
  type Design,
  type DesignLink,
  type Mark,
  type Note,
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
import { Play } from './Play';
import { PickSheet } from './Pickers';
import './style.css';
import { ToReview } from './ToReview';
import { reviewHref } from './review-model';
import { CanvasReviewBar, useCanvasReview } from './CanvasReview';
import {
  reviewProject,
  reviewBranch,
  reviewFrames,
  reviewCanvas,
  reviewKey,
  reviewFeedback,
  stepFrame,
} from './canvas-review-model';

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
  const [params, setParams] = useSearchParams();
  const reviewId = params.get('review');
  const canvasProject = reviewId
    ? reviewProject(reviewId)
    : params.get('view') === 'canvas' ||
        params.has('board') ||
        params.has('ref') ||
        params.has('task')
      ? params.get('project')
      : null;
  const openProject = useCallback(
    (id: string) => {
      setParams(new URLSearchParams({ project: id, view: 'canvas' }));
    },
    [setParams],
  );
  return canvasProject ? (
    <DesignCanvasPage key={`${canvasProject}:${reviewId ?? ''}`} initialProject={canvasProject} />
  ) : (
    <ToReview
      projectId={params.get('project') ?? undefined}
      alwaysList={params.get('view') === 'review'}
      openProject={openProject}
    />
  );
}

function DesignCanvasPage({ initialProject }: { initialProject: string }) {
  const seed = useDataSeed();
  const [params] = useSearchParams();
  const inbox = useInbox();
  const waiting = inbox.items.filter((item) => item.state === 'waiting');
  // Read after hydration: the server has no browser storage.
  const [owner, setOwner] = useState('');
  useEffect(() => setOwner(getAuth()?.username ?? ''), []);
  const projects = useData<{ projects: Project[] }>('/api/projects');
  const [projectId, setProjectId] = useState(initialProject);
  const project = projects.data?.projects.find((item) => item.id === projectId);
  const reviewId = params.get('review');
  const review = useCanvasReview(projectId, reviewId);
  const [ref, setRef] = useState(reviewId ? reviewBranch(reviewId) : (params.get('ref') ?? 'HEAD'));
  const reviewData = review.data;
  const reviewBoards = useMemo(() => (reviewData ? reviewFrames(reviewData) : []), [reviewData]);
  const reviewByFile = useMemo(
    () => new Map(reviewBoards.map((board) => [board.file, board])),
    [reviewBoards],
  );
  const readRef = reviewData && reviewData.item.state !== 'waiting' ? reviewData.after : ref;
  // The design loads from the id in the address, alongside the project list rather than after it.
  const designPath =
    projectId && (!reviewId || reviewData)
      ? `/api/projects/${encodeURIComponent(projectId)}/design?ref=${encodeURIComponent(readRef)}`
      : undefined;
  const design = useData<Design>(designPath);
  const beforeDesign = useData<Design>(
    reviewData
      ? `/api/projects/${encodeURIComponent(projectId)}/design?ref=${encodeURIComponent(reviewData.before)}`
      : undefined,
  );
  useEffect(() => {
    if (!project || !design.data?.canvas || !Object.keys(design.data.canvas.boards).length) return;
    try {
      localStorage.setItem(`deploy.design.lastProject.${owner}`, project.id);
    } catch {
      /* Storage is optional. */
    }
  }, [owner, project, design.data?.canvas]);
  // An agent's design branch, shown over yours: Mine, Overlay (its version, changes outlined), Agent's.
  const [taskId, setTaskId] = useState(reviewId ? '' : (params.get('task') ?? ''));
  const [mode, setMode] = useState<OverlayMode>('overlay');
  const [poll, setPoll] = useState(0);
  const projectApi = projectId ? `/api/projects/${encodeURIComponent(projectId)}/design` : '';
  const agentDesign = useData<Design>(
    project && taskId ? `${projectApi}?task=${encodeURIComponent(taskId)}&v=${poll}` : undefined,
  );
  const agentChanges = useData<{ files: Change[] }>(
    project && taskId
      ? `${projectApi}/changes?task=${encodeURIComponent(taskId)}&v=${poll}`
      : undefined,
  );
  const { asks } = useAsks(projectId, poll);
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
  // Pen marks you changed show at once; the canvas from the server catches up after each commit.
  const [markEdits, setMarkEdits] = useState<Record<string, Partial<Note> | null>>({});
  useEffect(() => setMarkEdits({}), [shown?.commit]);
  const canvas = useMemo(() => {
    const saved = reviewId
      ? reviewCanvas(shown?.canvas ?? null, beforeDesign.data?.canvas ?? null, reviewBoards)
      : (shown?.canvas ?? null);
    if (!saved || !Object.keys(markEdits).length) return saved;
    const notes = { ...saved.notes };
    for (const [id, patch] of Object.entries(markEdits))
      if (patch === null) delete notes[id];
      else if (notes[id]) notes[id] = { ...notes[id], ...patch };
    return { ...saved, notes };
  }, [shown, markEdits, reviewId, beforeDesign.data, reviewBoards]);
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
    `/api/projects/${encodeURIComponent(projectId)}/design/files/${commit}`;
  const base = projectId && shown && frameCommit ? filesAt(frameCommit) : null;
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
  const [connections, setConnections] = useState(false);
  useEffect(() => {
    try {
      setConnections(localStorage.getItem(`deploy.design.connections.${owner}`) === 'true');
    } catch {
      // Connections still work without device storage.
    }
  }, [owner]);
  const toggleConnections = useCallback(() => {
    setConnections((current) => {
      try {
        localStorage.setItem(`deploy.design.connections.${owner}`, String(!current));
      } catch {
        // Keep the choice for this visit when storage is unavailable.
      }
      return !current;
    });
  }, [owner]);
  const [tab, setTab] = useState<'edit' | 'prototype' | 'comments'>('edit');
  const [commentFocus, setCommentFocus] = useState(0);
  const { comments, refresh: refreshComments } = useComments(projectId);
  const [asking, setAsking] = useState(false);
  // Agents working on this design right now: a light poll of the coordinator's presence.
  const [agents, setAgents] = useState<AgentPresence[]>(
    () =>
      (seed?.data[`${projectApi}/presence`] as { agents: AgentPresence[] } | undefined)?.agents ??
      [],
  );
  useEffect(() => {
    if (!projectApi) return;
    let live = true;
    const look = () =>
      readSeeded(seed, `${projectApi}/presence`, () =>
        request<{ agents: AgentPresence[] }>(`${projectApi}/presence`),
      )
        .then((value) => live && setAgents(value.agents))
        .catch(() => undefined);
    look();
    const timer = window.setInterval(look, 3000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [projectApi, seed]);
  const proposals = useData<{
    proposals: {
      id: string;
      title: string;
      state: string;
      boards: string[];
      branch?: string | null;
    }[];
  }>(project ? `${projectApi}/proposals?v=${poll}` : undefined);
  const [proposing, setProposing] = useState(false);
  const [proposalOpen, setProposalOpen] = useState(false);
  const [proposalTitle, setProposalTitle] = useState('');
  const [proposalSummary, setProposalSummary] = useState('');
  const [proposalError, setProposalError] = useState('');
  const sendProposal = async () => {
    if (!proposalTitle.trim() || !proposalSummary.trim()) return;
    setProposing(true);
    try {
      await request(`${projectApi}/propose`, {
        method: 'POST',
        body: JSON.stringify({ ref, title: proposalTitle.trim(), summary: proposalSummary.trim() }),
      });
      setPoll((n) => n + 1);
      setProposalOpen(false);
      setProposalTitle('');
      setProposalSummary('');
      setProposalError('');
    } catch (failure) {
      setProposalError((failure as Error).message);
    } finally {
      setProposing(false);
    }
  };
  // In review only while the waiting request is for the branch as it is now; new edits since
  // make it something to propose again.
  const inReview = proposals.data?.proposals.some(
    (item) =>
      item.state === 'waiting' &&
      item.id ===
        `design:${project?.id}:${ref.replaceAll('/', '~')}:${design.data?.commit.slice(0, 12)}`,
  );
  const reviewedEarlier =
    !inReview &&
    proposals.data?.proposals.some(
      (item) =>
        item.state === 'waiting' &&
        item.id.startsWith(`design:${project?.id}:${ref.replaceAll('/', '~')}:`),
    );
  const tokensData = useData<unknown>(base ? `${base}/ds/deploy-local/tokens.json` : undefined);
  const tokens = useMemo(
    () => (tokensData.data ? readTokens(tokensData.data) : noTokens),
    [tokensData.data],
  );
  const branchChanges = useChanges(reviewId ? undefined : projectId, ref, design.data?.commit);
  const changes = useMemo(
    () =>
      reviewId
        ? reviewBoards.map((board) => ({
            status: board.status,
            path: `design/boards/${board.file}`,
            layers: undefined,
          }))
        : branchChanges,
    [reviewId, reviewBoards, branchChanges],
  );
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
  const [narrowMenu, setNarrowMenu] = useState(false);
  // On a phone, the sheet that picks the project, branch and page.
  const [pickSheet, setPickSheet] = useState(false);
  // On a phone, Layers opens as a sheet from the tool bar.
  const [layersOpen, setLayersOpen] = useState(false);
  // Each panel closes on its own, for more canvas, and stays that way on this device.
  const [hidden, setHidden] = useState({ left: false, right: false });
  // Read after hydration: the server has no browser storage.
  useEffect(
    () => setHidden({ left: designPanelHidden('left'), right: designPanelHidden('right') }),
    [],
  );
  const showPanel = useCallback((panel: DesignPanel, show: boolean) => {
    rememberDesignPanel(panel, !show);
    setHidden((state) => ({ ...state, [panel]: !show }));
  }, []);
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
    const named =
      selection && canvas.boards[selection.board]
        ? [selection.board]
        : reviewBoards[0]
          ? [reviewBoards[0].file]
          : section.boards;
    requestAnimationFrame(() => fitTo(named));
  }, [canvas, section, frameCommit, selection, fitTo, reviewBoards]);

  const fittedNote = useRef('');
  useEffect(() => {
    if (!reviewData || reviewData.boards.length || !canvas || fittedNote.current === reviewData.id)
      return;
    const note = canvas.notes?.[reviewData.notes[0]?.id];
    if (note) {
      fittedNote.current = reviewData.id;
      setView({ z: 1, x: 48 - note.x, y: 72 - note.y });
    }
  }, [reviewData?.id, canvas, reviewData]);

  // A pen mark on the canvas, selected instead of a board or a layer.
  const [mark, setMarkId] = useState<string | null>(null);
  const select = useCallback((next: Selection) => {
    setSelection(next);
    if (next) setMarkId(null);
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
  const editable = Boolean(
    project &&
    design.data &&
    !(overlay && mode !== 'mine') &&
    (!reviewId || (reviewData?.item.state === 'waiting' && review.side === 'after')),
  );
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
    // The pen keeps inking, as Apple Pencil markup does; the other tools draw once.
    if (!('canvas' in drawn && drawn.canvas === 'mark')) setTool('move');
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
    if (drawn.canvas === 'mark')
      return send<{ branch: string; commit: string; made: string }>(
        '/canvas',
        { op: 'mark', points: drawn.points },
        (result) => chooseMark(result.made),
      );
    send('/canvas', { op: 'note', x: drawn.x, y: drawn.y, text: drawn.text }, () => undefined);
  };
  const chooseMark = (id: string | null) => {
    setMarkId(id);
    if (id) {
      setSelection(null);
      setPicked(null);
      remember({ board: null, layer: null });
    }
  };
  type MarkPatch = Partial<Mark & { x: number; y: number; w: number; h: number }>;
  const editMark = (id: string, patch: MarkPatch) => {
    setMarkEdits((current) => ({ ...current, [id]: { ...current[id], ...patch } }));
    send('/canvas', { op: 'mark', id, ...patch }, () => undefined);
  };
  // Prototype: every link between boards at the commit on screen, with links you just set on top.
  const linkData = useData<{ links: DesignLink[] }>(
    projectApi && shown ? `${projectApi}/links?ref=${shown.commit}` : undefined,
  );
  const [linkEdits, setLinkEdits] = useState<Record<string, DesignLink | null>>({});
  useEffect(() => setLinkEdits({}), [linkData.data]);
  const links = useMemo(() => {
    const keyOf = (link: { from: string; layer: string }) => `${link.from}:${link.layer}`;
    const kept = (linkData.data?.links ?? []).filter((link) => !(keyOf(link) in linkEdits));
    return [
      ...kept,
      ...Object.values(linkEdits).filter((link): link is DesignLink => Boolean(link)),
    ];
  }, [linkData.data, linkEdits]);
  const [sidebarLinks, setSidebarLinks] = useState(false);
  const setLink = (board: string, layer: string, to: string | null) => {
    const element = layerElement(frames, board, layer);
    if (element)
      if (to) element.setAttribute('href', to);
      else element.removeAttribute('href');
    setLinkEdits((current) => ({
      ...current,
      [`${board}:${layer}`]: to
        ? {
            from: board,
            layer,
            to,
            text: element?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 80) ?? '',
            sidebar: Boolean(element?.closest('.dl-side, .rail, .dz-rail')),
          }
        : null,
    }));
    setRevision((n) => n + 1);
    send<{ branch: string; commit: string }>(
      '/edit',
      { board, edits: [{ op: 'link', layer, to }] },
      (result) =>
        setBoardSrc((current) =>
          new Map(current).set(board, {
            base: filesAt(result.commit),
            reload: current.get(board)?.reload ?? 0,
          }),
        ),
      (at) => reload(board, at.commit),
    );
  };
  const start = section
    ? canvas?.starts?.[section.id] && canvas.boards[canvas.starts[section.id]]
      ? canvas.starts[section.id]
      : (section.boards[0] ?? null)
    : null;
  const setStart = (board: string) =>
    section && send('/canvas', { op: 'start', page: section.id, board }, () => undefined);
  // Play: the page's boards full screen, from its start board.
  const [playing, setPlaying] = useState<string | null>(null);
  const removeMark = (id: string) => {
    setMarkId(null);
    setMarkEdits((current) => ({ ...current, [id]: null }));
    send('/canvas', { op: 'remove-note', id }, () => undefined);
  };
  const markNote = mark ? canvas?.notes?.[mark] : undefined;
  const shownMark =
    mark && markNote && isMark(markNote)
      ? { id: mark, note: markNote, page: sectionAt(sections, markNote)?.title ?? 'Canvas' }
      : null;
  // Beside this page's boards in Layers: its pen marks and the sticky notes people added, not
  // the labels the canvas is laid out with.
  const loose = section
    ? Object.entries(canvas?.notes ?? {})
        .filter(
          ([id, note]) =>
            (isMark(note) || (id.startsWith('note-') && note.text)) &&
            sectionAt(sections, note)?.id === section.id,
        )
        .map(([id, note]) => ({ id, note }))
    : [];
  const showLoose = (id: string) => {
    const note = canvas?.notes?.[id];
    if (!note) return;
    if (isMark(note)) chooseMark(id);
    const host = stage.current?.querySelector('.dz-canvas');
    if (!host) return;
    const [w, h] = [note.w ?? 240, note.h ?? 160];
    setView((current) => ({
      ...current,
      x: host.clientWidth / 2 - (note.x + w / 2) * current.z,
      y: host.clientHeight / 2 - (note.y + h / 2) * current.z,
    }));
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
        onAsk={() => setAsking(true)}
      />
    ) : undefined;
  const [shape, setShape] = useState<'rectangle' | 'ellipse' | 'line'>('rectangle');
  const [shapeMenu, setShapeMenu] = useState(false);

  const [activeReviewFile, setActiveReviewFile] = useState<string>();
  useEffect(() => {
    if (selection && reviewByFile.has(selection.board)) setActiveReviewFile(selection.board);
  }, [selection, reviewByFile]);
  const activeReviewIndex = Math.max(
    0,
    reviewBoards.findIndex((board) => board.file === activeReviewFile),
  );
  const focusReviewFrame = useCallback(
    (file: string) => {
      const page = sections.find((entry) => entry.boards.includes(file));
      if (page) {
        setSectionId(page.id);
        remember({ page: page.id });
      }
      select({ board: file, layer: null });
      requestAnimationFrame(() => fitTo([file]));
    },
    [sections, select, fitTo],
  );
  const stepReview = (delta: number) => {
    const next = stepFrame(reviewBoards, activeReviewFile, delta);
    if (next) focusReviewFrame(next);
  };
  useEffect(() => {
    if (!reviewId) return;
    const key = (event: KeyboardEvent) => {
      const editing = Boolean(
        (event.target as HTMLElement)?.closest?.(
          'input:not([type="checkbox"]):not([type="radio"]),textarea,select,[contenteditable],[role="dialog"],dialog,[role="slider"]',
        ),
      );
      // Native Space activates a focused checkbox/button; arrows still navigate frames.
      if (
        event.key === ' ' &&
        (event.target as HTMLElement)?.closest?.(
          'button,a,input[type="checkbox"],input[type="radio"]',
        )
      )
        return;
      const action = reviewKey(event, editing);
      if (!action) return;
      event.preventDefault();
      if (action === 'approve') {
        const board = reviewBoards[activeReviewIndex];
        if (board && (!selection || selection.board === board.file))
          void review.approveFrame(board.file);
      } else stepReview(action === 'previous' ? -1 : 1);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
    // Keep the handler in sync with the current frame and approval state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    reviewId,
    reviewBoards,
    activeReviewIndex,
    activeReviewFile,
    selection,
    focusReviewFrame,
    review.approveFrame,
  ]);
  const reviewNavigation = (
    <>
      <button
        className="dz-tool"
        type="button"
        aria-label="Previous changed frame"
        disabled={!reviewBoards.length || activeReviewIndex === 0}
        onClick={() => stepReview(-1)}
      >
        ‹
      </button>
      <span className="dz-review-step">
        {reviewBoards.length ? activeReviewIndex + 1 : 0} of {reviewBoards.length}
      </span>
      <button
        className="dz-tool"
        type="button"
        aria-label="Next changed frame"
        disabled={!reviewBoards.length || activeReviewIndex === reviewBoards.length - 1}
        onClick={() => stepReview(1)}
      >
        ›
      </button>
      <i className="dz-sep" />
    </>
  );

  const chooseSection = (id: string) => {
    setSectionId(id);
    remember({ page: id, board: null, layer: null });
    setSelection(null);
    const next = sections.find((item) => item.id === id);
    if (next) requestAnimationFrame(() => fitTo(next.boards));
  };
  const chooseRef = (next: string) => {
    if (reviewId) {
      window.location.assign(
        `/dashboard/design?project=${encodeURIComponent(projectId)}&view=canvas&ref=${encodeURIComponent(next)}`,
      );
      return;
    }
    setRef(next);

    remember({ ref: next === 'HEAD' ? null : next });
  };
  const newBranch = async () => {
    const name = window.prompt('Name the design branch', '');
    if (!name || !project) return;
    try {
      const { branch } = await request<{ branch: { name: string } }>(
        `/api/projects/${encodeURIComponent(project.id)}/design/branches`,
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
      if (
        event.shiftKey &&
        event.key.toLowerCase() === 'c' &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        event.preventDefault();
        toggleConnections();
        return;
      }
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
        if ((event.key === 'Delete' || event.key === 'Backspace') && mark) removeMark(mark);
      }
      if ((event.key === 'c' || event.key === 'C') && !event.metaKey && !event.ctrlKey)
        setTool('comment');
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey) && selection) {
        event.preventDefault();
        setAsking(true);
      }
      if (event.key === 'Escape') {
        select(null);
        setMarkId(null);
        setTool('move');
        setShapeMenu(false);
      }
      if (event.shiftKey && event.key === '!' && section) fitTo(section.boards);
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
    // removeLayer changes with every render; the listener is added again with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, fitTo, select, selection, editable, mark, toggleConnections]);

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
    !reviewId && ref.startsWith('design/') && changes.length && project
      ? {
          state: (proposing ? 'busy' : inReview ? 'in-review' : 'ready') as
            | 'ready'
            | 'busy'
            | 'in-review',
          note: inReview
            ? 'Waiting on you: approve it there or in the task'
            : reviewedEarlier
              ? 'Propose again: it changed since you proposed it'
              : `Ask to approve ${ref}`,
          run: () => setProposalOpen(true),
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
  const reviewingBranches = new Set(
    (proposals.data?.proposals ?? [])
      .filter((item) => item.state === 'waiting' && item.branch)
      .map((item) => item.branch!),
  );
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
      className={`dz${selection || inAssets ? ' has-selection' : ''}${asking ? ' asking' : ''}${hidden.left ? ' left-hidden' : ''}${hidden.right ? ' right-hidden' : ''}${layersOpen ? ' layers-open' : ''}`}
      ref={stage}
    >
      <Dialog
        className="dl-propose-dialog"
        open={proposalOpen}
        onClose={() => !proposing && setProposalOpen(false)}
        title="Propose for review"
        actions={
          <>
            <Action disabled={proposing} onClick={() => setProposalOpen(false)}>
              Cancel
            </Action>
            <Action
              variant="primary"
              disabled={proposing || !proposalTitle.trim() || !proposalSummary.trim()}
              onClick={() => void sendProposal()}
            >
              Propose
            </Action>
          </>
        }
      >
        <form
          className="dl-propose-form"
          onSubmit={(event) => {
            event.preventDefault();
            void sendProposal();
          }}
        >
          <Field
            label="What is this?"
            required
            maxLength={200}
            value={proposalTitle}
            onChange={(event) => setProposalTitle(event.target.value)}
          />
          <label>
            What changed, and why?
            <textarea
              className="dl-textarea"
              required
              maxLength={4000}
              value={proposalSummary}
              onChange={(event) => setProposalSummary(event.target.value)}
            />
          </label>
          <p className="dl-meta">The reviewer reads this first.</p>
          {proposalError && <p role="alert">{proposalError}</p>}
        </form>
      </Dialog>
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700&display=swap"
      />
      <div className="dz-phone-bar">
        <button
          type="button"
          className="dl-icon-btn"
          aria-label="Show sidebar"
          onClick={() => window.dispatchEvent(new Event('deploy:v2-sidebar'))}
        >
          <Icon name="menu" />
        </button>
        <span className="dz-phone-title">
          <b>{selection ? boardName(selection.board) : 'Designs'}</b>
          <button
            type="button"
            className="dz-phone-sub"
            aria-haspopup="dialog"
            aria-expanded={pickSheet}
            onClick={() => setPickSheet(true)}
          >
            {project?.name ?? ''}
            {' · '}
            <Icon name="branch" size={11} />
            {selection
              ? ref === 'HEAD'
                ? 'main'
                : ref
              : (section?.title.replace(/^[\w]+\s·\s/, '') ?? '')}
            <Icon name="down" size={10} />
          </button>
        </span>
        <button
          type="button"
          className="dl-icon-btn"
          aria-label="Comments"
          onClick={() => {
            setTab('comments');
            if (!selection && section?.boards[0]) select({ board: section.boards[0], layer: null });
          }}
        >
          <Icon name="comment" size={18} />
        </button>
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
      <div className="dz-narrow-bar">
        <a
          className="dl-icon-btn"
          aria-label="Back to Artifacts"
          href="/dashboard/design?view=review"
        >
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
            <span className="dz-narrow-title">Artifacts</span>
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
      <LeftPanel
        projects={projects.data?.projects ?? []}
        project={project}
        onProject={(id) => {
          if (reviewId) {
            window.location.assign(
              `/dashboard/design?project=${encodeURIComponent(id)}&view=canvas`,
            );
            return;
          }
          setProjectId(id);
          try {
            localStorage.setItem(`deploy.design.lastProject.${owner}`, id);
          } catch {
            /* Storage is optional. */
          }
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
        owner={owner}
        reviewing={reviewingBranches}
        onRef={chooseRef}
        onNewBranch={newBranch}
        inReview={inReviewBoards}
        agentAt={agentAt}
        onHide={() => showPanel('left', false)}
        onCloseSheet={() => setLayersOpen(false)}
        loose={loose}
        mark={mark}
        onLoose={showLoose}
        links={tab === 'prototype' || connections ? links : undefined}
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
        {reviewId && (
          <CanvasReviewBar
            review={review}
            suggestions={
              reviewData ? reviewFeedback(reviewData, comments, ref, design.data?.commit) : ''
            }
            beforeDecision={async (action) => {
              await queue.current;
              if (!reviewData) return '';
              if (action !== 'changes') return '';
              const latest = await request<{ comments: Comment[] }>(`${projectApi}/comments`);
              return reviewFeedback(
                reviewData,
                latest.comments,
                head.current?.ref ?? ref,
                head.current?.commit ?? design.data?.commit,
              );
            }}
          />
        )}
        {!reviewId &&
          (proposals.data?.proposals.filter((entry) => entry.state === 'waiting').length ?? 0) >
            0 && (
            <div className="dl-design-waiting-banner">
              <span>
                {proposals.data!.proposals.filter((entry) => entry.state === 'waiting').length}{' '}
                design
                {proposals.data!.proposals.filter((entry) => entry.state === 'waiting').length === 1
                  ? ''
                  : 's'}{' '}
                waiting on you
                {proposals.data!.proposals.filter((entry) => entry.state === 'waiting').length === 1
                  ? ` · ${proposals.data!.proposals.find((entry) => entry.state === 'waiting')!.title}`
                  : ''}
              </span>
              <a
                href={
                  proposals.data!.proposals.filter((entry) => entry.state === 'waiting').length ===
                  1
                    ? reviewHref(
                        proposals.data!.proposals.find((entry) => entry.state === 'waiting')!.id,
                      )
                    : `/dashboard/design?project=${encodeURIComponent(projectId)}&view=review`
                }
              >
                Review
              </a>
            </div>
          )}
        {(hidden.left || hidden.right) && (
          <div className="dz-panel-shows">
            {hidden.left && (
              <button
                type="button"
                className="dz-panel-show left"
                aria-label="Show left panel"
                title="Show left panel"
                onClick={() => showPanel('left', true)}
              >
                <Icon name="sidebar" size={15} />
              </button>
            )}
            {hidden.right && (
              <button
                type="button"
                className="dz-panel-show right"
                aria-label="Show right panel"
                title="Show right panel"
                onClick={() => showPanel('right', true)}
              >
                <Icon name="panel" size={15} />
              </button>
            )}
          </div>
        )}
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
            review={
              reviewId
                ? {
                    api: review.api,
                    item: reviewId,
                    boards: reviewByFile,
                    side: review.side,
                    approve: review.approveFrame,
                    busy: review.busy,
                    waiting: reviewData?.item.state === 'waiting',
                  }
                : undefined
            }
            onFollow={reviewId ? focusReviewFrame : undefined}
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
            mark={mark}
            onMark={chooseMark}
            onMoveMark={editable ? (id, x, y) => editMark(id, { x, y }) : undefined}
            connections={connections ? { links, sidebar: sidebarLinks } : null}
            prototype={
              tab === 'prototype'
                ? {
                    links,
                    sidebar: sidebarLinks,
                    start,
                    onLink: editable ? (board, layer, to) => setLink(board, layer, to) : undefined,
                  }
                : null
            }
          />
        ) : (
          <Skeleton block label="Loading the design" />
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
        {asking && (selection || inAssets) && project && design.data && (
          <AskPopover
            projectId={project.id}
            designRef={ref}
            selection={selection}
            component={
              !selection && inAssets
                ? { id: inAssets.component.id, name: inAssets.component.name }
                : undefined
            }
            target={
              !selection
                ? `the ${inAssets!.component.name} component`
                : selection.layer
                  ? nameFor(selection.board, selection.layer)
                  : boardName(selection.board)
            }
            comments={
              selection
                ? comments.filter(
                    (comment) =>
                      !comment.resolved &&
                      comment.board === selection.board &&
                      (!selection.layer || comment.layer === selection.layer),
                  ).length
                : 0
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
          {reviewId && reviewNavigation}
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
          <button
            type="button"
            className={`dz-tool dz-connections-toggle${connections ? ' on' : ''}`}
            aria-label="Connections"
            title="Connections ⇧C"
            aria-pressed={connections}
            onClick={toggleConnections}
          >
            <Icon name="connections" size={18} />
          </button>
        </div>
        <div className="dz-phone-hud">
          <span className="dz-phone-zoom">{Math.round(view.z * 100)}%</span>
          {!selection && <span className="dz-phone-hint">Pinch to zoom · double-tap a board</span>}
        </div>
        <div className="dz-phone-tools" role="toolbar" aria-label="Tools">
          {reviewId && reviewNavigation}
          {(
            [
              ['move', 'move', 'Move'],
              ['pen', 'pen', 'Pen'],
              ['text', 'text', 'Text'],
              ['sticky', 'sticky', 'Sticky note'],
              ['comment', 'comment', 'Comment'],
            ] as const
          ).map(([id, icon, label]) => (
            <button
              key={id}
              type="button"
              className={`dz-tool${tool === id ? ' on' : ''}`}
              aria-label={label}
              aria-pressed={tool === id}
              disabled={id !== 'move' && id !== 'comment' && !editable}
              onClick={() => setTool(id)}
            >
              <Icon name={icon} size={18} />
            </button>
          ))}
          <button
            type="button"
            className={`dz-tool${layersOpen ? ' on' : ''}`}
            aria-label="Layers"
            aria-pressed={layersOpen}
            onClick={() => setLayersOpen(!layersOpen)}
          >
            <Icon name="layers" size={18} />
          </button>
          <button
            type="button"
            className={`dz-tool dz-connections-toggle${connections ? ' on' : ''}`}
            aria-label="Connections"
            title="Connections ⇧C"
            aria-pressed={connections}
            onClick={toggleConnections}
          >
            <Icon name="connections" size={18} />
          </button>
        </div>
      </div>
      <RightPanel
        onHide={() => showPanel('right', false)}
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
        select={
          reviewId
            ? (next) => {
                if (next) {
                  focusReviewFrame(next.board);
                  if (next.layer) select(next);
                } else select(null);
              }
            : select
        }
        owner={owner}
        tab={tab}
        setTab={setTab}
        commentCount={comments.filter((comment) => !comment.resolved).length}
        onAsk={() => setAsking(true)}
        propose={propose}
        review={reviewData}
        reviewing={Boolean(reviewId)}
        reviewSide={review.side}
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
        mark={shownMark}
        onMark={editable && shownMark ? (patch) => editMark(shownMark.id, patch) : undefined}
        onRemoveMark={editable && shownMark ? () => removeMark(shownMark.id) : undefined}
        connections={connections}
        onConnections={toggleConnections}
        onConnection={(board) => {
          const page = sections.find((item) => item.boards.includes(board));
          if (!page) return;
          setSectionId(page.id);
          select({ board, layer: null });
          remember({ page: page.id });
          requestAnimationFrame(() => fitTo([board]));
        }}
        prototype={{
          links,
          sidebar: sidebarLinks,
          setSidebar: setSidebarLinks,
          start,
          onStart: editable ? setStart : undefined,
          onLink: editable ? setLink : undefined,
        }}
        onPlay={start && canvas ? () => setPlaying(start) : undefined}
        component={componentPanel}
        comments={
          project ? (
            <CommentsPanel
              projectId={project.id}
              commit={reviewData?.after ?? shown?.commit}
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
      <PickSheet
        open={pickSheet}
        onClose={() => setPickSheet(false)}
        first={selection ? 'branch' : 'page'}
        projects={projects.data?.projects ?? []}
        project={project}
        onProject={(id) => {
          if (reviewId) {
            window.location.assign(
              `/dashboard/design?project=${encodeURIComponent(id)}&view=canvas`,
            );
            return;
          }
          setProjectId(id);
          try {
            localStorage.setItem(`deploy.design.lastProject.${owner}`, id);
          } catch {
            /* Storage is optional. */
          }
          setRef('HEAD');
          setSelection(null);
          remember({ project: id, ref: null, board: null, layer: null, page: null });
        }}
        branches={design.data?.branches ?? []}
        current={ref}
        owner={owner}
        reviewing={reviewingBranches}
        onRef={chooseRef}
        onNewBranch={() => void newBranch()}
        sections={sections}
        section={section}
        onSection={chooseSection}
      />
      {playing && canvas && base && (
        <Play
          canvas={canvas}
          start={playing}
          src={(board) =>
            `${boardSrc.get(board)?.base ?? base}/boards/${encodeURIComponent(board)}`
          }
          onClose={() => setPlaying(null)}
        />
      )}
    </div>
  );
}
