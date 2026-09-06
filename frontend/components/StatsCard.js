/**
 * components/StatsCard.js
 * ------------------------------------------------------------------
 * Dashboard stat tile: big number, label, icon and a coloured accent.
 *
 *   <StatsCard label="Total Applied" value={42} tone="blue" icon={<Send/>} />
 */

const TONES = {
  blue: { bg: 'bg-blue-50', text: 'text-blue-600', bar: 'bg-blue-500' },
  yellow: { bg: 'bg-yellow-50', text: 'text-yellow-600', bar: 'bg-yellow-500' },
  green: { bg: 'bg-green-50', text: 'text-green-600', bar: 'bg-green-500' },
  purple: { bg: 'bg-purple-50', text: 'text-purple-600', bar: 'bg-purple-500' },
  red: { bg: 'bg-red-50', text: 'text-red-600', bar: 'bg-red-500' },
  slate: { bg: 'bg-slate-100', text: 'text-slate-600', bar: 'bg-slate-400' },
};

export default function StatsCard({ label, value, sublabel, tone = 'blue', icon, onClick, className = '' }) {
  const t = TONES[tone] || TONES.blue;
  const Tag = onClick ? 'button' : 'div';

  return (
    <Tag
      onClick={onClick}
      className={`card relative overflow-hidden text-left transition-shadow ${
        onClick ? 'cursor-pointer hover:shadow-card-hover' : ''
      } ${className}`}
    >
      {/* coloured accent strip */}
      <span className={`absolute inset-y-0 left-0 w-1 ${t.bar}`} aria-hidden="true" />

      <div className="flex items-start justify-between gap-3 p-4 pl-5">
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
          <p className="mt-1.5 text-2xl font-bold text-slate-900">{value}</p>
          {sublabel && <p className="mt-0.5 truncate text-xs text-slate-400">{sublabel}</p>}
        </div>
        {icon && (
          <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${t.bg} ${t.text}`}>
            {icon}
          </span>
        )}
      </div>
    </Tag>
  );
}
