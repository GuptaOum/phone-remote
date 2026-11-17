const crypto = require('crypto');
const fs = require('fs');

/**
 * ICE servers handed to browsers and phones for WebRTC.
 *
 * STUN (Google) lets the two ends find a direct path. When a network blocks
 * that, TURN (our coturn container) relays the media instead.
 *
 * TURN uses coturn's "REST API" auth (--use-auth-secret): no stored
 * passwords. Each client gets a short-lived username "<expiry>:<userId>" and a
 * password = base64(HMAC-SHA1(TURN_SECRET, username)), which coturn checks
 * with the same shared secret. Leaked credentials die on their own.
 *
 * Without TURN_SECRET only STUN is returned (direct path or JPEG fallback).
 */
const STUN = { urls: 'stun:stun.l.google.com:19302' };
const TTL_S = 24 * 3600;
const PORT = process.env.TURN_PORT || 3478;

// TURN_SECRET env wins; otherwise the file docker compose's turn-init creates.
let fileSecret = null;
function turnSecret() {
  if (process.env.TURN_SECRET) return process.env.TURN_SECRET;
  if (fileSecret) return fileSecret;
  const f = process.env.TURN_SECRET_FILE;
  if (!f) return null;
  try { fileSecret = fs.readFileSync(f, 'utf8').trim() || null; } catch { /* not created yet */ }
  return fileSecret;
}

function turnHost() {
  if (process.env.TURN_HOST) return process.env.TURN_HOST;
  try { return new URL(process.env.PUBLIC_URL).hostname; } catch { return null; }
}

function iceServers(userId) {
  const secret = turnSecret();
  const host = turnHost();
  if (!secret || !host) return [STUN];

  const username = `${Math.floor(Date.now() / 1000) + TTL_S}:${userId}`;
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
  return [
    STUN,
    {
      urls: [`turn:${host}:${PORT}?transport=udp`, `turn:${host}:${PORT}?transport=tcp`],
      username,
      credential,
    },
  ];
}

module.exports = { iceServers };
