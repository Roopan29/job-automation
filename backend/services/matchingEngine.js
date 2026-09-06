/**
 * backend/services/matchingEngine.js
 * ------------------------------------------------------------------
 * How well does a resume fit a job?
 *
 * matchJobToResume(job, resume) -> {
 *   matchScore, matchedSkills, missingSkills,
 *   requiredSkills, titleMatch, experienceMatch, locationMatch, breakdown
 * }
 *
 * Scoring model (before the 0–100 cap):
 *
 *   base           = matched / required * 75
 *   + title bonus     up to 10   (job title words present in the resume)
 *   + experience      up to  5   (seniority lines up)
 *   + location        up to  5   (job location / remote matches prefs)
 *   + seniority fit   up to  5   (resume years vs required years)
 *
 * A job with no detectable requirements falls back to keyword overlap so
 * it still gets a sensible score instead of NaN.
 */

const { extractSkills, fold, guessSeniority } = require('./resumeParser');
const log = require('../utils/logger');

/** Common words that carry no signal in a job title/description. */
const STOP_WORDS = new Set([
  'a','an','the','and','or','of','to','in','on','for','with','at','by','as','is','are','was','were','be','been','being',
  'we','you','our','your','their','they','it','its','this','that','these','those','all','any','other','from','into',
  'about','over','under','between','through','during','before','after','above','below','up','down','out','off','then',
  'than','but','if','so','not','no','yes','can','could','will','would','should','shall','may','might','must','have',
  'has','had','do','does','did','doing','done','more','most','some','such','only','own','same','too','very','just',
  'also','please','apply','job','role','position','candidate','candidates','team','teams','company','work','working',
  'us','who','what','which','when','where','why','how','there','here','both','each','few','many','much','while',
  'etc','e.g','i.e','per','via','within','without','across','along','including','include','includes','included',
  'requirements','requirement','responsibilities','responsibility','qualifications','qualification','description',
  'years','year','experience','experienced','level','skills','skill','strong','good','great','plus','bonus',
  'preferred','preferably','required','requires','require','ability','able','knowledge','understanding','familiar',
  'familiarity','proficient','proficiency','exposure','hands','hand','well','verbal','written','excellent',
  'minimum','min','max','maximum','least','least 2','least 3','join','looking','seek','seeking','help','want',
  'need','needs','needed','ideal','ideally','comfortable','proven','track','record','self','starter','motivated',
  'new','full','time','part','contract','permanent','temporary','remote','hybrid','onsite','on-site','office',
  'benefits','salary','compensation','package','competitive','based','year of','years of',
]);

/* ------------------------------------------------------------------ *
 * Keyword extraction
 * ------------------------------------------------------------------ */

/**
 * Pull meaningful keywords out of arbitrary job text.
 * Returns a Set of folded (lowercase, diacritic-free) keywords.
 */
function extractKeywords(text = '', { minWordLength = 3, includePhrases = true } = {}) {
  const clean = String(text)
    .replace(/[•●▪‣]/g, ' ')
    .replace(/[^a-zA-Z0-9+#./&,\s-]/g, ' ')
    .toLowerCase();

  const words = clean
    .split(/[\s,;:|/()]+/)
    .map((w) => w.replace(/^[.-]+|[.-]+$/g, ''))
    .filter((w) => w.length >= minWordLength && !STOP_WORDS.has(w) && !/^\d+$/.test(w));

  const keywords = new Set(words);

  if (includePhrases) {
    // Two-word phrases catch "machine learning", "product manager", …
    for (let i = 0; i < words.length - 1; i += 1) {
      const pair = `${words[i]} ${words[i + 1]}`;
      if (!STOP_WORDS.has(words[i]) && !STOP_WORDS.has(words[i + 1])) keywords.add(pair);
    }
  }

  return keywords;
}

/**
 * Coerce a job's `requirements` into a real array.
 *
 * It arrives in two shapes: a JSON string straight from
 * jobScraper.normalizeJob() / the SQLite TEXT column, and a real array
 * once mapJob() has parsed the row. Both must work, or freshly scraped
 * jobs would blow up before they are ever scored.
 */
function toRequirementArray(requirements) {
  if (Array.isArray(requirements)) return requirements;
  if (typeof requirements === 'string' && requirements.trim()) {
    try {
      const parsed = JSON.parse(requirements);
      return Array.isArray(parsed) ? parsed : [requirements];
    } catch {
      // Not JSON – treat it as free text and split on line breaks.
      return requirements.split('\n');
    }
  }
  return [];
}

/**
 * Guess the skills a job asks for.
 * Uses the skill dictionary first (authoritative), then adds any
 * ALL-CAPS / bullet-listed requirement phrases as free-form keywords.
 */
function extractRequiredSkills(job = {}) {
  const requirements = toRequirementArray(job.requirements);

  const haystack = [job.title, job.description, requirements.join('\n')].filter(Boolean).join('\n');

  if (!haystack.trim()) return { skills: [], keywords: [] };

  // 1. Dictionary hits – the same detector used on resumes, so both
  //    sides speak the same vocabulary.
  const dictionarySkills = extractSkills(haystack).map((s) => s.name);

  // 2. Explicit requirement lines add free-form phrases the dictionary
  //    does not know ("stakeholder management", "Figma hand-off").
  const requirementPhrases = requirements
    .flatMap((req) => String(req).split(/[;\n]/))
    .map((r) => r.replace(/^[•\-–*\d+.)\s]+/, '').trim())
    .filter((r) => r.length > 3 && r.length < 80)
    .slice(0, 12);

  return { skills: dictionarySkills, keywords: requirementPhrases };
}

/* ------------------------------------------------------------------ *
 * Comparison helpers
 * ------------------------------------------------------------------ */

/** Case/accent-insensitive skill comparison. */
function skillKey(name) {
  return fold(name).replace(/[.\-_+/#]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Build a lookup of resume skills for O(1) matching. */
function buildSkillSet(resumeSkills = []) {
  const set = new Set();
  const names = [];
  resumeSkills.forEach((s) => {
    const raw = typeof s === 'string' ? s : s.name;
    if (!raw) return;
    set.add(skillKey(raw));
    names.push(raw);
  });
  return { set, names };
}

/**
 * Token overlap between the job title and the resume text.
 * @returns {number} 0–1
 */
function titleSimilarity(jobTitle = '', resume = {}) {
  const resumeText = fold(
    [resume.summary, (resume.experience || []).map((e) => `${e.title} ${e.company}`).join(' '), (resume.rawText || '').slice(0, 4000)]
      .filter(Boolean)
      .join(' ')
  );

  const tokens = fold(jobTitle)
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));

  if (tokens.length === 0) return 0;

  const hits = tokens.filter((t) => resumeText.includes(t)).length;
  return hits / tokens.length;
}

/**
 * Does the resume's total experience satisfy the job's implied level?
 * @returns {number} 0–1
 */
function experienceFit(jobLevel, resumeYears) {
  if (!jobLevel || jobLevel === 'any') return 0.75; // unknown level: neutral-ish

  const level = fold(jobLevel);
  if (level.includes('entry')) return resumeYears <= 3 ? 1 : 0.7;
  if (level.includes('senior')) return resumeYears >= 5 ? 1 : resumeYears >= 3 ? 0.6 : 0.25;
  // mid
  return resumeYears >= 2 ? 1 : 0.5;
}

/**
 * Location compatibility between a job and the user's preferences.
 * @returns {number} 0–1
 */
function locationFit(jobLocation = '', jobType = '', preferredLocations = []) {
  const loc = fold(jobLocation);
  const type = fold(jobType);
  const prefs = (preferredLocations || []).map(fold).filter(Boolean);

  if (prefs.length === 0) return 0.6;

  const remoteOk = prefs.some((p) => p.includes('remote') || p.includes('anywhere') || p.includes('any'));
  const isRemote = type.includes('remote') || loc.includes('remote');

  if (isRemote && remoteOk) return 1;
  if (isRemote && !remoteOk) return 0.4;

  // City / country overlap
  const tokens = loc.split(/[^a-z0-9]+/).filter((t) => t.length > 2);
  const hit = prefs.some((p) => tokens.some((t) => p.includes(t)) || p.split(' ').some((pt) => loc.includes(pt)));
  if (hit) return 1;

  return remoteOk ? 0.5 : 0.25;
}

/** Pull "X+ years" out of a job description. */
function requiredYears(job = {}) {
  const text = `${job.title} ${job.description} ${toRequirementArray(job.requirements).join(' ')}`;
  const matches = text.match(/(\d{1,2})\s*\+?\s*(?:years?|yrs?)\b/gi) || [];
  if (!matches.length) return null;
  const years = matches
    .map((m) => parseInt(m.match(/\d+/)[0], 10))
    .filter((n) => n > 0 && n < 30);
  return years.length ? Math.max(...years) : null;
}

/* ------------------------------------------------------------------ *
 * Main scorer
 * ------------------------------------------------------------------ */

/**
 * Score a job against a parsed resume.
 *
 * @param {object} job     { title, description, requirements, location, job_type, experience_level, source }
 * @param {object} resume  output of resumeParser.parseResume(Text)
 * @param {object} [options]
 * @param {string[]} [options.preferredLocations] from preferences.target_locations
 * @returns {{matchScore:number, matchedSkills:string[], missingSkills:string[],
 *            requiredSkills:string[], breakdown:object}}
 */
function matchJobToResume(job = {}, resume = {}, options = {}) {
  const empty = {
    matchScore: 0,
    matchedSkills: [],
    missingSkills: [],
    requiredSkills: [],
    breakdown: {},
  };

  if (!job || (!job.title && !job.description)) return empty;
  if (!resume || !resume.skills) {
    // No resume uploaded yet – score 0 but still list the requirements.
    const { skills } = extractRequiredSkills(job);
    return { ...empty, requiredSkills: skills, missingSkills: skills.slice(0, 10) };
  }

  const { skills: requiredSkills } = extractRequiredSkills(job);
  const { set: resumeSet, names: resumeNames } = buildSkillSet(resume.skills);

  const matchedSkills = [];
  const missingSkills = [];

  requiredSkills.forEach((skill) => {
    if (resumeSet.has(skillKey(skill))) matchedSkills.push(skill);
    else missingSkills.push(skill);
  });

  const total = requiredSkills.length;
  const matched = matchedSkills.length;

  // --- base score -----------------------------------------------------
  let base = 0;
  let keywordOverlap = 0;

  if (total > 0) {
    base = (matched / total) * 75;
  } else {
    // Fallback: keyword overlap between the job text and the resume text.
    const jobKeywords = extractKeywords(`${job.title} ${job.description}`, { includePhrases: false });
    const resumeKeywords = extractKeywords(resume.rawText || '', { includePhrases: false });
    let hits = 0;
    jobKeywords.forEach((k) => resumeKeywords.has(k) && (hits += 1));
    keywordOverlap = jobKeywords.size ? hits / jobKeywords.size : 0;
    base = keywordOverlap * 75;
  }

  // --- bonuses --------------------------------------------------------
  const resumeYears = ((resume.experience || []).reduce((sum, e) => sum + (e.months || 0), 0) || 0) / 12;
  const jobLevel = job.experience_level || guessSeniority(job.title);

  const titleScore = titleSimilarity(job.title, resume);
  const expScore = experienceFit(jobLevel, resumeYears);
  const locScore = locationFit(job.location, job.job_type, options.preferredLocations);

  // Years-of-experience bonus: does the resume clear the stated bar?
  const reqYears = requiredYears(job);
  const yearsScore = reqYears ? (resumeYears >= reqYears ? 1 : Math.max(0.2, resumeYears / reqYears)) : 0.75;

  const bonus = titleScore * 10 + expScore * 5 + locScore * 5 + yearsScore * 5;

  const raw = base + bonus;
  const matchScore = Math.max(0, Math.min(100, Math.round(raw * 10) / 10));

  const result = {
    matchScore,
    matchedSkills: matchedSkills.slice(0, 20),
    missingSkills: missingSkills.slice(0, 20),
    requiredSkills: requiredSkills.slice(0, 30),
    breakdown: {
      required: total,
      matched,
      missing: missingSkills.length,
      baseScore: Math.round(base * 10) / 10,
      titleBonus: Math.round(titleScore * 10 * 10) / 10,
      experienceBonus: Math.round(expScore * 5 * 10) / 10,
      locationBonus: Math.round(locScore * 5 * 10) / 10,
      yearsBonus: Math.round(yearsScore * 5 * 10) / 10,
      keywordOverlap: Math.round(keywordOverlap * 100) / 100,
      requiredYears: reqYears,
      yourYears: Math.round(resumeYears * 10) / 10,
    },
  };

  return result;
}

/**
 * Score a whole list of jobs (used by the scraper and by /api/jobs).
 * @returns the input array with matchScore/matchedSkills/missingSkills filled in
 */
function matchJobs(jobs = [], resume = {}, options = {}) {
  if (!resume || !resume.skills) {
    return jobs.map((j) => ({ ...j, matchScore: 0, matchedSkills: [], missingSkills: [] }));
  }
  return jobs.map((job) => {
    const m = matchJobToResume(job, resume, options);
    return {
      ...job,
      matchScore: m.matchScore,
      matchedSkills: m.matchedSkills,
      missingSkills: m.missingSkills,
    };
  });
}

/**
 * One-line explanation of the score, shown in the job card tooltip.
 */
function explainMatch(match) {
  const { matchedSkills = [], missingSkills = [], requiredSkills = [] } = match || {};
  if (!requiredSkills.length) return 'Score based on keyword overlap — the posting lists no explicit requirements.';

  const parts = [
    `You match ${matchedSkills.length} of ${requiredSkills.length} required skills.`,
    matchedSkills.length ? `Strongest: ${matchedSkills.slice(0, 5).join(', ')}.` : '',
    missingSkills.length ? `Gaps: ${missingSkills.slice(0, 5).join(', ')}.` : '',
  ];
  return parts.filter(Boolean).join(' ');
}

/**
 * Aggregate the most common missing skills across a set of jobs –
 * powers the "Skill Gaps" widget on the dashboard.
 *
 * @param {Array<{missingSkills:string[]|string}>} jobs
 * @param {number} [limit]
 * @returns {Array<{skill:string,count:number,percentage:number}>}
 */
function topSkillGaps(jobs = [], limit = 8) {
  const counts = new Map();
  let scanned = 0;

  jobs.forEach((job) => {
    let missing = job.missingSkills;
    if (typeof missing === 'string') {
      try {
        missing = JSON.parse(missing);
      } catch {
        missing = [];
      }
    }
    if (!Array.isArray(missing) || missing.length === 0) return;
    scanned += 1;
    new Set(missing).forEach((skill) => {
      const key = skillKey(skill);
      if (!key) return;
      counts.set(key, (counts.get(key) || 0) + 1);
    });
  });

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([skill, count]) => ({
      skill: skill.replace(/\b\w/g, (c) => c.toUpperCase()),
      count,
      percentage: scanned ? Math.round((count / scanned) * 100) : 0,
    }));
}

module.exports = {
  matchJobToResume,
  matchJobs,
  extractKeywords,
  extractRequiredSkills,
  toRequirementArray,
  titleSimilarity,
  experienceFit,
  locationFit,
  requiredYears,
  explainMatch,
  topSkillGaps,
  skillKey,
  STOP_WORDS,
};
