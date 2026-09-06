/**
 * backend/controllers/dashboardController.js
 * ------------------------------------------------------------------
 *   GET /api/dashboard
 *
 * One request that returns everything the Dashboard page renders:
 *
 *   { stats, recentApplications, topMatchJobs, resumeCount,
 *     defaultResume, lastScrapeInfo, upcomingFollowUps, skillGaps,
 *     jobCount, bookmarks, aiConfigured }
 */

const { ok, asyncHandler } = require('../utils/apiResponse');
const { mapApplication, mapJob, mapScrapeLog, parseJson, timeAgo } = require('../utils/serialize');
const { getDb } = require('../db/initDB');
const { computeStats } = require('./trackerController');
const { getDefaultResume } = require('./resumeController');
const matchingEngine = require('../services/matchingEngine');
const aiService = require('../services/aiService');

/** Same join the tracker uses, so the shapes match exactly. */
const APPLICATION_SELECT = `
  SELECT a.*,
         j.title, j.company, j.location, j.source, j.source_url,
         j.match_score, j.salary, j.job_type, j.experience_level,
         r.label AS resume_label
    FROM applications a
    LEFT JOIN jobs j     ON j.id = a.job_id
    LEFT JOIN resumes r  ON r.id = a.resume_id
`;

const getDashboard = asyncHandler(async (req, res) => {
  const db = getDb();

  // --- stats ----------------------------------------------------------
  const stats = computeStats();

  // --- recent applications --------------------------------------------
  const recentApplications = db
    .prepare(`${APPLICATION_SELECT} ORDER BY a.applied_at DESC, a.id DESC LIMIT 5`)
    .all()
    .map(mapApplication);

  // --- best unapplied matches ------------------------------------------
  const topMatchJobs = db
    .prepare(
      `SELECT * FROM jobs
        WHERE is_applied = 0
        ORDER BY match_score DESC, id DESC
        LIMIT 5`
    )
    .all()
    .map(mapJob);

  // --- resumes ----------------------------------------------------------
  const resumeCount = db.prepare('SELECT COUNT(*) AS n FROM resumes').get().n;
  const resume = getDefaultResume();

  // --- last scrape -------------------------------------------------------
  const lastLogRow = db
    .prepare('SELECT * FROM scrape_logs ORDER BY scraped_at DESC, id DESC LIMIT 1')
    .get();

  const lastScrapeInfo = lastLogRow
    ? {
        ...mapScrapeLog(lastLogRow),
        ago: timeAgo(lastLogRow.scraped_at),
      }
    : null;

  // --- follow-ups in the next 7 days -------------------------------------
  const upcomingFollowUps = db
    .prepare(
      `${APPLICATION_SELECT}
        WHERE a.follow_up_date IS NOT NULL
          AND date(a.follow_up_date) BETWEEN date('now') AND date('now', '+7 day')
          AND a.status NOT IN ('rejected','offer','withdrawn')
        ORDER BY date(a.follow_up_date) ASC
        LIMIT 10`
    )
    .all()
    .map((row) => {
      const app = mapApplication(row);
      const days = Math.round(
        (new Date(`${app.followUpDate}T00:00:00Z`).getTime() - new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').getTime()) /
          86400000
      );
      return {
        ...app,
        daysRemaining: days,
        daysLabel: days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : `in ${days} days`,
      };
    });

  // --- skill gaps across the strongest unapplied jobs ----------------------
  const gapRows = db
    .prepare(
      `SELECT missing_skills FROM jobs
        WHERE is_applied = 0 AND match_score >= 40
        ORDER BY match_score DESC
        LIMIT 60`
    )
    .all()
    .map((r) => ({ missingSkills: parseJson(r.missing_skills, []) }));

  const skillGaps = matchingEngine.topSkillGaps(gapRows, 6);

  // --- misc counters -------------------------------------------------------
  const jobCount = db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n;
  const bookmarked = db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE is_bookmarked = 1').get().n;
  const readyQueue = db
    .prepare(
      `SELECT COUNT(*) AS n FROM jobs
        WHERE is_applied = 0
          AND match_score >= COALESCE((SELECT min_match_score FROM preferences WHERE id = 1), 70)
          AND source_url IS NOT NULL AND source_url <> ''`
    )
    .get().n;

  return ok(res, {
    stats,
    recentApplications,
    topMatchJobs,
    resumeCount,
    defaultResume: resume
      ? {
          id: resume.id,
          label: resume.label,
          skills: (resume.skills || []).slice(0, 12),
          skillCount: (resume.skills || []).length,
          atsScore: resume.atsScore,
          experienceRoles: (resume.experience || []).length,
          summary: resume.summary,
        }
      : null,
    lastScrapeInfo,
    upcomingFollowUps,
    skillGaps,
    jobCount,
    bookmarked,
    readyQueue,
    aiConfigured: aiService.isConfigured(),
    generatedAt: new Date().toISOString(),
  });
});

module.exports = { getDashboard };
