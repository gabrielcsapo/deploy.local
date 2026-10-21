import { IconButton, ActionCluster } from './ui';
// Shared component — only used inside client components. Dropping the
// 'use client' directive avoids emitting a separate client chunk for it.
interface PaginationProps {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}

export function Pagination({ page, totalPages, onPageChange }: PaginationProps) {
  if (totalPages <= 1) return null;

  return (
    <div className="ds-pagination border-t border-border px-4 py-2 flex items-center justify-between gap-2 flex-wrap">
      <p className="text-xs text-text-tertiary">
        Page {page} of {totalPages}
      </p>
      <ActionCluster>
        <IconButton
          icon="chevron-left"
          label="Previous page"
          onClick={() => onPageChange(Math.max(1, page - 1))}
          disabled={page <= 1}
        />
        <IconButton
          icon="chevron"
          label="Next page"
          onClick={() => onPageChange(Math.min(totalPages, page + 1))}
          disabled={page >= totalPages}
        />
      </ActionCluster>
    </div>
  );
}
