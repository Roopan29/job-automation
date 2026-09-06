/**
 * components/ResumeUploader.js
 * ------------------------------------------------------------------
 * Drag-and-drop resume upload (react-dropzone).
 *
 *   • accepts .pdf / .docx only, 5 MB max (mirrors the multer limits)
 *   • validates client-side so obvious mistakes never hit the server
 *   • shows a progress bar while the file is in flight
 *   • on success shows the parsed preview (skills, ATS score, roles)
 *
 * The parent supplies `onUploaded(resume, ats)` and refreshes its list.
 */

'use client';

import { useCallback, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { UploadCloud, FileText, FileType2, X, Sparkles } from 'lucide-react';
import toast from 'react-hot-toast';
import { uploadResume } from '@/services/api';
import { SkillList } from './SkillTag';

const MAX_SIZE_MB = 5;
const MAX_SIZE_BYTES = MAX_SIZE_MB * 1024 * 1024;

export default function ResumeUploader({ onUploaded }) {
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState(null); // { resume, ats }
  const [rejected, setRejected] = useState('');

  const onDrop = useCallback(
    async (accepted, rejectedFiles) => {
      setRejected('');
      setResult(null);

      if (rejectedFiles?.length) {
        const reason = rejectedFiles[0].errors?.[0];
        const message =
          reason?.code === 'file-too-large'
            ? `That file is larger than ${MAX_SIZE_MB} MB.`
            : reason?.code === 'file-invalid-type'
              ? 'Only PDF and DOCX resumes are supported.'
              : reason?.message || 'That file was rejected.';
        setRejected(message);
        toast.error(message);
        return;
      }

      const file = accepted[0];
      if (!file) return;

      setUploading(true);
      setProgress(0);

      try {
        const data = await uploadResume(
          file,
          (percent) => setProgress(percent),
          file.name.replace(/\.(pdf|docx)$/i, '')
        );
        setResult(data);
        toast.success(`Resume parsed — ATS score ${data.ats.score}/100`);
        onUploaded?.(data.resume, data.ats);
      } catch (err) {
        setRejected(err.message);
        toast.error(err.message);
      } finally {
        setUploading(false);
      }
    },
    [onUploaded]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'application/pdf': ['.pdf'],
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
    },
    maxSize: MAX_SIZE_BYTES,
    multiple: false,
    disabled: uploading,
  });

  return (
    <div className="space-y-4">
      {/* ---- dropzone -------------------------------------------------- */}
      <div
        {...getRootProps()}
        className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
          isDragActive
            ? 'border-brand-500 bg-brand-50'
            : uploading
              ? 'border-slate-200 bg-slate-50'
              : 'border-slate-300 bg-white hover:border-brand-500 hover:bg-slate-50'
        }`}
      >
        <input {...getInputProps()} />

        {uploading ? (
          <>
            <FileText size={32} className="text-brand-500" />
            <p className="text-sm font-medium text-slate-700">Uploading and parsing…</p>
            <div className="mt-2 h-2 w-64 overflow-hidden rounded-full bg-slate-200">
              <div className="h-full rounded-full bg-brand-600 transition-all" style={{ width: `${progress}%` }} />
            </div>
            <p className="text-xs text-slate-400">{progress}% uploaded</p>
          </>
        ) : (
          <>
            <UploadCloud size={32} className={isDragActive ? 'text-brand-600' : 'text-slate-400'} />
            <p className="text-sm font-medium text-slate-700">
              {isDragActive ? 'Drop your resume here' : 'Drag & drop your resume, or click to browse'}
            </p>
            <p className="flex items-center gap-3 text-xs text-slate-400">
              <span className="inline-flex items-center gap-1">
                <FileText size={12} /> PDF
              </span>
              <span className="inline-flex items-center gap-1">
                <FileType2 size={12} /> DOCX
              </span>
              <span>Max {MAX_SIZE_MB} MB</span>
            </p>
          </>
        )}
      </div>

      {/* ---- rejection message ------------------------------------------ */}
      {rejected && (
        <div className="flex items-start justify-between gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          <span>{rejected}</span>
          <button type="button" onClick={() => setRejected('')} className="text-red-400 hover:text-red-600" aria-label="Dismiss">
            <X size={15} />
          </button>
        </div>
      )}

      {/* ---- parsed preview --------------------------------------------- */}
      {result && !uploading && (
        <div className="animate-fade-in rounded-xl border border-green-200 bg-green-50/60 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Sparkles size={16} className="text-green-600" />
              <p className="text-sm font-semibold text-green-900">
                Parsed &ldquo;{result.resume.label}&rdquo; — ATS {result.ats.score}/100 ({result.ats.grade})
              </p>
            </div>
            <button type="button" onClick={() => setResult(null)} className="text-green-600 hover:text-green-800" aria-label="Hide preview">
              <X size={15} />
            </button>
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <div>
              <p className="label">Skills found</p>
              <p className="text-lg font-semibold text-slate-800">{result.resume.skills.length}</p>
            </div>
            <div>
              <p className="label">Roles detected</p>
              <p className="text-lg font-semibold text-slate-800">{result.resume.experience.length}</p>
            </div>
            <div>
              <p className="label">Degrees</p>
              <p className="text-lg font-semibold text-slate-800">{result.resume.education.length}</p>
            </div>
          </div>

          <div className="mt-3">
            <p className="label">Top skills</p>
            <SkillList skills={result.resume.skills} max={12} variant="matched" />
          </div>

          {result.ats.tips?.length > 0 && (
            <div className="mt-3">
              <p className="label">First improvement tip</p>
              <p className="text-xs text-slate-600">{result.ats.tips[0]}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
