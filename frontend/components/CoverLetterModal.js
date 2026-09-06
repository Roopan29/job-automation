/**
 * components/CoverLetterModal.js
 * ------------------------------------------------------------------
 * View / edit / regenerate a cover letter for one job.
 *
 *   • loads a letter on open (AI when a key is configured, otherwise
 *     the deterministic template engine)
 *   • tone selector: professional | friendly | confident
 *   • ✨ Regenerate, 📋 Copy, and an optional onSubmit (used by the
 *     apply dialog to send the edited text with the application)
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import { X, Sparkles, Copy, Check, Send, Wand2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { generateCoverLetter } from '@/services/api';
import Loader from './Loader';

const TONES = [
  { value: 'professional', label: 'Professional' },
  { value: 'friendly', label: 'Friendly' },
  { value: 'confident', label: 'Confident' },
];

export default function CoverLetterModal({ open, job, resumes = [], initialTone = 'professional', onClose, onSubmit, submitLabel }) {
  const [text, setText] = useState('');
  const [tone, setTone] = useState(initialTone);
  const [resumeId, setResumeId] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [source, setSource] = useState('');
  const [copied, setCopied] = useState(false);

  const defaultResume = resumes.find((r) => r.isDefault) || resumes[0];

  /** (Re)generate the letter from the backend. */
  const generate = useCallback(
    async (nextTone = tone, nextResumeId = resumeId) => {
      if (!job?.id) return;
      setLoading(true);
      try {
        const data = await generateCoverLetter(job.id, {
          tone: nextTone,
          resumeId: nextResumeId || defaultResume?.id,
        });
        setText(data.coverLetter || '');
        setSource(data.source === 'ai' ? `Written by ${data.message || 'AI'}` : 'Built-in template engine');
      } catch (err) {
        toast.error(err.message);
      } finally {
        setLoading(false);
      }
    },
    [job?.id, tone, resumeId, defaultResume?.id]
  );

  // Load a letter when the modal opens, and keep state in sync.
  useEffect(() => {
    if (!open) return;
    setResumeId(defaultResume?.id || '');
    setTone(initialTone);
    setCopied(false);
    generate(initialTone, defaultResume?.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, job?.id]);

  if (!open || !job) return null;

  const changeTone = (next) => {
    setTone(next);
    generate(next, resumeId);
  };

  const changeResume = (next) => {
    setResumeId(next);
    generate(tone, next);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success('Cover letter copied');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Could not access the clipboard');
    }
  };

  const submit = async () => {
    setSubmitting(true);
    try {
      await onSubmit?.(text, { tone, resumeId });
      onClose?.();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSubmitting(false);
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
        {/* ---- header -------------------------------------------------- */}
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold text-slate-900">
              Cover letter — {job.title}
            </h3>
            <p className="mt-0.5 truncate text-xs text-slate-500">
              {job.company}
              {job.location ? ` · ${job.location}` : ''}
              {source ? ` · ${source}` : ''}
            </p>
          </div>
          <button type="button" onClick={() => !submitting && onClose?.()} className="text-slate-400 hover:text-slate-600" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {/* ---- controls ------------------------------------------------- */}
        <div className="flex flex-wrap items-end gap-3 border-b border-slate-100 bg-slate-50 px-5 py-3">
          <div>
            <label className="label" htmlFor="cl-tone">
              Tone
            </label>
            <select id="cl-tone" className="select" value={tone} onChange={(e) => changeTone(e.target.value)} disabled={loading}>
              {TONES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>

          {resumes.length > 0 && (
            <div className="min-w-[180px] flex-1">
              <label className="label" htmlFor="cl-resume">
                Resume
              </label>
              <select
                id="cl-resume"
                className="select"
                value={resumeId}
                onChange={(e) => changeResume(e.target.value)}
                disabled={loading}
              >
                {resumes.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                    {r.isDefault ? ' (default)' : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          <button type="button" className="btn-secondary btn-sm" onClick={() => generate()} disabled={loading}>
            {loading ? <Wand2 size={13} className="animate-pulse" /> : <Sparkles size={13} />}
            Regenerate
          </button>
        </div>

        {/* ---- letter ---------------------------------------------------- */}
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {loading && !text ? (
            <Loader full label="Writing your cover letter…" />
          ) : (
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="h-[340px] w-full resize-none rounded-lg border border-slate-200 bg-white p-4 font-serif text-[13.5px] leading-relaxed text-slate-800 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
              placeholder="Your cover letter will appear here…"
              spellCheck
            />
          )}
          <p className="mt-2 text-right text-[11px] text-slate-400">{text.trim().split(/\s+/).filter(Boolean).length} words</p>
        </div>

        {/* ---- footer ----------------------------------------------------- */}
        <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-5 py-3">
          <button type="button" className="btn-ghost btn-sm" onClick={copy} disabled={!text}>
            {copied ? <Check size={13} className="text-green-600" /> : <Copy size={13} />}
            {copied ? 'Copied' : 'Copy'}
          </button>

          <div className="flex gap-2">
            <button type="button" className="btn-secondary" onClick={onClose} disabled={submitting}>
              Close
            </button>
            {onSubmit && (
              <button type="button" className="btn-primary" onClick={submit} disabled={submitting || loading || !text.trim()}>
                <Send size={14} />
                {submitLabel || 'Use this letter'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
