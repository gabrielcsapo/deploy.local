'use client';

import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type Ref,
} from 'react';
import { copyPresentation, createCopyFeedback, type CopyFeedback } from './copy-feedback';
import { WorkspaceIcon, type WorkspaceIconName } from './WorkspaceIcon';

export type IconButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children' | 'aria-label' | 'title'
> & {
  icon: WorkspaceIconName;
  label: string;
  size?: 'compact' | 'default' | 'touch';
  pressed?: boolean;
  shortcut?: string;
  tone?: 'default' | 'danger';
  ref?: Ref<HTMLButtonElement>;
};

export function IconButton({
  icon,
  label,
  size = 'default',
  pressed,
  shortcut,
  tone = 'default',
  className = '',
  type = 'button',
  ...props
}: IconButtonProps) {
  if (!label.trim()) throw new Error('IconButton requires a nonempty label');
  return (
    <button
      {...props}
      type={type}
      className={`ui-icon-button ${className}`}
      data-size={size}
      data-tone={tone}
      aria-label={label}
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-pressed={pressed}
    >
      <WorkspaceIcon name={icon} />
    </button>
  );
}

export function ActionCluster({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={`ui-action-cluster ${className}`} />;
}

export function CopyButton({
  text,
  label,
  menuItem = false,
  ...props
}: Omit<IconButtonProps, 'icon' | 'onClick' | 'pressed'> & { text: string; menuItem?: boolean }) {
  const [state, setState] = useState<CopyFeedback>('idle');
  const [feedback] = useState(() =>
    createCopyFeedback(setState, (text) => navigator.clipboard.writeText(text)),
  );
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => () => feedback.dispose(), [feedback]);
  useEffect(() => {
    if (state === 'fallback') {
      field.current?.focus();
      field.current?.select();
    }
  }, [state]);
  const { icon, announcement } = copyPresentation(state);
  return (
    <span className="ui-copy-action">
      {menuItem ? (
        <button
          type="button"
          className="ui-copy-menu-item"
          onClick={() => void feedback.copy(text)}
          aria-label={label}
        >
          <WorkspaceIcon name={icon} />
          {state === 'copied' ? 'Copied' : label}
        </button>
      ) : (
        <IconButton {...props} icon={icon} label={label} onClick={() => void feedback.copy(text)} />
      )}
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
      {state === 'fallback' && (
        <span className="ui-copy-fallback">
          <label>
            {' '}
            Select and copy the text
            <textarea
              ref={field}
              readOnly
              value={text}
              aria-label={`${label}: select text to copy`}
            />
          </label>
          <IconButton
            icon="close"
            label="Close copy fallback"
            size="compact"
            onClick={() => feedback.reset()}
          />
        </span>
      )}
    </span>
  );
}

/** Preserve native link behavior (new tabs, download and context menus) for icon navigation. */
export function IconLink({
  icon,
  label,
  size = 'default',
  className = '',
  ...props
}: Omit<
  import('react').AnchorHTMLAttributes<HTMLAnchorElement>,
  'children' | 'aria-label' | 'title'
> & { icon: WorkspaceIconName; label: string; size?: IconButtonProps['size'] }) {
  return (
    <a
      {...props}
      className={`ui-icon-button ${className}`}
      data-size={size}
      aria-label={label}
      title={label}
    >
      <WorkspaceIcon name={icon} />
    </a>
  );
}
