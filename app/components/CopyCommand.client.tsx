'use client';

import { CopyButton } from './ui';

/**
 * A shell command with a copy button.
 *
 * The `$` prompt is decorative: it lives outside the copied string and is
 * marked select-none, so dragging across the line — how people actually copy —
 * can't pick up a prompt that would break the paste.
 */
export function CopyCommand({ command, className = '' }: { command: string; className?: string }) {
  return (
    <div
      className={`group flex items-center gap-3 rounded-lg border border-white/[0.06] bg-bg/80 px-4 py-3 text-left backdrop-blur-sm ${className}`}
    >
      <span className="select-none font-mono text-sm text-text-tertiary" aria-hidden>
        $
      </span>
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-sm text-text">
        {command}
      </code>
      <CopyButton label="Copy command" text={command} />
    </div>
  );
}
