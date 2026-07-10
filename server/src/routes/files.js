const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const mime = require('mime-types');
const archiver = require('archiver');
const { ApiError } = require('../middleware/errorHandler');
const { requireAuth } = require('../middleware/auth');

const ROOT_DIR = process.env.FILE_DIR || path.join(require('os').homedir(), 'PhoneRemote');
if (!fs.existsSync(ROOT_DIR)) fs.mkdirSync(ROOT_DIR, { recursive: true });

// Every account gets its own isolated directory: ROOT_DIR/<userId>/
function userDir(userId) {
  const dir = path.join(ROOT_DIR, userId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safe(userId, rel) {
  const base = userDir(userId);
  const resolved = path.resolve(base, rel);
  // startsWith alone is vulnerable to prefix collision (e.g. base/../baseEvil)
  if (resolved !== base && !resolved.startsWith(base + path.sep))
    throw new ApiError(400, 'Invalid path');
  return resolved;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      const dest = safe(req.userId, req.query.path || '');
      fs.mkdirSync(dest, { recursive: true });
      cb(null, dest);
    } catch (e) { cb(e); }
  },
  filename: (req, file, cb) => cb(null, file.originalname),
});
const upload = multer({ storage, limits: { fileSize: 4 * 1024 * 1024 * 1024 } });

function statOrThrow(fp) {
  try { return fs.statSync(fp); }
  catch { throw new ApiError(404, 'Not found'); }
}

function startZip(res, filename) {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  const arc = archiver('zip', { zlib: { level: 6 } });
  arc.pipe(res);
  return arc;
}

function setupFileRoutes(app) {
  const r = express.Router();
  r.use(requireAuth); // every file route is scoped to the authenticated user

  r.get('/files', (req, res, next) => {
    try {
      const dir = safe(req.userId, req.query.path || '');
      let dirents;
      try { dirents = fs.readdirSync(dir, { withFileTypes: true }); }
      catch { throw new ApiError(404, 'Not found'); }
      const entries = dirents.map((e) => {
        const st = fs.statSync(path.join(dir, e.name));
        return {
          name: e.name,
          type: e.isDirectory() ? 'dir' : 'file',
          size: e.isFile() ? st.size : null,
          modified: st.mtime,
          mime: e.isFile() ? (mime.lookup(e.name) || 'application/octet-stream') : null,
          path: path.join(req.query.path || '', e.name).replace(/\\/g, '/'),
        };
      });
      entries.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);
      res.json({ path: req.query.path || '', entries });
    } catch (err) { next(err); }
  });

  r.get('/files/download', (req, res, next) => {
    try {
      const fp = safe(req.userId, req.query.path || '');
      const st = statOrThrow(fp);
      if (st.isDirectory()) {
        const arc = startZip(res, path.basename(fp) + '.zip');
        arc.directory(fp, path.basename(fp));
        arc.finalize();
      } else {
        res.download(fp);
      }
    } catch (err) { next(err); }
  });

  // bulk download: ?paths=a&paths=b  →  zip
  r.get('/files/download-zip', (req, res, next) => {
    try {
      const paths = [].concat(req.query.paths || []);
      if (!paths.length) throw new ApiError(400, 'No paths');
      const arc = startZip(res, 'download.zip');
      for (const p of paths) {
        const fp = safe(req.userId, p);
        let st;
        try { st = fs.statSync(fp); } catch { continue; }
        if (st.isDirectory()) arc.directory(fp, path.basename(fp));
        else arc.file(fp, { name: path.basename(fp) });
      }
      arc.finalize();
    } catch (err) { next(err); }
  });

  r.post('/files/upload', upload.array('files'), (req, res) => {
    res.json({ success: true, files: req.files.map(f => f.originalname) });
  });

  r.delete('/files', (req, res, next) => {
    try {
      const fp = safe(req.userId, req.query.path || '');
      statOrThrow(fp);
      fs.rmSync(fp, { recursive: true, force: true });
      res.json({ success: true });
    } catch (err) { next(err); }
  });

  r.post('/files/mkdir', (req, res, next) => {
    try {
      fs.mkdirSync(safe(req.userId, req.body.path || ''), { recursive: true });
      res.json({ success: true });
    } catch (err) { next(err); }
  });

  app.use('/api', r);
  console.log(`📁 File storage root: ${ROOT_DIR} (per-account subdirectories)`);
}

module.exports = { setupFileRoutes };
