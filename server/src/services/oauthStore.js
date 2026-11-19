const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const db = require('./db');

/**
 * OAuth 2.1 client/code store for the MCP authorization flow (RFC 7591
 * dynamic client registration + RFC 7636 PKCE).
 *
 * Clients are persisted in the database: not every MCP client re-registers
 * when its client_id is rejected, so losing them on each deploy (blue-green
 * restarts the app) broke re-authentication for some agents. The Map is a
 * cache. Codes live ~60 s and stay in memory.
 */

const clients = new Map();        // cache: client_id → { client_id, redirect_uris, client_name }
const codes = new Map();          // code → { clientId, userId, redirectUri, codeChallenge, expiresAt }

const CODE_TTL_MS = 60_000;

async function registerClient({ redirect_uris, client_name }) {
  if (!Array.isArray(redirect_uris) || !redirect_uris.length) {
    throw new Error('redirect_uris is required');
  }
  // Rows are kept forever, so bound what one unauthenticated call can store.
  if (redirect_uris.length > 10) throw new Error('too many redirect_uris (max 10)');
  for (const u of redirect_uris) {
    if (typeof u !== 'string' || u.length > 2000) throw new Error('each redirect_uri must be a string of at most 2000 characters');
    try { new URL(u); } catch { throw new Error(`invalid redirect_uri: ${u}`); }
  }
  const client = {
    client_id: uuidv4(),
    redirect_uris,
    client_name: String(client_name || 'MCP Client').slice(0, 200),
  };
  await db.saveOAuthClient(client);
  clients.set(client.client_id, client);
  return client;
}

async function getClient(clientId) {
  if (typeof clientId !== 'string' || clientId.length > 100) return null;
  if (clients.has(clientId)) return clients.get(clientId);
  const client = await db.getOAuthClient(clientId);
  if (client) clients.set(clientId, client);
  return client;
}

function isRedirectUriAllowed(client, redirectUri) {
  return client.redirect_uris.includes(redirectUri);
}

function createCode({ clientId, userId, redirectUri, codeChallenge, codeChallengeMethod }) {
  const code = crypto.randomBytes(32).toString('base64url');
  codes.set(code, {
    clientId, userId, redirectUri, codeChallenge, codeChallengeMethod,
    expiresAt: Date.now() + CODE_TTL_MS,
    used: false,
  });
  return code;
}

function consumeCode(code) {
  const entry = codes.get(code);
  if (!entry) return null;
  codes.delete(code); // single use, regardless of outcome
  if (entry.used || Date.now() > entry.expiresAt) return null;
  return entry;
}

/** RFC 7636 — code_challenge = base64url(sha256(code_verifier)) */
function verifyPkce(codeVerifier, codeChallenge, method) {
  if (method && method !== 'S256') return false; // 'plain' not supported
  if (!codeVerifier) return false;
  const computed = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  return computed === codeChallenge;
}

// Periodic sweep so long-lived processes don't accumulate expired codes
setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of codes) if (now > entry.expiresAt) codes.delete(code);
}, 5 * 60_000).unref();

module.exports = { registerClient, getClient, isRedirectUriAllowed, createCode, consumeCode, verifyPkce };
