'use client';

import { useRef } from 'react';
import { useDialogFocus } from '../../../components/useDialogFocus';
import { Button } from '../../../components/ui';
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

  useDialogFocus(true, dialogRef, onClose);

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        className="ds-analytics-dialog bg-bg card max-w-4xl w-full max-h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="data-transfer-title"
      >
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <div>
            <h2 id="data-transfer-title" className="text-lg font-semibold">
              Data transfer by path
            </h2>
            <p className="text-xs text-text-secondary mt-1">
              Total: ↓ {formatBytes(dataTransfer.totalResponseBytes)} received, ↑{' '}
              {formatBytes(dataTransfer.totalRequestBytes)} sent
            </p>
          </div>
          <Button variant="quiet" onClick={onClose} aria-label="Close">
            ✕
          </Button>
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
