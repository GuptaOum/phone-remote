const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

/**
 * In-memory OAuth 2.1 client/code store — enough for the MCP authorization
 * flow (RFC 7591 dynamic client registration + RFC 7636 PKCE).
 *
 * Deliberately not persisted: clients are cheap to re-register (a connector
 * that finds its client_id gone just registers again transparently), and
 * codes live for ~60 seconds anyway. A server restart just means any
 * in-flight "Connect" click needs to be retried — acceptable for v1.
 */

const clients = new Map();        // client_id → { client_id, redirect_uris, client_name }
const codes = new Map();          // code → { clientId, userId, redirectUri, codeChallenge, expiresAt }

const CODE_TTL_MS = 60_000;

function registerClient({ redirect_uris, client_name }) {
  if (!Array.isArray(redirect_uris) || !redirect_uris.length) {
    throw new Error('redirect_uris is required');
  }
  const client_id = uuidv4();
  const client = {
    client_id,
    redirect_uris,
    client_name: client_name || 'MCP Client',
  };
  clients.set(client_id, client);
  return client;
}

function getClient(clientId) {
  return clients.get(clientId) || null;
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
