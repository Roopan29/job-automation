/**
 * components/Sidebar.js
 * ------------------------------------------------------------------
 * Fixed 240px dark-navy navigation rail.
 *
 *   • App name + bot emoji at the top
 *   • Six nav links with lucide icons, active item highlighted
 *   • Footer shows the default resume name + its ATS score
 *   • A red dot appears when the backend cannot be reached
 */

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, FileText, Search, Bot, ClipboardList, Settings, WifiOff } from 'lucide-react';
import { useApp } from '@/context/AppContext';

const NAV = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/resume', label: 'My Resumes', icon: FileText },
  { href: '/search', label: 'Job Search', icon: Search },
  { href: '/auto-apply', label: 'Auto Apply', icon: Bot },
  { href: '/tracker', label: 'Tracker', icon: ClipboardList },
  { href: '/preferences', label: 'Preferences', icon: Settings },
];

/** Red / yellow / green class for the ATS meter. */
function atsColor(score) {
  if (score >= 75) return 'bg-green-500';
  if (score >= 50) return 'bg-yellow-500';
  return 'bg-red-500';
}

export default function Sidebar() {
  const pathname = usePathname();
  const { defaultResume, backendOnline } = useApp();

  return (
    <aside className="fixed inset-y-0 left-0 z-40 flex w-60 flex-col bg-navy text-slate-300">
      {/* ---- brand ---------------------------------------------------- */}
      <div className="flex items-center gap-2 px-5 py-5">
        <span className="text-2xl" aria-hidden="true">
          🤖
        </span>
        <div>
          <p className="text-base font-bold text-white">JobBot</p>
          <p className="text-[11px] text-slate-400">Personal job automation</p>
        </div>
      </div>

      {/* ---- backend health ------------------------------------------- */}
      {!backendOnline && (
        <div className="mx-4 mb-2 flex items-start gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-[11px] text-red-200 ring-1 ring-inset ring-red-500/30">
          <WifiOff size={14} className="mt-0.5 shrink-0" />
          <span>Backend offline. Run `node app.js` in the backend folder.</span>
        </div>
      )}

      {/* ---- nav ------------------------------------------------------ */}
      <nav className="flex-1 space-y-1 px-3 py-2">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                active ? 'bg-brand-600 text-white' : 'text-slate-300 hover:bg-navy-700 hover:text-white'
              }`}
              aria-current={active ? 'page' : undefined}
            >
              <Icon size={17} className="shrink-0" />
              {label}
            </Link>
          );
        })}
      </nav>

      {/* ---- default resume footer ------------------------------------- */}
      <div className="border-t border-white/10 p-4">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Default resume</p>

        {defaultResume ? (
          <div>
            <div className="flex items-center justify-between gap-2">
              <p className="truncate text-sm font-medium text-white" title={defaultResume.label}>
                {defaultResume.label}
              </p>
              <span className="shrink-0 text-xs font-semibold text-slate-300">{defaultResume.atsScore}</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
              <div
                className={`h-full rounded-full transition-all ${atsColor(defaultResume.atsScore)}`}
                style={{ width: `${Math.min(100, defaultResume.atsScore)}%` }}
              />
            </div>
            <p className="mt-1.5 text-[11px] text-slate-400">
              ATS score {defaultResume.atsScore}/100 · {defaultResume.skills?.length || 0} skills
            </p>
          </div>
        ) : (
          <Link href="/resume" className="text-xs text-brand-100 underline decoration-dotted hover:text-white">
            Upload a resume to get started →
          </Link>
        )}
      </div>
    </aside>
  );
}
