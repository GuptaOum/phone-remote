const express = require('express');
const path = require('path');
const oauthStore = require('../services/oauthStore');
const { signToken, verifyToken } = require('../middleware/auth');
const db = require('../services/db');

const MCP_TOKEN_TTL = process.env.MCP_TOKEN_TTL || '90d';

/**
 * OAuth 2.1 authorization server for the MCP connector (RFC 7591 dynamic
 * client registration + RFC 7636 PKCE, RFC 8414 / RFC 9728 metadata).
 *
 * Flow:
 *   1. claude.ai discovers endpoints via /.well-known/oauth-authorization-server
 *   2. POST /oauth/register        → claude.ai self-registers, gets a client_id
 *   3. Browser opens GET /oauth/authorize?... → oauth-authorize.html checks
 *      for a Phone Remote login (localStorage token); if missing, sends the
 *      user through the existing /login page first (?next= carries them back)
 *   4. Page POSTs /oauth/authorize with the user's token → gets an auth code
 *      → redirects the browser back to claude.ai's redirect_uri
 *   5. claude.ai's backend calls POST /oauth/token to exchange the code
 *      (+ PKCE verifier) for an access_token — a normal Phone Remote JWT,
 *      just longer-lived, that the /mcp endpoint accepts exactly like any
 *      other Bearer token.
 */
function setupOAuthRoutes(app) {
  const r = express.Router();
  const issuer = () => `${process.env.PUBLIC_URL || ''}`.replace(/\/$/, '') || null;
  const baseUrl = (req) => issuer() || `${req.protocol}://${req.get('host')}`;

  // ── Discovery metadata ──────────────────────────────────────────────────
  app.get('/.well-known/oauth-authorization-server', (req, res) => {
    const base = baseUrl(req);
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  });

  app.get('/.well-known/oauth-protected-resource', (req, res) => {
    const base = baseUrl(req);
    res.json({
      resource: `${base}/mcp`,
      authorization_servers: [base],
    });
  });

  // ── Dynamic client registration ─────────────────────────────────────────
  r.post('/register', (req, res) => {
    try {
      const client = oauthStore.registerClient(req.body || {});
      res.status(201).json({
        client_id: client.client_id,
        redirect_uris: client.redirect_uris,
        client_name: client.client_name,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'],
        response_types: ['code'],
      });
    } catch (e) {
      res.status(400).json({ error: 'invalid_client_metadata', error_description: e.message });
    }
  });

  // ── Authorization page ──────────────────────────────────────────────────
  r.get('/authorize', (req, res) => {
    res.sendFile(path.join(__dirname, '../../public/oauth-authorize.html'));
  });

  // Called by the page's script once it has a Phone Remote login token
  r.post('/authorize', (req, res) => {
    const token = req.headers.authorization?.replace(/^Bearer /, '');
    const payload = token && verifyToken(token);
    if (!payload) return res.status(401).json({ error: 'invalid_token' });

    const { client_id, redirect_uri, code_challenge, code_challenge_method, state } = req.body || {};
    const client = client_id && oauthStore.getClient(client_id);
    if (!client) return res.status(400).json({ error: 'invalid_client' });
    if (!redirect_uri || !oauthStore.isRedirectUriAllowed(client, redirect_uri)) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri not registered for this client' });
    }
    if (!code_challenge) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'code_challenge (PKCE) is required' });
    }

    const code = oauthStore.createCode({
      clientId: client_id,
      userId: payload.uid,
      redirectUri: redirect_uri,
      codeChallenge: code_challenge,
      codeChallengeMethod: code_challenge_method || 'S256',
    });

    const redirect = new URL(redirect_uri);
    redirect.searchParams.set('code', code);
    if (state) redirect.searchParams.set('state', state);
    res.json({ redirect: redirect.toString() });
  });

  // ── Token exchange ───────────────────────────────────────────────────────
  r.post('/token', async (req, res) => {
    const body = req.body || {};
    if (body.grant_type !== 'authorization_code') {
      return res.status(400).json({ error: 'unsupported_grant_type' });
    }
    const entry = oauthStore.consumeCode(body.code);
    if (!entry) return res.status(400).json({ error: 'invalid_grant', error_description: 'Code is invalid, expired, or already used' });
    if (entry.clientId !== body.client_id) return res.status(400).json({ error: 'invalid_grant', error_description: 'client_id mismatch' });
    if (entry.redirectUri !== body.redirect_uri) return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
    if (!oauthStore.verifyPkce(body.code_verifier, entry.codeChallenge, entry.codeChallengeMethod)) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
    }

    const user = await db.getUserById(entry.userId);
    if (!user) return res.status(400).json({ error: 'invalid_grant', error_description: 'Account no longer exists' });

    const access_token = signToken(user, MCP_TOKEN_TTL);
    res.json({
      access_token,
      token_type: 'bearer',
      expires_in: 60 * 60 * 24 * 90, // matches MCP_TOKEN_TTL default (90d)
      scope: 'phone-remote:control',
    });
  });

  app.use('/oauth', r);
}

module.exports = { setupOAuthRoutes };
