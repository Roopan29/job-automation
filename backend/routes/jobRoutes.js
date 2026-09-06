/**
 * backend/routes/jobRoutes.js
 * ------------------------------------------------------------------
 * Mounts every /api/jobs endpoint.
 *
 * Route order matters: the literal paths (/recommended, /clear-old,
 * /scrape/logs) are registered before /:id so they are not swallowed by
 * the id parameter.
 */

const express = require('express');
const controller = require('../controllers/jobController');

const router = express.Router();

// POST /api/jobs/scrape
router.post('/scrape', controller.scrapeJobs);

// GET /api/jobs/scrape/logs
router.get('/scrape/logs', controller.getScrapeLogs);

// GET /api/jobs/recommended
router.get('/recommended', controller.recommendedJobs);

// DELETE /api/jobs/clear-old
router.delete('/clear-old', controller.clearOldJobs);

// GET /api/jobs  (filters + pagination)
router.get('/', controller.listJobs);

// GET /api/jobs/:id
router.get('/:id', controller.getJobById);

// GET /api/jobs/:id/match-details
router.get('/:id/match-details', controller.getMatchDetails);

// POST /api/jobs/:id/bookmark
router.post('/:id/bookmark', controller.toggleBookmark);

module.exports = router;
