function authMiddleware(secret) {
  return (req, res, next) => {
    const token =
      req.query.secret ||
      req.headers.authorization?.replace('Bearer ', '');
    if (!token || token !== secret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  };
}
module.exports = { authMiddleware };
