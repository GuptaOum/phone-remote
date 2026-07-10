const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../services/db');
const { signToken, requireAuth } = require('../middleware/auth');
const { revokeDevice } = require('../services/signaling');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Auth + account API.
 *
 *   POST /api/register  { email, password }        → { token, email }
 *   POST /api/login     { email, password }        → { token, email }
 *   GET  /api/me                                   → { id, email }
 *   GET  /api/devices                              → { devices: [{id, name, model, last_seen, online}] }
 *   DELETE /api/devices/:id                        → { success }
 *
 * `presence` comes from signaling.js — live WS connection state.
 */
function setupAuthRoutes(app, presence) {
  const r = express.Router();

  r.post('/register', async (req, res) => {
    try {
      const { email, password } = req.body || {};
      if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Valid email required' });
      if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
      if (await db.getUserByEmail(email)) return res.status(409).json({ error: 'An account with this email already exists' });
      const hash = await bcrypt.hash(password, 10);
      const user = await db.createUser(email, hash);
      res.json({ token: signToken(user), email: user.email });
    } catch (e) {
      console.error('register failed:', e.message);
      res.status(500).json({ error: 'Registration failed' });
    }
  });

  r.post('/login', async (req, res) => {
    try {
      const { email, password } = req.body || {};
      const user = email && (await db.getUserByEmail(email));
      if (!user || !(await bcrypt.compare(password || '', user.password_hash))) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }
      res.json({ token: signToken(user), email: user.email });
    } catch (e) {
      console.error('login failed:', e.message);
      res.status(500).json({ error: 'Login failed' });
    }
  });

  r.get('/me', requireAuth, async (req, res) => {
    const user = await db.getUserById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ id: user.id, email: user.email });
  });

  r.get('/devices', requireAuth, async (req, res) => {
    const devices = await db.listDevices(req.userId);
    res.json({
      devices: devices.map((d) => ({
        ...d,
        online: presence.isOnline(req.userId, d.id),
      })),
    });
  });

  r.delete('/devices/:id', requireAuth, async (req, res) => {
    // Mark revoked FIRST (keeps the row so reconnects with pre-removal
    // tokens are rejected), then kick the live connection if any.
    await db.revokeDeviceRow(req.params.id, req.userId);
    revokeDevice(req.userId, req.params.id, 'removed_from_dashboard');
    res.json({ success: true });
  });

  app.use('/api', r);
}

module.exports = { setupAuthRoutes };
