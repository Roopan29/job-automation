/**
 * backend/routes/preferenceRoutes.js
 * ------------------------------------------------------------------
 * Mounts the /api/preferences endpoints (single row, id = 1).
 */

const express = require('express');
const controller = require('../controllers/preferenceController');

const router = express.Router();

// GET /api/preferences
router.get('/', controller.getPreferences);

// PUT /api/preferences
router.put('/', controller.updatePreferences);

// POST /api/preferences/test-ai  — "Test API Connection" button
router.post('/test-ai', controller.testAiConnection);

module.exports = router;
