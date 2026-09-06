/**
 * backend/services/aiService.js
 * ------------------------------------------------------------------
 * Every OpenAI call the tool makes, in one place.
 *
 * Exported functions:
 *   generateCoverLetter(jobDetails, resumeData, tone)      -> string
 *   generateInterviewQuestions(jobDetails, resumeData)     -> [{question, suggestedAnswer}]
 *   generateFollowUpEmail(jobDetails, applicationDate)     -> string
 *   getResumeImprovements(resumeText, targetRole)          -> string[]
 *   generateSkillGapAnalysis(missingSkills, targetRole)    -> {summary, skills:[{skill, why, resources, effort}]}
 *
 * Behaviour without an API key:
 *   `isConfigured()` returns false and every function rejects with an
 *   Error whose `.code` is "NO_API_KEY". Callers (coverLetterGen.js,
 *   the controllers) catch that and fall back to a deterministic local
 *   template so the app is still fully usable offline.
 *
 * Behaviour with an API key:
 *   Calls chat.completions with a system + user prompt, retries once on
 *   a 429 / 5xx, and never lets a raw SDK error escape.
 */

const log = require('../utils/logger');

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const MAX_TOKENS = Number(process.env.OPENAI_MAX_TOKENS || 1200);
const TEMPERATURE = Number(process.env.OPENAI_TEMPERATURE || 0.7);

/** @type {any|null} lazily created OpenAI client */
let client = null;
/** Set once we know the key is bad, so we stop hammering the API. */
let disabled = false;

/** The configured key, ignoring the shipped placeholder. */
function apiKey() {
  const key = (process.env.OPENAI_API_KEY || '').trim();
  if (!key || key === 'your_openai_api_key_here' || key.startsWith('<')) return '';
  return key;
}

/** Is a real OpenAI key present? */
function isConfigured() {
  return Boolean(apiKey()) && !disabled;
}

/** Build (and memoise) the OpenAI client. */
function getClient() {
  if (client) return client;
  const key = apiKey();
  if (!key) return null;
  try {
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    const OpenAI = require('openai');
    client = new OpenAI({ apiKey: key });
    return client;
  } catch (err) {
    log.error(`Could not initialise the OpenAI SDK: ${err.message}`);
    disabled = true;
    return null;
  }
}

/** Error thrown when AI features are unavailable. */
class AiUnavailableError extends Error {
  constructor(message = 'OpenAI is not configured. Add OPENAI_API_KEY to backend/.env to enable AI features.') {
    super(message);
    this.name = 'AiUnavailableError';
    this.code = 'NO_API_KEY';
  }
}

/**
 * Drop the memoised client so a newly saved API key takes effect
 * without restarting the server.
 * @param {string} [newKey] when supplied, also updates process.env
 */
function resetClient(newKey) {
  if (newKey !== undefined) {
    if (newKey) process.env.OPENAI_API_KEY = newKey;
    else delete process.env.OPENAI_API_KEY;
  }
  client = null;
  disabled = false;
  return isConfigured();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Low level chat call with one retry on transient failures.
 *
 * @param {string} system  system prompt
 * @param {string} user    user prompt
 * @param {object} [opts]  { temperature, maxTokens, json, model }
 * @returns {Promise<string>} the assistant message (trimmed)
 */
async function chat(system, user, opts = {}) {
  const openai = getClient();
  if (!openai) throw new AiUnavailableError();

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  const params = {
    model: opts.model || MODEL,
    messages,
    temperature: opts.temperature ?? TEMPERATURE,
    max_tokens: opts.maxTokens ?? MAX_TOKENS,
  };
  if (opts.json) params.response_format = { type: 'json_object' };

  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      log.info(`aiService → ${params.model} (attempt ${attempt})`);
      const completion = await openai.chat.completions.create(params);
      const content = completion.choices?.[0]?.message?.content;
      if (!content) throw new Error('OpenAI returned an empty response');
      return content.trim();
    } catch (err) {
      lastError = err;
      const status = err.status || err.response?.status;
      const retryable = status === 429 || (status >= 500 && status < 600) || err.code === 'ECONNRESET';

      if (status === 401 || status === 403) {
        disabled = true;
        throw new AiUnavailableError('OpenAI rejected the API key (401/403). Check OPENAI_API_KEY in backend/.env.');
      }
      if (!retryable || attempt === 2) break;

      const backoff = 1500 * attempt;
      log.warn(`aiService: ${err.message} – retrying in ${backoff}ms`);
      await sleep(backoff);
    }
  }

  throw new Error(`OpenAI call failed: ${lastError?.message || 'unknown error'}`);
}

/** Safely parse a JSON reply, tolerating code fences. */
function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    const fenced = String(text).match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
      try {
        return JSON.parse(fenced[1].trim());
      } catch {
        /* fall through */
      }
    }
    return fallback;
  }
}

/** Turn "- point\n- point" or "1. point" into a string array. */
function bulletList(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter((l) => l.length > 3);
}

/* ------------------------------------------------------------------ *
 * Prompt helpers
 * ------------------------------------------------------------------ */

/** Compact description of the candidate, safe to embed in a prompt. */
function resumeBlurb(resume = {}) {
  const skills = (resume.skills || [])
    .map((s) => (typeof s === 'string' ? s : s.name))
    .slice(0, 30)
    .join(', ');

  const experience = (resume.experience || [])
    .slice(0, 4)
    .map((e) => `• ${e.title} at ${e.company || 'unknown company'} (${e.startDate || '?'} → ${e.endDate || '?'}): ${(e.description || '').slice(0, 300)}`)
    .join('\n');

  const education = (resume.education || [])
    .slice(0, 3)
    .map((e) => `• ${e.degree}${e.institution ? ` — ${e.institution}` : ''}${e.year ? ` (${e.year})` : ''}`)
    .join('\n');

  return [
    `Candidate name: ${resume.contact?.name || 'the candidate'}`,
    `Professional summary: ${resume.summary || 'not available'}`,
    `Skills: ${skills || 'not extracted'}`,
    `Experience:\n${experience || 'none parsed'}`,
    `Education:\n${education || 'none parsed'}`,
  ].join('\n\n');
}

/**
 * Compact description of the job, safe to embed in a prompt.
 * `requirements` may be an array (DB row) or a JSON string (freshly
 * scraped job), so both are normalised here.
 */
function jobBlurb(job = {}) {
  let requirements = job.requirements;
  if (typeof requirements === 'string') {
    try {
      requirements = JSON.parse(requirements);
    } catch {
      requirements = requirements.split('\n').filter(Boolean);
    }
  }
  const reqText = Array.isArray(requirements) && requirements.length
    ? requirements.slice(0, 12).join('; ')
    : 'not listed';

  return [
    `Job title: ${job.title || 'Unknown'}`,
    `Company: ${job.company || 'Unknown'}`,
    `Location: ${job.location || 'Unknown'}`,
    `Job type: ${job.job_type || 'any'}`,
    `Experience level: ${job.experience_level || 'unspecified'}`,
    `Requirements: ${reqText}`,
    `Description:\n${String(job.description || '').slice(0, 2500) || 'not available'}`,
  ].join('\n');
}

const TONE_GUIDE = {
  professional:
    'Tone: professional and polished. Formal but warm, no slang, no exclamation marks, confident without being arrogant.',
  friendly:
    'Tone: friendly and personable. Conversational, first person, a little warmth and enthusiasm, still workplace appropriate.',
  confident:
    'Tone: confident and results driven. Direct, assertive, lead with measurable achievements, short punchy sentences.',
};

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * Generate a tailored cover letter.
 * @param {object} jobDetails
 * @param {object} resumeData
 * @param {'professional'|'friendly'|'confident'} [tone]
 * @returns {Promise<string>}
 */
async function generateCoverLetter(jobDetails = {}, resumeData = {}, tone = 'professional') {
  const system = [
    'You are an expert career coach and technical recruiter who writes cover letters that get interviews.',
    'Rules: 250–350 words, 3–4 short paragraphs, plain text only (no markdown, no headers, no placeholders).',
    'Open by naming the role and company. Tie two or three specific resume achievements to two or three specific job requirements.',
    'Never invent achievements, employers, dates or metrics that are not in the supplied resume.',
    'Close with a clear, specific call to action. Sign off with the candidate name.',
    TONE_GUIDE[tone] || TONE_GUIDE.professional,
  ].join('\n');

  const user = [
    'Write the cover letter for this job:',
    '--- JOB ---',
    jobBlurb(jobDetails),
    '',
    '--- CANDIDATE RESUME ---',
    resumeBlurb(resumeData),
    '',
    'Return only the cover letter text.',
  ].join('\n');

  return chat(system, user, { maxTokens: 900, temperature: 0.75 });
}

/**
 * Generate 10 likely interview questions with suggested answers.
 * @returns {Promise<Array<{question:string, suggestedAnswer:string}>>}
 */
async function generateInterviewQuestions(jobDetails = {}, resumeData = {}) {
  const system = [
    'You are a senior hiring manager preparing a candidate for an interview.',
    'Produce exactly 10 questions: a mix of technical, behavioural and role specific ones.',
    'Answers must be 3–6 sentences, grounded in the candidate resume, and use the STAR structure where relevant.',
    'Respond with strict JSON: {"questions":[{"question":"...","suggestedAnswer":"..."}]}',
  ].join('\n');

  const user = [
    '--- JOB ---',
    jobBlurb(jobDetails),
    '',
    '--- CANDIDATE RESUME ---',
    resumeBlurb(resumeData),
    '',
    'Return the JSON object now.',
  ].join('\n');

  const raw = await chat(system, user, { maxTokens: 1600, temperature: 0.6, json: true });
  const parsed = parseJson(raw, { questions: [] });
  const questions = Array.isArray(parsed.questions) ? parsed.questions : [];

  return questions.slice(0, 10).map((q, i) => ({
    id: i + 1,
    question: String(q.question || '').trim(),
    suggestedAnswer: String(q.suggestedAnswer || q.answer || '').trim(),
  })).filter((q) => q.question);
}

/**
 * Generate a follow-up email after applying (or after an interview).
 * @returns {Promise<string>}
 */
async function generateFollowUpEmail(jobDetails = {}, applicationDate) {
  const daysSince = applicationDate
    ? Math.max(0, Math.round((Date.now() - new Date(applicationDate).getTime()) / 86400000))
    : null;

  const system = [
    'You are a career coach writing a short, polite follow-up email to a recruiter or hiring manager.',
    'Rules: 90–150 words, plain text, subject line on the first line prefixed with "Subject: ".',
    'Restate interest, mention one concrete value point, ask for a status update, thank them.',
    'No markdown, no placeholders.',
  ].join('\n');

  const user = [
    '--- JOB ---',
    jobBlurb(jobDetails),
    daysSince !== null ? `\nThe candidate applied ${daysSince} day(s) ago (${new Date(applicationDate).toDateString()}).` : '',
    '\nWrite the follow-up email.',
  ].join('\n');

  return chat(system, user, { maxTokens: 400, temperature: 0.6 });
}

/**
 * Ask the model for concrete resume improvements.
 * @returns {Promise<string[]>} bullet list of suggestions
 */
async function getResumeImprovements(resumeText = '', targetRole = '') {
  const system = [
    'You are a resume writer specialising in ATS optimisation for tech roles.',
    'Return 8–12 short, specific, actionable bullets. Each bullet starts with a verb.',
    'Reference concrete problems you can see in the text (missing metrics, weak verbs, keyword gaps, formatting).',
    'Plain text, one bullet per line, no numbering.',
  ].join('\n');

  const user = [
    targetRole ? `Target role: ${targetRole}` : 'Target role: not specified (assume a senior software engineering role).',
    '',
    '--- RESUME TEXT ---',
    String(resumeText).slice(0, 6000) || '(empty resume)',
    '',
    'Return the bullets now.',
  ].join('\n');

  const raw = await chat(system, user, { maxTokens: 800, temperature: 0.5 });
  const list = bulletList(raw);
  return list.length ? list : ['No suggestions returned – try again or check your API key.'];
}

/**
 * Turn a list of missing skills into a study plan.
 * @returns {Promise<{summary:string, skills:Array}>}
 */
async function generateSkillGapAnalysis(missingSkills = [], targetRole = '') {
  const skills = (missingSkills || []).slice(0, 8);

  const system = [
    'You are a technical mentor building a learning plan for a job seeker.',
    'For each skill explain why it matters for the target role, give one concrete first project,',
    'name one free resource, and estimate the effort in weeks.',
    'Respond with strict JSON: {"summary":"2-3 sentences","skills":[{"skill":"...","why":"...","firstProject":"...","resource":"...","effortWeeks":n}]}',
  ].join('\n');

  const user = [
    targetRole ? `Target role: ${targetRole}` : 'Target role: software engineer.',
    `Missing skills: ${skills.join(', ') || 'none'}`,
    'Return the JSON object now.',
  ].join('\n');

  const raw = await chat(system, user, { maxTokens: 1200, temperature: 0.5, json: true });
  const parsed = parseJson(raw, {});

  return {
    summary: String(parsed.summary || 'Focus on the skills below to close the gap for this role.').trim(),
    skills: (Array.isArray(parsed.skills) ? parsed.skills : skills.map((skill) => ({ skill }))).map((s) => ({
      skill: s.skill || '',
      why: s.why || '',
      firstProject: s.firstProject || '',
      resource: s.resource || '',
      effortWeeks: Number(s.effortWeeks) || 2,
    })),
  };
}

/**
 * Verify the API key by sending a 1-token ping.
 * Used by the "Test API Connection" button on the Preferences page.
 * @returns {Promise<{ok:boolean, model:string, message:string, ms:number}>}
 */
async function testConnection() {
  const started = Date.now();
  try {
    const reply = await chat(
      'You are a connectivity test. Reply with the single word: ok',
      'ping',
      { maxTokens: 5, temperature: 0 }
    );
    return { ok: true, model: MODEL, message: `OpenAI responded: "${reply.slice(0, 40)}"`, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, model: MODEL, message: err.message, ms: Date.now() - started };
  }
}

module.exports = {
  generateCoverLetter,
  generateInterviewQuestions,
  generateFollowUpEmail,
  getResumeImprovements,
  generateSkillGapAnalysis,
  testConnection,
  isConfigured,
  resetClient,
  apiKey,
  chat,
  bulletList,
  parseJson,
  resumeBlurb,
  jobBlurb,
  AiUnavailableError,
  MODEL,
};
