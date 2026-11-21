const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const { verifyToken, requireAuth } = require('../middleware/auth');
const { iceServers } = require('./turn');

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
    // media: deviceId → what the phone is capturing, as far as the server knows.
    // downloadOwners: pf_download id → the browser that asked for it.
    a = {
      phones: new Map(), phonePool: new Map(), browsers: new Set(), lastLocation: new Map(),
      media: new Map(), downloadOwners: new Map(),
    };
    accounts.set(userId, a);
  }
  return a;
}

function cleanupAcct(userId) {
  const a = accounts.get(userId);
  // phonePool must be checked too: a socket mid-registration is already pooled
  // but not yet primary, and dropping the account here would strand it under an
  // object no lookup can reach.
  if (a && a.phones.size === 0 && a.browsers.size === 0 && a.phonePool.size === 0) {
    for (const m of a.media.values()) clearTimeout(m.idleTimer);
    accounts.delete(userId);
  }
}

/** Primary live socket for a device, promoting a live pooled one if the primary died. */
function livePhone(a, deviceId) {
  if (!a || !deviceId) return null;
  const p = a.phones.get(deviceId);
  if (p?.readyState === 1) return p;
  for (const s of a.phonePool.get(deviceId) || []) {
    if (s.readyState === 1) {
      a.phones.set(deviceId, s);
      return s;
    }
  }
  return null;
}

// ── Screen / camera ownership ───────────────────────────────────────────────
// Capture on the phone is shared by every tab watching the device. Each
// browser socket records whether IT wants the stream (wantsStream /
// wantsCamera); the phone is only told to stop once no live watcher wants it.
// A tab that closes or refreshes gets IDLE_STOP_GRACE_MS to come back and
// re-claim the stream before the phone is stopped.
const START_PENDING_MS = 15000;
const IDLE_STOP_GRACE_MS = 10000;
const STOP_FRAME_GRACE_MS = 3000;
// Live-frame flow control: at most this many frames unacknowledged per hop.
// 2 keeps the link busy (one frame on the wire while the next is encoded)
// while bounding latency to ~2 frames instead of whatever TCP buffers hold.
const FRAME_WINDOW = 2;
// No ack for this long → assume the acks were lost, not that the link is slow.
const FRAME_ACK_STALL_MS = 1500;
const FRAME_ACK = '{"type":"fa"}';

function mediaState(a, deviceId) {
  let m = a.media.get(deviceId);
  if (!m) {
    m = {
      stream: 'off', streamAt: 0, streamOnAt: 0, streamStopAt: 0,
      camera: 'off', cameraAt: 0, cameraStopAt: 0, cameraFront: true,
      idleTimer: null,
    };
    a.media.set(deviceId, m);
  }
  return m;
}

function viewersOf(a, deviceId) {
  return [...a.browsers].filter((b) => b.role === 'browser' && b.watchId === deviceId && b.readyState === 1);
}

function scheduleIdleCheck(userId, deviceId) {
  const a = accounts.get(userId);
  if (!a || !deviceId) return;
  const m = mediaState(a, deviceId);
  clearTimeout(m.idleTimer);
  m.idleTimer = setTimeout(() => {
    m.idleTimer = null;
    const acc = accounts.get(userId);
    const phone = livePhone(acc, deviceId);
    if (!phone) return;
    const viewers = viewersOf(acc, deviceId);
    if (m.stream !== 'off' && !viewers.some((b) => b.wantsStream)) {
      m.stream = 'off';
      m.streamStopAt = Date.now();
      phone.send(j({ type: 'stream_stop' }));
      console.log(`🛑 Auto-stopped screen stream (no viewers) user=${userId.slice(0, 8)} device=${deviceId.slice(0, 8)}`);
    }
    if (m.camera !== 'off' && !viewers.some((b) => b.wantsCamera)) {
      m.camera = 'off';
      m.cameraStopAt = Date.now();
      phone.send(j({ type: 'camera_stop' }));
      console.log(`🛑 Auto-stopped camera (no viewers) user=${userId.slice(0, 8)} device=${deviceId.slice(0, 8)}`);
    }
  }, IDLE_STOP_GRACE_MS);
}

/**
 * WebRTC is negotiated separately for each media kind. Per kind: which tab
 * flags track it, the phone capability that must be present, and the mode
 * message that moves the phone between JPEG and WebRTC.
 */
const RTC_KINDS = {
  screen: { ready: 'rtcReady', offered: 'rtcOffered', probing: 'rtcProbing', wants: 'wantsStream', mode: 'rtcMode', cap: 'webrtc_screen', msg: 'screen_mode' },
  camera: { ready: 'camRtcReady', offered: 'camRtcOffered', probing: 'camRtcProbing', wants: 'wantsCamera', mode: 'camRtcMode', cap: 'webrtc_camera', msg: 'camera_mode' },
};
const rtcKind = (k) => (k === 'camera' ? 'camera' : 'screen');
// On phone re-register (= network switch), tell watching tabs to ICE-restart
// their peers right away (pairs with ICE_RESTART in useRtcStream.js).
const ICE_RESTART_HINT = true;

/**
 * Transport for one kind — WebRTC first: as soon as EVERY tab that wants it
 * has offered (or connected) a peer, the phone feeds WebRTC from the first
 * frame. A tab whose attempt fails sends rtc_failed (or never offers), which
 * drops it from the count and moves everyone to JPEG (the phone's capture can
 * feed only one of them at a time). `force` re-sends even if unchanged — used
 * after a phone reconnect or capture restart.
 *
 * A retry after a fallback is a *probe* (rtc_offer with probe:true): it does
 * not count until rtc_ready, so the phone keeps sending JPEG — the picture
 * never goes blank — and switches only once the new peer is connected.
 */
function updateRtcMode(kind, userId, deviceId, force = false) {
  const k = RTC_KINDS[kind];
  const a = accounts.get(userId);
  if (!a || !deviceId) return;
  const m = mediaState(a, deviceId);
  const viewers = viewersOf(a, deviceId).filter((b) => b[k.wants]);
  const rtc = viewers.length > 0 && viewers.every((b) => b[k.ready] || b[k.offered]);
  if (!force && m[k.mode] === rtc) return;
  m[k.mode] = rtc;
  getPhoneSocket(userId, deviceId, k.cap)?.send(j({ type: k.msg, mode: rtc ? 'rtc' : 'jpeg' }));
}
const updateScreenMode = (userId, deviceId, force) => updateRtcMode('screen', userId, deviceId, force);
const updateCameraMode = (userId, deviceId, force) => updateRtcMode('camera', userId, deviceId, force);

/** Tell the phone to drop this tab's WebRTC peer(s) — one kind, or all. */
function closeTabRtc(ws, deviceId = ws.watchId, only = null) {
  for (const kind of only ? [only] : Object.keys(RTC_KINDS)) {
    const k = RTC_KINDS[kind];
    if (!ws[k.ready] && !ws[k.offered] && !ws[k.probing]) continue;
    ws[k.ready] = false;
    ws[k.offered] = false;
    ws[k.probing] = false;
    getPhoneSocket(ws.userId, deviceId, k.cap)?.send(j({ type: 'rtc_close', from: ws.id, kind }));
  }
}

/** Cancel phone→browser downloads this browser socket was receiving. */
function cancelOwnedDownloads(a, ws, deviceId = ws.watchId) {
  if (!ws.downloads) return;
  for (const id of ws.downloads) {
    if (a.downloadOwners.get(id) !== ws) continue;
    a.downloadOwners.delete(id);
    try { livePhone(a, deviceId)?.send(j({ type: 'pf_download_cancel', id })); } catch (_) {}
  }
  ws.downloads.clear();
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
    return !!livePhone(accounts.get(userId), deviceId);
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

/**
 * A live socket for this device.
 *
 * With `cap`, returns a socket that advertised that capability — NOT merely
 * the primary one. A phone holds several sockets at once (the Flutter app's
 * and the background service's), and only the background service handles
 * control/ui_tree/status and answers them. The app's socket registers without
 * `caps` and can become primary, so anything that needs a reply must ask the
 * socket that can actually produce one; asking "primary" is a coin flip.
 *
 * Returns null when no live socket can do it — the caller should treat that
 * as unsupported rather than silently falling back to a socket that will
 * never answer.
 */
function getPhoneSocket(userId, deviceId, cap = null) {
  const a = accounts.get(userId);
  if (!a) return null;
  if (cap) {
    const has = (s) => s && s.readyState === 1 && Array.isArray(s.caps) && s.caps.includes(cap);
    // The primary first: after a network switch the pool still holds the
    // phone's OLD socket (dead, but open until the heartbeat reaps it ~30s
    // later). Iterating in insertion order picked it, so every WebRTC
    // message went nowhere for half a minute.
    const primary = a.phones.get(deviceId);
    if (has(primary)) return primary;
    const pool = [...(a.phonePool.get(deviceId) || [])].reverse(); // newest first
    return pool.find(has) || null;
  }
  return livePhone(a, deviceId);
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

/** True if ANY of the device's live sockets can handle this capability. */
function deviceSupports(userId, deviceId, cap) {
  return !!getPhoneSocket(userId, deviceId, cap);
}

/**
 * Send a control command and wait for the phone to confirm it actually ran.
 *
 * sendToPhone only proves the bytes left this process: if accessibility was
 * off, or Android refused the gesture, the command vanished and the caller
 * still reported success. Builds advertising `control_ack` echo the outcome
 * back, so a failure surfaces as a failure.
 *
 * Older builds don't ack — waiting on them would hang every call — so they
 * fall back to fire-and-forget and say so via `confirmed: false`.
 *
 * @returns {Promise<{confirmed: boolean, ok: boolean, error?: string}>}
 *   Rejects only when the device is offline.
 */
async function controlPhone(userId, deviceId, msg, timeoutMs = 6000) {
  if (!getPhoneSocket(userId, deviceId)) throw new Error('Device is offline');
  if (!deviceSupports(userId, deviceId, 'control_ack')) {
    sendToPhone(userId, deviceId, msg);
    return { confirmed: false, ok: true };
  }
  const reply = await requestFromPhone(userId, deviceId, (id) => ({ ...msg, id }), timeoutMs, 'control_ack');
  return { confirmed: true, ok: !!reply.ok, error: reply.error };
}

/**
 * Send a message to the phone and wait for its correlated reply (matched by
 * `id`). Used for pf_list / pf_delete, which already round-trip an id.
 */
function requestFromPhone(userId, deviceId, buildMsg, timeoutMs = 15000, cap = null) {
  // With a cap, insist on a socket that can reply. Falling back to primary
  // would send the request to the Flutter app's socket, which never answers
  // these — the call would just time out with a misleading message.
  const phone = getPhoneSocket(userId, deviceId, cap) || (cap ? null : getPhoneSocket(userId, deviceId));
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
function downloadFromPhone(userId, deviceId, path, { idleTimeoutMs = 20000, maxBytes = 100 * 1024 * 1024 } = {}) {
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
      return livePhone(accounts.get(ws.userId), ws.watchId);
    };

    const relayToPhone = (msg) => { if (ws.role === 'browser') myPhone()?.send(j(msg)); };
    // Phone → one specific tab (WebRTC answers/candidates are per peer).
    const sendToTab = (tabId, msg) => {
      const a = accounts.get(ws.userId);
      for (const b of a?.browsers || []) {
        if (b.id === tabId && b.watchId === ws.deviceId && b.readyState === 1) { b.send(j(msg)); return; }
      }
    };
    const relayToWatchers = (msg) => { if (ws.role === 'phone') bcast(watchers(), msg); };

    // Phone → server: frames prove capture is running even if the server
    // never saw stream_started (server restart, older app build). Adopt that
    // state so the idle check can stop it when nobody is watching.
    const syncMediaFromFrame = (marker) => {
      const a = accounts.get(ws.userId);
      if (!a || !ws.deviceId) return;
      const m = mediaState(a, ws.deviceId);
      const now = Date.now();
      if (marker === 0x01 && m.stream !== 'on' && now - m.streamStopAt > STOP_FRAME_GRACE_MS) {
        const wasOff = m.stream === 'off';
        m.stream = 'on';
        m.streamOnAt = now;
        if (wasOff) scheduleIdleCheck(ws.userId, ws.deviceId);
      } else if (marker === 0x02 && m.camera !== 'on' && now - m.cameraStopAt > STOP_FRAME_GRACE_MS) {
        const wasOff = m.camera === 'off';
        m.camera = 'on';
        if (wasOff) scheduleIdleCheck(ws.userId, ws.deviceId);
      }
    };

    ws.on('message', (raw, isBinary) => {
      // Binary frames = screen/camera/screenshot JPEGs — relay only to
      // browsers of the same account watching this device. Zero parsing
      // beyond the 1-byte type marker.
      if (isBinary) {
        if (ws.authed && ws.role === 'phone') {
          const marker = raw[0];
          const live = marker === 0x01 || marker === 0x02;
          if (live) syncMediaFromFrame(marker);
          // Per-hop flow control: the phone keeps at most FRAME_WINDOW screen
          // frames unacknowledged, so frames can't pile up in its TCP buffer
          // during a network spike and play back late.
          if (marker === 0x01 && ws.caps?.includes('frame_ack')) ws.send(FRAME_ACK);
          const now = Date.now();
          watchers().forEach((b) => {
            if (b.readyState !== 1) return;
            // Screen (0x01) and camera (0x02) frames only go to tabs that asked
            // for them; screenshots (0x03) go to every watcher (MCP included).
            if (marker === 0x01 && !b.wantsStream) return;
            if (marker === 0x02 && !b.wantsCamera) return;
            if (live) {
              // Live frames are disposable: a frame that would have to wait
              // behind older ones is dropped, never queued.
              if (b.frameAck) {
                const f = b.frames || (b.frames = { 1: { n: 0, at: 0 }, 2: { n: 0, at: 0 } });
                const s = f[marker];
                if (s.n >= FRAME_WINDOW && now - s.at < FRAME_ACK_STALL_MS) return;
                if (s.n >= FRAME_WINDOW) s.n = 0; // acks lost (tab froze/reloaded) — start over
                s.n++;
                s.at = now;
              } else if ((b.bufferedAmount || 0) > 128 * 1024) {
                return;
              }
            }
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

            // A phone sends MORE THAN ONE register over the SAME socket: the
            // background service registers first (agent=service, caps, true
            // screen metrics), then the Flutter UI registers again over that
            // same connection with none of it. Treating the later, weaker
            // register as authoritative silently erased everything the service
            // said — caps went to [], so every capability tool reported "this
            // build is too old" one second after the build had announced all
            // seven, and the app's nav-bar-excluded height replaced the real
            // one, skewing tap coordinates. So merge: a register may add
            // information, never take it away.
            const wasService = ws.agent === 'service';
            if (msg.agent) ws.agent = msg.agent;
            if (Array.isArray(msg.caps) && msg.caps.length) ws.caps = msg.caps;
            if (!Array.isArray(ws.caps)) ws.caps = [];

            // Screen metrics: the background service reads the true display
            // bounds; the Flutter UI reports its own window, which excludes the
            // navigation bar. Once the service has spoken, don't let the UI
            // overwrite it.
            if (msg.agent === 'service' || !wasService) {
              ws.screenW = msg.screenW || ws.screenW || 1080;
              ws.screenH = msg.screenH || ws.screenH || 1920;
              ws.model = msg.model || ws.model || 'Android Device';
              ws.deviceName = msg.deviceName || ws.deviceName || ws.model;
            }

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

              // Re-resolve the account instead of using the one captured
              // before this await. cleanupAcct drops an account the moment it
              // has no phones and no browsers, which is exactly how it looks
              // while we sit in this DB call: any socket closing in that gap
              // deletes it from the map. Registering into the captured object
              // would then file this socket under a ghost account nobody can
              // look up — the socket stays open and healthy, but it is
              // invisible to every lookup, so relays silently go nowhere and
              // the device reads as offline while it is plainly connected.
              const acc = acct(ws.userId);

              // Pool this socket. The same device legitimately holds several
              // live connections (app UI + background service) — never close
              // the others. Primary selection: the background SERVICE socket
              // owns all control/file/camera handling, so a service socket
              // always outranks the app's socket, and a newly-registered
              // service socket takes over immediately (its registration just
              // proved it's alive — no waiting for the heartbeat to clear a
              // dead predecessor).
              let pool = acc.phonePool.get(ws.deviceId);
              if (!pool) { pool = new Set(); acc.phonePool.set(ws.deviceId, pool); }
              pool.add(ws);
              const cur = acc.phones.get(ws.deviceId);
              const curAlive = cur && cur.readyState === 1;
              if (ws.agent === 'service' || !curAlive) acc.phones.set(ws.deviceId, ws);
              // The background service keeps ONE socket; a new one means it
              // reconnected (usually a network switch) and has abandoned the
              // old one. Drop those now instead of waiting ~30s for the
              // heartbeat — messages must not keep landing on a dead socket.
              if (ws.agent === 'service') {
                for (const old of pool) {
                  if (old !== ws && old.agent === 'service') {
                    pool.delete(old);
                    try { old.terminate(); } catch (_) {}
                  }
                }
              }

              // The Flutter UI re-registers over the same socket. Announcing
              // again would make every watching tab treat it as a reconnect
              // and re-send stream_start, restarting capture on the phone.
              if (ws.announced) return;
              ws.announced = true;

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
              bcast([...acc.browsers], { type: 'device_online', deviceId: ws.deviceId, name: ws.deviceName, model: ws.model });
              console.log(`📱 Phone connected  user=${ws.userId.slice(0, 8)} device=${ws.deviceId.slice(0, 8)} agent=${ws.agent || 'app'} (${ws.model}, ${ws.screenW}×${ws.screenH}) caps=[${ws.caps.join(',') || 'none'}]`);
              // A phone re-registering mid-stream almost always means its network
              // changed (Wi-Fi ↔ cellular). Its WebRTC peers survive but their
              // network path is dead: tell those tabs to ICE-restart right away
              // instead of waiting for WebRTC's own timeouts.
              for (const b of ICE_RESTART_HINT ? viewersOf(acc, ws.deviceId) : []) {
                for (const [kind, k] of Object.entries(RTC_KINDS)) {
                  if (ws.caps.includes(k.cap) && (b[k.ready] || b[k.offered] || b[k.probing])) {
                    b.send(j({ type: 'rtc_restart', kind }));
                  }
                }
              }
            }).catch((e) => console.error('register device check failed:', e.message));
          } else {
            const prevWatch = ws.watchId;
            ws.watchId = msg.deviceId || null;
            // This tab acks every live frame it receives (`fa`).
            ws.frameAck = msg.frameAck === true;
            ws.frames = null;
            if (prevWatch !== ws.watchId) {
              ws.wantsStream = false;
              ws.wantsCamera = false;
              if (prevWatch) {
                closeTabRtc(ws, prevWatch);
                updateScreenMode(ws.userId, prevWatch);
                updateCameraMode(ws.userId, prevWatch);
                cancelOwnedDownloads(a, ws, prevWatch);
                scheduleIdleCheck(ws.userId, prevWatch);
              }
            }
            a.browsers.add(ws);
            const p = livePhone(a, ws.watchId);
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
            ws.send(j({ type: 'rtc_config', iceServers: iceServers(ws.userId) }));
          }
          break;
        }

        // ── WebRTC (screen and camera): tab offers, phone answers ─────────
        // One peer per tab per kind (`kind` defaults to screen for older
        // pages/builds). Media goes peer-to-peer, or through our coturn relay
        // when a direct path is blocked; only this negotiation goes through
        // us. The offer carries fresh ICE servers (incl. TURN credentials) for
        // the phone. If WebRTC can't connect at all, the tab stays on JPEG.
        case 'rtc_offer':
        case 'rtc_ice': {
          const kind = rtcKind(msg.kind);
          if (ws.role === 'browser') {
            const phone = ws.watchId && getPhoneSocket(ws.userId, ws.watchId, RTC_KINDS[kind].cap);
            if (!phone) {
              if (msg.type === 'rtc_offer') ws.send(j({ type: 'rtc_unsupported', kind }));
              break;
            }
            phone.send(j({
              type: msg.type, kind, from: ws.id, sdp: msg.sdp, candidate: msg.candidate,
              restart: msg.type === 'rtc_offer' && msg.restart ? true : undefined,
              iceServers: msg.type === 'rtc_offer' ? iceServers(ws.userId) : undefined,
            }));
            // An ICE restart renegotiates an existing peer: its mode flags stay
            // as set by rtc_recovering / rtc_ready.
            if (msg.type === 'rtc_offer' && !msg.restart) {
              ws[RTC_KINDS[kind].offered] = !msg.probe;
              ws[RTC_KINDS[kind].probing] = !!msg.probe;
              updateRtcMode(kind, ws.userId, ws.watchId);
            }
          } else if (ws.role === 'phone' && msg.type === 'rtc_ice') {
            sendToTab(msg.to, { type: 'rtc_ice', kind, candidate: msg.candidate });
          }
          break;
        }
        case 'rtc_answer':
        case 'rtc_error':
          if (ws.role === 'phone') sendToTab(msg.to, { type: msg.type, kind: rtcKind(msg.kind), sdp: msg.sdp, reason: msg.reason });
          break;
        // Diagnostics from the browser's WebRTC client (useRtcStream.js).
        case 'rtc_trace': {
          if (ws.role !== 'browser') return;
          const ev = String(msg.event || '').slice(0, 40);
          const detail = msg.detail ? ` ${String(msg.detail).slice(0, 200)}` : '';
          console.log(`🧭 rtc ${rtcKind(msg.kind)} ${ev}${detail} tab=${String(ws.id).slice(0, 6)} device=${(ws.watchId || '').slice(0, 8)}`);
          break;
        }
        // The tab's peer lost its network path and is ICE-restarting: treat it
        // like a probe (phone shows JPEG meanwhile) until rtc_ready.
        case 'rtc_recovering': {
          if (ws.role !== 'browser' || !ws.watchId) return;
          const kind = rtcKind(msg.kind);
          const k = RTC_KINDS[kind];
          ws[k.ready] = false;
          ws[k.offered] = false;
          ws[k.probing] = true;
          updateRtcMode(kind, ws.userId, ws.watchId);
          console.log(`🔁 WebRTC ${kind} recovering (ICE restart) user=${ws.userId.slice(0, 8)} device=${ws.watchId.slice(0, 8)}`);
          break;
        }
        case 'rtc_ready':
        case 'rtc_failed': {
          if (ws.role !== 'browser' || !ws.watchId) return;
          const kind = rtcKind(msg.kind);
          if (msg.type === 'rtc_ready') ws[RTC_KINDS[kind].ready] = true;
          else closeTabRtc(ws, ws.watchId, kind);
          updateRtcMode(kind, ws.userId, ws.watchId);
          console.log(`🔗 WebRTC ${kind} ${msg.type === 'rtc_ready' ? 'connected' : 'failed (tab retries)'} user=${ws.userId.slice(0, 8)} device=${ws.watchId.slice(0, 8)}`);
          break;
        }

        // ── JPEG frame fallback (legacy JSON path) ────────────────────────
        case 'frame':
          relayToWatchers({ type: 'frame', data: msg.data, w: msg.w, h: msg.h });
          break;
        case 'camera_frame':
          relayToWatchers({ type: 'camera_frame', data: msg.data });
          break;

        // ── Phone → watchers status events ────────────────────────────────
        case 'stream_started': {
          if (ws.role !== 'phone') return;
          const a = acct(ws.userId);
          const m = mediaState(a, ws.deviceId);
          m.stream = 'on';
          m.streamOnAt = Date.now();
          relayToWatchers({ type: 'stream_started' });
          scheduleIdleCheck(ws.userId, ws.deviceId);
          // Also sent on phone reconnect: re-state the mode so both sides agree.
          updateScreenMode(ws.userId, ws.deviceId, true);
          break;
        }
        case 'stream_stopped':
        case 'stream_error': {
          if (ws.role !== 'phone') return;
          const a = acct(ws.userId);
          const m = mediaState(a, ws.deviceId);
          const now = Date.now();
          // A stop→start in quick succession: the phone's reply to the stop
          // arrives after the browser already asked to start again. Passing
          // it on would kill the stream the user just restarted.
          const staleStop = msg.type === 'stream_stopped' && m.streamStopAt && (
            (m.stream === 'starting' && m.streamAt >= m.streamStopAt) ||
            (m.stream === 'on' && m.streamAt >= m.streamStopAt && now - m.streamOnAt < 2000)
          );
          if (staleStop) break;
          m.stream = 'off';
          m.streamStopAt = now;
          m.rtcMode = false;
          viewersOf(a, ws.deviceId).forEach((b) => { b.wantsStream = false; b.rtcReady = false; b.rtcOffered = false; b.rtcProbing = false; });
          relayToWatchers(msg.type === 'stream_error'
            ? { type: 'stream_error', reason: msg.reason || 'failed' }
            : { type: 'stream_stopped' });
          break;
        }
        case 'camera_streaming': {
          if (ws.role !== 'phone') return;
          const m = mediaState(acct(ws.userId), ws.deviceId);
          m.camera = 'on';
          if (typeof msg.front === 'boolean') m.cameraFront = msg.front;
          relayToWatchers({ type: 'camera_streaming', front: m.cameraFront });
          scheduleIdleCheck(ws.userId, ws.deviceId);
          // Also sent on (re)start and phone reconnect: re-state the mode.
          updateCameraMode(ws.userId, ws.deviceId, true);
          break;
        }
        case 'camera_stopped':
        case 'camera_error': {
          if (ws.role !== 'phone') return;
          const a = acct(ws.userId);
          const m = mediaState(a, ws.deviceId);
          m.camera = 'off';
          m.cameraStopAt = Date.now();
          m.camRtcMode = false;
          viewersOf(a, ws.deviceId).forEach((b) => { b.wantsCamera = false; b.camRtcReady = false; b.camRtcOffered = false; b.camRtcProbing = false; });
          relayToWatchers(msg.type === 'camera_error'
            ? { type: 'camera_error', reason: msg.reason }
            : { type: 'camera_stopped' });
          break;
        }
        case 'screenshot_error': {
          const errMsg = { type: 'screenshot_error', reason: msg.reason };
          relayToWatchers(errMsg);
          acct(ws.userId).mcpErrorListeners?.forEach((fn) => fn(errMsg));
          break;
        }

        // ── Browser → phone: screen stream (shared, ref-counted) ─────────
        case 'stream_start': {
          if (ws.role !== 'browser' || !ws.watchId) return;
          ws.wantsStream = true;
          // A fresh viewer starts on JPEG until its own WebRTC peer connects.
          closeTabRtc(ws, ws.watchId, 'screen');
          updateScreenMode(ws.userId, ws.watchId);
          const m = mediaState(acct(ws.userId), ws.watchId);
          if (m.stream === 'on') {
            ws.send(j({ type: 'stream_started' }));
            break;
          }
          if (m.stream === 'starting' && Date.now() - m.streamAt < START_PENDING_MS) break;
          const phone = myPhone();
          if (!phone) {
            ws.send(j({ type: 'stream_error', reason: 'phone_offline' }));
            break;
          }
          m.stream = 'starting';
          m.streamAt = Date.now();
          phone.send(j({ type: 'stream_start' }));
          break;
        }
        case 'stream_stop': {
          if (ws.role !== 'browser' || !ws.watchId) return;
          ws.wantsStream = false;
          closeTabRtc(ws, ws.watchId, 'screen');
          updateScreenMode(ws.userId, ws.watchId);
          const a = acct(ws.userId);
          const others = viewersOf(a, ws.watchId).some((b) => b !== ws && b.wantsStream);
          if (!others) {
            const m = mediaState(a, ws.watchId);
            m.stream = 'off';
            m.streamStopAt = Date.now();
            relayToPhone({ type: 'stream_stop' });
          }
          // Confirm to this tab right away — the phone's own reply goes to
          // everyone, and may never come if the phone is offline.
          if (others || !myPhone()) ws.send(j({ type: 'stream_stopped' }));
          break;
        }

        // ── Browser → phone: camera (shared, ref-counted) ─────────────────
        case 'camera_start': {
          if (ws.role !== 'browser' || !ws.watchId) return;
          ws.wantsCamera = true;
          // A fresh viewer starts on JPEG until its own WebRTC peer connects.
          closeTabRtc(ws, ws.watchId, 'camera');
          updateCameraMode(ws.userId, ws.watchId);
          const front = msg.front ?? true;
          const m = mediaState(acct(ws.userId), ws.watchId);
          if (m.camera === 'on' && m.cameraFront === front) {
            ws.send(j({ type: 'camera_streaming', front }));
            break;
          }
          if (m.camera === 'starting' && m.cameraFront === front && Date.now() - m.cameraAt < START_PENDING_MS) break;
          if (!myPhone()) {
            ws.send(j({ type: 'camera_error', reason: 'phone_offline' }));
            break;
          }
          m.camera = 'starting';
          m.cameraAt = Date.now();
          m.cameraFront = front;
          relayToPhone({ type: 'camera_start', front });
          break;
        }
        case 'camera_stop': {
          if (ws.role !== 'browser' || !ws.watchId) return;
          ws.wantsCamera = false;
          closeTabRtc(ws, ws.watchId, 'camera');
          updateCameraMode(ws.userId, ws.watchId);
          const a = acct(ws.userId);
          const others = viewersOf(a, ws.watchId).some((b) => b !== ws && b.wantsCamera);
          if (!others) {
            const m = mediaState(a, ws.watchId);
            m.camera = 'off';
            m.cameraStopAt = Date.now();
            relayToPhone({ type: 'camera_stop' });
          }
          if (others || !myPhone()) ws.send(j({ type: 'camera_stopped' }));
          break;
        }
        case 'camera_flip': {
          if (ws.role !== 'browser' || !ws.watchId) return;
          const m = mediaState(acct(ws.userId), ws.watchId);
          m.cameraFront = !m.cameraFront;
          relayToPhone({ type: 'camera_flip' });
          break;
        }

        // ── Browser → phone commands ──────────────────────────────────────
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
        case 'pf_download':
          if (ws.role === 'browser' && msg.id) {
            const a = acct(ws.userId);
            a.downloadOwners.set(msg.id, ws);
            (ws.downloads ||= new Set()).add(msg.id);
          }
          relayToPhone(msg);
          break;
        case 'pf_download_cancel':
          if (ws.role === 'browser' && msg.id) {
            acct(ws.userId).downloadOwners.delete(msg.id);
            ws.downloads?.delete(msg.id);
          }
          relayToPhone(msg);
          break;
        case 'pf_list':
        case 'pf_delete':
        case 'pf_upload_start':
        case 'pf_upload_chunk':
        case 'pf_upload_cancel':
          relayToPhone(msg);
          break;
        case 'pf_list_result':
        case 'pf_upload_ok':
        case 'pf_upload_chunk_ack':
        case 'pf_delete_ok':
        case 'open_app_result':
        case 'pf_error': {
          if (msg.type === 'pf_error' && msg.id) {
            const a = acct(ws.userId);
            a.downloadOwners.get(msg.id)?.downloads?.delete(msg.id);
            a.downloadOwners.delete(msg.id);
          }
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
        // Phone confirming a control command actually executed, and device
        // status snapshots. Both are answers to a specific MCP tool call — no
        // browser cares, so resolve the waiter and don't broadcast.
        case 'control_ack':
        case 'device_status_result':
        case 'ui_tree_result':
        case 'list_apps_result':
        case 'open_url_result':
        case 'uninstall_app_result':
        case 'open_app_settings_result':
        case 'open_settings_result':
        case 'open_file_result':
        case 'notifications_result': {
          if (ws.role !== 'phone') return;
          const waiting = pendingHttpRequests.get(msg.id);
          if (waiting) {
            pendingHttpRequests.delete(msg.id);
            waiting.resolve(msg);
          }
          break;
        }
        case 'pf_chunk': {
          if (ws.role !== 'phone') return;
          if (msg.done) {
            const a = acct(ws.userId);
            a.downloadOwners.get(msg.id)?.downloads?.delete(msg.id);
            a.downloadOwners.delete(msg.id);
          }
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

        case 'get_location': {
          if (ws.role === 'browser' && ws.watchId) {
            const loc = acct(ws.userId).lastLocation.get(ws.watchId);
            if (loc) ws.send(j(loc));
          }
          break;
        }

        // ── Remote control (browser → phone) ─────────────────────────────
        case 'control': {
          let action = msg.action;
          let keycode = msg.keycode;
          let value = msg.value !== undefined ? msg.value : msg.text;

          if (action === 'press_key' && msg.key) {
            const keyMap = {
              back: { action: 'back', keycode: 'KEYCODE_BACK' },
              home: { action: 'home', keycode: 'KEYCODE_HOME' },
              recents: { action: 'recents', keycode: 'KEYCODE_APP_SWITCH' },
              lock: { action: 'keyevent', keycode: 'KEYCODE_POWER' },
              power: { action: 'keyevent', keycode: 'KEYCODE_POWER' },
              volume_up: { action: 'keyevent', keycode: 'KEYCODE_VOLUME_UP' },
              vol_up: { action: 'keyevent', keycode: 'KEYCODE_VOLUME_UP' },
              volume_down: { action: 'keyevent', keycode: 'KEYCODE_VOLUME_DOWN' },
              vol_down: { action: 'keyevent', keycode: 'KEYCODE_VOLUME_DOWN' },
              enter: { action: 'keyevent', keycode: 'KEYCODE_ENTER' },
              delete: { action: 'keyevent', keycode: 'KEYCODE_DEL' },
              backspace: { action: 'keyevent', keycode: 'KEYCODE_DEL' },
            };
            const mapped = keyMap[msg.key];
            if (mapped) {
              action = mapped.action;
              keycode = mapped.keycode;
            }
          } else if (action === 'type_text') {
            action = msg.method === 'paste' ? 'paste' : 'text';
            value = msg.text !== undefined ? msg.text : msg.value;
          }

          relayToPhone({
            type: 'control',
            action,
            // Pass all possible args — phone ignores what it doesn't need
            x: msg.x, y: msg.y,
            x1: msg.x1, y1: msg.y1,
            x2: msg.x2, y2: msg.y2,
            dx: msg.dx, dy: msg.dy,
            ms: msg.ms,
            keycode,
            value,
          });

          if (msg.action === 'type_text' && msg.submit) {
            setTimeout(() => {
              relayToPhone({
                type: 'control',
                action: 'keyevent',
                keycode: 'KEYCODE_ENTER',
              });
            }, 150);
          }
          break;
        }

        case 'ping':
          ws.send(j({ type: 'pong' }));
          break;
        case 'fa': {
          const s = ws.frames?.[msg.k === 2 ? 2 : 1];
          if (s && s.n > 0) s.n--;
          break;
        }
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
            // Capture state is unknown until the phone is back; the app
            // reports any capture still running when it re-registers, and
            // watchers keep their wantsStream/wantsCamera so they re-claim it.
            const m = a.media.get(ws.deviceId);
            if (m) { m.stream = 'off'; m.camera = 'off'; m.streamStopAt = 0; m.cameraStopAt = 0; m.rtcMode = false; m.camRtcMode = false; }
            for (const [id, owner] of a.downloadOwners) {
              if (owner.watchId === ws.deviceId) { owner.downloads?.delete(id); a.downloadOwners.delete(id); }
            }
            bcast(watchers(), { type: 'phone_disconnected', deviceId: ws.deviceId });
            bcast([...a.browsers], { type: 'device_offline', deviceId: ws.deviceId });
            db.touchDevice(ws.deviceId).catch(() => {});
            console.log(`📱 Phone disconnected user=${ws.userId.slice(0, 8)} device=${ws.deviceId.slice(0, 8)}`);
          }
        }
      } else if (ws.role === 'browser') {
        a.browsers.delete(ws);
        cancelOwnedDownloads(a, ws);
        if (ws.watchId) {
          closeTabRtc(ws);
          updateScreenMode(ws.userId, ws.watchId);
          updateCameraMode(ws.userId, ws.watchId);
        }
        if (ws.watchId && (ws.wantsStream || ws.wantsCamera)) scheduleIdleCheck(ws.userId, ws.watchId);
      }
      cleanupAcct(ws.userId);
    });
  });

  // HTTP fast-path for control commands (lower latency than WS for tiny messages)
  if (app) {
    app.post('/api/control', requireAuth, (req, res) => {
      const { deviceId, ...cmd } = req.body || {};
      const phone = livePhone(accounts.get(req.userId), deviceId);
      if (!phone) return res.status(503).json({ error: 'Phone not connected' });
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
  sendToPhone, controlPhone, deviceSupports,
  getLastLocation, getDeviceScreenSize, requestFromPhone, captureScreenshot, uploadToPhone, downloadFromPhone,
};
