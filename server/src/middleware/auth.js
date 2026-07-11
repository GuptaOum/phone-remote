const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me-in-production';
if (JWT_SECRET === 'dev-secret-change-me-in-production') {
  console.warn('⚠️  JWT_SECRET not set — using insecure dev default. Set it in .env for production!');
}

const TOKEN_TTL = process.env.TOKEN_TTL || '30d';

function signToken(user, expiresIn = TOKEN_TTL) {
  return jwt.sign({ uid: user.id, email: user.email }, JWT_SECRET, { expiresIn });
}

/** Returns { uid, email } or null. */
function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch { return null; }
}

/**
 * Express middleware. Accepts the JWT as:
 *   Authorization: Bearer <token>   (fetch/Dio)
 *   ?token=<token>                  (browser <a download> links can't set headers)
 */
function requireAuth(req, res, next) {
  const token =
    req.headers.authorization?.replace(/^Bearer /, '') ||
    req.query.token;
  const payload = token && verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Unauthorized' });
  req.userId = payload.uid;
  req.userEmail = payload.email;
  next();
}

module.exports = { signToken, verifyToken, requireAuth };
