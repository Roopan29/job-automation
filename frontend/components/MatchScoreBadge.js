/**
 * components/MatchScoreBadge.js
 * ------------------------------------------------------------------
 * Colour-coded match percentage pill.
 *
 *   90–100  green   🟢
 *   70–89   yellow  🟡
 *   50–69   orange  🟠
 *   <50     red     🔴
 */

/** Map a score to its colour class + dot. */
export function scoreTier(score) {
  const n = Number(score) || 0;
  if (n >= 90) return { label: 'green', dot: '🟢', classes: 'bg-green-50 text-green-700 ring-green-200' };
  if (n >= 70) return { label: 'yellow', dot: '🟡', classes: 'bg-yellow-50 text-yellow-700 ring-yellow-200' };
  if (n >= 50) return { label: 'orange', dot: '🟠', classes: 'bg-orange-50 text-orange-700 ring-orange-200' };
  return { label: 'red', dot: '🔴', classes: 'bg-red-50 text-red-700 ring-red-200' };
}

export default function MatchScoreBadge({ score, size = 'md', showDot = true, className = '' }) {
  const tier = scoreTier(score);
  const value = Math.round(Number(score) || 0);

  const sizes = {
    sm: 'px-1.5 py-0.5 text-[11px]',
    md: 'px-2 py-0.5 text-xs',
    lg: 'px-2.5 py-1 text-sm',
  };

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full font-semibold ring-1 ring-inset ${tier.classes} ${sizes[size]} ${className}`}
      title={`${value}% match with your default resume`}
    >
      {showDot && <span aria-hidden="true">{tier.dot}</span>}
      {value}% Match
    </span>
  );
}
