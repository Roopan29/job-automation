/**
 * utils/apiResponse.js
 * ------------------------------------------------------------------
 * Helpers that guarantee every endpoint answers with the same envelope:
 *
 *   Success: { success: true,  data: {...}, message: "..." }
 *   Error:   { success: false, error: "...", code: 400 }
 *
 * Express controllers call these instead of hand-rolling res.json(...)
 * so the frontend only ever has to deal with one shape.
 */

/**
 * Send a successful JSON response.
 * @param {import('express').Response} res
 * @param {*} [data]   Payload for the `data` field (null is allowed).
 * @param {string} [message]
 * @param {number} [status] HTTP status, defaults to 200.
 */
function ok(res, data = null, message = 'Success', status = 200) {
  return res.status(status).json({ success: true, data, message });
}

/**
 * Send a created (201) response.
 */
function created(res, data = null, message = 'Created') {
  return ok(res, data, message, 201);
}

/**
 * Send an error JSON response.
 * @param {import('express').Response} res
 * @param {string} error  Human readable message.
 * @param {number} [code] HTTP status code, defaults to 400.
 * @param {*} [extra]     Optional extra fields merged into the body.
 */
function fail(res, error = 'Something went wrong', code = 400, extra = {}) {
  return res.status(code).json({ success: false, error, code, ...extra });
}

/**
 * Wrap an async route handler so a rejected promise becomes a 500
 * response instead of an unhandled rejection.
 * @param {(req:any,res:any,next:any)=>Promise<any>} handler
 */
function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

module.exports = { ok, created, fail, asyncHandler };
