/**
 * backend/controllers/applyController.js
 * ------------------------------------------------------------------
 *   POST /api/apply/:jobId                track a manual application
 *   POST /api/apply/:jobId/auto           AI cover letter + Puppeteer
 *   POST /api/apply/run-auto-batch        apply to the whole queue
 *   POST /api/apply/stop                  stop a running batch
 *   POST /api/apply/:jobId/cover-letter   generate / regenerate a letter
 *   POST /api/apply/:jobId/interview-prep 10 questions + answers
 *   POST /api/apply/:jobId/follow-up-email follow-up draft
 *   GET  /api/apply/status                bot health + queue + today
 *   GET  /api/apply/log                   live run log for the UI
 */

const log = require('../utils/logger');
const { ok, fail, asyncHandler } = require('../utils/apiResponse');
const { mapJob, mapResume, parseJson, toJson, toStr, toInt } = require('../utils/serialize');
const { getDb } = require('../db/initDB');
const fileHelper = require('../utils/fileHelper');
const notifier = require('../utils/notifier');
const autoApplyBot = require('../services/autoApplyBot');
const coverLetterGen = require('../services/coverLetterGen');
const { getDefaultResume, getResumeRow, toParsedResume } = require('./resumeController');

const logger = log.scope('Apply');

/** Application statuses used everywhere in the app. */
const STATUSES = ['applied', 'responded', 'interview', 'offer', 'rejected', 'ghosted', 'withdrawn'];

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

/** Preferences row as a usable object. */
function getPrefs() {
  const row = getDb().prepare('SELECT * FROM preferences WHERE id = 1').get() || {};
  return {
    defaultResumeId: row.default_resume_id ?? null,
    generateCoverLetter: Boolean(Number(row.generate_cover_letter ?? 1)),
    coverLetterTone: row.cover_letter_tone || 'professional',
    minMatchScore: row.min_match_score ?? 70,
    dailyApplyLimit: row.daily_apply_limit ?? 15,
    autoApplyEnabled: Boolean(Number(row.auto_apply_enabled ?? 0)),
    autoApplySources: parseJson(row.auto_apply_sources, ['indeed', 'linkedin']),
    delayBetweenApplications: row.delay_between_applications || '60s',
    contact: {
      fullName: row.full_name || '',
      email: row.email || '',
      phone: row.phone || '',
      linkedin: row.linkedin_url || '',
      website: row.portfolio_url || '',
      location: row.location || '',
    },
  };
}

/** Resolve the resume to use: explicit id > preferences > default. */
function resolveResume(resumeId) {
  const prefs = getPrefs();
  const id = toInt(resumeId) || prefs.defaultResumeId;
  const row = id ? getResumeRow(id) : null;
  return row ? toParsedResume(row) : getDefaultResume();
}

/** Load a job row as a mapped object (or null). */
function loadJob(jobId) {
  const row = getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  return row ? mapJob(row) : null;
}

/** How many applications were recorded today (local time)? */
function appliedToday() {
  return getDb()
    .prepare("SELECT COUNT(*) AS n FROM applications WHERE date(applied_at) = date('now')")
    .get().n;
}

/**
 * Create an application row + mark the job applied + first history entry.
 * @returns {number} the new application id
 */
function createApplication({ jobId, resumeId, coverLetter = '', method = 'manual', status = 'applied', notes = '' }) {
  const db = getDb();

  const insert = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO applications (job_id, resume_id, cover_letter, status, applied_method, notes, applied_at, last_updated)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
      )
      .run(jobId, resumeId ?? null, coverLetter || '', status, method, notes || '');

    const applicationId = Number(info.lastInsertRowid);

    db.prepare(
      `INSERT INTO status_history (application_id, old_status, new_status, note, changed_at)
       VALUES (?, NULL, ?, ?, datetime('now'))`
    ).run(applicationId, status, notes || `Application recorded (${method})`);

    db.prepare("UPDATE jobs SET is_applied = 1 WHERE id = ?").run(jobId);

    return applicationId;
  });

  const id = insert();
  logger.info(`Application #${id} created for job #${jobId} (${method})`);
  return id;
}

/** Build a cover letter for a job using the resolved resume. */
async function makeCoverLetter(job, resume, tone, forceTemplate = false) {
  return coverLetterGen.buildCoverLetter(job, resume, { tone, forceTemplate });
}

/* ------------------------------------------------------------------ *
 * POST /api/apply/:jobId   (manual tracking)
 * ------------------------------------------------------------------ */

const applyManually = asyncHandler(async (req, res) => {
  const jobId = toInt(req.params.jobId);
  if (!jobId) return fail(res, 'A numeric job id is required', 400);

  const job = loadJob(jobId);
  if (!job) return fail(res, `Job ${jobId} not found`, 404);

  const resume = resolveResume(req.body?.resumeId);
  const prefs = getPrefs();

  let coverLetter = toStr(req.body?.coverLetter);
  let coverLetterSource = 'user';

  // No letter supplied and auto-generation is on -> generate one.
  if (!coverLetter && prefs.generateCoverLetter && req.body?.generateCoverLetter !== false) {
    const generated = await makeCoverLetter(job, resume || {}, prefs.coverLetterTone);
    coverLetter = generated.coverLetter;
    coverLetterSource = generated.source;
  }

  // Guard against double-applying to the same job.
  const existing = getDb()
    .prepare('SELECT id, status FROM applications WHERE job_id = ? ORDER BY id DESC LIMIT 1')
    .get(jobId);

  const applicationId = existing
    ? existing.id
    : createApplication({
        jobId,
        resumeId: resume?.id ?? null,
        coverLetter,
        method: 'manual',
        notes: toStr(req.body?.notes),
      });

  if (existing) {
    getDb()
      .prepare("UPDATE applications SET cover_letter = ?, last_updated = datetime('now') WHERE id = ?")
      .run(coverLetter || null, applicationId);
  }

  const followUp = toStr(req.body?.followUpDate);
  if (followUp) {
    getDb()
      .prepare("UPDATE applications SET follow_up_date = ?, last_updated = datetime('now') WHERE id = ?")
      .run(followUp, applicationId);
  }

  return ok(
    res,
    {
      applicationId,
      jobId,
      alreadyTracked: Boolean(existing),
      resumeUsed: resume ? { id: resume.id, label: resume.label } : null,
      coverLetterSource,
      coverLetter,
    },
    existing
      ? `You already tracked this one – the cover letter was updated`
      : `Application tracked for ${job.title} at ${job.company}`
  );
});

/* ------------------------------------------------------------------ *
 * POST /api/apply/:jobId/auto   (Puppeteer)
 * ------------------------------------------------------------------ */

const applyAutomatically = asyncHandler(async (req, res) => {
  const jobId = toInt(req.params.jobId);
  if (!jobId) return fail(res, 'A numeric job id is required', 400);

  const job = loadJob(jobId);
  if (!job) return fail(res, `Job ${jobId} not found`, 404);

  if (!job.sourceUrl) {
    return fail(res, 'This job has no source URL, so the bot cannot open it. Track it manually instead.', 422);
  }

  const prefs = getPrefs();
  const resume = resolveResume(req.body?.resumeId);
  if (!resume) return fail(res, 'Upload a resume before auto-applying.', 422);

  const resumePath = fileHelper.resolveUpload(resume.filePath);
  if (resumePath && !fileHelper.exists(resumePath)) {
    return fail(res, `The resume file is missing from disk (${resume.filePath}). Re-upload it.`, 410);
  }

  // --- cover letter ---------------------------------------------------
  let coverLetter = toStr(req.body?.coverLetter);
  let coverLetterSource = 'user';
  if (!coverLetter && prefs.generateCoverLetter) {
    const generated = await makeCoverLetter(job, resume, toStr(req.body?.tone) || prefs.coverLetterTone);
    coverLetter = generated.coverLetter;
    coverLetterSource = generated.source;
  }

  // --- health check before we bother the user --------------------------
  const health = await autoApplyBot.botHealth();
  if (!health.available) {
    notifier.notifyError('Auto-apply unavailable', health.reason || 'Chromium could not start');
    return res.status(503).json({
      success: false,
      error: `The automation browser is not available: ${health.reason}`,
      code: 503,
      hint: health.hint,
    });
  }

  if (!prefs.contact.email && !prefs.contact.fullName) {
    logger.warn('No personal info in preferences – the form filler will have nothing to type');
  }

  // --- run the bot -----------------------------------------------------
  logger.info(`Auto-applying to ${job.title} at ${job.company} (${job.source})`);

  const outcome = await autoApplyBot.applyToJob({
    jobUrl: job.sourceUrl,
    resumePath,
    coverLetter,
    jobSource: String(job.source || '').toLowerCase(),
    contact: prefs.contact,
    dryRun: req.body?.dryRun === true,
  });

  // --- persist whatever happened --------------------------------------
  let applicationId = null;
  if (outcome.success || req.body?.recordAnyway === true) {
    applicationId = createApplication({
      jobId,
      resumeId: resume.id,
      coverLetter,
      method: 'auto',
      notes: outcome.success
        ? `Auto-applied by JobBot on ${new Date().toISOString()}`
        : `Auto-apply incomplete: ${outcome.error}. Review the site manually.`,
    });
  }

  const message = outcome.success
    ? `Auto-applied to ${job.title} at ${job.company}`
    : outcome.captchaHit
      ? `CAPTCHA blocked the application at ${job.company} – solve it in the browser window and retry`
      : `Auto-apply did not complete at ${job.company}: ${outcome.error}`;

  logger[outcome.success ? 'success' : 'warn'](message);

  return ok(
    res,
    {
      success: outcome.success,
      status: outcome.success ? 'applied' : 'failed',
      message,
      applicationId,
      captchaHit: outcome.captchaHit,
      captchaType: outcome.captchaType,
      error: outcome.error,
      steps: outcome.steps,
      coverLetterSource,
      coverLetter,
    },
    message
  );
});

/* ------------------------------------------------------------------ *
 * POST /api/apply/run-auto-batch
 * ------------------------------------------------------------------ */

let batchRunning = false;
/** @type {object|null} summary of the most recent batch */
let lastBatch = null;

const runAutoBatch = asyncHandler(async (req, res) => {
  if (batchRunning) {
    return fail(res, 'An auto-apply batch is already running. Stop it first.', 409);
  }

  try {
    const summary = await runBatch(req.body || {});
    if (summary.error) return fail(res, summary.error, summary.code || 400, { data: summary });
    return ok(
      res,
      summary,
      `Batch finished — ${summary.succeeded} applied, ${summary.failed} failed, ${summary.captchaHit} CAPTCHA`
    );
  } catch (err) {
    logger.error(`Auto-apply batch crashed: ${err.message}`);
    return fail(res, `Auto-apply batch failed: ${err.message}`, 500);
  }
});

/**
 * Core batch runner, shared by the HTTP endpoint and the cron job.
 * Never throws for expected problems – it returns { error, code }.
 *
 * @param {object} [options] { resumeId, minMatchScore, limit, sources, delay, dryRun, recordFailures }
 * @returns {Promise<object>}
 */
async function runBatch(options = {}) {
  const db = getDb();
  const prefs = getPrefs();
  const resume = resolveResume(options.resumeId);

  if (!resume) return { error: 'Upload a resume before running the auto-apply batch.', code: 422 };

  const resumePath = fileHelper.resolveUpload(resume.filePath);
  if (resumePath && !fileHelper.exists(resumePath)) {
    return { error: 'The default resume file is missing from disk. Re-upload it.', code: 410 };
  }

  const minScore = toInt(options.minMatchScore) ?? prefs.minMatchScore;
  const limit = Math.min(
    toInt(options.limit) ?? prefs.dailyApplyLimit,
    Math.max(0, prefs.dailyApplyLimit - appliedToday())
  );

  if (limit <= 0) {
    return {
      error: `Today's daily limit (${prefs.dailyApplyLimit}) has been reached. Raise it in Preferences or try again tomorrow.`,
      code: 429,
    };
  }

  const health = await autoApplyBot.botHealth();
  if (!health.available) {
    return {
      error: `The automation browser is not available: ${health.reason}`,
      code: 503,
      hint: health.hint,
    };
  }

  const allowedSources = (Array.isArray(options.sources) && options.sources.length
    ? options.sources
    : prefs.autoApplySources
  ).map((s) => String(s).toLowerCase());

  const sourceLabels = allowedSources
    .map((s) => ({ indeed: 'Indeed', linkedin: 'LinkedIn', glassdoor: 'Glassdoor', remoteok: 'RemoteOK', remotive: 'Remotive' }[s] || s));

  // Build named parameters only – better-sqlite3 does not allow mixing
  // a bind object with positional arguments.
  const params = { minScore, limit };
  let sourceClause = '';
  if (sourceLabels.length) {
    sourceClause = `AND source IN (${sourceLabels.map((_, i) => `@src${i}`).join(', ')})`;
    sourceLabels.forEach((label, i) => {
      params[`src${i}`] = label;
    });
  }

  const queueRows = db
    .prepare(
      `SELECT * FROM jobs
        WHERE is_applied = 0
          AND match_score >= @minScore
          AND source_url IS NOT NULL AND source_url <> ''
          ${sourceClause}
        ORDER BY match_score DESC, id DESC
        LIMIT @limit`
    )
    .all(params);

  if (!queueRows.length) {
    return {
      attempted: 0,
      succeeded: 0,
      failed: 0,
      captchaHit: 0,
      results: [],
      queue: 0,
      minScore,
      message: `No jobs in the queue (match >= ${minScore}% and not yet applied). Try scraping first.`,
    };
  }

  const queue = queueRows.map(mapJob);

  autoApplyBot.clearRunLog();
  autoApplyBot.resetStop();
  batchRunning = true;

  logger.info(`Auto-apply batch: ${queue.length} job(s), limit ${limit}, min score ${minScore}%`);

  let summary;
  try {
    summary = await autoApplyBot.applyBatch(queue, {
      resumePath,
      contact: prefs.contact,
      limit,
      delay: toStr(options.delay) || prefs.delayBetweenApplications,
      dryRun: options.dryRun === true,

      /** Build a cover letter per job (AI when configured). */
      coverLetterFor: async (job) => {
        if (!prefs.generateCoverLetter) return '';
        const generated = await makeCoverLetter(job, resume, prefs.coverLetterTone);
        return generated.coverLetter;
      },

      /** Persist each outcome so the tracker stays truthful. */
      onApplied: async (job, outcome, coverLetter) => {
        if (!outcome.success && options.recordFailures === false) return;
        createApplication({
          jobId: job.id,
          resumeId: resume.id,
          coverLetter,
          method: 'auto',
          notes: outcome.success ? 'Auto-applied by JobBot' : `Auto-apply did not complete: ${outcome.error}`,
        });
      },
    });
  } finally {
    batchRunning = false;
  }

  lastBatch = { ...summary, finishedAt: new Date().toISOString() };

  return { ...summary, log: autoApplyBot.getRunLog(), queue: queue.length, minScore };
}

/* ------------------------------------------------------------------ *
 * POST /api/apply/stop
 * ------------------------------------------------------------------ */

const stopAutoBatch = asyncHandler(async (req, res) => {
  autoApplyBot.requestStop();
  return ok(res, { stopping: true, wasRunning: batchRunning }, 'Stop requested – the current job will finish first');
});

/* ------------------------------------------------------------------ *
 * GET /api/apply/status
 * ------------------------------------------------------------------ */

const getApplyStatus = asyncHandler(async (req, res) => {
  const db = getDb();
  const prefs = getPrefs();
  const health = await autoApplyBot.botHealth();

  const queue = db
    .prepare(
      `SELECT COUNT(*) AS n FROM jobs
        WHERE is_applied = 0 AND match_score >= @minScore
          AND source_url IS NOT NULL AND source_url <> ''`
    )
    .get({ minScore: prefs.minMatchScore }).n;

  const lastRuns = db
    .prepare(
      `SELECT a.id, a.applied_at, a.status, a.applied_method, j.title, j.company, j.source
         FROM applications a LEFT JOIN jobs j ON j.id = a.job_id
        WHERE a.applied_method = 'auto'
        ORDER BY a.applied_at DESC LIMIT 20`
    )
    .all();

  // "Next run" is derived from the cron expression in preferences.
  const nextRun = describeNextRun(prefs.autoApplySchedule);

  return ok(res, {
    enabled: prefs.autoApplyEnabled,
    running: batchRunning,
    stopping: autoApplyBot.isStopRequested(),
    browser: health,
    today: { applied: appliedToday(), limit: prefs.dailyApplyLimit },
    queue,
    nextRun,
    lastRun: lastBatch,
    recentAutoApplications: lastRuns,
    settings: {
      minMatchScore: prefs.minMatchScore,
      dailyApplyLimit: prefs.dailyApplyLimit,
      schedule: prefs.autoApplySchedule,
      sources: prefs.autoApplySources,
      delay: prefs.delayBetweenApplications,
      generateCoverLetter: prefs.generateCoverLetter,
      coverLetterTone: prefs.coverLetterTone,
    },
    log: autoApplyBot.getRunLog().slice(-60),
  });
});

/* ------------------------------------------------------------------ *
 * GET /api/apply/log
 * ------------------------------------------------------------------ */

const getApplyLog = asyncHandler(async (req, res) => {
  const since = toInt(req.query.since, 0);
  const all = autoApplyBot.getRunLog();
  return ok(res, {
    log: all.slice(since),
    total: all.length,
    running: batchRunning,
    stopping: autoApplyBot.isStopRequested(),
  });
});

/** Turn "0 9 * * *" into "Today at 09:00" / "Tomorrow at 09:00". */
function describeNextRun(cron) {
  const parts = String(cron || '').trim().split(/\s+/);
  if (parts.length < 5) return 'Not scheduled';

  const [minute, hour] = parts;
  const hh = Number(hour);
  const mm = Number(minute);
  if (Number.isNaN(hh) || Number.isNaN(mm)) return `Cron: ${cron}`;

  const now = new Date();
  const next = new Date(now);
  next.setHours(hh, mm, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);

  const sameDay = next.toDateString() === now.toDateString();
  const time = `${String(next.getHours()).padStart(2, '0')}:${String(next.getMinutes()).padStart(2, '0')}`;
  return sameDay ? `Today at ${time}` : `Tomorrow at ${time}`;
}

/* ------------------------------------------------------------------ *
 * POST /api/apply/:jobId/cover-letter
 * ------------------------------------------------------------------ */

const generateCoverLetter = asyncHandler(async (req, res) => {
  const jobId = toInt(req.params.jobId) || toInt(req.body?.jobId);
  if (!jobId) return fail(res, 'A numeric job id is required', 400);

  const job = loadJob(jobId);
  if (!job) return fail(res, `Job ${jobId} not found`, 404);

  const resume = resolveResume(req.body?.resumeId);
  const tone = toStr(req.body?.tone) || getPrefs().coverLetterTone;

  if (!['professional', 'friendly', 'confident'].includes(tone)) {
    return fail(res, 'Tone must be one of: professional, friendly, confident', 400);
  }

  try {
    const generated = await makeCoverLetter(job, resume || {}, tone, req.body?.forceTemplate === true);

    // Keep any existing application record in sync.
    const app = getDb()
      .prepare('SELECT id FROM applications WHERE job_id = ? ORDER BY id DESC LIMIT 1')
      .get(jobId);
    if (app && req.body?.save !== false) {
      getDb()
        .prepare("UPDATE applications SET cover_letter = ?, last_updated = datetime('now') WHERE id = ?")
        .run(generated.coverLetter, app.id);
    }

    return ok(
      res,
      {
        jobId,
        coverLetter: generated.coverLetter,
        source: generated.source,
        tone,
        resumeUsed: resume ? { id: resume.id, label: resume.label } : null,
        message: generated.message,
      },
      generated.source === 'ai' ? 'Cover letter generated with AI' : 'Cover letter generated from the built-in template'
    );
  } catch (err) {
    logger.error(`Cover letter generation failed: ${err.message}`);
    return fail(res, `Cover letter generation failed: ${err.message}`, 500);
  }
});

/* ------------------------------------------------------------------ *
 * POST /api/apply/:jobId/interview-prep
 * ------------------------------------------------------------------ */

const getInterviewPrep = asyncHandler(async (req, res) => {
  const jobId = toInt(req.params.jobId);
  if (!jobId) return fail(res, 'A numeric job id is required', 400);

  const job = loadJob(jobId);
  if (!job) return fail(res, `Job ${jobId} not found`, 404);

  const resume = resolveResume(req.body?.resumeId);
  const prep = await coverLetterGen.buildInterviewPrep(job, resume || {});

  return ok(
    res,
    { jobId, job: { title: job.title, company: job.company }, questions: prep.questions, source: prep.source },
    `${prep.questions.length} interview questions prepared (${prep.source})`
  );
});

/* ------------------------------------------------------------------ *
 * POST /api/apply/:jobId/follow-up-email
 * ------------------------------------------------------------------ */

const getFollowUpEmail = asyncHandler(async (req, res) => {
  const jobId = toInt(req.params.jobId);
  if (!jobId) return fail(res, 'A numeric job id is required', 400);

  const job = loadJob(jobId);
  if (!job) return fail(res, `Job ${jobId} not found`, 404);

  const resume = resolveResume(req.body?.resumeId);
  const app = getDb()
    .prepare('SELECT applied_at FROM applications WHERE job_id = ? ORDER BY id DESC LIMIT 1')
    .get(jobId);

  const generated = await coverLetterGen.buildFollowUpEmail(job, resume || {}, app?.applied_at);

  return ok(
    res,
    {
      jobId,
      emailDraft: generated.emailDraft,
      source: generated.source,
      appliedAt: app?.applied_at || null,
    },
    'Follow-up email drafted'
  );
});

module.exports = {
  applyManually,
  applyAutomatically,
  runAutoBatch,
  runBatch,
  stopAutoBatch,
  getApplyStatus,
  getApplyLog,
  generateCoverLetter,
  getInterviewPrep,
  getFollowUpEmail,
  createApplication,
  getPrefs,
  resolveResume,
  appliedToday,
  describeNextRun,
  isBatchRunning: () => batchRunning,
  STATUSES,
};
