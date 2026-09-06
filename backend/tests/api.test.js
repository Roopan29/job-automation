/**
 * backend/tests/api.test.js
 * ------------------------------------------------------------------
 * Integration test: boots the real Express app against a throwaway
 * SQLite file and drives every endpoint over HTTP.
 *
 * Run with:  npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

/* ------------------------------------------------------------------ *
 * The database path must be set BEFORE app.js / initDB.js are required,
 * because initDB resolves DB_PATH at module load time.
 * ------------------------------------------------------------------ */
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jobbot-api-test-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.sqlite');
process.env.NODE_ENV = 'test';
process.env.OPENAI_API_KEY = ''; // force the template/offline code paths

const { app } = require('../app');
const { buildPdf, SAMPLE_RESUME_LINES } = require('./helpers/makePdf');
const jobScraper = require('../services/jobScraper');
const jobController = require('../controllers/jobController');
const { getDb, closeDb } = require('../db/initDB');

/** @type {string} base URL, filled in by the "start server" test */
let base = '';
/** @type {import('http').Server} */
let server = null;

/** Small fetch wrapper that unwraps the { success, data, message } envelope. */
async function api(method, url, body, opts = {}) {
  const init = { method, headers: {} };
  if (body !== undefined && !(body instanceof FormData)) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  } else if (body instanceof FormData) {
    init.body = body;
  }
  const res = await fetch(`${base}${url}`, init);

  if (opts.raw) return res;

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, ...json };
}

/** Seed a handful of normalised jobs straight through the real upsert path. */
function seedJobs() {
  const raw = [
    {
      title: 'Senior React Developer',
      company: 'Acme Corp',
      location: 'Remote',
      description:
        'We need deep React, TypeScript, Next.js, Jest and AWS experience. We are fully remote and value ownership. Salary $140k-$180k.',
      requirements: ['React', 'TypeScript', 'Next.js', 'Jest', 'AWS'],
      source: 'remoteok',
      source_url: 'https://remoteok.com/l/1001',
      posted_date: new Date().toISOString(),
    },
    {
      title: 'Frontend Engineer',
      company: 'Globex',
      location: 'Remote',
      description: 'Build interfaces with React, Redux and CSS. Hybrid friendly. 3 years of experience required.',
      requirements: ['React', 'Redux', 'CSS'],
      source: 'linkedin',
      source_url: 'https://linkedin.com/jobs/view/1002',
      posted_date: new Date().toISOString(),
    },
    {
      title: 'Machine Learning Engineer',
      company: 'Initech',
      location: 'Onsite, Berlin',
      description: 'PyTorch, TensorFlow, Spark, Hadoop and Kafka. 5+ years of experience with large datasets.',
      requirements: ['PyTorch', 'TensorFlow', 'Spark', 'Hadoop', 'Kafka'],
      source: 'indeed',
      source_url: 'https://indeed.com/viewjob?jk=1003',
      posted_date: new Date().toISOString(),
    },
  ];

  const resume = require('../controllers/resumeController').getDefaultResume();
  const db = getDb();
  const run = db.transaction(() => raw.forEach((job) => jobController.upsertJob(jobScraper.normalizeJob(job), resume)));
  run();
  return raw.length;
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

test('server starts and reports healthy', async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;

  const res = await api('GET', '/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.success, true);
  assert.equal(res.data.status, 'ok');
});

/* ------------------------------------------------------------------ *
 * Resume endpoints
 * ------------------------------------------------------------------ */

test('POST /api/resume/upload parses and scores a real PDF', async () => {
  const pdf = buildPdf(SAMPLE_RESUME_LINES);
  const form = new FormData();
  form.append('resume', new Blob([pdf], { type: 'application/pdf' }), 'john-doe.pdf');

  const res = await api('POST', '/api/resume/upload', form);

  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${res.error}`);
  assert.equal(res.success, true);
  assert.ok(res.data.resume.id, 'a resume id must come back');
  assert.equal(res.data.resume.originalName, 'john-doe.pdf');
  assert.equal(res.data.resume.fileType, 'pdf');
  assert.equal(res.data.resume.isDefault, true, 'the first resume becomes the default');
  assert.ok(res.data.resume.skills.length >= 20, `expected 20+ skills, got ${res.data.resume.skills.length}`);
  assert.ok(res.data.ats.score > 60, `expected a decent ATS score, got ${res.data.ats.score}`);
  assert.equal(res.data.resume.rawText, undefined, 'list payloads must not ship the raw text');
});

test('POST /api/resume/upload rejects a .txt file with 415', async () => {
  const form = new FormData();
  form.append('resume', new Blob([Buffer.from('just text')], { type: 'text/plain' }), 'notes.txt');

  const res = await api('POST', '/api/resume/upload', form);
  assert.equal(res.status, 415, `expected 415, got ${res.status}`);
  assert.match(res.error, /PDF or DOCX/);
});

test('POST /api/resume/upload with no file explains the required field', async () => {
  const res = await api('POST', '/api/resume/upload', new FormData());
  assert.equal(res.status, 400);
  assert.match(res.error, /resume/);
});

test('GET /api/resume/all lists resumes', async () => {
  const res = await api('GET', '/api/resume/all');
  assert.equal(res.status, 200);
  assert.equal(res.data.total, 1);
  assert.ok(Array.isArray(res.data.resumes));
});

test('GET /api/resume/:id includes the raw text', async () => {
  const all = await api('GET', '/api/resume/all');
  const id = all.data.resumes[0].id;

  const res = await api('GET', `/api/resume/${id}`);
  assert.equal(res.status, 200);
  assert.ok(res.data.resume.rawText.length > 200, 'raw text should be present');
  assert.equal(res.data.resume.experience.length, 3);
});

test('GET /api/resume/:id returns 404 for an unknown id', async () => {
  const res = await api('GET', '/api/resume/99999');
  assert.equal(res.status, 404);
  assert.equal(res.success, false);
});

test('GET /api/resume/abc rejects a non-numeric id with 400', async () => {
  const res = await api('GET', '/api/resume/abc');
  assert.equal(res.status, 400);
});

test('PUT /api/resume/:id/label renames the resume', async () => {
  const all = await api('GET', '/api/resume/all');
  const id = all.data.resumes[0].id;

  const res = await api('PUT', `/api/resume/${id}/label`, { label: 'Frontend Resume' });
  assert.equal(res.status, 200);
  assert.equal(res.data.resume.label, 'Frontend Resume');
});

test('PUT /api/resume/:id/label validates the payload', async () => {
  const all = await api('GET', '/api/resume/all');
  const id = all.data.resumes[0].id;

  const empty = await api('PUT', `/api/resume/${id}/label`, {});
  assert.equal(empty.status, 400);

  const long = await api('PUT', `/api/resume/${id}/label`, { label: 'x'.repeat(120) });
  assert.equal(long.status, 400);
});

test('GET /api/resume/:id/ats-score returns all 8 categories', async () => {
  const all = await api('GET', '/api/resume/all');
  const id = all.data.resumes[0].id;

  const res = await api('GET', `/api/resume/${id}/ats-score`);
  assert.equal(res.status, 200);
  assert.equal(Object.keys(res.data.breakdown).length, 8);
  assert.ok(res.data.tips.length > 0, 'improvement tips should be present');
  assert.ok(res.data.score >= 0 && res.data.score <= 100);
});

test('GET /api/resume/:id/suggestions falls back to the local analyser without a key', async () => {
  const all = await api('GET', '/api/resume/all');
  const id = all.data.resumes[0].id;

  const res = await api('GET', `/api/resume/${id}/suggestions`);
  assert.equal(res.status, 200);
  assert.equal(res.data.source, 'local');
  assert.ok(res.data.suggestions.length > 0);
});

/* ------------------------------------------------------------------ *
 * Preferences
 * ------------------------------------------------------------------ */

test('GET /api/preferences returns defaults', async () => {
  const res = await api('GET', '/api/preferences');
  assert.equal(res.status, 200);
  assert.equal(res.data.preferences.minMatchScore, 70);
  assert.equal(res.data.preferences.dailyApplyLimit, 15);
  assert.equal(res.data.preferences.coverLetterTone, 'professional');
  assert.equal(res.data.preferences.aiConfigured, false);
});

test('PUT /api/preferences saves and validates fields', async () => {
  const res = await api('PUT', '/api/preferences', {
    fullName: 'John Doe',
    email: 'john.doe@email.com',
    phone: '+14155550134',
    linkedinUrl: 'https://linkedin.com/in/johndoe',
    location: 'San Francisco, CA',
    targetRoles: ['React Developer', 'Frontend Engineer'],
    targetLocations: ['Remote'],
    minMatchScore: 60,
    workType: 'remote',
    coverLetterTone: 'confident',
    dailyApplyLimit: 5,
    scrapeSources: ['remoteok', 'linkedin'],
  });

  assert.equal(res.status, 200, res.error);
  const p = res.data.preferences;
  assert.equal(p.fullName, 'John Doe');
  assert.equal(p.minMatchScore, 60);
  assert.equal(p.coverLetterTone, 'confident');
  assert.deepEqual(p.targetRoles, ['React Developer', 'Frontend Engineer']);
  assert.deepEqual(p.scrapeSources, ['remoteok', 'linkedin']);
  assert.deepEqual(res.data.rejected, []);
});

test('PUT /api/preferences rejects an invalid enum and cron', async () => {
  const res = await api('PUT', '/api/preferences', { workType: 'telepathy' });
  assert.equal(res.status, 400);
  assert.match(res.error, /workType/);

  const cron = await api('PUT', '/api/preferences', { autoApplySchedule: 'not a cron' });
  assert.equal(cron.status, 400);
  assert.match(cron.error, /cron/);
});

/* ------------------------------------------------------------------ *
 * Jobs
 * ------------------------------------------------------------------ */

test('seeded jobs are scored against the default resume', () => {
  assert.equal(seedJobs(), 3);
});

test('GET /api/jobs sorts by match score and paginates', async () => {
  const res = await api('GET', '/api/jobs?limit=2&page=1');
  assert.equal(res.status, 200);
  assert.equal(res.data.total, 3);
  assert.equal(res.data.jobs.length, 2);
  assert.equal(res.data.totalPages, 2);
  assert.ok(
    res.data.jobs[0].matchScore >= res.data.jobs[1].matchScore,
    'results must be sorted by match score descending'
  );
  assert.ok(res.data.jobs[0].matchScore > 70, `the React job should match strongly, got ${res.data.jobs[0].matchScore}`);
});

test('GET /api/jobs filters by search, type and score', async () => {
  const byCompany = await api('GET', '/api/jobs?q=Globex');
  assert.equal(byCompany.data.total, 1);
  assert.equal(byCompany.data.jobs[0].company, 'Globex');

  const highScore = await api('GET', '/api/jobs?minScore=70');
  assert.ok(highScore.data.jobs.every((j) => j.matchScore >= 70));
  assert.ok(highScore.data.total < 3, 'a score filter should exclude the ML job');

  const bySource = await api('GET', '/api/jobs?source=Indeed');
  assert.equal(bySource.data.total, 1);
  assert.equal(bySource.data.jobs[0].source, 'Indeed');
});

test('GET /api/jobs/recommended excludes applied jobs below the threshold', async () => {
  const res = await api('GET', '/api/jobs/recommended?minScore=60');
  assert.equal(res.status, 200);
  assert.ok(res.data.jobs.every((j) => j.matchScore >= 60 && !j.isApplied));
});

test('GET /api/jobs/:id/match-details explains the score', async () => {
  const list = await api('GET', '/api/jobs?q=Acme');
  const id = list.data.jobs[0].id;

  const res = await api('GET', `/api/jobs/${id}/match-details`);
  assert.equal(res.status, 200);
  assert.ok(res.data.matchScore > 70);
  assert.ok(res.data.matchedSkills.includes('React'));
  assert.ok(res.data.explanation.length > 20);
  assert.ok(Array.isArray(res.data.suggestions) && res.data.suggestions.length > 0);
});

test('POST /api/jobs/:id/bookmark toggles back and forth', async () => {
  const list = await api('GET', '/api/jobs?q=Globex');
  const id = list.data.jobs[0].id;

  const on = await api('POST', `/api/jobs/${id}/bookmark`);
  assert.equal(on.data.bookmarked, true);

  const off = await api('POST', `/api/jobs/${id}/bookmark`);
  assert.equal(off.data.bookmarked, false);
});

test('POST /api/jobs/scrape reports an upstream failure without crashing', async () => {
  // The sandbox has no egress to job boards, so every source fails. The
  // contract we care about is: 502, success:false, per-source detail.
  const res = await api('POST', '/api/jobs/scrape', {
    query: 'React Developer',
    location: 'Remote',
    sources: ['remoteok'],
    limit: 5,
    useBrowser: false,
  });

  assert.ok([200, 502].includes(res.status), `unexpected status ${res.status}`);
  if (res.status === 502) {
    assert.equal(res.success, false);
    assert.ok(res.data.sources.length >= 1);
    assert.ok(res.data.sources[0].error.length > 5, 'a failure reason must be included');
  } else {
    assert.equal(res.success, true);
    assert.ok(typeof res.data.jobsAdded === 'number');
  }
});

/* ------------------------------------------------------------------ *
 * Apply
 * ------------------------------------------------------------------ */

test('POST /api/apply/:jobId tracks a manual application and generates a letter', async () => {
  const list = await api('GET', '/api/jobs?q=Globex');
  const jobId = list.data.jobs[0].id;

  const res = await api('POST', `/api/apply/${jobId}`, {});
  assert.equal(res.status, 200, res.error);
  assert.equal(res.success, true);
  assert.ok(res.data.applicationId > 0);
  assert.equal(res.data.coverLetterSource, 'template', 'no API key -> template letter');
  assert.match(res.data.coverLetter, /Globex/);

  // The job must now be flagged as applied.
  const job = await api('GET', `/api/jobs/${jobId}`);
  assert.equal(job.data.job.isApplied, true);
});

test('POST /api/apply/:jobId is idempotent for the same job', async () => {
  const list = await api('GET', '/api/jobs?q=Globex');
  const jobId = list.data.jobs[0].id;

  const res = await api('POST', `/api/apply/${jobId}`, {});
  assert.equal(res.data.alreadyTracked, true);

  const tracker = await api('GET', '/api/tracker');
  assert.equal(tracker.data.total, 1, 'no duplicate application should be created');
});

test('POST /api/apply/:jobId/cover-letter respects the tone', async () => {
  const list = await api('GET', '/api/jobs?q=Acme');
  const jobId = list.data.jobs[0].id;

  const res = await api('POST', `/api/apply/${jobId}/cover-letter`, { tone: 'confident' });
  assert.equal(res.status, 200);
  assert.equal(res.data.source, 'template');
  assert.equal(res.data.tone, 'confident');
  assert.ok(res.data.coverLetter.length > 300);
});

test('POST /api/apply/:jobId/cover-letter rejects an unknown tone', async () => {
  const list = await api('GET', '/api/jobs?q=Acme');
  const jobId = list.data.jobs[0].id;

  const res = await api('POST', `/api/apply/${jobId}/cover-letter`, { tone: 'aggressive' });
  assert.equal(res.status, 400);
});

test('POST /api/apply/:jobId/interview-prep returns 10 questions', async () => {
  const list = await api('GET', '/api/jobs?q=Acme');
  const jobId = list.data.jobs[0].id;

  const res = await api('POST', `/api/apply/${jobId}/interview-prep`, {});
  assert.equal(res.status, 200);
  assert.equal(res.data.questions.length, 10);
  assert.ok(res.data.questions[0].suggestedAnswer.length > 20);
});

test('POST /api/apply/:jobId/follow-up-email drafts an email with a subject', async () => {
  const list = await api('GET', '/api/jobs?q=Globex');
  const jobId = list.data.jobs[0].id;

  const res = await api('POST', `/api/apply/${jobId}/follow-up-email`, {});
  assert.equal(res.status, 200);
  assert.match(res.data.emailDraft, /^Subject: /);
});

test('POST /api/apply/:jobId/auto reports the missing browser instead of hanging', async () => {
  const list = await api('GET', '/api/jobs?q=Initech');
  const jobId = list.data.jobs[0].id;

  const res = await api('POST', `/api/apply/${jobId}/auto`, {});
  // Either Chromium is unavailable here (503) or the run failed cleanly (200).
  assert.ok([200, 503].includes(res.status), `unexpected status ${res.status}: ${res.error}`);
  if (res.status === 503) {
    assert.match(res.error, /browser is not available/i);
    assert.ok(res.hint, 'a remediation hint should be included');
  } else {
    assert.equal(res.data.success, false);
    assert.ok(res.data.error, 'a failure reason should be included');
  }
});

test('GET /api/apply/status exposes queue, limits and browser health', async () => {
  const res = await api('GET', '/api/apply/status');
  assert.equal(res.status, 200);
  assert.equal(typeof res.data.queue, 'number');
  assert.equal(res.data.settings.minMatchScore, 60);
  assert.ok(res.data.today.limit === 5);
  assert.ok(res.data.nextRun.length > 0);
  assert.equal(typeof res.data.browser.available, 'boolean');
});

/* ------------------------------------------------------------------ *
 * Tracker
 * ------------------------------------------------------------------ */

test('GET /api/tracker returns the application with its job', async () => {
  const res = await api('GET', '/api/tracker');
  assert.equal(res.status, 200);
  assert.equal(res.data.total, 1);
  assert.equal(res.data.applications[0].job.company, 'Globex');
  assert.equal(res.data.applications[0].status, 'applied');
  assert.equal(res.data.statuses.length, 7);
});

test('GET /api/tracker filters by status and search', async () => {
  const byStatus = await api('GET', '/api/tracker?status=interview');
  assert.equal(byStatus.data.total, 0);

  const bySearch = await api('GET', '/api/tracker?search=Globex');
  assert.equal(bySearch.data.total, 1);

  const byMethod = await api('GET', '/api/tracker?method=auto');
  assert.equal(byMethod.data.total, 0);
});

test('PATCH /api/tracker/:id/status writes a history entry', async () => {
  const list = await api('GET', '/api/tracker');
  const id = list.data.applications[0].id;

  const res = await api('PATCH', `/api/tracker/${id}/status`, { status: 'interview', note: 'Recruiter call' });
  assert.equal(res.status, 200, res.error);
  assert.equal(res.data.application.status, 'interview');
  assert.ok(res.data.history.length >= 2, 'the transition must be recorded');
  assert.equal(res.data.history[0].newStatus, 'interview');
  assert.equal(res.data.history[0].oldStatus, 'applied');
});

test('PATCH /api/tracker/:id/status rejects an unknown status', async () => {
  const list = await api('GET', '/api/tracker');
  const id = list.data.applications[0].id;

  const res = await api('PATCH', `/api/tracker/${id}/status`, { status: 'hired-maybe' });
  assert.equal(res.status, 400);
  assert.match(res.error, /Status must be one of/);
});

test('PATCH /api/tracker/:id/notes saves the notes', async () => {
  const list = await api('GET', '/api/tracker');
  const id = list.data.applications[0].id;

  const res = await api('PATCH', `/api/tracker/${id}/notes`, { notes: 'Second round next week.' });
  assert.equal(res.status, 200);
  assert.equal(res.data.application.notes, 'Second round next week.');
});

test('PATCH /api/tracker/:id/follow-up stores the dates', async () => {
  const list = await api('GET', '/api/tracker');
  const id = list.data.applications[0].id;
  const date = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);

  const res = await api('PATCH', `/api/tracker/${id}/follow-up`, { follow_up_date: date });
  assert.equal(res.status, 200);
  assert.equal(res.data.application.followUpDate, date);
});

test('GET /api/tracker/:id includes the history timeline', async () => {
  const list = await api('GET', '/api/tracker');
  const id = list.data.applications[0].id;

  const res = await api('GET', `/api/tracker/${id}`);
  assert.equal(res.status, 200);
  assert.ok(res.data.history.length >= 2);
  assert.equal(res.data.application.status, 'interview');
});

test('GET /api/tracker/stats computes rates and chart series', async () => {
  const res = await api('GET', '/api/tracker/stats');
  assert.equal(res.status, 200);
  assert.equal(res.data.total, 1);
  assert.equal(res.data.interview, 1);
  assert.equal(res.data.responseRate, 100, 'a single interview counts as a response');
  assert.equal(res.data.byMonth.length, 6, 'six monthly buckets');
  assert.equal(res.data.last30Days.length, 30, 'thirty daily buckets');
  assert.deepEqual(res.data.bySource, { LinkedIn: 1 });
});

test('GET /api/tracker/export/csv streams a downloadable file', async () => {
  const res = await api('GET', '/api/tracker/export/csv', undefined, { raw: true });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="jobbot-applications-.*\.csv"/);

  const csv = await res.text();
  const header = csv.split('\n')[0];
  ['Company', 'Role', 'Status', 'Applied Date', 'Source', 'Match Score', 'Notes'].forEach((col) => {
    assert.ok(header.includes(col), `CSV header is missing the ${col} column`);
  });
  assert.match(csv, /Globex/);
});

/* ------------------------------------------------------------------ *
 * Dashboard + system
 * ------------------------------------------------------------------ */

test('GET /api/dashboard returns every section the page renders', async () => {
  const res = await api('GET', '/api/dashboard');
  assert.equal(res.status, 200);

  const d = res.data;
  assert.equal(d.resumeCount, 1);
  assert.equal(d.defaultResume.label, 'Frontend Resume');
  assert.ok(d.defaultResume.atsScore > 0);
  assert.equal(d.jobCount, 3);
  assert.ok(Array.isArray(d.recentApplications));
  assert.ok(Array.isArray(d.topMatchJobs));
  assert.ok(Array.isArray(d.upcomingFollowUps));
  assert.ok(Array.isArray(d.skillGaps));
  assert.ok(d.stats.total >= 1);
  assert.equal(d.aiConfigured, false);

  // The ML job should drive the skill gaps.
  assert.ok(d.skillGaps.length > 0, 'skill gaps should be computed from the unapplied jobs');
});

test('GET /api/system/status lists the scheduled cron jobs', async () => {
  const res = await api('GET', '/api/system/status');
  assert.equal(res.status, 200);
  assert.equal(res.data.cron.length, 4);
  assert.deepEqual(
    res.data.cron.map((t) => t.name),
    ['auto-scrape', 'auto-apply', 'cleanup', 'follow-ups']
  );
  assert.equal(res.data.scraperSources.length, 5);
});

test('GET /api/notifications returns the alert feed', async () => {
  const res = await api('GET', '/api/notifications');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.data.notifications));
});

test('unknown API routes return a JSON 404', async () => {
  const res = await api('GET', '/api/does-not-exist');
  assert.equal(res.status, 404);
  assert.equal(res.success, false);
});

/* ------------------------------------------------------------------ *
 * Deletions
 * ------------------------------------------------------------------ */

test('DELETE /api/tracker/:id clears the job applied flag', async () => {
  const list = await api('GET', '/api/tracker');
  const id = list.data.applications[0].id;
  const jobId = list.data.applications[0].jobId;

  const res = await api('DELETE', `/api/tracker/${id}`);
  assert.equal(res.status, 200);

  const job = await api('GET', `/api/jobs/${jobId}`);
  assert.equal(job.data.job.isApplied, false, 'the job must be re-opened for applying');

  const tracker = await api('GET', '/api/tracker');
  assert.equal(tracker.data.total, 0);
});

test('DELETE /api/jobs/clear-old only removes untouched, stale jobs', async () => {
  // Age one unapplied job, bookmark another, apply-protect the third.
  const db = getDb();
  db.prepare("UPDATE jobs SET posted_date = date('now','-60 days'), scraped_at = datetime('now','-60 days') WHERE company = 'Initech'").run();
  db.prepare("UPDATE jobs SET posted_date = date('now','-60 days'), scraped_at = datetime('now','-60 days'), is_bookmarked = 1 WHERE company = 'Acme Corp'").run();

  const res = await api('DELETE', '/api/jobs/clear-old');
  assert.equal(res.status, 200);
  assert.equal(res.data.deleted, 1, 'only the unbookmarked stale job should go');

  const remaining = await api('GET', '/api/jobs?limit=10');
  assert.equal(remaining.data.total, 2);
  assert.ok(remaining.data.jobs.every((j) => j.company !== 'Initech'));
});

test('DELETE /api/resume/:id removes the row and the file', async () => {
  const all = await api('GET', '/api/resume/all');
  const resume = all.data.resumes[0];
  const filePath = resume.filePath;
  assert.ok(fs.existsSync(filePath), 'the uploaded file should exist before deletion');

  const res = await api('DELETE', `/api/resume/${resume.id}`);
  assert.equal(res.status, 200);

  const after = await api('GET', '/api/resume/all');
  assert.equal(after.data.total, 0);
  assert.equal(fs.existsSync(filePath), false, 'the file must be deleted from disk');
});

test('GET /api/dashboard works with no resumes at all', async () => {
  const res = await api('GET', '/api/dashboard');
  assert.equal(res.status, 200);
  assert.equal(res.data.resumeCount, 0);
  assert.equal(res.data.defaultResume, null);
});

/* ------------------------------------------------------------------ *
 * Notification feed
 *
 * Desktop notifications need a notification daemon, which CI/sandboxes
 * do not have. The in-memory feed is the fallback that the UI reads, so
 * it must still record every alert.
 * ------------------------------------------------------------------ */

test('notification feed records alerts even with no display daemon', async () => {
  const notifier = require('../utils/notifier');
  notifier.clearFeed();

  const before = await api('GET', '/api/notifications?limit=10');
  assert.equal(before.status, 200);
  assert.equal(before.data.total, 0, 'feed starts empty');

  notifier.notifyScrapeDone(12, 4, 'RemoteOK');
  notifier.notifyCaptcha('Acme Corp', 'Senior React Developer');
  notifier.notifyFollowUp('Brightline', 'Frontend Engineer');

  const after = await api('GET', '/api/notifications?limit=10');
  assert.equal(after.data.total, 3, 'all three alerts must be recorded');

  const entries = after.data.notifications;
  assert.equal(entries.length, 3);
  // Newest first, so the UI shows the latest alert at the top.
  assert.match(entries[0].title, /Follow-up/i);
  assert.match(entries[1].title, /CAPTCHA/i);
  assert.match(entries[2].title, /scrape/i);

  for (const entry of entries) {
    assert.ok(entry.id, 'each entry needs an id');
    assert.ok(entry.at, 'each entry needs a timestamp');
    assert.ok(entry.message.length > 0, 'each entry needs a message');
    assert.ok(['info', 'success', 'warning', 'error'].includes(entry.level));
  }
});

test('notification feed honours the limit param', async () => {
  const res = await api('GET', '/api/notifications?limit=2');
  assert.equal(res.data.notifications.length, 2, 'limit must cap the returned entries');
  assert.equal(res.data.total, 3, 'total still reports the real feed size');
});

test('DELETE /api/notifications clears the feed', async () => {
  const cleared = await api('DELETE', '/api/notifications');
  assert.equal(cleared.status, 200);

  const after = await api('GET', '/api/notifications');
  assert.equal(after.data.total, 0, 'the feed must be empty after clearing');
});

test('a scrape where every source fails does not claim success', async () => {
  // Regression guard: notifications must not fire for a scrape that
  // fetched nothing, otherwise the UI reports phantom new jobs.
  const notifier = require('../utils/notifier');
  notifier.clearFeed();

  const res = await api('POST', '/api/jobs/scrape', {
    query: 'react',
    location: 'Remote',
    sources: ['remoteok'],
    limit: 5,
  });

  assert.equal(res.status, 502, 'all sources failing is a 502, not a 200');
  // api() spreads the { success, data|error } envelope onto the result.
  assert.equal(res.success, false);
  assert.match(res.error, /No jobs could be fetched/);

  const feed = await api('GET', '/api/notifications');
  assert.equal(feed.data.total, 0, 'no "scrape finished" alert for a scrape that found nothing');
});

/* ------------------------------------------------------------------ *
 * Teardown
 * ------------------------------------------------------------------ */

test('server shuts down cleanly', async () => {
  closeDb();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});
