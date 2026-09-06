/**
 * backend/app.js
 * ------------------------------------------------------------------
 * Express entry point for the JobBot backend.
 *
 * Startup order:
 *   1. load .env
 *   2. create the uploads / db folders
 *   3. create the SQLite file + tables (db/initDB.js)
 *   4. mount every router under /api
 *   5. start the cron jobs
 *   6. listen on PORT (default 5000)
 *
 * Everything is CommonJS so `node app.js` works with no build step.
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');

const log = require('./utils/logger');
const fileHelper = require('./utils/fileHelper');
const notifier = require('./utils/notifier');
const { getDb, closeDb, DB_PATH } = require('./db/initDB');

const app = express();

const PORT = Number(process.env.PORT || 5000);
const HOST = process.env.HOST || '0.0.0.0';

/* ------------------------------------------------------------------ *
 * 1. Boot-time preparation
 * ------------------------------------------------------------------ */

fileHelper.ensureRuntimeDirs();
getDb(); // creates the file + tables on first run

/* ------------------------------------------------------------------ *
 * 2. Middleware
 * ------------------------------------------------------------------ */

// The frontend runs on another port during development, so allow any
// origin. This tool is local-only and has no authentication by design.
app.use(cors({ origin: true, credentials: true }));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// One log line per request, including how long it took.
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - started;
    const line = `${req.method} ${req.originalUrl} → ${res.statusCode} (${ms}ms)`;
    if (res.statusCode >= 500) log.error(line);
    else if (res.statusCode >= 400) log.warn(line);
    else log.info(line);
  });
  next();
});

/* ------------------------------------------------------------------ *
 * 3. Routes
 * ------------------------------------------------------------------ */

app.use('/api/resume', require('./routes/resumeRoutes'));
app.use('/api/jobs', require('./routes/jobRoutes'));
app.use('/api/apply', require('./routes/applyRoutes'));
app.use('/api/tracker', require('./routes/trackerRoutes'));
app.use('/api/preferences', require('./routes/preferenceRoutes'));
app.use('/api/dashboard', require('./routes/dashboardRoutes'));

/** Liveness probe – used by the frontend to show a "backend offline" banner. */
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    data: {
      status: 'ok',
      uptime: Math.round(process.uptime()),
      version: require('./package.json').version,
      database: DB_PATH,
      node: process.version,
      time: new Date().toISOString(),
    },
    message: 'JobBot backend is running',
  });
});

/** Scheduler state + the desktop-notification feed (for headless setups). */
app.get('/api/system/status', (req, res) => {
  const cronJobs = require('./scheduler/cronJobs');
  const autoApplyBot = require('./services/autoApplyBot');
  const aiService = require('./services/aiService');
  const jobScraper = require('./services/jobScraper');

  res.json({
    success: true,
    data: {
      cron: cronJobs.listTasks(),
      automation: autoApplyBot.isStopRequested() ? 'stopping' : 'idle',
      aiConfigured: aiService.isConfigured(),
      aiModel: aiService.MODEL,
      scraperSources: jobScraper.SOURCES,
      headless: autoApplyBot.headlessMode() === 'new',
    },
    message: 'System status',
  });
});

/**
 * GET /api/notifications
 * The in-memory alert feed. Desktop notifications are the primary
 * channel, but a headless machine (Docker, CI, a remote sandbox) has no
 * notification daemon, so the UI polls this instead.
 */
app.get('/api/notifications', (req, res) => {
  const feed = notifier.getFeed();
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  res.json({ success: true, data: { notifications: feed.slice(0, limit), total: feed.length }, message: 'Notification feed' });
});

app.delete('/api/notifications', (req, res) => {
  notifier.clearFeed();
  res.json({ success: true, data: null, message: 'Notification feed cleared' });
});

/** Root – a friendly pointer instead of "Cannot GET /". */
app.get('/', (req, res) => {
  res.json({
    success: true,
    data: {
      name: 'JobBot API',
      endpoints: [
        'GET  /api/health',
        'GET  /api/dashboard',
        'POST /api/resume/upload',
        'GET  /api/resume/all',
        'POST /api/jobs/scrape',
        'GET  /api/jobs',
        'GET  /api/jobs/recommended',
        'POST /api/apply/:jobId',
        'POST /api/apply/:jobId/auto',
        'POST /api/apply/run-auto-batch',
        'GET  /api/apply/status',
        'GET  /api/tracker',
        'GET  /api/tracker/stats',
        'GET  /api/tracker/export/csv',
        'GET  /api/preferences',
        'PUT  /api/preferences',
        'GET  /api/system/status',
        'GET  /api/notifications',
      ],
    },
    message: 'JobBot backend is running. Start the frontend with `npm run dev` in ../frontend',
  });
});

/* ------------------------------------------------------------------ *
 * 4. 404 + error handling
 * ------------------------------------------------------------------ */

app.use('/api', (req, res) => {
  res.status(404).json({
    success: false,
    error: `No API route for ${req.method} ${req.originalUrl}`,
    code: 404,
  });
});

// Anything that escaped a controller (including thrown Errors).
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  log.error(`Unhandled error on ${req.method} ${req.originalUrl}: ${err.message}`);
  if (process.env.NODE_ENV !== 'production') log.error(err.stack);

  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    success: false,
    error: err.message || 'Internal server error',
    code: status,
  });
});

/* ------------------------------------------------------------------ *
 * 5. Start
 * ------------------------------------------------------------------ */

let server = null;

function startServer() {
  server = app.listen(PORT, HOST, () => {
    log.banner('🤖 JobBot backend is live', [
      `API:      http://localhost:${PORT}/api`,
      `Health:   http://localhost:${PORT}/api/health`,
      `Database: ${DB_PATH}`,
      `Uploads:  ${fileHelper.UPLOAD_DIR}`,
      `Env:      ${process.env.NODE_ENV || 'development'}`,
    ]);

    // Cron jobs start after the HTTP server is accepting connections.
    const cronJobs = require('./scheduler/cronJobs');
    cronJobs.start();

    const aiService = require('./services/aiService');
    if (!aiService.isConfigured()) {
      log.warn('OPENAI_API_KEY is not set – cover letters will use the built-in template engine.');
      log.warn('Add your key to backend/.env (or paste it on the Preferences page) to enable AI writing.');
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log.error(`Port ${PORT} is already in use. Stop the other process or set PORT in backend/.env`);
    } else {
      log.error(`Server error: ${err.message}`);
    }
    process.exit(1);
  });

  return server;
}

/** Clean shutdown: stop cron, close the browser and the database. */
async function shutdown(signal) {
  log.info(`${signal} received – shutting down JobBot`);
  try {
    require('./scheduler/cronJobs').stopAll();
  } catch {
    /* ignore */
  }
  try {
    await require('./services/autoApplyBot').closeBrowser();
  } catch {
    /* ignore */
  }
  try {
    await require('./services/jobScraper').closeBrowser();
  } catch {
    /* ignore */
  }
  try {
    closeDb();
  } catch {
    /* ignore */
  }
  if (server) server.close();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  log.error(`Unhandled promise rejection: ${reason?.message || reason}`);
});

if (require.main === module) startServer();

module.exports = { app, startServer, shutdown };
