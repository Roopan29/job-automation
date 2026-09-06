/**
 * components/JobCard.js
 * ------------------------------------------------------------------
 * One job listing in the search grid.
 *
 *   • company + source badge, title, location/type pill, salary,
 *     "posted X days ago"
 *   • colour-coded match badge
 *   • matched skills (green) / missing skills (red)
 *   • [Apply Now] [💌 Cover Letter] [📌 Bookmark] [🔗 View Job]
 *   • already-applied jobs show an "✅ Applied" badge instead
 */

'use client';

import { useState } from 'react';
import { Bookmark, ExternalLink, Send, Mail, CheckCircle2, MapPin, Banknote, Briefcase } from 'lucide-react';
import toast from 'react-hot-toast';
import { toggleBookmark } from '@/services/api';
import MatchScoreBadge from './MatchScoreBadge';
import SkillTag from './SkillTag';
import { Spinner } from './Loader';

/** "2026-09-04" -> "2 days ago" */
export function timeAgoLabel(dateString) {
  if (!dateString) return '';
  const date = new Date(String(dateString).slice(0, 10));
  if (Number.isNaN(date.getTime())) return '';
  const days = Math.round((Date.now() - date.getTime()) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30);
  return `${months} month${months > 1 ? 's' : ''} ago`;
}

/** Source pill colours so LinkedIn / Indeed / … are distinguishable. */
const SOURCE_STYLES = {
  linkedin: 'bg-blue-50 text-blue-700 ring-blue-200',
  indeed: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  glassdoor: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  remoteok: 'bg-orange-50 text-orange-700 ring-orange-200',
  remotive: 'bg-teal-50 text-teal-700 ring-teal-200',
};

export default function JobCard({ job, onApply, onCoverLetter, onBookmarked, compact = false }) {
  const [bookmarked, setBookmarked] = useState(Boolean(job.isBookmarked));
  const [busy, setBusy] = useState(false);

  const sourceStyle = SOURCE_STYLES[String(job.source || '').toLowerCase()] || 'bg-slate-100 text-slate-600 ring-slate-200';
  const posted = timeAgoLabel(job.postedDate);

  const bookmark = async () => {
    setBusy(true);
    try {
      const data = await toggleBookmark(job.id);
      setBookmarked(data.bookmarked);
      toast.success(data.bookmarked ? `Bookmarked "${job.title}"` : 'Bookmark removed');
      onBookmarked?.(data.bookmarked);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="card flex animate-fade-in flex-col transition-shadow hover:shadow-card-hover">
      <div className="flex flex-1 flex-col p-4">
        {/* ---- header ------------------------------------------------- */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <p className="truncate text-xs font-semibold uppercase tracking-wide text-slate-500">{job.company}</p>
              {job.source && (
                <span className={`pill ring-1 ring-inset ${sourceStyle}`}>{job.source}</span>
              )}
            </div>
            <h3 className="mt-1 text-sm font-semibold leading-snug text-slate-900" title={job.title}>
              {job.title}
            </h3>
          </div>
          <MatchScoreBadge score={job.matchScore} size="md" />
        </div>

        {/* ---- meta --------------------------------------------------- */}
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
          {job.location && (
            <span className="inline-flex items-center gap-1">
              <MapPin size={12} /> {job.location}
            </span>
          )}
          {job.jobType && (
            <span className="pill bg-slate-100 text-slate-600 capitalize ring-1 ring-inset ring-slate-200">{job.jobType}</span>
          )}
          {job.salary && (
            <span className="inline-flex items-center gap-1 font-medium text-green-700">
              <Banknote size={12} /> {job.salary}
            </span>
          )}
          {job.experienceLevel && (
            <span className="inline-flex items-center gap-1 capitalize">
              <Briefcase size={12} /> {job.experienceLevel}
            </span>
          )}
          {posted && <span className="text-slate-400">{posted}</span>}
        </div>

        {/* ---- skills -------------------------------------------------- */}
        {!compact && (
          <div className="mt-3 space-y-2">
            {job.matchedSkills?.length > 0 && (
              <div>
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-green-700">
                  You have ({job.matchedSkills.length})
                </p>
                <div className="flex flex-wrap gap-1">
                  {job.matchedSkills.slice(0, 5).map((s) => (
                    <SkillTag key={s} skill={s} variant="matched" />
                  ))}
                  {job.matchedSkills.length > 5 && (
                    <span
                      className="inline-flex items-center rounded-md bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-500 ring-1 ring-inset ring-slate-200"
                      title={job.matchedSkills.slice(5).join(', ')}
                    >
                      +{job.matchedSkills.length - 5}
                    </span>
                  )}
                </div>
              </div>
            )}

            {job.missingSkills?.length > 0 && (
              <div>
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-red-700">Gaps</p>
                <div className="flex flex-wrap gap-1">
                  {job.missingSkills.slice(0, 3).map((s) => (
                    <SkillTag key={s} skill={s} variant="missing" />
                  ))}
                  {job.missingSkills.length > 3 && (
                    <span
                      className="inline-flex items-center rounded-md bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-500 ring-1 ring-inset ring-slate-200"
                      title={job.missingSkills.slice(3).join(', ')}
                    >
                      +{job.missingSkills.length - 3}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ---- actions --------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-4 py-3">
        {job.isApplied ? (
          <span className="pill bg-green-50 text-green-700 ring-1 ring-inset ring-green-200">
            <CheckCircle2 size={12} /> Applied
          </span>
        ) : (
          <button type="button" className="btn-primary btn-sm" onClick={() => onApply?.(job)}>
            <Send size={13} /> Apply Now
          </button>
        )}

        <button type="button" className="btn-secondary btn-sm" onClick={() => onCoverLetter?.(job)}>
          <Mail size={13} /> Cover Letter
        </button>

        <button
          type="button"
          onClick={bookmark}
          disabled={busy}
          className={`btn-sm ${bookmarked ? 'btn-primary' : 'btn-secondary'}`}
          aria-pressed={bookmarked}
          title={bookmarked ? 'Remove bookmark' : 'Bookmark this job'}
        >
          {busy ? <Spinner size={13} /> : <Bookmark size={13} fill={bookmarked ? 'currentColor' : 'none'} />}
          {bookmarked ? 'Saved' : 'Bookmark'}
        </button>

        {job.sourceUrl && (
          <a
            href={job.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-ghost btn-sm ml-auto"
            title="Open the original posting"
          >
            <ExternalLink size={13} /> View Job
          </a>
        )}
      </div>
    </article>
  );
}
