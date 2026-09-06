/**
 * backend/middleware/uploadMiddleware.js
 * ------------------------------------------------------------------
 * Multer configuration for resume uploads.
 *
 *   • field name : "resume"
 *   • accepted   : .pdf and .docx (anything else is rejected before the
 *                  body is buffered)
 *   • max size   : 5 MB (configurable with MAX_UPLOAD_MB)
 *   • destination: backend/uploads/resumes with a unique, sanitised name
 *
 * Exports a ready-to-use middleware plus a wrapper that turns Multer's
 * own errors into the standard { success:false, error, code } envelope.
 */

const path = require('path');
const multer = require('multer');
const fileHelper = require('../utils/fileHelper');
const log = require('../utils/logger');

const logger = log.scope('Upload');

/** Hard size limit for a resume. */
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 5);
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

/** Extensions we accept (checked against both name and MIME type). */
const ALLOWED_EXTENSIONS = ['.pdf', '.docx'];
const ALLOWED_MIME = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  // Browsers occasionally send this for docx
  'application/octet-stream',
];

/** Disk storage: unique file names, resumes folder, created on demand. */
const storage = multer.diskStorage({
  destination(req, file, cb) {
    try {
      const dir = fileHelper.ensureDir(fileHelper.UPLOAD_DIR);
      cb(null, dir);
    } catch (err) {
      cb(err);
    }
  },
  filename(req, file, cb) {
    // Decode browser-encoded names ("R%C3%A9sum%C3%A9.pdf")
    const original = Buffer.from(file.originalname, 'latin1').toString('utf8');
    file.originalname = original;
    cb(null, fileHelper.uniqueFileName(original));
  },
});

/** Reject anything that is not a PDF or DOCX. */
function fileFilter(req, file, cb) {
  const original = Buffer.from(file.originalname, 'latin1').toString('utf8');
  const ext = path.extname(original).toLowerCase();

  const extensionOk = ALLOWED_EXTENSIONS.includes(ext);
  const mimeOk = ALLOWED_MIME.includes(file.mimetype);

  if (!extensionOk) {
    logger.warn(`Rejected "${original}" – unsupported extension ${ext || '(none)'}`);
    const err = new Error(`Unsupported file type "${ext || 'unknown'}". Please upload a PDF or DOCX resume.`);
    err.code = 'UNSUPPORTED_FILE_TYPE';
    err.status = 415;
    return cb(err);
  }

  if (!mimeOk) {
    // Extension is right but the MIME type is unexpected – allow it with
    // a warning, because browsers are inconsistent here and the parser
    // will fail loudly anyway if the content really is wrong.
    logger.warn(`"${original}" has an unexpected MIME type: ${file.mimetype} (extension ${ext} accepted anyway)`);
  }

  return cb(null, true);
}

/** The configured Multer instance. */
const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 1,
    fields: 5,
  },
});

/** Single-file upload middleware bound to the "resume" field. */
const uploadResume = upload.single('resume');

/**
 * Wrap an upload middleware so Multer errors come back as JSON in the
 * standard envelope instead of an HTML error page.
 * @param {Function} middleware e.g. uploadResume
 */
function handleUpload(middleware) {
  return (req, res, next) => {
    middleware(req, res, (err) => {
      if (!err) return next();

      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          logger.warn(`Rejected upload – larger than ${MAX_UPLOAD_MB} MB`);
          return res.status(413).json({
            success: false,
            error: `That file is too large. The maximum resume size is ${MAX_UPLOAD_MB} MB.`,
            code: 413,
          });
        }
        if (err.code === 'LIMIT_UNEXPECTED_FILE') {
          return res.status(400).json({
            success: false,
            error: 'Unexpected field. The resume must be sent in a form field named "resume".',
            code: 400,
          });
        }
        logger.warn(`Multer error: ${err.message}`);
        return res.status(400).json({ success: false, error: err.message, code: 400 });
      }

      const status = err.status || 400;
      logger.warn(`Upload rejected: ${err.message}`);
      return res.status(status).json({ success: false, error: err.message, code: status });
    });
  };
}

module.exports = {
  upload,
  uploadResume,
  resumeUpload: handleUpload(uploadResume),
  handleUpload,
  MAX_UPLOAD_MB,
  MAX_UPLOAD_BYTES,
  ALLOWED_EXTENSIONS,
};
