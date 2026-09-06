/**
 * frontend/services/api.js
 * ------------------------------------------------------------------
 * Every backend call in one place.
 *
 * Base URL
 * --------
 * Defaults to "/api", which Next.js proxies to the Express backend
 * (see next.config.mjs). Same-origin relative URLs mean the app works
 * on localhost, behind a preview proxy, or on any hostname without
 * touching this file. Override with NEXT_PUBLIC_API_URL if you host the
 * API on a different origin.
 *
 * Response envelope
 * -----------------
 * The backend always answers { success, data, message } or
 * { success: false, error, code }. The interceptor below unwraps the
 * success case to just `data` and turns failures into a thrown Error
 * carrying `.code`, so components can write:
 *
 *     const { resumes } = await getAllResumes();
 *
 * and use try/catch + toast.error(err.message) for the unhappy path.
 */

import axios from 'axios';

export const API_BASE = process.env.NEXT_PUBLIC_API_URL || '/api';

/** Shared axios instance with a sensible timeout. */
export const http = axios.create({
  baseURL: API_BASE,
  timeout: 120000, // scraping and AI calls are slow
  headers: { 'Content-Type': 'application/json' },
});

/* ------------------------------------------------------------------ *
 * Interceptors
 * ------------------------------------------------------------------ */

http.interceptors.response.use(
  (response) => {
    const body = response.data;

    // Non-JSON responses (the CSV export) pass straight through.
    if (body === null || typeof body !== 'object') return body;

    if (body.success === false) {
      const error = new Error(body.error || 'Request failed');
      error.code = body.code || response.status;
      error.response = response;
      error.hint = body.hint;
      return Promise.reject(error);
    }

    // Unwrap: callers get `data`, and `.message` rides along on it when
    // the payload is an object.
    if (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) {
      return { ...body.data, __message: body.message };
    }
    return body.data;
  },
  (error) => {
    const body = error.response?.data;
    const message =
      body?.error ||
      (error.code === 'ECONNABORTED'
        ? 'The request timed out. Scraping and AI calls can take a while.'
        : error.response
          ? `Request failed with status ${error.response.status}`
          : 'Cannot reach the backend. Is `node app.js` running in the backend folder?');

    const wrapped = new Error(message);
    wrapped.code = body?.code || error.response?.status || error.code;
    wrapped.hint = body?.hint;
    wrapped.details = body?.data;
    return Promise.reject(wrapped);
  }
);

/* ------------------------------------------------------------------ *
 * RESUME
 * ------------------------------------------------------------------ */

/**
 * Upload a resume file.
 * @param {File|Blob} file
 * @param {(percent:number)=>void} [onProgress] upload progress 0–100
 * @param {string} [label]
 */
export const uploadResume = (file, onProgress, label) => {
  const form = new FormData();
  form.append('resume', file);
  if (label) form.append('label', label);

  return http.post('/resume/upload', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    onUploadProgress: (event) => {
      if (onProgress && event.total) onProgress(Math.round((event.loaded * 100) / event.total));
    },
  });
};

export const getAllResumes = () => http.get('/resume/all');
export const getResume = (id) => http.get(`/resume/${id}`);
export const renameResume = (id, label) => http.put(`/resume/${id}/label`, { label });
export const setDefaultResume = (id) => http.put(`/resume/${id}/set-default`);
export const getAtsScore = (id) => http.get(`/resume/${id}/ats-score`);
export const getResumeSuggestions = (id) => http.get(`/resume/${id}/suggestions`);
export const deleteResume = (id) => http.delete(`/resume/${id}`);

/* ------------------------------------------------------------------ *
 * JOBS
 * ------------------------------------------------------------------ */

/**
 * Trigger a scrape.
 * @param {{query?:string, location?:string, sources?:string[], limit?:number, useBrowser?:boolean}} params
 */
export const scrapeJobs = (params) => http.post('/jobs/scrape', params);

/**
 * List jobs.
 * @param {{q?:string, location?:string, jobType?:string, experienceLevel?:string,
 *          minScore?:number, bookmarked?:boolean, source?:string, applied?:boolean,
 *          page?:number, limit?:number, sort?:string}} params
 */
export const searchJobs = (params) => http.get('/jobs', { params });

export const getRecommendedJobs = (params) => http.get('/jobs/recommended', { params });
export const getJob = (id) => http.get(`/jobs/${id}`);
export const getMatchDetails = (id) => http.get(`/jobs/${id}/match-details`);
export const toggleBookmark = (id) => http.post(`/jobs/${id}/bookmark`);
export const clearOldJobs = (days = 30) => http.delete(`/jobs/clear-old${days ? `?days=${days}` : ''}`);
export const getScrapeLogs = (limit = 20) => http.get('/jobs/scrape/logs', { params: { limit } });

/* ------------------------------------------------------------------ *
 * APPLY
 * ------------------------------------------------------------------ */

/** Track a manual application. */
export const applyToJob = (jobId, payload = {}) => http.post(`/apply/${jobId}`, payload);

/** Run the Puppeteer bot against one job. */
export const autoApplyToJob = (jobId, payload = {}) => http.post(`/apply/${jobId}/auto`, payload);

/** Apply to the whole recommended queue. */
export const runAutoApplyBatch = (payload = {}) => http.post('/apply/run-auto-batch', payload);

/** Ask a running batch to stop after the current job. */
export const stopAutoApply = () => http.post('/apply/stop');

/** Bot health, queue size, today's count, recent log. */
export const getApplyStatus = () => http.get('/apply/status');

/** Live run log (poll this while a batch is running). */
export const getApplyLog = (since = 0) => http.get('/apply/log', { params: { since } });

/** Cover letters & interview material. */
export const generateCoverLetter = (jobId, payload = {}) => http.post(`/apply/${jobId}/cover-letter`, payload);
export const generateInterviewPrep = (jobId, payload = {}) => http.post(`/apply/${jobId}/interview-prep`, payload);
export const generateFollowUpEmail = (jobId, payload = {}) => http.post(`/apply/${jobId}/follow-up-email`, payload);

/* ------------------------------------------------------------------ *
 * TRACKER
 * ------------------------------------------------------------------ */

/**
 * List applications.
 * @param {{status?:string, method?:string, dateFrom?:string, dateTo?:string,
 *          search?:string, source?:string}} params
 */
export const getApplications = (params) => http.get('/tracker', { params });

export const getTrackerStats = () => http.get('/tracker/stats');
export const getApplication = (id) => http.get(`/tracker/${id}`);
export const updateApplicationStatus = (id, status, note) =>
  http.patch(`/tracker/${id}/status`, { status, note });
export const updateApplicationNotes = (id, notes) => http.patch(`/tracker/${id}/notes`, { notes });
export const updateApplicationDates = (id, payload) => http.patch(`/tracker/${id}/follow-up`, payload);
export const deleteApplication = (id) => http.delete(`/tracker/${id}`);

/**
 * Download the CSV export. Goes through the same proxy so it works
 * behind a preview host, and triggers a real browser download.
 */
/**
 * Download the tracker as CSV.
 *
 * Accepts the same filter params as getApplications so the file matches the
 * table the user is looking at. Call it with no arguments to export all.
 */
export const exportApplicationsCsv = async (params) => {
  const response = await http.get('/tracker/export/csv', { params, responseType: 'blob' });
  const blob = response instanceof Blob ? response : new Blob([response], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `jobbot-applications-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};

/* ------------------------------------------------------------------ *
 * PREFERENCES
 * ------------------------------------------------------------------ */

export const getPreferences = () => http.get('/preferences');
export const updatePreferences = (payload) => http.put('/preferences', payload);
export const testAiConnection = () => http.post('/preferences/test-ai');

/* ------------------------------------------------------------------ *
 * DASHBOARD / SYSTEM
 * ------------------------------------------------------------------ */

export const getDashboard = () => http.get('/dashboard');
export const getHealth = () => http.get('/health');
export const getSystemStatus = () => http.get('/system/status');
export const getNotifications = (limit = 20) => http.get('/notifications', { params: { limit } });
/** Empty the notification feed. */
export const clearNotifications = () => http.delete('/notifications');

export default http;
