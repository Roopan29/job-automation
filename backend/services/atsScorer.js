/**
 * backend/services/atsScorer.js
 * ------------------------------------------------------------------
 * Applicant-Tracking-System friendliness score for a resume.
 *
 * The score is out of 100 and is the sum of 8 weighted categories:
 *
 *   contactInfo      10   email + phone + at least one link
 *   summary          10   a real summary/objective paragraph
 *   skills           20   skills section present AND populated
 *   experience       20   roles with dates + descriptive bullets
 *   education        10   at least one degree entry
 *   formatting       10   ATS-safe layout (no tables/columns/art noise)
 *   actionVerbs      10   bullets that start with strong verbs
 *   length           10   400–800 words is the sweet spot
 *
 * scoreResume(text, parsed) -> {
 *   totalScore, grade, breakdown: { key: { label, score, max, details[] } },
 *   tips: string[]
 * }
 */

const { toLines, splitSections } = require('./resumeParser');
const log = require('../utils/logger');

/** Weights, in the order the report is rendered. */
const WEIGHTS = {
  contactInfo: 10,
  summary: 10,
  skills: 20,
  experience: 20,
  education: 10,
  formatting: 10,
  actionVerbs: 10,
  length: 10,
};

const LABELS = {
  contactInfo: 'Contact Info',
  summary: 'Professional Summary',
  skills: 'Skills Section',
  experience: 'Work Experience',
  education: 'Education',
  formatting: 'ATS Formatting',
  actionVerbs: 'Action Verbs',
  length: 'Length',
};

/** Strong verbs recruiters / ATS look for at the start of a bullet. */
const ACTION_VERBS = [
  'achieved', 'accelerated', 'administered', 'analyzed', 'architected', 'automated', 'built',
  'championed', 'collaborated', 'conducted', 'consolidated', 'coordinated', 'created', 'cut',
  'delivered', 'designed', 'developed', 'devised', 'diagnosed', 'directed', 'documented',
  'drove', 'eliminated', 'engineered', 'enhanced', 'established', 'evaluated', 'exceeded',
  'executed', 'expanded', 'facilitated', 'founded', 'generated', 'grew', 'headed',
  'implemented', 'improved', 'increased', 'influenced', 'initiated', 'integrated',
  'introduced', 'launched', 'led', 'managed', 'mentored', 'migrated', 'modernized',
  'negotiated', 'optimized', 'orchestrated', 'organized', 'owned', 'partnered', 'pioneered',
  'planned', 'prioritized', 'produced', 'programmed', 'prototyped', 'reduced', 'refactored',
  'released', 'researched', 'resolved', 'revamped', 'scaled', 'secured', 'shipped',
  'simplified', 'spearheaded', 'standardized', 'streamlined', 'strengthened', 'supervised',
  'tested', 'trained', 'transformed', 'unified', 'upgraded',
];

/** Signs that a PDF was exported from a two-column / table heavy layout. */
const FORMATTING_RED_FLAGS = [
  { re: /\|.*\|.*\|/, label: 'table-like pipes' },
  { re: /^[\t ]{6,}\S/m, label: 'heavy indentation (possible columns)' },
  { re: /[\u2022\u25cf\u25aa\u25cb]/, label: 'non-standard bullet glyphs' },
  { re: /[A-Za-z]{25,}/, label: 'missing spaces between words' },
  { re: /^\s*\d{1,2}\s+[A-Za-z]{3,}\s+\d{4}\s+[A-Za-z]/m, label: 'interleaved dates (column layout)' },
];

/** Letter grade for a 0–100 score. */
function gradeFor(score) {
  if (score >= 90) return 'A+';
  if (score >= 80) return 'A';
  if (score >= 70) return 'B';
  if (score >= 60) return 'C';
  if (score >= 50) return 'D';
  return 'F';
}

/* ------------------------------------------------------------------ *
 * Individual category scorers
 * ------------------------------------------------------------------ */

function scoreContactInfo(parsed) {
  const c = parsed.contact || {};
  const details = [];
  let score = 0;

  if (c.email) {
    score += 4;
    details.push('Email found');
  } else details.push('No email address detected');

  if (c.phone) {
    score += 3;
    details.push('Phone number found');
  } else details.push('No phone number detected');

  if (c.linkedin || c.github || c.website) {
    score += 3;
    details.push('Profile / portfolio link found');
  } else details.push('Add a LinkedIn or portfolio URL');

  if (!c.name) details.push('Could not detect your full name at the top');

  return { score: Math.min(score, WEIGHTS.contactInfo), details };
}

function scoreSummary(parsed) {
  const summary = parsed.summary || '';
  const words = summary.split(/\s+/).filter(Boolean).length;
  const details = [];
  let score = 0;

  if (words >= 25 && words <= 120) {
    score = 10;
    details.push(`Summary is a good length (${words} words)`);
  } else if (words >= 10) {
    score = 6;
    details.push(`Summary is short (${words} words) — aim for 30–80`);
  } else if (words > 0) {
    score = 3;
    details.push('Summary looks like a fragment rather than a paragraph');
  } else {
    details.push('No professional summary or objective section found');
  }

  // Quantified results in the summary are a big plus.
  if (/\d+%|\$\d|\d+\+/.test(summary)) details.push('Nice — summary contains metrics');
  else if (score > 0) details.push('Consider adding one measurable result to the summary');

  return { score, details };
}

function scoreSkills(parsed) {
  const skills = parsed.skills || [];
  const details = [];
  const count = skills.length;

  let score;
  if (count >= 20) {
    score = 20;
    details.push(`${count} recognisable skills — excellent keyword coverage`);
  } else if (count >= 12) {
    score = 16;
    details.push(`${count} recognisable skills — good coverage`);
  } else if (count >= 6) {
    score = 10;
    details.push(`Only ${count} recognisable skills — ATS keyword matching will suffer`);
  } else if (count > 0) {
    score = 5;
    details.push(`Just ${count} recognisable skill${count === 1 ? '' : 's'} found`);
  } else {
    score = 0;
    details.push('No skills detected at all — add a dedicated Skills section');
  }

  const categories = new Set(skills.map((s) => s.category));
  if (categories.size >= 4) details.push(`Skills span ${categories.size} categories — well rounded`);
  else if (count > 0) details.push('Group skills by category (languages, tools, cloud…)');

  return { score: Math.min(score, WEIGHTS.skills), details };
}

function scoreExperience(parsed, text) {
  const exp = parsed.experience || [];
  const details = [];
  let score = 0;

  if (exp.length === 0) {
    // The block parser found nothing, but bullet lines may still exist.
    const bulletCount = (text.match(/^[•\-–*]\s+\S/gm) || []).length;
    if (bulletCount >= 3) {
      score = 8;
      details.push('Found bullet points but could not detect role/date structure');
      details.push('Use the format: Job Title | Company | Mon YYYY – Mon YYYY');
    } else {
      details.push('No work experience section detected');
    }
    return { score, details };
  }

  score += Math.min(8, exp.length * 2.5);
  details.push(`${exp.length} role${exp.length === 1 ? '' : 's'} detected`);

  const withDates = exp.filter((e) => e.startDate && e.endDate);
  score += withDates.length === exp.length ? 6 : withDates.length > 0 ? 4 : 0;
  details.push(
    withDates.length === exp.length
      ? 'Every role has start and end dates'
      : `${withDates.length}/${exp.length} roles have complete date ranges`
  );

  const withDescription = exp.filter((e) => (e.description || '').split(/\s+/).length >= 20);
  score += withDescription.length > 0 ? 6 : 0;
  details.push(
    withDescription.length > 0
      ? `${withDescription.length} role(s) include detailed bullet points`
      : 'Add 2–4 bullet points describing impact for each role'
  );

  const quantified = exp.filter((e) => /\d+%|\$\d|\d+x|\d+\+/.test(e.description || '')).length;
  if (quantified > 0) details.push(`${quantified} role(s) mention measurable results — great`);
  else details.push('Add numbers (%, $, users, time saved) to your bullets');

  return { score: Math.min(Math.round(score), WEIGHTS.experience), details };
}

function scoreEducation(parsed) {
  const edu = parsed.education || [];
  const details = [];
  let score = 0;

  if (edu.length > 0) {
    score = 8;
    details.push(`${edu.length} education entr${edu.length === 1 ? 'y' : 'ies'} found`);
    if (edu.some((e) => e.year)) score += 2;
    if (edu.every((e) => !e.year)) details.push('Add graduation years to each degree');
  } else {
    details.push('No education section detected');
    details.push('Even bootcamps and certifications count — list them');
  }

  return { score: Math.min(score, WEIGHTS.education), details };
}

function scoreFormatting(text) {
  const details = [];
  const hits = FORMATTING_RED_FLAGS.filter((f) => f.re.test(text));
  let score = WEIGHTS.formatting;

  hits.slice(0, 3).forEach((h) => {
    score -= 3;
    details.push(`Detected ${h.label} — ATS parsers read these poorly`);
  });

  if (hits.length === 0) details.push('Clean single-column layout — parser friendly');

  // Very long unbroken runs suggest the PDF lost its line breaks.
  const longestLine = Math.max(0, ...text.split('\n').map((l) => l.length));
  if (longestLine > 400) {
    score -= 2;
    details.push('Some lines are extremely long — check for lost line breaks');
  }

  return { score: Math.max(0, Math.min(score, WEIGHTS.formatting)), details };
}

function scoreActionVerbs(parsed, text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  // Prefer genuine bullet lines. Only when a resume has almost no glyph
  // bullets do we fall back to "any sentence-looking line", otherwise
  // headings and contact lines dilute the ratio unfairly.
  const glyphBullets = lines.filter((l) => /^[•\-–*▪‣]\s+/.test(l));
  const bullets =
    glyphBullets.length >= 3
      ? glyphBullets
      : lines.filter((l) => /^[A-Z][a-z]+\s+\S+/.test(l) && l.split(/\s+/).length >= 4 && !/@|http/.test(l));

  const startsWithVerb = bullets.filter((b) => {
    const first = b.replace(/^[•\-–*▪‣\s]+/, '').split(/\s+/)[0] || '';
    return ACTION_VERBS.includes(first.toLowerCase().replace(/[,.;:]/g, ''));
  });

  const ratio = bullets.length ? startsWithVerb.length / bullets.length : 0;
  const details = [];
  let score;

  if (ratio >= 0.5 && startsWithVerb.length >= 4) {
    score = 10;
    details.push(`${startsWithVerb.length} bullets open with a strong action verb`);
  } else if (ratio >= 0.25) {
    score = 6;
    details.push(`${startsWithVerb.length} bullet(s) start with an action verb — aim for most of them`);
  } else if (startsWithVerb.length > 0) {
    score = 3;
    details.push('Only a couple of bullets use action verbs');
  } else {
    score = 0;
    details.push('Rewrite bullets to start with verbs like Built, Led, Optimized, Shipped');
  }

  if (/responsible for|worked on|helped with|duties included/i.test(text)) {
    score = Math.max(0, score - 2);
    details.push('Avoid passive phrases such as "responsible for"');
  }

  return { score: Math.min(score, WEIGHTS.actionVerbs), details };
}

function scoreLength(parsed) {
  const words = parsed.wordCount || 0;
  const details = [];
  let score;

  if (words >= 400 && words <= 800) {
    score = 10;
    details.push(`${words} words — ideal length (400–800)`);
  } else if (words >= 300 && words < 400) {
    score = 7;
    details.push(`${words} words — slightly short, ideal is 400–800`);
  } else if (words > 800 && words <= 1100) {
    score = 7;
    details.push(`${words} words — a little long, trim anything irrelevant`);
  } else if (words > 1100) {
    score = 4;
    details.push(`${words} words — too long for most ATS screens (aim under 1000)`);
  } else if (words >= 150) {
    score = 4;
    details.push(`${words} words — quite thin for a professional resume`);
  } else {
    score = 1;
    details.push(`Only ${words} words extracted — is the resume a scanned image?`);
  }

  return { score: Math.min(score, WEIGHTS.length), details };
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * Score a resume.
 *
 * @param {string} rawText     extracted resume text
 * @param {object} [parsed]    output of resumeParser.parseResume(Text)
 * @returns {{totalScore:number, grade:string, breakdown:object, tips:string[]}}
 */
function scoreResume(rawText, parsed = {}) {
  const text = String(rawText || '');

  const results = {
    contactInfo: scoreContactInfo(parsed),
    summary: scoreSummary(parsed),
    skills: scoreSkills(parsed),
    experience: scoreExperience(parsed, text),
    education: scoreEducation(parsed),
    formatting: scoreFormatting(text),
    actionVerbs: scoreActionVerbs(parsed, text),
    length: scoreLength(parsed),
  };

  const breakdown = {};
  let totalScore = 0;

  Object.keys(WEIGHTS).forEach((key) => {
    const { score, details } = results[key] || { score: 0, details: [] };
    const max = WEIGHTS[key];
    const clamped = Math.max(0, Math.min(score, max));
    totalScore += clamped;
    breakdown[key] = { label: LABELS[key], score: clamped, max, details };
  });

  totalScore = Math.round(totalScore);

  // Tips = every detail line belonging to a category that lost points,
  // worst category first.
  const tips = Object.entries(breakdown)
    .filter(([, b]) => b.score < b.max)
    .sort((a, b) => a[1].score / a[1].max - b[1].score / b[1].max)
    .flatMap(([key, b]) =>
      b.details
        .filter((d) => /no |only |add |avoid |consider |could not|too |slightly|quite|just |detected .*poorly/i.test(d))
        .map((d) => `${b.label}: ${d}`)
    )
    .slice(0, 10);

  if (tips.length === 0) tips.push('Strong resume — keep tailoring keywords per job posting.');

  log.info(`atsScorer: total ${totalScore}/100 (${gradeFor(totalScore)})`);

  return { totalScore, grade: gradeFor(totalScore), breakdown, tips };
}

/**
 * Quick one-number score (used when storing a resume row).
 */
function quickScore(rawText, parsed) {
  return scoreResume(rawText, parsed).totalScore;
}

module.exports = { scoreResume, quickScore, gradeFor, WEIGHTS, LABELS, ACTION_VERBS };
