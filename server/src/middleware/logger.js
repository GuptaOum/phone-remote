function logger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    if (!req.path.startsWith('/health'))
      console.log(`${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`);
  });
  next();
}
module.exports = { logger };
