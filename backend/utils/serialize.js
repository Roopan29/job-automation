/**
 * utils/serialize.js
 * ------------------------------------------------------------------
 * SQLite stores JSON columns as TEXT. These helpers convert database
 * rows into clean API payloads (camelCase, real arrays/objects, real
 * booleans) and back again, so no controller has to repeat the same
 * JSON.parse boilerplate – and a corrupt value never crashes a request.
 */

/** Parse a JSON TEXT column, falling back to a safe default. */
function parseJson(value, fallback = []) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

/** Stringify a value for a JSON TEXT column. */
function toJson(value, fallback = []) {
  try {
    return JSON.stringify(value ?? fallback);
  } catch {
    return JSON.stringify(fallback);
  }
}

/** SQLite stores booleans as 0/1 – make them real booleans again. */
function toBool(value) {
  return Boolean(Number(value));
}

/** Coerce anything the UI sends into a safe string. */
function toStr(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value).trim();
}

/** Coerce to an integer, or null when not numeric. */
function toInt(value, fallback = null) {
  const n = Number.parseInt(value, 10);
  return Number.isNaN(n) ? fallback : n;
}

/** Coerce to a float, or null when not numeric. */
function toNum(value, fallback = null) {
  const n = Number.parseFloat(value);
  return Number.isNaN(n) ? fallback : n;
}

/* ------------------------------------------------------------------ *
 * Row mappers
 * ------------------------------------------------------------------ */

/** resumes row -> API payload */
function mapResume(row) {
  if (!row) return null;
  return {
    id: row.id,
    fileName: row.file_name,
    originalName: row.original_name,
    filePath: row.file_path,
    fileType: row.file_type,
    label: row.label,
    skills: parseJson(row.skills, []),
    experience: parseJson(row.experience, []),
    education: parseJson(row.education, []),
    summary: row.summary || '',
    atsScore: row.ats_score ?? 0,
    isDefault: toBool(row.is_default),
    uploadedAt: row.uploaded_at,
    contact: parseJson(row.contact_info, {}),
    wordCount: row.word_count ?? null,
    // raw_text is deliberately omitted – it can be hundreds of KB and
    // the list endpoint does not need it.
  };
}

/** jobs row -> API payload */
function mapJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    company: row.company,
    location: row.location,
    salary: row.salary || '',
    jobType: row.job_type,
    experienceLevel: row.experience_level,
    description: row.description || '',
    requirements: parseJson(row.requirements, []),
    source: row.source,
    sourceUrl: row.source_url,
    postedDate: row.posted_date,
    matchScore: Number(row.match_score ?? 0),
    matchedSkills: parseJson(row.matched_skills, []),
    missingSkills: parseJson(row.missing_skills, []),
    isBookmarked: toBool(row.is_bookmarked),
    isApplied: toBool(row.is_applied),
    scrapedAt: row.scraped_at,
  };
}

/** applications row (+ joined job/resume) -> API payload */
function mapApplication(row) {
  if (!row) return null;
  return {
    id: row.id,
    jobId: row.job_id,
    resumeId: row.resume_id,
    coverLetter: row.cover_letter || '',
    status: row.status,
    appliedMethod: row.applied_method,
    appliedAt: row.applied_at,
    followUpDate: row.follow_up_date,
    interviewDate: row.interview_date,
    salaryOffered: row.salary_offered || '',
    notes: row.notes || '',
    lastUpdated: row.last_updated,
    job: row.title
      ? {
          id: row.job_id,
          title: row.title,
          company: row.company,
          location: row.location,
          source: row.source,
          sourceUrl: row.source_url,
          matchScore: Number(row.match_score ?? 0),
          salary: row.salary || '',
          jobType: row.job_type,
        }
      : null,
    resume: row.resume_label ? { id: row.resume_id, label: row.resume_label } : null,
  };
}

/** preferences row -> API payload */
function mapPreferences(row) {
  if (!row) return null;
  return {
    id: row.id,
    fullName: row.full_name || '',
    email: row.email || '',
    phone: row.phone || '',
    linkedinUrl: row.linkedin_url || '',
    portfolioUrl: row.portfolio_url || '',
    location: row.location || '',
    targetRoles: parseJson(row.target_roles, []),
    targetLocations: parseJson(row.target_locations, []),
    minSalary: row.min_salary ?? 0,
    maxSalary: row.max_salary ?? 999999,
    workType: row.work_type || 'any',
    experienceLevel: row.experience_level || 'any',
    autoApplyEnabled: toBool(row.auto_apply_enabled),
    dailyApplyLimit: row.daily_apply_limit ?? 15,
    minMatchScore: row.min_match_score ?? 70,
    autoApplySchedule: row.auto_apply_schedule || '0 9 * * *',
    autoScrapeEnabled: toBool(row.auto_scrape_enabled),
    scrapeSchedule: row.scrape_schedule || '0 8 * * *',
    defaultResumeId: row.default_resume_id ?? null,
    generateCoverLetter: toBool(row.generate_cover_letter),
    coverLetterTone: row.cover_letter_tone || 'professional',
    notifyNewJobs: toBool(row.notify_new_jobs),
    notifyReminders: toBool(row.notify_reminders),
    notifyCaptcha: true, // always on – a CAPTCHA needs a human
    autoApplySources: parseJson(row.auto_apply_sources, ['indeed', 'linkedin']),
    scrapeSources: parseJson(row.scrape_sources, ['remoteok', 'remotive', 'linkedin']),
    delayBetweenApplications: row.delay_between_applications || '60s',
    openaiApiKeySet: Boolean(row.openai_api_key) && row.openai_api_key !== 'your_openai_api_key_here',
  };
}

/** scrape_logs row -> API payload */
function mapScrapeLog(row) {
  if (!row) return null;
  return {
    id: row.id,
    source: row.source,
    jobsFound: row.jobs_found ?? 0,
    jobsAdded: row.jobs_added ?? 0,
    status: row.status,
    errorMessage: row.error_message,
    scrapedAt: row.scraped_at,
  };
}

/** status_history row -> API payload */
function mapHistory(row) {
  if (!row) return null;
  return {
    id: row.id,
    applicationId: row.application_id,
    oldStatus: row.old_status,
    newStatus: row.new_status,
    changedAt: row.changed_at,
    note: row.note || '',
  };
}

/** "2026-09-06 12:00:00" -> "3 days ago" style label. */
function timeAgo(value) {
  if (!value) return 'never';
  const then = new Date(String(value).replace(' ', 'T') + (String(value).includes('Z') ? '' : 'Z'));
  if (Number.isNaN(then.getTime())) return String(value);
  const seconds = Math.round((Date.now() - then.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const units = [
    ['minute', 60],
    ['hour', 3600],
    ['day', 86400],
    ['week', 604800],
    ['month', 2592000],
    ['year', 31536000],
  ];
  for (let i = units.length - 1; i >= 0; i -= 1) {
    const [label, size] = units[i];
    if (seconds >= size) {
      const n = Math.floor(seconds / size);
      return `${n} ${label}${n > 1 ? 's' : ''} ago`;
    }
  }
  return 'just now';
}

module.exports = {
  parseJson,
  toJson,
  toBool,
  toStr,
  toInt,
  toNum,
  mapResume,
  mapJob,
  mapApplication,
  mapPreferences,
  mapScrapeLog,
  mapHistory,
  timeAgo,
};
