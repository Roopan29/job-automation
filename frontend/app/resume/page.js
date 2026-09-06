/**
 * app/resume/page.js — My Resumes
 * ------------------------------------------------------------------
 * TOP     drag-and-drop uploader (PDF/DOCX, 5 MB) with progress + preview
 * LIST    one card per resume: label, default badge, ATS meter, skills,
 *         and [Set Default] [ATS Details] [Suggestions] [Delete]
 *
 * Everything below the uploader comes from GET /api/resume/all; any
 * mutation calls refresh() so the sidebar footer updates too.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import { FileText, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import { getAllResumes } from '@/services/api';
import { useApp } from '@/context/AppContext';
import ResumeUploader from '@/components/ResumeUploader';
import ResumeCard from '@/components/ResumeCard';
import Loader, { Skeleton } from '@/components/Loader';

export default function ResumePage() {
  const { refresh } = useApp();
  const [resumes, setResumes] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getAllResumes();
      setResumes(data.resumes || []);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /** Reload the list + global state after any change. */
  const onChanged = async () => {
    await load();
    await refresh();
  };

  const defaultCount = resumes.filter((r) => r.isDefault).length;
  const avgScore = resumes.length
    ? Math.round(resumes.reduce((sum, r) => sum + (r.atsScore || 0), 0) / resumes.length)
    : 0;

  return (
    <div className="space-y-6">
      {/* ---- header ---------------------------------------------------- */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">My Resumes</h1>
          <p className="page-subtitle">
            Upload a PDF or DOCX. JobBot extracts your skills, experience and education, then scores how
            ATS-friendly the file is.
          </p>
        </div>
        <button type="button" className="btn-secondary" onClick={load} disabled={loading}>
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {/* ---- uploader --------------------------------------------------- */}
      <section className="card">
        <div className="card-header">
          <h2 className="card-title">Upload a resume</h2>
          <span className="text-xs text-slate-400">PDF or DOCX · max 5 MB</span>
        </div>
        <div className="card-body">
          <ResumeUploader onUploaded={onChanged} />
        </div>
      </section>

      {/* ---- list -------------------------------------------------------- */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">
            Your resumes {resumes.length > 0 && <span className="font-normal text-slate-400">({resumes.length})</span>}
          </h2>
          {resumes.length > 0 && (
            <p className="text-xs text-slate-400">
              Average ATS score {avgScore}
              {defaultCount === 0 && <span className="ml-2 text-yellow-600">· no default set</span>}
            </p>
          )}
        </div>

        {loading ? (
          <div className="grid gap-4 md:grid-cols-2">
            {[0, 1].map((i) => (
              <div key={i} className="card p-5">
                <Skeleton rows={5} />
              </div>
            ))}
          </div>
        ) : resumes.length === 0 ? (
          <div className="card">
            <div className="empty-state">
              <FileText size={26} className="text-slate-300" />
              <p className="font-medium text-slate-600">No resumes yet</p>
              <p className="max-w-sm">
                Drop your resume above. Until you do, job match scores stay at 0% and cover letters have
                nothing to work with.
              </p>
            </div>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {resumes.map((resume) => (
              <ResumeCard key={resume.id} resume={resume} onChanged={onChanged} />
            ))}
          </div>
        )}
      </section>

      {/* ---- explainer ---------------------------------------------------- */}
      <section className="card">
        <div className="card-header">
          <h2 className="card-title">How the ATS score works</h2>
        </div>
        <div className="card-body grid gap-4 text-sm text-slate-600 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="mb-1 font-semibold text-slate-800">Content · 60 pts</p>
            <p className="text-xs leading-relaxed">
              Contact info (10), professional summary (10), skills section (20), work experience (20) and
              education (10).
            </p>
          </div>
          <div>
            <p className="mb-1 font-semibold text-slate-800">Formatting · 10 pts</p>
            <p className="text-xs leading-relaxed">
              Single-column layout, no tables or graphics. Two-column PDFs lose their structure when a
              parser reads them.
            </p>
          </div>
          <div>
            <p className="mb-1 font-semibold text-slate-800">Action verbs · 10 pts</p>
            <p className="text-xs leading-relaxed">
              Bullets should open with Built, Led, Shipped, Optimized — not &ldquo;Responsible for&rdquo;.
            </p>
          </div>
          <div>
            <p className="mb-1 font-semibold text-slate-800">Length · 10 pts</p>
            <p className="text-xs leading-relaxed">
              400–800 words is the sweet spot. Under 150 usually means a scanned image the parser could not
              read.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
