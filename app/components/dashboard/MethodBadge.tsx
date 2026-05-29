// HTTP method semantics:
// - Reads (GET/HEAD): neutral/success
// - Mutations (POST/PUT/PATCH): warning — destructive intent
// - Destructive (DELETE): danger
// - OPTIONS (preflight): tertiary
const methodColor: Record<string, string> = {
  GET: 'text-success bg-success/10 ring-1 ring-success/20',
  HEAD: 'text-success bg-success/10 ring-1 ring-success/20',
  POST: 'text-warning bg-warning/12 ring-1 ring-warning/25',
  PUT: 'text-warning bg-warning/12 ring-1 ring-warning/25',
  PATCH: 'text-warning bg-warning/12 ring-1 ring-warning/25',
  DELETE: 'text-danger bg-danger/12 ring-1 ring-danger/30',
  OPTIONS: 'text-text-tertiary bg-bg-hover ring-1 ring-border',
};

export function MethodBadge({ method }: { method: string }) {
  const cls =
    methodColor[method.toUpperCase()] || 'text-text-tertiary bg-bg-hover ring-1 ring-border';
  return (
    <span
      className={`inline-flex items-center justify-center font-mono text-[10px] font-semibold px-1.5 py-0.5 rounded ${cls} min-w-[44px] tracking-wider`}
    >
      {method.toUpperCase()}
    </span>
  );
}
