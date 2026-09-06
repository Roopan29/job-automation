/**
 * backend/db/initDB.js
 * ------------------------------------------------------------------
 * Creates the SQLite database file and every table used by JobBot.
 *
 *  • Running `node db/initDB.js` directly creates/resets nothing – it
 *    only makes sure the schema exists (safe to run any time).
 *  • `require('./db/initDB')` exposes the shared better-sqlite3 handle
 *    (`getDb()`) which every controller uses.
 *
 * The database file lives at backend/db/database.sqlite and is created
 * automatically the first time the server starts.
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const log = require('../utils/logger');

/** Absolute path of the database file. */
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'database.sqlite');

/** @type {import('better-sqlite3').Database|null} */
let db = null;

/* ------------------------------------------------------------------ *
 * Schema
 * ------------------------------------------------------------------ */

const SCHEMA = `
-- ---------------------------------------------------------------- resumes
CREATE TABLE IF NOT EXISTS resumes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  file_name      TEXT NOT NULL,
  original_name  TEXT NOT NULL,
  file_path      TEXT NOT NULL,
  file_type      TEXT NOT NULL,
  label          TEXT DEFAULT 'My Resume',
  raw_text       TEXT,
  skills         TEXT DEFAULT '[]',
  experience     TEXT DEFAULT '[]',
  education      TEXT DEFAULT '[]',
  summary        TEXT,
  ats_score      INTEGER DEFAULT 0,
  is_default     INTEGER DEFAULT 0,
  -- extras used by the UI (contact card + word count in the ATS report)
  contact_info   TEXT DEFAULT '{}',
  word_count     INTEGER DEFAULT 0,
  uploaded_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ------------------------------------------------------------------- jobs
CREATE TABLE IF NOT EXISTS jobs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  title            TEXT NOT NULL,
  company          TEXT,
  location         TEXT,
  salary           TEXT,
  job_type         TEXT,
  experience_level TEXT,
  description      TEXT,
  requirements     TEXT DEFAULT '[]',
  source           TEXT,
  source_url       TEXT UNIQUE,
  posted_date      TEXT,
  match_score      REAL DEFAULT 0,
  matched_skills   TEXT DEFAULT '[]',
  missing_skills   TEXT DEFAULT '[]',
  is_bookmarked    INTEGER DEFAULT 0,
  is_applied       INTEGER DEFAULT 0,
  scraped_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_jobs_match_score ON jobs(match_score DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_scraped_at  ON jobs(scraped_at);
CREATE INDEX IF NOT EXISTS idx_jobs_applied     ON jobs(is_applied);

-- ---------------------------------------------------------- applications
CREATE TABLE IF NOT EXISTS applications (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id         INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  resume_id      INTEGER REFERENCES resumes(id) ON DELETE SET NULL,
  cover_letter   TEXT,
  status         TEXT DEFAULT 'applied',
  applied_method TEXT DEFAULT 'manual',
  applied_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  follow_up_date DATE,
  interview_date DATE,
  salary_offered TEXT,
  notes          TEXT,
  last_updated   DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_apps_status ON applications(status);
CREATE INDEX IF NOT EXISTS idx_apps_job    ON applications(job_id);

-- -------------------------------------------------------- status_history
CREATE TABLE IF NOT EXISTS status_history (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER REFERENCES applications(id) ON DELETE CASCADE,
  old_status     TEXT,
  new_status     TEXT,
  changed_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  note           TEXT
);

-- ----------------------------------------------------------- preferences
CREATE TABLE IF NOT EXISTS preferences (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  -- personal info (used by the auto-apply bot to fill forms)
  full_name             TEXT DEFAULT '',
  email                 TEXT DEFAULT '',
  phone                 TEXT DEFAULT '',
  linkedin_url          TEXT DEFAULT '',
  portfolio_url         TEXT DEFAULT '',
  location              TEXT DEFAULT '',
  -- job preferences
  target_roles          TEXT DEFAULT '[]',
  target_locations      TEXT DEFAULT '[]',
  min_salary            INTEGER DEFAULT 0,
  max_salary            INTEGER DEFAULT 999999,
  work_type             TEXT DEFAULT 'any',
  experience_level      TEXT DEFAULT 'any',
  -- auto-apply config
  auto_apply_enabled    INTEGER DEFAULT 0,
  daily_apply_limit     INTEGER DEFAULT 15,
  min_match_score       INTEGER DEFAULT 70,
  auto_apply_schedule   TEXT DEFAULT '0 9 * * *',
  auto_apply_sources    TEXT DEFAULT '["indeed","linkedin"]',
  delay_between_applications TEXT DEFAULT '60s',
  -- scraping config
  auto_scrape_enabled   INTEGER DEFAULT 1,
  scrape_schedule       TEXT DEFAULT '0 8 * * *',
  scrape_sources        TEXT DEFAULT '["remoteok","remotive","linkedin"]',
  -- ai / resume / notifications
  default_resume_id     INTEGER,
  generate_cover_letter INTEGER DEFAULT 1,
  cover_letter_tone     TEXT DEFAULT 'professional',
  openai_api_key        TEXT DEFAULT '',
  notify_new_jobs       INTEGER DEFAULT 1,
  notify_reminders      INTEGER DEFAULT 1
);

-- ------------------------------------------------------------ scrape_logs
CREATE TABLE IF NOT EXISTS scrape_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT,
  jobs_found    INTEGER DEFAULT 0,
  jobs_added    INTEGER DEFAULT 0,
  status        TEXT,
  error_message TEXT,
  scraped_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_scrape_logs_at ON scrape_logs(scraped_at DESC);
`;

/**
 * Columns that were introduced after the first release. Adding a column
 * to an existing SQLite table needs ALTER TABLE, so on every boot we
 * check what is actually there and patch anything missing. This keeps
 * upgrading painless – the file is never dropped.
 */
const MIGRATIONS = {
  resumes: [
    ['summary', 'TEXT'],
    ['ats_score', 'INTEGER DEFAULT 0'],
    ['contact_info', "TEXT DEFAULT '{}'"],
    ['word_count', 'INTEGER DEFAULT 0'],
  ],
  jobs: [
    ['salary', 'TEXT'],
    ['experience_level', 'TEXT'],
    ['matched_skills', "TEXT DEFAULT '[]'"],
    ['missing_skills', "TEXT DEFAULT '[]'"],
  ],
  applications: [
    ['interview_date', 'DATE'],
    ['salary_offered', 'TEXT'],
    ['last_updated', 'DATETIME DEFAULT CURRENT_TIMESTAMP'],
  ],
  preferences: [
    ['full_name', "TEXT DEFAULT ''"],
    ['email', "TEXT DEFAULT ''"],
    ['phone', "TEXT DEFAULT ''"],
    ['linkedin_url', "TEXT DEFAULT ''"],
    ['portfolio_url', "TEXT DEFAULT ''"],
    ['location', "TEXT DEFAULT ''"],
    ['auto_apply_sources', 'TEXT DEFAULT \'["indeed","linkedin"]\''],
    ['delay_between_applications', "TEXT DEFAULT '60s'"],
    ['scrape_sources', 'TEXT DEFAULT \'["remoteok","remotive","linkedin"]\''],
    ['openai_api_key', "TEXT DEFAULT ''"],
    ['notify_new_jobs', 'INTEGER DEFAULT 1'],
    ['notify_reminders', 'INTEGER DEFAULT 1'],
    ['cover_letter_tone', "TEXT DEFAULT 'professional'"],
    ['default_resume_id', 'INTEGER'],
  ],
};

/**
 * Open (and memoise) the database connection.
 * @param {{ force?: boolean }} [options] force = drop every table first.
 * @returns {import('better-sqlite3').Database}
 */
function getDb(options = {}) {
  if (db && !options.force) return db;

  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const isFirstRun = !fs.existsSync(DB_PATH);

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL'); // better concurrency, still one file
  db.pragma('foreign_keys = ON');

  if (options.force) {
    log.warn('Force flag set – dropping all JobBot tables');
    db.exec(`
      DROP TABLE IF EXISTS status_history;
      DROP TABLE IF EXISTS applications;
      DROP TABLE IF EXISTS scrape_logs;
      DROP TABLE IF EXISTS preferences;
      DROP TABLE IF EXISTS jobs;
      DROP TABLE IF EXISTS resumes;
    `);
  }

  db.exec(SCHEMA);
  runMigrations(db);
  seedDefaultPreferences(db);

  if (isFirstRun) log.info(`Created SQLite database at ${DB_PATH}`);
  else log.info(`Using SQLite database at ${DB_PATH}`);

  return db;
}

/** Add any columns that a newer version expects but the file lacks. */
function runMigrations(database) {
  Object.entries(MIGRATIONS).forEach(([table, columns]) => {
    const existing = new Set(
      database.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
    );
    columns.forEach(([column, definition]) => {
      if (!existing.has(column)) {
        try {
          database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
          log.info(`Migrated ${table}: added column "${column}"`);
        } catch (err) {
          log.warn(`Could not add ${table}.${column}: ${err.message}`);
        }
      }
    });
  });
}

/** Make sure the singleton preferences row (id = 1) always exists. */
function seedDefaultPreferences(database) {
  const row = database.prepare('SELECT id FROM preferences WHERE id = 1').get();
  if (!row) {
    database.prepare('INSERT INTO preferences (id) VALUES (1)').run();
    log.info('Created default preferences row');
  }
}

/** Close the connection (used by tests and graceful shutdown). */
function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

/* ------------------------------------------------------------------ *
 * Direct execution: `node db/initDB.js`  (or `--force` to wipe)
 * ------------------------------------------------------------------ */
if (require.main === module) {
  const force = process.argv.includes('--force');
  const handle = getDb({ force });
  const tables = handle
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((t) => t.name);

  log.banner('JobBot database ready', [
    `File:   ${DB_PATH}`,
    `Tables: ${tables.join(', ')}`,
    force ? 'Mode:   recreated from scratch' : 'Mode:   created if missing',
  ]);
}

module.exports = { getDb, closeDb, DB_PATH };
