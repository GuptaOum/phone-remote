require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const db = require('./services/db');
const { setupSignaling, presence } = require('./services/signaling');
const { setupAuthRoutes } = require('./routes/auth');
const { setupFileRoutes } = require('./routes/files');
const { setupOAuthRoutes } = require('./routes/oauth');
const { setupMcpRoutes } = require('./routes/mcp');
const { errorHandler } = require('./middleware/errorHandler');
const { logger } = require('./middleware/logger');

const PORT = process.env.PORT || 3000;

async function main() {
  await db.init();

  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server });

  app.set('trust proxy', 1); // nginx terminates TLS — needed so req.protocol reports https
  app.use(cors());
  app.use(express.json({ limit: '25mb' })); // MCP send_file carries base64 file data in the JSON-RPC body
  app.use(express.urlencoded({ extended: false })); // OAuth token exchange uses form-encoded bodies
  app.use(logger);

  // Serve static files from React build if present, otherwise legacy public
  const clientCandidates = [
    path.join(__dirname, '../../client/dist'),
    path.join(__dirname, '../dist'),
    path.join(__dirname, '../client/dist'),
  ];
  const CLIENT_DIST = clientCandidates.find((p) => fs.existsSync(path.join(p, 'index.html')));
  const PUBLIC = path.join(__dirname, '../public');

  if (CLIENT_DIST) {
    console.log(`🚀 Serving React + Vite SPA from: ${CLIENT_DIST}`);
    app.use(express.static(CLIENT_DIST));
  }
  app.use(express.static(PUBLIC));

  // Page routes
  if (CLIENT_DIST) {
    const spaIndex = path.join(CLIENT_DIST, 'index.html');
    app.get(['/', '/login', '/dashboard', '/mirror', '/camera', '/files', '/location', '/mcp-test'], (_, res) => {
      res.sendFile(spaIndex);
    });
  } else {
    app.get('/',          (_, res) => res.redirect('/dashboard'));
    app.get('/login',     (_, res) => res.sendFile(path.join(PUBLIC, 'login.html')));
    app.get('/dashboard', (_, res) => res.sendFile(path.join(PUBLIC, 'dashboard.html')));
    app.get('/mirror',    (_, res) => res.sendFile(path.join(PUBLIC, 'mirror.html')));
    app.get('/camera',    (_, res) => res.sendFile(path.join(PUBLIC, 'camera.html')));
    app.get('/files',     (_, res) => res.sendFile(path.join(PUBLIC, 'files.html')));
    app.get('/location',  (_, res) => res.sendFile(path.join(PUBLIC, 'location.html')));
    app.get('/mcp-test',  (_, res) => res.sendFile(path.join(PUBLIC, 'mcp-test.html')));
  }

  app.get('/health', (_, res) => res.json({ ok: true }));

  app.get('/qr', async (req, res) => {
    const url = req.query.url || `http://localhost:${PORT}`;
    const qr = await QRCode.toDataURL(url);
    res.json({ qr });
  });

  setupAuthRoutes(app, presence);
  setupFileRoutes(app);
  setupSignaling(wss, app);
  setupOAuthRoutes(app);
  setupMcpRoutes(app);

  // SPA fallback for client-side routing on page refresh
  if (CLIENT_DIST) {
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/mcp') || req.path.startsWith('/oauth') || req.path.startsWith('/ws')) {
        return next();
      }
      res.sendFile(path.join(CLIENT_DIST, 'index.html'));
    });
  }

  app.use(errorHandler);

  server.listen(PORT, () => {
    console.log('\n📱 Phone Remote — multi-account server');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`📡 Listening: http://0.0.0.0:${PORT}`);
    console.log(`🔐 Login:     http://localhost:${PORT}/login`);
  });
}

main().catch((e) => {
  console.error('Fatal startup error:', e);
  process.exit(1);
});
