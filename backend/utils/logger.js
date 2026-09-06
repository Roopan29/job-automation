/**
 * utils/logger.js
 * ------------------------------------------------------------------
 * A tiny, dependency-free console logger used across the whole backend.
 *
 * Every line is prefixed with a timestamp + level + (optional) scope so
 * that long running jobs (scrapers, auto-apply bot, cron) are easy to
 * follow in the terminal.
 *
 * Usage:
 *   const log = require('./logger');
 *   log.info('Scraper', 'found 12 jobs');
 *   log.error('AutoApply', 'browser crashed', err);
 */

const COLORS = {
  reset: '\x1b[0m',
  gray: '\x1b[90m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

/** True when NODE_ENV is not "production". */
const IS_DEV = process.env.NODE_ENV !== 'production';

/**
 * Build the "[HH:MM:SS] LEVEL  [scope]" prefix.
 * @param {string} level
 * @param {string} [scope]
 * @returns {string}
 */
function prefix(level, scope) {
  const time = new Date().toISOString().replace('T', ' ').slice(11, 19);
  const color =
    {
      INFO: COLORS.green,
      WARN: COLORS.yellow,
      ERROR: COLORS.red,
      DEBUG: COLORS.gray,
      SUCCESS: COLORS.cyan,
      STEP: COLORS.blue,
    }[level] || COLORS.reset;

  const scopePart = scope ? ` ${COLORS.magenta}[${scope}]${COLORS.reset}` : '';
  return `${COLORS.gray}${time}${COLORS.reset} ${color}${level.padEnd(7)}${COLORS.reset}${scopePart}`;
}

/** Write a formatted line to stdout. */
function write(level, scope, args) {
  const fn = level === 'ERROR' ? console.error : console.log;
  fn(prefix(level, scope), ...args);
}

module.exports = {
  info: (...args) => write('INFO', undefined, args),
  warn: (...args) => write('WARN', undefined, args),
  error: (...args) => write('ERROR', undefined, args),
  debug: (...args) => IS_DEV && write('DEBUG', undefined, args),

  /** Scoped logger: log.scope('Scraper').info('...') */
  scope(name) {
    return {
      info: (...args) => write('INFO', name, args),
      warn: (...args) => write('WARN', name, args),
      error: (...args) => write('ERROR', name, args),
      debug: (...args) => IS_DEV && write('DEBUG', name, args),
      success: (...args) => write('SUCCESS', name, args),
      step: (...args) => write('STEP', name, args),
    };
  },

  /**
   * Print a boxed banner. Used on server startup so the console output
   * looks intentional rather than a random pile of logs.
   * @param {string} title
   * @param {string[]} [lines]
   */
  banner(title, lines = []) {
    const width = Math.max(46, title.length + 8, ...lines.map((l) => l.length + 4));
    const bar = '═'.repeat(width);
    console.log(`\n${COLORS.cyan}╔${bar}╗${COLORS.reset}`);
    console.log(`${COLORS.cyan}║${COLORS.reset} ${title.padEnd(width - 2)} ${COLORS.cyan}║${COLORS.reset}`);
    console.log(`${COLORS.cyan}╚${bar}╝${COLORS.reset}`);
    lines.forEach((l) => console.log(`   ${COLORS.gray}•${COLORS.reset} ${l}`));
    console.log('');
  },
};
