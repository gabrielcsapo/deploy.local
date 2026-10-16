import type { ReactNode } from 'react';

export function WorkspaceIcon({ name, className = '' }: { name: string; className?: string }) {
  const paths: Record<string, ReactNode> = {
    'pull-request': (
      <>
        <circle cx="6" cy="5" r="2" />
        <circle cx="6" cy="19" r="2" />
        <circle cx="18" cy="19" r="2" />
        <path d="M6 7v10m7-12h1a4 4 0 0 1 4 4v8m-5-9-3-3 3-3" />
      </>
    ),
    expand: <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" />,
    collapse: <path d="M3 8h5V3m13 5h-5V3M8 21v-5H3m13 5v-5h5" />,
    keyboard: (
      <>
        <rect x="2" y="5" width="20" height="14" rx="3" />
        <path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 16h10" />
      </>
    ),
    user: (
      <>
        <circle cx="12" cy="8" r="3.5" />
        <path d="M5 21v-2a7 7 0 0 1 14 0v2" />
      </>
    ),
    terminal: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="4" />
        <path d="m7 9 3 3-3 3m6 0h4" />
      </>
    ),
    compose: (
      <>
        <path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" />
        <path d="m15 5 4 4m-10 6 1-5 8-8 4 4-8 8-5 1Z" />
      </>
    ),
    folder: (
      <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Zm0 3h18" />
    ),
    search: (
      <>
        <circle cx="10" cy="10" r="6" />
        <path d="m15 15 5 5" />
      </>
    ),
    'sign-out': <path d="M10 4H5v16h5m5-12 4 4-4 4m-6-4h10" />,
    plus: <path d="M12 5v14M5 12h14" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    chevron: <path d="m9 6 6 6-6 6" />,
    'chevron-down': <path d="m7 9.5 5 5 5-5" />,
    'chevron-left': <path d="m15 6-6 6 6 6" />,
    'arrow-right': <path d="M5 12h14m-6-6 6 6-6 6" />,
    check: <path d="m5 12 4 4L19 6" />,
    circle: <circle cx="12" cy="12" r="7" />,
    alert: (
      <>
        <circle cx="12" cy="12" r="8" />
        <path d="M12 7v6m0 4h.01" />
      </>
    ),
    bolt: <path d="m13 2-9 12h7l-1 8 10-12h-7l1-8Z" />,
    reset: (
      <>
        <path d="M4 5v6h6" />
        <path d="M4.6 10a8 8 0 1 1 1.4 8" />
      </>
    ),
    file: (
      <>
        <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" />
        <path d="M14 3v6h6" />
      </>
    ),
    arrow: <path d="M12 19V5m-6 6 6-6 6 6" />,
    stop: <rect x="7" y="7" width="10" height="10" rx="1" fill="currentColor" stroke="none" />,
    computer: (
      <>
        <rect x="3" y="4" width="18" height="13" rx="2" />
        <path d="M8 21h8m-4-4v4" />
      </>
    ),
    sidebar: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="3" />
        <path d="M15 4v16" />
      </>
    ),
    chat: (
      <path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-8l-5 3v-3H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" />
    ),
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </>
    ),
    settings: (
      <>
        <path d="M4 7h16M4 17h16" />
        <circle cx="9" cy="7" r="2" fill="var(--pw-rail)" />
        <circle cx="15" cy="17" r="2" fill="var(--pw-rail)" />
      </>
    ),
  };
  return (
    <svg
      className={`pw-icon ${className}`}
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths[name]}
    </svg>
  );
}
