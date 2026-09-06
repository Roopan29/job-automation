/**
 * backend/services/jobScraper.js
 * ------------------------------------------------------------------
 * Pulls real job listings from multiple job boards.
 *
 * Sources:
 *   remoteok   – https://remoteok.com/api          (public JSON, no browser)
 *   remotive   – https://remotive.com/api          (public JSON, no browser)
 *   linkedin   – public "jobs-guest" search HTML   (no login, parsed with Cheerio)
 *   indeed     – Puppeteer on indeed.com/jobs      (frequently bot-blocked)
 *   glassdoor  – Puppeteer on glassdoor.com        (frequently bot-blocked)
 *
 * Design notes
 *   • Every source is isolated: if one throws, the others still run and
 *     the failure is reported per source in the result + scrape_logs.
 *   • A random 2–5 s delay separates requests so we behave politely.
 *   • A realistic desktop Chrome User-Agent is sent on every request.
 *   • Puppeteer is only launched when a source actually needs it, and
 *     the browser is reused across sources inside one run.
 *   • Results are normalised to one shape before being returned:
 *       { title, company, location, salary, jobType, experienceLevel,
 *         description, requirements[], source, sourceUrl, postedDate }
 */

const cheerio = require('cheerio');
const log = require('../utils/logger');

const logger = log.scope('Scraper');

/** Realistic desktop Chrome UA – some boards reject the default Node UA. */
const USER_AGENT =
  process.env.SCRAPER_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const SOURCES = ['remoteok', 'remotive', 'linkedin', 'indeed', 'glassdoor'];

/** Human friendly labels stored in the DB / shown in the UI. */
const SOURCE_LABELS = {
  remoteok: 'RemoteOK',
  remotive: 'Remotive',
  linkedin: 'LinkedIn',
  indeed: 'Indeed',
  glassdoor: 'Glassdoor',
};

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

/** Random sleep. */
const randomDelay = (min = 2000, max = 5000) =>
  new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));

/** fetch with a timeout and our browser-ish headers. */
async function fetchJson(url, { timeout = 20000, accept = 'application/json' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: accept,
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const type = res.headers.get('content-type') || '';
    return type.includes('json') ? res.json() : res.text();
  } catch (err) {
    // Node's fetch hides the real reason behind a generic "fetch failed".
    // Surface the underlying code/message so the UI can explain *why*
    // a source is unreachable (DNS, TLS, blocked egress, reset, …).
    const cause = err.cause;
    if (cause && err.message === 'fetch failed') {
      const detail = cause.code || cause.message || String(cause);
      const hint =
        cause.code === 'ECONNRESET' || cause.code === 'ECONNREFUSED' || cause.code === 'ETIMEDOUT'
          ? ' – the request was blocked or the host is unreachable (check network egress / firewall)'
          : cause.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || cause.code === 'SELF_SIGNED_CERT_IN_CHAIN'
            ? ' – TLS certificate could not be verified (corporate proxy? set NODE_EXTRA_CA_CERTS)'
            : '';
      throw new Error(`Network error ${detail}${hint}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Strip HTML, collapse whitespace. */
function stripHtml(html = '') {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ------------------------------------------------------------------ *
 * Field inference
 * ------------------------------------------------------------------ */

/** "USD 90k-120k" style salary hunt inside free text. */
function extractSalary(text = '') {
  const patterns = [
    /\$\s?\d{2,3}(?:[.,]\d{3})*\s?(?:k)?\s?(?:-|–|to)\s?\$?\s?\d{2,3}(?:[.,]\d{3})*\s?(?:k)?/i,
    /\$\s?\d{2,3}(?:[.,]\d{3})*(?:\s?k)?\s?(?:per|\/|an)\s?(?:hour|year|annum|yr)/i,
    /\b(?:usd|eur|gbp|inr|cad|aud)\s?\d{2,3}(?:[.,]\d{3})*\s?(?:-|–|to)?\s?\d{0,3}(?:[.,]\d{3})*\s?k?\b/i,
    /\b\d{2,3}k\s?(?:-|–|to)\s?\d{2,3}k\b/i,
  ];
  for (const re of patterns) {
    const m = String(text).match(re);
    if (m) return m[0].trim();
  }
  return '';
}

/** remote | hybrid | onsite, guessed from location + description. */
function inferJobType(location = '', description = '', explicit = '') {
  const text = `${explicit} ${location} ${description.slice(0, 1500)}`.toLowerCase();
  if (/\bhybrid\b/.test(text)) return 'hybrid';
  if (/\b(remote|work from home|wfh|anywhere in|fully remote|distributed)\b/.test(text)) return 'remote';
  if (/\b(onsite|on-site|in office|in-office|relocation|office based|office-based)\b/.test(text)) return 'onsite';
  return location && /remote/i.test(location) ? 'remote' : 'onsite';
}

/** entry | mid | senior from the title / description. */
function inferExperienceLevel(title = '', description = '') {
  const text = `${title} ${description.slice(0, 800)}`.toLowerCase();
  if (/\b(intern|internship|junior|jr\.?|entry level|entry-level|trainee|graduate|apprentice|0-2 years|1\+? years?)\b/.test(text)) {
    return 'entry';
  }
  if (/\b(senior|sr\.?|lead|principal|staff|head of|director|manager|architect|5\+|6\+|7\+|8\+|10\+)\s?(years|yrs)?/.test(text)) {
    return 'senior';
  }
  if (/\b(mid[- ]level|intermediate|3\+|4\+)\s?(years|yrs)?/.test(text)) return 'mid';
  return 'mid';
}

/** Pull requirement-looking lines out of a description. */
function extractRequirements(description = '') {
  const lines = String(description)
    .split('\n')
    .map((l) => l.replace(/^\s*[•\-–*▪‣\d+.)\s]+/, '').trim())
    .filter(Boolean);

  const requirementish = lines.filter(
    (l) =>
      l.length > 12 &&
      l.length < 200 &&
      /\b(years?|experience|proficien|familiar|knowledge|understanding|ability to|strong|bachelor|degree|expertise|hands-on|skills? in)\b/i.test(l)
  );

  return [...new Set(requirementish)].slice(0, 12);
}

/** Coerce anything date-like into YYYY-MM-DD (or null). */
function normaliseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** "3 days ago" -> ISO date. */
function relativeToISO(text = '') {
  const m = String(text).match(/(\d+)\s*(second|minute|hour|day|week|month)s?\s*ago/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const ms =
    { second: 1e3, minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6 }[unit] || 864e5;
  return new Date(Date.now() - n * ms).toISOString().slice(0, 10);
}

/** Build the canonical job object, dropping anything unusable. */
function normalizeJob(raw) {
  const title = String(raw.title || '').replace(/\s+/g, ' ').trim();
  if (!title) return null;

  const description = String(raw.description || '').trim();
  const location = String(raw.location || '').trim() || 'Not specified';

  return {
    title: title.slice(0, 200),
    company: String(raw.company || '').trim() || 'Unknown company',
    location: location.slice(0, 160),
    salary: raw.salary || extractSalary(description) || '',
    job_type: raw.job_type || inferJobType(location, description, raw.job_type),
    experience_level: raw.experience_level || inferExperienceLevel(title, description),
    description: description.slice(0, 12000),
    requirements: JSON.stringify(
      Array.isArray(raw.requirements) && raw.requirements.length
        ? raw.requirements.slice(0, 15)
        : extractRequirements(description)
    ),
    source: SOURCE_LABELS[raw.source] || raw.source || 'Unknown',
    source_url: String(raw.source_url || '').trim(),
    posted_date: normaliseDate(raw.posted_date) || relativeToISO(raw.posted_text) || new Date().toISOString().slice(0, 10),
  };
}

/* ------------------------------------------------------------------ *
 * Shared Puppeteer browser (lazily started, reused, closed by caller)
 * ------------------------------------------------------------------ */

/** @type {Promise<import('puppeteer').Browser>|null} */
let browserPromise = null;
/** Set after the first launch failure so we do not keep retrying. */
let browserUnavailable = null;

/** Extra flags needed when running as root / inside a container. */
function launchArgs() {
  return [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--no-zygote',
    '--window-size=1440,900',
    `--user-agent=${USER_AGENT}`,
  ];
}

/**
 * Get a shared browser instance.
 * Resolves to null (never throws) when Puppeteer/Chromium cannot run
 * here — e.g. inside a container without the required shared libraries.
 */
function getBrowser() {
  if (browserUnavailable) return Promise.resolve(null);
  if (browserPromise) return browserPromise;

  browserPromise = (async () => {
    try {
      // eslint-disable-next-line global-require, import/no-extraneous-dependencies
      const puppeteer = require('puppeteer');
      const browser = await puppeteer.launch({
        headless: process.env.PUPPETEER_HEADLESS !== 'false' ? 'new' : false,
        args: launchArgs(),
        defaultViewport: { width: 1440, height: 900 },
      });
      logger.info('Chromium launched for scraping');
      return browser;
    } catch (err) {
      browserUnavailable = err.message;
      logger.warn(`Chromium unavailable – browser-based sources will be skipped: ${err.message.split('\n')[0]}`);
      return null;
    }
  })();

  return browserPromise;
}

/** Close the shared browser (called at the end of a scrape run). */
async function closeBrowser() {
  if (!browserPromise) return;
  try {
    const browser = await browserPromise;
    if (browser) await browser.close();
  } catch (err) {
    logger.debug(`closeBrowser: ${err.message}`);
  }
  browserPromise = null;
}

/* ------------------------------------------------------------------ *
 * Source: RemoteOK (public JSON API)
 * ------------------------------------------------------------------ */

async function scrapeRemoteOK({ query = '', limit = 25 } = {}) {
  logger.step('RemoteOK: fetching https://remoteok.com/api');
  const data = await fetchJson('https://remoteok.com/api');

  if (!Array.isArray(data)) throw new Error('Unexpected RemoteOK payload (expected an array)');

  const needle = query.toLowerCase().trim();

  const jobs = data
    .filter((item) => item && item.id && item.position) // first item is legal boilerplate
    .filter((item) => {
      if (!needle) return true;
      const haystack = `${item.position} ${(item.tags || []).join(' ')} ${item.company || ''}`.toLowerCase();
      return needle.split(/\s+/).some((word) => haystack.includes(word));
    })
    .slice(0, limit)
    .map((item) =>
      normalizeJob({
        title: item.position,
        company: item.company,
        location: [item.location, item.candidate_required_location].filter(Boolean).join(' / ') || 'Remote',
        salary: [item.salary_min && item.salary_max ? `$${item.salary_min} – $${item.salary_max}` : '', item.salary]
          .filter(Boolean)
          .join(' ')
          .trim(),
        job_type: 'remote',
        description: stripHtml(item.description || ''),
        requirements: item.tags || [],
        source: 'remoteok',
        source_url: item.url || `https://remoteok.com/remote-jobs/${item.id}`,
        posted_date: item.date || item.epoch ? new Date((item.epoch || 0) * 1000).toISOString() : null,
      })
    )
    .filter(Boolean);

  logger.success(`RemoteOK: ${jobs.length} jobs`);
  return jobs;
}

/* ------------------------------------------------------------------ *
 * Source: Remotive (public JSON API)
 * ------------------------------------------------------------------ */

async function scrapeRemotive({ query = '', limit = 25 } = {}) {
  const url = `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(query)}&limit=${Math.min(100, Math.max(5, limit))}`;
  logger.step(`Remotive: fetching ${url}`);
  const data = await fetchJson(url);

  const list = Array.isArray(data?.jobs) ? data.jobs : [];

  const jobs = list
    .slice(0, limit)
    .map((item) =>
      normalizeJob({
        title: item.title,
        company: item.company_name,
        location: [item.candidate_required_location, item.location].filter(Boolean).join(' / ') || 'Remote',
        salary: item.salary || '',
        job_type: 'remote',
        description: stripHtml(item.description || ''),
        requirements: item.tags || [],
        source: 'remotive',
        source_url: item.url,
        posted_date: item.publication_date,
      })
    )
    .filter(Boolean);

  logger.success(`Remotive: ${jobs.length} jobs`);
  return jobs;
}

/* ------------------------------------------------------------------ *
 * Source: LinkedIn (public guest search, no login required)
 * ------------------------------------------------------------------ */

async function scrapeLinkedIn({ query = '', location = '', limit = 25 } = {}) {
  const url =
    `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search` +
    `?keywords=${encodeURIComponent(query)}` +
    `&location=${encodeURIComponent(location || 'United States')}` +
    `&start=0`;

  logger.step('LinkedIn: fetching public guest job search');
  const html = await fetchJson(url, { accept: 'text/html' });

  if (typeof html !== 'string') throw new Error('LinkedIn returned a non-HTML payload');
  if (html.includes('authwall') || html.includes('Sign in to LinkedIn')) {
    throw new Error('LinkedIn redirected to the login wall for this request');
  }

  const $ = cheerio.load(html);
  const cards = $('li, div.base-card, div.job-card-container').toArray();
  const jobs = [];

  cards.forEach((el) => {
    const card = $(el);
    const titleEl = card.find('.base-search-card__title, .job-search-card__title, h3').first();
    const title = titleEl.text().trim();
    if (!title) return;

    const companyEl = card.find('.base-search-card__subtitle a, .job-search-card__subtitle a').first();
    const linkEl = card.find('a.base-card__full-link, a.base-search-card__full-link, a.job-search-card__title').first();
    const locationEl = card.find('.job-search-card__location, .base-search-card__location').first();
    const timeEl = card.find('time').first();
    const salaryEl = card.find('.job-search-card__salary-info, .salary.compensation__salary').first();

    jobs.push(
      normalizeJob({
        title,
        company: companyEl.text().trim(),
        location: locationEl.text().trim() || location,
        salary: salaryEl.text().trim(),
        description: card.find('.base-search-card__snippet').text().trim(),
        source: 'linkedin',
        source_url: (linkEl.attr('href') || '').split('?')[0],
        posted_date: timeEl.attr('datetime') || null,
        posted_text: timeEl.text().trim(),
      })
    );
  });

  const unique = dedupe(jobs.filter(Boolean)).slice(0, limit);
  if (unique.length === 0) throw new Error('LinkedIn returned no parsable job cards (layout may have changed)');

  logger.success(`LinkedIn: ${unique.length} jobs`);
  return unique;
}

/* ------------------------------------------------------------------ *
 * Source: Indeed (Puppeteer)
 * ------------------------------------------------------------------ */

async function scrapeIndeed({ query = '', location = '', limit = 25 } = {}) {
  const browser = await getBrowser();
  if (!browser) throw new Error(`Chromium is not available: ${browserUnavailable || 'launch failed'}`);

  const url = `https://www.indeed.com/jobs?q=${encodeURIComponent(query)}&l=${encodeURIComponent(location)}&sort=date`;
  logger.step(`Indeed: opening ${url}`);

  const page = await browser.newPage();
  try {
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1440, height: 900 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await randomDelay(1500, 3000);

    if (response && response.status() >= 400) {
      throw new Error(`Indeed responded with HTTP ${response.status()} (bot protection)`);
    }

    // Indeed sometimes shows a "prove you are human" interstitial.
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 600) || '');
    if (/are you a human|access denied|captcha|please verify/i.test(bodyText)) {
      throw new Error('Indeed served a bot-check page instead of results');
    }

    await page.waitForSelector('div.job_seen_beacon, td.resultContent, div[data-testid="job-card"]', {
      timeout: 20000,
    }).catch(() => {
      throw new Error('Indeed results markup not found (layout changed or blocked)');
    });

    const raw = await page.evaluate(() => {
      const cards = Array.from(
        document.querySelectorAll('div.job_seen_beacon, td.resultContent, div[data-testid="job-card"]')
      );
      return cards.map((card) => {
        const pick = (selectors) => {
          for (const sel of selectors.split(',')) {
            const el = card.querySelector(sel.trim());
            if (el && el.textContent.trim()) return el.textContent.trim();
          }
          return '';
        };
        const link = card.querySelector('a.jcs-JobTitle, a[data-jk], a.tapItem');
        const snippet = pick('.job-snippet, [data-testid="text"], .job-snippet-container');
        return {
          title: pick('h2.jobTitle span, h2 a span, [data-testid="job-title"]'),
          company: pick('.companyName, [data-testid="company-name"]'),
          location: pick('.companyLocation, [data-testid="text-location"]'),
          salary: pick('.salary-snippet, .metadata.salary-snippet-container'),
          snippet,
          href: link ? link.getAttribute('href') : '',
          dateText: pick('.date, [data-testid="date"]'),
        };
      });
    });

    const jobs = raw
      .filter((r) => r.title)
      .slice(0, limit)
      .map((r) =>
        normalizeJob({
          title: r.title,
          company: r.company,
          location: r.location,
          salary: r.salary,
          description: r.snippet,
          source: 'indeed',
          source_url: r.href
            ? `https://www.indeed.com${r.href.startsWith('/') ? '' : '/'}${r.href}`
            : `https://www.indeed.com/jobs?q=${encodeURIComponent(query)}&l=${encodeURIComponent(location)}`,
          posted_text: r.dateText,
        })
      )
      .filter(Boolean);

    if (jobs.length === 0) throw new Error('No Indeed jobs could be parsed from the page');
    logger.success(`Indeed: ${jobs.length} jobs`);
    return jobs;
  } finally {
    await page.close().catch(() => undefined);
  }
}

/* ------------------------------------------------------------------ *
 * Source: Glassdoor (Puppeteer)
 * ------------------------------------------------------------------ */

async function scrapeGlassdoor({ query = '', location = '', limit = 25 } = {}) {
  const browser = await getBrowser();
  if (!browser) throw new Error(`Chromium is not available: ${browserUnavailable || 'launch failed'}`);

  const slug = query.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'jobs';
  const url = `https://www.glassdoor.com/Job/${slug}-jobs-SRCH_KO0,${slug.length}.htm`;
  logger.step(`Glassdoor: opening ${url}`);

  const page = await browser.newPage();
  try {
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1440, height: 900 });

    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await randomDelay(1500, 3000);

    if (response && response.status() >= 400) {
      throw new Error(`Glassdoor responded with HTTP ${response.status()} (Cloudflare / login wall)`);
    }

    const html = await page.content();
    const $ = cheerio.load(html);
    const cards = $('[data-test="jobListing"], .JobCard_jobCardContainer__lKgld, li.react-job-listing').toArray();

    if (cards.length === 0) throw new Error('Glassdoor returned no job cards (login or Cloudflare wall)');

    const jobs = cards
      .map((el) => {
        const card = $(el);
        const title = card.find('[data-test="job-title"], .JobCard_jobTitle__aPvzu, a.jobLink').first().text().trim();
        if (!title) return null;
        const href = card.find('a[href*="/partner/jobListing.htm"], a.jobLink').first().attr('href') || '';
        return normalizeJob({
          title,
          company: card.find('[data-test="employer-name"], .EmployerProfile_compactEmployerName__g2QJS').first().text().trim(),
          location: card.find('[data-test="emp-location"], .JobCard_location__VYPTs').first().text().trim() || location,
          salary: card.find('[data-test="detailSalary"], .JobCard_salaryEstimate__UW78F').first().text().trim(),
          description: card.find('[data-test="job-snippet"], .JobCard_jobSnippet__VbGmT').first().text().trim(),
          source: 'glassdoor',
          source_url: href.startsWith('http') ? href : `https://www.glassdoor.com${href}`,
        });
      })
      .filter(Boolean)
      .slice(0, limit);

    if (jobs.length === 0) throw new Error('Glassdoor cards found but none could be parsed');
    logger.success(`Glassdoor: ${jobs.length} jobs`);
    return jobs;
  } finally {
    await page.close().catch(() => undefined);
  }
}

/* ------------------------------------------------------------------ *
 * Orchestration
 * ------------------------------------------------------------------ */

const SCRAPERS = {
  remoteok: scrapeRemoteOK,
  remotive: scrapeRemotive,
  linkedin: scrapeLinkedIn,
  indeed: scrapeIndeed,
  glassdoor: scrapeGlassdoor,
};

/** Remove jobs that share a source URL (or the same title+company). */
function dedupe(jobs = []) {
  const seen = new Set();
  const out = [];
  jobs.forEach((job) => {
    const key = job.source_url || `${job.source}|${job.title}|${job.company}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(job);
  });
  return out;
}

/**
 * Scrape every requested source.
 *
 * @param {object} params
 * @param {string} params.query       e.g. "React Developer"
 * @param {string} [params.location]  e.g. "Remote" or "New York, NY"
 * @param {string[]} [params.sources] subset of SOURCES (default: all that work headlessly)
 * @param {number} [params.limit]     max jobs per source
 * @param {boolean} [params.useBrowser] allow Puppeteer-based sources
 * @returns {Promise<{jobs:object[], results:Array, totalFound:number}>}
 */
async function scrapeJobs({ query = '', location = '', sources = [], limit = 25, useBrowser = true } = {}) {
  const started = Date.now();
  const requested = (sources.length ? sources : ['remoteok', 'linkedin']).map((s) => String(s).toLowerCase().trim());

  const unknown = requested.filter((s) => !SCRAPERS[s]);
  if (unknown.length) logger.warn(`Ignoring unknown source(s): ${unknown.join(', ')}`);

  const active = requested.filter((s) => SCRAPERS[s]);
  if (!active.length) {
    return {
      jobs: [],
      results: [{ source: requested.join(',') || 'none', found: 0, status: 'failed', error: 'No valid sources supplied' }],
      totalFound: 0,
      durationMs: Date.now() - started,
    };
  }

  const allJobs = [];
  const results = [];

  for (let i = 0; i < active.length; i += 1) {
    const source = active[i];
    const needsBrowser = source === 'indeed' || source === 'glassdoor';

    if (needsBrowser && !useBrowser) {
      results.push({ source, found: 0, status: 'skipped', error: 'Browser-based sources disabled for this run' });
      continue;
    }

    const startedAt = Date.now();
    try {
      const jobs = await SCRAPERS[source]({ query, location, limit });
      allJobs.push(...jobs);
      results.push({ source, found: jobs.length, status: 'success', error: null, ms: Date.now() - startedAt });
    } catch (err) {
      logger.warn(`${source} failed: ${err.message}`);
      results.push({
        source,
        found: 0,
        status: 'failed',
        error: err.message.split('\n')[0].slice(0, 300),
        ms: Date.now() - startedAt,
      });
    }

    // Politeness delay between sources (skipped after the last one).
    if (i < active.length - 1) await randomDelay(2000, 5000);
  }

  await closeBrowser();

  const jobs = dedupe(allJobs);
  const succeeded = results.filter((r) => r.status === 'success').length;

  logger.info(
    `Scrape finished in ${((Date.now() - started) / 1000).toFixed(1)}s — ` +
      `${jobs.length} unique jobs from ${succeeded}/${active.length} sources`
  );

  return {
    jobs,
    results,
    totalFound: allJobs.length,
    durationMs: Date.now() - started,
  };
}

/** Is Chromium usable right now? (for the UI health indicator) */
async function browserHealth() {
  const browser = await getBrowser();
  if (!browser) return { available: false, reason: browserUnavailable };
  try {
    const version = await browser.version();
    return { available: true, version };
  } catch (err) {
    return { available: false, reason: err.message };
  }
}

module.exports = {
  scrapeJobs,
  scrapeRemoteOK,
  scrapeRemotive,
  scrapeLinkedIn,
  scrapeIndeed,
  scrapeGlassdoor,
  normalizeJob,
  dedupe,
  extractSalary,
  inferJobType,
  inferExperienceLevel,
  extractRequirements,
  stripHtml,
  browserHealth,
  closeBrowser,
  SOURCES,
  SOURCE_LABELS,
  USER_AGENT,
};
