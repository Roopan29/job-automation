/**
 * components/ApplicationRow.js
 * ------------------------------------------------------------------
 * One row of the tracker table.
 *
 *   • company + role + match score
 *   • status: click the badge to open an inline dropdown (writes to
 *     status_history on the backend)
 *   • follow-up date: native date input, saved on change
 *   • applied via: 🤖 auto / 👤 manual
 *   • [📝 Notes] [📧 Follow-up Email] [🗑️ Delete]
 */

'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, StickyNote, Mail, Trash2, Bot, User, ExternalLink } from 'lucide-react';
import toast from 'react-hot-toast';
import { updateApplicationStatus, updateApplicationDates } from '@/services/api';
import StatusBadge, { STATUS_META, STATUS_KEYS } from './StatusBadge';
import MatchScoreBadge from './MatchScoreBadge';
import { Spinner } from './Loader';

export default function ApplicationRow({ application, onChanged, onNotes, onFollowUpEmail, onDelete }) {
  const [statusOpen, setStatusOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [followUp, setFollowUp] = useState(application.followUpDate || '');
  const dropdownRef = useRef(null);

  // Close the status dropdown on an outside click or Escape.
  useEffect(() => {
    if (!statusOpen) return undefined;
    const onDown = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) setStatusOpen(false);
    };
    const onKey = (e) => e.key === 'Escape' && setStatusOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [statusOpen]);

  // Keep the local date in sync when the row is refetched.
  useEffect(() => setFollowUp(application.followUpDate || ''), [application.followUpDate]);

  const changeStatus = async (next) => {
    setStatusOpen(false);
    if (next === application.status) return;
    setBusy(true);
    try {
      await updateApplicationStatus(application.id, next);
      toast.success(`${application.job?.company || 'Application'} → ${STATUS_META[next].label}`);
      onChanged?.();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const saveFollowUp = async (value) => {
    setFollowUp(value);
    try {
      await updateApplicationDates(application.id, { follow_up_date: value });
      toast.success(value ? `Follow-up set for ${value}` : 'Follow-up cleared');
      onChanged?.();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const job = application.job || {};

  return (
    <tr>
      {/* ---- company ------------------------------------------------- */}
      <td>
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-slate-100 text-[11px] font-bold text-slate-500">
            {(job.company || '?').slice(0, 2).toUpperCase()}
          </span>
          <div className="min-w-0">
            <p className="truncate font-medium text-slate-800">{job.company || 'Unknown'}</p>
            {job.location && <p className="truncate text-xs text-slate-400">{job.location}</p>}
          </div>
        </div>
      </td>

      {/* ---- role ---------------------------------------------------- */}
      <td>
        <p className="max-w-[220px] truncate text-slate-700" title={job.title}>
          {job.title || '—'}
        </p>
        {job.sourceUrl && (
          <a
            href={job.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[11px] text-brand-600 hover:underline"
          >
            {job.source} <ExternalLink size={10} />
          </a>
        )}
      </td>

      {/* ---- match --------------------------------------------------- */}
      <td>{job.matchScore != null ? <MatchScoreBadge score={job.matchScore} size="sm" showDot={false} /> : '—'}</td>

      {/* ---- status -------------------------------------------------- */}
      <td>
        <div className="relative" ref={dropdownRef}>
          <button
            type="button"
            onClick={() => setStatusOpen((v) => !v)}
            className="inline-flex items-center gap-1 rounded-full ring-1 ring-inset ring-slate-200 transition-colors hover:ring-slate-300"
            aria-haspopup="listbox"
            aria-expanded={statusOpen}
            aria-label={`Change status (currently ${STATUS_META[application.status]?.label || application.status})`}
          >
            <StatusBadge status={application.status} size="sm" />
            <ChevronDown size={12} className="mr-1 text-slate-400" />
          </button>

          {statusOpen && (
            <ul
              className="absolute left-0 top-full z-20 mt-1 w-40 animate-fade-in overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-lg"
              role="listbox"
            >
              {STATUS_KEYS.map((key) => (
                <li key={key}>
                  <button
                    type="button"
                    onClick={() => changeStatus(key)}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-slate-50 ${
                      key === application.status ? 'font-semibold text-slate-900' : 'text-slate-600'
                    }`}
                    role="option"
                    aria-selected={key === application.status}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${STATUS_META[key].dot}`} />
                    {STATUS_META[key].label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </td>

      {/* ---- applied date --------------------------------------------- */}
      <td className="whitespace-nowrap text-slate-600">
        {application.appliedAt ? new Date(application.appliedAt).toLocaleDateString() : '—'}
      </td>

      {/* ---- follow-up ------------------------------------------------- */}
      <td>
        <input
          type="date"
          value={followUp}
          onChange={(e) => saveFollowUp(e.target.value)}
          className="w-[130px] rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-700 focus:border-brand-500 focus:outline-none"
          aria-label="Follow-up date"
        />
      </td>

      {/* ---- method ----------------------------------------------------- */}
      <td>
        <span
          className={`pill ring-1 ring-inset ${
            application.appliedMethod === 'auto'
              ? 'bg-purple-50 text-purple-700 ring-purple-200'
              : 'bg-slate-100 text-slate-600 ring-slate-200'
          }`}
          title={application.appliedMethod === 'auto' ? 'Applied by the bot' : 'Tracked manually'}
        >
          {application.appliedMethod === 'auto' ? <Bot size={11} /> : <User size={11} />}
          {application.appliedMethod === 'auto' ? 'Auto' : 'Manual'}
        </span>
      </td>

      {/* ---- actions ----------------------------------------------------- */}
      <td>
        <div className="flex items-center justify-end gap-1">
          {busy && <Spinner size={13} className="text-slate-400" />}
          <button
            type="button"
            onClick={() => onNotes?.(application)}
            className="btn-ghost btn-sm"
            title={application.notes ? 'View / edit notes' : 'Add notes'}
          >
            <StickyNote size={14} />
          </button>
          <button type="button" onClick={() => onFollowUpEmail?.(application)} className="btn-ghost btn-sm" title="Draft a follow-up email">
            <Mail size={14} />
          </button>
          <button
            type="button"
            onClick={() => onDelete?.(application)}
            className="btn-ghost btn-sm text-red-500 hover:bg-red-50 hover:text-red-700"
            title="Delete application"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </td>
    </tr>
  );
}
