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

  // The web UI is the React app (client/). server/public only holds the
  // OAuth consent page used by the MCP connector, plus its stylesheet.
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
  // Large downloads (the Android APK) live in a mounted folder, not the image:
  // replacing the APK is a file copy, no rebuild. Served at the site root.
  const DOWNLOADS = process.env.DOWNLOADS_DIR;
  if (DOWNLOADS && fs.existsSync(DOWNLOADS)) app.use(express.static(DOWNLOADS));

  // Page routes
  if (CLIENT_DIST) {
    const spaIndex = path.join(CLIENT_DIST, 'index.html');
    app.get(['/', '/login', '/dashboard', '/mirror', '/camera', '/files', '/location', '/mcp-test'], (_, res) => {
      res.sendFile(spaIndex);
    });
  } else {
    console.warn('⚠️  React client not built (client/dist missing) — run `npm run build` in client/ or use the Docker image.');
    app.get(['/', '/login', '/dashboard', '/mirror', '/camera', '/files', '/location', '/mcp-test'], (_, res) => {
      res.status(503).send('Web UI not built. Build client/ (npm run build) or run the Docker image.');
    });
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

  // Blue-green deploys stop the old instance with SIGTERM once the new one is
  // live. Close every socket right away (1012 = service restart) so phones and
  // browsers reconnect at once — through nginx, to the new instance.
  let stopping = false;
  const shutdown = (sig) => {
    if (stopping) return;
    stopping = true;
    console.log(`👋 ${sig}: closing ${wss.clients.size} socket(s), shutting down`);
    server.close(() => process.exit(0));
    wss.clients.forEach((ws) => {
      try { ws.close(1012, 'server restart'); } catch { /* already gone */ }
    });
    setTimeout(() => wss.clients.forEach((ws) => ws.terminate()), 2000).unref();
    server.closeIdleConnections?.();
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  console.error('Fatal startup error:', e);
  process.exit(1);
});
