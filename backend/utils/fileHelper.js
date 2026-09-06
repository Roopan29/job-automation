/**
 * utils/fileHelper.js
 * ------------------------------------------------------------------
 * Small filesystem helpers: safe path building, existence checks,
 * human readable sizes, safe deletion and directory bootstrapping.
 *
 * Everything here is synchronous on purpose – these are tiny local
 * disk operations performed once per request, and synchronous code is
 * far easier to reason about in controllers.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const log = require('./logger');

/** Absolute path of the backend folder (…/backend). */
const BACKEND_ROOT = path.resolve(__dirname, '..');

/** Folder where uploaded resumes live. */
const UPLOAD_DIR = path.join(BACKEND_ROOT, 'uploads', 'resumes');

/** Folder that holds the SQLite database file. */
const DB_DIR = path.join(BACKEND_ROOT, 'db');

/** Create a directory (and its parents) if it is missing. */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    log.info(`Created directory ${dir}`);
  }
  return dir;
}

/** Make sure the runtime folders exist. Called on server start. */
function ensureRuntimeDirs() {
  ensureDir(UPLOAD_DIR);
  ensureDir(DB_DIR);
  return { UPLOAD_DIR, DB_DIR };
}

/** Does the path exist on disk? */
function exists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

/** File size in bytes, or 0 when the file is missing. */
function size(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

/** Format a byte count as "1.2 MB" etc. */
function humanSize(bytes) {
  if (!bytes) return '0 KB';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Build a collision-free file name for an uploaded resume.
 * "John Doe.pdf" -> "1712345678901-3f2a-john-doe.pdf"
 *
 * @param {string} originalName
 * @returns {string}
 */
function uniqueFileName(originalName) {
  const ext = path.extname(originalName || '').toLowerCase() || '.pdf';
  const base = path
    .basename(originalName || 'resume', ext)
    .replace(/[^a-zA-Z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 40);
  const stamp = Date.now();
  const rand = crypto.randomBytes(2).toString('hex');
  return `${stamp}-${rand}-${base || 'resume'}${ext}`;
}

/** Resolve a stored file name / relative path to an absolute path. */
function resolveUpload(nameOrPath) {
  if (!nameOrPath) return null;
  if (path.isAbsolute(nameOrPath)) return nameOrPath;
  return path.join(UPLOAD_DIR, path.basename(nameOrPath));
}

/**
 * Delete a file, never throwing when it is already gone.
 * @returns {boolean} true when a file was actually removed.
 */
function safeDelete(filePath) {
  if (!filePath) return false;
  const abs = resolveUpload(filePath);
  try {
    if (fs.existsSync(abs)) {
      fs.unlinkSync(abs);
      log.info(`Deleted file ${path.basename(abs)}`);
      return true;
    }
  } catch (err) {
    log.warn(`Could not delete ${abs}: ${err.message}`);
  }
  return false;
}

/** Read a file as a Buffer (or null). */
function readBuffer(filePath) {
  try {
    return fs.readFileSync(resolveUpload(filePath));
  } catch (err) {
    log.error(`Failed to read ${filePath}: ${err.message}`);
    return null;
  }
}

/** Read a file as UTF-8 text (or null). */
function readText(filePath) {
  const buf = readBuffer(filePath);
  return buf ? buf.toString('utf8') : null;
}

/** List every resume file currently on disk. */
function listUploads() {
  ensureDir(UPLOAD_DIR);
  try {
    return fs.readdirSync(UPLOAD_DIR).filter((f) => /\.(pdf|docx)$/i.test(f));
  } catch {
    return [];
  }
}

module.exports = {
  BACKEND_ROOT,
  UPLOAD_DIR,
  DB_DIR,
  ensureDir,
  ensureRuntimeDirs,
  exists,
  size,
  humanSize,
  uniqueFileName,
  resolveUpload,
  safeDelete,
  readBuffer,
  readText,
  listUploads,
};
