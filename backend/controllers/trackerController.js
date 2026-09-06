/**
 * backend/controllers/trackerController.js
 * ------------------------------------------------------------------
 *   GET    /api/tracker              filtered list (+ joined job data)
 *   GET    /api/tracker/stats        counts, rates, by-source, by-month
 *   GET    /api/tracker/export/csv   CSV download
 *   GET    /api/tracker/:id          one application + status history
 *   PATCH  /api/tracker/:id/status   change status (+ history entry)
 *   PATCH  /api/tracker/:id/notes    edit notes
 *   PATCH  /api/tracker/:id/follow-up set follow-up / interview dates
 *   DELETE /api/tracker/:id          delete (+ un-mark the job)
 */

const log = require('../utils/logger');
const { stringify } = require('csv-stringify/sync');
const { ok, fail, asyncHandler } = require('../utils/apiResponse');
const { mapApplication, mapHistory, toStr, toInt } = require('../utils/serialize');
const { getDb } = require('../db/initDB');

const logger = log.scope('Tracker');

/** The seven statuses the whole app understands, with their UI colour. */
const STATUSES = [
  { key: 'applied', label: 'Applied', color: 'blue' },
  { key: 'responded', label: 'Responded', color: 'purple' },
  { key: 'interview', label: 'Interview', color: 'yellow' },
  { key: 'offer', label: 'Offer', color: 'green' },
  { key: 'rejected', label: 'Rejected', color: 'red' },
  { key: 'ghosted', label: 'Ghosted', color: 'gray' },
  { key: 'withdrawn', label: 'Withdrawn', color: 'orange' },
];

const STATUS_KEYS = STATUSES.map((s) => s.key);

/**
 * The SELECT used by every tracker query.
 * Joins just enough of `jobs` / `resumes` for the table to render
 * without a second round trip per row.
 */
const BASE_SELECT = `
  SELECT a.*,
         j.title, j.company, j.location, j.source, j.source_url,
         j.match_score, j.salary, j.job_type, j.experience_level,
         r.label AS resume_label
    FROM applications a
    LEFT JOIN jobs j     ON j.id = a.job_id
    LEFT JOIN resumes r  ON r.id = a.resume_id
`;

/** Normalise "YYYY-MM-DD" or an ISO timestamp to YYYY-MM-DD (or null). */
function toDateOnly(value) {
  if (!value) return null;
  const d = new Date(String(value).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) {
    const m = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
  }
  return d.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ *
 * GET /api/tracker
 * ------------------------------------------------------------------ */

const listApplications = asyncHandler(async (req, res) => {
  const db = getDb();
  const where = [];
  const params = {};

  const status = toStr(req.query.status).toLowerCase();
  if (status && status !== 'all') {
    where.push('lower(a.status) = @status');
    params.status = status;
  }

  const method = toStr(req.query.method).toLowerCase();
  if (method && method !== 'all') {
    where.push('lower(a.applied_method) = @method');
    params.method = method;
  }

  const search = toStr(req.query.search);
  if (search) {
    where.push('(j.company LIKE @search OR j.title LIKE @search OR a.notes LIKE @search)');
    params.search = `%${search}%`;
  }

  const dateFrom = toDateOnly(req.query.dateFrom);
  if (dateFrom) {
    where.push('date(a.applied_at) >= date(@dateFrom)');
    params.dateFrom = dateFrom;
  }

  const dateTo = toDateOnly(req.query.dateTo);
  if (dateTo) {
    where.push('date(a.applied_at) <= date(@dateTo)');
    params.dateTo = dateTo;
  }

  const source = toStr(req.query.source);
  if (source && source !== 'all') {
    where.push('j.source = @source');
    params.source = source;
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM applications a LEFT JOIN jobs j ON j.id = a.job_id ${whereSql}`).get(params).n;

  const rows = db.prepare(`${BASE_SELECT} ${whereSql} ORDER BY a.applied_at DESC, a.id DESC`).all(params);

  return ok(
    res,
    {
      applications: rows.map(mapApplication),
      total,
      statuses: STATUSES,
    },
    `${total} application(s)`
  );
});

/* ------------------------------------------------------------------ *
 * GET /api/tracker/stats
 * ------------------------------------------------------------------ */

const getStats = asyncHandler(async (req, res) => ok(res, computeStats()));

/**
 * Pure stats computation – shared with the dashboard endpoint.
 * @returns {object} the same payload GET /api/tracker/stats returns
 */
function computeStats() {
  const db = getDb();

  const byStatus = db
    .prepare('SELECT status, COUNT(*) AS n FROM applications GROUP BY status')
    .all()
    .reduce((acc, row) => ({ ...acc, [String(row.status).toLowerCase()]: row.n }), {});

  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const responded = byStatus.responded || 0;
  const interview = byStatus.interview || 0;
  const offer = byStatus.offer || 0;
  const rejected = byStatus.rejected || 0;

  // A "response" is anything better than silence.
  const positive = responded + interview + offer;
  const decided = positive + rejected;

  const thisWeek = db
    .prepare(
      `SELECT
         SUM(CASE WHEN date(applied_at) >= date('now','-7 day') THEN 1 ELSE 0 END) AS applied,
         SUM(CASE WHEN date(last_updated) >= date('now','-7 day') AND status <> 'applied' THEN 1 ELSE 0 END) AS responses
       FROM applications`
    )
    .get();

  const bySourceRows = db
    .prepare(
      `SELECT COALESCE(j.source, 'Unknown') AS source, COUNT(*) AS n
         FROM applications a LEFT JOIN jobs j ON j.id = a.job_id
        GROUP BY COALESCE(j.source, 'Unknown')
        ORDER BY n DESC`
    )
    .all();

  const byMonthRows = db
    .prepare(
      `SELECT strftime('%Y-%m', applied_at) AS month, COUNT(*) AS n
         FROM applications
        WHERE applied_at >= date('now', '-6 month')
        GROUP BY strftime('%Y-%m', applied_at)
        ORDER BY month ASC`
    )
    .all();

  // Fill gaps so the chart always has 6 evenly spaced points.
  const byMonth = [];
  const cursor = new Date();
  cursor.setDate(1);
  for (let i = 5; i >= 0; i -= 1) {
    const d = new Date(cursor.getFullYear(), cursor.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const hit = byMonthRows.find((r) => r.month === key);
    byMonth.push({
      month: key,
      label: d.toLocaleString('en-US', { month: 'short' }),
      count: hit ? hit.n : 0,
    });
  }

  // Applications per day for the last 30 days (tracker page line chart).
  const dailyRows = db
    .prepare(
      `SELECT date(applied_at) AS day, COUNT(*) AS n
         FROM applications
        WHERE date(applied_at) >= date('now', '-30 day')
        GROUP BY date(applied_at)`
    )
    .all();
  const dailyMap = new Map(dailyRows.map((r) => [r.day, r.n]));
  const last30Days = [];
  for (let i = 29; i >= 0; i -= 1) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    last30Days.push({ date: key, label: `${d.getMonth() + 1}/${d.getDate()}`, count: dailyMap.get(key) || 0 });
  }

  const bySource = bySourceRows.reduce((acc, r) => ({ ...acc, [r.source]: r.n }), {});

  return {
    total,
    applied: byStatus.applied || 0,
    responded,
    interview,
    offer,
    rejected,
    ghosted: byStatus.ghosted || 0,
    withdrawn: byStatus.withdrawn || 0,
    responseRate: decided ? Math.round((positive / decided) * 1000) / 10 : 0,
    offerRate: decided ? Math.round((offer / decided) * 1000) / 10 : 0,
    interviewRate: decided ? Math.round((interview / decided) * 1000) / 10 : 0,
    thisWeek: { applied: thisWeek?.applied || 0, responses: thisWeek?.responses || 0 },
    bySource,
    byMonth,
    last30Days,
    statuses: STATUSES,
  };
}

/* ------------------------------------------------------------------ *
 * GET /api/tracker/:id
 * ------------------------------------------------------------------ */

const getApplication = asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  if (!id) return fail(res, 'A numeric application id is required', 400);

  const db = getDb();
  const row = db.prepare(`${BASE_SELECT} WHERE a.id = ?`).get(id);
  if (!row) return fail(res, `Application ${id} not found`, 404);

  const history = db
    .prepare('SELECT * FROM status_history WHERE application_id = ? ORDER BY changed_at DESC, id DESC')
    .all(id);

  return ok(res, { application: mapApplication(row), history: history.map(mapHistory) });
});

/* ------------------------------------------------------------------ *
 * PATCH /api/tracker/:id/status
 * ------------------------------------------------------------------ */

const updateStatus = asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  if (!id) return fail(res, 'A numeric application id is required', 400);

  const newStatus = toStr(req.body?.status).toLowerCase();
  if (!STATUS_KEYS.includes(newStatus)) {
    return fail(res, `Status must be one of: ${STATUS_KEYS.join(', ')}`, 400);
  }

  const db = getDb();
  const row = db.prepare('SELECT * FROM applications WHERE id = ?').get(id);
  if (!row) return fail(res, `Application ${id} not found`, 404);

  if (row.status === newStatus && !req.body?.note) {
    return ok(res, { application: mapApplication(db.prepare(`${BASE_SELECT} WHERE a.id = ?`).get(id)) }, 'Status unchanged');
  }

  const note = toStr(req.body?.note);

  const apply = db.transaction(() => {
    db.prepare(
      `UPDATE applications
          SET status = @status,
              last_updated = datetime('now'),
              interview_date = CASE WHEN @status = 'interview' AND interview_date IS NULL
                                    THEN date('now','+3 day') ELSE interview_date END,
              notes = CASE WHEN @note <> '' AND notes IS NULL THEN @note ELSE notes END
        WHERE id = @id`
    ).run({ id, status: newStatus, note });

    db.prepare(
      `INSERT INTO status_history (application_id, old_status, new_status, note, changed_at)
       VALUES (?, ?, ?, ?, datetime('now'))`
    ).run(id, row.status, newStatus, note || null);
  });
  apply();

  logger.info(`Application #${id}: ${row.status} → ${newStatus}`);

  const updated = db.prepare(`${BASE_SELECT} WHERE a.id = ?`).get(id);
  const history = db
    .prepare('SELECT * FROM status_history WHERE application_id = ? ORDER BY changed_at DESC, id DESC')
    .all(id);

  return ok(
    res,
    { application: mapApplication(updated), history: history.map(mapHistory) },
    `Status updated to ${newStatus}`
  );
});

/* ------------------------------------------------------------------ *
 * PATCH /api/tracker/:id/notes
 * ------------------------------------------------------------------ */

const updateNotes = asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  if (!id) return fail(res, 'A numeric application id is required', 400);

  if (req.body?.notes === undefined) return fail(res, 'A "notes" field is required', 400);

  const notes = toStr(req.body.notes);
  if (notes.length > 5000) return fail(res, 'Notes must be under 5000 characters', 400);

  const db = getDb();
  const row = db.prepare('SELECT id FROM applications WHERE id = ?').get(id);
  if (!row) return fail(res, `Application ${id} not found`, 404);

  db.prepare("UPDATE applications SET notes = ?, last_updated = datetime('now') WHERE id = ?").run(notes, id);

  return ok(res, { application: mapApplication(db.prepare(`${BASE_SELECT} WHERE a.id = ?`).get(id)) }, 'Notes saved');
});

/* ------------------------------------------------------------------ *
 * PATCH /api/tracker/:id/follow-up
 * ------------------------------------------------------------------ */

const updateFollowUp = asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  if (!id) return fail(res, 'A numeric application id is required', 400);

  const followUpDate = toDateOnly(req.body?.follow_up_date ?? req.body?.followUpDate);
  const interviewDate = toDateOnly(req.body?.interview_date ?? req.body?.interviewDate);
  const salaryOffered = req.body?.salary_offered !== undefined ? toStr(req.body.salary_offered) : null;

  if (!followUpDate && !interviewDate && salaryOffered === null) {
    return fail(res, 'Provide follow_up_date, interview_date or salary_offered', 400);
  }

  const db = getDb();
  const row = db.prepare('SELECT id FROM applications WHERE id = ?').get(id);
  if (!row) return fail(res, `Application ${id} not found`, 404);

  db.prepare(
    `UPDATE applications
        SET follow_up_date = COALESCE(@followUpDate, follow_up_date),
            interview_date = COALESCE(@interviewDate, interview_date),
            salary_offered = COALESCE(@salaryOffered, salary_offered),
            last_updated = datetime('now')
      WHERE id = @id`
  ).run({ id, followUpDate, interviewDate, salaryOffered });

  return ok(
    res,
    { application: mapApplication(db.prepare(`${BASE_SELECT} WHERE a.id = ?`).get(id)) },
    'Dates updated'
  );
});

/* ------------------------------------------------------------------ *
 * DELETE /api/tracker/:id
 * ------------------------------------------------------------------ */

const deleteApplication = asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  if (!id) return fail(res, 'A numeric application id is required', 400);

  const db = getDb();
  const row = db.prepare('SELECT * FROM applications WHERE id = ?').get(id);
  if (!row) return fail(res, `Application ${id} not found`, 404);

  const apply = db.transaction(() => {
    db.prepare('DELETE FROM status_history WHERE application_id = ?').run(id);
    db.prepare('DELETE FROM applications WHERE id = ?').run(id);

    // Only clear the job flag when no other application points at it.
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM applications WHERE job_id = ?').get(row.job_id).n;
    if (row.job_id && remaining === 0) {
      db.prepare('UPDATE jobs SET is_applied = 0 WHERE id = ?').run(row.job_id);
    }
  });
  apply();

  logger.info(`Deleted application #${id} (job #${row.job_id})`);

  return ok(res, { deletedId: id, jobId: row.job_id }, 'Application deleted');
});

/* ------------------------------------------------------------------ *
 * GET /api/tracker/export/csv
 * ------------------------------------------------------------------ */

const exportCsv = asyncHandler(async (req, res) => {
  const db = getDb();

  const rows = db
    .prepare(
      `${BASE_SELECT}
        ORDER BY a.applied_at DESC, a.id DESC`
    )
    .all();

  const records = rows.map((r) => {
    const app = mapApplication(r);
    return {
      Company: app.job?.company || 'Unknown',
      Role: app.job?.title || 'Unknown',
      Status: app.status,
      'Applied Date': app.appliedAt ? String(app.appliedAt).slice(0, 10) : '',
      'Last Updated': app.lastUpdated ? String(app.lastUpdated).slice(0, 10) : '',
      Source: app.job?.source || '',
      'Match Score': app.job?.matchScore ?? '',
      Location: app.job?.location || '',
      'Applied Via': app.appliedMethod,
      'Follow-up Date': app.followUpDate || '',
      'Interview Date': app.interviewDate || '',
      'Salary Offered': app.salaryOffered || '',
      'Job URL': app.job?.sourceUrl || '',
      Notes: app.notes || '',
    };
  });

  const csv = stringify(records, {
    header: true,
    columns: [
      'Company', 'Role', 'Status', 'Applied Date', 'Last Updated', 'Source',
      'Match Score', 'Location', 'Applied Via', 'Follow-up Date',
      'Interview Date', 'Salary Offered', 'Job URL', 'Notes',
    ],
  });

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="jobbot-applications-${stamp}.csv"`);
  res.send(csv);
});

module.exports = {
  listApplications,
  getStats,
  computeStats,
  getApplication,
  updateStatus,
  updateNotes,
  updateFollowUp,
  deleteApplication,
  exportCsv,
  STATUSES,
  STATUS_KEYS,
};
