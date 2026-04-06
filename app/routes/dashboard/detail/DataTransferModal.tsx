'use client';

import { useEffect, useRef, useCallback } from 'react';
import { formatBytes } from '../../../utils';

export interface DataTransferStats {
  path: string;
  requestBytes: number;
  responseBytes: number;
  count: number;
}

interface DataTransferModalProps {
  dataTransfer: {
    totalRequestBytes: number;
    totalResponseBytes: number;
  };
  dataTransferByPath: DataTransferStats[];
  onClose: () => void;
}

export function DataTransferModal({
  dataTransfer,
  dataTransferByPath,
  onClose,
}: DataTransferModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  // Focus trap
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = dialog.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }, []);

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        className="bg-bg card max-w-4xl w-full max-h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        role="dialog"
        aria-modal="true"
        aria-labelledby="data-transfer-title"
      >
        <div className="px-6 py-4 border-b border-border flex items-center justify-between">
          <div>
            <h2 id="data-transfer-title" className="text-lg font-semibold">
              Data Transfer by Path
            </h2>
            <p className="text-xs text-text-secondary mt-1">
              Total: ↓ {formatBytes(dataTransfer.totalResponseBytes)} received, ↑{' '}
              {formatBytes(dataTransfer.totalRequestBytes)} sent
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-text-tertiary hover:text-text text-2xl leading-none"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="overflow-auto flex-1">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-bg">
              <tr className="border-b border-border text-left text-xs text-text-tertiary">
                <th className="px-4 py-3 font-medium">Path</th>
                <th className="px-4 py-3 font-medium text-right">Requests</th>
                <th className="px-4 py-3 font-medium text-right">Data Sent</th>
                <th className="px-4 py-3 font-medium text-right">Data Received</th>
                <th className="px-4 py-3 font-medium text-right">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {dataTransferByPath.map((stat) => (
                <tr key={stat.path} className="hover:bg-bg-hover transition-colors">
                  <td className="px-4 py-2 font-mono text-xs text-text-secondary max-w-[300px] truncate">
                    {stat.path}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-right">{stat.count}</td>
                  <td className="px-4 py-2 font-mono text-xs text-right text-accent">
                    ↑ {formatBytes(stat.requestBytes)}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-right text-success">
                    ↓ {formatBytes(stat.responseBytes)}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-right font-medium">
                    {formatBytes(stat.requestBytes + stat.responseBytes)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
