/**
 * components/StatusBadge.js
 * ------------------------------------------------------------------
 * Application status pill. Also exports the shared status metadata so
 * the tracker, dashboard and dropdowns all agree on labels + colours.
 */

/**
 * The seven statuses, in the order they should be listed.
 * `dot` is the coloured circle, `classes` the pill styling.
 */
export const STATUS_META = {
  applied: { label: 'Applied', dot: 'bg-blue-500', classes: 'bg-blue-50 text-blue-700 ring-blue-200' },
  responded: { label: 'Responded', dot: 'bg-purple-500', classes: 'bg-purple-50 text-purple-700 ring-purple-200' },
  interview: { label: 'Interview', dot: 'bg-yellow-500', classes: 'bg-yellow-50 text-yellow-800 ring-yellow-200' },
  offer: { label: 'Offer', dot: 'bg-green-500', classes: 'bg-green-50 text-green-700 ring-green-200' },
  rejected: { label: 'Rejected', dot: 'bg-red-500', classes: 'bg-red-50 text-red-700 ring-red-200' },
  ghosted: { label: 'Ghosted', dot: 'bg-slate-400', classes: 'bg-slate-100 text-slate-600 ring-slate-200' },
  withdrawn: { label: 'Withdrawn', dot: 'bg-orange-500', classes: 'bg-orange-50 text-orange-700 ring-orange-200' },
};

export const STATUS_KEYS = Object.keys(STATUS_META);

export default function StatusBadge({ status, size = 'md', className = '' }) {
  const meta = STATUS_META[String(status || '').toLowerCase()] || {
    label: status || 'Unknown',
    dot: 'bg-slate-400',
    classes: 'bg-slate-100 text-slate-600 ring-slate-200',
  };

  const sizes = {
    sm: 'px-1.5 py-0.5 text-[11px]',
    md: 'px-2 py-0.5 text-xs',
  };

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full font-medium ring-1 ring-inset ${meta.classes} ${sizes[size]} ${className}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} aria-hidden="true" />
      {meta.label}
    </span>
  );
}
