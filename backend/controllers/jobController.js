/**
 * backend/controllers/jobController.js
 * ------------------------------------------------------------------
 *   POST   /api/jobs/scrape              run the scraper + score + store
 *   GET    /api/jobs                     filter / sort / paginate
 *   GET    /api/jobs/recommended         best unapplied matches
 *   GET    /api/jobs/:id                 full job detail
 *   GET    /api/jobs/:id/match-details   why it scored what it did
 *   POST   /api/jobs/:id/bookmark        toggle bookmark
 *   DELETE /api/jobs/clear-old           purge stale, untouched jobs
 *   GET    /api/jobs/scrape/logs         recent scrape runs
 */

const log = require('../utils/logger');
const { ok, fail, asyncHandler } = require('../utils/apiResponse');
const { mapJob, mapScrapeLog, parseJson, toJson, toStr, toInt, toNum } = require('../utils/serialize');
const { getDb } = require('../db/initDB');
const jobScraper = require('../services/jobScraper');
const matchingEngine = require('../services/matchingEngine');
const notifier = require('../utils/notifier');
const { getDefaultResume } = require('./resumeController');

const logger = log.scope('Jobs');

const VALID_SORTS = {
  match: 'match_score DESC',
  score: 'match_score DESC',
  date: "date(COALESCE(posted_date, scraped_at)) DESC",
  posted: "date(COALESCE(posted_date, scraped_at)) DESC",
  company: 'company COLLATE NOCASE ASC',
  title: 'title COLLATE NOCASE ASC',
};

/** Read the singleton preferences row as a plain object. */
function prefs() {
  const row = getDb().prepare('SELECT * FROM preferences WHERE id = 1').get() || {};
  return {
    minMatchScore: row.min_match_score ?? 70,
    targetLocations: parseJson(row.target_locations, []),
    targetRoles: parseJson(row.target_roles, []),
    workType: row.work_type || 'any',
    experienceLevel: row.experience_level || 'any',
    minSalary: row.min_salary ?? 0,
    notifyNewJobs: Boolean(row.notify_new_jobs),
  };
}

/* ------------------------------------------------------------------ *
 * Insert / update helpers
 * ------------------------------------------------------------------ */

/**
 * Persist one scraped job.
 * Duplicates are detected on source_url (UNIQUE) – a repeat scrape
 * refreshes the description but never creates a second row.
 *
 * @returns {'added'|'updated'|'skipped'}
 */
function upsertJob(job, resume) {
  const db = getDb();

  const match = resume ? matchingEngine.matchJobToResume(job, resume, { preferredLocations: prefs().targetLocations }) : null;

  const existing = job.source_url
    ? db.prepare('SELECT id FROM jobs WHERE source_url = ?').get(job.source_url)
    : null;

  if (existing) {
    db.prepare(
      `UPDATE jobs SET
         title = @title, company = @company, location = @location, salary = @salary,
         job_type = @job_type, experience_level = @experience_level,
         description = CASE WHEN length(@description) > length(COALESCE(description,''))
                            THEN @description ELSE description END,
         requirements = @requirements, posted_date = @posted_date,
         match_score = @match_score, matched_skills = @matched_skills, missing_skills = @missing_skills
       WHERE id = @id`
    ).run({
      id: existing.id,
      title: job.title,
      company: job.company,
      location: job.location,
      salary: job.salary || '',
      job_type: job.job_type,
      experience_level: job.experience_level,
      description: job.description || '',
      requirements: job.requirements,
      posted_date: job.posted_date,
      match_score: match ? match.matchScore : 0,
      matched_skills: toJson(match ? match.matchedSkills : []),
      missing_skills: toJson(match ? match.missingSkills : []),
    });
    return 'updated';
  }

  db.prepare(
    `INSERT INTO jobs
       (title, company, location, salary, job_type, experience_level, description,
        requirements, source, source_url, posted_date, match_score, matched_skills, missing_skills)
     VALUES
       (@title, @company, @location, @salary, @job_type, @experience_level, @description,
        @requirements, @source, @source_url, @posted_date, @match_score, @matched_skills, @missing_skills)`
  ).run({
    title: job.title,
    company: job.company,
    location: job.location,
    salary: job.salary || '',
    job_type: job.job_type,
    experience_level: job.experience_level,
    description: job.description || '',
    requirements: job.requirements,
    source: job.source,
    source_url: job.source_url || null,
    posted_date: job.posted_date,
    match_score: match ? match.matchScore : 0,
    matched_skills: toJson(match ? match.matchedSkills : []),
    missing_skills: toJson(match ? match.missingSkills : []),
  });

  return 'added';
}

/**
 * Re-score every stored job against the current default resume.
 * Called after a resume upload/delete so the UI never shows stale scores.
 */
function rescoreAllJobs() {
  const db = getDb();
  const resume = getDefaultResume();
  const jobs = db.prepare('SELECT * FROM jobs').all();

  const update = db.prepare(
    'UPDATE jobs SET match_score = ?, matched_skills = ?, missing_skills = ? WHERE id = ?'
  );

  const run = db.transaction(() => {
    jobs.forEach((row) => {
      const job = mapJob(row);
      const match = resume
        ? matchingEngine.matchJobToResume(job, resume, { preferredLocations: prefs().targetLocations })
        : { matchScore: 0, matchedSkills: [], missingSkills: [] };
      update.run(match.matchScore, toJson(match.matchedSkills), toJson(match.missingSkills), row.id);
    });
  });
  run();

  logger.info(`Re-scored ${jobs.length} job(s) against the default resume`);
  return jobs.length;
}

/* ------------------------------------------------------------------ *
 * Scraping (shared by the HTTP endpoint and the cron scheduler)
 * ------------------------------------------------------------------ */

/**
 * Scrape the requested sources, score every job against the default
 * resume, persist the results and write one scrape_logs row per source.
 *
 * @param {object} options
 * @param {string} [options.query]
 * @param {string} [options.location]
 * @param {string[]} [options.sources]  falls back to preferences
 * @param {number} [options.limit]
 * @param {boolean} [options.useBrowser]
 * @param {boolean} [options.notify]    fire desktop notifications
 * @returns {Promise<object>} scrape summary
 */
async function scrapeAndStore(options = {}) {
  const db = getDb();

  const query = toStr(options.query) || prefs().targetRoles[0] || 'Software Engineer';
  const location = toStr(options.location) || prefs().targetLocations[0] || 'Remote';

  const configuredSources = parseJson(
    db.prepare('SELECT scrape_sources FROM preferences WHERE id = 1').get()?.scrape_sources,
    ['remoteok', 'remotive', 'linkedin']
  );
  const sources = (Array.isArray(options.sources) && options.sources.length ? options.sources : configuredSources)
    .map((s) => String(s).toLowerCase().trim())
    .filter(Boolean);

  const limit = Math.min(100, Math.max(1, toInt(options.limit, 25)));
  const useBrowser = options.useBrowser !== false;
  const shouldNotify = options.notify !== false;

  logger.info(`Scraping "${query}" in ${location} from [${sources.join(', ')}]`);

  const outcome = await jobScraper.scrapeJobs({ query, location, sources, limit, useBrowser });

  const resume = getDefaultResume();
  if (!resume) logger.warn('No resume uploaded yet – jobs will be stored with a 0% match score');

  let jobsAdded = 0;
  let jobsUpdated = 0;

  const persist = db.transaction(() => {
    outcome.jobs.forEach((job) => {
      const result = upsertJob(job, resume);
      if (result === 'added') jobsAdded += 1;
      if (result === 'updated') jobsUpdated += 1;
    });
  });
  persist();

  // One scrape_logs row per source so the UI can show per-source health.
  const insertLog = db.prepare(
    `INSERT INTO scrape_logs (source, jobs_found, jobs_added, status, error_message)
     VALUES (?, ?, ?, ?, ?)`
  );
  const logAll = db.transaction(() => {
    outcome.results.forEach((r) => {
      insertLog.run(
        jobScraper.SOURCE_LABELS[r.source] || r.source,
        r.found || 0,
        r.status === 'success' ? jobsAdded : 0,
        r.status === 'success' ? 'success' : r.status === 'skipped' ? 'partial' : 'failed',
        r.error || null
      );
    });
    if (outcome.results.length === 0) {
      insertLog.run('none', 0, 0, 'failed', 'No sources were requested');
    }
  });
  logAll();

  const succeeded = outcome.results.filter((r) => r.status === 'success');
  const allFailed = outcome.results.length > 0 && succeeded.length === 0;

  if (shouldNotify && jobsAdded > 0 && prefs().notifyNewJobs) notifier.notifyNewMatches(jobsAdded);
  if (shouldNotify && succeeded.length) {
    notifier.notifyScrapeDone(outcome.totalFound, jobsAdded, succeeded.map((s) => s.source).join(', '));
  }

  const message = allFailed
    ? `No jobs could be fetched. ${outcome.results
        .map((r) => `${r.source}: ${r.error || 'failed'}`)
        .join(' | ')}`
    : `Scraped ${outcome.totalFound} job(s) — ${jobsAdded} new, ${jobsUpdated} refreshed in ${Math.round(
        outcome.durationMs / 1000
      )}s`;

  logger.info(message);

  return {
    ok: !allFailed,
    message,
    query,
    location,
    sources: outcome.results,
    jobsFound: outcome.totalFound,
    jobsAdded,
    jobsUpdated,
    duration: Math.round(outcome.durationMs),
    resumeUsed: resume ? { id: resume.id, label: resume.label } : null,
  };
}

/* ------------------------------------------------------------------ *
 * POST /api/jobs/scrape
 * ------------------------------------------------------------------ */

const scrapeJobs = asyncHandler(async (req, res) => {
  let summary;
  try {
    summary = await scrapeAndStore({
      query: req.body?.query,
      location: req.body?.location,
      sources: Array.isArray(req.body?.sources) ? req.body.sources : undefined,
      limit: req.body?.limit,
      useBrowser: req.body?.useBrowser !== false,
    });
  } catch (err) {
    logger.error(`Scrape crashed: ${err.message}`);
    return fail(res, `Scraping failed: ${err.message}`, 500);
  }

  if (!summary.ok) {
    // Every source failed – report it as an upstream error, but still
    // include the per-source detail so the UI can explain what happened.
    return res.status(502).json({
      success: false,
      error: summary.message,
      code: 502,
      data: { ...summary, sources: summary.sources },
    });
  }

  return ok(res, summary, summary.message);
});

/* ------------------------------------------------------------------ *
 * GET /api/jobs
 * ------------------------------------------------------------------ */

const listJobs = asyncHandler(async (req, res) => {
  const db = getDb();
  const page = Math.max(1, toInt(req.query.page, 1));
  const limit = Math.min(100, Math.max(1, toInt(req.query.limit, 20)));
  const sort = VALID_SORTS[String(req.query.sort || 'match').toLowerCase()] || VALID_SORTS.match;

  const where = [];
  const params = {};

  const q = toStr(req.query.q);
  if (q) {
    where.push('(title LIKE @q OR company LIKE @q OR description LIKE @q OR location LIKE @q)');
    params.q = `%${q}%`;
  }

  const location = toStr(req.query.location);
  if (location) {
    where.push('location LIKE @location');
    params.location = `%${location}%`;
  }

  const jobType = toStr(req.query.jobType).toLowerCase();
  if (jobType && jobType !== 'any') {
    where.push('lower(job_type) = @jobType');
    params.jobType = jobType;
  }

  const level = toStr(req.query.experienceLevel).toLowerCase();
  if (level && level !== 'any') {
    where.push('lower(experience_level) = @level');
    params.level = level;
  }

  const minScore = toNum(req.query.minScore);
  if (minScore !== null) {
    where.push('match_score >= @minScore');
    params.minScore = minScore;
  }

  const source = toStr(req.query.source);
  if (source && source !== 'any') {
    where.push('source = @source');
    params.source = source;
  }

  if (req.query.bookmarked === 'true' || req.query.bookmarked === '1') where.push('is_bookmarked = 1');
  if (req.query.applied === 'false' || req.query.applied === '0') where.push('is_applied = 0');
  if (req.query.applied === 'true' || req.query.applied === '1') where.push('is_applied = 1');

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM jobs ${whereSql}`).get(params).n;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  /*
   * Clamp an out-of-range page. Without this, ?page=999 echoes page:999 next
   * to totalPages:3 with an empty list — a self-contradictory response that
   * makes a client render "page 999 of 3" with nothing to show. Clamping
   * means a stale or hand-edited page number lands on the last real page.
   */
  const safePage = Math.min(page, totalPages);

  const rows = db
    .prepare(
      `SELECT * FROM jobs ${whereSql} ORDER BY ${sort}, id DESC LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit, offset: (safePage - 1) * limit });

  return ok(res, {
    jobs: rows.map(mapJob),
    total,
    page: safePage,
    limit,
    totalPages,
  }, `${total} job(s) match your filters`);
});

/* ------------------------------------------------------------------ *
 * GET /api/jobs/recommended
 * ------------------------------------------------------------------ */

const recommendedJobs = asyncHandler(async (req, res) => {
  const db = getDb();
  const minScore = toNum(req.query.minScore) ?? prefs().minMatchScore;
  const limit = Math.min(100, Math.max(1, toInt(req.query.limit, 50)));

  const rows = db
    .prepare(
      `SELECT * FROM jobs
        WHERE is_applied = 0 AND match_score >= @minScore
        ORDER BY match_score DESC, id DESC
        LIMIT @limit`
    )
    .all({ minScore, limit });

  return ok(
    res,
    {
      jobs: rows.map(mapJob),
      total: rows.length,
      minMatchScore: minScore,
    },
    `${rows.length} recommended job(s) scoring ${minScore}% or higher`
  );
});

/* ------------------------------------------------------------------ *
 * GET /api/jobs/:id
 * ------------------------------------------------------------------ */

const getJobById = asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  if (!id) return fail(res, 'A numeric job id is required', 400);

  const row = getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  if (!row) return fail(res, `Job ${id} not found`, 404);

  const job = mapJob(row);
  const resume = getDefaultResume();
  const details = resume
    ? matchingEngine.matchJobToResume(job, resume, { preferredLocations: prefs().targetLocations })
    : null;

  return ok(res, {
    job,
    match: details
      ? {
          ...details,
          explanation: matchingEngine.explainMatch(details),
        }
      : null,
    applied: db_hasApplication(id),
  });
});

/** Has the user already applied to this job? */
function db_hasApplication(jobId) {
  return Boolean(
    getDb().prepare('SELECT id FROM applications WHERE job_id = ? LIMIT 1').get(jobId)
  );
}

/* ------------------------------------------------------------------ *
 * GET /api/jobs/:id/match-details
 * ------------------------------------------------------------------ */

const getMatchDetails = asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  if (!id) return fail(res, 'A numeric job id is required', 400);

  const row = getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  if (!row) return fail(res, `Job ${id} not found`, 404);

  const job = mapJob(row);
  const resume = getDefaultResume();

  if (!resume) {
    return ok(res, {
      jobId: id,
      matchScore: job.matchScore,
      matchedSkills: [],
      missingSkills: job.missingSkills,
      suggestions: ['Upload a resume to see a detailed match breakdown.'],
      message: 'No resume uploaded yet',
    });
  }

  const details = matchingEngine.matchJobToResume(job, resume, {
    preferredLocations: prefs().targetLocations,
  });

  const suggestions = [];
  if (details.missingSkills.length) {
    suggestions.push(
      `Learning ${details.missingSkills.slice(0, 3).join(', ')} would lift this match the most.`
    );
  }
  if (details.breakdown.requiredYears && details.breakdown.yourYears < details.breakdown.requiredYears) {
    suggestions.push(
      `They ask for ${details.breakdown.requiredYears}+ years and your parsed history shows about ${details.breakdown.yourYears}. Emphasise scope and impact over tenure.`
    );
  }
  if (details.breakdown.titleBonus < 6) {
    suggestions.push('Your resume does not repeat the job title – mirror their wording in your summary.');
  }
  if (!suggestions.length) suggestions.push('Strong match – tailor the cover letter and apply.');

  return ok(res, {
    jobId: id,
    matchScore: details.matchScore,
    matchedSkills: details.matchedSkills,
    missingSkills: details.missingSkills,
    requiredSkills: details.requiredSkills,
    breakdown: details.breakdown,
    explanation: matchingEngine.explainMatch(details),
    suggestions,
    resume: { id: resume.id, label: resume.label },
  });
});

/* ------------------------------------------------------------------ *
 * POST /api/jobs/:id/bookmark
 * ------------------------------------------------------------------ */

const toggleBookmark = asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  if (!id) return fail(res, 'A numeric job id is required', 400);

  const db = getDb();
  const row = db.prepare('SELECT id, is_bookmarked, title, company FROM jobs WHERE id = ?').get(id);
  if (!row) return fail(res, `Job ${id} not found`, 404);

  const next = row.is_bookmarked ? 0 : 1;
  db.prepare('UPDATE jobs SET is_bookmarked = ? WHERE id = ?').run(next, id);

  logger.info(`${next ? 'Bookmarked' : 'Unbookmarked'} job #${id} (${row.company} – ${row.title})`);

  return ok(
    res,
    { jobId: id, bookmarked: Boolean(next) },
    next ? `Bookmarked "${row.title}" at ${row.company}` : `Removed bookmark from "${row.title}"`
  );
});

/* ------------------------------------------------------------------ *
 * DELETE /api/jobs/clear-old
 * ------------------------------------------------------------------ */

const clearOldJobs = asyncHandler(async (req, res) => {
  const days = Math.max(1, toInt(req.query.days ?? req.body?.days, 30));
  const db = getDb();

  const info = db
    .prepare(
      `DELETE FROM jobs
        WHERE is_applied = 0
          AND is_bookmarked = 0
          AND date(COALESCE(posted_date, scraped_at)) < date('now', ?)`
    )
    .run(`-${days} days`);

  logger.info(`Cleared ${info.changes} job(s) older than ${days} days`);

  return ok(
    res,
    { deleted: info.changes, olderThanDays: days },
    `${info.changes} stale job(s) removed`
  );
});

/* ------------------------------------------------------------------ *
 * GET /api/jobs/scrape/logs
 * ------------------------------------------------------------------ */

const getScrapeLogs = asyncHandler(async (req, res) => {
  const limit = Math.min(100, Math.max(1, toInt(req.query.limit, 20)));
  const rows = getDb()
    .prepare('SELECT * FROM scrape_logs ORDER BY scraped_at DESC, id DESC LIMIT ?')
    .all(limit);

  const last = rows[0] || null;

  return ok(res, {
    logs: rows.map(mapScrapeLog),
    lastScrape: last
      ? { source: last.source, scrapedAt: last.scraped_at, jobsFound: last.jobs_found, jobsAdded: last.jobs_added, status: last.status }
      : null,
  });
});

module.exports = {
  scrapeJobs,
  scrapeAndStore,
  listJobs,
  recommendedJobs,
  getJobById,
  getMatchDetails,
  toggleBookmark,
  clearOldJobs,
  getScrapeLogs,
  upsertJob,
  rescoreAllJobs,
};
