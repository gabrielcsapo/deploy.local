'use client';
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from './shared';
import { choiceIndex, choiceKey, choicePosition, type ChipOption } from './chip-select';
import './chip-select.css';

export function ChipSelect({
  id,
  label,
  value,
  options,
  onChange,
  disabled = false,
  variant = 'chip',
}: {
  id?: string;
  label: string;
  value: string;
  options: readonly ChipOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  variant?: 'chip' | 'secondary';
}) {
  const generated = useId();
  const menuId = `${generated}-choices`;
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLSpanElement>(null);
  const [state, setState] = useState({ open: false, active: -1 });
  const unavailable = disabled || !options.length;
  const open = state.open && !unavailable;
  const active = options[state.active] ? state.active : choiceIndex(options, value);

  function close(restoreFocus = false) {
    menu.current?.hidePopover();
    setState((current) => ({ ...current, open: false }));
    if (restoreFocus) button.current?.focus({ preventScroll: true });
  }
  function select(next: string) {
    close(true);
    if (next !== value) onChange(next);
  }
  function keyDown(event: KeyboardEvent) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
    const next = choiceKey({ open, active }, event.key, options, value, unavailable);
    if (next.handled) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (next.restoreFocus) close(true);
    setState({ open: next.open, active: next.active });
    if (next.selected !== undefined && next.selected !== value) onChange(next.selected);
  }

  useLayoutEffect(() => {
    const list = menu.current;
    const trigger = button.current;
    if (!list || !trigger) return;
    if (!open) {
      list.hidePopover();
      return;
    }
    list.showPopover();
    const viewport = window.visualViewport;
    const bounds = {
      left: viewport?.offsetLeft ?? 0,
      top: viewport?.offsetTop ?? 0,
      width: viewport?.width ?? document.documentElement.clientWidth,
      height: viewport?.height ?? document.documentElement.clientHeight,
    };
    // Measure the natural menu before constraining its height or choosing a side.
    list.style.width = '';
    list.style.maxHeight = '';
    list.style.maxWidth = `${bounds.width}px`;
    const position = choicePosition(
      trigger.getBoundingClientRect(),
      list.getBoundingClientRect(),
      bounds,
    );
    Object.assign(list.style, {
      left: `${position.left}px`,
      top: `${position.top}px`,
      width: `${position.width}px`,
      maxHeight: `${position.maxHeight}px`,
    });
    list.focus({ preventScroll: true });
    const dismiss = () => close();
    const scroll = (event: Event) => {
      if (event.target instanceof Node && list.contains(event.target)) return;
      close();
    };
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !list.contains(event.target) &&
        !trigger.contains(event.target)
      )
        close();
    };
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', dismiss);
    document.addEventListener('pointerdown', outside);
    viewport?.addEventListener('scroll', dismiss);
    viewport?.addEventListener('resize', dismiss);
    return () => {
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', dismiss);
      document.removeEventListener('pointerdown', outside);
      viewport?.removeEventListener('scroll', dismiss);
      viewport?.removeEventListener('resize', dismiss);
    };
  }, [open, options]);

  useLayoutEffect(() => {
    if (open) document.getElementById(`${menuId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active, menuId]);

  return (
    <span className="dl-choice">
      <button
        ref={button}
        id={id}
        type="button"
        className={variant === 'chip' ? 'dl-chip' : 'dl-btn secondary'}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        disabled={unavailable}
        onKeyDown={keyDown}
        onClick={() =>
          open ? close(true) : setState({ open: true, active: choiceIndex(options, value) })
        }
      >
        <span>{options.find((option) => option.value === value)?.label ?? options[0]?.label}</span>
        {variant === 'chip' && <Icon name="down" size={14} />}
      </button>
      <span
        ref={menu}
        id={menuId}
        popover="auto"
        className="dl-menu dl-choice-menu"
        role="listbox"
        aria-label={label}
        aria-activedescendant={open && active >= 0 ? `${menuId}-${active}` : undefined}
        tabIndex={-1}
        onKeyDown={keyDown}
        onToggle={(event) => {
          if (event.newState === 'closed') setState((current) => ({ ...current, open: false }));
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) close();
        }}
        onClick={(event) => event.preventDefault()}
      >
        <span className="dl-menu-label" aria-hidden="true">
          {label}
        </span>
        {options.map((option, index) => (
          <span
            key={option.value}
            id={`${menuId}-${index}`}
            role="option"
            aria-selected={option.value === value}
            className={`dl-menu-item${option.value === value ? ' on' : ''}`}
            data-active={index === active || undefined}
            onPointerMove={() => setState((current) => ({ ...current, active: index }))}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => select(option.value)}
          >
            {option.label}
          </span>
        ))}
      </span>
    </span>
  );
}
