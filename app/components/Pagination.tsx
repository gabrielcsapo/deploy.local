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
    <div className="border-t border-border px-4 py-3 flex items-center justify-between">
      <p className="text-xs text-text-tertiary">
        Page {page} of {totalPages}
      </p>
      <div className="flex gap-2">
        <button
          onClick={() => onPageChange(Math.max(1, page - 1))}
          disabled={page <= 1}
          className="btn btn-sm"
        >
          Previous
        </button>
        <button
          onClick={() => onPageChange(Math.min(totalPages, page + 1))}
          disabled={page >= totalPages}
          className="btn btn-sm"
        >
          Next
        </button>
      </div>
    </div>
  );
}
