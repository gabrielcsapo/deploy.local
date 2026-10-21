'use client';
import { useId, useRef, useState, type ReactNode } from 'react';
import { IconButton } from './IconButton';

/** Native popover dismissal, keyboard focus and a quiet, labelled utility trigger. */
export function OverflowMenu({
  label = 'More',
  children,
}: {
  label?: string;
  children: ReactNode;
}) {
  const id = useId();
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <span className="ui-overflow">
      <IconButton
        icon="more"
        label={label}
        popoverTarget={id}
        aria-expanded={open}
        aria-controls={id}
      />
      <div
        id={id}
        ref={menu}
        popover="auto"
        className="ui-overflow-menu"
        onToggle={(event) => {
          setOpen(event.newState === 'open');
          if (event.newState === 'open')
            menu.current?.querySelector<HTMLElement>('button:not(:disabled),a[href]')?.focus();
        }}
        onKeyDown={(event) => {
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
          const items = [
            ...menu.current!.querySelectorAll<HTMLElement>('button:not(:disabled),a[href]'),
          ];
          if (!items.length) return;
          event.preventDefault();
          const at = items.indexOf(document.activeElement as HTMLElement);
          items[
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? items.length - 1
                : (at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
          ]?.focus();
        }}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('[data-dismiss-menu]'))
            menu.current?.hidePopover();
        }}
      >
        {children}
      </div>
    </span>
  );
}
