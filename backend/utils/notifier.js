/**
 * utils/notifier.js
 * ------------------------------------------------------------------
 * Desktop notification helper.
 *
 * Tries, in order:
 *   1. node-notifier (works out of the box on macOS + Windows, and on
 *      Linux when `notify-send` is installed)
 *   2. `notify-send` / `osascript` / PowerShell directly
 *   3. The terminal (always works, including inside Docker / CI / a
 *      headless sandbox where there is no desktop session at all)
 *
 * Every notification is also pushed into a small in-memory ring buffer
 * so the web UI can display the same alerts (see GET /api/notifications).
 * That is what makes CAPTCHA warnings usable when the tool runs on a
 * machine that has no notification daemon.
 */

const { exec } = require('child_process');
const log = require('./logger');

let notifier = null;
let notifierBroken = false;

/** Lazily require node-notifier so a broken install can never crash boot. */
function getNotifier() {
  if (notifier || notifierBroken) return notifier;
  try {
    notifier = require('node-notifier');
  } catch (err) {
    notifierBroken = true;
    log.warn(`node-notifier unavailable (${err.message}) – using terminal fallback`);
  }
  return notifier;
}

/** In-memory alert feed, newest last. Capped at 200 entries. */
const FEED_LIMIT = 200;
const feed = [];

/** Push an alert into the in-memory feed. */
function pushFeed(title, message, level) {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    title,
    message,
    level, // info | success | warning | error
    at: new Date().toISOString(),
  };
  feed.push(entry);
  if (feed.length > FEED_LIMIT) feed.shift();
  return entry;
}

/** Read the alert feed (optionally newest first). */
function getFeed(newestFirst = true) {
  return newestFirst ? [...feed].reverse() : [...feed];
}

/** Clear the alert feed. */
function clearFeed() {
  feed.length = 0;
}

/** Platform specific fallback used when node-notifier cannot display. */
function shellNotify(title, message) {
  const platform = process.platform;
  const safe = (s) => String(s).replace(/["'`$\\]/g, '');

  if (platform === 'darwin') {
    exec(
      `osascript -e 'display notification "${safe(message)}" with title "${safe(title)}"'`,
      (err) => err && log.debug('osascript notification failed:', err.message)
    );
    return;
  }

  if (platform === 'win32') {
    const ps =
      `[reflection.assembly]::loadwithpartialname('System.Windows.Forms')|Out-Null;` +
      `$n=New-Object System.Windows.Forms.NotifyIcon;` +
      `$n.Icon=[System.Drawing.SystemIcons]::Information;$n.Visible=$true;` +
      `$n.ShowBalloonTip(8000,'${safe(title)}','${safe(message)}',[System.Windows.Forms.ToolTipIcon]::Info)`;
    exec(`powershell -command "${ps}"`, (err) =>
      err ? log.debug('PowerShell notification failed:', err.message) : undefined
    );
    return;
  }

  // Linux / *BSD
  exec(`notify-send "${safe(title)}" "${safe(message)}"`, (err) => {
    if (err) log.debug('notify-send unavailable:', err.message);
  });
}

/**
 * Show a desktop notification.
 *
 * Never throws: notifications are a nicety, they must not break a
 * scrape run or an application attempt.
 *
 * @param {string} title
 * @param {string} message
 * @param {object} [opts]
 * @param {'info'|'success'|'warning'|'error'} [opts.level]
 * @param {boolean} [opts.sound] play the system sound
 * @returns {{title:string,message:string,level:string,at:string}} the feed entry
 */
function notify(title, message, opts = {}) {
  const level = opts.level || 'info';
  const entry = pushFeed(title, message, level);

  // Always echo to the terminal – useful in headless environments.
  const icon = { info: 'ℹ️', success: '✅', warning: '⚠️', error: '❌' }[level];
  log.info(`${icon}  ${title} — ${message}`);

  const n = getNotifier();
  if (n) {
    try {
      n.notify({ title, message, sound: opts.sound !== false }, (err) => {
        if (err) {
          notifierBroken = true;
          shellNotify(title, message);
        }
      });
      return entry;
    } catch (err) {
      notifierBroken = true;
      log.debug('node-notifier threw, falling back:', err.message);
    }
  }

  shellNotify(title, message);
  return entry;
}

/* ------------------------------------------------------------------ *
 * Convenience wrappers for the events the tool actually raises
 * ------------------------------------------------------------------ */

/** "✅ Scraped 47 new jobs from RemoteOK" */
const notifyScrapeDone = (jobsFound, jobsAdded, source) =>
  notify(
    'JobBot — scrape finished',
    `Scraped ${jobsFound} jobs (${jobsAdded} new) from ${source}`,
    { level: 'success' }
  );

/** "✅ Applied to 8 jobs today (2 failed, 1 CAPTCHA)" */
const notifyAutoApplyDone = ({ attempted = 0, succeeded = 0, failed = 0, captchaHit = 0 } = {}) =>
  notify(
    'JobBot — auto-apply finished',
    `Applied to ${succeeded}/${attempted} jobs · ${failed} failed · ${captchaHit} CAPTCHA`,
    { level: succeeded ? 'success' : 'warning' }
  );

/** CAPTCHA wall – the user has to step in. */
const notifyCaptcha = (company = 'a job site') =>
  notify(
    '⚠️ CAPTCHA detected!',
    `${company} is showing a CAPTCHA. Please complete it manually in the open browser window.`,
    { level: 'warning', sound: true }
  );

/** Daily follow-up reminder. */
const notifyFollowUp = (company, role, daysLabel = 'today') =>
  notify(
    '📮 Follow-up reminder',
    `${company} — ${role} is due ${daysLabel}. Send that follow-up email!`,
    { level: 'info' }
  );

/** A batch of shiny new matches. */
const notifyNewMatches = (count) =>
  notify('🎯 New matches found', `${count} new job(s) match your resume.`, {
    level: 'success',
  });

/** Anything that went sideways. */
const notifyError = (title, message) => notify(title, message, { level: 'error', sound: true });

module.exports = {
  notify,
  notifyScrapeDone,
  notifyAutoApplyDone,
  notifyCaptcha,
  notifyFollowUp,
  notifyNewMatches,
  notifyError,
  getFeed,
  clearFeed,
};
