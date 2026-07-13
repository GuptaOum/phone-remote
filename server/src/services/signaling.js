const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const { verifyToken, requireAuth } = require('../middleware/auth');

/**
 * Multi-account signaling + control relay.
 *
 * Every connection authenticates with a JWT:
 *   auth      { type, token }                          → auth_ok | auth_error
 *
 * Then registers a role:
 *   phone     { type:'register', role:'phone', deviceId, deviceName, screenW, screenH, model }
 *   browser   { type:'register', role:'browser', deviceId }   ← the device it wants to control
 *
 * Routing model:
 *   accounts: userId → {
 *     phones:       Map<deviceId, ws>     — all of this user's connected phones
 *     browsers:     Set<ws>               — all of this user's open browser tabs
 *     lastLocation: Map<deviceId, msg>    — cached last GPS fix per device
 *   }
 *
 * A browser controls exactly ONE device (ws.watchId). All browser→phone
 * messages go only to that device; all phone→browser messages (JSON and
 * binary JPEG frames) go only to browsers of the SAME account watching
 * THAT device. Accounts are fully isolated.
 */

const accounts = new Map();

function acct(userId) {
  let a = accounts.get(userId);
  if (!a) {
    // phones = primary socket per device (all browser→phone traffic goes here);
    // phonePool = ALL live sockets per device — the app UI and the background
    // service each hold one, and closing "the other" caused an endless
    // replace/reconnect fight that dropped transfers mid-flight.
    a = { phones: new Map(), phonePool: new Map(), browsers: new Set(), lastLocation: new Map() };
    accounts.set(userId, a);
  }
  return a;
}

function cleanupAcct(userId) {
  const a = accounts.get(userId);
  if (a && a.phones.size === 0 && a.browsers.size === 0) accounts.delete(userId);
}

function revokeDevice(userId, deviceId, reason = 'device_removed') {
  const a = accounts.get(userId);
  if (!a) return false;
  // Close EVERY pooled socket for the device, not just the primary —
  // otherwise a secondary connection would be promoted and the "removed"
  // device would stay online.
  const pool = a.phonePool?.get(deviceId);
  if (pool) {
    for (const s of pool) {
      if (s === a.phones.get(deviceId)) continue; // primary handled below
      try { s.send(j({ type: 'device_removed', reason })); } catch (_) {}
      try { s.send(j({ type: '_auth_error', reason })); } catch (_) {}
      try { s.close(4001, reason); } catch (_) {}
    }
  }
  const phone = a.phones.get(deviceId);
  if (!phone || phone.readyState !== 1) {
    a.lastLocation.delete(deviceId);
    return false;
  }
  try {
    phone.send(j({ type: 'device_removed', reason }));
  } catch (_) {}
  try {
    phone.send(j({ type: '_auth_error', reason }));
  } catch (_) {}
  try {
    phone.close(4001, reason);
  } catch (_) {}
  return true;
}

// Live presence — used by GET /api/devices
const presence = {
  isOnline(userId, deviceId) {
    return accounts.get(userId)?.phones.has(deviceId) || false;
  },
};

// ── MCP bridge ───────────────────────────────────────────────────────────────
// The MCP HTTP endpoint has no persistent connection of its own — it borrows
// the account's existing phone WebSocket for fire-and-forget commands, and
// for request/response calls (file listing, screenshot) it correlates on the
// same `id` field the browser dashboard already uses.

// requestId → { resolve, reject } — resolved when the matching phone→server
// reply (pf_list_result, pf_error, ...) arrives, regardless of whether any
// browser is also watching.
const pendingHttpRequests = new Map();

function getPhoneSocket(userId, deviceId) {
  const p = accounts.get(userId)?.phones.get(deviceId);
  return p?.readyState === 1 ? p : null;
}

/** Fire-and-forget control command (tap/swipe/text/ring/flash/...). */
function sendToPhone(userId, deviceId, msg) {
  const phone = getPhoneSocket(userId, deviceId);
  if (!phone) return false;
  phone.send(j(msg));
  return true;
}

function getLastLocation(userId, deviceId) {
  return accounts.get(userId)?.lastLocation.get(deviceId) || null;
}

/** Live screen dimensions, known only while the phone is connected. */
function getDeviceScreenSize(userId, deviceId) {
  const p = getPhoneSocket(userId, deviceId);
  return p ? { screenW: p.screenW, screenH: p.screenH } : null;
}

/**
 * Send a message to the phone and wait for its correlated reply (matched by
 * `id`). Used for pf_list / pf_delete, which already round-trip an id.
 */
function requestFromPhone(userId, deviceId, buildMsg, timeoutMs = 15000) {
  const phone = getPhoneSocket(userId, deviceId);
  if (!phone) return Promise.reject(new Error('Device is offline'));
  const id = uuidv4();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingHttpRequests.delete(id);
      reject(new Error('Phone did not respond in time'));
    }, timeoutMs);
    pendingHttpRequests.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    phone.send(j(buildMsg(id)));
  });
}

/**
 * Push a file to the phone over the existing pf_upload protocol. Chunks are
 * sent sequentially: each non-final chunk waits for the phone's
 * pf_upload_chunk_ack, the final one for pf_upload_ok — same flow control the
 * browser dashboard uses, so large files can't flood the WebSocket.
 */
async function uploadToPhone(userId, deviceId, destPath, buffer, timeoutMs = 20000) {
  const phone = getPhoneSocket(userId, deviceId);
  if (!phone) throw new Error('Device is offline');
  const id = uuidv4();
  const CHUNK = 64 * 1024;
  const total = Math.ceil(buffer.length / CHUNK) || 1;
  phone.send(j({ type: 'pf_upload_start', id, path: destPath, size: buffer.length, total }));
  // The phone handles start and chunk on separate threads — give start a
  // moment to register the destination path before the first chunk lands.
  await new Promise((r) => setTimeout(r, 250));
  try {
    for (let i = 0; i < total; i++) {
      const done = i === total - 1;
      const data = buffer.subarray(i * CHUNK, (i + 1) * CHUNK).toString('base64');
      // The phone may drop and re-register its socket between chunks (the app
      // and the background service both connect), so resolve the live socket
      // fresh for every attempt instead of trusting the one captured at start.
      const attempt = () => new Promise((resolve, reject) => {
        const ws = getPhoneSocket(userId, deviceId);
        if (!ws) return reject(new Error('offline'));
        const timer = setTimeout(() => {
          pendingHttpRequests.delete(id);
          reject(new Error('ack timeout'));
        }, timeoutMs);
        pendingHttpRequests.set(id, {
          resolve: (v) => { clearTimeout(timer); resolve(v); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        });
        ws.send(j({ type: 'pf_upload_chunk', id, index: i, total, data, done }));
      });
      try {
        await attempt();
      } catch {
        // The chunk (or its ack) died with a dropped socket. The phone
        // dedupes by chunk index, so one re-send — after a beat for the
        // reconnect to land — is safe and rescues the transfer.
        await new Promise((r) => setTimeout(r, 4000));
        try {
          await attempt();
        } catch {
          throw new Error(`UPLOAD CANCELLED: the phone did not acknowledge chunk ${i + 1}/${total} even after a retry (connection dropped mid-transfer). Retry the upload when the connection is stable.`);
        }
      }
    }
  } catch (e) {
    // Best effort: tell the phone to drop its half-received buffer right away
    // (its idle-TTL sweep is the fallback if this doesn't get through).
    try { getPhoneSocket(userId, deviceId)?.send(j({ type: 'pf_upload_cancel', id })); } catch (_) {}
    throw e;
  }
  return destPath;
}

/**
 * Pull a file from the phone over the existing pf_download protocol — the
 * same fake-watcher trick as captureScreenshot below, but collecting the
 * JSON pf_chunk stream instead of one binary frame. The phone-socket relay
 * already acks each chunk (pf_chunk_ack), so flow control comes for free.
 * No phone-side (Kotlin) changes needed.
 */
function downloadFromPhone(userId, deviceId, path, { idleTimeoutMs = 20000, maxBytes = 50 * 1024 * 1024 } = {}) {
  const phone = getPhoneSocket(userId, deviceId);
  if (!phone) return Promise.reject(new Error('Device is offline'));
  const a = acct(userId);
  const id = uuidv4();
  return new Promise((resolve, reject) => {
    let settled = false;
    const parts = [];
    let received = 0;
    let timer = null;
    const fail = (message) => {
      if (settled) return;
      settled = true;
      cleanup();
      // Best effort: stop the phone from streaming the rest.
      try { getPhoneSocket(userId, deviceId)?.send(j({ type: 'pf_download_cancel', id })); } catch (_) {}
      reject(new Error(message));
    };
    // Idle timeout, re-armed on every chunk — a big file is fine as long as
    // data keeps flowing; silence means the transfer died.
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => fail(`DOWNLOAD CANCELLED: no data from the phone for ${idleTimeoutMs / 1000}s.`), idleTimeoutMs);
    };
    const fake = {
      watchId: deviceId,
      readyState: 1,
      send: (data, opts) => {
        try {
          if (settled || (opts && opts.binary)) return;
          let m;
          try { m = JSON.parse(data); } catch { return; }
          if (m.id !== id) return;
          if (m.type === 'pf_error') return fail(m.error || 'Phone reported an error');
          if (m.type !== 'pf_chunk') return;
          const buf = Buffer.from(m.data || '', 'base64');
          parts[m.index] = buf;
          received += buf.length;
          if (received > maxBytes) return fail(`File exceeds the ${Math.round(maxBytes / 1048576)} MB limit.`);
          arm();
          if (m.done) {
            // A mid-stream reconnect can silently drop chunks — verify the
            // sequence is complete before assembling, or Buffer.concat would
            // hit the holes (and a corrupt file would be worse anyway).
            const total = m.total || m.index + 1;
            for (let i = 0; i < total; i++) {
              if (!parts[i]) return fail(`DOWNLOAD FAILED: chunk ${i + 1}/${total} was lost in transit (connection blip mid-stream) — retry.`);
            }
            settled = true;
            cleanup();
            resolve(Buffer.concat(parts));
          }
        } catch (e) {
          fail(`Download failed: ${e.message}`);
        }
      },
    };
    function cleanup() { clearTimeout(timer); a.browsers.delete(fake); }
    a.browsers.add(fake);
    arm();
    phone.send(j({ type: 'pf_download', id, path }));
  });
}

/**
 * Screenshot has no request-id in its binary reply — it's a broadcast to
 * whichever browsers are "watching" the device. So we register a fake
 * browser socket for the duration of one capture: it looks enough like a
 * real ws (readyState + send) to receive the relay, and its send() just
 * resolves our promise with the raw JPEG bytes instead of touching a socket.
 * No phone-side (Kotlin) changes needed.
 */
function captureScreenshot(userId, deviceId, timeoutMs = 15000) {
  const phone = getPhoneSocket(userId, deviceId);
  if (!phone) return Promise.reject(new Error('Device is offline'));
  const a = acct(userId);
  return new Promise((resolve, reject) => {
    let settled = false;
    const fake = {
      watchId: deviceId,
      readyState: 1,
      send: (data, opts) => {
        if (settled) return;
        if (opts && opts.binary && Buffer.isBuffer(data) && data[0] === 0x03) {
          settled = true;
          cleanup();
          resolve(data.subarray(1));
        }
      },
    };
    const onJson = (msg) => {
      if (settled || msg.type !== 'screenshot_error') return;
      settled = true;
      cleanup();
      reject(new Error(msg.reason || 'Screenshot failed'));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Screenshot timed out'));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      a.browsers.delete(fake);
      a.mcpErrorListeners?.delete(onJson);
    }
    a.browsers.add(fake);
    if (!a.mcpErrorListeners) a.mcpErrorListeners = new Set();
    a.mcpErrorListeners.add(onJson);
    phone.send(j({ type: 'screenshot' }));
  });
}

function setupSignaling(wss, app) {
  wss.on('connection', (ws) => {
    ws.id = uuidv4();
    ws.isAlive = true;
    ws.authed = false;
    ws.userId = null;
    ws.role = null;
    ws.deviceId = null;  // set for phones
    ws.watchId = null;   // set for browsers — the device being controlled

    ws.on('pong', () => { ws.isAlive = true; });

    // Browser tabs of THIS account watching THIS phone's device
    const watchers = () => {
      if (!ws.userId || !ws.deviceId) return [];
      const a = accounts.get(ws.userId);
      if (!a) return [];
      return [...a.browsers].filter((b) => b.watchId === ws.deviceId);
    };

    // The phone THIS browser is controlling
    const myPhone = () => {
      if (!ws.userId || !ws.watchId) return null;
      const p = accounts.get(ws.userId)?.phones.get(ws.watchId);
      return p?.readyState === 1 ? p : null;
    };

    const relayToPhone = (msg) => { if (ws.role === 'browser') myPhone()?.send(j(msg)); };
    const relayToWatchers = (msg) => { if (ws.role === 'phone') bcast(watchers(), msg); };

    ws.on('message', (raw, isBinary) => {
      // Binary frames = screen/camera/screenshot JPEGs — relay only to
      // browsers of the same account watching this device. Zero parsing
      // beyond the 1-byte type marker.
      if (isBinary) {
        if (ws.authed && ws.role === 'phone') {
          const marker = raw[0];
          watchers().forEach((b) => {
            if (b.readyState !== 1) return;
            // Live stream (0x01) and camera (0x02) frames are disposable: if
            // a browser's socket is backed up, DROP the frame instead of
            // queueing it — otherwise the backlog keeps playing long after
            // the phone stopped streaming. Screenshots (0x03) always deliver.
            if ((marker === 0x01 || marker === 0x02) && (b.bufferedAmount || 0) > 512 * 1024) return;
            b.send(raw, { binary: true });
          });
        }
        return;
      }

      let msg;
      try { msg = JSON.parse(raw); }
      catch { return; }

      if (msg.type === 'auth') {
        const payload = msg.token && verifyToken(msg.token);
        if (!payload) {
          ws.send(j({ type: 'auth_error', reason: 'invalid_token' }));
          ws.close(4001, 'invalid token');
          return;
        }
        ws.authed = true;
        ws.userId = payload.uid;
        ws.tokenIat = payload.iat || 0; // seconds — used to reject removed devices
        ws.send(j({ type: 'auth_ok' }));
        return;
      }

      if (!ws.authed) return;

      switch (msg.type) {

        case 'register': {
          ws.role = msg.role;
          const a = acct(ws.userId);

          if (msg.role === 'phone') {
            ws.deviceId = msg.deviceId || 'default';
            ws.agent = msg.agent || null; // 'service' = the authoritative background-service socket
            ws.screenW = msg.screenW || 1080;
            ws.screenH = msg.screenH || 1920;
            ws.model = msg.model || 'Android Device';
            ws.deviceName = msg.deviceName || ws.model;

            // Revocation gate: a device removed from the dashboard may only
            // re-register with a token issued AFTER the removal (i.e. the
            // user signed in again). Old auto-login tokens are rejected, so
            // reopening the app can't silently re-add the device.
            db.getDevice(ws.deviceId).then((row) => {
              if (ws.readyState !== 1) return;
              if (row && row.user_id === ws.userId && row.revoked_at && ws.tokenIat * 1000 < row.revoked_at) {
                ws.send(j({ type: 'device_removed', reason: 'removed_from_dashboard' }));
                ws.send(j({ type: '_auth_error', reason: 'device_removed' }));
                ws.close(4001, 'device removed');
                console.log(`📱 Rejected revoked device user=${ws.userId.slice(0, 8)} device=${ws.deviceId.slice(0, 8)}`);
                return;
              }

              // Pool this socket. The same device legitimately holds several
              // live connections (app UI + background service) — never close
              // the others. Primary selection: the background SERVICE socket
              // owns all control/file/camera handling, so a service socket
              // always outranks the app's socket, and a newly-registered
              // service socket takes over immediately (its registration just
              // proved it's alive — no waiting for the heartbeat to clear a
              // dead predecessor).
              let pool = a.phonePool.get(ws.deviceId);
              if (!pool) { pool = new Set(); a.phonePool.set(ws.deviceId, pool); }
              pool.add(ws);
              const cur = a.phones.get(ws.deviceId);
              const curAlive = cur && cur.readyState === 1;
              if (ws.agent === 'service' || !curAlive) a.phones.set(ws.deviceId, ws);

              db.upsertDevice({ id: ws.deviceId, userId: ws.userId, name: ws.deviceName, model: ws.model })
                .catch((e) => console.error('upsertDevice failed:', e.message));

              // Notify this account's browsers: watchers get full connect info,
              // dashboard tabs (no watchId) get a lightweight presence event.
              bcast(watchers(), {
                type: 'phone_connected',
                deviceId: ws.deviceId,
                screenW: ws.screenW,
                screenH: ws.screenH,
                model: ws.model,
              });
              bcast([...a.browsers], { type: 'device_online', deviceId: ws.deviceId, name: ws.deviceName, model: ws.model });
              console.log(`📱 Phone connected  user=${ws.userId.slice(0, 8)} device=${ws.deviceId.slice(0, 8)} (${ws.model}, ${ws.screenW}×${ws.screenH})`);
            }).catch((e) => console.error('register device check failed:', e.message));
          } else {
            ws.watchId = msg.deviceId || null;
            a.browsers.add(ws);
            const p = ws.watchId && a.phones.get(ws.watchId);
            if (p) {
              ws.send(j({
                type: 'phone_connected',
                deviceId: p.deviceId,
                screenW: p.screenW,
                screenH: p.screenH,
                model: p.model,
              }));
              const loc = a.lastLocation.get(ws.watchId);
              if (loc) ws.send(j(loc));
            }
            console.log(`🖥️  Browser connected user=${ws.userId.slice(0, 8)} watching=${ws.watchId?.slice(0, 8) || 'dashboard'} (account tabs: ${a.browsers.size})`);
          }
          break;
        }

        // ── WebRTC negotiation ────────────────────────────────────────────
        case 'offer':
        case 'camera_offer':
          relayToWatchers({ type: msg.type, sdp: msg.sdp });
          break;
        case 'answer':
        case 'camera_answer':
          relayToPhone({ type: msg.type, sdp: msg.sdp });
          break;
        case 'ice':
        case 'camera_ice':
          if (ws.role === 'phone') relayToWatchers({ type: msg.type, candidate: msg.candidate });
          else relayToPhone({ type: msg.type, candidate: msg.candidate });
          break;

        // ── JPEG frame fallback (legacy JSON path) ────────────────────────
        case 'frame':
          relayToWatchers({ type: 'frame', data: msg.data, w: msg.w, h: msg.h });
          break;
        case 'camera_frame':
          relayToWatchers({ type: 'camera_frame', data: msg.data });
          break;

        // ── Phone → watchers status events ────────────────────────────────
        case 'camera_stopped':
        case 'camera_streaming':
        case 'stream_started':
        case 'stream_stopped':
          relayToWatchers({ type: msg.type });
          break;
        case 'camera_error':
          relayToWatchers({ type: 'camera_error', reason: msg.reason });
          break;
        case 'screenshot_error': {
          const errMsg = { type: 'screenshot_error', reason: msg.reason };
          relayToWatchers(errMsg);
          acct(ws.userId).mcpErrorListeners?.forEach((fn) => fn(errMsg));
          break;
        }

        // ── Browser → phone commands ──────────────────────────────────────
        case 'camera_start':
          relayToPhone({ type: 'camera_start', front: msg.front ?? true });
          break;
        case 'camera_stop':
        case 'camera_flip':
        case 'stream_start':
        case 'stream_stop':
        case 'screenshot':
        case 'ring':
          relayToPhone({ type: msg.type });
          break;
        case 'flash':
          relayToPhone({ type: 'flash', count: msg.count ?? 3 });
          break;
        case 'open_app':
          relayToPhone({ type: 'open_app', id: msg.id, query: msg.query, package: msg.package });
          break;

        // ── Phone file system (browser ↔ phone) ───────────────────────────
        case 'pf_list':
        case 'pf_download':
        case 'pf_delete':
        case 'pf_upload_start':
        case 'pf_upload_chunk':
        case 'pf_upload_cancel':
        case 'pf_download_cancel':
          relayToPhone(msg);
          break;
        case 'pf_list_result':
        case 'pf_upload_ok':
        case 'pf_upload_chunk_ack':
        case 'pf_delete_ok':
        case 'open_app_result':
        case 'pf_error': {
          relayToWatchers(msg);
          // Resolve any MCP tool call waiting on this exact request id —
          // independent of whether a browser dashboard is also watching.
          const pending = pendingHttpRequests.get(msg.id);
          if (pending) {
            pendingHttpRequests.delete(msg.id);
            if (msg.type === 'pf_error') pending.reject(new Error(msg.error || 'Phone reported an error'));
            else pending.resolve(msg);
          }
          break;
        }
        case 'pf_chunk': {
          if (ws.role !== 'phone') return;
          bcast(watchers(), msg);
          // Ack back to phone — gates the next chunk send so the WebSocket
          // buffer never floods, which was causing rapid disconnect/reconnect.
          ws.send(j({ type: 'pf_chunk_ack', id: msg.id, index: msg.index }));
          break;
        }
        case 'pf_chunk_ack':
          relayToPhone(msg);
          break;

        // ── Location (phone → watchers, cached per device) ────────────────
        case 'location': {
          if (ws.role !== 'phone') return;
          const loc = {
            type: 'location', deviceId: ws.deviceId,
            lat: msg.lat, lng: msg.lng, accuracy: msg.accuracy,
            altitude: msg.altitude, timestamp: msg.timestamp,
          };
          acct(ws.userId).lastLocation.set(ws.deviceId, loc);
          bcast(watchers(), loc);
          break;
        }

        // ── Remote control (browser → phone) ─────────────────────────────
        case 'control':
          relayToPhone({
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
          });
          break;

        case 'ping':
          ws.send(j({ type: 'pong' }));
          break;
      }
    });

    ws.on('close', () => {
      if (!ws.userId) return;
      const a = accounts.get(ws.userId);
      if (!a) return;

      if (ws.role === 'phone') {
        const pool = a.phonePool.get(ws.deviceId);
        pool?.delete(ws);
        if (pool && pool.size === 0) a.phonePool.delete(ws.deviceId);
        if (a.phones.get(ws.deviceId) === ws) {
          // Primary closed — promote another live socket from the pool so the
          // device stays online with no visible blip. Prefer the service
          // socket: it owns control/file/camera handling.
          const alive = pool ? [...pool].filter((s) => s.readyState === 1) : [];
          const next = alive.find((s) => s.agent === 'service') || alive[0];
          if (next) {
            a.phones.set(ws.deviceId, next);
            console.log(`📱 Phone socket failover user=${ws.userId.slice(0, 8)} device=${ws.deviceId.slice(0, 8)}`);
          } else {
            a.phones.delete(ws.deviceId);
            a.lastLocation.delete(ws.deviceId);
            bcast(watchers(), { type: 'phone_disconnected', deviceId: ws.deviceId });
            bcast([...a.browsers], { type: 'device_offline', deviceId: ws.deviceId });
            db.touchDevice(ws.deviceId).catch(() => {});
            console.log(`📱 Phone disconnected user=${ws.userId.slice(0, 8)} device=${ws.deviceId.slice(0, 8)}`);
          }
        }
      } else if (ws.role === 'browser') {
        a.browsers.delete(ws);
      }
      cleanupAcct(ws.userId);
    });
  });

  // HTTP fast-path for control commands (lower latency than WS for tiny messages)
  if (app) {
    app.post('/api/control', requireAuth, (req, res) => {
      const { deviceId, ...cmd } = req.body || {};
      const phone = accounts.get(req.userId)?.phones.get(deviceId);
      if (!phone || phone.readyState !== 1) return res.status(503).json({ error: 'Phone not connected' });
      phone.send(j({ type: 'control', ...cmd }));
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

module.exports = {
  setupSignaling, presence, revokeDevice,
  sendToPhone, getLastLocation, getDeviceScreenSize, requestFromPhone, captureScreenshot, uploadToPhone, downloadFromPhone,
};
