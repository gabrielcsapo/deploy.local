import type { ReactNode } from 'react';

export function EmptyState({
  icon,
  title,
  description,
  action,
  className = '',
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center text-center py-10 px-4 sm:py-14 ${className}`}
    >
      {icon && (
        <div className="mb-3 sm:mb-4 text-text-tertiary opacity-50 flex items-center justify-center">
          <span className="[&>svg]:w-10 [&>svg]:h-10 sm:[&>svg]:w-12 sm:[&>svg]:h-12">{icon}</span>
        </div>
      )}
      <p className="text-sm font-medium text-text">{title}</p>
      {description && (
        <p className="text-xs text-text-secondary mt-2 max-w-md leading-relaxed">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
