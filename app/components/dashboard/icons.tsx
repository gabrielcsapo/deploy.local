import type { SVGProps } from 'react';

const baseProps: SVGProps<SVGSVGElement> = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
};

export function OverviewIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...baseProps} {...p}>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

export function BuildIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...baseProps} {...p}>
      <path d="M14.7 6.3a3 3 0 1 0 4 4l-4-4z" />
      <path d="M16 8 4 20" />
      <path d="m8 12 4 4" />
    </svg>
  );
}

export function LogsIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...baseProps} {...p}>
      <path d="M4 6h16" />
      <path d="M4 12h10" />
      <path d="M4 18h16" />
    </svg>
  );
}

export function TerminalIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...baseProps} {...p}>
      <path d="M5 7l4 4-4 4" />
      <path d="M13 17h6" />
    </svg>
  );
}

export function RequestsIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...baseProps} {...p}>
      <path d="M3 3v18h18" />
      <path d="M7 14l4-4 4 4 5-6" />
    </svg>
  );
}

export function ResourcesIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...baseProps} {...p}>
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  );
}

export function HistoryIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...baseProps} {...p}>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

export function BackupsIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...baseProps} {...p}>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v6c0 1.7 4 3 9 3s9-1.3 9-3V5" />
      <path d="M3 11v6c0 1.7 4 3 9 3s9-1.3 9-3v-6" />
    </svg>
  );
}

export function DeploymentsIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...baseProps} {...p}>
      <path d="M4 7v10l8 4 8-4V7l-8-4-8 4z" />
      <path d="M4 7l8 4 8-4" />
      <path d="M12 11v10" />
    </svg>
  );
}

export function DiscoverIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...baseProps} {...p}>
      <circle cx="11" cy="11" r="8" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}

export function SettingsIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...baseProps} {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .4 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.4 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .4-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.4-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.4H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.4l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.4 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}

export function ChevronDownIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...baseProps} {...p}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function ExternalLinkIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...baseProps} {...p}>
      <path d="M15 3h6v6" />
      <path d="M10 14L21 3" />
      <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
    </svg>
  );
}

export function PlayIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...baseProps} {...p}>
      <polygon points="6 4 20 12 6 20 6 4" fill="currentColor" />
    </svg>
  );
}

export function PauseIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...baseProps} {...p}>
      <rect x="6" y="4" width="4" height="16" />
      <rect x="14" y="4" width="4" height="16" />
    </svg>
  );
}

export function CopyIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...baseProps} {...p}>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

export function DownloadIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...baseProps} {...p}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5" />
      <path d="M12 15V3" />
    </svg>
  );
}

export function SearchIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...baseProps} {...p}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

export function CalendarIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...baseProps} {...p}>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4" />
      <path d="M8 2v4" />
      <path d="M3 10h18" />
    </svg>
  );
}

export function RotateIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...baseProps} {...p}>
      <path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.4 2.6L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

export function PlusIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...baseProps} {...p}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

export function ClockIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...baseProps} {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </svg>
  );
}

export function AlertTriangleIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...baseProps} {...p}>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}
