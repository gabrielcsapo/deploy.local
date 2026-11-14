'use client';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useDataSeed, readSeeded } from '../../../routes/dashboard/v2/data/seeds';
import { formatTime } from '../../../routes/dashboard/v2/data/time';
import { AgentAvatar } from './AgentAvatar';
import type { AgentConfiguration } from '../../../../shared/v2/contracts';
import { Icon, IconButton, type ComponentState } from './shared';
import { Dialog } from './Dialog';
import { useLocation } from 'react-flight-router/client';
import { chosenProject, projectParameter } from '../../../routes/dashboard/v2/start/chosen-project';
import type { Attachment, ComputerModels } from '../../../../shared/v2/contracts';
import {
  mediaRequest,
  submitMessage,
  uploadFile,
  type ComposerMessage,
} from '../../../routes/dashboard/v2/markup/client';
import '../../../routes/dashboard/v2/markup/style.css';

export function Composer({
  project = 'deploy.local',
  computer = 'Any free computer',
  model = 'Auto',
  disabled,
  loading,
  onSend,
  onAttach,
  onModel,
  onVoice,
  footer,
  suggestedText,
}: ComponentState & {
  project?: string | null;
  computer?: string | null;
  model?: string;
  onSend?: (text: string, message?: ComposerMessage) => void | Promise<void>;
  onAttach?: () => void;
  onModel?: () => void;
  onVoice?: () => void;
  footer?: ReactNode;
  suggestedText?: { text: string; nonce: number };
}) {
  const seed = useDataSeed();
  const id = useId();
  const location = useLocation();
  const picker = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  useEffect(() => {
    if (suggestedText) setText(suggestedText.text);
  }, [suggestedText]);
  const [agents, setAgents] = useState<AgentConfiguration[]>(
    () =>
      (seed?.data['/api/v2/agents'] as { agents: AgentConfiguration[] } | undefined)?.agents ?? [],
  );
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionClosed, setMentionClosed] = useState(false);
  const mentionQuery = !mentionClosed && text.match(/(?:^|\s)@([^@\n]*)$/)?.[1];
  const matches =
    typeof mentionQuery === 'string'
      ? agents.filter((a) => a.name.toLowerCase().includes(mentionQuery.toLowerCase()))
      : [];
  function chooseMention(agent: AgentConfiguration) {
    setText(text.replace(/@[^@\n]*$/, `@${agent.name} `));
    setMentionClosed(true);
  }
  useEffect(() => {
    readSeeded(seed, '/api/v2/agents', () => mediaRequest('/agents'))
      .then((v) => setAgents(v.agents))
      .catch(() => {});
  }, [seed]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [menu, setMenu] = useState<'attach' | 'model' | 'screenshot' | 'project' | null>(null);
  const [models, setModels] = useState<ComputerModels | null>(
    () => (seed?.data['/api/v2/computers/models'] as ComputerModels) ?? null,
  );
  const [override, setOverride] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [context, setContext] = useState<{
    taskId?: string;
    agentId?: string;
    home?: boolean;
    projectId?: string;
    /** The project a New task link chose for the start page. */
    chosen?: { id: string; name: string };
  }>({});
  const [target, setTarget] = useState('web');
  const [address, setAddress] = useState('');
  const [projectPath, setProjectPath] = useState('');
  const [files, setFiles] = useState<any[]>([]);
  const [projectRef, setProjectRef] = useState('HEAD');
  const busy = disabled || loading || pending;
  // A project heading's + opens the start page with its project chosen (?project=<id>).
  const chosenId = projectParameter(location.pathname, location.search);
  useEffect(() => {
    const path = location.pathname;
    setText('');
    setAttachments([]);
    setOverride(null);
    setError('');
    let active = true;
    const taskId = path.match(/^\/dashboard\/tasks\/([^/]+)/)?.[1];
    const agentId = path.match(/^\/dashboard\/agents\/([^/]+)$/)?.[1];
    const home = path === '/dashboard' || path === '/dashboard/';
    setContext({ taskId, agentId, home });
    if (home && chosenId)
      void readSeeded(seed, '/api/v2/projects', () => mediaRequest('/projects'))
        .then((value: { projects?: { id: string; name: string }[] }) => {
          const chosen = chosenProject(chosenId, value?.projects);
          if (active && chosen) setContext({ home, chosen });
        })
        .catch(() => {});
    if (taskId)
      void readSeeded(seed, `/api/v2/tasks/${encodeURIComponent(taskId)}`, () =>
        mediaRequest(`/tasks/${encodeURIComponent(taskId)}`),
      )
        .then((value) => {
          if (!active) return;
          setContext({ taskId, projectId: value.project?.id });
          const last = value.screenshots?.at(-1);
          if (last) {
            setTarget(last.target.kind);
            setAddress(last.target.url || last.target.device || '');
          }
        })
        .catch(() => {});
    void readSeeded(seed, '/api/v2/computers/models', () => mediaRequest('/computers/models'))
      .then((value) => {
        if (active) setModels(value);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [location.pathname, chosenId, seed]);
  async function perform(action: () => Promise<void>) {
    setPending(true);
    setError('');
    try {
      await action();
    } catch (failure: any) {
      setError(failure.message);
    } finally {
      setPending(false);
    }
  }
  async function takeScreenshots() {
    await perform(async () => {
      await mediaRequest(`/tasks/${encodeURIComponent(context.taskId!)}/screenshots`, 'POST', {
        target:
          target === 'web' ? { kind: target, url: address } : { kind: target, device: address },
        widths: [390, 1440],
        text: text.trim() || undefined,
      });
      setMenu(null);
      setText('');
      window.dispatchEvent(new Event('deploy:conversation-changed'));
    });
  }
  async function send() {
    if (busy || !text.trim()) return;
    if (
      context.taskId &&
      !attachments.length &&
      /^(show me what it looks like|(?:take|show me) (?:a |some )?screenshots?)/i.test(text.trim())
    ) {
      if (address.trim()) await takeScreenshots();
      else setMenu('screenshot');
      return;
    }
    await perform(async () => {
      const message = { text: text.trim(), attachments, model: override };
      if (context.taskId || context.agentId || context.home) {
        const result = await submitMessage(
          message,
          context.taskId,
          context.agentId,
          context.home ? context.chosen?.id : undefined,
        );
        if (context.home) {
          window.location.assign(`/dashboard/tasks/${encodeURIComponent(result.taskId)}`);
          return;
        }
        window.dispatchEvent(new Event('deploy:conversation-changed'));
      } else await onSend?.(message.text, message);
      setText('');
      setAttachments([]);
    });
  }
  function pick(accept: string, camera = false) {
    if (!picker.current) return;
    picker.current.accept = accept;
    if (camera) picker.current.setAttribute('capture', 'environment');
    else picker.current.removeAttribute('capture');
    setMenu(null);
    picker.current.click();
  }
  async function projectFiles(path: string) {
    const value = await mediaRequest(
      `/attachments/projects/${encodeURIComponent(context.projectId!)}?path=${encodeURIComponent(path)}&ref=${encodeURIComponent(projectRef)}`,
    );
    setFiles(value.entries);
    setProjectPath(path);
    setProjectRef(value.commit);
  }
  const selectedModel = models?.choices.find((choice) => choice.id === override);
  const defaultId = models?.defaults[context.agentId ? 'answering-questions' : 'writing-code'];
  const defaultModel = models?.choices.find((choice) => choice.id === defaultId);
  return (
    <>
      <form
        className="dl-composer"
        aria-busy={busy || undefined}
        data-disabled={disabled || undefined}
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        {!!attachments.length && (
          <div className="dl-composer-files">
            {attachments.map((attachment) => (
              <span className="dl-chip" key={attachment.ref}>
                <Icon name={attachment.kind === 'file' ? 'file' : 'file'} size={14} />
                <span>
                  {attachment.name}
                  <small>{(attachment.bytes / 1024).toFixed(0)} KiB</small>
                </span>
                <button
                  type="button"
                  className="dl-icon-btn sm"
                  aria-label={`Remove ${attachment.name}`}
                  disabled={busy}
                  onClick={() =>
                    setAttachments((items) => items.filter((item) => item.ref !== attachment.ref))
                  }
                >
                  <Icon name="close" size={14} />
                </button>
              </span>
            ))}
          </div>
        )}
        {typeof mentionQuery === 'string' && (
          <div
            className="dl-agent-mentions"
            role="listbox"
            aria-label="Bring an agent into this task"
          >
            <p className="dl-meta">Bring an agent into this task</p>
            {matches.map((agent, index) => (
              <button
                type="button"
                role="option"
                aria-selected={index === mentionIndex}
                key={agent.id}
                className="dl-item"
                onClick={() => chooseMention(agent)}
              >
                <AgentAvatar id={agent.id} avatar={agent.avatar} />
                <span className="dl-t">
                  <span className="dl-agent-name">{agent.name}</span>
                  <span>{agent.lastMessage?.text || 'Say hello'}</span>
                </span>
                {agent.lastMessage && (
                  <span className="dl-meta">{formatTime(agent.lastMessage.at, 'list')}</span>
                )}
              </button>
            ))}
            {!matches.length && (
              <p className="dl-meta">
                {agents.length ? (
                  'No matching agents'
                ) : (
                  <a href="/dashboard/agents/new">New agent</a>
                )}
              </p>
            )}
            <p className="dl-meta">Select a name, then send your message.</p>
          </div>
        )}
        <label htmlFor={id} className="dl-sr">
          Message
        </label>
        <input
          id={id}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setMentionClosed(false);
            setMentionIndex(0);
          }}
          onKeyDown={(event) => {
            if (typeof mentionQuery !== 'string') return;
            if (event.key === 'Escape') {
              event.preventDefault();
              setMentionClosed(true);
            } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              setMentionIndex((i) =>
                Math.max(0, Math.min(matches.length - 1, i + (event.key === 'ArrowDown' ? 1 : -1))),
              );
            } else if (event.key === 'Enter' && matches[mentionIndex]) {
              event.preventDefault();
              chooseMention(matches[mentionIndex]);
            }
          }}
          disabled={busy}
          placeholder="Ask, build, or follow up…"
        />
        <div className="dl-composer-bar">
          <IconButton
            icon="plus"
            label="Attach"
            className="sm"
            disabled={busy}
            onClick={() => {
              if (onAttach) onAttach();
              else setMenu('attach');
            }}
          />
          {project && (
            <span className="dl-chip">
              <Icon name="folder" size={14} />
              {context.chosen?.name ?? project}
            </span>
          )}
          {computer && (
            <span className="dl-chip">
              <Icon name="computer" size={14} />
              {computer}
            </span>
          )}
          <span className="dl-grow" />
          <button
            type="button"
            className="dl-model"
            onClick={() => {
              if (onModel) onModel();
              else setMenu('model');
            }}
            disabled={busy}
            aria-label={`Model for this chat: ${selectedModel?.name || defaultModel?.name || (onModel ? model : 'Auto')}`}
          >
            {selectedModel?.name || defaultModel?.name || (onModel ? model : 'Auto')}
            <Icon name="down" size={12} />
          </button>
          <IconButton
            icon="voice"
            label="Voice"
            className="sm"
            disabled={busy || !onVoice}
            onClick={onVoice}
          />
          <button
            className="dl-send"
            type="submit"
            aria-label={pending ? 'Sending' : 'Send'}
            disabled={busy || !text.trim()}
          >
            <Icon name={pending ? 'running' : 'send'} className={pending ? 'dl-spin' : ''} />
          </button>
        </div>
        {error && (
          <p className="dl-field-error" role="alert">
            {error}
          </p>
        )}
        {footer}
      </form>
      <input
        type="file"
        multiple
        hidden
        ref={picker}
        onChange={(event) => {
          const selected = Array.from(event.target.files || []);
          event.target.value = '';
          void perform(async () => {
            if (attachments.length + selected.length > 8)
              throw new Error('At most eight attachments are allowed');
            for (const file of selected) {
              const attachment = await uploadFile(file, file.name);
              setAttachments((items) => [...items, attachment]);
            }
          });
        }}
      />
      <Dialog open={menu === 'attach'} onClose={() => setMenu(null)} title="Attach">
        <div className="dl-media-options">
          <button
            type="button"
            className="dl-item"
            onClick={() => pick('image/png,image/jpeg,image/webp,image/gif')}
          >
            <Icon name="file" />
            Photos
          </button>
          <button type="button" className="dl-item" onClick={() => pick('image/*', true)}>
            <Icon name="file" />
            Take a photo
          </button>
          <button
            type="button"
            className="dl-item"
            onClick={() =>
              pick('.txt,.md,.csv,.json,.pdf,.zip,.xlsx,.docx,.png,.jpg,.jpeg,.gif,.webp')
            }
          >
            <Icon name="file" />
            Files
          </button>
          <button
            type="button"
            className="dl-item"
            disabled={!context.taskId}
            onClick={() => setMenu('screenshot')}
          >
            <Icon name="file" />A screenshot of the app
          </button>
          <button
            type="button"
            className="dl-item"
            disabled={!context.projectId}
            onClick={() => {
              setMenu('project');
              void perform(() => projectFiles(''));
            }}
          >
            <Icon name="folder" />A file from {project}
          </button>
        </div>
        <p className="dl-meta">
          Only the files you pick are shared. Up to 10 MiB each. Screenshots and project files are
          available within a task.
        </p>
      </Dialog>
      <Dialog open={menu === 'model'} onClose={() => setMenu(null)} title="Model for this chat">
        <p className="dl-meta">
          Only changes this chat. Defaults live in{' '}
          <a href="/dashboard/computers/models">Computers › Models</a>.
        </p>
        <div className="dl-media-options">
          {[
            { id: '', name: `Auto${defaultModel ? ` · ${defaultModel.name}` : ''}` },
            ...(models?.choices || []),
          ].map((choice) => (
            <label className="dl-item" key={choice.id}>
              <input
                type="radio"
                name={`${id}-model`}
                checked={(override || '') === choice.id}
                onChange={() => {
                  setOverride(choice.id || null);
                  setMenu(null);
                }}
              />
              {choice.name}
            </label>
          ))}
        </div>
        {!models && <p className="dl-meta">Models are unavailable. Check Computers › Models.</p>}
      </Dialog>
      <Dialog
        open={menu === 'screenshot'}
        onClose={() => {
          if (!pending) setMenu(null);
        }}
        title="A screenshot of the app"
        loading={pending}
        actions={
          <button
            type="button"
            className="dl-btn primary"
            disabled={pending || !address.trim()}
            onClick={() => void takeScreenshots()}
          >
            Take screenshots
          </button>
        }
      >
        <label className="dl-media-field">
          App type
          <select value={target} onChange={(event) => setTarget(event.target.value)}>
            <option value="web">Web app · phone and laptop</option>
            <option value="ios-simulator">iOS simulator</option>
            <option value="desktop">Desktop window</option>
          </select>
        </label>
        <label className="dl-media-field">
          {target === 'web'
            ? 'App address on its computer'
            : target === 'ios-simulator'
              ? 'Simulator UUID'
              : 'Approved window ID'}
          <input value={address} onChange={(event) => setAddress(event.target.value)} />
        </label>
        <p className="dl-meta">
          Taken on the task’s computer. Desktop windows require Use the screen permission.
        </p>
        {error && (
          <p role="alert" className="dl-field-error">
            {error}
          </p>
        )}
      </Dialog>
      <Dialog
        open={menu === 'project'}
        onClose={() => setMenu(null)}
        title={`A file from ${project}`}
      >
        <p className="dl-meta">{projectPath || '/'} · saved project version</p>
        {projectPath && (
          <button
            type="button"
            className="dl-btn secondary"
            onClick={() =>
              void perform(() => projectFiles(projectPath.split('/').slice(0, -1).join('/')))
            }
          >
            Back
          </button>
        )}
        <div className="dl-media-options">
          {files.map((file) => (
            <button
              type="button"
              className="dl-item"
              key={file.path}
              disabled={pending || attachments.length >= 8}
              onClick={() =>
                void perform(async () => {
                  if (file.type === 'tree') await projectFiles(file.path);
                  else {
                    const value = await mediaRequest(
                      `/attachments/projects/${encodeURIComponent(context.projectId!)}`,
                      'POST',
                      { path: file.path, ref: projectRef },
                    );
                    setAttachments((items) => [...items, value.attachment]);
                    setMenu(null);
                  }
                })
              }
            >
              <Icon name={file.type === 'tree' ? 'folder' : 'file'} />
              {file.name}
            </button>
          ))}
        </div>
        {error && (
          <p role="alert" className="dl-field-error">
            {error}
          </p>
        )}
      </Dialog>
    </>
  );
}
