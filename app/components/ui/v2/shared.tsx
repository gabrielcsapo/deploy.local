'use client';

import type { HTMLAttributes, ReactNode, ButtonHTMLAttributes } from 'react';
import './components.css';

export type ComponentState = { disabled?: boolean; loading?: boolean };
export type ComponentProps = HTMLAttributes<HTMLDivElement> & ComponentState;

export function stateProps({ disabled, loading }: ComponentState) {
  return {
    'aria-disabled': disabled || undefined,
    'aria-busy': loading || undefined,
    inert: disabled || loading || undefined,
    'data-disabled': disabled || undefined,
    'data-loading': loading || undefined,
  };
}

const paths = {
  compose: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  pulse: 'M3 12h4l3-7 4 14 3-7h4',
  computer: 'M5 4h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM8 20h8M12 16v4',
  plus: 'M12 5v14M5 12h14',
  chevron: 'M9 6l6 6-6 6',
  down: 'M6 9l6 6 6-6',
  menu: 'M4 7h16M4 12h16M4 17h16',
  panel: 'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM15 4v16',
  send: 'M12 19V5M5 12l7-7 7 7',
  bulb: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.6.6 1 1.4 1 2.5h6c0-1.1.4-1.9 1-2.5A6 6 0 0 0 12 3z',
  voice: 'M9 6a3 3 0 0 1 6 0v5a3 3 0 0 1-6 0zM5 11a7 7 0 0 0 14 0M12 18v3',
  search: 'M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0M20 20l-3.5-3.5',
  settings:
    'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M18 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0M12 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0M20 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0',
  running: 'M12 3a9 9 0 1 0 9 9',
  attention: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M12 7v6M12 17h.01',
  check: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M8 12l3 3 5-6',
  close: 'M6 6l12 12M18 6L6 18',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5',
  terminal:
    'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM7 9l3 3-3 3M13 15h4',
  merge:
    'M8 5a2 2 0 1 1-4 0 2 2 0 0 1 4 0M8 19a2 2 0 1 1-4 0 2 2 0 0 1 4 0M20 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0M6 7v10M6 7a7 7 0 0 0 10 5',
  cloud: 'M7 18a5 5 0 0 1-.6-10A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9z',
  clock: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M12 7v5l3 2',
  image:
    'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM21 16l-5-5-9 9M11 10a2 2 0 1 1-4 0 2 2 0 0 1 4 0',
  play: 'M8 5l11 7-11 7z',
  download: 'M12 4v12M6 10l6 6 6-6M5 20h14',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  // Design canvas: tools, layers and properties.
  move: 'M5 3l14 8-6 2-2 6z',
  hand: 'M8 13V5a1.5 1.5 0 0 1 3 0v6M11 11V4a1.5 1.5 0 0 1 3 0v7M14 11V6a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-3l-2-4a1.5 1.5 0 0 1 2.6-1.5L8 13',
  frame: 'M7 3v18M17 3v18M3 7h18M3 17h18',
  shape: 'M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  pen: 'M12 19l7-7 3 3-7 7zM18 13l-1.5-7.5L2 2l3.5 14.5L13 18zM2 2l7.6 7.6',
  text: 'M5 6V4h14v2M12 4v16M9 20h6',
  sticky: 'M5 4h14v10l-6 6H5zM13 20v-6h6',
  comment: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.6A8 8 0 1 1 21 12z',
  spark: 'M12 3l1.8 4.7 4.7 1.8-4.7 1.8L12 16l-1.8-4.7-4.7-1.8 4.7-1.8z',
  code: 'M9 8l-4 4 4 4M15 8l4 4-4 4',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
  stack:
    'M5 4h14a1.5 1.5 0 0 1 1.5 1.5v3A1.5 1.5 0 0 1 19 10H5a1.5 1.5 0 0 1-1.5-1.5v-3A1.5 1.5 0 0 1 5 4zM5 14h14a1.5 1.5 0 0 1 1.5 1.5v3A1.5 1.5 0 0 1 19 20H5a1.5 1.5 0 0 1-1.5-1.5v-3A1.5 1.5 0 0 1 5 14z',
  component: 'M12 3l4 4-4 4-4-4zM12 13l4 4-4 4-4-4z',
  vector: 'M4 18C8 6 16 6 20 18',
  branch:
    'M8 5a2 2 0 1 1-4 0 2 2 0 0 1 4 0M8 19a2 2 0 1 1-4 0 2 2 0 0 1 4 0M20 7a2 2 0 1 1-4 0 2 2 0 0 1 4 0M6 7v10M18 9c0 5-6 4-10 8',
  tokens:
    'M10 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0M20 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0M10 17a3 3 0 1 1-6 0 3 3 0 0 1 6 0M20 17a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  minus: 'M5 12h14',
  back: 'M15 6l-6 6 6 6',
  undo: 'M4 12a8 8 0 1 0 2.3-5.7L4 8.6M4 4v4.6h4.6',
  ellipse: 'M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  line: 'M5 19L19 5',
  keyboard:
    'M4 6h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zM6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10',
};
export type IconName = keyof typeof paths;
export function Icon({
  name,
  size = 16,
  className = '',
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d={paths[name]} />
    </svg>
  );
}

export function Action({
  variant = 'secondary',
  loading,
  disabled,
  className = '',
  children,
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> &
  ComponentState & { variant?: 'primary' | 'secondary' | 'quiet' | 'danger' }) {
  return (
    <button
      {...props}
      type={type}
      className={`dl-btn ${variant} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading && <Icon name="running" className="dl-spin" />}
      {children}
    </button>
  );
}
export function IconButton({
  icon,
  label,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string }) {
  return (
    <button type="button" {...props} aria-label={label} className={`dl-icon-btn ${className}`}>
      <Icon name={icon} />
    </button>
  );
}
export function Glyph({
  children,
  kind = '',
}: {
  children: ReactNode;
  kind?: '' | 'warden' | 'plain';
}) {
  return <span className={`dl-glyph ${kind}`}>{children}</span>;
}
