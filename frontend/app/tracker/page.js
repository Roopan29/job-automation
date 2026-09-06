/**
 * app/tracker/page.js — Application Tracker
 * ------------------------------------------------------------------
 * TOP     mini stat chips (click to filter by that status)
 * FILTER  search · status · method · date range · source · Export CSV
 * TABLE   company, role, match, editable status, dates, method, actions
 * MODALS  Notes (+ status history timeline) · Interview prep · Follow-up email draft
 * BOTTOM  line / bar / doughnut charts
 */

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, Search as SearchIcon, X, Send, Trash2, StickyNote, Copy, Check, GraduationCap } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  getApplications,
  getTrackerStats,
  getApplication,
  updateApplicationNotes,
  deleteApplication,
  exportApplicationsCsv,
  generateFollowUpEmail,
  generateInterviewPrep,
} from '@/services/api';
import ApplicationRow from '@/components/ApplicationRow';
import StatusBadge, { STATUS_META, STATUS_KEYS } from '@/components/StatusBadge';
import ConfirmModal from '@/components/ConfirmModal';
import Loader, { SkeletonTable, Spinner } from '@/components/Loader';
import { ApplicationsLine, SourceBar, StatusDonut } from '@/components/Charts';

/** Clickable status chip in the mini-stats row. */
function StatChip({ label, count, tone, active, onClick }) {
  const tones = {
    blue: 'border-blue-200 bg-blue-50 text-blue-700',
    purple: 'border-purple-200 bg-purple-50 text-purple-700',
    yellow: 'border-yellow-200 bg-yellow-50 text-yellow-800',
    green: 'border-green-200 bg-green-50 text-green-700',
    red: 'border-red-200 bg-red-50 text-red-700',
    slate: 'border-slate-200 bg-slate-50 text-slate-600',
    orange: 'border-orange-200 bg-orange-50 text-orange-700',
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg border px-3 py-2 text-left transition-all ${
        active ? `${tones[tone]} ring-2 ring-offset-1 ring-brand-500` : 'border-slate-200 bg-white hover:bg-slate-50'
      }`}
      aria-pressed={active}
    >
      <p className="text-lg font-bold leading-tight">{count}</p>
      <p className="text-[11px] font-medium uppercase tracking-wide opacity-80">{label}</p>
    </button>
  );
}

export default function TrackerPage() {
  const [applications, setApplications] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  // filters
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [method, setMethod] = useState('all');
  const [source, setSource] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // modals
  const [notesApp, setNotesApp] = useState(null);
  const [prepApp, setPrepApp] = useState(null);
  const [emailApp, setEmailApp] = useState(null);
  const [deleteApp, setDeleteApp] = useState(null);

  /* ---- data --------------------------------------------------------- */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, statData] = await Promise.all([
        getApplications({
          search: search || undefined,
          status: status !== 'all' ? status : undefined,
          method: method !== 'all' ? method : undefined,
          source: source !== 'all' ? source : undefined,
          dateFrom: dateFrom || undefined,
          dateTo: dateTo || undefined,
        }),
        getTrackerStats(),
      ]);
      setApplications(list.applications || []);
      setStats(statData);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }, [search, status, method, source, dateFrom, dateTo]);

  useEffect(() => {
    load();
  }, [load]);

  const doExport = async () => {
    setExporting(true);
    try {
      await exportApplicationsCsv();
      toast.success('CSV downloaded');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setExporting(false);
    }
  };

  const remove = async () => {
    try {
      await deleteApplication(deleteApp.id);
      toast.success('Application deleted');
      await load();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const filtersActive =
    search || status !== 'all' || method !== 'all' || source !== 'all' || dateFrom || dateTo;

  const sourceOptions = useMemo(
    () => Object.keys(stats?.bySource || {}).sort(),
    [stats]
  );

  return (
    <div className="space-y-5">
      {/* ---- header ---------------------------------------------------- */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">Application Tracker</h1>
          <p className="page-subtitle">Every application, its status and what happens next.</p>
        </div>
        <button type="button" className="btn-secondary" onClick={doExport} disabled={exporting}>
          {exporting ? <Spinner size={15} /> : <Download size={15} />} Export CSV
        </button>
      </div>

      {/* ---- mini stats -------------------------------------------------- */}
      {stats && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-7">
          <StatChip label="Applied" count={stats.applied} tone="blue" active={status === 'applied'} onClick={() => setStatus(status === 'applied' ? 'all' : 'applied')} />
          <StatChip label="Responded" count={stats.responded} tone="purple" active={status === 'responded'} onClick={() => setStatus(status === 'responded' ? 'all' : 'responded')} />
          <StatChip label="Interview" count={stats.interview} tone="yellow" active={status === 'interview'} onClick={() => setStatus(status === 'interview' ? 'all' : 'interview')} />
          <StatChip label="Offer" count={stats.offer} tone="green" active={status === 'offer'} onClick={() => setStatus(status === 'offer' ? 'all' : 'offer')} />
          <StatChip label="Rejected" count={stats.rejected} tone="red" active={status === 'rejected'} onClick={() => setStatus(status === 'rejected' ? 'all' : 'rejected')} />
          <StatChip label="Ghosted" count={stats.ghosted} tone="slate" active={status === 'ghosted'} onClick={() => setStatus(status === 'ghosted' ? 'all' : 'ghosted')} />
          <StatChip label="Withdrawn" count={stats.withdrawn} tone="orange" active={status === 'withdrawn'} onClick={() => setStatus(status === 'withdrawn' ? 'all' : 'withdrawn')} />
        </div>
      )}

      {/* ---- filter bar ---------------------------------------------------- */}
      <div className="card">
        <div className="card-body grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <div className="lg:col-span-2">
            <label className="label" htmlFor="t-search">
              Search
            </label>
            <div className="relative">
              <SearchIcon size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                id="t-search"
                className="input pl-9"
                placeholder="Company, role or notes"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>

          <div>
            <label className="label" htmlFor="t-status">
              Status
            </label>
            <select id="t-status" className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="all">All statuses</option>
              {STATUS_KEYS.map((k) => (
                <option key={k} value={k}>
                  {STATUS_META[k].label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="label" htmlFor="t-method">
              Applied via
            </label>
            <select id="t-method" className="select" value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="all">All</option>
              <option value="auto">Auto 🤖</option>
              <option value="manual">Manual 👤</option>
            </select>
          </div>

          <div>
            <label className="label" htmlFor="t-source">
              Source
            </label>
            <select id="t-source" className="select" value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="all">All sources</option>
              {sourceOptions.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="label" htmlFor="t-from">
                From
              </label>
              <input id="t-from" type="date" className="input" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="t-to">
                To
              </label>
              <input id="t-to" type="date" className="input" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
            </div>
          </div>

          {filtersActive && (
            <div className="sm:col-span-2 lg:col-span-6">
              <button
                type="button"
                className="btn-ghost btn-sm"
                onClick={() => {
                  setSearch('');
                  setStatus('all');
                  setMethod('all');
                  setSource('all');
                  setDateFrom('');
                  setDateTo('');
                }}
              >
                <X size={13} /> Clear all filters
              </button>
              <span className="ml-2 text-xs text-slate-400">
                {applications.length} of {stats?.total || 0} application(s) shown
              </span>
            </div>
          )}
        </div>
      </div>

      {/* ---- table ---------------------------------------------------------- */}
      <div className="card overflow-hidden">
        {loading ? (
          <SkeletonTable rows={6} cols={7} />
        ) : applications.length === 0 ? (
          <div className="empty-state">
            <StickyNote size={24} className="text-slate-300" />
            <p className="font-medium text-slate-600">No applications match these filters</p>
            <p>Apply to a job from the Job Search page to see it here.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="table min-w-[900px]">
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Role</th>
                  <th>Match</th>
                  <th>Status</th>
                  <th>Applied</th>
                  <th>Follow-up</th>
                  <th>Via</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {applications.map((app) => (
                  <ApplicationRow
                    key={app.id}
                    application={app}
                    onChanged={load}
                    onNotes={setNotesApp}
                    onInterviewPrep={setPrepApp}
                    onFollowUpEmail={setEmailApp}
                    onDelete={setDeleteApp}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ---- charts ----------------------------------------------------------- */}
      {stats && (
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="card">
            <div className="card-header">
              <h2 className="card-title">Applications — last 30 days</h2>
            </div>
            <div className="h-[240px] p-4">
              <ApplicationsLine series={stats.last30Days} />
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <h2 className="card-title">By source</h2>
            </div>
            <div className="h-[240px] p-4">
              <SourceBar bySource={stats.bySource} />
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <h2 className="card-title">By status</h2>
            </div>
            <div className="h-[240px] p-4">
              <StatusDonut stats={stats} />
            </div>
          </div>
        </div>
      )}

      {/* ---- modals -------------------------------------------------------------- */}
      <NotesModal application={notesApp} onClose={() => setNotesApp(null)} onSaved={load} />
      <InterviewPrepModal application={prepApp} onClose={() => setPrepApp(null)} />
      <FollowUpEmailModal application={emailApp} onClose={() => setEmailApp(null)} />

      <ConfirmModal
        open={Boolean(deleteApp)}
        title="Delete this application?"
        message={
          deleteApp
            ? `${deleteApp.job?.company || 'This company'} — ${deleteApp.job?.title || 'role'}. The job goes back into the apply queue.`
            : ''
        }
        confirmLabel="Delete"
        danger
        onConfirm={remove}
        onClose={() => setDeleteApp(null)}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Notes modal (+ status history timeline)
 * ------------------------------------------------------------------ */

function NotesModal({ application, onClose, onSaved }) {
  const [notes, setNotes] = useState('');
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!application) return;
    setNotes(application.notes || '');
    setHistory([]);
    setLoading(true);
    getApplication(application.id)
      .then((data) => setHistory(data.history || []))
      .catch((err) => toast.error(err.message))
      .finally(() => setLoading(false));
  }, [application]);

  if (!application) return null;

  const save = async () => {
    setSaving(true);
    try {
      await updateApplicationNotes(application.id, notes);
      toast.success('Notes saved');
      onSaved?.();
      onClose?.();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm"
      onMouseDown={() => !saving && onClose?.()}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="max-h-[85vh] w-full max-w-xl animate-slide-up overflow-y-auto rounded-xl bg-white shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div>
            <h3 className="text-base font-semibold text-slate-900">Notes</h3>
            <p className="mt-0.5 text-xs text-slate-500">
              {application.job?.company} — {application.job?.title}
            </p>
          </div>
          <button type="button" onClick={() => !saving && onClose?.()} className="text-slate-400 hover:text-slate-600" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4 p-5">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={6}
            className="input resize-y"
            placeholder="Recruiter name, interview rounds, salary discussed, next steps…"
            maxLength={5000}
          />
          <p className="text-right text-[11px] text-slate-400">{notes.length}/5000</p>

          <div>
            <p className="label">Status history</p>
            {loading ? (
              <Loader label="Loading history…" />
            ) : history.length === 0 ? (
              <p className="text-sm text-slate-400">No status changes recorded yet.</p>
            ) : (
              <ol className="relative space-y-3 border-l border-slate-200 pl-4">
                {history.map((h) => (
                  <li key={h.id} className="relative">
                    <span className="absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full border-2 border-white bg-brand-500" />
                    <div className="flex flex-wrap items-center gap-2">
                      {h.oldStatus && <StatusBadge status={h.oldStatus} size="sm" />}
                      {h.oldStatus && <span className="text-slate-300">→</span>}
                      <StatusBadge status={h.newStatus} size="sm" />
                      <span className="text-[11px] text-slate-400">
                        {new Date(h.changedAt).toLocaleString()}
                      </span>
                    </div>
                    {h.note && <p className="mt-1 text-xs text-slate-500">{h.note}</p>}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={save} disabled={saving}>
            {saving ? <Spinner size={14} /> : <StickyNote size={14} />} Save notes
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Interview prep modal
 * ------------------------------------------------------------------ */

function InterviewPrepModal({ application, onClose }) {
  const [questions, setQuestions] = useState([]);
  const [source, setSource] = useState('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!application) return;
    setQuestions([]);
    setCopied(false);
    setLoading(true);
    generateInterviewPrep(application.jobId || 0)
      .then((data) => {
        setQuestions(data.questions || []);
        setSource(data.source === 'ai' ? 'AI generated' : 'Template engine');
      })
      .catch((err) => toast.error(err.message))
      .finally(() => setLoading(false));
  }, [application]);

  if (!application) return null;

  /** Flatten the Q&A into plain text for the clipboard. */
  const copy = async () => {
    const text = questions
      .map((q, i) => `${i + 1}. ${q.question}\n   ${q.suggestedAnswer || ''}`.trimEnd())
      .join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success('Questions copied to the clipboard');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Could not access the clipboard');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm"
      onMouseDown={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl animate-slide-up flex-col overflow-hidden rounded-xl bg-white shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div>
            <h3 className="text-base font-semibold text-slate-900">Interview prep</h3>
            <p className="mt-0.5 text-xs text-slate-500">
              {application.job?.company} — {application.job?.title}
              {source ? ` · ${source}` : ''}
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {loading ? (
            <Loader full label="Preparing your questions…" />
          ) : questions.length === 0 ? (
            <p className="text-sm text-slate-400">No questions could be generated for this role.</p>
          ) : (
            <ol className="space-y-3">
              {questions.map((q, i) => (
                <li key={q.question} className="rounded-lg border border-slate-200 p-3">
                  <p className="flex gap-2 text-sm font-medium text-slate-800">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-50 text-[11px] font-bold text-brand-600">
                      {i + 1}
                    </span>
                    {q.question}
                  </p>
                  {q.suggestedAnswer && (
                    <p className="mt-2 pl-7 text-[13px] leading-relaxed text-slate-500">{q.suggestedAnswer}</p>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3">
          <button type="button" className="btn-secondary" onClick={copy} disabled={!questions.length}>
            {copied ? <Check size={14} className="text-green-600" /> : <Copy size={14} />}
            {copied ? 'Copied' : 'Copy all'}
          </button>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Follow-up email modal
 * ------------------------------------------------------------------ */

function FollowUpEmailModal({ application, onClose }) {
  const [draft, setDraft] = useState('');
  const [source, setSource] = useState('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!application) return;
    setDraft('');
    setCopied(false);
    setLoading(true);
    generateFollowUpEmail(application.jobId || 0)
      .then((data) => {
        setDraft(data.emailDraft || '');
        setSource(data.source === 'ai' ? 'AI generated' : 'Template engine');
      })
      .catch((err) => toast.error(err.message))
      .finally(() => setLoading(false));
  }, [application]);

  if (!application) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(draft);
      setCopied(true);
      toast.success('Email copied to the clipboard');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Could not access the clipboard');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm"
      onMouseDown={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl animate-slide-up flex-col overflow-hidden rounded-xl bg-white shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div>
            <h3 className="text-base font-semibold text-slate-900">Follow-up email</h3>
            <p className="mt-0.5 text-xs text-slate-500">
              {application.job?.company} — {application.job?.title}
              {source ? ` · ${source}` : ''}
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {loading ? (
            <Loader full label="Drafting your follow-up…" />
          ) : (
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={14}
              className="input resize-y font-serif text-[13px] leading-relaxed"
            />
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3">
          <button type="button" className="btn-secondary" onClick={copy} disabled={!draft}>
            {copied ? <Check size={14} className="text-green-600" /> : <Copy size={14} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Close
          </button>
          <a
            className="btn-primary"
            href={`mailto:?subject=${encodeURIComponent(
              `Following up — ${application.job?.title || 'my application'}`
            )}&body=${encodeURIComponent(draft)}`}
          >
            <Send size={14} /> Open in mail app
          </a>
        </div>
      </div>
    </div>
  );
}
