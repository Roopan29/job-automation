/**
 * backend/routes/resumeRoutes.js
 * ------------------------------------------------------------------
 * Mounts every /api/resume endpoint.
 * Mounted from app.js as:  app.use('/api/resume', resumeRoutes)
 */

const express = require('express');
const controller = require('../controllers/resumeController');
const { resumeUpload } = require('../middleware/uploadMiddleware');

const router = express.Router();

// POST /api/resume/upload  — multipart, field name "resume"
router.post('/upload', resumeUpload, controller.uploadResume);

// GET /api/resume/all
router.get('/all', controller.getAllResumes);

// GET /api/resume/:id
router.get('/:id', controller.getResumeById);

// PUT /api/resume/:id/label
router.put('/:id/label', controller.updateLabel);

// PUT /api/resume/:id/set-default
router.put('/:id/set-default', controller.setDefault);

// GET /api/resume/:id/ats-score
router.get('/:id/ats-score', controller.getAtsScore);

// GET /api/resume/:id/suggestions
router.get('/:id/suggestions', controller.getSuggestions);

// DELETE /api/resume/:id
router.delete('/:id', controller.deleteResume);

module.exports = router;
