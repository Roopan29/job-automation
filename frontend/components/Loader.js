/**
 * components/Loader.js
 * ------------------------------------------------------------------
 * Loading states. Three flavours:
 *
 *   <Loader />            inline spinner
 *   <Loader full />       centred block for a whole panel
 *   <SkeletonTable />     grey placeholder rows while a table loads
 */

export function Spinner({ size = 16, className = '' }) {
  return (
    <svg
      className={`animate-spin ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}

export default function Loader({ label = 'Loading…', full = false, className = '' }) {
  const content = (
    <div className="flex items-center gap-2 text-sm text-slate-500">
      <Spinner size={16} />
      <span>{label}</span>
    </div>
  );

  if (full) {
    return <div className={`flex min-h-[220px] items-center justify-center ${className}`}>{content}</div>;
  }
  return <div className={className}>{content}</div>;
}

/** Grey placeholder rows – used by tables and card grids. */
export function Skeleton({ rows = 4, className = '' }) {
  return (
    <div className={`animate-pulse space-y-3 ${className}`} aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-4 rounded bg-slate-200" style={{ width: `${90 - i * 7}%` }} />
      ))}
    </div>
  );
}

/** Table-shaped skeleton. */
export function SkeletonTable({ rows = 5, cols = 5 }) {
  return (
    <div className="animate-pulse p-4" aria-hidden="true">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="mb-3 flex gap-4">
          {Array.from({ length: cols }).map((__, c) => (
            <div key={c} className="h-3 flex-1 rounded bg-slate-200" />
          ))}
        </div>
      ))}
    </div>
  );
}
