/**
 * backend/controllers/preferenceController.js
 * ------------------------------------------------------------------
 *   GET  /api/preferences          read the singleton row (id = 1)
 *   PUT  /api/preferences          upsert any subset of fields
 *   POST /api/preferences/test-ai  verify the OpenAI key
 *
 * The row is created with defaults by db/initDB.js, so GET never 404s.
 */

const log = require('../utils/logger');
const { ok, fail, asyncHandler } = require('../utils/apiResponse');
const { mapPreferences, parseJson, toJson, toStr, toInt, toNum } = require('../utils/serialize');
const { getDb } = require('../db/initDB');
const aiService = require('../services/aiService');
const { rescoreAllJobs } = require('./jobController');

const logger = log.scope('Prefs');

const TONES = ['professional', 'friendly', 'confident'];
const WORK_TYPES = ['remote', 'hybrid', 'onsite', 'any'];
const LEVELS = ['entry', 'mid', 'senior', 'any'];
const DELAYS = ['30s', '60s', '2min', '5min'];
const ALL_SOURCES = ['indeed', 'linkedin', 'glassdoor', 'remoteok', 'remotive'];

/**
 * Whitelist of editable fields: API name -> { column, kind }.
 * `kind` decides how the incoming value is validated/coerced.
 */
const FIELDS = {
  // personal
  fullName: { column: 'full_name', kind: 'string', max: 120 },
  email: { column: 'email', kind: 'string', max: 160 },
  phone: { column: 'phone', kind: 'string', max: 40 },
  linkedinUrl: { column: 'linkedin_url', kind: 'url', max: 300 },
  portfolioUrl: { column: 'portfolio_url', kind: 'url', max: 300 },
  location: { column: 'location', kind: 'string', max: 120 },

  // job preferences
  targetRoles: { column: 'target_roles', kind: 'array' },
  targetLocations: { column: 'target_locations', kind: 'array' },
  minSalary: { column: 'min_salary', kind: 'int', min: 0, max: 10000000 },
  maxSalary: { column: 'max_salary', kind: 'int', min: 0, max: 10000000 },
  workType: { column: 'work_type', kind: 'enum', values: WORK_TYPES },
  experienceLevel: { column: 'experience_level', kind: 'enum', values: LEVELS },

  // auto-apply
  autoApplyEnabled: { column: 'auto_apply_enabled', kind: 'bool' },
  dailyApplyLimit: { column: 'daily_apply_limit', kind: 'int', min: 1, max: 200 },
  minMatchScore: { column: 'min_match_score', kind: 'int', min: 0, max: 100 },
  autoApplySchedule: { column: 'auto_apply_schedule', kind: 'cron' },
  autoApplySources: { column: 'auto_apply_sources', kind: 'sources' },
  delayBetweenApplications: { column: 'delay_between_applications', kind: 'enum', values: DELAYS },

  // scraping
  autoScrapeEnabled: { column: 'auto_scrape_enabled', kind: 'bool' },
  scrapeSchedule: { column: 'scrape_schedule', kind: 'cron' },
  scrapeSources: { column: 'scrape_sources', kind: 'sources' },

  // ai / resume / notifications
  defaultResumeId: { column: 'default_resume_id', kind: 'id' },
  generateCoverLetter: { column: 'generate_cover_letter', kind: 'bool' },
  coverLetterTone: { column: 'cover_letter_tone', kind: 'enum', values: TONES },
  openaiApiKey: { column: 'openai_api_key', kind: 'string', max: 300, secret: true },
  notifyNewJobs: { column: 'notify_new_jobs', kind: 'bool' },
  notifyReminders: { column: 'notify_reminders', kind: 'bool' },
};

/** Loose cron validation – five space separated fields. */
function isCron(value) {
  const parts = String(value).trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const field = /^(\*|\d{1,2}|\d{1,2}-\d{1,2}|\*\/\d{1,2}|\d{1,2}(,\d{1,2})*)(\/\d{1,2})?$/;
  return parts.every((p) => field.test(p));
}

/** Coerce "true"/"1"/1/true into 0|1. */
function toBoolInt(value) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === 'true' || value === '1' || value === 1) return 1;
  return 0;
}

/** Read the preferences row, creating it if a fresh DB somehow lacks it. */
function getPreferencesRow() {
  const db = getDb();
  let row = db.prepare('SELECT * FROM preferences WHERE id = 1').get();
  if (!row) {
    db.prepare('INSERT INTO preferences (id) VALUES (1)').run();
    row = db.prepare('SELECT * FROM preferences WHERE id = 1').get();
  }
  return row;
}

/* ------------------------------------------------------------------ *
 * GET /api/preferences
 * ------------------------------------------------------------------ */

const getPreferences = asyncHandler(async (req, res) => {
  const row = getPreferencesRow();
  const prefs = mapPreferences(row);

  // Make the effective OpenAI key visible to the UI without leaking it:
  // the DB copy wins, then the .env copy.
  prefs.aiConfigured = aiService.isConfigured();
  prefs.aiModel = aiService.MODEL;

  return ok(res, { preferences: prefs });
});

/* ------------------------------------------------------------------ *
 * PUT /api/preferences
 * ------------------------------------------------------------------ */

const updatePreferences = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const db = getDb();
  getPreferencesRow(); // make sure the row exists

  const sets = [];
  const params = { id: 1 };
  const applied = [];
  const rejected = [];

  Object.entries(FIELDS).forEach(([apiName, spec]) => {
    if (body[apiName] === undefined) return;

    const raw = body[apiName];
    let value;

    try {
      switch (spec.kind) {
        case 'string':
          value = toStr(raw).slice(0, spec.max || 200);
          break;
        case 'url': {
          const url = toStr(raw);
          if (url && !/^https?:\/\//i.test(url)) throw new Error('must start with http:// or https://');
          value = url.slice(0, spec.max || 300);
          break;
        }
        case 'int': {
          const n = toInt(raw);
          if (n === null) throw new Error('must be a whole number');
          if (n < spec.min || n > spec.max) throw new Error(`must be between ${spec.min} and ${spec.max}`);
          value = n;
          break;
        }
        case 'id': {
          const n = toInt(raw);
          if (raw !== null && n === null) throw new Error('must be a resume id or null');
          if (n !== null && !db.prepare('SELECT id FROM resumes WHERE id = ?').get(n)) {
            throw new Error(`resume ${n} does not exist`);
          }
          value = n;
          break;
        }
        case 'bool':
          value = toBoolInt(raw);
          break;
        case 'enum':
          value = String(raw).toLowerCase();
          if (!spec.values.includes(value)) throw new Error(`must be one of: ${spec.values.join(', ')}`);
          break;
        case 'cron':
          if (!isCron(raw)) throw new Error('must be a 5-field cron expression, e.g. "0 9 * * *"');
          value = String(raw).trim();
          break;
        case 'array': {
          const list = Array.isArray(raw) ? raw : String(raw).split(',');
          value = toJson(list.map((v) => toStr(v)).filter(Boolean).slice(0, 30));
          break;
        }
        case 'sources': {
          const list = (Array.isArray(raw) ? raw : String(raw).split(','))
            .map((s) => toStr(s).toLowerCase())
            .filter((s) => ALL_SOURCES.includes(s));
          value = toJson([...new Set(list)]);
          break;
        }
        default:
          value = toStr(raw);
      }
    } catch (err) {
      rejected.push(`${apiName}: ${err.message}`);
      return;
    }

    sets.push(`${spec.column} = @${apiName}`);
    params[apiName] = value;
    applied.push(apiName);
  });

  if (rejected.length && !applied.length) {
    return fail(res, `Invalid preferences – ${rejected.join('; ')}`, 400);
  }

  if (sets.length) {
    db.prepare(`UPDATE preferences SET ${sets.join(', ')} WHERE id = @id`).run(params);
  }

  // --- side effects -----------------------------------------------------

  // A key saved through the UI must take effect immediately.
  if (body.openaiApiKey !== undefined) {
    const key = toStr(body.openaiApiKey);
    aiService.resetClient(key || undefined);
    logger.info(key ? 'OpenAI key saved – AI features enabled' : 'OpenAI key cleared – falling back to templates');
  }

  // Keep resumes.is_default in sync with preferences.default_resume_id.
  if (body.defaultResumeId !== undefined && body.defaultResumeId !== null) {
    const apply = db.transaction(() => {
      db.prepare('UPDATE resumes SET is_default = 0').run();
      db.prepare('UPDATE resumes SET is_default = 1 WHERE id = ?').run(toInt(body.defaultResumeId));
    });
    apply();
    // A different default resume changes every match score.
    rescoreAllJobs();
  }

  // Changing the minimum match score only affects filtering, but changing
  // target locations changes the location bonus – so re-score.
  if (body.targetLocations !== undefined) rescoreAllJobs();

  const row = getPreferencesRow();
  const prefs = mapPreferences(row);
  prefs.aiConfigured = aiService.isConfigured();
  prefs.aiModel = aiService.MODEL;

  logger.info(`Preferences updated: ${applied.join(', ') || 'nothing changed'}`);

  return ok(
    res,
    { preferences: prefs, applied, rejected },
    rejected.length ? `Saved with warnings: ${rejected.join('; ')}` : 'Preferences saved'
  );
});

/* ------------------------------------------------------------------ *
 * POST /api/preferences/test-ai
 * ------------------------------------------------------------------ */

const testAiConnection = asyncHandler(async (req, res) => {
  const result = await aiService.testConnection();

  return res.status(result.ok ? 200 : 400).json({
    success: result.ok,
    data: result,
    message: result.ok ? 'OpenAI connection OK' : `OpenAI connection failed: ${result.message}`,
    ...(result.ok ? {} : { error: result.message, code: 400 }),
  });
});

module.exports = {
  getPreferences,
  updatePreferences,
  testAiConnection,
  getPreferencesRow,
  FIELDS,
};
