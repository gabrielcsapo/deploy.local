/** Placeholders describe layout only; mount only while the requested data has never loaded. */
export function Skeleton({
  variant = 'rows',
  label = 'Loading',
  rows = 5,
}: {
  variant?: 'rows' | 'sidebar' | 'conversation' | 'detail';
  label?: string;
  rows?: number;
}) {
  return (
    <div
      className={`ui-skeleton ui-skeleton-${variant}`}
      role="status"
      aria-label={label}
      aria-busy="true"
    >
      <span className="sr-only">{label}</span>
      {Array.from({ length: variant === 'conversation' ? 3 : rows }, (_, index) => (
        <div className="ui-skeleton-block" aria-hidden="true" key={index} />
      ))}
    </div>
  );
}
