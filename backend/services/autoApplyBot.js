/**
 * backend/services/autoApplyBot.js
 * ------------------------------------------------------------------
 * Drives a real Chromium window through a job application form.
 *
 *   applyToJob({ jobUrl, resumePath, coverLetter, jobSource, contact, onEvent })
 *     -> { success, appliedAt, error, captchaHit, steps[] }
 *
 * What it does
 *   1. Launches Chromium (headful by default so the user can watch and
 *      step in for a CAPTCHA; falls back to headless when there is no
 *      display, e.g. inside a container).
 *   2. Opens the job URL and clicks through to the application form,
 *      using a per-source strategy (Indeed / LinkedIn) plus a generic
 *      fallback that works on most plain application pages.
 *   3. Fills name / email / phone / location from preferences, uploads
 *      the resume PDF, pastes the cover letter, and answers common
 *      screening questions with configurable defaults.
 *   4. Watches for reCAPTCHA / hCaptcha / Cloudflare challenges. When
 *      one appears it raises a desktop notification and waits up to
 *      CAPTCHA_TIMEOUT_MS for the human to solve it.
 *   5. Submits, then waits a random 30–60 s before the next job so we
 *      do not look like a bot hammering the site.
 *
 * It is deliberately defensive: any selector that is missing is skipped
 * rather than fatal, and the whole run always resolves to a result
 * object so a caller can log and continue with the next job.
 */

const path = require('path');
const fs = require('fs');
const log = require('../utils/logger');
const notifier = require('../utils/notifier');

const logger = log.scope('AutoApply');

const CAPTCHA_TIMEOUT_MS = Number(process.env.CAPTCHA_TIMEOUT_MS || 5 * 60 * 1000); // 5 minutes
const CAPTCHA_POLL_MS = 3000;
const NAV_TIMEOUT_MS = Number(process.env.NAV_TIMEOUT_MS || 45000);
const USER_AGENT =
  process.env.PUPPETEER_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** Default answers for common screening questions. */
const DEFAULT_SCREENING_ANSWERS = {
  authorization: 'Yes, I am legally authorized to work in the country of the position.',
  sponsorship: 'No, I do not require sponsorship now or in the future.',
  experienceYears: '5',
  salaryExpectation: '',
  noticePeriod: 'Two weeks',
  relocation: 'Yes, I am open to relocation.',
  start: 'I am available to start within two weeks.',
};

/* ------------------------------------------------------------------ *
 * Browser lifecycle
 * ------------------------------------------------------------------ */

/** @type {Promise<import('puppeteer').Browser>|null} */
let browserPromise = null;
let launchError = null;

/** Can a display be used? (headful needs X11/Wayland/Windows/macOS) */
function canRunHeadful() {
  if (process.platform !== 'linux') return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/** Should we run headful? Defaults to yes when a display exists. */
function headlessMode() {
  const env = (process.env.PUPPETEER_HEADLESS || '').toLowerCase();
  if (env === 'true' || env === '1' || env === 'new') return 'new';
  if (env === 'false' || env === '0') return false;
  return canRunHeadful() ? false : 'new'; // auto
}

function launchArgs() {
  return [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1366,900',
    '--lang=en-US',
    `--user-agent=${USER_AGENT}`,
  ];
}

/**
 * Turn a Puppeteer launch failure into a single readable line.
 *
 * Puppeteer reports "Chrome not found" as a multi-line message whose first
 * line ends mid-sentence ("This can occur if either") — the actual fix is
 * on the following lines. Taking only line 0 produced a truncated,
 * unhelpful error, so collapse the whole message instead and cap it.
 *
 * @param {Error} err
 * @returns {string} one-line summary, max ~300 chars
 */
function flattenLaunchError(err) {
  const raw = String(err?.message || err || 'Chromium launch failed');
  const flat = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const MAX = 300;
  return flat.length > MAX ? `${flat.slice(0, MAX - 1)}…` : flat;
}

/**
 * Launch (or reuse) the automation browser.
 * Resolves to null when Chromium cannot run in this environment.
 */
function getBrowser() {
  if (launchError) return Promise.resolve(null);
  if (browserPromise) return browserPromise;

  browserPromise = (async () => {
    try {
      // eslint-disable-next-line global-require, import/no-extraneous-dependencies
      const puppeteer = require('puppeteer');
      const headless = headlessMode();
      logger.info(`Launching Chromium (headless=${headless === 'new' ? 'yes' : 'no – visible window'})`);
      const browser = await puppeteer.launch({
        headless,
        args: launchArgs(),
        defaultViewport: { width: 1280, height: 860 },
      });
      return browser;
    } catch (err) {
      launchError = flattenLaunchError(err);
      logger.warn(`Chromium could not be launched: ${launchError}`);
      return null;
    }
  })();

  return browserPromise;
}

/** Close the automation browser. */
async function closeBrowser() {
  if (!browserPromise) return;
  try {
    const browser = await browserPromise;
    if (browser) await browser.close();
    logger.info('Chromium closed');
  } catch (err) {
    logger.debug(`closeBrowser: ${err.message}`);
  }
  browserPromise = null;
}

/** Health probe used by GET /api/apply/status. */
async function botHealth() {
  const browser = await getBrowser();
  if (!browser) {
    return {
      available: false,
      reason: launchError || 'Chromium launch failed',
      hint: 'Run `npx puppeteer browsers install chrome` inside backend/, or set PUPPETEER_HEADLESS=true.',
    };
  }
  try {
    const version = await browser.version();
    return { available: true, version, headless: headlessMode() === 'new' };
  } catch (err) {
    return { available: false, reason: err.message };
  }
}

/* ------------------------------------------------------------------ *
 * Stop flag + live run log (shared with the Auto Apply page)
 * ------------------------------------------------------------------ */

let stopRequested = false;
/** @type {Array<{ts:string, level:string, message:string}>} */
const runLog = [];
const RUN_LOG_LIMIT = 200;

/** Ask the running batch to stop after the current job. */
function requestStop() {
  stopRequested = true;
  pushLog('warning', '⏹ Stop requested – finishing the current job then halting');
}

function resetStop() {
  stopRequested = false;
}

function isStopRequested() {
  return stopRequested;
}

/** Append a line to the live log the UI tails. */
function pushLog(level, message) {
  const entry = { ts: new Date().toISOString(), level, message };
  runLog.push(entry);
  if (runLog.length > RUN_LOG_LIMIT) runLog.shift();
  const icon = { info: 'ℹ️', success: '✅', warning: '⚠️', error: '❌', step: '▶' }[level] || '';
  logger.info(`${icon} ${message}`);
  return entry;
}

function getRunLog() {
  return [...runLog];
}

function clearRunLog() {
  runLog.length = 0;
}

/* ------------------------------------------------------------------ *
 * In-page helpers (stringified and run inside the browser)
 * ------------------------------------------------------------------ */

/** Wait a bit. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Human-ish pause between actions. */
const humanPause = (min = 500, max = 1400) => sleep(min + Math.random() * (max - min));

/**
 * Detect a CAPTCHA / bot challenge on the current page.
 * Runs in the browser context.
 */
const CAPTCHA_PROBE = () => {
  const html = document.documentElement.innerHTML.toLowerCase();
  const text = (document.body?.innerText || '').toLowerCase();

  const checks = {
    recaptcha: Boolean(document.querySelector('iframe[src*="recaptcha"], .g-recaptcha, #recaptcha')),
    hcaptcha: Boolean(document.querySelector('iframe[src*="hcaptcha"], .h-captcha')),
    turnstile: Boolean(document.querySelector('iframe[src*="challenges.cloudflare.com"], .cf-turnstile')),
    arkose: html.includes('funcaptcha') || html.includes('arkoselabs'),
    cloudflare:
      html.includes('cf-browser-verification') ||
      html.includes('checking your browser') ||
      text.includes('verify you are human'),
    textCaptcha: /solve the captcha|enter the characters|prove you('| a)re (not )?human|security check/i.test(text),
  };

  const type = Object.keys(checks).find((k) => checks[k]);
  return { detected: Boolean(type), type: type || null };
};

/**
 * Look for a clickable "apply" style element and click it.
 * Runs in the browser context. Returns a description of what it clicked.
 */
const CLICK_APPLY = (labels) => {
  const wanted = (labels || [])
    .concat(['apply now', 'apply', 'easy apply', 'easy apply now', 'continue', 'start application', 'apply on company website', 'i am interested'])
    .map((l) => l.toLowerCase());

  const nodes = Array.from(document.querySelectorAll('button, a, input[type="submit"], [role="button"], span'));
  const visible = nodes.filter((n) => {
    const r = n.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });

  for (const label of wanted) {
    const hit = visible.find((n) => {
      const text = (n.innerText || n.value || '').trim().toLowerCase();
      return text.length > 0 && text.length < 40 && (text === label || text.startsWith(label));
    });
    if (hit) {
      hit.scrollIntoView({ block: 'center' });
      hit.click();
      return (hit.innerText || hit.value || '').trim();
    }
  }
  return null;
};

/**
 * Fill every obvious text input on the page from a map of values.
 * Runs in the browser context. Returns how many fields were filled.
 */
const AUTOFILL = (values) => {
  const setNativeValue = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const match = (el, patterns) => {
    const hay = [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), el.getAttribute('autocomplete')]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return patterns.some((p) => hay.includes(p));
  };

  let filled = 0;
  const fields = Array.from(document.querySelectorAll('input, textarea, select')).filter((el) => {
    if (el.disabled || el.readOnly || el.type === 'hidden' || el.type === 'file' || el.type === 'submit') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });

  fields.forEach((el) => {
    if (el.value && el.value.trim()) return; // never overwrite existing input
    const tag = el.tagName.toLowerCase();

    if (tag === 'select') {
      if (match(el, ['country', 'nationality']) && values.country) {
        const opt = Array.from(el.options).find((o) => o.text.toLowerCase().includes(values.country.toLowerCase()));
        if (opt) {
          el.value = opt.value;
          el.dispatchEvent(new Event('change', { bubbles: true }));
          filled += 1;
        }
      }
      return;
    }

    if (match(el, ['full name', 'fullname', 'your name', 'name']) && !match(el, ['company', 'user', 'last', 'middle']) && values.fullName) {
      setNativeValue(el, values.fullName);
      filled += 1;
    } else if (match(el, ['first name', 'firstname', 'given name']) && values.firstName) {
      setNativeValue(el, values.firstName);
      filled += 1;
    } else if (match(el, ['last name', 'lastname', 'surname', 'family name']) && values.lastName) {
      setNativeValue(el, values.lastName);
      filled += 1;
    } else if (match(el, ['email', 'e-mail']) && values.email) {
      setNativeValue(el, values.email);
      filled += 1;
    } else if (match(el, ['phone', 'mobile', 'tel', 'cell']) && values.phone) {
      setNativeValue(el, values.phone);
      filled += 1;
    } else if (match(el, ['linkedin']) && values.linkedin) {
      setNativeValue(el, values.linkedin);
      filled += 1;
    } else if (match(el, ['portfolio', 'website', 'github']) && values.website) {
      setNativeValue(el, values.website);
      filled += 1;
    } else if (match(el, ['city', 'location', 'address']) && values.location) {
      setNativeValue(el, values.location);
      filled += 1;
    } else if (match(el, ['cover letter', 'coverletter', 'message', 'why are you']) && values.coverLetter) {
      setNativeValue(el, values.coverLetter);
      filled += 1;
    } else if (el.type === 'number' && match(el, ['year', 'experience']) && values.experienceYears) {
      setNativeValue(el, values.experienceYears);
      filled += 1;
    } else if (el.type === 'number' && match(el, ['salary', 'compensation']) && values.salaryExpectation) {
      setNativeValue(el, values.salaryExpectation);
      filled += 1;
    } else if (match(el, ['authorized', 'authorised', 'work permit', 'legally']) && values.authorization) {
      setNativeValue(el, values.authorization);
      filled += 1;
    } else if (match(el, ['sponsor']) && values.sponsorship) {
      setNativeValue(el, values.sponsorship);
      filled += 1;
    }
  });

  // Yes/No radio groups: answer the most common screening questions.
  const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
  radios.forEach((radio) => {
    if (radio.checked) return;
    const label = (radio.closest('label')?.innerText || radio.getAttribute('aria-label') || radio.value || '').toLowerCase();
    if (/(authorized|authorised|permit|eligible|legally)/.test(label)) {
      radio.click();
    } else if (/(sponsor)/.test(label) && /\bno\b/.test(label)) {
      radio.click();
    }
  });

  return filled;
};

/**
 * Find a file input and report whether a resume can be attached.
 */
const FIND_FILE_INPUT = () => {
  const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
  return { count: inputs.length, accepts: inputs.map((i) => i.accept || '') };
};

/* ------------------------------------------------------------------ *
 * The main flow
 * ------------------------------------------------------------------ */

/**
 * Apply to a single job.
 *
 * @param {object} params
 * @param {string} params.jobUrl        where to apply
 * @param {string} [params.resumePath]  absolute path to the resume file
 * @param {string} [params.coverLetter] text to paste
 * @param {string} [params.jobSource]   'indeed' | 'linkedin' | 'glassdoor' | …
 * @param {object} [params.contact]     { fullName, email, phone, linkedin, website, location }
 * @param {object} [params.screening]   overrides for DEFAULT_SCREENING_ANSWERS
 * @param {(level:string, message:string)=>void} [params.onEvent] live progress callback
 * @param {boolean} [params.dryRun]     fill everything but do NOT click submit
 * @returns {Promise<object>}
 */
async function applyToJob(params = {}) {
  const {
    jobUrl,
    resumePath,
    coverLetter = '',
    jobSource = 'generic',
    contact = {},
    screening = {},
    onEvent,
    dryRun = false,
  } = params;

  const steps = [];
  const emit = (level, message) => {
    steps.push({ level, message, at: new Date().toISOString() });
    pushLog(level, message);
    if (typeof onEvent === 'function') {
      try {
        onEvent(level, message);
      } catch {
        /* a broken UI callback must not break the run */
      }
    }
  };

  const result = {
    success: false,
    appliedAt: null,
    error: null,
    captchaHit: false,
    captchaType: null,
    dryRun,
    steps,
  };

  if (!jobUrl || !/^https?:\/\//i.test(jobUrl)) {
    result.error = 'A valid job URL is required to auto-apply';
    emit('error', result.error);
    return result;
  }

  const browser = await getBrowser();
  if (!browser) {
    result.error = `Chromium is not available: ${launchError || 'launch failed'}`;
    emit('error', `${result.error} — install it with "npx puppeteer browsers install chrome" in the backend folder.`);
    return result;
  }

  if (resumePath && !fs.existsSync(resumePath)) {
    result.error = `Resume file missing on disk: ${resumePath}`;
    emit('error', result.error);
    return result;
  }

  const page = await browser.newPage();

  try {
    await page.setUserAgent(USER_AGENT);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    page.setDefaultTimeout(20000);

    emit('step', `Opening ${jobUrl}`);
    await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await humanPause(1200, 2500);

    // --- CAPTCHA check right after load -------------------------------
    const initialCaptcha = await page.evaluate(CAPTCHA_PROBE);
    if (initialCaptcha.detected) {
      result.captchaHit = true;
      result.captchaType = initialCaptcha.type;
      notifier.notifyCaptcha(new URL(jobUrl).hostname);
      emit('warning', `⚠️ CAPTCHA (${initialCaptcha.type}) detected before applying — waiting for you to solve it`);

      const solved = await waitForCaptchaToClear(page, emit);
      if (!solved) {
        result.error = `CAPTCHA (${initialCaptcha.type}) was not solved within ${Math.round(CAPTCHA_TIMEOUT_MS / 60000)} minutes`;
        emit('error', result.error);
        return result;
      }
      emit('success', 'CAPTCHA solved – continuing');
    }

    // --- Step 1: get to the application form --------------------------
    const source = String(jobSource).toLowerCase();
    if (source === 'linkedin') {
      emit('step', 'LinkedIn: looking for Easy Apply');
      const clicked = await page.evaluate(CLICK_APPLY, ['easy apply', 'easy apply now', 'apply']);
      emit(clicked ? 'success' : 'warning', clicked ? `Clicked "${clicked}"` : 'No Easy Apply button found on the page');
      await humanPause();
    } else if (source === 'indeed') {
      emit('step', 'Indeed: looking for the Apply button');
      const clicked = await page.evaluate(CLICK_APPLY, ['apply now', 'apply', 'continue']);
      emit(clicked ? 'success' : 'warning', clicked ? `Clicked "${clicked}"` : 'No Apply button found on the page');
      await humanPause();
    } else {
      const clicked = await page.evaluate(CLICK_APPLY, []);
      if (clicked) {
        emit('step', `Clicked "${clicked}"`);
        await humanPause();
      }
    }

    // LinkedIn / Indeed open multi-step wizards – walk through them.
    for (let step = 0; step < 6; step += 1) {
      if (isStopRequested()) throw new Error('Batch stopped by user');

      const values = {
        fullName: contact.fullName || '',
        firstName: (contact.fullName || '').split(' ')[0] || '',
        lastName: (contact.fullName || '').split(' ').slice(1).join(' ') || '',
        email: contact.email || '',
        phone: contact.phone || '',
        linkedin: contact.linkedin || '',
        website: contact.website || '',
        location: contact.location || '',
        coverLetter,
        ...DEFAULT_SCREENING_ANSWERS,
        ...screening,
      };

      const filled = await page.evaluate(AUTOFILL, values);
      if (filled > 0) emit('success', `Filled ${filled} field(s) on step ${step + 1}`);

      // Resume upload
      if (resumePath) {
        const fileInputs = await page.$$('input[type="file"]');
        if (fileInputs.length) {
          try {
            await fileInputs[0].uploadFile(path.resolve(resumePath));
            emit('success', `Attached resume ${path.basename(resumePath)}`);
            await humanPause(600, 1200);
          } catch (err) {
            emit('warning', `Could not attach the resume: ${err.message.split('\n')[0]}`);
          }
        }
      }

      // Cover letter into a contenteditable rich text editor, if any
      if (coverLetter) {
        const editable = await page.$('[contenteditable="true"]');
        if (editable) {
          await editable.click();
          await editable.type(coverLetter, { delay: 4 });
          emit('success', 'Typed the cover letter into the rich text editor');
        }
      }

      const captchaNow = await page.evaluate(CAPTCHA_PROBE);
      if (captchaNow.detected && !result.captchaHit) {
        result.captchaHit = true;
        result.captchaType = captchaNow.type;
        notifier.notifyCaptcha(new URL(jobUrl).hostname);
        emit('warning', `⚠️ CAPTCHA (${captchaNow.type}) detected mid-form — please solve it in the browser window`);
        const solved = await waitForCaptchaToClear(page, emit);
        if (!solved) {
          result.error = 'CAPTCHA not solved in time';
          emit('error', result.error);
          return result;
        }
      }

      // Move on / finish
      const advanced = await page.evaluate(CLICK_APPLY, [
        'continue',
        'next',
        'review',
        'review application',
        'submit application',
        'submit',
      ]);

      if (!advanced) break;
      emit('step', `Advanced with "${advanced}"`);
      await humanPause(900, 1800);

      const stillForm = await page.$('form input, form textarea, [data-testid="easy-apply-form"]');
      if (!stillForm) break;
    }

    // --- Step 2: submit -------------------------------------------------
    if (dryRun) {
      result.success = true;
      result.appliedAt = new Date().toISOString();
      emit('warning', 'Dry run – form filled but NOT submitted');
      return result;
    }

    const submitted = await page.evaluate(CLICK_APPLY, ['submit application', 'submit', 'apply now', 'finish', 'send']);
    if (submitted) {
      await humanPause(1500, 2500);
      emit('success', `Submitted ("${submitted}")`);
    } else {
      emit('warning', 'No submit button found – the form may need manual review');
    }

    // --- Step 3: verify ---------------------------------------------------
    const confirmation = await page
      .evaluate(() => {
        const text = (document.body?.innerText || '').toLowerCase();
        return /application (submitted|received|sent)|thank you for applying|successfully applied|your application has been/i.test(
          text
        );
      })
      .catch(() => false);

    if (confirmation) {
      emit('success', 'Application confirmation detected on the page');
    }

    result.success = Boolean(submitted || confirmation);
    result.appliedAt = result.success ? new Date().toISOString() : null;
    if (!result.success && !result.error) {
      result.error = 'Reached the end of the flow without a submit button or confirmation message';
    }
    return result;
  } catch (err) {
    result.error = err.message.split('\n')[0];
    emit('error', `Failed: ${result.error}`);
    return result;
  } finally {
    await page.close().catch(() => undefined);
  }
}

/**
 * Poll the page until the CAPTCHA disappears (or we time out).
 * In headless mode nobody can solve it, so we bail out early.
 */
async function waitForCaptchaToClear(page, emit) {
  if (headlessMode() === 'new') {
    emit('warning', 'Running headless – a CAPTCHA cannot be solved manually. Restart with PUPPETEER_HEADLESS=false.');
    return false;
  }

  const deadline = Date.now() + CAPTCHA_TIMEOUT_MS;
  let lastNudge = 0;

  while (Date.now() < deadline) {
    await sleep(CAPTCHA_POLL_MS);
    const probe = await page.evaluate(CAPTCHA_PROBE).catch(() => ({ detected: false }));
    if (!probe.detected) return true;

    const left = Math.round((deadline - Date.now()) / 1000);
    if (Date.now() - lastNudge > 45000) {
      lastNudge = Date.now();
      emit('warning', `Still waiting on the CAPTCHA… ${Math.max(0, left)}s left`);
    }
  }
  return false;
}

/**
 * Apply to a batch of jobs, honouring the daily limit and the stop flag.
 *
 * @param {Array<object>} jobs      jobs to apply to
 * @param {object} options
 * @param {string} [options.resumePath]
 * @param {object} [options.contact]
 * @param {boolean} [options.generateCoverLetter]
 * @param {(job, result)=>Promise<void>} [options.onApplied] persistence hook
 * @param {(job)=>Promise<string>} [options.coverLetterFor] builds the letter per job
 * @param {number} [options.limit]
 * @param {'30s'|'60s'|'2min'|'5min'} [options.delay]
 * @returns {Promise<{attempted:number,succeeded:number,failed:number,captchaHit:number,results:Array}>}
 */
async function applyBatch(jobs = [], options = {}) {
  const {
    resumePath,
    contact = {},
    limit = 15,
    delay = '60s',
    coverLetterFor,
    onApplied,
    onEvent,
    dryRun = false,
  } = options;

  resetStop();

  const delayMs = { '30s': 30000, '60s': 60000, '2min': 120000, '5min': 300000 }[delay] ?? 60000;
  const queue = jobs.slice(0, limit);

  const summary = { attempted: 0, succeeded: 0, failed: 0, captchaHit: 0, results: [] };

  pushLog('step', `▶ Auto-apply batch started — ${queue.length} job(s), ${Math.round(delayMs / 1000)}s between applications`);

  for (let i = 0; i < queue.length; i += 1) {
    if (isStopRequested()) {
      pushLog('warning', 'Batch stopped by the user');
      break;
    }

    const job = queue[i];
    summary.attempted += 1;

    let coverLetter = job.coverLetter || '';
    if (!coverLetter && typeof coverLetterFor === 'function') {
      try {
        coverLetter = await coverLetterFor(job);
      } catch (err) {
        pushLog('warning', `Cover letter generation failed for ${job.company}: ${err.message}`);
      }
    }

    pushLog('step', `[${i + 1}/${queue.length}] ${job.title} at ${job.company}`);

    const outcome = await applyToJob({
      jobUrl: job.source_url || job.sourceUrl,
      resumePath,
      coverLetter,
      jobSource: job.source || 'generic',
      contact,
      onEvent,
      dryRun,
    });

    summary.results.push({ jobId: job.id, title: job.title, company: job.company, ...outcome, steps: undefined });

    if (outcome.success) {
      summary.succeeded += 1;
      pushLog('success', `Applied to ${job.title} at ${job.company}`);
    } else {
      summary.failed += 1;
      pushLog('error', `Failed at ${job.company}: ${outcome.error}`);
    }
    if (outcome.captchaHit) summary.captchaHit += 1;

    if (typeof onApplied === 'function') {
      try {
        await onApplied(job, outcome, coverLetter);
      } catch (err) {
        pushLog('warning', `Could not persist the application record: ${err.message}`);
      }
    }

    // Politeness pause between applications (skipped after the last one).
    if (i < queue.length - 1 && !isStopRequested()) {
      const jitter = Math.round(delayMs * (0.8 + Math.random() * 0.4));
      pushLog('info', `Waiting ${Math.round(jitter / 1000)}s before the next application…`);
      await sleep(jitter);
    }
  }

  notifier.notifyAutoApplyDone(summary);
  pushLog(
    summary.succeeded ? 'success' : 'warning',
    `Batch complete — ${summary.succeeded} applied, ${summary.failed} failed, ${summary.captchaHit} CAPTCHA`
  );

  return summary;
}

module.exports = {
  applyToJob,
  applyBatch,
  flattenLaunchError,
  botHealth,
  closeBrowser,
  requestStop,
  resetStop,
  isStopRequested,
  getRunLog,
  clearRunLog,
  canRunHeadful,
  headlessMode,
  CAPTCHA_TIMEOUT_MS,
  DEFAULT_SCREENING_ANSWERS,
};
