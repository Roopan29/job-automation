/**
 * backend/routes/applyRoutes.js
 * ------------------------------------------------------------------
 * Mounts every /api/apply endpoint.
 *
 * /run-auto-batch, /stop, /status and /log are registered before
 * /:jobId so "run-auto-batch" is never parsed as a job id.
 */

const express = require('express');
const controller = require('../controllers/applyController');

const router = express.Router();

// --- batch + monitoring (no :jobId) -----------------------------------
router.post('/run-auto-batch', controller.runAutoBatch);
router.post('/stop', controller.stopAutoBatch);
router.get('/status', controller.getApplyStatus);
router.get('/log', controller.getApplyLog);

// --- per job ----------------------------------------------------------
router.post('/:jobId/auto', controller.applyAutomatically);
router.post('/:jobId/cover-letter', controller.generateCoverLetter);
router.post('/:jobId/interview-prep', controller.getInterviewPrep);
router.post('/:jobId/follow-up-email', controller.getFollowUpEmail);

// Manual tracking must come last – it is the catch-all POST /:jobId
router.post('/:jobId', controller.applyManually);

module.exports = router;
