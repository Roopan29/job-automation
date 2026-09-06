/**
 * components/SkillTag.js
 * ------------------------------------------------------------------
 * Small chip used for matched / missing / parsed skills.
 *
 *   variant="matched"  green  – you have it
 *   variant="missing"  red    – the job wants it, you do not have it
 *   variant="neutral"  grey   – plain skill list (resume cards)
 */

const VARIANTS = {
  matched: 'bg-green-50 text-green-700 ring-green-200',
  missing: 'bg-red-50 text-red-700 ring-red-200',
  neutral: 'bg-slate-100 text-slate-600 ring-slate-200',
  brand: 'bg-brand-50 text-brand-700 ring-brand-100',
};

export default function SkillTag({ skill, variant = 'neutral', title, className = '' }) {
  const label = typeof skill === 'string' ? skill : skill?.name || '';
  if (!label) return null;

  return (
    <span
      className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${
        VARIANTS[variant] || VARIANTS.neutral
      } ${className}`}
      title={title || label}
    >
      {label}
    </span>
  );
}

/**
 * Render a list of skills with a "+N more" overflow indicator.
 * @param {{skills:Array, max?:number, variant?:string}} props
 */
export function SkillList({ skills = [], max = 8, variant = 'neutral', emptyText = 'No skills detected' }) {
  if (!skills.length) return <span className="text-xs text-slate-400">{emptyText}</span>;

  const shown = skills.slice(0, max);
  const rest = skills.length - shown.length;

  return (
    <div className="flex flex-wrap gap-1">
      {shown.map((skill, i) => (
        <SkillTag key={`${typeof skill === 'string' ? skill : skill.name}-${i}`} skill={skill} variant={variant} />
      ))}
      {rest > 0 && (
        <span
          className="inline-flex items-center rounded-md bg-slate-50 px-1.5 py-0.5 text-[11px] font-medium text-slate-500 ring-1 ring-inset ring-slate-200"
          title={skills
            .slice(max)
            .map((s) => (typeof s === 'string' ? s : s.name))
            .join(', ')}
        >
          +{rest} more
        </span>
      )}
    </div>
  );
}
