/**
 * app/preferences/page.js — Preferences
 * ------------------------------------------------------------------
 * 1  Personal info      (name, email, phone, LinkedIn, portfolio, location)
 * 2  Job preferences    (target roles/locations, salary band, type, level)
 * 3  Auto-apply config  (same fields as the Auto Apply page – synced)
 * 4  Notifications      (new jobs, reminders, CAPTCHA always on)
 * 5  AI settings        (OpenAI key, tone, test connection)
 *
 * A single [💾 Save All Preferences] posts the whole form; the backend
 * validates each field and reports anything it rejected.
 */

'use client';

import { useEffect, useState } from 'react';
import { Save, Plus, X, PlugZap, KeyRound, User, Briefcase, Bot, Bell, Sparkles, CheckCircle2, XCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { updatePreferences, testAiConnection } from '@/services/api';
import { useApp } from '@/context/AppContext';
import Loader, { Spinner } from '@/components/Loader';

const TONES = [
  { value: 'professional', label: 'Professional' },
  { value: 'friendly', label: 'Friendly' },
  { value: 'confident', label: 'Confident' },
];
const WORK_TYPES = ['remote', 'hybrid', 'onsite', 'any'];
const LEVELS = ['entry', 'mid', 'senior', 'any'];
const DELAYS = ['30s', '60s', '2min', '5min'];
const APPLY_SOURCES = ['indeed', 'linkedin', 'glassdoor', 'remoteok', 'remotive'];

/** Section wrapper with an icon + heading. */
function Section({ icon, title, description, children }) {
  return (
    <section className="card">
      <div className="card-header">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-50 text-brand-600">{icon}</span>
          <div>
            <h2 className="card-title">{title}</h2>
            {description && <p className="text-xs text-slate-400">{description}</p>}
          </div>
        </div>
      </div>
      <div className="card-body space-y-4">{children}</div>
    </section>
  );
}

/** iOS-style switch. */
function Toggle({ checked, onChange, label, disabled }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
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

/** Comma-separated list editor for target roles / locations. */
function TagInput({ label, values = [], onChange, placeholder, hint }) {
  const [draft, setDraft] = useState('');

  const add = () => {
    const value = draft.trim();
    if (!value) return;
    if (values.includes(value)) {
      setDraft('');
      return;
    }
    onChange([...values, value]);
    setDraft('');
  };

  return (
    <div>
      <span className="label">{label}</span>
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-slate-300 bg-white p-2 focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-500/20">
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
          className="min-w-[140px] flex-1 border-none bg-transparent text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none"
        />
        <button type="button" onClick={add} className="btn-ghost btn-sm" aria-label={`Add to ${label}`}>
          <Plus size={13} />
        </button>
      </div>
      {hint && <p className="mt-1 text-[11px] text-slate-400">{hint}</p>}
    </div>
  );
}

/** "0 9 * * *" <-> time input (daily schedules only). */
function cronToTime(cron) {
  const parts = String(cron || '').trim().split(/\s+/);
  if (parts.length !== 5) return '09:00';
  const [m, h] = parts;
  const hh = String(Number(h)).padStart(2, '0');
  const mm = String(Number(m)).padStart(2, '0');
  return /^\d{2}:\d{2}$/.test(`${hh}:${mm}`) ? `${hh}:${mm}` : '09:00';
}
const timeToCron = (time) => {
  const [h, m] = String(time || '09:00').split(':');
  return `${Number(m) || 0} ${Number(h) || 0} * * *`;
};

export default function PreferencesPage() {
  const { preferences, resumes, refresh, loading: ctxLoading } = useApp();

  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [showKey, setShowKey] = useState(false);
  const [apiKey, setApiKey] = useState('');

  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  // Seed the form when preferences first arrive.
  useEffect(() => {
    if (!preferences || form) return;
    setForm({ ...preferences });
  }, [preferences, form]);

  if (ctxLoading || !form) return <Loader full label="Loading preferences…" />;

  const save = async () => {
    setSaving(true);
    setTestResult(null);
    try {
      const payload = {
        fullName: form.fullName,
        email: form.email,
        phone: form.phone,
        linkedinUrl: form.linkedinUrl,
        portfolioUrl: form.portfolioUrl,
        location: form.location,
        targetRoles: form.targetRoles,
        targetLocations: form.targetLocations,
        minSalary: Number(form.minSalary) || 0,
        maxSalary: Number(form.maxSalary) || 999999,
        workType: form.workType,
        experienceLevel: form.experienceLevel,
        autoApplyEnabled: form.autoApplyEnabled,
        dailyApplyLimit: Number(form.dailyApplyLimit),
        minMatchScore: Number(form.minMatchScore),
        autoApplySchedule: form.autoApplySchedule,
        autoApplySources: form.autoApplySources,
        delayBetweenApplications: form.delayBetweenApplications,
        autoScrapeEnabled: form.autoScrapeEnabled,
        scrapeSchedule: form.scrapeSchedule,
        scrapeSources: form.scrapeSources,
        defaultResumeId: form.defaultResumeId ? Number(form.defaultResumeId) : null,
        generateCoverLetter: form.generateCoverLetter,
        coverLetterTone: form.coverLetterTone,
        notifyNewJobs: form.notifyNewJobs,
        notifyReminders: form.notifyReminders,
      };

      // Only send the key when the user actually typed one.
      if (apiKey.trim()) payload.openaiApiKey = apiKey.trim();

      const data = await updatePreferences(payload);
      setForm({ ...data.preferences });
      setApiKey('');
      await refresh();

      if (data.rejected?.length) toast.error(`Saved with warnings: ${data.rejected.join('; ')}`);
      else toast.success('Preferences saved');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  const testAi = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      // Save a freshly typed key first so the test uses it.
      if (apiKey.trim()) {
        await updatePreferences({ openaiApiKey: apiKey.trim() });
        await refresh();
      }
      const result = await testAiConnection();
      setTestResult({ ok: true, ...result });
      setApiKey('');
      toast.success('OpenAI connection OK');
    } catch (err) {
      setTestResult({ ok: false, message: err.message });
      toast.error(err.message);
    } finally {
      setTesting(false);
    }
  };

  const toggleIn = (key, id) =>
    set(key, form[key].includes(id) ? form[key].filter((x) => x !== id) : [...form[key], id]);

  return (
    <div className="space-y-5">
      {/* ---- header ---------------------------------------------------- */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">Preferences</h1>
          <p className="page-subtitle">Your details, job targets, automation rules and AI settings.</p>
        </div>
        <button type="button" className="btn-primary" onClick={save} disabled={saving}>
          {saving ? <Spinner size={15} /> : <Save size={15} />} Save All Preferences
        </button>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* ---- 1. personal info ------------------------------------------- */}
        <Section
          icon={<User size={16} />}
          title="Personal info"
          description="Used by the auto-apply bot to fill application forms"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="fullName">
                Full name
              </label>
              <input id="fullName" className="input" value={form.fullName} onChange={(e) => set('fullName', e.target.value)} placeholder="Jane Doe" />
            </div>
            <div>
              <label className="label" htmlFor="email">
                Email
              </label>
              <input id="email" type="email" className="input" value={form.email} onChange={(e) => set('email', e.target.value)} placeholder="jane@example.com" />
            </div>
            <div>
              <label className="label" htmlFor="phone">
                Phone
              </label>
              <input id="phone" className="input" value={form.phone} onChange={(e) => set('phone', e.target.value)} placeholder="+1 555 000 0000" />
            </div>
            <div>
              <label className="label" htmlFor="location">
                Location
              </label>
              <input id="location" className="input" value={form.location} onChange={(e) => set('location', e.target.value)} placeholder="City, Country" />
            </div>
            <div>
              <label className="label" htmlFor="linkedin">
                LinkedIn URL
              </label>
              <input id="linkedin" className="input" value={form.linkedinUrl} onChange={(e) => set('linkedinUrl', e.target.value)} placeholder="https://linkedin.com/in/you" />
            </div>
            <div>
              <label className="label" htmlFor="portfolio">
                Portfolio URL
              </label>
              <input id="portfolio" className="input" value={form.portfolioUrl} onChange={(e) => set('portfolioUrl', e.target.value)} placeholder="https://you.dev" />
            </div>
          </div>
          <p className="text-[11px] text-slate-400">
            These are stored only in your local SQLite database and typed into job application forms by the
            bot.
          </p>
        </Section>

        {/* ---- 2. job preferences ------------------------------------------- */}
        <Section icon={<Briefcase size={16} />} title="Job preferences" description="Drives scraping, matching and the recommendation queue">
          <TagInput
            label="Target roles"
            values={form.targetRoles}
            onChange={(v) => set('targetRoles', v)}
            placeholder="React Developer, +add"
            hint="The scheduled scraper searches one query per role."
          />
          <TagInput
            label="Target locations"
            values={form.targetLocations}
            onChange={(v) => set('targetLocations', v)}
            placeholder="Remote, +add"
            hint="Locations also affect the match score bonus."
          />

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="minSalary">
                Min salary
              </label>
              <input id="minSalary" type="number" min="0" className="input" value={form.minSalary} onChange={(e) => set('minSalary', e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="maxSalary">
                Max salary
              </label>
              <input id="maxSalary" type="number" min="0" className="input" value={form.maxSalary} onChange={(e) => set('maxSalary', e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="workType">
                Work type
              </label>
              <select id="workType" className="select capitalize" value={form.workType} onChange={(e) => set('workType', e.target.value)}>
                {WORK_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="level">
                Experience level
              </label>
              <select id="level" className="select capitalize" value={form.experienceLevel} onChange={(e) => set('experienceLevel', e.target.value)}>
                {LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </Section>

        {/* ---- 3. auto-apply config ----------------------------------------- */}
        <Section
          icon={<Bot size={16} />}
          title="Auto-apply config"
          description="Synced with the Auto Apply page — change it in either place"
        >
          <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2.5">
            <div>
              <p className="text-sm font-medium text-slate-700">Auto Apply enabled</p>
              <p className="text-xs text-slate-400">Let the scheduler apply on your behalf</p>
            </div>
            <Toggle checked={form.autoApplyEnabled} onChange={(v) => set('autoApplyEnabled', v)} label="Auto Apply enabled" />
          </div>

          <div>
            <label className="label" htmlFor="minMatch">
              Minimum match score: <span className="text-brand-600">{form.minMatchScore}%</span>
            </label>
            <input
              id="minMatch"
              type="range"
              min="50"
              max="100"
              step="5"
              value={form.minMatchScore}
              onChange={(e) => set('minMatchScore', e.target.value)}
              className="w-full"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="limit">
                Daily apply limit
              </label>
              <input id="limit" type="number" min="1" max="200" className="input" value={form.dailyApplyLimit} onChange={(e) => set('dailyApplyLimit', e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="delay">
                Delay between applications
              </label>
              <select id="delay" className="select" value={form.delayBetweenApplications} onChange={(e) => set('delayBetweenApplications', e.target.value)}>
                {DELAYS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="applyAt">
                Auto-apply time (daily)
              </label>
              <input
                id="applyAt"
                type="time"
                className="input"
                value={cronToTime(form.autoApplySchedule)}
                onChange={(e) => set('autoApplySchedule', timeToCron(e.target.value))}
              />
            </div>
            <div>
              <label className="label" htmlFor="scrapeAt">
                Auto-scrape time (daily)
              </label>
              <input
                id="scrapeAt"
                type="time"
                className="input"
                value={cronToTime(form.scrapeSchedule)}
                onChange={(e) => set('scrapeSchedule', timeToCron(e.target.value))}
              />
            </div>
            <div>
              <label className="label" htmlFor="defResume">
                Default resume
              </label>
              <select id="defResume" className="select" value={form.defaultResumeId || ''} onChange={(e) => set('defaultResumeId', e.target.value)}>
                <option value="">— none —</option>
                {resumes.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label} (ATS {r.atsScore})
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-end">
              <div className="flex w-full items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
                <span className="text-sm text-slate-700">Auto-scrape</span>
                <Toggle checked={form.autoScrapeEnabled} onChange={(v) => set('autoScrapeEnabled', v)} label="Auto-scrape" />
              </div>
            </div>
          </div>

          <div>
            <span className="label">Sources to scrape</span>
            <div className="flex flex-wrap gap-2">
              {APPLY_SOURCES.map((s) => (
                <label
                  key={s}
                  className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-xs capitalize ${
                    form.scrapeSources.includes(s) ? 'border-brand-300 bg-brand-50 text-slate-800' : 'border-slate-200 text-slate-500'
                  }`}
                >
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                    checked={form.scrapeSources.includes(s)}
                    onChange={() => toggleIn('scrapeSources', s)}
                  />
                  {s}
                </label>
              ))}
            </div>
          </div>

          <div>
            <span className="label">Sources to auto-apply</span>
            <div className="flex flex-wrap gap-2">
              {APPLY_SOURCES.map((s) => (
                <label
                  key={s}
                  className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-xs capitalize ${
                    form.autoApplySources.includes(s) ? 'border-brand-300 bg-brand-50 text-slate-800' : 'border-slate-200 text-slate-500'
                  }`}
                >
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                    checked={form.autoApplySources.includes(s)}
                    onChange={() => toggleIn('autoApplySources', s)}
                  />
                  {s}
                </label>
              ))}
            </div>
          </div>
        </Section>

        <div className="space-y-5">
          {/* ---- 4. notifications ------------------------------------------ */}
          <Section icon={<Bell size={16} />} title="Notifications" description="Desktop notifications plus an in-app feed">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-slate-700">New matching jobs</p>
                  <p className="text-xs text-slate-400">After a scrape finds new matches</p>
                </div>
                <Toggle checked={form.notifyNewJobs} onChange={(v) => set('notifyNewJobs', v)} label="New matching jobs" />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-slate-700">Follow-up reminders</p>
                  <p className="text-xs text-slate-400">Every morning at 08:00 for anything due</p>
                </div>
                <Toggle checked={form.notifyReminders} onChange={(v) => set('notifyReminders', v)} label="Follow-up reminders" />
              </div>
              <div className="flex items-center justify-between opacity-70">
                <div>
                  <p className="text-sm font-medium text-slate-700">CAPTCHA alerts</p>
                  <p className="text-xs text-slate-400">Always on — a CAPTCHA needs you</p>
                </div>
                <Toggle checked onChange={() => {}} label="CAPTCHA alerts (always on)" disabled />
              </div>
            </div>
            <p className="text-[11px] text-slate-400">
              On a machine without a notification daemon (Docker, headless servers) alerts are still recorded
              and can be read at <code className="rounded bg-slate-100 px-1">/api/notifications</code>.
            </p>
          </Section>

          {/* ---- 5. AI settings ------------------------------------------------ */}
          <Section
            icon={<Sparkles size={16} />}
            title="AI settings"
            description="Optional — everything works without a key using the built-in template engine"
          >
            <div>
              <label className="label" htmlFor="apiKey">
                OpenAI API key
              </label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <KeyRound size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    id="apiKey"
                    type={showKey ? 'text' : 'password'}
                    className="input pl-9 pr-16 font-mono text-xs"
                    placeholder={form.openaiApiKeySet ? 'A key is already saved — paste a new one to replace it' : 'sk-…'}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] font-medium text-slate-400 hover:text-slate-600"
                  >
                    {showKey ? 'Hide' : 'Show'}
                  </button>
                </div>
                <button type="button" className="btn-secondary" onClick={testAi} disabled={testing}>
                  {testing ? <Spinner size={14} /> : <PlugZap size={14} />} Test
                </button>
              </div>
              <p className="mt-1.5 flex items-center gap-1.5 text-[11px]">
                {form.openaiApiKeySet || form.aiConfigured ? (
                  <>
                    <CheckCircle2 size={12} className="text-green-600" />
                    <span className="text-green-700">AI enabled — model {form.aiModel}</span>
                  </>
                ) : (
                  <>
                    <XCircle size={12} className="text-slate-400" />
                    <span className="text-slate-500">
                      No key set. Cover letters use the built-in template engine.
                    </span>
                  </>
                )}
              </p>
              <p className="mt-1 text-[11px] text-slate-400">
                You can also put <code className="rounded bg-slate-100 px-1">OPENAI_API_KEY</code> in{' '}
                <code className="rounded bg-slate-100 px-1">backend/.env</code>.
              </p>
            </div>

            {testResult && (
              <div
                className={`flex items-start gap-2 rounded-lg px-3 py-2 text-xs ${
                  testResult.ok ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-700'
                }`}
              >
                {testResult.ok ? <CheckCircle2 size={14} className="mt-0.5 shrink-0" /> : <XCircle size={14} className="mt-0.5 shrink-0" />}
                <span>
                  {testResult.message}
                  {testResult.ms != null && <span className="ml-1 opacity-70">({testResult.ms} ms)</span>}
                </span>
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
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
              <div className="flex items-end">
                <div className="flex w-full items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
                  <span className="text-sm text-slate-700">Generate cover letters</span>
                  <Toggle checked={form.generateCoverLetter} onChange={(v) => set('generateCoverLetter', v)} label="Generate cover letters" />
                </div>
              </div>
            </div>
          </Section>
        </div>
      </div>

      {/* ---- sticky save bar ---------------------------------------------- */}
      <div className="sticky bottom-4 flex justify-end">
        <button type="button" className="btn-primary shadow-lg" onClick={save} disabled={saving}>
          {saving ? <Spinner size={15} /> : <Save size={15} />} Save All Preferences
        </button>
      </div>
    </div>
  );
}
