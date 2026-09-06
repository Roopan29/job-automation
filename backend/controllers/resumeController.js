/**
 * backend/controllers/resumeController.js
 * ------------------------------------------------------------------
 * Everything that touches the `resumes` table:
 *
 *   POST   /api/resume/upload          upload + parse + score
 *   GET    /api/resume/all             list every resume
 *   GET    /api/resume/:id             one resume (with raw text)
 *   PUT    /api/resume/:id/label       rename
 *   PUT    /api/resume/:id/set-default promote to default
 *   GET    /api/resume/:id/ats-score   re-score with full breakdown
 *   GET    /api/resume/:id/suggestions AI improvement suggestions
 *   DELETE /api/resume/:id             delete row + file on disk
 */

const path = require('path');
const log = require('../utils/logger');
const { ok, created, fail, asyncHandler } = require('../utils/apiResponse');
const fileHelper = require('../utils/fileHelper');
const { mapResume, parseJson, toJson, toStr, toInt } = require('../utils/serialize');
const { getDb } = require('../db/initDB');
const resumeParser = require('../services/resumeParser');
const atsScorer = require('../services/atsScorer');
const aiService = require('../services/aiService');

const logger = log.scope('Resume');

/* ------------------------------------------------------------------ *
 * Shared helpers (used by other controllers too)
 * ------------------------------------------------------------------ */

/** Fetch one resume row by id (raw DB row). */
function getResumeRow(id) {
  return getDb().prepare('SELECT * FROM resumes WHERE id = ?').get(id) || null;
}

/**
 * The resume the matcher/cover letters should use.
 * Prefers the explicit default, then the most recently uploaded one.
 * @returns {object|null} parsed resume (skills/experience/… as real arrays)
 */
function getDefaultResume() {
  const db = getDb();
  const row =
    db.prepare('SELECT * FROM resumes WHERE is_default = 1 ORDER BY id DESC LIMIT 1').get() ||
    db.prepare('SELECT * FROM resumes ORDER BY uploaded_at DESC, id DESC LIMIT 1').get();

  return row ? toParsedResume(row) : null;
}

/** Turn a raw row into the shape the services expect. */
function toParsedResume(row) {
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    rawText: row.raw_text || '',
    skills: parseJson(row.skills, []),
    experience: parseJson(row.experience, []),
    education: parseJson(row.education, []),
    summary: row.summary || '',
    contact: parseJson(row.contact_info, {}),
    wordCount: row.word_count || (row.raw_text || '').split(/\s+/).filter(Boolean).length,
    atsScore: row.ats_score || 0,
    fileType: row.file_type,
    filePath: row.file_path,
  };
}

/** Recompute the ATS score for a row and persist it. */
function rescoreResume(row) {
  const parsed = toParsedResume(row);
  const report = atsScorer.scoreResume(parsed.rawText, parsed);
  getDb()
    .prepare('UPDATE resumes SET ats_score = ?, word_count = ? WHERE id = ?')
    .run(report.totalScore, parsed.wordCount, row.id);
  return report;
}

/* ------------------------------------------------------------------ *
 * POST /api/resume/upload
 * ------------------------------------------------------------------ */

const uploadResume = asyncHandler(async (req, res) => {
  if (!req.file) {
    return fail(res, 'No file received. Send the resume in a multipart field named "resume".', 400);
  }

  const { filename, originalname, path: savedPath } = req.file;
  const fileType = path.extname(originalname).toLowerCase().replace('.', '');

  try {
    logger.info(`Uploading ${originalname} (${fileHelper.humanSize(req.file.size)})`);

    // --- parse --------------------------------------------------------
    const parsed = await resumeParser.parseResume(savedPath, fileType);

    if (!parsed.rawText) {
      fileHelper.safeDelete(savedPath);
      return fail(
        res,
        parsed.parseError
          ? `Could not read that file: ${parsed.parseError}`
          : 'No text could be extracted from that file. Scanned/image PDFs are not supported – export a text PDF.',
        422
      );
    }

    // --- score --------------------------------------------------------
    const report = atsScorer.scoreResume(parsed.rawText, parsed);

    // --- store --------------------------------------------------------
    const db = getDb();
    const isFirst = db.prepare('SELECT COUNT(*) AS n FROM resumes').get().n === 0;

    const info = db
      .prepare(
        `INSERT INTO resumes
           (file_name, original_name, file_path, file_type, label, raw_text,
            skills, experience, education, summary, contact_info, word_count,
            ats_score, is_default)
         VALUES (@file_name, @original_name, @file_path, @file_type, @label, @raw_text,
                 @skills, @experience, @education, @summary, @contact_info, @word_count,
                 @ats_score, @is_default)`
      )
      .run({
        file_name: filename,
        original_name: originalname,
        file_path: savedPath,
        file_type: fileType,
        label: toStr(req.body?.label) || originalname.replace(/\.(pdf|docx)$/i, '') || 'My Resume',
        raw_text: parsed.rawText,
        skills: toJson(parsed.skills),
        experience: toJson(parsed.experience),
        education: toJson(parsed.education),
        summary: parsed.summary,
        contact_info: toJson(parsed.contact, {}),
        word_count: parsed.wordCount,
        ats_score: report.totalScore,
        is_default: isFirst ? 1 : 0,
      });

    const id = Number(info.lastInsertRowid);

    // First resume becomes the default and is wired into preferences.
    if (isFirst) {
      db.prepare('UPDATE preferences SET default_resume_id = ? WHERE id = 1').run(id);
      logger.info(`Resume #${id} is the first one – marked as default`);
    }

    logger.success(
      `Stored resume #${id} — ${parsed.skills.length} skills, ATS ${report.totalScore}/100 (${report.grade})`
    );

    const row = getResumeRow(id);

    return created(
      res,
      {
        resume: mapResume(row),
        ats: { score: report.totalScore, grade: report.grade, breakdown: report.breakdown, tips: report.tips },
      },
      `Resume uploaded and parsed – ATS score ${report.totalScore}/100`
    );
  } catch (err) {
    logger.error(`Upload failed: ${err.message}`);
    fileHelper.safeDelete(savedPath);
    return fail(res, `Upload failed: ${err.message}`, 500);
  }
});

/* ------------------------------------------------------------------ *
 * GET /api/resume/all
 * ------------------------------------------------------------------ */

const getAllResumes = asyncHandler(async (req, res) => {
  const rows = getDb()
    .prepare('SELECT * FROM resumes ORDER BY is_default DESC, uploaded_at DESC, id DESC')
    .all();

  return ok(
    res,
    { resumes: rows.map(mapResume), total: rows.length },
    `${rows.length} resume(s) found`
  );
});

/* ------------------------------------------------------------------ *
 * GET /api/resume/:id
 * ------------------------------------------------------------------ */

const getResumeById = asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  if (!id) return fail(res, 'A numeric resume id is required', 400);

  const row = getResumeRow(id);
  if (!row) return fail(res, `Resume ${id} not found`, 404);

  return ok(res, {
    resume: { ...mapResume(row), rawText: row.raw_text || '' },
  });
});

/* ------------------------------------------------------------------ *
 * PUT /api/resume/:id/label
 * ------------------------------------------------------------------ */

const updateLabel = asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  const label = toStr(req.body?.label);

  if (!id) return fail(res, 'A numeric resume id is required', 400);
  if (!label) return fail(res, 'A non-empty "label" is required', 400);
  if (label.length > 80) return fail(res, 'Label must be 80 characters or fewer', 400);

  const row = getResumeRow(id);
  if (!row) return fail(res, `Resume ${id} not found`, 404);

  getDb().prepare('UPDATE resumes SET label = ? WHERE id = ?').run(label, id);
  logger.info(`Renamed resume #${id} to "${label}"`);

  return ok(res, { resume: mapResume(getResumeRow(id)) }, 'Label updated');
});

/* ------------------------------------------------------------------ *
 * PUT /api/resume/:id/set-default
 * ------------------------------------------------------------------ */

const setDefault = asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  if (!id) return fail(res, 'A numeric resume id is required', 400);

  const db = getDb();
  const row = getResumeRow(id);
  if (!row) return fail(res, `Resume ${id} not found`, 404);

  const apply = db.transaction(() => {
    db.prepare('UPDATE resumes SET is_default = 0').run();
    db.prepare('UPDATE resumes SET is_default = 1 WHERE id = ?').run(id);
    db.prepare('UPDATE preferences SET default_resume_id = ? WHERE id = 1').run(id);
  });
  apply();

  logger.info(`Resume #${id} ("${row.label}") is now the default`);

  return ok(
    res,
    { resume: mapResume(getResumeRow(id)), defaultResumeId: id },
    `"${row.label}" is now your default resume`
  );
});

/* ------------------------------------------------------------------ *
 * GET /api/resume/:id/ats-score
 * ------------------------------------------------------------------ */

const getAtsScore = asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  if (!id) return fail(res, 'A numeric resume id is required', 400);

  const row = getResumeRow(id);
  if (!row) return fail(res, `Resume ${id} not found`, 404);

  // Always recompute so the score reflects the latest parsing rules.
  const report = rescoreResume(row);

  return ok(
    res,
    {
      resumeId: id,
      score: report.totalScore,
      grade: report.grade,
      breakdown: report.breakdown,
      tips: report.tips,
      wordCount: toParsedResume(row).wordCount,
    },
    `ATS score recalculated: ${report.totalScore}/100 (${report.grade})`
  );
});

/* ------------------------------------------------------------------ *
 * GET /api/resume/:id/suggestions
 * ------------------------------------------------------------------ */

const getSuggestions = asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  if (!id) return fail(res, 'A numeric resume id is required', 400);

  const row = getResumeRow(id);
  if (!row) return fail(res, `Resume ${id} not found`, 404);

  const parsed = toParsedResume(row);
  const db = getDb();
  const targetRole = parseJson(
    db.prepare('SELECT target_roles FROM preferences WHERE id = 1').get()?.target_roles,
    []
  )[0];

  if (!aiService.isConfigured()) {
    // No API key: give deterministic, still-useful advice from the ATS
    // report instead of returning an error the UI cannot act on.
    const report = atsScorer.scoreResume(parsed.rawText, parsed);
    return ok(
      res,
      {
        resumeId: id,
        suggestions: report.tips,
        source: 'local',
        message:
          'These come from the built-in ATS analyser. Add OPENAI_API_KEY to backend/.env for AI-written, role-specific advice.',
      },
      'Local ATS suggestions generated'
    );
  }

  try {
    const suggestions = await aiService.getResumeImprovements(parsed.rawText, targetRole);
    return ok(
      res,
      { resumeId: id, suggestions, source: 'ai', message: `Generated with OpenAI ${aiService.MODEL}` },
      'AI suggestions generated'
    );
  } catch (err) {
    logger.warn(`AI suggestions failed (${err.message}) – falling back to the ATS analyser`);
    const report = atsScorer.scoreResume(parsed.rawText, parsed);
    return ok(
      res,
      {
        resumeId: id,
        suggestions: report.tips,
        source: 'local',
        message: `AI call failed (${err.message}); used the built-in ATS analyser instead.`,
      },
      'Local ATS suggestions generated'
    );
  }
});

/* ------------------------------------------------------------------ *
 * DELETE /api/resume/:id
 * ------------------------------------------------------------------ */

const deleteResume = asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  if (!id) return fail(res, 'A numeric resume id is required', 400);

  const db = getDb();
  const row = getResumeRow(id);
  if (!row) return fail(res, `Resume ${id} not found`, 404);

  const wasDefault = Boolean(row.is_default);

  const apply = db.transaction(() => {
    db.prepare('DELETE FROM resumes WHERE id = ?').run(id);
    db.prepare('UPDATE preferences SET default_resume_id = NULL WHERE id = 1 AND default_resume_id = ?').run(id);
  });
  apply();

  fileHelper.safeDelete(row.file_path);

  // Promote another resume when we just deleted the default one.
  let newDefault = null;
  if (wasDefault) {
    const next = db.prepare('SELECT * FROM resumes ORDER BY uploaded_at DESC, id DESC LIMIT 1').get();
    if (next) {
      db.prepare('UPDATE resumes SET is_default = 1 WHERE id = ?').run(next.id);
      db.prepare('UPDATE preferences SET default_resume_id = ? WHERE id = 1').run(next.id);
      newDefault = mapResume(next);
    }
  }

  logger.info(`Deleted resume #${id} ("${row.label}")${newDefault ? ` – new default is #${newDefault.id}` : ''}`);

  return ok(res, { deletedId: id, newDefault }, `Resume "${row.label}" deleted`);
});

module.exports = {
  uploadResume,
  getAllResumes,
  getResumeById,
  updateLabel,
  setDefault,
  getAtsScore,
  getSuggestions,
  deleteResume,
  // internal helpers reused by job / apply / dashboard code
  getResumeRow,
  getDefaultResume,
  toParsedResume,
  rescoreResume,
};
