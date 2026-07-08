const { v4: uuidv4 } = require('uuid');

/**
 * Signaling + control relay server.
 *
 * Roles:
 *   phone   — the Android device (Flutter app)
 *   browser — the web remote control UI
 *
 * Message protocol:
 *   auth       { type, secret }
 *   register   { type, role, screenW, screenH }
 *   offer      { type, sdp }             phone → browser (WebRTC)
 *   answer     { type, sdp }             browser → phone
 *   ice        { type, candidate }       both directions
 *   frame      { type, data, w, h }      phone → browser (JPEG fallback)
 *   control    { type, action, ...args } browser → phone
 *   phone_info { type, screenW, screenH, androidVersion, model }
 *   ping/pong
 *
 * Control actions (browser → phone):
 *   tap    { x, y }                  — single tap (0-1 normalized coords)
 *   swipe  { x1, y1, x2, y2, ms }   — swipe gesture
 *   scroll { x, y, dx, dy }         — scroll
 *   back                             — Android back button
 *   home                             — Android home button
 *   recents                          — Android recents
 *   keyevent { keycode }             — key press
 *   text   { value }                 — type text
 */
function setupSignaling(wss, app) {
  let phone = null;
  let lastLocation = null;
  const browsers = new Set();

  wss.on('connection', (ws) => {
    ws.id = uuidv4();
    ws.isAlive = true;
    ws.authed = true;
    ws.role = null;

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw, isBinary) => {
      // Binary frames are screen/camera JPEG payloads — relay directly, no JSON parsing
      if (isBinary) {
        if (ws.authed && ws.role === 'phone') {
          browsers.forEach(b => { if (b.readyState === 1) b.send(raw, { binary: true }); });
        }
        return;
      }

      let msg;
      try { msg = JSON.parse(raw); }
      catch { return; }

      switch (msg.type) {

        case 'auth': {
          ws.send(j({ type: 'auth_ok' }));
          break;
        }

        case 'register': {
          if (!ws.authed) return;
          ws.role = msg.role;

          if (msg.role === 'phone') {
            phone = ws;
            phone.screenW = msg.screenW || 1080;
            phone.screenH = msg.screenH || 1920;
            // Tell all browsers the phone is here
            bcast(browsers, {
              type: 'phone_connected',
              screenW: phone.screenW,
              screenH: phone.screenH,
              model: msg.model || 'Android Device',
            });
            console.log(`📱 Phone connected (${msg.model || 'unknown'}, ${phone.screenW}×${phone.screenH})`);
          } else {
            browsers.add(ws);
            // Tell this browser current phone status
            if (phone) {
              ws.send(j({
                type: 'phone_connected',
                screenW: phone.screenW,
                screenH: phone.screenH,
              }));
              if (lastLocation) ws.send(j(lastLocation));
            }
            console.log(`🖥️  Browser connected (total: ${browsers.size})`);
          }
          break;
        }

        // ── WebRTC negotiation ────────────────────────────────────────────
        case 'offer': {
          if (!ws.authed || ws.role !== 'phone') return;
          bcast(browsers, { type: 'offer', sdp: msg.sdp });
          break;
        }
        case 'answer': {
          if (!ws.authed || ws.role !== 'browser') return;
          phone?.send(j({ type: 'answer', sdp: msg.sdp }));
          break;
        }
        case 'ice': {
          if (!ws.authed) return;
          if (ws.role === 'phone') bcast(browsers, { type: 'ice', candidate: msg.candidate });
          else phone?.send(j({ type: 'ice', candidate: msg.candidate }));
          break;
        }

        // ── JPEG frame fallback ───────────────────────────────────────────
        case 'frame': {
          if (!ws.authed || ws.role !== 'phone') return;
          bcast(browsers, { type: 'frame', data: msg.data, w: msg.w, h: msg.h });
          break;
        }

        // ── Camera WebRTC (phone ↔ browser) ──────────────────────────────
        case 'camera_offer': {
          if (!ws.authed || ws.role !== 'phone') return;
          bcast(browsers, { type: 'camera_offer', sdp: msg.sdp });
          break;
        }
        case 'camera_answer': {
          if (!ws.authed || ws.role !== 'browser') return;
          phone?.send(j({ type: 'camera_answer', sdp: msg.sdp }));
          break;
        }
        case 'camera_ice': {
          if (!ws.authed) return;
          if (ws.role === 'phone') bcast(browsers, { type: 'camera_ice', candidate: msg.candidate });
          else phone?.send(j({ type: 'camera_ice', candidate: msg.candidate }));
          break;
        }
        case 'camera_stopped': {
          if (!ws.authed || ws.role !== 'phone') return;
          bcast(browsers, { type: 'camera_stopped' });
          break;
        }

        // JPEG relay — same pattern as screen frames, works through any tunnel
        case 'camera_frame': {
          if (!ws.authed || ws.role !== 'phone') return;
          bcast(browsers, { type: 'camera_frame', data: msg.data });
          break;
        }
        case 'camera_streaming': {
          if (!ws.authed || ws.role !== 'phone') return;
          bcast(browsers, { type: 'camera_streaming' });
          break;
        }

        case 'camera_start': {
          if (!ws.authed || ws.role !== 'browser') return;
          phone?.send(j({ type: 'camera_start', front: msg.front ?? true }));
          break;
        }
        case 'camera_stop': {
          if (!ws.authed || ws.role !== 'browser') return;
          phone?.send(j({ type: 'camera_stop' }));
          break;
        }
        case 'camera_flip': {
          if (!ws.authed || ws.role !== 'browser') return;
          phone?.send(j({ type: 'camera_flip' }));
          break;
        }

        // ── Phone file system (browser ↔ phone) ───────────────────────────
        // Browser → Phone requests
        case 'pf_list':
        case 'pf_download':
        case 'pf_delete':
        case 'pf_upload_start':
        case 'pf_upload_chunk': {
          if (!ws.authed || ws.role !== 'browser') return;
          phone?.send(j(msg));
          break;
        }
        // Phone → Browser responses
        case 'pf_list_result':
        case 'pf_upload_ok':
        case 'pf_delete_ok':
        case 'pf_error': {
          if (!ws.authed || ws.role !== 'phone') return;
          bcast(browsers, msg);
          break;
        }
        case 'pf_chunk': {
          if (!ws.authed || ws.role !== 'phone') return;
          bcast(browsers, msg);
          // Ack back to phone — gates the next chunk send so the WebSocket
          // buffer never floods, which was causing rapid disconnect/reconnect.
          ws.send(j({ type: 'pf_chunk_ack', id: msg.id, index: msg.index }));
          break;
        }
        // Browser → Phone: ack relay (browser acknowledges its own chunk receipt)
        case 'pf_chunk_ack': {
          if (!ws.authed || ws.role !== 'browser') return;
          phone?.send(j(msg));
          break;
        }
        case 'pf_download_cancel': {
          if (!ws.authed || ws.role !== 'browser') return;
          phone?.send(j({ type: 'pf_download_cancel', id: msg.id }));
          break;
        }

        // ── Location (phone → browsers) ───────────────────────────────────
        case 'location': {
          if (!ws.authed || ws.role !== 'phone') return;
          lastLocation = { type: 'location', lat: msg.lat, lng: msg.lng, accuracy: msg.accuracy, altitude: msg.altitude, timestamp: msg.timestamp };
          bcast(browsers, lastLocation);
          break;
        }

        // ── Screen stream control (browser → phone, phone → browsers) ───────
        case 'stream_start': {
          if (!ws.authed || ws.role !== 'browser') return;
          phone?.send(j({ type: 'stream_start' }));
          break;
        }
        case 'stream_stop': {
          if (!ws.authed || ws.role !== 'browser') return;
          phone?.send(j({ type: 'stream_stop' }));
          break;
        }
        case 'screenshot': {
          if (!ws.authed || ws.role !== 'browser') return;
          phone?.send(j({ type: 'screenshot' }));
          break;
        }
        case 'ring': {
          if (!ws.authed || ws.role !== 'browser') return;
          phone?.send(j({ type: 'ring' }));
          break;
        }
        case 'flash': {
          if (!ws.authed || ws.role !== 'browser') return;
          phone?.send(j({ type: 'flash', count: msg.count ?? 3 }));
          break;
        }
        case 'screenshot_error': {
          if (!ws.authed || ws.role !== 'phone') return;
          bcast(browsers, { type: 'screenshot_error', reason: msg.reason });
          break;
        }
        case 'stream_stopped': {
          if (!ws.authed || ws.role !== 'phone') return;
          bcast(browsers, { type: 'stream_stopped' });
          break;
        }

        // ── Remote control (browser → phone) ─────────────────────────────
        case 'control': {
          if (!ws.authed || ws.role !== 'browser') return;
          if (phone?.readyState === 1) {
            phone.send(j({
              type: 'control',
              action: msg.action,
              // Pass all possible args — phone ignores what it doesn't need
              x: msg.x, y: msg.y,
              x1: msg.x1, y1: msg.y1,
              x2: msg.x2, y2: msg.y2,
              dx: msg.dx, dy: msg.dy,
              ms: msg.ms,
              keycode: msg.keycode,
              value: msg.value,
            }));
          }
          break;
        }

        case 'ping':
          ws.send(j({ type: 'pong' }));
          break;
      }
    });

    ws.on('close', () => {
      if (ws.role === 'phone') {
        // Only clear the phone slot if THIS ws is the currently-active phone.
        // Both Flutter and the Kotlin foreground service register as 'phone';
        // whichever registered last owns the slot. When the stale one closes
        // we must NOT send a spurious phone_disconnected to the browser.
        if (ws === phone) {
          phone = null;
          lastLocation = null;
          bcast(browsers, { type: 'phone_disconnected' });
          console.log('📱 Phone disconnected');
        } else {
          console.log('📱 Stale phone WS closed (not the active phone, ignoring)');
        }
      } else if (ws.role === 'browser') {
        browsers.delete(ws);
      }
    });
  });

  // HTTP fast-path for control commands (lower latency than WS for tiny messages)
  if (app) {
    app.post('/api/control', (req, res) => {
      if (!phone || phone.readyState !== 1) return res.status(503).json({ error: 'Phone not connected' });
      phone.send(j({ type: 'control', ...req.body }));
      res.json({ ok: true });
    });
  }

  // Heartbeat — 15 s interval: 3 s was too tight and killed connections busy sending file chunks
  const hb = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 15000);
  wss.on('close', () => clearInterval(hb));
}

const j = (obj) => JSON.stringify(obj);
const bcast = (targets, msg) => {
  const s = j(msg);
  targets.forEach((ws) => { if (ws.readyState === 1) ws.send(s); });
};

module.exports = { setupSignaling };
