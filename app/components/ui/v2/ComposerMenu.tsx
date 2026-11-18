'use client';
import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { Icon } from './shared';
import { menuPosition, type MenuPlacement } from './composer-menu';
import './chip-select.css';

/** Rows of this menu only, not of a submenu inside it. */
function rows(menu: HTMLElement) {
  return Array.from(
    menu.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled]), input'),
  ).filter((row) => row.closest('[role="menu"]') === menu);
}

/**
 * A small menu in the top layer, beside the control that opened it: the composer's project,
 * computer and model menus, and their submenus. Clicking outside or Escape closes it.
 */
export function PopoverMenu({
  anchor,
  open,
  onClose,
  label,
  placement = 'start',
  onHoverRow,
  children,
}: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  label: string;
  placement?: MenuPlacement;
  /** The pointer moved onto one of this menu's rows that opens no submenu. */
  onHoverRow?: () => void;
  children: ReactNode;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const list = menu.current;
    const trigger = anchor.current;
    if (!list || !trigger) return;
    if (!open) {
      if (list.matches(':popover-open')) list.hidePopover();
      return;
    }
    list.showPopover();
    const place = () => {
      const viewport = window.visualViewport;
      list.style.maxHeight = '';
      const position = menuPosition(
        trigger.getBoundingClientRect(),
        list.getBoundingClientRect(),
        {
          left: viewport?.offsetLeft ?? 0,
          top: viewport?.offsetTop ?? 0,
          width: viewport?.width ?? document.documentElement.clientWidth,
          height: viewport?.height ?? document.documentElement.clientHeight,
        },
        placement,
      );
      Object.assign(list.style, {
        left: `${position.left}px`,
        top: `${position.top}px`,
        maxHeight: `${position.maxHeight}px`,
      });
    };
    place();
    (list.querySelector('input') ?? rows(list)[0])?.focus({ preventScroll: true });
    // Keep it beside its control as the menu, the window or the on-screen keyboard changes size.
    const observer = new ResizeObserver(place);
    observer.observe(list);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    window.visualViewport?.addEventListener('resize', place);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      window.visualViewport?.removeEventListener('resize', place);
    };
  }, [open, anchor, placement]);

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    const list = menu.current;
    if (!list || event.target instanceof HTMLElement === false) return;
    if ((event.target as HTMLElement).closest('[role="menu"]') !== list) return;
    if (event.key === 'Escape') {
      // Also from the search field, which would otherwise only clear itself.
      event.preventDefault();
      list.hidePopover();
      return;
    }
    const items = rows(list);
    const at = items.indexOf(event.target as HTMLElement);
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (step) {
      event.preventDefault();
      items[(at + step + items.length) % items.length]?.focus();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      items[event.key === 'Home' ? 0 : items.length - 1]?.focus();
    } else if (event.key === 'ArrowLeft' && placement === 'side') {
      event.preventDefault();
      onClose();
    }
  }

  return (
    <div
      ref={menu}
      popover="auto"
      role="menu"
      aria-label={label}
      className="dl-menu dl-choice-menu dl-composer-menu"
      data-placement={placement}
      onKeyDown={keyDown}
      onPointerOver={(event) => {
        const row = (event.target as HTMLElement).closest('[role^="menuitem"]');
        if (
          row &&
          row.closest('[role="menu"]') === menu.current &&
          !row.hasAttribute('aria-haspopup')
        )
          onHoverRow?.();
      }}
      onToggle={(event) => {
        // React passes a submenu's toggle up to this menu too; only this menu's own counts.
        if (event.target !== event.currentTarget) return;
        if (event.newState === 'closed' && open) {
          onClose();
          if (placement !== 'side') anchor.current?.focus({ preventScroll: true });
        }
      }}
    >
      {children}
    </div>
  );
}

/** One row: a name, an optional muted hint, and a check when it is chosen. */
export function MenuRow({
  children,
  hint,
  end,
  checked,
  kind = 'radio',
  disabled,
  onSelect,
}: {
  children: ReactNode;
  hint?: ReactNode;
  end?: ReactNode;
  checked?: boolean;
  kind?: 'radio' | 'checkbox' | 'item';
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role={kind === 'item' ? 'menuitem' : `menuitem${kind}`}
      aria-checked={kind === 'item' ? undefined : Boolean(checked)}
      className="dl-menu-item"
      disabled={disabled}
      onClick={onSelect}
    >
      <span>
        {children}
        {hint && <span className="dl-menu-hint"> {hint}</span>}
      </span>
      {checked ? (
        <span className="dl-end dl-menu-check">
          <Icon name="tick" size={14} />
        </span>
      ) : (
        end && <span className="dl-end">{end}</span>
      )}
    </button>
  );
}

/** A row that opens a submenu beside it (Effort, More models). */
export function SubMenu({
  label,
  end,
  open,
  disabled,
  onOpen,
  onClose,
  children,
}: {
  label: string;
  end?: ReactNode;
  open: boolean;
  disabled?: boolean;
  onOpen: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const row = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={row}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        className={`dl-menu-item${open ? ' on' : ''}`}
        disabled={disabled}
        // Hovering opens it first, so a click only ever opens: it must not close what hover opened.
        onClick={onOpen}
        onPointerEnter={(event) => {
          if (event.pointerType === 'mouse' && !disabled) onOpen();
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight' && !disabled) {
            event.preventDefault();
            onOpen();
          }
        }}
      >
        <span>{label}</span>
        <span className="dl-end">
          {end}
          <Icon name="chevron" size={12} />
        </span>
      </button>
      <PopoverMenu
        anchor={row}
        open={open}
        placement="side"
        label={label}
        onClose={() => {
          onClose();
          row.current?.focus({ preventScroll: true });
        }}
      >
        {children}
      </PopoverMenu>
    </>
  );
}

export function MenuSeparator() {
  return <span className="dl-menu-sep" role="separator" />;
}
