'use client';
import { useEffect, useId, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Action, Glyph } from '@/components/ui';
import type { InboxItem } from '../../../../../shared/v2/contracts';
import { questionActions, askedTime } from './presentation';
import './question.css';

export function QuestionDecision({
  item,
  name,
  note,
  setNote,
  pending,
  choose,
}: {
  item: InboxItem;
  name: string;
  note: string;
  setNote: (value: string) => void;
  pending: boolean;
  choose: (action: InboxItem['actions'][number]) => void;
}) {
  const id = useId();
  const draft = useRef<HTMLElement>(null);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const element = draft.current;
    if (!element) {
      setOverflows(false);
      return;
    }
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    measure();
    return () => observer.disconnect();
  }, [item.context?.text]);
  const { options, answer, dismiss } = questionActions(item);
  return (
    <section className="dl-question-decision" aria-labelledby={`${id}-name`}>
      <header className="dl-decision-header">
        <Glyph kind={item.from === 'warden' ? 'warden' : ''}>{name[0]}</Glyph>
        <div className="dl-decision-identity">
          <h2 id={`${id}-name`} className="dl-decision-name">
            {name}
          </h2>
          <span className="dl-meta">
            {item.projectName && `${item.projectName} · `}
            {askedTime(item.createdAt)}
          </span>
        </div>
      </header>
      <p className="dl-decision-question">{item.text || item.title}</p>
      {(item.context || item.taskId) && (
        <div className="dl-decision-preview">
          {item.context && (
            <article
              ref={draft}
              className="dl-decision-draft dl-reply"
              tabIndex={0}
              aria-label="Question context"
            >
              <div>
                <Markdown remarkPlugins={[remarkGfm]}>{item.context.text}</Markdown>
              </div>
            </article>
          )}
          {item.taskId && (
            <div className="dl-decision-task">
              {overflows && <span>Scroll to read more</span>}
              <a href={`/dashboard/tasks/${encodeURIComponent(item.taskId)}`}>Open the task</a>
            </div>
          )}
        </div>
      )}
      {options.length > 0 && (
        <div className="dl-decision-options" role="group" aria-label="Choose an answer">
          {options.map((action) => (
            <Action
              key={action.id}
              variant={action.primary ? 'primary' : 'secondary'}
              disabled={pending}
              onClick={() => choose(action)}
            >
              {action.label}
            </Action>
          ))}
        </div>
      )}
      <form
        className="dl-decision-answer"
        onSubmit={(event) => {
          event.preventDefault();
          if (answer && note.trim() && !pending) choose(answer);
        }}
      >
        {answer && (
          <>
            <label className="dl-field-label" htmlFor={`${id}-answer`}>
              Your answer
            </label>
            <textarea
              id={`${id}-answer`}
              className="dl-field"
              rows={2}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              disabled={pending}
              maxLength={4000}
            />
          </>
        )}
        <div className="dl-decision-footer">
          {dismiss && (
            <Action variant="quiet" disabled={pending} onClick={() => choose(dismiss)}>
              {dismiss.label}
            </Action>
          )}
          {answer && (
            <Action type="submit" variant="secondary" disabled={pending || !note.trim()}>
              {answer.label}
            </Action>
          )}
        </div>
      </form>
    </section>
  );
}
