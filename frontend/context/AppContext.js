/**
 * frontend/context/AppContext.js
 * ------------------------------------------------------------------
 * Global client-side state:
 *
 *   backendOnline  – false when the API is unreachable (banner in the layout)
 *   preferences    – the singleton preferences row
 *   resumes        – every uploaded resume
 *   defaultResume  – the one the matcher and cover letters use
 *   refresh()      – reload preferences + resumes (called after mutations)
 *
 * Components read it with `useApp()`. Pages call `refresh()` after
 * anything that changes resumes or preferences so the sidebar footer
 * (default resume name + ATS score) stays in sync.
 */

'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { getAllResumes, getPreferences, getHealth } from '@/services/api';

const AppContext = createContext(null);

export function AppProvider({ children }) {
  const [backendOnline, setBackendOnline] = useState(true);
  const [loading, setLoading] = useState(true);
  const [preferences, setPreferences] = useState(null);
  const [resumes, setResumes] = useState([]);
  const [error, setError] = useState('');

  /** Pull preferences + resumes. Never throws – sets `error` instead. */
  const refresh = useCallback(async () => {
    try {
      const [prefs, resumeData] = await Promise.all([getPreferences(), getAllResumes()]);
      setPreferences(prefs.preferences);
      setResumes(resumeData.resumes || []);
      setBackendOnline(true);
      setError('');
    } catch (err) {
      setBackendOnline(false);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  /** Cheap liveness ping, run on an interval so the banner self-heals. */
  const ping = useCallback(async () => {
    try {
      await getHealth();
      setBackendOnline(true);
    } catch {
      setBackendOnline(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(ping, 30000);
    return () => clearInterval(id);
  }, [refresh, ping]);

  const defaultResume = useMemo(() => {
    if (!resumes.length) return null;
    return resumes.find((r) => r.isDefault) || resumes[0];
  }, [resumes]);

  const value = useMemo(
    () => ({
      backendOnline,
      loading,
      error,
      preferences,
      resumes,
      defaultResume,
      refresh,
      ping,
      setPreferences,
      setResumes,
    }),
    [backendOnline, loading, error, preferences, resumes, defaultResume, refresh, ping]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

/** Access the global app state. */
export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp() must be used inside <AppProvider>');
  return ctx;
}

export default AppContext;
