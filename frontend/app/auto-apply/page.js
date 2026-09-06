/**
 * app/auto-apply/page.js — Auto Apply
 * ------------------------------------------------------------------
 * 1  Status: big on/off toggle, today's progress, queue, next run
 * 2  Auto-apply settings (min score, daily limit, schedule, sources…)
 * 3  Scrape settings (schedule, target roles/locations, sources)
 * 4  Manual run: ▶ Run now + live console log + ⏹ Stop
 * 5  Recent auto-apply results table
 *
 * The live log polls GET /api/apply/log every 2 s while a batch runs.
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Play,
  Square,
  Save,
  Zap,
  Bot,
  Clock,
  ListChecks,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Plus,
  X,
  RefreshCw,
} from 'lucide-react';
import toast from 'react-hot-toast';
import {
  getApplyStatus,
  runAutoApplyBatch,
  stopAutoApply,
  getApplyLog,
  updatePreferences,
  scrapeJobs,
} from '@/services/api';
import { useApp } from '@/context/AppContext';
import Loader, { Spinner } from '@/components/Loader';

const TONES = [
  { value: 'professional', label: 'Professional' },
  { value: 'friendly', label: 'Friendly' },
  { value: 'confident', label: 'Confident' },
];
const DELAYS = [
  { value: '30s', label: '30 seconds' },
  { value: '60s', label: '1 minute' },
  { value: '2min', label: '2 minutes' },
  { value: '5min', label: '5 minutes' },
];
const APPLY_SOURCES = [
  { id: 'indeed', label: 'Indeed' },
  { id: 'linkedin', label: 'LinkedIn' },
  { id: 'glassdoor', label: 'Glassdoor' },
  { id: 'remoteok', label: 'RemoteOK' },
  { id: 'remotive', label: 'Remotive' },
];
const SCRAPE_SOURCES = APPLY_SOURCES;

/** iOS-style switch. */
function Toggle({ checked, onChange, label, disabled }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? 'bg-brand-600' : 'bg-slate-300'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  );
}

/** "0 9 * * *" <-> a time input. Only the daily-at-HH:MM case is editable. */
function cronToTime(cron) {
  const parts = String(cron || '').trim().split(/\s+/);
  if (parts.length !== 5) return { time: '09:00', daily: false };
  const [m, h, dom, mon, dow] = parts;
  const daily = dom === '*' && mon === '*' && dow === '*';
  const hh = String(Number(h)).padStart(2, '0');
  const mm = String(Number(m)).padStart(2, '0');
  const valid = /^\d{2}:\d{2}$/.test(`${hh}:${mm}`) && !Number.isNaN(Number(h)) && !Number.isNaN(Number(m));
  return { time: valid ? `${hh}:${mm}` : '09:00', daily };
}

function timeToCron(time) {
  const [h, m] = String(time || '09:00').split(':');
  return `${Number(m) || 0} ${Number(h) || 0} * * *`;
}

/** Tag input used for target roles / locations. */
function TagInput({ label, values = [], onChange, placeholder }) {
  const [draft, setDraft] = useState('');

  const add = () => {
    const value = draft.trim();
    if (!value) return;
    if (values.includes(value)) {
      toast('Already added');
      setDraft('');
      return;
    }
    onChange([...values, value]);
    setDraft('');
  };

  return (
    <div>
      <span className="label">{label}</span>
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-slate-300 bg-white p-2">
        {values.map((v) => (
          <span key={v} className="pill bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-100">
            {v}
            <button type="button" onClick={() => onChange(values.filter((x) => x !== v))} aria-label={`Remove ${v}`}>
              <X size={11} />
            </button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              add();
            }
            if (e.key === 'Backspace' && !draft && values.length) onChange(values.slice(0, -1));
          }}
          placeholder={values.length ? '' : placeholder}
          className="min-w-[120px] flex-1 border-none bg-transparent text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none"
        />
        <button type="button" onClick={add} className="btn-ghost btn-sm" aria-label={`Add ${label}`}>
          <Plus size={13} />
        </button>
      </div>
    </div>
  );
}

export default function AutoApplyPage() {
  const { preferences, resumes, refresh } = useApp();

  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [scraping, setScraping] = useState(false);
  const [log, setLog] = useState([]);

  // Local form state, seeded from preferences.
  const [form, setForm] = useState(null);
  const [roles, setRoles] = useState([]);
  const [locations, setLocations] = useState([]);

  const logRef = useRef(null);
  const pollRef = useRef(null);

  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  /* ---- load ------------------------------------------------------------ */
  const load = useCallback(async () => {
    try {
      const data = await getApplyStatus();
      setStatus(data);
      setLog(data.log || []);
      setRunning(data.running);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Seed the form once preferences arrive.
  useEffect(() => {
    if (!preferences || form) return;
    setForm({
      autoApplyEnabled: preferences.autoApplyEnabled,
      minMatchScore: preferences.minMatchScore,
      dailyApplyLimit: preferences.dailyApplyLimit,
      autoApplySchedule: preferences.autoApplySchedule,
      defaultResumeId: preferences.defaultResumeId || resumes[0]?.id || '',
      generateCoverLetter: preferences.generateCoverLetter,
      coverLetterTone: preferences.coverLetterTone,
      autoApplySources: preferences.autoApplySources || [],
      delayBetweenApplications: preferences.delayBetweenApplications,
      autoScrapeEnabled: preferences.autoScrapeEnabled,
      scrapeSchedule: preferences.scrapeSchedule,
      scrapeSources: preferences.scrapeSources || [],
    });
    setRoles(preferences.targetRoles || []);
    setLocations(preferences.targetLocations || []);
  }, [preferences, resumes, form]);

  useEffect(() => {
    load();
  }, [load]);

  // Poll the live log while a batch is running.
  useEffect(() => {
    if (!running) return undefined;
    pollRef.current = setInterval(async () => {
      try {
        const data = await getApplyLog(0);
        setLog(data.log || []);
        if (!data.running) {
          setRunning(false);
          load();
        }
      } catch {
        /* ignore transient poll errors */
      }
    }, 2000);
    return () => clearInterval(pollRef.current);
  }, [running, load]);

  // Auto-scroll the console.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  if (loading || !form) return <Loader full label="Loading auto-apply settings…" />;

  /* ---- actions ---------------------------------------------------------- */
  const save = async (extra = {}) => {
    setSaving(true);
    try {
      const payload = {
        autoApplyEnabled: form.autoApplyEnabled,
        minMatchScore: Number(form.minMatchScore),
        dailyApplyLimit: Number(form.dailyApplyLimit),
        autoApplySchedule: form.autoApplySchedule,
        generateCoverLetter: form.generateCoverLetter,
        coverLetterTone: form.coverLetterTone,
        autoApplySources: form.autoApplySources,
        delayBetweenApplications: form.delayBetweenApplications,
        autoScrapeEnabled: form.autoScrapeEnabled,
        scrapeSchedule: form.scrapeSchedule,
        scrapeSources: form.scrapeSources,
        targetRoles: roles,
        targetLocations: locations,
        ...extra,
      };
      await updatePreferences(payload);
      await refresh();
      await load();
      toast.success('Settings saved');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  const toggleAutoApply = async (next) => {
    set('autoApplyEnabled', next);
    try {
      await updatePreferences({ autoApplyEnabled: next });
      await refresh();
      await load();
      toast.success(next ? 'Auto Apply is ON' : 'Auto Apply is OFF');
    } catch (err) {
      set('autoApplyEnabled', !next);
      toast.error(err.message);
    }
  };

  const runNow = async () => {
    setRunning(true);
    setLog([]);
    try {
      const data = await runAutoApplyBatch({});
      setLog(data.log || []);
      if (data.attempted === 0) toast(data.message || 'Nothing in the queue', { icon: 'ℹ️' });
      else toast.success(`${data.succeeded} applied · ${data.failed} failed · ${data.captchaHit} CAPTCHA`);
    } catch (err) {
      toast.error(err.hint ? `${err.message} — ${err.hint}` : err.message, { duration: 8000 });
    } finally {
      setRunning(false);
      load();
      refresh();
    }
  };

  const stop = async () => {
    try {
      await stopAutoApply();
      toast('Stop requested — the current job will finish first.', { icon: '⏹' });
      load();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const scrapeNow = async () => {
    setScraping(true);
    try {
      const data = await scrapeJobs({
        query: roles[0] || 'Software Engineer',
        location: locations[0] || 'Remote',
        sources: form.scrapeSources,
        limit: 25,
      });
      toast.success(`Scraped ${data.jobsFound} jobs — ${data.jobsAdded} new`);
      load();
    } catch (err) {
      toast.error(err.message, { duration: 8000 });
    } finally {
      setScraping(false);
    }
  };

  const toggleIn = (key, id, list) =>
    set(key, list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const applyTime = cronToTime(form.autoApplySchedule);
  const scrapeTime = cronToTime(form.scrapeSchedule);
  const queue = status?.queue || 0;
  const today = status?.today || { applied: 0, limit: 0 };
  const pct = today.limit ? Math.min(100, Math.round((today.applied / today.limit) * 100)) : 0;

  return (
    <div className="space-y-5">
      {/* ---- header --------------------------------------------------- */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">Auto Apply</h1>
          <p className="page-subtitle">
            Drive a real browser through application forms on a schedule — with a human in the loop for
            CAPTCHAs.
          </p>
        </div>
        <button type="button" className="btn-secondary" onClick={load}>
          <RefreshCw size={15} /> Refresh
        </button>
      </div>

      {/* ---- 1. status -------------------------------------------------- */}
      <section className="card">
        <div className="card-body grid gap-6 lg:grid-cols-[auto_1fr]">
          <div className="flex flex-col items-center gap-3 lg:pr-6 lg:border-r lg:border-slate-100">
            <Toggle checked={form.autoApplyEnabled} onChange={toggleAutoApply} label="Auto Apply" />
            <p className="text-sm font-semibold text-slate-800">Auto Apply is {form.autoApplyEnabled ? 'ON' : 'OFF'}</p>
            <p className="max-w-[200px] text-center text-xs text-slate-400">
              {form.autoApplyEnabled
                ? `Runs daily at ${applyTime.time}. It will apply to up to ${form.dailyApplyLimit} jobs per day.`
                : 'Turn it on to let the scheduler apply for you.'}
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <p className="label">Today</p>
              <p className="text-xl font-bold text-slate-900">
                {today.applied} <span className="text-sm font-normal text-slate-400">/ {today.limit}</span>
              </p>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100">
                <div className="h-full rounded-full bg-brand-600" style={{ width: `${pct}%` }} />
              </div>
            </div>
            <div>
              <p className="label">Queue</p>
              <p className="flex items-center gap-1.5 text-xl font-bold text-slate-900">
                <ListChecks size={16} className="text-slate-400" />
                {queue}
              </p>
              <p className="mt-1 text-xs text-slate-400">
                jobs ≥ {form.minMatchScore}% not yet applied
              </p>
            </div>
            <div>
              <p className="label">Next run</p>
              <p className="flex items-center gap-1.5 text-xl font-bold text-slate-900">
                <Clock size={16} className="text-slate-400" />
                {status?.nextRun || '—'}
              </p>
              <p className="mt-1 text-xs text-slate-400">cron: {form.autoApplySchedule}</p>
            </div>
            <div>
              <p className="label">Browser</p>
              {status?.browser?.available ? (
                <p className="flex items-center gap-1.5 text-sm font-semibold text-green-700">
                  <CheckCircle2 size={15} /> Ready
                </p>
              ) : (
                <p className="flex items-start gap-1.5 text-sm font-semibold text-red-600">
                  <XCircle size={15} className="mt-0.5 shrink-0" />
                  <span className="text-xs font-normal">
                    Unavailable
                    <span className="mt-0.5 block text-slate-500">{status?.browser?.hint}</span>
                  </span>
                </p>
              )}
              <p className="mt-1 text-xs text-slate-400">
                {status?.browser?.available
                  ? status.browser.headless
                    ? 'headless — CAPTCHAs cannot be solved'
                    : 'headful — you can solve CAPTCHAs'
                  : status?.browser?.reason || 'not started'}
              </p>
            </div>
          </div>
        </div>
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* ---- 2. auto-apply settings ------------------------------------ */}
        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Auto-apply settings</h2>
          </div>
          <div className="card-body space-y-4">
            <div>
              <label className="label" htmlFor="minScore">
                Minimum match score: <span className="text-brand-600">{form.minMatchScore}%</span>
              </label>
              <input
                id="minScore"
                type="range"
                min="50"
                max="100"
                step="5"
                value={form.minMatchScore}
                onChange={(e) => set('minMatchScore', e.target.value)}
                className="w-full"
              />
              <div className="flex justify-between text-[10px] text-slate-400">
                <span>50%</span>
                <span>75%</span>
                <span>100%</span>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="limit">
                  Daily apply limit
                </label>
                <input
                  id="limit"
                  type="number"
                  min="1"
                  max="200"
                  className="input"
                  value={form.dailyApplyLimit}
                  onChange={(e) => set('dailyApplyLimit', e.target.value)}
                />
              </div>
              <div>
                <label className="label" htmlFor="delay">
                  Delay between applications
                </label>
                <select
                  id="delay"
                  className="select"
                  value={form.delayBetweenApplications}
                  onChange={(e) => set('delayBetweenApplications', e.target.value)}
                >
                  {DELAYS.map((d) => (
                    <option key={d.value} value={d.value}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="label" htmlFor="applyTime">
                Schedule (daily)
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="applyTime"
                  type="time"
                  className="input"
                  value={applyTime.time}
                  onChange={(e) => set('autoApplySchedule', timeToCron(e.target.value))}
                />
                <code className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-500">{form.autoApplySchedule}</code>
              </div>
              {!applyTime.daily && (
                <p className="mt-1 text-[11px] text-yellow-700">
                  The stored cron is not a simple daily schedule. Saving will replace it with one.
                </p>
              )}
            </div>

            <div>
              <label className="label" htmlFor="resume">
                Default resume
              </label>
              <select
                id="resume"
                className="select"
                value={form.defaultResumeId}
                onChange={(e) => set('defaultResumeId', e.target.value)}
              >
                <option value="">— none —</option>
                {resumes.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label} (ATS {r.atsScore})
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2.5">
              <div>
                <p className="text-sm font-medium text-slate-700">Generate cover letters</p>
                <p className="text-xs text-slate-400">
                  {form.generateCoverLetter ? 'AI when a key is set, otherwise the template engine' : 'Apply without a letter'}
                </p>
              </div>
              <Toggle
                checked={form.generateCoverLetter}
                onChange={(v) => set('generateCoverLetter', v)}
                label="Generate cover letters"
              />
            </div>

            <div>
              <label className="label" htmlFor="tone">
                Cover letter tone
              </label>
              <select id="tone" className="select" value={form.coverLetterTone} onChange={(e) => set('coverLetterTone', e.target.value)}>
                {TONES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <span className="label">Job sources to auto-apply</span>
              <div className="flex flex-wrap gap-2">
                {APPLY_SOURCES.map((s) => (
                  <label
                    key={s.id}
                    className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-xs ${
                      form.autoApplySources.includes(s.id)
                        ? 'border-brand-300 bg-brand-50 text-slate-800'
                        : 'border-slate-200 text-slate-500'
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                      checked={form.autoApplySources.includes(s.id)}
                      onChange={() => toggleIn('autoApplySources', s.id, form.autoApplySources)}
                    />
                    {s.label}
                  </label>
                ))}
              </div>
            </div>

            <button type="button" className="btn-primary w-full" onClick={() => save({ defaultResumeId: Number(form.defaultResumeId) || null })} disabled={saving}>
              {saving ? <Spinner size={14} /> : <Save size={14} />} Save Settings
            </button>
          </div>
        </section>

        {/* ---- 3. scrape settings ---------------------------------------- */}
        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Job scrape settings</h2>
          </div>
          <div className="card-body space-y-4">
            <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2.5">
              <div>
                <p className="text-sm font-medium text-slate-700">Auto-scrape</p>
                <p className="text-xs text-slate-400">Refresh the job board listings on a schedule</p>
              </div>
              <Toggle checked={form.autoScrapeEnabled} onChange={(v) => set('autoScrapeEnabled', v)} label="Auto-scrape" />
            </div>

            <div>
              <label className="label" htmlFor="scrapeTime">
                Scrape schedule (daily)
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="scrapeTime"
                  type="time"
                  className="input"
                  value={scrapeTime.time}
                  onChange={(e) => set('scrapeSchedule', timeToCron(e.target.value))}
                />
                <code className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-500">{form.scrapeSchedule}</code>
              </div>
            </div>

            <TagInput label="Target roles" values={roles} onChange={setRoles} placeholder="React Developer, +add" />
            <TagInput label="Target locations" values={locations} onChange={setLocations} placeholder="Remote, +add" />

            <div>
              <span className="label">Sources</span>
              <div className="flex flex-wrap gap-2">
                {SCRAPE_SOURCES.map((s) => (
                  <label
                    key={s.id}
                    className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-xs ${
                      form.scrapeSources.includes(s.id)
                        ? 'border-brand-300 bg-brand-50 text-slate-800'
                        : 'border-slate-200 text-slate-500'
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                      checked={form.scrapeSources.includes(s.id)}
                      onChange={() => toggleIn('scrapeSources', s.id, form.scrapeSources)}
                    />
                    {s.label}
                  </label>
                ))}
              </div>
              <p className="mt-1.5 text-[11px] text-slate-400">
                RemoteOK and Remotive expose public JSON APIs. LinkedIn uses its public guest search.
                Indeed and Glassdoor need a local browser and block automated traffic often.
              </p>
            </div>

            <div className="flex gap-2">
              <button type="button" className="btn-primary flex-1" onClick={save} disabled={saving}>
                {saving ? <Spinner size={14} /> : <Save size={14} />} Save
              </button>
              <button type="button" className="btn-secondary flex-1" onClick={scrapeNow} disabled={scraping}>
                {scraping ? <Spinner size={14} /> : <Zap size={14} />} Scrape Now
              </button>
            </div>
          </div>
        </section>
      </div>

      {/* ---- 4. manual run ------------------------------------------------ */}
      <section className="card">
        <div className="card-header">
          <h2 className="card-title">Manual run</h2>
          <div className="flex gap-2">
            <button type="button" className="btn-primary btn-sm" onClick={runNow} disabled={running}>
              {running ? <Spinner size={13} /> : <Play size={13} />}
              {running ? 'Running…' : 'Run Auto-Apply Now'}
            </button>
            <button type="button" className="btn-secondary btn-sm" onClick={stop} disabled={!running}>
              <Square size={13} /> Stop
            </button>
          </div>
        </div>
        <div className="card-body">
          <div className="console" ref={logRef}>
            {log.length === 0 ? (
              <div className="text-slate-500">
                <div>$ waiting for a run…</div>
                <div className="mt-1 text-slate-600">
                  Press “Run Auto-Apply Now”. Each line here is written by the bot as it works through the
                  queue.
                </div>
              </div>
            ) : (
              log.map((entry, i) => (
                <div
                  key={`${entry.ts}-${i}`}
                  className={
                    entry.level === 'error'
                      ? 'text-red-300'
                      : entry.level === 'success'
                        ? 'text-green-300'
                        : entry.level === 'warning'
                          ? 'text-yellow-300'
                          : 'text-slate-300'
                  }
                >
                  <span className="text-slate-500">{new Date(entry.ts).toLocaleTimeString()}</span> {entry.message}
                </div>
              ))
            )}
          </div>

          {status?.browser?.available === false && (
            <div className="mt-3 flex items-start gap-2 rounded-lg bg-yellow-50 px-3 py-2 text-xs text-yellow-800">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>
                Chromium is not available in this environment, so the bot cannot run. Install it with{' '}
                <code className="rounded bg-yellow-100 px-1">npx puppeteer browsers install chrome</code> in the
                backend folder. Manual tracking still works.
              </span>
            </div>
          )}
        </div>
      </section>

      {/* ---- 5. recent results --------------------------------------------- */}
      <section className="card">
        <div className="card-header">
          <h2 className="card-title">Recent auto-apply results</h2>
          <span className="text-xs text-slate-400">last 20</span>
        </div>
        {status?.recentAutoApplications?.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>Company</th>
                <th>Role</th>
                <th>Source</th>
                <th>Status</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {status.recentAutoApplications.map((row) => (
                <tr key={row.id}>
                  <td className="font-medium text-slate-800">{row.company || 'Unknown'}</td>
                  <td className="max-w-[240px] truncate text-slate-600">{row.title || '—'}</td>
                  <td className="text-slate-500">{row.source || '—'}</td>
                  <td>
                    <span className="pill bg-slate-100 text-slate-600 capitalize ring-1 ring-inset ring-slate-200">
                      {row.status}
                    </span>
                  </td>
                  <td className="whitespace-nowrap text-slate-500">
                    {row.applied_at ? new Date(row.applied_at).toLocaleString() : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty-state">
            <Bot size={22} className="text-slate-300" />
            <p>No automated applications yet.</p>
          </div>
        )}
      </section>
    </div>
  );
}
