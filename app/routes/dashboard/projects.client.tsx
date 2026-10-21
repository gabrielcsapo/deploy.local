'use client';
import { ActionCluster, IconButton, OverflowMenu } from '@/components/ui';
import { uploadProgress, type MediaUploadState } from './video-state';
import { Button, StatusBadge, CompactTopBar, CollapsibleMessage } from '@/components/ui';
import {
  useEffect,
  useCallback,
  useLayoutEffect,
  useState,
  useRef,
  useMemo,
  type ReactNode,
} from 'react';
import { Link, useRouter, useLocation, useSearchParams } from 'react-flight-router/client';
import './workspace.css';
import './attachments.css';
import '../../design-tokens.css';
import '../../native-workspace.css';
import {
  workspaceRequest,
  WorkspaceRequestError,
  workspaceConnectionMessage,
} from './command-journal';
import { TaskActivity } from './task-activity.client';
import { TaskActivityPanel, CheckVerdicts, type ActivityFocus } from './task-activity-panel.client';
import { activitySummary, activeJob, jobStatus, jobTitle } from './task-activity-summary';
import { taskCardWidth, composerActivityVisible } from './interaction-layout';
import { useTranscriptLayoutAnchor } from './transcript-layout.client';
import { ActivityRail, useActivityRail } from './task-activity-rail.client';
import { TaskQuestion } from './task-question.client';
import { ControlRequestCard } from './control-request.client';
import { WorkspaceIcon } from './workspace-icon';
import { VoiceInput } from './voice-input.client';
import { ComposerControls } from './composer-controls.client';
import { ComposerContext, PhoneComposerContext } from './composer-context.client';
import { SurfaceNavigation, useWorkspaceKeyboard } from './workspace-navigation.client';
import { ProjectHub } from './project-hub.client';
import { RepositoryLibrary } from './repository-library.client';
import { repositoryRoute, repositoryURL } from './repository-navigation';
import { ControlPanel } from './control-panel.client';
import { WorkspaceRail } from './workspace-rail.client';
import { SidebarResizeHandle, useSidebarResize } from './workspace-resize.client';
import { MarkupButton, markupAttachedEvent } from './image-markup.client';
import { AttachmentImage, AttachmentStrip, uploadImage } from './attachments.client';
import {
  attachmentChips,
  attachmentDraftKey,
  restoreAttachmentDraft,
  type Attachment,
} from './attachment-state';
import { MessageContent } from './message-content.client';
import type { MessageFileLinks } from './message-content.client';
import type { TaskFileReference } from './task-file-link';
import { TaskCard } from './task-card.client';
import { ReplyActions } from './reply-actions.client';
import './conversation-chrome.css';
import { AgentContext } from './agent-context.client';
import { indexTranscript } from './transcript-index';
import { TaskResource } from './task-resource';
import { TaskPublish } from './task-publish.client';
import { taskTitle } from '../../../shared/task-title';
import { checkSummary } from './task-review';
import { TaskTree } from './task-tree.client';
import { taskStatus } from './task-tree';
import { parseTaskDiff, taskDiffIndex } from './task-diff';
import { useWorkspacePerformance } from './workspace-performance';
import { LoginForm } from './data.client';
import { getAuth } from './detail/shared';
import './phone-workspace.css';
type Row = Record<string, any>;
export default function ProjectsClient({ surface }: { surface?: ReactNode } = {}) {
  const [authed, setAuthed] = useState<boolean | null>(null);
  useEffect(() => {
    setAuthed(Boolean(getAuth()));
  }, []);
  if (authed === null)
    return (
      <div className="ds-feedback" role="status">
        Connecting to workspace…
      </div>
    );
  if (!authed) return <LoginForm onLogin={() => setAuthed(true)} />;
  return <ProjectWorkspace surface={surface} />;
}
function ProjectWorkspace({ surface }: { surface?: ReactNode }) {
  const { navigate } = useRouter();
  const { pathname } = useLocation();
  const [searchParams] = useSearchParams();
  const repositoryLocation = repositoryRoute(pathname);
  const repositoryView = repositoryLocation !== null;
  useWorkspaceKeyboard();
  const sidebarResize = useSidebarResize();
  const surfaceTitle = pathname.startsWith('/dashboard/design-system')
    ? 'Design system'
    : pathname.startsWith('/dashboard/settings')
      ? 'Settings'
      : pathname.startsWith('/dashboard/computers')
        ? 'Computers'
        : pathname.startsWith('/dashboard/catalog')
          ? 'Catalog'
          : pathname.startsWith('/dashboard/discover')
            ? 'Shared apps'
            : pathname.startsWith('/dashboard/logs')
              ? 'Logs'
              : pathname.startsWith('/dashboard/activity')
                ? 'Activity'
                : 'Applications';
  const applicationSurface = Boolean(
    surface &&
    surfaceTitle === 'Applications' &&
    !['/dashboard/apps', '/dashboard/apps/'].includes(pathname),
  );
  function returnToChat() {
    if (surface || repositoryView || searchParams.has('task')) void navigate('/dashboard');
  }
  const [needsAuthentication, setNeedsAuthentication] = useState(false);
  // In-flight refreshes must see expiry immediately, before React restarts the event listener.
  const authenticationRequired = useRef(false);
  authenticationRequired.current = needsAuthentication;
  const [signingIn, setSigningIn] = useState(false);
  const account = useRef(getAuth()?.username);
  const [state, setState] = useState<Row>({ projects: [], tasks: [], workers: [], adapters: [] }),
    [selected, setSelected] = useState(() =>
      typeof window !== 'undefined'
        ? new URLSearchParams(window.location.search).get('task') ||
          localStorage.getItem('workspace-selected-task') ||
          ''
        : '',
    ),
    [project, setProject] = useState(''),
    [workerId, setWorkerId] = useState('local'),
    [model, setModel] = useState(''),
    [effort, setEffort] = useState(''),
    [adapter, setAdapter] = useState('codex'),
    [detail, setDetail] = useState<Row | null>(null),
    [patch, setPatch] = useState<Row | null>(null),
    [turnPatch, setTurnPatch] = useState<Row | null>(null),
    [patchError, setPatchError] = useState(''),
    [draft, setDraft] = useState(''),
    [name, setName] = useState(''),
    [source, setSource] = useState(''),
    [creatingProject, setCreatingProject] = useState(false),
    [error, setError] = useState(''),
    [connectionError, setConnectionError] = useState(''),
    [busy, setBusy] = useState(false),
    [inspector, setInspector] = useState(false),
    // The computer viewer belongs to one thread: opening it on one task never shows it on another.
    [controlTasks, setControlTasks] = useState<ReadonlySet<string>>(() => new Set()),
    [sidebar, setSidebar] = useState(false),
    [checkCommand, setCheckCommand] = useState('');
  function showControl(taskId: string | null | undefined, open: boolean) {
    if (!taskId) return;
    setControlTasks((current) => {
      if (current.has(taskId) === open) return current;
      const next = new Set(current);
      if (open) next.add(taskId);
      else next.delete(taskId);
      return next;
    });
  }
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [mediaUpload, setMediaUpload] = useState<MediaUploadState | null>(null);
  const uploadAbort = useRef<AbortController | null>(null);
  const attachmentInput = useRef<HTMLInputElement>(null);
  const attachmentKey = (taskId: string) => attachmentDraftKey(getAuth()?.username || '', taskId);
  function keepAttachments(rows: Attachment[], taskId = selected) {
    localStorage.setItem(attachmentKey(taskId), JSON.stringify(rows));
    setPendingAttachments(rows);
  }
  useEffect(() => {
    const attached = (event: Event) => {
      const attachment = (event as CustomEvent<Attachment>).detail;
      const rows = attachmentChips(
        restoreAttachmentDraft(localStorage.getItem(attachmentKey(attachment.taskId))),
        { add: attachment },
      );
      localStorage.setItem(attachmentKey(attachment.taskId), JSON.stringify(rows));
      if (selectedRef.current === attachment.taskId) {
        setPendingAttachments(rows);
        requestAnimationFrame(() => composerRef.current?.focus());
      }
    };
    window.addEventListener(markupAttachedEvent, attached);
    return () => window.removeEventListener(markupAttachedEvent, attached);
  }, []);
  async function addImages(files: File[]) {
    if (!files.length || uploading) return;
    setUploading(true);
    try {
      let task = detail?.task;
      if (!task) {
        task = await api('/tasks', {
          projectId: project || undefined,
          title: taskTitle(draft || 'Images'),
          workerId,
        });
        localStorage.setItem('workspace-draft-' + task.id, draft);
        selectedRef.current = task.id;
        setSelected(task.id);
        setDetail({ task, messages: [], runs: [], events: [] });
      }
      let rows = restoreAttachmentDraft(localStorage.getItem(attachmentKey(task.id)));
      for (const file of files) {
        if (rows.length >= 20) throw new Error('At most 20 attachments per message');
        const controller = new AbortController();
        uploadAbort.current = controller;
        setMediaUpload({ name: file.name, loaded: 0, total: file.size, cancelled: false });
        const uploaded = await uploadImage(task.id, file, {
          signal: controller.signal,
          progress: (loaded, total) =>
            setMediaUpload({ name: file.name, loaded, total, cancelled: false }),
        });
        rows = attachmentChips(
          restoreAttachmentDraft(localStorage.getItem(attachmentKey(task.id))),
          { add: uploaded },
        );
        localStorage.setItem(attachmentKey(task.id), JSON.stringify(rows));
        if (selectedRef.current === task.id) setPendingAttachments(rows);
      }
    } catch (failure: any) {
      setError(failure.message);
    } finally {
      setUploading(false);
      setMediaUpload(null);
      uploadAbort.current = null;
    }
  }
  useEffect(() => {
    const toggle = () => setSidebar((open) => !open);
    const resize = () => {
      if (!matchMedia('(max-width:760px)').matches) setSidebar(false);
      if (!matchMedia('(width < 640px)').matches) setTaskSection('conversation');
    };
    window.addEventListener('resize', resize);
    window.addEventListener('deploy:toggle-navigation', toggle);
    return () => {
      window.removeEventListener('deploy:toggle-navigation', toggle);
      window.removeEventListener('resize', resize);
    };
  }, []);
  const drawerWasOpen = useRef(false);
  const drawerTrigger = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!sidebar && drawerWasOpen.current) {
      drawerWasOpen.current = false;
      (drawerTrigger.current?.isConnected
        ? [drawerTrigger.current]
        : [...document.querySelectorAll<HTMLElement>('.pw-mobile-menu')]
      )
        .find((el) => el.getClientRects().length)
        ?.focus();
    }
    const root = document.querySelector('.project-workspace');
    const compact = matchMedia(
      surface || repositoryView ? '(max-width:760px)' : '(width < 640px)',
    ).matches;
    const aside = [...(root?.querySelectorAll<HTMLElement>(':scope>.pw-sidebar') || [])].find(
      (el) => el.getClientRects().length > 0,
    );
    if (!aside) return;
    const work = root?.querySelectorAll<HTMLElement>(
      ':scope>.pw-chat,:scope>.pw-surface,:scope>.pw-context,:scope>.workspace-rail,:scope>.workspace-tabs,:scope>.compact-top-bar,:scope>.phone-task-segments',
    );
    if (sidebar && compact) {
      drawerWasOpen.current = true;
      drawerTrigger.current = document.activeElement as HTMLElement;
      aside.setAttribute('role', 'dialog');
      aside.setAttribute('aria-modal', 'true');
      work?.forEach((el) => (el.inert = true));
      aside.querySelector<HTMLElement>('button,a,select')?.focus();
    }
    return () => {
      aside.removeAttribute('role');
      aside.removeAttribute('aria-modal');
      work?.forEach((el) => (el.inert = false));
    };
  }, [sidebar, pathname, surface, repositoryView]);
  useEffect(() => setSidebar(false), [pathname]);
  const [workspaceLoaded, setWorkspaceLoaded] = useState(false);
  const projectHub =
    repositoryLocation?.valid && repositoryLocation.projectId
      ? state.projects.find((item: Row) => item.id === repositoryLocation.projectId)
      : null;
  const [repositoryTaskScope, setRepositoryTaskScope] = useState<{
    projectId: string;
    ref: string;
    path: string;
  } | null>(null);
  const [taskSection, setTaskSection] = useState(() =>
    typeof window !== 'undefined' && matchMedia('(width < 640px)').matches
      ? 'tasks'
      : 'conversation',
  );
  const [taskPanels, setTaskPanels] = useState<Record<string, string>>({});
  const reviewSection = taskPanels[selected] ?? 'changes';
  const setReviewSection = useCallback(
    (section: string) => {
      setTaskPanels((panels) => ({ ...panels, [selected]: section }));
    },
    [selected],
  );
  const summary = activitySummary(detail?.jobs, detail?.activity);
  const [jobAnnouncement, setJobAnnouncement] = useState('');
  const previousJobs = useRef<{ task: string; jobs: Row[] }>({ task: selected, jobs: [] });
  useEffect(() => {
    const before = previousJobs.current;
    const jobs = detail?.jobs ?? [];
    if (before.task === selected) {
      const finished = jobs.filter(
        (job: Row) =>
          !activeJob(job) && before.jobs.some((old) => old.id === job.id && activeJob(old)),
      );
      if (finished.length)
        setJobAnnouncement(
          finished.map((job: Row) => `${jobTitle(job)}: ${jobStatus(job)}`).join('. '),
        );
    } else setJobAnnouncement('');
    previousJobs.current = { task: selected, jobs };
  }, [detail?.jobs, selected]);
  const messageLinkRestored = useRef('');
  useEffect(() => {
    const hash = window.location.hash;
    if (
      !hash.startsWith('#message-') ||
      !detail ||
      messageLinkRestored.current === `${selected}${hash}`
    )
      return;
    let messageId: string;
    try {
      messageId = decodeURIComponent(hash.slice(1));
    } catch {
      return;
    }
    const element = document.getElementById(messageId);
    if (element) {
      messageLinkRestored.current = `${selected}${hash}`;
      followTranscript.current = false;
      element.scrollIntoView({ block: 'center' });
      element.focus({ preventScroll: true });
    }
  }, [detail, selected]);
  const activityRail = useActivityRail();
  const [activityFocus, setActivityFocus] = useState<ActivityFocus>(null);
  useEffect(() => setActivityFocus(null), [selected]);
  function openActivity(runId?: string, check?: string) {
    setActivityFocus(runId || check ? { runId, check, key: Date.now() } : null);
    activityRail.update('open');
  }
  function showJobConversation(runId: string) {
    setInspector(false);
    if (matchMedia('(width < 1100px)').matches) activityRail.update('closed');
    requestAnimationFrame(() => {
      const message = document.querySelector<HTMLElement>(
        `[data-conversation-run="${CSS.escape(runId)}"]`,
      );
      message?.scrollIntoView({
        block: 'center',
        behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
      });
      message?.focus({ preventScroll: true });
      message?.classList.add('pw-job-highlight');
      setTimeout(() => message?.classList.remove('pw-job-highlight'), 1800);
    });
  }
  // "This turn" diffs the latest turn's checkpoints; "All changes" is the cumulative task diff.
  const [diffScope, setDiffScope] = useState<'turn' | 'all'>('all');
  const diffScopeRef = useRef(diffScope);
  diffScopeRef.current = diffScope;
  const [fileFocus, setFileFocus] = useState<(TaskFileReference & { key: number }) | null>(null);
  const [fileNotice, setFileNotice] = useState<(TaskFileReference & { listed?: boolean }) | null>(
    null,
  );
  const [focusedLine, setFocusedLine] = useState<{ at: number; line: number } | null>(null);
  const [scrollCode, setScrollCode] = useState(false);
  useEffect(() => {
    const show = () => {
      if (matchMedia('(width < 640px)').matches) setTaskSection('tasks');
      setInspector(false);
      setSidebar(false);
    };
    window.addEventListener('deploy:task-list', show);
    return () => window.removeEventListener('deploy:task-list', show);
  }, []);
  const timing = useWorkspacePerformance(detail, selected);
  const timingRef = useRef(timing);
  timingRef.current = timing;
  const transcriptIndex = useMemo(
    () => indexTranscript(detail?.messages ?? [], detail?.activity ?? []),
    [detail?.messages, detail?.activity],
  );
  const readingPositions = useRef(new Map<string, { top: number; start: number; end: number }>());
  const transcriptRef = useRef<HTMLDivElement>(null);
  const followTranscript = useRef(true);
  useTranscriptLayoutAnchor(transcriptRef, !signingIn);
  const conversationRef = useRef<HTMLElement>(null);
  const [cardWidth, setCardWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const pane = conversationRef.current;
    if (!pane) return;
    const measure = () => setCardWidth(taskCardWidth(pane.clientWidth));
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    const composer = pane.querySelector<HTMLElement>('.pw-compose-area');
    const composerObserver = new ResizeObserver(() => {
      pane.style.setProperty('--composer-height', `${composer?.offsetHeight ?? 0}px`);
    });
    if (composer) composerObserver.observe(composer);
    measure();
    return () => {
      observer.disconnect();
      composerObserver.disconnect();
    };
  }, [signingIn]);
  const cardVisible = cardWidth !== null && activityRail.mode === 'closed' && !inspector;

  // Publishing, counts and checks always use all changes; the Changes view shows the chosen scope.
  const shownPatch = diffScope === 'turn' ? turnPatch : patch;
  const fileDiffs = useMemo(() => parseTaskDiff(shownPatch?.patch || ''), [shownPatch?.patch]);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const saved = readingPositions.current.get(selected);
    followTranscript.current = !saved;
    const positions = readingPositions.current,
      transcript = transcriptRef.current,
      editor = composerRef.current;
    return () => {
      positions.set(selected, {
        top: transcript?.scrollTop || 0,
        start: editor?.selectionStart || 0,
        end: editor?.selectionEnd || 0,
      });
    };
  }, [selected]);
  useLayoutEffect(() => {
    const saved = readingPositions.current.get(selected);
    if (saved && detail?.task.id === selected) {
      if (transcriptRef.current) transcriptRef.current.scrollTop = saved.top;
      composerRef.current?.setSelectionRange(saved.start, saved.end);
    }
  }, [selected, detail?.task.id]);
  const projectDialogRef = useRef<HTMLDialogElement>(null);
  const repositoryFromComposer = useRef(false);
  useLayoutEffect(() => {
    const resize = () => {
      const input = composerRef.current;
      if (!input) return;
      const phone = matchMedia('(width < 640px)').matches;
      input.rows = phone || selected ? 1 : 3;
      input.style.maxHeight = phone
        ? `${(window.visualViewport?.height || window.innerHeight) * 0.4}px`
        : '';
      input.style.height = 'auto';
      if (!phone || draft)
        input.style.height =
          (phone ? input.scrollHeight : Math.min(input.scrollHeight, 180)) + 'px';
    };
    resize();
    window.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      window.visualViewport?.removeEventListener('resize', resize);
    };
  }, [draft, selected]);
  const selectedRef = useRef(selected);
  const eventCursor = useRef(0);
  const refreshGeneration = useRef(0);
  const loadedSettings = useRef('');
  const lastMessageContent = detail?.messages?.at(-1)?.content;
  useEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript && followTranscript.current) transcript.scrollTop = transcript.scrollHeight;
  }, [selected, detail?.messages?.length, lastMessageContent]);
  selectedRef.current = selected;
  useEffect(() => {
    const openProject = (event: Event) => {
      const requestedProject = (event as CustomEvent<Row>).detail;
      if (requestedProject?.id && requestedProject?.name) {
        void navigate(
          repositoryURL(requestedProject.id, requestedProject.initialTab || 'repository'),
        );
      }
    };
    window.addEventListener('deploy:open-project', openProject);
    return () => window.removeEventListener('deploy:open-project', openProject);
  }, [navigate]);
  useEffect(() => {
    if (selected) localStorage.setItem('workspace-selected-task', selected);
    else localStorage.removeItem('workspace-selected-task');
  }, [selected]);
  const api = useCallback(async (path: string, body?: Row, signal?: AbortSignal) => {
    if (authenticationRequired.current)
      throw new WorkspaceRequestError(401, 'Sign in again to continue.');
    try {
      return await workspaceRequest(path, body, getAuth(), localStorage, fetch, signal);
    } catch (failure) {
      if (!signal?.aborted && failure instanceof WorkspaceRequestError && failure.status === 401) {
        authenticationRequired.current = true;
        setNeedsAuthentication(true);
        setConnectionError(workspaceConnectionMessage(failure));
      }
      throw failure;
    }
  }, []);
  const patchResource = useRef<TaskResource<Row> | null>(null);
  if (!patchResource.current) {
    patchResource.current = new TaskResource<Row>(
      (taskId, signal) => api('/tasks/' + taskId + '/diff', undefined, signal),
      (value) => {
        setPatch(value);
        setPatchError('');
      },
      () =>
        setPatchError(
          'Changes could not be refreshed. Retrying; the conversation is still available.',
        ),
    );
  }
  const turnResource = useRef<TaskResource<Row> | null>(null);
  if (!turnResource.current) {
    turnResource.current = new TaskResource<Row>(
      (taskId, signal) => api('/tasks/' + taskId + '/diff?scope=turn', undefined, signal),
      (value) => {
        setTurnPatch(value);
        setPatchError('');
      },
      () =>
        setPatchError(
          'Changes could not be refreshed. Retrying; the conversation is still available.',
        ),
    );
  }
  useEffect(() => {
    const resource = patchResource.current,
      turn = turnResource.current;
    if (needsAuthentication) {
      resource?.cancel();
      turn?.cancel();
    }
    return () => {
      resource?.cancel();
      turn?.cancel();
    };
  }, [selected, needsAuthentication]);
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const generation = ++refreshGeneration.current;
      try {
        const next = await api('/state', undefined, signal);
        if (signal?.aborted || generation !== refreshGeneration.current) return;
        eventCursor.current = next.cursor;
        setState(next);
        setWorkspaceLoaded(true);
        const taskId = selectedRef.current;
        if (taskId) {
          const nextDetail = await api('/tasks/' + taskId, undefined, signal);
          if (signal?.aborted || generation !== refreshGeneration.current) return;
          if (selectedRef.current === taskId) {
            if (loadedSettings.current !== taskId) {
              const last = nextDetail.runs?.at(-1);
              if (last) {
                setAdapter(last.adapter);
                setModel(last.model || '');
                setEffort(last.effort || '');
              }
              setProject(nextDetail.task.projectId || '');
              loadedSettings.current = taskId;
            }
            timingRef.current.applying(taskId, nextDetail);
            setDetail(nextDetail);
            // Diff IO has its own bounded queue; it must not delay the next event read.
            patchResource.current?.request(taskId);
            if (diffScopeRef.current === 'turn') turnResource.current?.request(taskId);
          }
        }
        setConnectionError('');
      } catch (failure) {
        if (signal?.aborted || generation !== refreshGeneration.current) return;
        setConnectionError(workspaceConnectionMessage(failure));
        throw failure;
      }
    },
    [api],
  );
  useEffect(() => {
    if (needsAuthentication) return;
    const controller = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const pause = () =>
      new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(retryTimer);
          controller.signal.removeEventListener('abort', done);
          resolve();
        };
        retryTimer = setTimeout(done, 1000);
        controller.signal.addEventListener('abort', done, { once: true });
      });
    async function listen() {
      while (!controller.signal.aborted) {
        try {
          await refresh(controller.signal);
          const page = await api(
            '/events?after=' + eventCursor.current + '&waitMs=10000',
            undefined,
            controller.signal,
          );
          if (
            page.events?.some(
              (event: Row) => event.taskId === selectedRef.current && event.type === 'message',
            )
          )
            timingRef.current.received(selectedRef.current);
          if (!page.supportsWait && !controller.signal.aborted) await pause();
        } catch (failure) {
          if (controller.signal.aborted) return;
          setConnectionError(workspaceConnectionMessage(failure));
          if (failure instanceof WorkspaceRequestError && failure.status === 401) return;
          await pause();
        }
      }
    }
    void listen();
    return () => {
      controller.abort();
      clearTimeout(retryTimer);
    };
  }, [needsAuthentication, api, refresh]);
  useEffect(() => {
    setDetail(null);
    setPatch(null);
    setTurnPatch(null);
    setPatchError('');
    setFileFocus(null);
    setFileNotice(null);
    setFocusedLine(null);
    setDraft(localStorage.getItem('workspace-draft-' + (selected || 'new')) || '');
    setPendingAttachments(restoreAttachmentDraft(localStorage.getItem(attachmentKey(selected))));
    if (selected) void refresh().catch(() => {});
  }, [selected, refresh]);
  useEffect(() => {
    const taskId = selectedRef.current;
    if (!taskId || diffScope !== 'turn') return;
    setTurnPatch(null);
    turnResource.current?.request(taskId);
  }, [diffScope]);
  useEffect(() => {
    if (!fileFocus || !shownPatch) return;
    const at = fileDiffs.findIndex((file) => file.path === fileFocus.path);
    if (at < 0) {
      // A file outside this turn may still be part of the task; look there before saying so.
      if (diffScope === 'turn') {
        setDiffScope('all');
        return;
      }
      setFileNotice({
        ...fileFocus,
        listed: shownPatch.files?.some((file: Row) => file.path === fileFocus.path),
      });
      setFileFocus(null);
      return;
    }
    const line = fileFocus.line;
    setFileFocus(null);
    requestAnimationFrame(() => {
      const section = document.getElementById(`task-diff-${at}`);
      const row = line ? section?.querySelector<HTMLElement>(`[data-new-line="${line}"]`) : null;
      (row || section)?.scrollIntoView({ block: row ? 'center' : 'start' });
      section?.focus({ preventScroll: true });
      setFocusedLine(row && line ? { at, line } : null);
    });
  }, [fileFocus, shownPatch, fileDiffs, diffScope]);
  // Keep links stable while the task streams; only its identity and paths matter.
  const linkTaskId = detail?.task.id,
    linkWorkspace = detail?.task.workspacePath,
    linkRemoteWorkspace = detail?.task.remoteWorkspacePath;
  const fileLinks = useMemo<MessageFileLinks | undefined>(
    () =>
      linkTaskId
        ? {
            task: {
              id: linkTaskId,
              workspacePath: linkWorkspace,
              remoteWorkspacePath: linkRemoteWorkspace,
            },
            open: (reference) => {
              setInspector(true);
              setReviewSection('changes');
              setFileNotice(null);
              setFileFocus({ ...reference, key: Date.now() });
            },
          }
        : undefined,
    [linkTaskId, linkWorkspace, linkRemoteWorkspace, setReviewSection],
  );
  const [pendingAnswers, setPendingAnswers] = useState<Set<string>>(new Set());
  useEffect(() => {
    const controller = new AbortController();
    const candidates: Row[] = state.tasks.filter((task: Row) =>
      ['running', 'checking', 'queued'].includes(task.status),
    );
    const next = new Set<string>();
    // Bound detail reads: the inventory does not include pending questions.
    async function readQuestions() {
      while (candidates.length && !controller.signal.aborted) {
        const task = candidates.shift()!;
        try {
          const value = await api('/tasks/' + task.id, undefined, controller.signal);
          if (value.questions?.some((question: Row) => question.status === 'pending'))
            next.add(task.id);
        } catch {
          // A failed read must not invent an attention status.
        }
      }
    }
    void Promise.all(Array.from({ length: Math.min(4, candidates.length) }, readQuestions)).then(
      () => {
        if (!controller.signal.aborted) setPendingAnswers(next);
      },
    );
    return () => controller.abort();
  }, [state.tasks, api]);
  const tasksWaitingForAnswer = new Set(pendingAnswers);
  if (detail) {
    if (detail.questions?.some((question: Row) => question.status === 'pending'))
      tasksWaitingForAnswer.add(detail.task.id);
    else tasksWaitingForAnswer.delete(detail.task.id);
  }
  async function action(fn: () => Promise<void>) {
    setError('');
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const selectedProject = state.projects.find((p: Row) => p.id === detail?.task.projectId);
  const fileCount = patch?.files?.length || 0;
  const waitingForAnswer = detail?.questions?.some((q: Row) => q.status === 'pending');
  const headerStatus = taskStatus(
    detail?.task.status ?? '',
    Boolean(waitingForAnswer),
    detail?.task.pull,
    Boolean(detail?.task.controlRequest),
  );
  const statusLabel = headerStatus.label;
  const titleStatus =
    detail?.task.controlRequest || waitingForAnswer
      ? 'Needs you'
      : detail?.task.pull?.status === 'open' || ['review', 'ready'].includes(detail?.task.status)
        ? 'Ready to review'
        : ['running', 'starting', 'checking'].includes(detail?.task.status)
          ? 'Running'
          : statusLabel;
  const taskStatusBadge =
    detail?.task.pull?.status === 'open' && detail.task.status !== 'merged' ? (
      <Button
        variant="link"
        onClick={() =>
          void navigate(
            repositoryURL(detail.task.projectId, 'pulls') +
              '?pull=' +
              encodeURIComponent(detail.task.pull.id) +
              '&task=' +
              encodeURIComponent(detail.task.id),
          )
        }
      >
        <StatusBadge tone={headerStatus.tone} label={titleStatus} />
      </Button>
    ) : (
      <StatusBadge tone={headerStatus.tone} label={titleStatus} />
    );
  const active =
    detail?.task.status === 'checking' ||
    detail?.runs?.some((r: Row) => ['queued', 'starting', 'running'].includes(r.status));
  const worker = state.workers.find((w: Row) => w.id === (detail?.task.workerId || workerId));
  useEffect(() => {
    if (
      !selected &&
      !state.workers.some((w: Row) => w.id === workerId) &&
      state.workers.some((w: Row) => w.status === 'online')
    )
      setWorkerId(state.workers.find((w: Row) => w.status === 'online')!.id);
  }, [state.workers, selected, workerId]);
  const options = worker?.modelOptions?.find((a: Row) => a.id === adapter);
  const models: Row[] = options?.models || [];
  const efforts: string[] = useMemo(() => {
    const choice = worker?.modelOptions?.find((a: Row) => a.id === adapter);
    return choice?.models?.find((m: Row) => m.id === model)?.efforts ?? choice?.efforts ?? [];
  }, [worker, adapter, model]);
  useEffect(() => {
    setEffort((prior) => (efforts.includes(prior) ? prior : ''));
  }, [efforts]);
  const chooseAdapter = (value: string) => {
    setAdapter(value);
    setModel('');
    setEffort('');
  };
  const chooseModel = (value: string) => {
    setModel(value);
    setEffort('');
  };
  const queuedMessage: Row | null = detail?.queuedMessage ?? null;
  // While a turn runs, Send queues one follow-up on the coordinator instead of interrupting it.
  const queueing = Boolean(selected && active && detail?.task.status !== 'checking');
  const canSend = Boolean(
    (draft.trim() || pendingAttachments.length) &&
    !uploading &&
    !needsAuthentication &&
    (!active || (queueing && queuedMessage?.status !== 'queued')) &&
    !busy &&
    worker?.status === 'online' &&
    (worker.id === 'local' || worker.capabilities?.includes(adapter)) &&
    (!selected || detail),
  );
  function newTask(projectId = '', ref = 'HEAD', path = '') {
    setRepositoryTaskScope(ref !== 'HEAD' || path ? { projectId, ref, path } : null);
    returnToChat();
    setTaskSection('conversation');
    setSelected('');
    loadedSettings.current = '';
    selectedRef.current = '';
    setDetail(null);
    setPatch(null);
    setTurnPatch(null);
    setProject(projectId);
    setInspector(false);
    setSidebar(false);
    setDraft(localStorage.getItem('workspace-draft-new') || '');
    requestAnimationFrame(() => composerRef.current?.focus());
  }
  function followLatest() {
    followTranscript.current = true;
    const transcript = transcriptRef.current;
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
  }
  async function send() {
    if (!canSend) return;
    // Your own message, and the reply after it, should stay in view.
    followLatest();
    if (queueing && detail) {
      await action(async () => {
        await api('/tasks/' + detail.task.id + '/queue', {
          content: draft.trim(),
          attachmentIds: pendingAttachments.map((a) => a.id),
          model: model || undefined,
          effort: effort || undefined,
          adapter,
        });
        setDraft('');
        keepAttachments([], detail.task.id);
        localStorage.removeItem('workspace-draft-' + detail.task.id);
        if (composerRef.current) composerRef.current.style.height = 'auto';
      });
      requestAnimationFrame(followLatest);
      return;
    }
    await action(async () => {
      let task = detail?.task;
      if (!task) {
        task = await api('/tasks', {
          projectId: project || undefined,
          ref: repositoryTaskScope?.projectId === project ? repositoryTaskScope.ref : undefined,
          title: taskTitle(draft),
          workerId,
        });
        localStorage.setItem('workspace-draft-' + task.id, draft);
        selectedRef.current = task.id;
        setSelected(task.id);
        setDetail({ task, messages: [], runs: [], events: [] });
      }
      await api('/tasks/' + task.id + '/messages', {
        attachmentIds: pendingAttachments.map((a) => a.id),
        revision: task.revision,
        content:
          (repositoryTaskScope?.projectId === project && repositoryTaskScope.path
            ? `Focus on repository path: ${repositoryTaskScope.path}\n\n`
            : '') + draft.trim(),
        model: model || undefined,
        effort: effort || undefined,
        adapter,
      });
      setDraft('');
      keepAttachments([], task.id);
      setRepositoryTaskScope(null);
      localStorage.removeItem('workspace-draft-' + (selected || 'new'));
      localStorage.removeItem('workspace-draft-' + task.id);
      if (composerRef.current) composerRef.current.style.height = 'auto';
    });
    requestAnimationFrame(followLatest);
  }
  // A held follow-up (its turn failed or was stopped) returns to the draft once per device.
  useEffect(() => {
    if (queuedMessage?.status !== 'held' || !detail) return;
    const key = 'workspace-held-' + detail.task.id;
    if (localStorage.getItem(key) === queuedMessage.createdAt) return;
    localStorage.setItem(key, queuedMessage.createdAt);
    if (queuedMessage.attachmentIds?.length) {
      const rows = (detail.attachments || []).filter((a: Attachment) =>
        queuedMessage.attachmentIds.includes(a.id),
      );
      keepAttachments([
        ...pendingAttachments,
        ...rows.filter((a: Attachment) => !pendingAttachments.some((p) => p.id === a.id)),
      ]);
    }
    setDraft((prior) => {
      const next = prior.includes(queuedMessage.content)
        ? prior
        : queuedMessage.content + (prior.trim() ? '\n\n' + prior : '');
      localStorage.setItem('workspace-draft-' + detail.task.id, next);
      return next;
    });
  }, [
    queuedMessage?.status,
    queuedMessage?.createdAt,
    queuedMessage?.content,
    queuedMessage?.attachmentIds,
    pendingAttachments,
    detail,
  ]);
  function openTask(taskId: string) {
    returnToChat();
    setTaskSection('conversation');
    setInspector(false);
    setSelected(taskId);
    setSidebar(false);
    if (matchMedia('(width < 640px)').matches)
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>('.phone-task-segments [aria-current="page"]')?.focus(),
      );
  }
  useEffect(() => {
    const dialog = projectDialogRef.current;
    if (creatingProject && dialog && !dialog.open) {
      dialog.showModal();
      dialog.querySelector('input')?.focus();
    } else if (!creatingProject && dialog?.open) dialog.close();
  }, [creatingProject]);
  const composerContext = {
    projects: state.projects,
    project: project,
    computers: state.workers,
    computer: workerId,
    chooseProject: (value: string) => {
      setProject(value);
      setRepositoryTaskScope(null);
    },
    chooseComputer: setWorkerId,
    newRepository: () => {
      repositoryFromComposer.current = true;
      setCreatingProject(true);
    },
  };
  const composerControls = {
    catalogs: worker?.modelOptions || [],
    adapters: state.adapters.map((value: Row) => ({
      ...value,
      available:
        worker?.id === 'local' ? value.available : !!worker?.capabilities?.includes(value.id),
    })),
    adapter: adapter,
    models: models as { id: string; name: string }[],
    model: model,
    efforts: efforts,
    effort: effort,
    disabled: Boolean(active),
    chooseAdapter: chooseAdapter,
    chooseModel: chooseModel,
    chooseEffort: setEffort,
  };
  const repositoryDialog = repositoryView || repositoryFromComposer.current;
  const taskMoreMenu = detail && (
    <OverflowMenu label="More task actions">
      <p>{selectedProject?.name || 'No project'}</p>
      <p>{worker?.name || detail.task.workerId || 'Computer unavailable'}</p>
      {!active && !waitingForAnswer && (
        <button
          data-dismiss-menu
          disabled={busy || Boolean(connectionError)}
          onClick={() => {
            const closed = ['done', 'merged'].includes(detail.task.status);
            if (
              !window.confirm(
                closed ? 'Reopen this task for further work?' : 'Mark this task as done?',
              )
            )
              return;
            void action(async () => {
              await api(`/tasks/${selected}/${closed ? 'reopen' : 'close'}`, {
                revision: detail.task.revision,
              });
            });
          }}
        >
          {['done', 'merged'].includes(detail.task.status) ? 'Reopen' : 'Mark done'}
        </button>
      )}
    </OverflowMenu>
  );
  if (signingIn)
    return (
      <LoginForm
        onLogin={() => {
          if (getAuth()?.username !== account.current) {
            window.location.reload();
            return;
          }
          setSigningIn(false);
          setNeedsAuthentication(false);
          setConnectionError('');
          setError('');
        }}
      />
    );
  return (
    <div
      data-phone=""
      onKeyDown={(event) => {
        if (
          event.key === 'Escape' &&
          !event.defaultPrevented &&
          inspector &&
          !surface &&
          !repositoryView
        ) {
          event.preventDefault();
          setInspector(false);
          document
            .querySelector<HTMLButtonElement>('.pw-task-titlebar [aria-label="Changes"]')
            ?.focus();
        }
      }}
      style={{ ...sidebarResize.style, ...activityRail.style }}
      className={`project-workspace ${!selected ? 'is-composing' : ''} ${applicationSurface ? 'has-application' : ''} ${!surface && !repositoryView && taskSection !== 'tasks' ? 'is-task-flow' : ''} ${inspector && !surface && !repositoryView && taskSection !== 'tasks' ? 'has-inspector' : ''} ${activityRail.mode !== 'closed' && !surface && !repositoryView && taskSection !== 'tasks' ? 'has-activity-rail' : ''} ${sidebar ? 'show-sidebar' : ''} ${surface ? 'has-surface' : ''} ${repositoryView ? 'has-repository' : ''} ${!surface && !repositoryView && taskSection === 'tasks' ? 'has-task-tree' : ''}`}
    >
      {timing.enabled && <output hidden ref={timing.output} data-workspace-performance="true" />}
      <WorkspaceRail workers={state.workers} workerId={worker?.id} />
      {!applicationSurface && (surface || repositoryView || taskSection !== 'tasks') && (
        <CompactTopBar
          singleRow={!surface && !repositoryView && taskSection !== 'tasks'}
          title={
            surface
              ? surfaceTitle
              : repositoryView
                ? projectHub?.name || 'Repositories'
                : taskSection === 'tasks'
                  ? 'Tasks'
                  : detail?.task.title || (selected ? 'Loading task…' : 'New task')
          }
          back={
            surface && !['/dashboard/apps', '/dashboard/computers'].includes(pathname)
              ? pathname.startsWith('/dashboard/catalog/')
                ? '/dashboard/catalog'
                : pathname.startsWith('/dashboard/design-system')
                  ? '/dashboard/settings'
                  : '/dashboard'
              : repositoryView && projectHub
                ? '/dashboard/repositories'
                : undefined
          }
          onBackLabel={inspector ? 'Back to chat' : 'Back to tasks'}
          onBack={
            !surface && !repositoryView && taskSection !== 'tasks'
              ? () => {
                  if (inspector) setInspector(false);
                  else setTaskSection('tasks');
                }
              : undefined
          }
          profile
          context={
            !surface && !repositoryView && taskSection !== 'tasks' && detail ? (
              <>{taskStatusBadge}</>
            ) : undefined
          }
          action={
            !surface && !repositoryView && taskSection === 'tasks' ? (
              <Button variant="primary" onClick={() => newTask()}>
                New task
              </Button>
            ) : !surface && !repositoryView && taskSection !== 'tasks' && detail ? (
              <ActionCluster>
                <IconButton
                  icon="computer"
                  label="Open computer use"
                  onClick={() => showControl(selected, true)}
                />
                <IconButton
                  icon="panel-right"
                  label="Activity"
                  data-activity-toggle
                  pressed={activityRail.mode === 'open'}
                  onClick={() =>
                    activityRail.mode === 'open' ? activityRail.update('closed') : openActivity()
                  }
                />
                {taskMoreMenu}
              </ActionCluster>
            ) : undefined
          }
        />
      )}
      {!surface && !repositoryView && taskSection !== 'tasks' && selected && (
        <nav className="phone-task-segments phone-only" role="tablist" aria-label="Task views">
          {['conversation', 'changes', 'checks'].map((section) => (
            <Button
              key={section}
              id={`phone-task-tab-${section}`}
              role="tab"
              aria-selected={(inspector ? reviewSection : 'conversation') === section}
              aria-controls={
                section === 'conversation' ? 'task-conversation' : `task-panel-${section}`
              }
              tabIndex={(inspector ? reviewSection : 'conversation') === section ? 0 : -1}
              onKeyDown={(event) => {
                const sections = ['conversation', 'changes', 'checks'];
                const index = sections.indexOf(section);
                const next =
                  event.key === 'ArrowRight'
                    ? sections[(index + 1) % 3]
                    : event.key === 'ArrowLeft'
                      ? sections[(index + 2) % 3]
                      : event.key === 'Home'
                        ? sections[0]
                        : event.key === 'End'
                          ? sections[2]
                          : null;
                if (next) {
                  event.preventDefault();
                  setInspector(next !== 'conversation');
                  if (next !== 'conversation') setReviewSection(next);
                  document.getElementById(`phone-task-tab-${next}`)?.focus();
                }
              }}
              variant="quiet"
              aria-current={
                (inspector ? reviewSection : 'conversation') === section ? 'page' : undefined
              }
              onClick={() => {
                setInspector(section !== 'conversation');
                if (section !== 'conversation') {
                  setReviewSection(section);
                }
              }}
            >
              {section === 'conversation'
                ? 'Chat'
                : section === 'changes'
                  ? `Changes${fileCount ? ` ${fileCount}` : ''}`
                  : 'Checks'}
            </Button>
          ))}
        </nav>
      )}

      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {jobAnnouncement}
      </span>
      <SidebarResizeHandle width={sidebarResize.width} update={sidebarResize.update} />
      {sidebar && (
        <button
          className="pw-sidebar-scrim"
          aria-label="Close navigation"
          onClick={() => setSidebar(false)}
        />
      )}
      <aside className="pw-sidebar task-navigation" aria-label="Tasks navigation">
        <TaskTree
          projects={state.projects}
          tasks={state.tasks}
          selected={selected}
          loaded={workspaceLoaded}
          error={connectionError}
          waitingForAnswer={tasksWaitingForAnswer}
          openTask={openTask}
          newTask={newTask}
          addRepository={() => {
            void navigate('/dashboard/repositories');
            setCreatingProject(true);
          }}
          retry={() => void refresh().catch(() => {})}
        />
      </aside>
      {surface && <SurfaceNavigation pathname={pathname} />}
      {!surface && !repositoryView && taskSection !== 'tasks' && (
        <header className="pw-header pw-task-titlebar">
          <IconButton
            icon="navigation"
            label="Toggle navigation"
            className="pw-mobile-menu"
            aria-expanded={sidebar}
            onClick={() => setSidebar(!sidebar)}
          />
          <span className="pw-title-project" title={selectedProject?.name || 'No project'}>
            <WorkspaceIcon name="folder" />
          </span>
          <div className="pw-heading">
            <strong
              title={`${detail?.task.title ?? 'New task'} · ${selectedProject?.name ?? 'No project'} · ${worker?.name ?? detail?.task.workerId ?? 'Computer unavailable'}`}
            >
              {detail?.task.title || (selected ? 'Loading task…' : 'New task')}
            </strong>
          </div>
          {detail && (
            <>
              <span className="pw-header-status">{taskStatusBadge}</span>
              <ActionCluster>
                <IconButton
                  icon="computer"
                  label="Open computer use"
                  onClick={() => showControl(selected, true)}
                />
                <IconButton
                  icon="review"
                  label="Changes"
                  pressed={inspector}
                  onClick={() => setInspector(!inspector)}
                />
                <IconButton
                  icon="panel-right"
                  label={summary.visible ? summary.label : 'Activity'}
                  data-activity-toggle
                  pressed={activityRail.mode === 'open'}
                  onClick={() =>
                    activityRail.mode === 'open' ? activityRail.update('closed') : openActivity()
                  }
                />
                {(summary.running > 0 || summary.failing > 0) && (
                  <span className="pw-count" aria-hidden="true">
                    {summary.failing || summary.running}
                  </span>
                )}
                {taskMoreMenu}
              </ActionCluster>
            </>
          )}
        </header>
      )}
      <section
        id="task-conversation"
        ref={conversationRef}
        className="pw-chat"
        aria-label="Conversation"
      >
        {detail && (
          <TaskCard
            visible={cardVisible}
            width={cardWidth ?? 216}
            detail={detail}
            patch={patch}
            workers={state.workers}
            project={selectedProject?.name}
            changes={() => {
              setReviewSection('changes');
              setInspector(true);
            }}
            activity={() => openActivity()}
            sources={() => {
              setActivityFocus({ sources: true, key: Date.now() });
              activityRail.update('open');
            }}
          />
        )}
        {(connectionError || error) && (
          <div className="pw-error" role="alert">
            {connectionError || error}
            {needsAuthentication && (
              <button onClick={() => setSigningIn(true)}>Sign in again</button>
            )}
          </div>
        )}
        <div
          className="pw-transcript"
          ref={transcriptRef}
          onScroll={(event) => {
            const target = event.currentTarget;
            followTranscript.current =
              target.scrollHeight - target.scrollTop - target.clientHeight < 100;
          }}
        >
          <div className="pw-conversation">
            {!selected && <div className="pw-empty"></div>}
            {detail && !detail.messages.length && <div className="pw-empty"></div>}
            {transcriptIndex.visible.map((m: Row) => (
              <div
                key={m.id}
                id={`message-${m.id}`}
                data-conversation-run={m.role === 'assistant' ? m.runId : undefined}
                tabIndex={-1}
              >
                {m.role === 'assistant' &&
                  transcriptIndex.firstAssistant.get(m.runId) === m.id &&
                  transcriptIndex.activityByRun.has(m.runId) && (
                    <TaskActivity
                      activity={transcriptIndex.activityByRun.get(m.runId)!}
                      run={detail?.runs?.find((run: Row) => run.id === m.runId)}
                      jobs={(detail?.jobs ?? []).filter((job: Row) => job.runId === m.runId)}
                      workers={state.workers}
                      openActivity={() => openActivity(m.runId)}
                      progress={transcriptIndex.progress.get(m.runId) ?? []}
                    />
                  )}
                {m.role === 'assistant' && transcriptIndex.firstAssistant.get(m.runId) === m.id && (
                  <AttachmentStrip
                    allRows={detail?.attachments || []}
                    computer
                    rows={(detail?.attachments || []).filter(
                      (a: Attachment) => a.source === 'computer-use' && a.runId === m.runId,
                    )}
                  />
                )}
                <div
                  className={'pw-message ' + m.role}
                  aria-label={
                    m.role === 'user'
                      ? 'You'
                      : m.adapter === 'claude'
                        ? 'Claude'
                        : m.adapter === 'compatible'
                          ? 'Local model'
                          : 'Codex'
                  }
                >
                  {m.role === 'user' ? (
                    <CollapsibleMessage>
                      <MessageContent
                        content={m.content}
                        fileLinks={fileLinks}
                        attachments={detail?.attachments || []}
                      />
                    </CollapsibleMessage>
                  ) : (
                    <MessageContent
                      content={m.content}
                      fileLinks={fileLinks}
                      attachments={detail?.attachments || []}
                    />
                  )}
                  <AttachmentStrip
                    allRows={detail?.attachments || []}
                    rows={(detail?.attachments || []).filter(
                      (a: Attachment) =>
                        a.source !== 'computer-use' &&
                        (a.messageId === m.id ||
                          m.attachmentIds?.includes(a.id) ||
                          (a.source === 'agent' &&
                            a.runId === m.runId &&
                            transcriptIndex.visible
                              .filter((v: Row) => v.role === 'assistant' && v.runId === m.runId)
                              .at(-1)?.id === m.id)) &&
                        !m.content.includes('/attachments/' + a.id),
                    )}
                  />
                </div>
                {m.role === 'assistant' &&
                  transcriptIndex.visible.findLast(
                    (message: Row) => message.role === 'assistant' && message.runId === m.runId,
                  )?.id === m.id && (
                    <ReplyActions
                      message={{ ...m, taskId: selected }}
                      run={detail?.runs?.find((run: Row) => run.id === m.runId)}
                    />
                  )}
              </div>
            ))}
            {transcriptIndex.trailingActivity.map((a: Row) => (
              <div key={a.id} data-conversation-run={a.id} tabIndex={-1}>
                <TaskActivity
                  activity={a}
                  run={detail?.runs?.find((run: Row) => run.id === a.id)}
                  jobs={(detail?.jobs ?? []).filter((job: Row) => job.runId === a.id)}
                  workers={state.workers}
                  openActivity={() => openActivity(a.id)}
                  progress={transcriptIndex.progress.get(a.id) ?? []}
                />
                <AttachmentStrip
                  allRows={detail?.attachments || []}
                  computer
                  rows={(detail?.attachments || []).filter(
                    (attachment: Attachment) =>
                      attachment.source === 'computer-use' && attachment.runId === a.id,
                  )}
                />
                <AttachmentStrip
                  allRows={detail?.attachments || []}
                  rows={(detail?.attachments || []).filter(
                    (attachment: Attachment) =>
                      attachment.source === 'agent' && attachment.runId === a.id,
                  )}
                />
              </div>
            ))}
            {detail?.runs
              ?.filter(
                (run: Row) =>
                  !transcriptIndex.visible.some(
                    (message: Row) => message.role === 'assistant' && message.runId === run.id,
                  ),
              )
              .map((run: Row) => (
                <AgentContext key={run.id} run={run} />
              ))}
            {active && !waitingForAnswer && (
              <p className="pw-working">
                <span className="pw-dot running" />
                {statusLabel || 'Working'}…
              </p>
            )}
            {detail?.runs
              .slice(-1)
              .filter((r: Row) => r.error)
              .map((r: Row) => (
                <p className="pw-error" key={r.id}>
                  {r.error}
                </p>
              ))}
          </div>
        </div>
        <div
          className={`pw-compose-area ${!selected ? 'is-new-task' : ''} ${detail?.questions?.some((q: Row) => q.status === 'pending') ? 'has-question' : ''}`}
        >
          {detail?.task.controlRequest && (
            <ControlRequestCard
              taskId={detail.task.id}
              request={detail.task.controlRequest}
              project={
                selectedProject ? { id: selectedProject.id, name: selectedProject.name } : null
              }
              disabled={Boolean(connectionError)}
              respond={async (path, body) => {
                await api(path, body);
                await refresh();
              }}
            />
          )}
          {detail?.questions
            ?.filter((q: Row) => q.status === 'pending')
            .map((q: Row) => (
              <TaskQuestion
                key={q.id}
                question={q as any}
                disabled={busy || Boolean(connectionError)}
                answer={async (answer, dismiss) => {
                  await api(`/tasks/${q.taskId}/questions/${q.id}/answer`, {
                    answer,
                    dismiss: Boolean(dismiss),
                  });
                  await refresh();
                }}
              />
            ))}
          {detail?.questions?.some((q: Row) => q.status === 'pending') && (
            <button
              className="pw-question-stop"
              disabled={busy || Boolean(connectionError)}
              onClick={() =>
                void action(async () => {
                  await api('/tasks/' + selected + '/stop', { revision: detail!.task.revision });
                })
              }
            >
              <WorkspaceIcon name="stop" />
              Stop task
            </button>
          )}
          {!selected && repositoryTaskScope?.projectId === project && (
            <div className="pw-task-start">
              <p className="pw-muted">
                Starting from {repositoryTaskScope.ref.slice(0, 12)}
                {repositoryTaskScope.path ? ` · ${repositoryTaskScope.path}` : ''}
              </p>
            </div>
          )}
          {queuedMessage && (
            <div
              className={`pw-queued ${queuedMessage.status === 'held' ? 'is-held' : ''}`}
              role="status"
            >
              <WorkspaceIcon name={queuedMessage.status === 'held' ? 'alert' : 'chat'} />
              <div>
                <strong>
                  {queuedMessage.status === 'held'
                    ? `${queuedMessage.reason} It’s back in your draft.`
                    : 'Queued, sends when this turn ends'}
                </strong>
                {queuedMessage.status === 'queued' && <p>{queuedMessage.content}</p>}
              </div>
              <IconButton
                icon="close"
                label={
                  queuedMessage.status === 'held'
                    ? 'Dismiss queued message'
                    : 'Cancel queued message'
                }
                disabled={busy || Boolean(connectionError)}
                onClick={() =>
                  void action(async () => {
                    await api('/tasks/' + detail!.task.id + '/queue/cancel', {});
                  })
                }
              />
            </div>
          )}
          <div
            className="pw-composer"
            onPaste={(event) => {
              const files = [...event.clipboardData.files].filter(
                (f) => f.type.startsWith('image/') || f.type.startsWith('video/'),
              );
              if (files.length) {
                event.preventDefault();
                void addImages(files);
              }
            }}
            onDragOver={(event) => {
              if (event.dataTransfer.types.includes('Files')) event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              void addImages([...event.dataTransfer.files]);
            }}
          >
            <div className="pw-attachment-drafts">
              {pendingAttachments.map((a) => (
                <div key={a.id} className="pw-attachment-draft">
                  {a.kind === 'video' ? (
                    <AttachmentStrip rows={[a]} />
                  ) : (
                    <AttachmentImage id={a.id} caption={a.name} attachment={a} />
                  )}
                  <ActionCluster>
                    {a.kind !== 'video' && <MarkupButton attachment={a} />}
                    <IconButton
                      icon="close"
                      className="pw-chip-remove"
                      label={`Remove ${a.name}`}
                      onClick={() =>
                        keepAttachments(attachmentChips(pendingAttachments, { remove: a.id }))
                      }
                    />
                  </ActionCluster>
                </div>
              ))}
            </div>
            {uploading && mediaUpload && (
              <div className="pw-attachment-draft">
                <span role="status">
                  {mediaUpload.name}: {uploadProgress(mediaUpload)}
                </span>
                <IconButton
                  icon="close"
                  label="Cancel upload"
                  onClick={() => uploadAbort.current?.abort()}
                />
              </div>
            )}
            <textarea
              ref={composerRef}
              aria-label="Message"
              data-appearance="plain"
              rows={selected ? 1 : 3}
              disabled={Boolean(selected && !detail)}
              placeholder={
                queueing
                  ? queuedMessage?.status === 'queued'
                    ? 'Draft your next message…'
                    : 'Queue a follow-up…'
                  : selected
                    ? 'Ask, build, or follow up…'
                    : 'Describe what to build or change…'
              }
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                localStorage.setItem('workspace-draft-' + (selected || 'new'), e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="pw-composer-toolbar">
              <input
                ref={attachmentInput}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp,video/mp4,video/quicktime,video/webm"
                multiple
                hidden
                onChange={(event) => {
                  void addImages([...(event.target.files || [])]);
                  event.target.value = '';
                }}
              />
              <IconButton
                icon="plus"
                className="pw-composer-attach"
                label="Attach images"
                disabled={uploading || busy}
                onClick={() => attachmentInput.current?.click()}
              />
              <PhoneComposerContext
                {...composerContext}
                followUp={Boolean(selected)}
                modelControls={<ComposerControls {...composerControls} inline />}
              />
              <VoiceInput
                onTranscript={(text) =>
                  setDraft((prior) => {
                    const next = prior ? prior + ' ' + text : text;
                    localStorage.setItem('workspace-draft-' + (selected || 'new'), next);
                    return next;
                  })
                }
                contextKey={selected}
              />
              {!selected && <ComposerContext {...composerContext} desktopOnly />}
              {selected &&
                composerActivityVisible(
                  cardVisible,
                  activityRail.mode,
                  summary.running,
                  summary.failing,
                ) && (
                  <Button
                    variant="link"
                    className="pw-composer-activity-pill"
                    onClick={() => openActivity()}
                    aria-label={summary.label}
                  >
                    {summary.failing > 0
                      ? `✕ ${summary.failing} failing`
                      : `◐ ${summary.running} running`}
                  </Button>
                )}
              <ComposerControls {...composerControls} desktopOnly />
            </div>
            {active && queueing && draft.trim() && queuedMessage?.status !== 'queued' ? (
              <div className="pw-send-group">
                <IconButton
                  icon="stop"
                  label="Stop task"
                  disabled={busy}
                  onClick={() =>
                    action(async () => {
                      await api('/tasks/' + selected + '/stop', {
                        revision: detail!.task.revision,
                      });
                    })
                  }
                />
                <IconButton
                  className="pw-send"
                  icon="arrow"
                  shortcut="⌘ Return to send"
                  label="Queue message"
                  disabled={!canSend}
                  onClick={() => void send()}
                />
              </div>
            ) : active ? (
              <IconButton
                className="pw-send"
                icon="stop"
                label="Stop task"
                disabled={busy}
                onClick={() =>
                  action(async () => {
                    await api('/tasks/' + selected + '/stop', {
                      revision: detail!.task.revision,
                    });
                  })
                }
              />
            ) : (
              <IconButton
                className="pw-send"
                icon="arrow"
                shortcut="⌘ Return to send"
                label={selected ? 'Send message' : 'Start task'}
                disabled={!canSend}
                onClick={() => void send()}
              />
            )}
          </div>
          <div className="pw-composer-caption">
            <span>
              {worker?.status !== 'online' ? (
                <>
                  Task computer offline.{' '}
                  <Link to="/dashboard/settings#settings-providers">Set up task worker</Link>
                </>
              ) : worker.id !== 'local' && !worker.capabilities?.includes(adapter) ? (
                <>
                  <Link to="/dashboard/settings#settings-providers">Connect a provider</Link> to
                  start coding.
                </>
              ) : (
                ''
              )}
            </span>
          </div>
        </div>
      </section>
      {surface && (
        <section className="pw-surface" aria-label={`${surfaceTitle} workspace`}>
          <div className="pw-surface-content">{surface}</div>
        </section>
      )}
      {!surface && !repositoryView && selected && (
        <ControlPanel
          key={selected}
          taskId={selected}
          workers={state.workers}
          api={api}
          onReveal={() => showControl(selected, true)}
          visible={controlTasks.has(selected)}
          onClose={() => showControl(selected, false)}
        />
      )}
      <aside
        className={`pw-context ds-work-pane ${scrollCode ? 'phone-scroll-code' : ''}`}
        aria-label="Task inspector"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            setInspector(false);
            document
              .querySelector<HTMLButtonElement>('.pw-task-titlebar [aria-label="Changes"]')
              ?.focus();
          }
        }}
      >
        {selected && (
          <>
            <nav className="pw-review-sections" role="tablist" aria-label="Inspector sections">
              {['changes', 'checks'].map((section) => (
                <button
                  key={section}
                  role="tab"
                  id={`task-tab-${section}`}
                  aria-controls={`task-panel-${section}`}
                  aria-selected={reviewSection === section}
                  tabIndex={reviewSection === section ? 0 : -1}
                  onKeyDown={(event) => {
                    const sections = ['changes', 'checks'];
                    const index = sections.indexOf(section);
                    const next =
                      event.key === 'ArrowRight'
                        ? sections[(index + 1) % 2]
                        : event.key === 'ArrowLeft'
                          ? sections[(index + 1) % 2]
                          : event.key === 'Home'
                            ? sections[0]
                            : event.key === 'End'
                              ? sections[1]
                              : null;
                    if (next) {
                      event.preventDefault();
                      setReviewSection(next);
                      document.getElementById(`task-tab-${next}`)?.focus();
                    }
                  }}
                  onClick={() => setReviewSection(section)}
                >
                  {section === 'changes' ? 'Changes' : 'Checks'}
                </button>
              ))}
            </nav>
            {reviewSection === 'changes' && (
              <div className="phone-review-options phone-only">
                <IconButton
                  icon="wrap"
                  label="Wrap code"
                  pressed={!scrollCode}
                  onClick={() => setScrollCode(!scrollCode)}
                />
              </div>
            )}
            <div className="pw-review-body">
              <div
                role="tabpanel"
                id="task-panel-changes"
                aria-labelledby="task-tab-changes"
                hidden={reviewSection !== 'changes'}
              >
                {detail?.task.projectId && (
                  <TaskPublish
                    key={detail.task.id}
                    task={detail.task}
                    defaults={detail.publishDefaults}
                    pulls={detail.pullRequests || []}
                    diff={patch}
                    busy={
                      busy ||
                      detail.runs?.some((run: Row) =>
                        ['queued', 'starting', 'running', 'unknown'].includes(run.status),
                      ) ||
                      detail.task.status === 'checking'
                    }
                    api={api}
                    published={(pull) => {
                      void navigate(
                        repositoryURL(detail.task.projectId, 'pulls') +
                          '?pull=' +
                          encodeURIComponent(pull.id) +
                          '&task=' +
                          encodeURIComponent(detail.task.id),
                      );
                    }}
                  />
                )}
                <div className="pw-diff-scope" role="group" aria-label="Changes shown">
                  {(['turn', 'all'] as const).map((scope) => (
                    <button
                      key={scope}
                      type="button"
                      aria-pressed={diffScope === scope}
                      onClick={() => {
                        setFileNotice(null);
                        setFocusedLine(null);
                        setDiffScope(scope);
                      }}
                    >
                      {scope === 'turn' ? 'This turn' : 'All changes'}
                    </button>
                  ))}
                </div>
                <div className="pw-review-summary">
                  <strong>
                    {shownPatch?.files?.length
                      ? `${shownPatch.files.length} changed ${shownPatch.files.length === 1 ? 'file' : 'files'}${shownPatch.scope === 'turn' ? ' this turn' : ''}`
                      : shownPatch?.scope === 'turn'
                        ? 'This turn'
                        : 'Working tree'}
                  </strong>
                  {shownPatch?.scope === 'turn' ? (
                    <span className="pw-muted">
                      {['queued', 'starting', 'running'].includes(
                        detail?.runs?.find((r: Row) => r.id === shownPatch.runId)?.status,
                      )
                        ? 'So far, since this turn started'
                        : 'Since this turn started'}
                    </span>
                  ) : (
                    <span className="pw-muted">
                      {shownPatch?.baseRevision?.slice(0, 12)}{' '}
                      <WorkspaceIcon name="arrow-right" className="pw-inline-icon" />{' '}
                      {shownPatch?.headRevision === shownPatch?.baseRevision
                        ? 'Working tree'
                        : shownPatch?.headRevision?.slice(0, 12)}
                    </span>
                  )}
                </div>
                {shownPatch?.note && (
                  <p role="status" className="pw-muted">
                    {shownPatch.note}
                  </p>
                )}
                {fileNotice && (
                  <p role="status" className="pw-file-notice">
                    <span>
                      {fileNotice.listed
                        ? `${fileNotice.path} changed, but its diff isn’t shown here.`
                        : `${fileNotice.path} has no changes in this task.`}
                    </span>
                    {!fileNotice.listed && detail?.task.projectId && (
                      <Link
                        to={
                          repositoryURL(detail.task.projectId) +
                          '?task=' +
                          encodeURIComponent(detail.task.id) +
                          '&path=' +
                          encodeURIComponent(fileNotice.path)
                        }
                      >
                        View file
                      </Link>
                    )}
                  </p>
                )}
                {patchError && (
                  <p role="status" className="pw-muted">
                    {patchError}
                  </p>
                )}
                <div className="pw-files">
                  {shownPatch?.files?.length ? (
                    shownPatch.files.map((file: Row) => {
                      const status = file.status.trim();
                      const at = taskDiffIndex(fileDiffs, file.path, status);
                      const label =
                        status === '??' || status === 'A'
                          ? 'Added'
                          : status === 'D'
                            ? 'Deleted'
                            : status === 'R'
                              ? 'Renamed'
                              : status === 'M'
                                ? 'Modified'
                                : status || 'Modified';
                      return (
                        <div key={file.path}>
                          <WorkspaceIcon name="file" />
                          {at >= 0 ? (
                            <a
                              href={`#task-diff-${at}`}
                              onClick={(event) => {
                                event.preventDefault();
                                const target = document.getElementById(`task-diff-${at}`);
                                target?.scrollIntoView({ block: 'start' });
                                target?.focus({ preventScroll: true });
                              }}
                            >
                              {file.path}
                            </a>
                          ) : (
                            <span>{file.path}</span>
                          )}
                          <span className="pw-file-status">{label}</span>
                          {detail?.task.projectId && (
                            <Button
                              variant="link"
                              className="pw-view-file"
                              onClick={() =>
                                void navigate(
                                  repositoryURL(detail.task.projectId) +
                                    '?task=' +
                                    encodeURIComponent(detail.task.id) +
                                    '&path=' +
                                    encodeURIComponent(file.path),
                                )
                              }
                            >
                              View file
                            </Button>
                          )}
                          {at >= 0 && (
                            <span className="phone-only phone-file-count">
                              <span className="pw-added">
                                +
                                {fileDiffs[at].lines.filter((line) => line.kind === 'added').length}
                              </span>{' '}
                              <span className="pw-removed">
                                −
                                {
                                  fileDiffs[at].lines.filter((line) => line.kind === 'removed')
                                    .length
                                }
                              </span>
                            </span>
                          )}
                        </div>
                      );
                    })
                  ) : (
                    <p className="pw-muted">
                      {shownPatch
                        ? shownPatch.status || 'Your working tree is clean.'
                        : patchError
                          ? 'Changes unavailable.'
                          : 'Loading changes…'}
                    </p>
                  )}
                </div>
                {fileDiffs.map((file, at) => (
                  <section
                    key={`${at}-${file.path}`}
                    id={`task-diff-${at}`}
                    className={`pw-file-diff ${file.lines.some((line) => line.text.startsWith('new file mode ')) ? 'is-added-file' : ''}`}
                    aria-label={`Diff for ${file.path}`}
                    tabIndex={-1}
                  >
                    <header>
                      <WorkspaceIcon name="file" />
                      <strong>{file.path}</strong>
                      {file.lines.some((line) => line.text.startsWith('new file mode ')) && (
                        <span className="phone-only phone-new-file">New file</span>
                      )}
                    </header>
                    <div className="pw-diff">
                      <pre tabIndex={0} aria-label={`Code changes in ${file.path}`}>
                        {file.lines.map((line, index) => (
                          <span
                            className={`pw-diff-line pw-diff-${line.kind} ${line.text.startsWith('new file mode ') ? 'pw-new-file-metadata' : ''} ${focusedLine?.at === at && line.kind !== 'removed' && focusedLine.line === line.newLine ? 'is-focused' : ''}`}
                            data-new-line={line.kind === 'removed' ? undefined : line.newLine}
                            key={index}
                          >
                            <span className="pw-diff-gutter" aria-hidden="true">
                              {line.oldLine ?? ''}
                            </span>
                            <span className="pw-diff-gutter" aria-hidden="true">
                              {line.newLine ?? ''}
                            </span>
                            <span>{line.text || ' '}</span>
                          </span>
                        ))}
                      </pre>
                    </div>
                  </section>
                ))}
                {shownPatch?.truncated && (
                  <p className="pw-muted">
                    Patch truncated; inspect full files on the execution computer.
                  </p>
                )}
              </div>
              <div
                role="tabpanel"
                id="task-panel-checks"
                aria-labelledby="task-tab-checks"
                hidden={reviewSection !== 'checks'}
              >
                <h3 className="sr-only">Checks</h3>
                {patch?.checks?.length ? (
                  patch.checks.map((c: Row) => (
                    <details className="pw-check" key={c.id}>
                      <summary>
                        <span
                          className={`pw-check-icon ${c.exitCode === 0 ? 'passed' : c.exitCode != null ? 'failed' : ''}`}
                        >
                          <WorkspaceIcon
                            name={
                              c.exitCode === 0 ? 'check' : c.exitCode != null ? 'close' : 'circle'
                            }
                          />
                        </span>
                        <span>
                          <strong>{c.command}</strong>
                          <small>
                            {c.exitCode === 0
                              ? 'Passed'
                              : c.exitCode != null
                                ? `Exited with code ${c.exitCode}`
                                : c.status || 'Running'}
                          </small>
                        </span>
                        <WorkspaceIcon name="chevron-down" className="pw-disclosure" />
                      </summary>
                      <pre>{checkOutput(c.output)}</pre>
                    </details>
                  ))
                ) : (
                  <p className="pw-muted">{!detail?.jobs?.length && 'No checks recorded'}</p>
                )}
                <CheckVerdicts
                  jobs={detail?.jobs ?? []}
                  workers={state.workers}
                  open={(check) => openActivity(undefined, check)}
                />
                {detail?.task.workerId && detail.task.workerId !== 'local' ? (
                  !patch?.checks?.length &&
                  !detail?.jobs?.length && (
                    <p className="pw-muted">Ask the task to run checks on its computer.</p>
                  )
                ) : (
                  <>
                    <input
                      aria-label="Check command"
                      placeholder="Check command, e.g. npm test"
                      value={checkCommand}
                      onChange={(e) => setCheckCommand(e.target.value)}
                    />
                    <button
                      disabled={
                        !detail ||
                        !checkCommand ||
                        active ||
                        busy ||
                        worker?.status !== 'online' ||
                        (detail.task.workerId && detail.task.workerId !== 'local')
                      }
                      onClick={() => {
                        const command = checkCommand.trim();
                        if (command)
                          void action(async () => {
                            await api('/tasks/' + selected + '/check', {
                              revision: detail!.task.revision,
                              command,
                            });
                          });
                      }}
                    >
                      Run check
                    </button>
                  </>
                )}
              </div>
            </div>
          </>
        )}
        <p className="phone-review-verdict phone-only">
          Checks: {checkSummary(patch?.checks || [], detail?.jobs || [], Boolean(patchError))}
        </p>
      </aside>
      {!surface && !repositoryView && taskSection !== 'tasks' && selected && (
        <ActivityRail rail={activityRail} jobs={detail?.jobs ?? []}>
          <TaskActivityPanel
            key={selected}
            detail={detail}
            workers={state.workers}
            busy={busy}
            focus={activityFocus}
            showConversation={showJobConversation}
            cancel={(job) =>
              void action(async () => {
                await api(`/tasks/${detail!.task.id}/jobs/${job.id}/cancel`, {});
              })
            }
          />
        </ActivityRail>
      )}
      {repositoryView && projectHub && (
        <ProjectHub
          key={projectHub.id}
          project={projectHub}
          tasks={state.tasks.filter((task: Row) => task.projectId === projectHub.id)}
          startTask={(ref, path) => newTask(projectHub.id, ref, path)}
          section={repositoryLocation?.section}
          initialSelected={searchParams.get('pull') || undefined}
          returnTask={searchParams.get('task') || undefined}
          refreshProject={() => refresh()}
          updateProject={(updated) =>
            setState((current) => ({
              ...current,
              projects: current.projects.map((item: Row) =>
                item.id === updated.id ? { ...item, ...updated } : item,
              ),
            }))
          }
          api={api}
          openTask={(id) => {
            openTask(id);
            void refresh().catch(() => {});
          }}
        />
      )}
      {repositoryView && !projectHub && (
        <RepositoryLibrary
          projects={state.projects}
          loaded={workspaceLoaded}
          error={connectionError}
          retry={() => void refresh().catch(() => {})}
          create={() => setCreatingProject(true)}
          unavailable={
            workspaceLoaded &&
            !!repositoryLocation &&
            (!repositoryLocation.valid || !!repositoryLocation.projectId)
          }
        />
      )}
      <dialog
        ref={projectDialogRef}
        className="pw-project-dialog"
        onCancel={() => setCreatingProject(false)}
        onClose={() => {
          setCreatingProject(false);
          repositoryFromComposer.current = false;
        }}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action(async () => {
              const p = await api('/projects', {
                name: name.trim(),
                sourcePath: source.trim() || undefined,
              });
              setName('');
              setSource('');
              setCreatingProject(false);
              if (repositoryView) {
                await refresh();
                void navigate(repositoryURL(p.id));
              } else if (repositoryFromComposer.current) {
                setProject(p.id);
                setRepositoryTaskScope(null);
                requestAnimationFrame(() => composerRef.current?.focus());
              } else newTask(p.id);
            });
          }}
        >
          <div className="pw-dialog-heading">
            <h2>{repositoryDialog ? 'New repository' : 'Create project'}</h2>
            <IconButton
              icon="close"
              label="Close create project"
              onClick={() => setCreatingProject(false)}
            />
          </div>
          <p>
            {repositoryDialog
              ? 'Start a hosted repository or import a Git repository.'
              : 'Keep related tasks together in a shared repository.'}
          </p>
          <label>
            {repositoryDialog ? 'Repository name' : 'Project name'}
            <input
              autoFocus
              required
              aria-label={repositoryDialog ? 'Repository name' : 'Project name'}
              placeholder={repositoryDialog ? 'My repository' : 'My project'}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            Repository <span className="pw-muted">(optional)</span>
            <input
              aria-label="Repository source"
              placeholder="Local path or Git URL"
              value={source}
              onChange={(e) => setSource(e.target.value)}
            />
          </label>
          <p className="pw-muted">Leave blank to start with an empty repository.</p>
          {error && (
            <p className="pw-error" role="alert">
              {error}
            </p>
          )}
          <div className="pw-dialog-actions">
            <Button variant="link" onClick={() => setCreatingProject(false)}>
              Cancel
            </Button>
            <button className="pw-primary" disabled={!name.trim() || busy}>
              {repositoryDialog ? 'Create repository' : 'Create project'}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}

function checkOutput(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'object') {
    const item = value as Row;
    if (item.text || item.output || item.message)
      return String(item.text || item.output || item.message);
    if (Array.isArray(item.content)) return item.content.map(checkOutput).join('\n');
    return Object.entries(item)
      .map(([key, content]) => `${key}: ${checkOutput(content)}`)
      .join('\n');
  }
  const raw = String(value);
  try {
    return checkOutput(JSON.parse(raw));
  } catch {
    return raw;
  }
}
