/**
 * backend/services/coverLetterGen.js
 * ------------------------------------------------------------------
 * Cover letter generation with two modes:
 *
 *   1. AI mode      – OpenAI via aiService.generateCoverLetter()
 *   2. Template mode – a deterministic, well-written letter assembled
 *                      from the parsed resume + the job requirements.
 *                      Used when no API key is configured, when the API
 *                      call fails, or when the caller asks for it.
 *
 * The returned object always says which mode produced the text so the
 * UI can show a "generated without AI" hint instead of pretending.
 *
 *   buildCoverLetter(job, resume, { tone, forceTemplate }) -> {
 *     coverLetter, source: 'ai' | 'template', message
 *   }
 */

const aiService = require('./aiService');
const { matchJobToResume } = require('./matchingEngine');
const log = require('../utils/logger');

/** Sentence starters per tone, so the template does not read robotic. */
const TONE_OPENERS = {
  professional: [
    'I am writing to express my interest in the {title} position at {company}.',
    'With {years} years of experience in {focus}, I am confident I can contribute meaningfully to your team.',
  ],
  friendly: [
    'When I saw the {title} opening at {company}, I knew I had to apply.',
    "I have spent the last {years} years building {focus}, and this role looks like exactly the kind of work I love.",
  ],
  confident: [
    'I am applying for the {title} role at {company} because it maps directly onto what I do best.',
    'Over {years} years I have shipped {focus} at scale, and I am ready to bring that to your team.',
  ],
};

const TONE_CLOSERS = {
  professional:
    'I would welcome the opportunity to discuss how my background aligns with your needs. Thank you for your time and consideration.',
  friendly:
    "I would love to chat about how I can help the team — I am happy to jump on a call whenever suits you. Thanks so much for reading!",
  confident:
    'I would be glad to walk you through the specifics and the results behind them. I look forward to the conversation.',
};

/** Pick a readable phrase for the candidate's strongest area. */
function focusArea(skills = []) {
  const names = skills.map((s) => (typeof s === 'string' ? s : s.name)).filter(Boolean);
  if (names.length === 0) return 'software engineering';
  if (names.length === 1) return names[0];
  return `${names[0]} and ${names[1]}`;
}

/** Total years of experience from parsed roles. */
function yearsOfExperience(resume = {}) {
  const months = (resume.experience || []).reduce((sum, e) => sum + (e.months || 0), 0);
  const years = Math.floor(months / 12);
  return years > 0 ? years : 'several';
}

/** Fill {placeholders} in a template string. */
function fill(template, values) {
  return template.replace(/\{(\w+)\}/g, (_, key) => (values[key] !== undefined ? values[key] : `{${key}}`));
}

/**
 * Build a cover letter without any AI.
 * Deterministic, always available, and genuinely tailored: it quotes the
 * job requirements the resume actually satisfies.
 */
function templateCoverLetter(job = {}, resume = {}, tone = 'professional') {
  const safeTone = TONE_OPENERS[tone] ? tone : 'professional';
  const skills = resume.skills || [];
  const match = matchJobToResume(job, resume);

  const values = {
    title: job.title || 'this role',
    company: job.company || 'your company',
    years: yearsOfExperience(resume),
    focus: focusArea(skills),
    name: resume.contact?.name || 'The Candidate',
  };

  const paragraphs = [];

  // --- 1. Opening -----------------------------------------------------
  paragraphs.push(fill(TONE_OPENERS[safeTone].join(' '), values));

  // --- 2. Why I fit (uses real parsed achievements) --------------------
  const achievements = (resume.experience || [])
    .flatMap((e) =>
      (e.description || '')
        .split('\n')
        .map((b) => b.replace(/^[•\-–*▪‣\s]+/, '').trim())
        .filter((b) => b.length > 25 && /\d/.test(b))
    )
    .slice(0, 2);

  if (achievements.length) {
    paragraphs.push(
      `In my most recent work I ${achievements
        .map((a, i) => `${i === 0 ? '' : 'and I '}${a.charAt(0).toLowerCase()}${a.slice(1).replace(/\.$/, '')}`)
        .join(', ')}.`
    );
  } else if ((resume.experience || []).length) {
    const latest = resume.experience[0];
    paragraphs.push(
      `Most recently I worked as ${latest.title}${latest.company ? ` at ${latest.company}` : ''}, where I was responsible for delivering production software with ${focusArea(skills)}.`
    );
  }

  // --- 3. Requirement mapping -----------------------------------------
  const matched = (match.matchedSkills || []).slice(0, 5);
  if (matched.length) {
    paragraphs.push(
      `Your posting calls for ${matched.join(', ')}, all of which are core parts of my day-to-day work. ` +
        (match.missingSkills?.length
          ? `I am already ramping up on ${match.missingSkills.slice(0, 2).join(' and ')}, and I pick up new tooling quickly.`
          : 'I would need very little ramp-up time to start contributing.')
    );
  } else if (skills.length) {
    paragraphs.push(
      `My strongest areas are ${skills.slice(0, 5).map((s) => (typeof s === 'string' ? s : s.name)).join(', ')}, and I am keen to apply them to the problems your team is solving.`
    );
  }

  // --- 4. Why this company -------------------------------------------
  if (job.description) {
    const sentence = String(job.description)
      .split(/(?<=[.!?])\s+/)
      .find((s) => s.length > 40 && s.length < 200);
    if (sentence) {
      paragraphs.push(
        `What drew me to ${values.company} specifically is this: ${sentence.trim().replace(/\.$/, '')}. That is the kind of environment I do my best work in.`
      );
    }
  }

  // --- 5. Closing -------------------------------------------------------
  paragraphs.push(TONE_CLOSERS[safeTone]);
  paragraphs.push(`Sincerely,\n${values.name}`);

  return paragraphs.filter(Boolean).join('\n\n');
}

/**
 * Generate a cover letter, preferring AI and falling back to the
 * template engine.
 *
 * @param {object} job      job row / job object
 * @param {object} resume   parsed resume
 * @param {object} [opts]
 * @param {'professional'|'friendly'|'confident'} [opts.tone]
 * @param {boolean} [opts.forceTemplate] skip the AI call entirely
 * @returns {Promise<{coverLetter:string, source:'ai'|'template', message:string}>}
 */
async function buildCoverLetter(job = {}, resume = {}, opts = {}) {
  const tone = opts.tone || 'professional';
  const label = `${job.title || 'job'} at ${job.company || 'company'}`;

  if (opts.forceTemplate || !aiService.isConfigured()) {
    const letter = templateCoverLetter(job, resume, tone);
    log.info(`coverLetterGen: template letter for ${label} (${letter.length} chars)`);
    return {
      coverLetter: letter,
      source: 'template',
      message: aiService.isConfigured()
        ? 'Generated from the built-in template engine.'
        : 'Generated from the built-in template engine — add OPENAI_API_KEY to backend/.env for AI-written letters.',
    };
  }

  try {
    const letter = await aiService.generateCoverLetter(job, resume, tone);
    log.success(`coverLetterGen: AI letter for ${label} (${letter.length} chars)`);
    return { coverLetter: letter, source: 'ai', message: `Generated with OpenAI ${aiService.MODEL}.` };
  } catch (err) {
    log.warn(`coverLetterGen: AI failed (${err.message}) — using template`);
    return {
      coverLetter: templateCoverLetter(job, resume, tone),
      source: 'template',
      message: `AI generation failed (${err.message}). Used the built-in template instead.`,
    };
  }
}

/**
 * Interview prep with a template fallback, so the button never dead-ends.
 * @returns {Promise<{questions:Array, source:'ai'|'template'}>}
 */
async function buildInterviewPrep(job = {}, resume = {}) {
  if (aiService.isConfigured()) {
    try {
      const questions = await aiService.generateInterviewQuestions(job, resume);
      if (questions.length) return { questions, source: 'ai' };
    } catch (err) {
      log.warn(`interviewPrep: AI failed (${err.message}) — using template`);
    }
  }

  const skills = (resume.skills || []).map((s) => (typeof s === 'string' ? s : s.name)).slice(0, 4);
  const latest = (resume.experience || [])[0] || {};
  const missing = (matchJobToResume(job, resume).missingSkills || []).slice(0, 2);

  const questions = [
    {
      question: `Walk me through your experience as a ${latest.title || 'engineer'}.`,
      suggestedAnswer:
        `Start with your most recent role${latest.company ? ` at ${latest.company}` : ''}, the scope you owned, and one measurable outcome. Keep it under two minutes and end on why this role is the logical next step.`,
    },
    {
      question: `How have you used ${skills[0] || 'your strongest technology'} in production?`,
      suggestedAnswer:
        'Describe a concrete feature, the constraints you worked under, a hard trade-off you made, and the result (performance, reliability or delivery speed).',
    },
    {
      question: 'Tell me about a time you disagreed with a technical decision.',
      suggestedAnswer:
        'Use STAR: the situation, your position, how you made your case with data, the compromise or outcome, and what you would do differently.',
    },
    {
      question: `Our stack uses ${missing[0] || 'tooling you have not used'}. How would you get up to speed?`,
      suggestedAnswer:
        'Be honest about the gap, then describe a concrete 30-day plan: read the docs, rebuild a small version of a real feature, and pair with someone who knows it.',
    },
    {
      question: 'How do you approach code review?',
      suggestedAnswer:
        'Separate correctness from style, review in small batches, comment on the code not the person, and call out what was done well.',
    },
    {
      question: 'Describe a production incident you handled.',
      suggestedAnswer:
        'Cover detection, triage, the fix, the post-mortem and the preventative change. Emphasise communication under pressure.',
    },
    {
      question: `Why ${job.company || 'this company'}?`,
      suggestedAnswer:
        'Reference something specific from the job description or the product, then connect it to a problem you have solved before.',
    },
    {
      question: 'How do you handle ambiguous requirements?',
      suggestedAnswer:
        'Write down your assumptions, ship the smallest useful slice, get feedback early, and keep stakeholders in the loop.',
    },
    {
      question: 'What are you looking for in your next role?',
      suggestedAnswer:
        'Mention ownership, a specific technology direction from the posting, and the kind of team you do your best work in.',
    },
    {
      question: 'Do you have any questions for us?',
      suggestedAnswer:
        `Ask what success looks like in the first 90 days for the ${job.title || 'role'}, how the team ships, and what the biggest technical challenge is right now.`,
    },
  ];

  return { questions, source: 'template' };
}

/**
 * Follow-up email with a template fallback.
 * @returns {Promise<{emailDraft:string, source:'ai'|'template'}>}
 */
async function buildFollowUpEmail(job = {}, resume = {}, applicationDate) {
  if (aiService.isConfigured()) {
    try {
      const draft = await aiService.generateFollowUpEmail(job, applicationDate);
      if (draft) return { emailDraft: draft, source: 'ai' };
    } catch (err) {
      log.warn(`followUpEmail: AI failed (${err.message}) — using template`);
    }
  }

  const name = resume.contact?.name || 'The Candidate';
  const days = applicationDate
    ? Math.max(0, Math.round((Date.now() - new Date(applicationDate).getTime()) / 86400000))
    : null;

  const emailDraft = [
    `Subject: Following up on my ${job.title || 'application'} — ${name}`,
    '',
    `Dear ${job.company ? `${job.company} Hiring Team` : 'Hiring Team'},`,
    '',
    `I applied for the ${job.title || 'open role'} position${days !== null ? ` ${days} day(s) ago` : ' recently'} and wanted to follow up.`,
    '',
    `I remain very interested in the role. My background in ${focusArea(resume.skills || [])} lines up closely with what you are looking for, and I am confident I could contribute quickly to ${job.company || 'your team'}.`,
    '',
    'If it would help, I am happy to share additional work samples or references. I would appreciate any update on the timeline, and I remain available at your convenience.',
    '',
    'Thank you for your time and consideration.',
    '',
    `Best regards,`,
    `${name}${resume.contact?.email ? `\n${resume.contact.email}` : ''}${resume.contact?.phone ? `\n${resume.contact.phone}` : ''}`,
  ].join('\n');

  return { emailDraft, source: 'template' };
}

module.exports = {
  buildCoverLetter,
  buildInterviewPrep,
  buildFollowUpEmail,
  templateCoverLetter,
  focusArea,
  yearsOfExperience,
};
