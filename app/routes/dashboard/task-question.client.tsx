'use client';
import { useState } from 'react';
import { WorkspaceIcon } from './workspace-icon';

export function TaskQuestion({
  question,
  disabled,
  answer,
}: {
  question: { id: string; question: string; options: string[] };
  disabled: boolean;
  answer: (value: string, dismiss?: boolean) => Promise<void>;
}) {
  const key = 'workspace-question-' + question.id;
  const [value, setValue] = useState(() => localStorage.getItem(key) || '');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  function change(next: string) {
    setValue(next);
    localStorage.setItem(key, next);
  }
  async function submit(dismiss = false) {
    setSending(true);
    setError('');
    try {
      await answer(value, dismiss);
      localStorage.removeItem(key);
    } catch (failure: any) {
      setError(failure.message);
    } finally {
      setSending(false);
    }
  }
  return (
    <form
      className="pw-question"
      aria-label="Agent question"
      onKeyDown={(e) => {
        if (
          e.key === 'Enter' &&
          (e.metaKey || e.ctrlKey) &&
          !disabled &&
          !sending &&
          value.trim()
        ) {
          e.preventDefault();
          void submit();
        }
      }}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="pw-question-heading">
        <WorkspaceIcon name="chat" />
        <span>Waiting for your answer</span>
      </div>
      <p id={'question-' + question.id}>{question.question}</p>
      <div className="pw-question-options">
        {question.options.map((option) => (
          <button
            type="button"
            key={option}
            aria-pressed={value === option}
            disabled={disabled || sending}
            onClick={() => change(option)}
          >
            {option}
          </button>
        ))}
      </div>
      <input
        aria-labelledby={'question-' + question.id}
        placeholder="Your answer…"
        maxLength={4000}
        value={value}
        disabled={disabled || sending}
        onChange={(e) => change(e.target.value)}
      />
      {error && <p role="alert">{error}</p>}
      <div className="pw-question-actions">
        <button type="button" disabled={disabled || sending} onClick={() => void submit(true)}>
          Skip
        </button>
        <button className="pw-question-submit" disabled={disabled || sending || !value.trim()}>
          {sending ? 'Sending…' : 'Continue'}
        </button>
      </div>
    </form>
  );
}
