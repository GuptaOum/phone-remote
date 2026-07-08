class ApiError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

function errorHandler(err, req, res, next) {
  if (err instanceof ApiError)
    return res.status(err.statusCode).json({ error: err.message });
  if (err.code === 'LIMIT_FILE_SIZE')
    return res.status(413).json({ error: 'File too large' });
  console.error('Unexpected error:', err);
  return res.status(500).json({ error: 'Internal server error' });
}

module.exports = { errorHandler, ApiError };
