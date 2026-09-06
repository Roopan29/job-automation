/**
 * app/page.js — Dashboard
 * ------------------------------------------------------------------
 * ROW 1  four stat cards: Total Applied · Interviews · Offers · Response Rate
 * ROW 2  Recent Applications table  |  Application Status donut
 * ROW 3  Top Matching Jobs          |  Skill Gaps
 * ROW 4  Upcoming Follow-ups        |  Last scrape info
 *
 * Refreshes on mount, on the 🔄 button, and automatically every 5 minutes.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  RefreshCw,
  Send,
  Video,
  Trophy,
  Percent,
  ArrowRight,
  Bookmark,
  CalendarClock,
  Database,
  FileText,
  Sparkles,
  ExternalLink,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { getDashboard, applyToJob } from '@/services/api';
import { useApp } from '@/context/AppContext';
import StatsCard from '@/components/StatsCard';
import StatusBadge from '@/components/StatusBadge';
import MatchScoreBadge from '@/components/MatchScoreBadge';
import Loader, { SkeletonTable, Skeleton } from '@/components/Loader';
import { StatusDonut } from '@/components/Charts';

/** Small section header used by the dashboard panels. */
function PanelHeader({ title, action }) {
  return (
    <div className="card-header">
      <h2 className="card-title">{title}</h2>
      {action}
    </div>
  );
}

export default function DashboardPage() {
  const { refresh } = useApp();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [applying, setApplying] = useState(null);

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      else setRefreshing(true);
      try {
        setData(await getDashboard());
      } catch (err) {
        toast.error(err.message);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    []
  );

  useEffect(() => {
    load();
    const id = setInterval(() => load(true), 5 * 60 * 1000); // every 5 minutes
    return () => clearInterval(id);
  }, [load]);

  const manualRefresh = async () => {
    await load(true);
    await refresh();
    toast.success('Dashboard refreshed');
  };

  /** Quick-apply straight from the dashboard (manual tracking). */
  const quickApply = async (job) => {
    setApplying(job.id);
    try {
      await applyToJob(job.id, {});
      toast.success(`Application tracked for ${job.title} at ${job.company}`);
      await load(true);
      await refresh();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setApplying(null);
    }
  };

  if (loading) {
    return (
      <div>
        <h1 className="page-title">Dashboard</h1>
        <p className="page-subtitle">Loading your job search overview…</p>
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="card p-4">
              <Skeleton rows={2} />
            </div>
          ))}
        </div>
        <div className="card mt-4">
          <SkeletonTable />
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div>
        <h1 className="page-title">Dashboard</h1>
        <div className="card mt-6">
          <div className="empty-state">
            <p>Could not load the dashboard.</p>
            <button type="button" className="btn-primary btn-sm mt-2" onClick={manualRefresh}>
              <RefreshCw size={13} /> Try again
            </button>
          </div>
        </div>
      </div>
    );
  }

  const s = data.stats;

  return (
    <div className="space-y-5">
      {/* ---- header ---------------------------------------------------- */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <p className="page-subtitle">
            {data.jobCount} jobs tracked · {data.resumeCount} resume{data.resumeCount === 1 ? '' : 's'} ·{' '}
            {data.readyQueue} ready in the auto-apply queue
          </p>
        </div>
        <button type="button" className="btn-secondary" onClick={manualRefresh} disabled={refreshing}>
          <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? 'Refreshing…' : 'Refresh Data'}
        </button>
      </div>

      {/* ---- ROW 1: stat cards ------------------------------------------ */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatsCard label="Total Applied" value={s.total} tone="blue" icon={<Send size={18} />} sublabel={`${s.thisWeek.applied} this week`} />
        <StatsCard
          label="Active Interviews"
          value={s.interview}
          tone="yellow"
          icon={<Video size={18} />}
          sublabel={`${data.upcomingFollowUps.length} follow-ups due`}
        />
        <StatsCard label="Offers Received" value={s.offer} tone="green" icon={<Trophy size={18} />} sublabel={`${s.responded} responded`} />
        <StatsCard
          label="Response Rate"
          value={`${s.responseRate}%`}
          tone="purple"
          icon={<Percent size={18} />}
          sublabel={`${s.rejected} rejected · ${s.ghosted} ghosted`}
        />
      </div>

      {/* ---- ROW 2 ------------------------------------------------------- */}
      <div className="grid gap-4 lg:grid-cols-3">
        {/* recent applications */}
        <div className="card lg:col-span-2">
          <PanelHeader
            title="Recent Applications"
            action={
              <Link href="/tracker" className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline">
                View All <ArrowRight size={13} />
              </Link>
            }
          />
          {data.recentApplications.length === 0 ? (
            <div className="empty-state">
              <Send size={22} className="text-slate-300" />
              <p>No applications yet.</p>
              <Link href="/search" className="btn-primary btn-sm mt-2">
                Find jobs to apply to
              </Link>
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Applied</th>
                </tr>
              </thead>
              <tbody>
                {data.recentApplications.map((a) => (
                  <tr key={a.id}>
                    <td className="font-medium text-slate-800">{a.job?.company || 'Unknown'}</td>
                    <td className="max-w-[220px] truncate text-slate-600">{a.job?.title || '—'}</td>
                    <td>
                      <StatusBadge status={a.status} size="sm" />
                    </td>
                    <td className="whitespace-nowrap text-slate-500">
                      {a.appliedAt ? new Date(a.appliedAt).toLocaleDateString() : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* status donut */}
        <div className="card">
          <PanelHeader title="Application Status" />
          <div className="h-[260px] p-4">
            <StatusDonut stats={s} />
          </div>
        </div>
      </div>

      {/* ---- ROW 3 -------------------------------------------------------- */}
      <div className="grid gap-4 lg:grid-cols-3">
        {/* top matches */}
        <div className="card lg:col-span-2">
          <PanelHeader
            title="Top Matching Jobs"
            action={
              <Link href="/search" className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline">
                View All <ArrowRight size={13} />
              </Link>
            }
          />
          {data.topMatchJobs.length === 0 ? (
            <div className="empty-state">
              <p>No jobs yet. Scrape some from the Job Search page.</p>
              <Link href="/search" className="btn-primary btn-sm mt-2">
                Go to Job Search
              </Link>
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.topMatchJobs.map((job) => (
                <li key={job.id} className="flex items-center gap-3 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-800">{job.title}</p>
                    <p className="truncate text-xs text-slate-500">
                      {job.company}
                      {job.location ? ` · ${job.location}` : ''}
                    </p>
                  </div>
                  <MatchScoreBadge score={job.matchScore} size="sm" />
                  <button
                    type="button"
                    className="btn-primary btn-sm shrink-0"
                    onClick={() => quickApply(job)}
                    disabled={applying === job.id}
                  >
                    {applying === job.id ? <Loader label="" /> : 'Apply Now'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* skill gaps */}
        <div className="card">
          <PanelHeader title="Skill Gaps" />
          <div className="p-5">
            {data.skillGaps.length === 0 ? (
              <p className="text-sm text-slate-400">
                No gaps detected yet. Apply to jobs with a decent match to see what is holding you back.
              </p>
            ) : (
              <ul className="space-y-3">
                {data.skillGaps.map((gap) => (
                  <li key={gap.skill}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-slate-700">{gap.skill}</span>
                      <span className="shrink-0 text-xs text-slate-400">{gap.count} jobs</span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100">
                      <div className="h-full rounded-full bg-red-400" style={{ width: `${Math.max(6, gap.percentage)}%` }} />
                    </div>
                    <a
                      href={`https://www.google.com/search?q=learn+${encodeURIComponent(gap.skill)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1 inline-flex items-center gap-1 text-[11px] text-brand-600 hover:underline"
                    >
                      Learn more <ExternalLink size={9} />
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      {/* ---- ROW 4 --------------------------------------------------------- */}
      <div className="grid gap-4 lg:grid-cols-3">
        {/* follow-ups */}
        <div className="card lg:col-span-2">
          <PanelHeader
            title="Upcoming Follow-ups"
            action={
              <Link href="/tracker" className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline">
                Tracker <ArrowRight size={13} />
              </Link>
            }
          />
          {data.upcomingFollowUps.length === 0 ? (
            <div className="empty-state">
              <CalendarClock size={22} className="text-slate-300" />
              <p>Nothing due in the next 7 days.</p>
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.upcomingFollowUps.map((f) => (
                <li key={f.id} className="flex items-center gap-3 px-5 py-3">
                  <span
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                      f.daysRemaining === 0 ? 'bg-red-50 text-red-600' : 'bg-brand-50 text-brand-600'
                    }`}
                  >
                    <CalendarClock size={16} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-800">{f.job?.company || 'Unknown'}</p>
                    <p className="truncate text-xs text-slate-500">{f.job?.title || '—'}</p>
                  </div>
                  <StatusBadge status={f.status} size="sm" />
                  <span
                    className={`shrink-0 text-xs font-semibold ${f.daysRemaining === 0 ? 'text-red-600' : 'text-slate-500'}`}
                  >
                    {f.daysLabel}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* scrape info + resume summary */}
        <div className="space-y-4">
          <div className="card">
            <PanelHeader title="Last Scrape" />
            <div className="p-5">
              {data.lastScrapeInfo ? (
                <>
                  <p className="text-sm text-slate-700">
                    Last scraped: <span className="font-semibold">{data.lastScrapeInfo.ago}</span>
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {data.lastScrapeInfo.jobsFound} found · {data.lastScrapeInfo.jobsAdded} new · from{' '}
                    {data.lastScrapeInfo.source}
                  </p>
                  {data.lastScrapeInfo.status !== 'success' && data.lastScrapeInfo.errorMessage && (
                    <p className="mt-2 rounded-md bg-yellow-50 px-2 py-1.5 text-[11px] text-yellow-800">
                      {data.lastScrapeInfo.errorMessage}
                    </p>
                  )}
                </>
              ) : (
                <div className="flex items-start gap-2 text-sm text-slate-500">
                  <Database size={16} className="mt-0.5 shrink-0 text-slate-400" />
                  <span>
                    Nothing scraped yet. Use <span className="font-medium">⚡ Scrape New Jobs</span> on the Job Search page,
                    or run <code className="rounded bg-slate-100 px-1">npm run seed</code> in the backend for demo data.
                  </span>
                </div>
              )}
            </div>
          </div>

          <div className="card">
            <PanelHeader
              title="Your Resume"
              action={
                <Link href="/resume" className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline">
                  Manage <ArrowRight size={13} />
                </Link>
              }
            />
            <div className="p-5">
              {data.defaultResume ? (
                <>
                  <div className="flex items-center gap-2">
                    <FileText size={16} className="text-red-500" />
                    <p className="truncate text-sm font-medium text-slate-800">{data.defaultResume.label}</p>
                  </div>
                  <div className="mt-3 flex items-baseline gap-2">
                    <span className="text-2xl font-bold text-slate-900">{data.defaultResume.atsScore}</span>
                    <span className="text-xs text-slate-500">ATS score · {data.defaultResume.skillCount} skills</span>
                  </div>
                  {data.defaultResume.summary && (
                    <p className="mt-3 line-clamp-3 text-xs leading-relaxed text-slate-500">{data.defaultResume.summary}</p>
                  )}
                </>
              ) : (
                <div className="flex items-start gap-2 text-sm text-slate-500">
                  <FileText size={16} className="mt-0.5 shrink-0 text-slate-400" />
                  <span>
                    No resume uploaded yet — match scores stay at 0% until you add one.
                    <Link href="/resume" className="ml-1 font-medium text-brand-600 hover:underline">
                      Upload now →
                    </Link>
                  </span>
                </div>
              )}

              <div className="mt-3 flex items-center gap-1.5 text-[11px]">
                <Sparkles size={12} className={data.aiConfigured ? 'text-green-500' : 'text-slate-400'} />
                <span className={data.aiConfigured ? 'text-green-700' : 'text-slate-500'}>
                  {data.aiConfigured ? 'AI cover letters enabled' : 'AI off — using the built-in template engine'}
                </span>
              </div>
            </div>
          </div>

          {data.bookmarked > 0 && (
            <Link href="/search?bookmarked=true" className="card flex items-center gap-3 p-4 transition-shadow hover:shadow-card-hover">
              <Bookmark size={16} className="text-brand-600" />
              <span className="text-sm text-slate-700">
                <span className="font-semibold">{data.bookmarked}</span> bookmarked job{data.bookmarked === 1 ? '' : 's'}
              </span>
              <ArrowRight size={14} className="ml-auto text-slate-400" />
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
