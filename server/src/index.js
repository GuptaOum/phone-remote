require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
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
  app.use(express.static(path.join(__dirname, '../public')));

  // Page routes — auth is enforced client-side (redirect to /login without a
  // token) and server-side on every API call and WebSocket message.
  const PUBLIC = path.join(__dirname, '../public');
  app.get('/',          (_, res) => res.redirect('/dashboard'));
  app.get('/login',     (_, res) => res.sendFile(path.join(PUBLIC, 'login.html')));
  app.get('/dashboard', (_, res) => res.sendFile(path.join(PUBLIC, 'dashboard.html')));
  app.get('/mirror',    (_, res) => res.sendFile(path.join(PUBLIC, 'mirror.html')));
  app.get('/camera',    (_, res) => res.sendFile(path.join(PUBLIC, 'camera.html')));
  app.get('/files',     (_, res) => res.sendFile(path.join(PUBLIC, 'files.html')));
  app.get('/location',  (_, res) => res.sendFile(path.join(PUBLIC, 'location.html')));

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
