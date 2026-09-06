/**
 * backend/routes/trackerRoutes.js
 * ------------------------------------------------------------------
 * Mounts every /api/tracker endpoint.
 * /stats and /export/csv are registered before /:id.
 */

const express = require('express');
const controller = require('../controllers/trackerController');

const router = express.Router();

// GET /api/tracker/stats
router.get('/stats', controller.getStats);

// GET /api/tracker/export/csv  (streams a file download)
router.get('/export/csv', controller.exportCsv);

// GET /api/tracker  (filters)
router.get('/', controller.listApplications);

// GET /api/tracker/:id
router.get('/:id', controller.getApplication);

// PATCH /api/tracker/:id/status
router.patch('/:id/status', controller.updateStatus);

// PATCH /api/tracker/:id/notes
router.patch('/:id/notes', controller.updateNotes);

// PATCH /api/tracker/:id/follow-up
router.patch('/:id/follow-up', controller.updateFollowUp);

// DELETE /api/tracker/:id
router.delete('/:id', controller.deleteApplication);

module.exports = router;
