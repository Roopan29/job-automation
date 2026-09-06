/**
 * backend/scheduler/cronJobs.js
 * ------------------------------------------------------------------
 * Four scheduled jobs, all driven by the preferences row:
 *
 *   1. AUTO-SCRAPE   cron from preferences.scrape_schedule   (default 8 AM)
 *        scrapes every target role × location combination
 *   2. AUTO-APPLY    cron from preferences.auto_apply_schedule (default 9 AM)
 *        only runs when auto_apply_enabled = 1
 *   3. CLEANUP       every night at 00:00
 *        deletes jobs older than 30 days that are neither applied nor bookmarked
 *   4. FOLLOW-UPS    every morning at 08:00
 *        desktop notification for each application due today
 *
 * Schedules are editable in the UI, so `reschedule()` rebuilds the
 * node-cron tasks whenever preferences change. Every job body is also
 * exported so it can be triggered manually (tests, "Run now" buttons).
 */

const cron = require('node-cron');
const log = require('../utils/logger');
const notifier = require('../utils/notifier');
const { getDb } = require('../db/initDB');
const { parseJson, mapJob } = require('../utils/serialize');

const logger = log.scope('Cron');

/** Live node-cron tasks, keyed by job name. */
const tasks = new Map();

/** Guard so a long scrape/apply run is never started twice. */
const running = new Set();

/** Read the preferences row safely. */
function prefs() {
  const row = getDb().prepare('SELECT * FROM preferences WHERE id = 1').get() || {};
  return {
    autoApplyEnabled: Boolean(Number(row.auto_apply_enabled ?? 0)),
    autoApplySchedule: row.auto_apply_schedule || '0 9 * * *',
    autoScrapeEnabled: Boolean(Number(row.auto_scrape_enabled ?? 1)),
    scrapeSchedule: row.scrape_schedule || '0 8 * * *',
    targetRoles: parseJson(row.target_roles, []),
    targetLocations: parseJson(row.target_locations, []),
    scrapeSources: parseJson(row.scrape_sources, ['remoteok', 'remotive', 'linkedin']),
    notifyReminders: Boolean(Number(row.notify_reminders ?? 1)),
    dailyApplyLimit: row.daily_apply_limit ?? 15,
    minMatchScore: row.min_match_score ?? 70,
  };
}

/** Run a job body at most once at a time. */
async function guarded(name, fn) {
  if (running.has(name)) {
    logger.warn(`${name} is still running – skipping this trigger`);
    return null;
  }
  running.add(name);
  const started = Date.now();
  try {
    logger.step(`▶ ${name} started`);
    const result = await fn();
    logger.success(`■ ${name} finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return result;
  } catch (err) {
    logger.error(`${name} failed: ${err.message}`);
    notifier.notifyError(`JobBot — ${name} failed`, err.message.split('\n')[0]);
    return { error: err.message };
  } finally {
    running.delete(name);
  }
}

/* ------------------------------------------------------------------ *
 * Job 1 — auto scrape
 * ------------------------------------------------------------------ */

async function runAutoScrape() {
  return guarded('auto-scrape', async () => {
    const { scrapeAndStore } = require('../controllers/jobController');
    const p = prefs();

    const roles = p.targetRoles.length ? p.targetRoles : ['Software Engineer'];
    const locations = p.targetLocations.length ? p.targetLocations : ['Remote'];

    let found = 0;
    let added = 0;
    const runs = [];

    for (const role of roles.slice(0, 5)) {
      for (const location of locations.slice(0, 5)) {
        const summary = await scrapeAndStore({ query: role, location, sources: p.scrapeSources, limit: 25 });
        found += summary.jobsFound;
        added += summary.jobsAdded;
        runs.push({ role, location, ...summary, sources: summary.sources });
      }
    }

    notifier.notifyScrapeDone(found, added, `${roles.length}×${locations.length} search(es)`);
    return { found, added, runs };
  });
}

/* ------------------------------------------------------------------ *
 * Job 2 — auto apply
 * ------------------------------------------------------------------ */

async function runAutoApply({ force = false } = {}) {
  return guarded('auto-apply', async () => {
    const { runBatch } = require('../controllers/applyController');
    const p = prefs();

    if (!p.autoApplyEnabled && !force) {
      logger.info('Auto-apply is disabled in preferences – nothing to do');
      return { skipped: true, reason: 'auto_apply_enabled is off' };
    }

    const summary = await runBatch({});
    if (summary.error) {
      notifier.notifyError('JobBot — auto-apply could not run', summary.error);
      return { skipped: true, reason: summary.error };
    }

    return summary;
  });
}

/* ------------------------------------------------------------------ *
 * Job 3 — nightly cleanup
 * ------------------------------------------------------------------ */

async function runCleanup(days = 30) {
  return guarded('cleanup', async () => {
    const db = getDb();
    const info = db
      .prepare(
        `DELETE FROM jobs
          WHERE is_applied = 0
            AND is_bookmarked = 0
            AND date(COALESCE(posted_date, scraped_at)) < date('now', ?)`
      )
      .run(`-${days} days`);

    logger.info(`Cleanup removed ${info.changes} stale job(s)`);
    return { deleted: info.changes };
  });
}

/* ------------------------------------------------------------------ *
 * Job 4 — follow-up reminders
 * ------------------------------------------------------------------ */

async function runFollowUpReminders() {
  return guarded('follow-ups', async () => {
    const db = getDb();
    const p = prefs();

    const due = db
      .prepare(
        `SELECT a.id, a.status, j.company, j.title
           FROM applications a LEFT JOIN jobs j ON j.id = a.job_id
          WHERE date(a.follow_up_date) <= date('now')
            AND a.status NOT IN ('rejected','offer','withdrawn')
          ORDER BY a.follow_up_date ASC
          LIMIT 10`
      )
      .all();

    if (!due.length) {
      logger.info('No follow-ups due today');
      return { reminded: 0 };
    }

    if (p.notifyReminders) {
      due.forEach((app) => {
        notifier.notifyFollowUp(app.company || 'A company', app.title || 'role', 'today');
      });
    }

    logger.info(`Sent ${due.length} follow-up reminder(s)`);
    return { reminded: due.length, items: due };
  });
}

/* ------------------------------------------------------------------ *
 * Task lifecycle
 * ------------------------------------------------------------------ */

/** Stop one task if it exists. */
function stopTask(name) {
  const task = tasks.get(name);
  if (task) {
    task.stop();
    tasks.delete(name);
  }
}

/** Stop everything. */
function stopAll() {
  [...tasks.keys()].forEach(stopTask);
  logger.info('All cron jobs stopped');
}

/**
 * (Re)create every task from the current preferences.
 * Safe to call repeatedly – existing tasks are stopped first.
 */
function start() {
  const p = prefs();

  stopTask('scrape');
  stopTask('apply');
  stopTask('cleanup');
  stopTask('follow-ups');

  // 1. auto scrape ------------------------------------------------------
  if (p.autoScrapeEnabled && cron.validate(p.scrapeSchedule)) {
    tasks.set(
      'scrape',
      cron.schedule(p.scrapeSchedule, () => runAutoScrape(), { timezone: process.env.TZ || 'UTC' })
    );
    logger.info(`Auto-scrape scheduled: "${p.scrapeSchedule}"`);
  } else if (!p.autoScrapeEnabled) {
    logger.info('Auto-scrape is disabled in preferences');
  } else {
    logger.warn(`Invalid scrape schedule "${p.scrapeSchedule}" – auto-scrape not scheduled`);
  }

  // 2. auto apply -------------------------------------------------------
  if (cron.validate(p.autoApplySchedule)) {
    tasks.set(
      'apply',
      cron.schedule(p.autoApplySchedule, () => runAutoApply(), { timezone: process.env.TZ || 'UTC' })
    );
    logger.info(
      `Auto-apply scheduled: "${p.autoApplySchedule}" (${p.autoApplyEnabled ? 'enabled' : 'DISABLED in preferences'})`
    );
  } else {
    logger.warn(`Invalid auto-apply schedule "${p.autoApplySchedule}" – auto-apply not scheduled`);
  }

  // 3. nightly cleanup ---------------------------------------------------
  tasks.set('cleanup', cron.schedule('0 0 * * *', () => runCleanup(), { timezone: process.env.TZ || 'UTC' }));
  logger.info('Cleanup scheduled: every night at 00:00');

  // 4. follow-up reminders ------------------------------------------------
  tasks.set(
    'follow-ups',
    cron.schedule('0 8 * * *', () => runFollowUpReminders(), { timezone: process.env.TZ || 'UTC' })
  );
  logger.info('Follow-up reminders scheduled: every day at 08:00');

  return listTasks();
}

/** Alias so "preferences changed" reads clearly at the call site. */
const reschedule = start;

/** Snapshot of what is currently scheduled (for GET /api/system/status). */
function listTasks() {
  const p = prefs();
  return [
    {
      name: 'auto-scrape',
      scheduled: tasks.has('scrape'),
      cron: p.scrapeSchedule,
      enabled: p.autoScrapeEnabled,
      running: running.has('auto-scrape'),
    },
    {
      name: 'auto-apply',
      scheduled: tasks.has('apply'),
      cron: p.autoApplySchedule,
      enabled: p.autoApplyEnabled,
      running: running.has('auto-apply'),
    },
    { name: 'cleanup', scheduled: tasks.has('cleanup'), cron: '0 0 * * *', enabled: true, running: running.has('cleanup') },
    {
      name: 'follow-ups',
      scheduled: tasks.has('follow-ups'),
      cron: '0 8 * * *',
      enabled: p.notifyReminders,
      running: running.has('follow-ups'),
    },
  ];
}

module.exports = {
  start,
  reschedule,
  stopAll,
  stopTask,
  listTasks,
  runAutoScrape,
  runAutoApply,
  runCleanup,
  runFollowUpReminders,
  isRunning: (name) => running.has(name),
};
