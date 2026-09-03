'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * A shell command with a copy button.
 *
 * The `$` prompt is decorative: it lives outside the copied string and is
 * marked select-none, so dragging across the line — how people actually copy —
 * can't pick up a prompt that would break the paste.
 */
export function CopyCommand({ command, className = '' }: { command: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => clearTimeout(resetTimer.current ?? undefined), []);

  async function copy() {
    if (!(await writeClipboard(command))) return;
    setCopied(true);
    clearTimeout(resetTimer.current ?? undefined);
    resetTimer.current = setTimeout(() => setCopied(false), 1600);
  }

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
      <button
        type="button"
        onClick={copy}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-white/[0.06] px-2 py-1 text-[11px] font-medium text-text-tertiary transition-colors hover:border-white/20 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        aria-label={`Copy command: ${command}`}
      >
        {copied ? <IconCheck /> : <IconCopy />}
        <span className="hidden sm:inline">{copied ? 'Copied' : 'Copy'}</span>
      </button>
      <span aria-live="polite" className="sr-only">
        {copied ? 'Command copied to clipboard' : ''}
      </span>
    </div>
  );
}

/**
 * The Clipboard API needs a secure context, and this dashboard is reachable
 * over plain HTTP on the LAN — so keep the legacy path as a fallback rather
 * than leaving the button silently dead there.
 */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }

  try {
    const scratch = document.createElement('textarea');
    scratch.value = text;
    scratch.setAttribute('readonly', '');
    scratch.style.position = 'fixed';
    scratch.style.top = '0';
    scratch.style.opacity = '0';
    document.body.appendChild(scratch);
    scratch.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(scratch);
    return ok;
  } catch {
    return false;
  }
}

function IconCopy() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      className="size-3.5"
    >
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h8" strokeLinecap="round" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="size-3.5 text-success"
    >
      <path d="m5 13 4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
