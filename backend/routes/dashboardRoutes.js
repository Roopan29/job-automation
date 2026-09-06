/**
 * backend/routes/dashboardRoutes.js
 * ------------------------------------------------------------------
 * Mounts the /api/dashboard aggregate endpoint.
 */

const express = require('express');
const controller = require('../controllers/dashboardController');

const router = express.Router();

// GET /api/dashboard
router.get('/', controller.getDashboard);

module.exports = router;
