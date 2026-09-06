/**
 * components/Sidebar.js
 * ------------------------------------------------------------------
 * Fixed 240px dark-navy navigation rail.
 *
 *   • App name + bot emoji at the top
 *   • Six nav links with lucide icons, active item highlighted
 *   • A notification bell polling the backend alert feed
 *   • Footer shows the default resume name + its ATS score
 *   • A red dot appears when the backend cannot be reached
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  FileText,
  Search,
  Bot,
  ClipboardList,
  Settings,
  WifiOff,
  Bell,
  Trash2,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { getNotifications, clearNotifications } from '@/services/api';
import { useApp } from '@/context/AppContext';

/** How often the bell re-reads the backend alert feed. */
const POLL_MS = 15000;

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

/** Dot colour per notification level. */
function levelDot(level) {
  if (level === 'error') return 'bg-red-400';
  if (level === 'warning') return 'bg-yellow-400';
  if (level === 'success') return 'bg-green-400';
  return 'bg-slate-400';
}

/** Relative "5m ago" label for a notification timestamp. */
function timeAgo(iso) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString();
}

export default function Sidebar() {
  const pathname = usePathname();
  const { defaultResume, backendOnline } = useApp();

  // ---- notification feed -------------------------------------------------
  // A headless machine has no notification daemon, so the feed the backend
  // keeps in memory is the only durable record of scrape / CAPTCHA /
  // follow-up events. Poll it so nothing is missed while the tab is open.
  const [alerts, setAlerts] = useState([]);
  const [alertTotal, setAlertTotal] = useState(0);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [seenIds, setSeenIds] = useState(() => new Set());
  const [clearing, setClearing] = useState(false);
  const panelRef = useRef(null);

  const loadAlerts = useCallback(async () => {
    try {
      const data = await getNotifications(30);
      setAlerts(data.notifications || []);
      setAlertTotal(data.total || 0);
    } catch {
      // Silent: the offline banner already tells the user the API is down.
    }
  }, []);

  useEffect(() => {
    loadAlerts();
    const timer = setInterval(loadAlerts, POLL_MS);
    return () => clearInterval(timer);
  }, [loadAlerts]);

  // Close the dropdown on an outside click.
  useEffect(() => {
    if (!alertsOpen) return undefined;
    const onDocClick = (event) => {
      if (panelRef.current && !panelRef.current.contains(event.target)) setAlertsOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [alertsOpen]);

  const unread = alerts.filter((a) => !seenIds.has(a.id)).length;

  const openAlerts = () => {
    const next = !alertsOpen;
    setAlertsOpen(next);
    if (next) {
      setSeenIds(new Set(alerts.map((a) => a.id)));
      loadAlerts();
    }
  };

  const doClear = async () => {
    setClearing(true);
    try {
      await clearNotifications();
      setAlerts([]);
      setAlertTotal(0);
      setSeenIds(new Set());
      toast.success('Notifications cleared');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setClearing(false);
    }
  };

  return (
    <aside className="fixed inset-y-0 left-0 z-40 flex w-60 flex-col bg-navy text-slate-300">
      {/* ---- brand ---------------------------------------------------- */}
      <div className="flex items-center gap-2 px-5 py-5">
        <span className="text-2xl" aria-hidden="true">
          🤖
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-base font-bold text-white">JobBot</p>
          <p className="text-[11px] text-slate-400">Personal job automation</p>
        </div>

        {/* ---- notification bell ---------------------------------------- */}
        <div className="relative" ref={panelRef}>
          <button
            type="button"
            onClick={openAlerts}
            aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
            aria-expanded={alertsOpen}
            className="relative rounded-lg p-2 text-slate-400 transition-colors hover:bg-navy-700 hover:text-white"
          >
            <Bell size={16} />
            {unread > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-bold text-white">
                {unread > 9 ? '9+' : unread}
              </span>
            )}
          </button>

          {alertsOpen && (
            <div
              className="absolute left-0 top-11 z-50 w-80 rounded-xl border border-white/10 bg-navy-700 shadow-2xl"
              data-testid="notification-panel"
            >
              <div className="flex items-center justify-between border-b border-white/10 px-3 py-2.5">
                <p className="text-xs font-semibold text-white">
                  Notifications
                  {alertTotal > 0 && <span className="ml-1.5 text-slate-400">({alertTotal})</span>}
                </p>
                <button
                  type="button"
                  onClick={doClear}
                  disabled={clearing || alerts.length === 0}
                  className="flex items-center gap-1 text-[11px] text-slate-400 transition-colors hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Trash2 size={12} /> Clear
                </button>
              </div>

              <div className="max-h-80 overflow-y-auto">
                {alerts.length === 0 ? (
                  <p className="px-3 py-6 text-center text-[11px] text-slate-500">
                    Nothing yet. Scrapes, CAPTCHA prompts and follow-up reminders show up here.
                  </p>
                ) : (
                  <ul className="divide-y divide-white/5">
                    {alerts.map((a) => (
                      <li key={a.id} className="flex gap-2.5 px-3 py-2.5">
                        <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${levelDot(a.level)}`} />
                        <div className="min-w-0">
                          <p className="text-xs font-medium text-white">{a.title}</p>
                          <p className="mt-0.5 break-words text-[11px] leading-snug text-slate-400">{a.message}</p>
                          <p className="mt-1 text-[10px] text-slate-500">{timeAgo(a.at)}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
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
