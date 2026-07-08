require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');
const QRCode = require('qrcode');

const { setupSignaling } = require('./services/signaling');
const { setupFileRoutes } = require('./routes/files');
const { errorHandler } = require('./middleware/errorHandler');
const { logger } = require('./middleware/logger');

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(logger);
app.use(express.static(path.join(__dirname, '../public')));

// Page routes — each served directly, no client-side restoration needed
const PUBLIC = path.join(__dirname, '../public');
app.get('/',         (_, res) => res.redirect('/mirror'));
app.get('/mirror',   (_, res) => res.sendFile(path.join(PUBLIC, 'mirror.html')));
app.get('/camera',   (_, res) => res.sendFile(path.join(PUBLIC, 'camera.html')));
app.get('/files',    (_, res) => res.sendFile(path.join(PUBLIC, 'files.html')));
app.get('/location', (_, res) => res.sendFile(path.join(PUBLIC, 'location.html')));

app.get('/health', (_, res) => res.json({ ok: true }));

app.get('/qr', async (req, res) => {
  const url = req.query.url || `http://localhost:${PORT}`;
  const qr = await QRCode.toDataURL(url);
  res.json({ qr });
});

setupFileRoutes(app);
setupSignaling(wss, app);

app.use(errorHandler);

server.listen(PORT, () => {
  console.log('\n📱 Phone Remote');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📡 Local:  http://localhost:${PORT}`);
  console.log(`\n   For remote access run in a second terminal:`);
  console.log(`   cloudflared tunnel --url http://localhost:${PORT}`);
  console.log(`   Then use the printed https://... URL in the app`);
});
