/**
 * app/search/page.js — Job Search
 * ------------------------------------------------------------------
 * TOP      search bar + filters (type, level, min score, bookmarked)
 *          [🔍 Search Jobs] [🤖 Find by Resume] [⚡ Scrape New Jobs]
 * RESULTS  count + sort selector + responsive job grid
 * MODALS   Apply (resume picker, cover letter, tone, manual vs bot)
 *          Cover Letter (view/edit/regenerate)
 * FOOTER   pagination
 */

'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Search, Sparkles, Zap, X, Send, Bot, ChevronLeft, ChevronRight, Filter } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  searchJobs,
  getRecommendedJobs,
  scrapeJobs,
  getScrapeLogs,
  applyToJob,
  autoApplyToJob,
  generateCoverLetter,
} from '@/services/api';
import { useApp } from '@/context/AppContext';
import JobCard from '@/components/JobCard';
import CoverLetterModal from '@/components/CoverLetterModal';
import Loader, { Skeleton, Spinner } from '@/components/Loader';

const JOB_TYPES = ['any', 'remote', 'hybrid', 'onsite'];
const LEVELS = ['any', 'entry', 'mid', 'senior'];
const SCORE_OPTIONS = [
  { value: '', label: 'Any match' },
  { value: '50', label: '50%+' },
  { value: '70', label: '70%+' },
  { value: '90', label: '90%+' },
];
const SORTS = [
  { value: 'match', label: 'Match score' },
  { value: 'date', label: 'Date posted' },
  { value: 'company', label: 'Company' },
  { value: 'title', label: 'Job title' },
];
const SCRAPE_SOURCES = [
  { id: 'remoteok', label: 'RemoteOK', hint: 'public JSON API' },
  { id: 'remotive', label: 'Remotive', hint: 'public JSON API' },
  { id: 'linkedin', label: 'LinkedIn', hint: 'public guest search' },
  { id: 'indeed', label: 'Indeed', hint: 'needs a browser' },
  { id: 'glassdoor', label: 'Glassdoor', hint: 'needs a browser' },
];

const PAGE_SIZE = 12;

/**
 * `useSearchParams()` bails out of static prerendering, so the real page
 * body lives in <JobSearchInner> and is wrapped in a Suspense boundary.
 * Without the boundary `next build` fails to prerender /search.
 */
export default function JobSearchPage() {
  return (
    <Suspense fallback={<Loader full label="Loading job search…" />}>
      <JobSearchInner />
    </Suspense>
  );
}

function JobSearchInner() {
  const searchParams = useSearchParams();
  const { resumes, defaultResume, preferences, refresh } = useApp();

  // ---- filters --------------------------------------------------------
  const [q, setQ] = useState('');
  const [location, setLocation] = useState('');
  const [jobType, setJobType] = useState('any');
  const [level, setLevel] = useState('any');
  const [minScore, setMinScore] = useState('');
  const [bookmarkedOnly, setBookmarkedOnly] = useState(searchParams.get('bookmarked') === 'true');
  const [sort, setSort] = useState('match');

  // ---- results ---------------------------------------------------------
  const [jobs, setJobs] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState('search'); // 'search' | 'recommended'

  // ---- scrape ------------------------------------------------------------
  const [scraping, setScraping] = useState(false);
  const [scrapeSources, setScrapeSources] = useState(['remoteok', 'remotive', 'linkedin']);
  const [scrapeOpen, setScrapeOpen] = useState(false);

  // ---- scrape history ------------------------------------------------------
  const [scrapeLogs, setScrapeLogs] = useState([]);
  const [logsOpen, setLogsOpen] = useState(false);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState('');

  // ---- modals --------------------------------------------------------------
  const [applyJob, setApplyJob] = useState(null);
  const [letterJob, setLetterJob] = useState(null);

  /** Fetch the current page with the active filters. */
  const load = useCallback(
    async (targetPage = 1) => {
      setLoading(true);
      try {
        if (mode === 'recommended') {
          const data = await getRecommendedJobs({
            minScore: minScore || preferences?.minMatchScore || 70,
            limit: 50,
          });
          setJobs(data.jobs || []);
          setTotal(data.jobs?.length || 0);
          setTotalPages(1);
          setPage(1);
        } else {
          const data = await searchJobs({
            q: q || undefined,
            location: location || undefined,
            jobType: jobType !== 'any' ? jobType : undefined,
            experienceLevel: level !== 'any' ? level : undefined,
            minScore: minScore || undefined,
            bookmarked: bookmarkedOnly ? true : undefined,
            sort,
            page: targetPage,
            limit: PAGE_SIZE,
          });
          setJobs(data.jobs || []);
          setTotal(data.total || 0);
          setTotalPages(data.totalPages || 1);
          setPage(data.page || 1);
        }
      } catch (err) {
        toast.error(err.message);
      } finally {
        setLoading(false);
      }
    },
    [mode, q, location, jobType, level, minScore, bookmarkedOnly, sort, preferences?.minMatchScore]
  );

  // First load + reload whenever a filter changes.
  useEffect(() => {
    load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobType, level, minScore, bookmarkedOnly, sort, mode]);

  const runSearch = (e) => {
    e?.preventDefault?.();
    setMode('search');
    load(1);
  };

  const findRecommended = () => {
    setMode('recommended');
    toast.success('Showing jobs that match your resume');
  };

  /* ---- scraping --------------------------------------------------------- */
  const toggleSource = (id) =>
    setScrapeSources((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]));

  /**
   * Load the scrape history. Every scrape writes a row per run, so this is how
   * a user finds out which board blocked them and when the last run happened.
   */
  const loadScrapeLogs = useCallback(async () => {
    setLogsLoading(true);
    setLogsError('');
    try {
      const data = await getScrapeLogs(20);
      setScrapeLogs(data.logs || []);
    } catch (err) {
      setLogsError(err.message);
    } finally {
      setLogsLoading(false);
    }
  }, []);

  const runScrape = async () => {
    if (!scrapeSources.length) {
      toast.error('Pick at least one source to scrape');
      return;
    }
    setScraping(true);
    try {
      const data = await scrapeJobs({
        query: q || preferences?.targetRoles?.[0] || 'Software Engineer',
        location: location || preferences?.targetLocations?.[0] || 'Remote',
        sources: scrapeSources,
        limit: 25,
      });
      toast.success(`Scraped ${data.jobsFound} jobs — ${data.jobsAdded} new`);
      setScrapeOpen(false);
      setMode('search');
      await Promise.all([load(1), loadScrapeLogs()]);
    } catch (err) {
      // The backend returns per-source detail; surface the reasons.
      const detail = err.details?.sources
        ?.map((s) => `${s.source}: ${s.error || s.status}`)
        .join('\n');
      toast.error(detail ? `${err.message}\n${detail}` : err.message, { duration: 9000 });
      // A failed scrape still writes log rows — refresh so the reasons show.
      await loadScrapeLogs();
    } finally {
      setScraping(false);
    }
  };

  const summary = useMemo(() => {
    const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
    const to = Math.min(page * PAGE_SIZE, total);
    return `Showing ${from}–${to} of ${total} job${total === 1 ? '' : 's'}`;
  }, [page, total]);

  return (
    <div className="space-y-5">
      {/* ---- header ---------------------------------------------------- */}
      <div>
        <h1 className="page-title">Job Search</h1>
        <p className="page-subtitle">
          Search what is already scraped, pull the best matches for your resume, or fetch fresh listings
          from the job boards.
        </p>
      </div>

      {/* ---- search bar ------------------------------------------------- */}
      <form onSubmit={runSearch} className="card">
        <div className="card-body space-y-4">
          <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
            <div>
              <label className="label" htmlFor="q">
                Job title, keywords or company
              </label>
              <input
                id="q"
                className="input"
                placeholder="e.g. React Developer"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="loc">
                Location
              </label>
              <input
                id="loc"
                className="input"
                placeholder="City, state or Remote"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
              />
            </div>
            <div className="flex items-end">
              <button type="submit" className="btn-primary w-full md:w-auto">
                <Search size={15} /> Search Jobs
              </button>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div>
              <label className="label" htmlFor="type">
                Job type
              </label>
              <select id="type" className="select capitalize" value={jobType} onChange={(e) => setJobType(e.target.value)}>
                {JOB_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t === 'any' ? 'Any type' : t}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="label" htmlFor="level">
                Experience
              </label>
              <select id="level" className="select capitalize" value={level} onChange={(e) => setLevel(e.target.value)}>
                {LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {l === 'any' ? 'Any level' : l}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="label" htmlFor="score">
                Min match score
              </label>
              <select id="score" className="select" value={minScore} onChange={(e) => setMinScore(e.target.value)}>
                {SCORE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="label" htmlFor="sort">
                Sort by
              </label>
              <select id="sort" className="select" value={sort} onChange={(e) => setSort(e.target.value)}>
                {SORTS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-end">
              <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                  checked={bookmarkedOnly}
                  onChange={(e) => setBookmarkedOnly(e.target.checked)}
                />
                Bookmarked only
              </label>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-4">
            <button type="button" className="btn-secondary" onClick={findRecommended}>
              <Sparkles size={15} /> Find by Resume
            </button>
            <button type="button" className="btn-primary" onClick={() => setScrapeOpen((v) => !v)}>
              <Zap size={15} /> Scrape New Jobs
            </button>
            {mode === 'recommended' && (
              <button type="button" className="btn-ghost" onClick={() => setMode('search')}>
                <X size={14} /> Exit recommended view
              </button>
            )}
            {!defaultResume && (
              <span className="self-center text-xs text-yellow-700">
                Upload a resume to unlock match scoring and “Find by Resume”.
              </span>
            )}
          </div>

          {/* ---- scrape panel -------------------------------------------- */}
          {scrapeOpen && (
            <div className="animate-fade-in rounded-lg border border-brand-100 bg-brand-50/60 p-4">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-slate-800">Scrape settings</p>
                <button type="button" onClick={() => setScrapeOpen(false)} className="text-slate-400 hover:text-slate-600" aria-label="Close scrape settings">
                  <X size={15} />
                </button>
              </div>

              <p className="mt-1 text-xs text-slate-500">
                Searching for <span className="font-medium">{q || preferences?.targetRoles?.[0] || 'Software Engineer'}</span>{' '}
                in <span className="font-medium">{location || preferences?.targetLocations?.[0] || 'Remote'}</span>. Fill the
                boxes above to change it.
              </p>

              <div className="mt-3 flex flex-wrap gap-2">
                {SCRAPE_SOURCES.map((src) => (
                  <label
                    key={src.id}
                    className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                      scrapeSources.includes(src.id)
                        ? 'border-brand-300 bg-white text-slate-800'
                        : 'border-slate-200 bg-white/60 text-slate-500'
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                      checked={scrapeSources.includes(src.id)}
                      onChange={() => toggleSource(src.id)}
                    />
                    <span className="font-medium">{src.label}</span>
                    <span className="text-[10px] text-slate-400">{src.hint}</span>
                  </label>
                ))}
              </div>

              <div className="mt-4 flex items-center gap-3">
                <button type="button" className="btn-primary btn-sm" onClick={runScrape} disabled={scraping}>
                  {scraping ? <Spinner size={13} /> : <Zap size={13} />}
                  {scraping ? 'Scraping…' : 'Start scrape'}
                </button>
                <span className="text-[11px] text-slate-500">
                  Runs 2–5 s apart per source. Some boards block automated traffic — failures are reported per source.
                </span>
              </div>
            </div>
          )}
        </div>
      </form>

      {/* ---- scrape history ------------------------------------------------ */}
      <div className="card mt-4">
        <button
          type="button"
          className="flex w-full items-center justify-between text-left"
          onClick={() => {
            const next = !logsOpen;
            setLogsOpen(next);
            // Load lazily on first open so the page stays fast.
            if (next && !scrapeLogs.length) loadScrapeLogs();
          }}
        >
          <span className="flex items-center gap-2 text-sm font-semibold text-slate-700">
            <Zap size={15} className="text-brand-600" />
            Scrape history
          </span>
          <span className="text-xs text-slate-400">
            {logsOpen ? 'Hide' : scrapeLogs.length ? `${scrapeLogs.length} run(s)` : 'Show'}
          </span>
        </button>

        {logsOpen && (
          <div className="mt-3" data-testid="scrape-history">
            {logsLoading && (
              <div className="flex items-center gap-2 py-4 text-xs text-slate-500">
                <Spinner size={13} /> Loading scrape history…
              </div>
            )}

            {!logsLoading && logsError && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                Could not load scrape history: {logsError}
                <button type="button" className="btn-ghost btn-sm ml-2" onClick={loadScrapeLogs}>
                  Retry
                </button>
              </div>
            )}

            {!logsLoading && !logsError && scrapeLogs.length === 0 && (
              <p className="py-3 text-xs text-slate-500">
                No scrapes yet. Run one above and each attempt will be recorded here, per source.
              </p>
            )}

            {!logsLoading && !logsError && scrapeLogs.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 text-[11px] uppercase tracking-wide text-slate-400">
                      <th className="py-2 pr-3 font-medium">When</th>
                      <th className="py-2 pr-3 font-medium">Source</th>
                      <th className="py-2 pr-3 font-medium">Found</th>
                      <th className="py-2 pr-3 font-medium">New</th>
                      <th className="py-2 pr-3 font-medium">Result</th>
                      <th className="py-2 font-medium">Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scrapeLogs.map((log) => (
                      <tr key={log.id} className="border-b border-slate-100 last:border-0">
                        <td className="whitespace-nowrap py-2 pr-3 text-slate-500">{log.scrapedAt}</td>
                        <td className="py-2 pr-3 font-medium text-slate-700">{log.source}</td>
                        <td className="py-2 pr-3 text-slate-600">{log.jobsFound}</td>
                        <td className="py-2 pr-3 text-slate-600">{log.jobsAdded}</td>
                        <td className="py-2 pr-3">
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                              log.status === 'success'
                                ? 'bg-emerald-50 text-emerald-700'
                                : 'bg-red-50 text-red-700'
                            }`}
                          >
                            {log.status}
                          </span>
                        </td>
                        <td className="max-w-[22rem] py-2 text-slate-500">
                          {log.errorMessage || '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <button
                  type="button"
                  className="btn-ghost btn-sm mt-2"
                  onClick={loadScrapeLogs}
                  disabled={logsLoading}
                >
                  Refresh
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ---- results ----------------------------------------------------- */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-500">
          {loading ? 'Loading…' : summary}
          {mode === 'recommended' && !loading && (
            <span className="ml-2 rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700">
              recommended for you
            </span>
          )}
        </p>
        {!loading && jobs.length > 0 && (
          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={() => {
              setQ('');
              setLocation('');
              setJobType('any');
              setLevel('any');
              setMinScore('');
              setBookmarkedOnly(false);
            }}
          >
            <Filter size={13} /> Clear filters
          </button>
        )}
      </div>

      {loading ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="card p-4">
              <Skeleton rows={5} />
            </div>
          ))}
        </div>
      ) : jobs.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <Search size={26} className="text-slate-300" />
            <p className="font-medium text-slate-600">No jobs match these filters</p>
            <p className="max-w-sm">
              Try a broader search, lower the minimum match score, or scrape fresh listings from the job
              boards.
            </p>
            <button type="button" className="btn-primary btn-sm mt-2" onClick={() => setScrapeOpen(true)}>
              <Zap size={13} /> Scrape new jobs
            </button>
          </div>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {jobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              onApply={setApplyJob}
              onCoverLetter={setLetterJob}
              onBookmarked={() => load(page)}
            />
          ))}
        </div>
      )}

      {/* ---- pagination ---------------------------------------------------- */}
      {mode === 'search' && totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-2">
          <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={() => load(page - 1)}
            disabled={page <= 1 || loading}
          >
            <ChevronLeft size={14} /> Previous
          </button>
          <span className="text-sm text-slate-500">
            Page {page} of {totalPages}
          </span>
          <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={() => load(page + 1)}
            disabled={page >= totalPages || loading}
          >
            Next <ChevronRight size={14} />
          </button>
        </div>
      )}

      {/* ---- modals ---------------------------------------------------------- */}
      <ApplyModal
        job={applyJob}
        resumes={resumes}
        onClose={() => setApplyJob(null)}
        onApplied={async () => {
          setApplyJob(null);
          await load(page);
          await refresh();
        }}
      />

      <CoverLetterModal
        open={Boolean(letterJob)}
        job={letterJob}
        resumes={resumes}
        initialTone={preferences?.coverLetterTone || 'professional'}
        onClose={() => setLetterJob(null)}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Apply modal
 * ------------------------------------------------------------------ */

/**
 * Apply dialog: pick a resume, review/generate the cover letter, choose
 * the tone, and either track it manually or drive the Puppeteer bot.
 */
function ApplyModal({ job, resumes, onClose, onApplied }) {
  const { preferences } = useApp();
  const defaultResume = resumes.find((r) => r.isDefault) || resumes[0];

  const [resumeId, setResumeId] = useState('');
  const [tone, setTone] = useState('professional');
  const [letter, setLetter] = useState('');
  const [letterSource, setLetterSource] = useState('');
  const [loadingLetter, setLoadingLetter] = useState(false);
  const [submitting, setSubmitting] = useState('');
  const [steps, setSteps] = useState([]);

  useEffect(() => {
    if (!job) return;
    setResumeId(defaultResume?.id || '');
    setTone(preferences?.coverLetterTone || 'professional');
    setLetter('');
    setSteps([]);
    setSubmitting('');
    setLetterSource('');
    // Auto-generate unless the user turned cover letters off.
    if (preferences?.generateCoverLetter !== false) {
      buildLetter(preferences?.coverLetterTone || 'professional', defaultResume?.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id]);

  if (!job) return null;

  async function buildLetter(nextTone = tone, nextResume = resumeId) {
    setLoadingLetter(true);
    try {
      const data = await generateCoverLetter(job.id, { tone: nextTone, resumeId: nextResume });
      setLetter(data.coverLetter || '');
      setLetterSource(data.source === 'ai' ? 'AI generated' : 'Template engine');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoadingLetter(false);
    }
  }

  const submit = async (method) => {
    setSubmitting(method);
    try {
      if (method === 'manual') {
        await applyToJob(job.id, { resumeId, coverLetter: letter });
        toast.success(`Application tracked for ${job.title} at ${job.company}`);
        onApplied?.();
      } else {
        const data = await autoApplyToJob(job.id, { resumeId, coverLetter: letter, tone });
        setSteps(data.steps || []);
        if (data.success) {
          toast.success(`Auto-applied to ${job.title} at ${job.company}`);
          onApplied?.();
        } else {
          toast.error(data.message || data.error || 'Auto-apply did not complete');
          if (data.captchaHit) {
            toast('⚠️ A CAPTCHA appeared — solve it in the browser window and try again.', { icon: '🤖' });
          }
        }
      }
    } catch (err) {
      toast.error(err.hint ? `${err.message}\n${err.hint}` : err.message, { duration: 8000 });
    } finally {
      setSubmitting('');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm"
      onMouseDown={() => !submitting && onClose?.()}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="flex max-h-[90vh] w-full max-w-3xl animate-slide-up flex-col overflow-hidden rounded-xl bg-white shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* ---- header ------------------------------------------------ */}
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold text-slate-900">Apply — {job.title}</h3>
            <p className="mt-0.5 truncate text-xs text-slate-500">
              {job.company}
              {job.location ? ` · ${job.location}` : ''}
              {job.source ? ` · via ${job.source}` : ''}
            </p>
          </div>
          <button type="button" onClick={() => !submitting && onClose?.()} className="text-slate-400 hover:text-slate-600" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {/* ---- body --------------------------------------------------- */}
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="apply-resume">
                Resume
              </label>
              <select
                id="apply-resume"
                className="select"
                value={resumeId}
                onChange={(e) => {
                  setResumeId(e.target.value);
                  if (letter) buildLetter(tone, e.target.value);
                }}
              >
                {resumes.length === 0 && <option value="">No resumes uploaded</option>}
                {resumes.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                    {r.isDefault ? ' (default)' : ''} · ATS {r.atsScore}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="label" htmlFor="apply-tone">
                Cover letter tone
              </label>
              <select
                id="apply-tone"
                className="select"
                value={tone}
                onChange={(e) => {
                  setTone(e.target.value);
                  buildLetter(e.target.value, resumeId);
                }}
              >
                <option value="professional">Professional</option>
                <option value="friendly">Friendly</option>
                <option value="confident">Confident</option>
              </select>
            </div>
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label className="label mb-0" htmlFor="apply-letter">
                Cover letter {letterSource && <span className="normal-case text-slate-400">· {letterSource}</span>}
              </label>
              <button
                type="button"
                className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline disabled:opacity-50"
                onClick={() => buildLetter()}
                disabled={loadingLetter}
              >
                <Sparkles size={12} /> {loadingLetter ? 'Writing…' : 'Regenerate'}
              </button>
            </div>

            {loadingLetter && !letter ? (
              <div className="rounded-lg border border-slate-200 p-6">
                <Loader label="Writing your cover letter…" />
              </div>
            ) : (
              <textarea
                id="apply-letter"
                value={letter}
                onChange={(e) => setLetter(e.target.value)}
                rows={11}
                className="w-full resize-y rounded-lg border border-slate-200 p-3 font-serif text-[13px] leading-relaxed text-slate-800 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                placeholder="Generate a letter above, or write your own here."
              />
            )}
          </div>

          {/* bot run log, shown after a failed/successful auto-apply */}
          {steps.length > 0 && (
            <div>
              <p className="label">Automation log</p>
              <div className="console max-h-40">
                {steps.map((s, i) => (
                  <div key={i} className={s.level === 'error' ? 'text-red-300' : s.level === 'success' ? 'text-green-300' : 'text-slate-300'}>
                    {new Date(s.at).toLocaleTimeString()} · {s.message}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ---- footer --------------------------------------------------- */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-5 py-3">
          <p className="text-[11px] text-slate-400">
            Manual tracking just records the application. Auto Apply drives a real browser to the job site.
          </p>
          <div className="flex gap-2">
            <button type="button" className="btn-secondary" onClick={onClose} disabled={Boolean(submitting)}>
              Cancel
            </button>
            <button type="button" className="btn-secondary" onClick={() => submit('manual')} disabled={Boolean(submitting)}>
              {submitting === 'manual' ? <Spinner size={14} /> : <Send size={14} />}
              Manual Track
            </button>
            <button type="button" className="btn-primary" onClick={() => submit('auto')} disabled={Boolean(submitting)}>
              {submitting === 'auto' ? <Spinner size={14} /> : <Bot size={14} />}
              Auto Apply
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
