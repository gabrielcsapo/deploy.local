'use client';
import { useId, useState, type ReactNode } from 'react';
import { Icon, IconButton, type ComponentState } from './shared';
export function Composer({
  project = 'deploy.local',
  computer = 'Any free computer',
  model = 'Opus',
  disabled,
  loading,
  onSend,
  onAttach,
  onModel,
  onVoice,
  footer,
}: ComponentState & {
  project?: string;
  computer?: string;
  model?: string;
  onSend?: (text: string) => void;
  onAttach?: () => void;
  onModel?: () => void;
  onVoice?: () => void;
  footer?: ReactNode;
}) {
  const id = useId();
  const [text, setText] = useState('');
  return (
    <form
      className="dl-composer"
      aria-busy={loading || undefined}
      data-disabled={disabled || undefined}
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled && !loading && text.trim()) onSend?.(text.trim());
      }}
    >
      <label htmlFor={id} className="dl-sr">
        Message
      </label>
      <input
        id={id}
        value={text}
        onChange={(event) => setText(event.target.value)}
        disabled={disabled || loading}
        placeholder="Ask, build, or follow up…"
      />
      <div className="dl-composer-bar">
        <IconButton
          icon="plus"
          label="Attach"
          className="sm"
          disabled={disabled || loading || !onAttach}
          onClick={onAttach}
        />
        <span className="dl-chip">
          <Icon name="folder" size={14} />
          {project}
        </span>
        <span className="dl-chip">
          <Icon name="computer" size={14} />
          {computer}
        </span>
        <span className="dl-grow" />
        <button
          type="button"
          className="dl-model"
          onClick={onModel}
          disabled={disabled || loading || !onModel}
          aria-label={`Model for this chat: ${model}`}
        >
          {model}
          <Icon name="down" size={12} />
        </button>
        <IconButton
          icon="voice"
          label="Voice"
          className="sm"
          disabled={disabled || loading || !onVoice}
          onClick={onVoice}
        />
        <button
          className="dl-send"
          type="submit"
          aria-label={loading ? 'Sending' : 'Send'}
          disabled={disabled || loading || !onSend}
        >
          <Icon name={loading ? 'running' : 'send'} className={loading ? 'dl-spin' : ''} />
        </button>
      </div>
      {footer}
    </form>
  );
}
