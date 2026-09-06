/**
 * components/ResumeCard.js
 * ------------------------------------------------------------------
 * One resume in the "My Resumes" list.
 *
 *   • file-type icon + inline-editable label
 *   • ⭐ Default badge
 *   • ATS meter: red < 50, yellow 50–75, green > 75
 *   • parsed skills (first 8 + overflow)
 *   • [Set Default] [ATS Details] [Suggestions] [Delete]
 *
 * The two modals (ATS breakdown, AI suggestions) are owned here so the
 * page component stays small.
 */

'use client';

import { useState } from 'react';
import { FileText, FileType2, Star, BarChart3, Lightbulb, Trash2, Pencil, Check, X, Sparkles } from 'lucide-react';
import toast from 'react-hot-toast';
import { getAtsScore, getResumeSuggestions, renameResume, setDefaultResume, deleteResume } from '@/services/api';
import { SkillList } from './SkillTag';
import Loader, { Spinner } from './Loader';
import ConfirmModal from './ConfirmModal';

/** Meter colour + label for an ATS score. */
export function atsTier(score) {
  if (score >= 75) return { color: 'bg-green-500', text: 'text-green-700', label: 'Strong' };
  if (score >= 50) return { color: 'bg-yellow-500', text: 'text-yellow-700', label: 'Needs work' };
  return { color: 'bg-red-500', text: 'text-red-700', label: 'Weak' };
}

/** Generic modal shell used by the ATS + suggestions dialogs. */
function Modal({ title, subtitle, onClose, children, wide = false }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm"
      onMouseDown={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className={`max-h-[85vh] w-full ${wide ? 'max-w-2xl' : 'max-w-lg'} animate-slide-up overflow-y-auto rounded-xl bg-white shadow-xl`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-start justify-between gap-3 border-b border-slate-100 bg-white px-5 py-4">
          <div>
            <h3 className="text-base font-semibold text-slate-900">{title}</h3>
            {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600" aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export default function ResumeCard({ resume, onChanged }) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(resume.label);
  const [busy, setBusy] = useState('');

  const [atsOpen, setAtsOpen] = useState(false);
  const [atsData, setAtsData] = useState(null);
  const [atsLoading, setAtsLoading] = useState(false);

  const [sugOpen, setSugOpen] = useState(false);
  const [sugData, setSugData] = useState(null);
  const [sugLoading, setSugLoading] = useState(false);

  const [confirmDelete, setConfirmDelete] = useState(false);

  const tier = atsTier(resume.atsScore);
  const Icon = resume.fileType === 'docx' ? FileType2 : FileText;

  /* ---- inline label editing ---------------------------------------- */
  const saveLabel = async () => {
    const next = label.trim();
    if (!next || next === resume.label) {
      setLabel(resume.label);
      setEditing(false);
      return;
    }
    try {
      await renameResume(resume.id, next);
      toast.success('Renamed');
      onChanged?.();
    } catch (err) {
      toast.error(err.message);
      setLabel(resume.label);
    } finally {
      setEditing(false);
    }
  };

  /* ---- actions ------------------------------------------------------ */
  const makeDefault = async () => {
    setBusy('default');
    try {
      await setDefaultResume(resume.id);
      toast.success(`"${resume.label}" is now your default resume`);
      onChanged?.();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy('');
    }
  };

  const openAts = async () => {
    setAtsOpen(true);
    setAtsLoading(true);
    try {
      setAtsData(await getAtsScore(resume.id));
    } catch (err) {
      toast.error(err.message);
      setAtsOpen(false);
    } finally {
      setAtsLoading(false);
    }
  };

  const openSuggestions = async () => {
    setSugOpen(true);
    setSugLoading(true);
    try {
      setSugData(await getResumeSuggestions(resume.id));
    } catch (err) {
      toast.error(err.message);
      setSugOpen(false);
    } finally {
      setSugLoading(false);
    }
  };

  const remove = async () => {
    try {
      await deleteResume(resume.id);
      toast.success(`Deleted "${resume.label}"`);
      onChanged?.();
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <div className="card animate-fade-in">
      <div className="p-5">
        {/* ---- header ------------------------------------------------- */}
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-red-50 text-red-500">
            <Icon size={22} />
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {editing ? (
                <div className="flex items-center gap-1">
                  <input
                    autoFocus
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveLabel();
                      if (e.key === 'Escape') {
                        setLabel(resume.label);
                        setEditing(false);
                      }
                    }}
                    className="input py-1 text-sm"
                    maxLength={80}
                    aria-label="Resume label"
                  />
                  <button type="button" onClick={saveLabel} className="btn-ghost btn-sm" aria-label="Save label">
                    <Check size={15} />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setLabel(resume.label);
                      setEditing(false);
                    }}
                    className="btn-ghost btn-sm"
                    aria-label="Cancel"
                  >
                    <X size={15} />
                  </button>
                </div>
              ) : (
                <>
                  <h3 className="truncate text-sm font-semibold text-slate-900">{resume.label}</h3>
                  <button
                    type="button"
                    onClick={() => setEditing(true)}
                    className="text-slate-400 hover:text-brand-600"
                    aria-label="Rename resume"
                  >
                    <Pencil size={13} />
                  </button>
                </>
              )}

              {resume.isDefault && (
                <span className="pill bg-yellow-50 text-yellow-700 ring-1 ring-inset ring-yellow-200">
                  <Star size={11} fill="currentColor" /> Default
                </span>
              )}
            </div>

            <p className="mt-0.5 truncate text-xs text-slate-400">
              {resume.originalName} · uploaded {new Date(resume.uploadedAt).toLocaleDateString()}
            </p>
          </div>

          {/* ATS meter */}
          <div className="w-28 shrink-0 text-right">
            <p className={`text-2xl font-bold ${tier.text}`}>{resume.atsScore}</p>
            <p className="text-[11px] text-slate-400">ATS · {tier.label}</p>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100">
              <div className={`h-full rounded-full ${tier.color}`} style={{ width: `${Math.min(100, resume.atsScore)}%` }} />
            </div>
          </div>
        </div>

        {/* ---- skills ------------------------------------------------- */}
        <div className="mt-4">
          <p className="label">Parsed skills ({resume.skills.length})</p>
          <SkillList skills={resume.skills} max={8} variant="neutral" />
        </div>

        {/* ---- quick facts --------------------------------------------- */}
        <div className="mt-4 grid grid-cols-3 gap-2 rounded-lg bg-slate-50 p-3 text-center">
          <div>
            <p className="text-sm font-semibold text-slate-800">{resume.experience.length}</p>
            <p className="text-[11px] text-slate-500">Roles</p>
          </div>
          <div>
            <p className="text-sm font-semibold text-slate-800">{resume.education.length}</p>
            <p className="text-[11px] text-slate-500">Degrees</p>
          </div>
          <div>
            <p className="text-sm font-semibold text-slate-800">{resume.wordCount || '—'}</p>
            <p className="text-[11px] text-slate-500">Words</p>
          </div>
        </div>

        {/* ---- actions -------------------------------------------------- */}
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className="btn-secondary btn-sm" onClick={makeDefault} disabled={resume.isDefault || busy === 'default'}>
            {busy === 'default' ? <Spinner size={13} /> : <Star size={13} />}
            Set Default
          </button>
          <button type="button" className="btn-secondary btn-sm" onClick={openAts}>
            <BarChart3 size={13} /> ATS Details
          </button>
          <button type="button" className="btn-secondary btn-sm" onClick={openSuggestions}>
            <Lightbulb size={13} /> Suggestions
          </button>
          <button type="button" className="btn-ghost btn-sm text-red-600 hover:bg-red-50" onClick={() => setConfirmDelete(true)}>
            <Trash2 size={13} /> Delete
          </button>
        </div>
      </div>

      {/* ---- ATS details modal ------------------------------------------ */}
      {atsOpen && (
        <Modal title="ATS score breakdown" subtitle={`${resume.label} — recalculated just now`} onClose={() => setAtsOpen(false)} wide>
          {atsLoading ? (
            <Loader full label="Scoring your resume…" />
          ) : (
            atsData && (
              <div>
                <div className="mb-4 flex items-end gap-3 rounded-lg bg-slate-50 p-4">
                  <p className="text-4xl font-bold text-slate-900">{atsData.score}</p>
                  <div className="pb-1">
                    <p className="text-sm font-semibold text-slate-700">out of 100 · grade {atsData.grade}</p>
                    <p className="text-xs text-slate-500">{atsData.wordCount} words</p>
                  </div>
                </div>

                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                      <th className="py-2">Category</th>
                      <th className="py-2 text-right">Score</th>
                      <th className="py-2 pl-4">Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(atsData.breakdown).map(([key, b]) => (
                      <tr key={key} className="border-b border-slate-100 align-top">
                        <td className="py-2.5 font-medium text-slate-700">{b.label}</td>
                        <td className="py-2.5 text-right">
                          <span
                            className={`font-semibold ${
                              b.score === b.max ? 'text-green-600' : b.score >= b.max * 0.5 ? 'text-yellow-600' : 'text-red-600'
                            }`}
                          >
                            {b.score}/{b.max}
                          </span>
                        </td>
                        <td className="py-2.5 pl-4 text-xs text-slate-500">
                          <ul className="space-y-0.5">
                            {b.details.map((d, i) => (
                              <li key={i}>• {d}</li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <div className="mt-4 rounded-lg border border-brand-100 bg-brand-50 p-4">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-brand-700">Tips for improvement</p>
                  <ul className="space-y-1 text-sm text-slate-700">
                    {atsData.tips.map((tip, i) => (
                      <li key={i} className="flex gap-2">
                        <span className="text-brand-500">•</span>
                        {tip}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )
          )}
        </Modal>
      )}

      {/* ---- suggestions modal ------------------------------------------- */}
      {sugOpen && (
        <Modal title="AI improvement suggestions" subtitle={resume.label} onClose={() => setSugOpen(false)}>
          {sugLoading ? (
            <Loader full label="Asking the AI for suggestions…" />
          ) : (
            sugData && (
              <div>
                <div className="mb-3 flex items-center gap-2 text-xs text-slate-500">
                  <Sparkles size={13} className="text-brand-500" />
                  {sugData.message}
                </div>
                <ul className="space-y-2">
                  {sugData.suggestions.map((s, i) => (
                    <li key={i} className="flex gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
                      <span className="font-semibold text-brand-500">{i + 1}.</span>
                      {s}
                    </li>
                  ))}
                </ul>
              </div>
            )
          )}
        </Modal>
      )}

      <ConfirmModal
        open={confirmDelete}
        title={`Delete "${resume.label}"?`}
        message="The resume file is removed from disk. Applications that used it keep their history."
        confirmLabel="Delete resume"
        danger
        onConfirm={remove}
        onClose={() => setConfirmDelete(false)}
      />
    </div>
  );
}
