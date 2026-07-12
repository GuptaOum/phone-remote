const express = require('express');
const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const db = require('../services/db');
const { verifyToken } = require('../middleware/auth');
const signaling = require('../services/signaling');

/**
 * MCP server — Streamable HTTP transport (2025-06-18), single-JSON-response
 * mode (no SSE): the client POSTs one JSON-RPC message, gets one JSON-RPC
 * reply. That's all Claude's remote connector needs for request/response
 * tool calls; no server-side session state is required since we don't do
 * sampling, roots, or long-lived subscriptions.
 *
 * Auth: every request needs `Authorization: Bearer <token>` — the same JWT
 * issued by /oauth/token (or, for convenience while testing, by /api/login).
 * A 401 without a valid token points the client at the protected-resource
 * metadata per RFC 9728, so a compliant MCP client can find its way to the
 * authorization server on its own.
 *
 * All the "advanced" navigation tools (scroll, long_press, open_app_drawer,
 * the rich press_key set, and the `screenshot: true` act-and-see option) are
 * composed entirely from the phone's existing control primitives — no APK
 * change is needed. See RemoteAccessibilityService.pressKey for the keycodes.
 */

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_VERSION = '1.3.0';

// send_file: JSON body limit is 25 MB (index.js) and base64 inflates ~4/3,
// so cap the decoded payload safely below that.
const MAX_SEND_FILE_BYTES = 18 * 1024 * 1024;

// send_local_file: one-time upload URLs. The tool call reserves a token, the
// MCP client then POSTs the raw file bytes to /mcp/upload/<token> — the file
// never has to be base64'd through the model's context window.
const UPLOAD_TTL_MS = 10 * 60 * 1000;
const pendingUploads = new Map(); // token → { userId, deviceId, dest, expiresAt }
function pruneUploads() {
  const now = Date.now();
  for (const [token, u] of pendingUploads) if (u.expiresAt < now) pendingUploads.delete(token);
}

// Named keys → the KEYCODE_* strings the phone's pressKey() already handles.
const KEY_MAP = {
  back: 'KEYCODE_BACK',
  home: 'KEYCODE_HOME',
  recents: 'KEYCODE_APP_SWITCH',
  enter: 'KEYCODE_ENTER',            // submits/newlines in the focused text field
  delete: 'KEYCODE_DEL',             // backspace in the focused text field
  notifications: 'KEYCODE_NOTIFICATION',
  quick_settings: 'KEYCODE_QUICK_SETTINGS',
  lock: 'KEYCODE_POWER',             // GLOBAL_ACTION_LOCK_SCREEN
  volume_up: 'KEYCODE_VOLUME_UP',
  volume_down: 'KEYCODE_VOLUME_DOWN',
};
const KEY_NAMES = Object.keys(KEY_MAP);

// How long to let the UI settle before the auto-screenshot in act-and-see calls.
const SCREENSHOT_SETTLE_MS = 850;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TOOLS = [
  {
    name: 'list_devices',
    description: 'List the Android phones linked to this account, with online/offline status and (when online) live screen resolution.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_location',
    description: 'Get the most recent known GPS location of a device. Returns the cached last fix — may be a few minutes old.',
    inputSchema: {
      type: 'object',
      properties: { deviceId: { type: 'string', description: 'Device id from list_devices' } },
      required: ['deviceId'],
    },
  },
  {
    name: 'take_screenshot',
    description: 'Capture and return the current screen of a device as a JPEG image. Requires the phone\'s Accessibility Service to be enabled. Call this first to see the screen before tapping.',
    inputSchema: {
      type: 'object',
      properties: { deviceId: { type: 'string', description: 'Device id from list_devices' } },
      required: ['deviceId'],
    },
  },
  {
    name: 'tap',
    description: 'Tap the screen at a point. Coordinates are normalized 0.0-1.0 (fraction of screen width/height), not pixels — e.g. x=0.5, y=0.5 is the center. Set screenshot:true to get a fresh screenshot back after the tap so you can see the result in one call.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string' },
        x: { type: 'number', minimum: 0, maximum: 1, description: 'Horizontal position, 0 = left edge, 1 = right edge' },
        y: { type: 'number', minimum: 0, maximum: 1, description: 'Vertical position, 0 = top edge, 1 = bottom edge' },
        screenshot: { type: 'boolean', description: 'If true, return a fresh screenshot of the screen after tapping (default false)' },
      },
      required: ['deviceId', 'x', 'y'],
    },
  },
  {
    name: 'long_press',
    description: 'Press and hold at a point — opens context menus, enters selection/edit mode, moves icons. Coordinates are normalized 0.0-1.0.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string' },
        x: { type: 'number', minimum: 0, maximum: 1 },
        y: { type: 'number', minimum: 0, maximum: 1 },
        ms: { type: 'integer', minimum: 400, maximum: 3000, description: 'Hold duration in ms (default 700)' },
        screenshot: { type: 'boolean', description: 'Return a fresh screenshot afterwards (default false)' },
      },
      required: ['deviceId', 'x', 'y'],
    },
  },
  {
    name: 'swipe',
    description: 'Swipe from one point to another with precise coordinates (normalized 0.0-1.0). For simple list/page navigation prefer the `scroll` tool instead.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string' },
        x1: { type: 'number', minimum: 0, maximum: 1 },
        y1: { type: 'number', minimum: 0, maximum: 1 },
        x2: { type: 'number', minimum: 0, maximum: 1 },
        y2: { type: 'number', minimum: 0, maximum: 1 },
        ms: { type: 'integer', minimum: 50, maximum: 5000, description: 'Swipe duration in milliseconds (default 300)' },
        screenshot: { type: 'boolean', description: 'Return a fresh screenshot afterwards (default false)' },
      },
      required: ['deviceId', 'x1', 'y1', 'x2', 'y2'],
    },
  },
  {
    name: 'scroll',
    description: 'Scroll the screen in a direction — the easy way to move through lists, feeds, and home-screen pages. direction is where the CONTENT moves: "down" reveals content further down the page, "up" goes back up, "left"/"right" flip pages.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount: { type: 'number', minimum: 0.1, maximum: 0.9, description: 'Fraction of the screen to travel (default 0.6). Larger = scrolls further.' },
        screenshot: { type: 'boolean', description: 'Return a fresh screenshot afterwards (default false)' },
      },
      required: ['deviceId', 'direction'],
    },
  },
  {
    name: 'type_text',
    description: 'Type text into the currently focused input field (tap the field first). Set submit:true to press Enter after typing — use this to run a search once the query is typed.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string' },
        text: { type: 'string' },
        submit: { type: 'boolean', description: 'Press Enter after typing, e.g. to execute a search (default false)' },
        screenshot: { type: 'boolean', description: 'Return a fresh screenshot afterwards (default false)' },
      },
      required: ['deviceId', 'text'],
    },
  },
  {
    name: 'press_key',
    description: 'Press a system key or button. back/home/recents navigate; enter submits and delete backspaces in a focused text field; notifications/quick_settings open those shades; lock locks the screen; volume_up/volume_down change media volume.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string' },
        key: { type: 'string', enum: KEY_NAMES },
        screenshot: { type: 'boolean', description: 'Return a fresh screenshot afterwards (default false)' },
      },
      required: ['deviceId', 'key'],
    },
  },
  {
    name: 'open_app',
    description: 'Open an app on the device by name (e.g. "YouTube", "Settings", "WhatsApp") — matched against installed apps by label — or by exact package name. This is the fastest way to launch an app; prefer it over hunting through the app drawer.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string' },
        name: { type: 'string', description: 'App name to search for, e.g. "YouTube". Case-insensitive, matches partial names.' },
        package: { type: 'string', description: 'Exact package name (e.g. com.google.android.youtube), if you know it — overrides name.' },
        screenshot: { type: 'boolean', description: 'Return a screenshot after launching (default true)' },
      },
      required: ['deviceId'],
    },
  },
  {
    name: 'open_app_drawer',
    description: 'Go to the home screen and open the app drawer (swipe up from the bottom), where the app search bar lives. Follow with take_screenshot, then tap the search bar and type an app name to find and open any app.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string' },
        screenshot: { type: 'boolean', description: 'Return a fresh screenshot afterwards (default true)' },
      },
      required: ['deviceId'],
    },
  },
  {
    name: 'wait',
    description: 'Pause for a few seconds to let the screen finish loading or animating before the next action.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string' },
        seconds: { type: 'number', minimum: 0.2, maximum: 15, description: 'How long to wait (default 1.5)' },
        screenshot: { type: 'boolean', description: 'Return a screenshot after waiting (default false)' },
      },
      required: ['deviceId'],
    },
  },
  {
    name: 'ring',
    description: 'Play a ringtone on the device at full volume, even in silent mode — useful for locating a lost phone.',
    inputSchema: {
      type: 'object',
      properties: { deviceId: { type: 'string' } },
      required: ['deviceId'],
    },
  },
  {
    name: 'flash_light',
    description: 'Blink the device\'s camera flash a few times.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string' },
        count: { type: 'integer', minimum: 1, maximum: 10, description: 'Number of blinks (default 3)' },
      },
      required: ['deviceId'],
    },
  },
  {
    name: 'list_files',
    description: 'List files and folders in a directory of the device\'s shared storage. Browsing is confined to /storage/emulated/0 (the Android storage root) and its subfolders; paths outside it are clamped to the root.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string' },
        path: { type: 'string', description: 'Absolute path under /storage/emulated/0 (defaults to the root)' },
      },
      required: ['deviceId'],
    },
  },
  {
    name: 'send_local_file',
    description: 'Send a file from the computer where the MCP client runs (any local file path the user gives) to the phone — the right tool for files on disk, no base64 needed. Step 1: call this tool with the destination file name (and optional folder); it returns a one-time upload_url. Step 2: upload the raw bytes from the shell, e.g. `curl -sS -X POST -H "Content-Type: application/octet-stream" --data-binary @"/path/to/file" "<upload_url>"`. The curl response confirms the file was saved to /storage/emulated/0/<folder>/<name> on the phone. The URL works once, within 10 minutes. Max 18 MB.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string' },
        name: { type: 'string', description: 'File name to save as on the phone, e.g. "photo.png"' },
        folder: { type: 'string', description: 'Destination folder under /storage/emulated/0 (default "Download")' },
      },
      required: ['deviceId', 'name'],
    },
  },
  {
    name: 'send_file',
    description: 'Send a small file to the device\'s shared storage with the content passed inline as base64. Saves to /storage/emulated/0/<folder>/<name> (folder defaults to Download). Max 18 MB — but for any file that exists on disk, prefer send_local_file (streams the bytes directly instead of routing base64 through the conversation).',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string' },
        name: { type: 'string', description: 'File name to save as, e.g. "photo.png"' },
        data_base64: { type: 'string', description: 'File content, base64-encoded' },
        folder: { type: 'string', description: 'Destination folder under /storage/emulated/0 (default "Download")' },
      },
      required: ['deviceId', 'name', 'data_base64'],
    },
  },
  {
    name: 'send_url',
    description: 'Download a file from a public http(s) URL and save it to the phone. The server fetches the bytes itself — they never pass through this conversation — so this is the cheapest way to put an online image or file on the phone (no base64, no tokens for the content). Saves to /storage/emulated/0/<folder>/<name>. Max 18 MB.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string' },
        url: { type: 'string', description: 'Public http(s) URL of the file to download' },
        name: { type: 'string', description: 'File name to save as on the phone (defaults to the name from the URL)' },
        folder: { type: 'string', description: 'Destination folder under /storage/emulated/0 (default "Download")' },
      },
      required: ['deviceId', 'url'],
    },
  },
];

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text: typeof text === 'string' ? text : JSON.stringify(text, null, 2) }], isError };
}

function imageResult(jpeg) {
  return { content: [{ type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg' }] };
}

// Append a fresh screenshot to a result when the caller asked for act-and-see.
async function maybeScreenshot(userId, deviceId, baseResult, want) {
  if (!want || baseResult.isError) return baseResult;
  await sleep(SCREENSHOT_SETTLE_MS);
  try {
    const jpeg = await signaling.captureScreenshot(userId, deviceId);
    return { content: [...baseResult.content, { type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg' }], isError: false };
  } catch (e) {
    return { content: [...baseResult.content, { type: 'text', text: `(couldn't grab a screenshot afterwards: ${e.message})` }], isError: false };
  }
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Android shared-storage root. list_files is confined here — resolve . / ..
// and snap anything above/outside back to the base, so the file tool can't
// wander into system directories. Mirrors the browser's confineToBase().
const PHONE_BASE = '/storage/emulated/0';
function confineToBase(path) {
  let raw = (path || PHONE_BASE).replace(/\\/g, '/').replace(/\/+/g, '/').trim();
  if (!raw.startsWith('/')) raw = '/' + raw;
  const parts = [];
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  const abs = '/' + parts.join('/');
  return (abs === PHONE_BASE || abs.startsWith(PHONE_BASE + '/')) ? abs : PHONE_BASE;
}

// ── send_url: SSRF-safe server-side download ────────────────────────────────
// Fetching an arbitrary URL server-side is dangerous — it could hit the EC2
// instance-metadata endpoint (169.254.169.254 → IAM creds) or internal hosts.
// We validate the *connect* IP (not just the hostname) so DNS rebinding can't
// slip a public name that resolves to a private address past us.

function isBlockedIp(ip) {
  if (net.isIPv4(ip)) {
    const n = ip.split('.').reduce((a, o) => ((a << 8) + (+o)) >>> 0, 0);
    const inRange = (base, bits) => {
      const b = base.split('.').reduce((a, o) => ((a << 8) + (+o)) >>> 0, 0);
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) === (b & mask);
    };
    return inRange('0.0.0.0', 8) || inRange('10.0.0.0', 8) || inRange('100.64.0.0', 10) ||
           inRange('127.0.0.0', 8) || inRange('169.254.0.0', 16) || inRange('172.16.0.0', 12) ||
           inRange('192.168.0.0', 16) || inRange('192.0.0.0', 24) || inRange('198.18.0.0', 15);
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::') return true;
    if (l.startsWith('fe80') || l.startsWith('fc') || l.startsWith('fd')) return true; // link-local / unique-local
    const m = l.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped
    if (m) return isBlockedIp(m[1]);
    return false;
  }
  return true; // unparseable → block
}

// Custom DNS resolver used as the socket `lookup` — the address it returns is
// the one Node actually connects to, so validating here blocks rebinding.
function safeLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  dns.lookup(hostname, { all: true, family: options.family || 0 }, (err, addresses) => {
    if (err) return callback(err);
    const safe = addresses.filter((a) => !isBlockedIp(a.address));
    if (!safe.length) return callback(new Error('Host resolves only to private/loopback addresses'));
    if (options.all) return callback(null, safe);
    callback(null, safe[0].address, safe[0].family);
  });
}

function downloadUrl(rawUrl, maxBytes, timeoutMs = 20000, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(rawUrl); } catch { return reject(new Error('Invalid URL')); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return reject(new Error('Only http(s) URLs are allowed'));
    // IP-literal hosts never hit the custom lookup (nothing to resolve), so
    // they must be checked here or 127.0.0.1 / 169.254.169.254 would slip past.
    if (net.isIP(url.hostname) && isBlockedIp(url.hostname)) {
      return reject(new Error('Refusing to fetch a private/loopback address'));
    }
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
      method: 'GET', lookup: safeLookup, timeout: timeoutMs,
      headers: { 'user-agent': 'PhoneRemote/1.0', accept: '*/*' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
        let next;
        try { next = new URL(res.headers.location, url).href; } catch { return reject(new Error('Bad redirect target')); }
        return resolve(downloadUrl(next, maxBytes, timeoutMs, redirectsLeft - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`Download failed: HTTP ${res.statusCode}`)); }
      const len = Number(res.headers['content-length'] || 0);
      if (len && len > maxBytes) { res.destroy(); return reject(new Error(`File is ${(len / 1048576).toFixed(1)} MB — max is ${maxBytes / 1048576} MB`)); }
      const chunks = []; let total = 0;
      res.on('data', (c) => {
        total += c.length;
        if (total > maxBytes) { res.destroy(); reject(new Error(`File exceeds the ${maxBytes / 1048576} MB limit`)); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        let base = '';
        try { base = decodeURIComponent(url.pathname.split('/').pop() || ''); } catch { base = url.pathname.split('/').pop() || ''; }
        resolve({ buffer: Buffer.concat(chunks), urlName: base });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Download timed out')));
    req.on('error', reject);
    req.end();
  });
}

// Directional scroll → a center-anchored swipe. direction = where content moves.
function scrollGesture(direction, amount) {
  const a = clamp(amount ?? 0.6, 0.1, 0.9);
  switch (direction) {
    case 'down':  return { x1: 0.5, y1: 0.75, x2: 0.5, y2: clamp(0.75 - a, 0.05, 0.95) };
    case 'up':    return { x1: 0.5, y1: 0.25, x2: 0.5, y2: clamp(0.25 + a, 0.05, 0.95) };
    case 'left':  return { x1: 0.75, y1: 0.5, x2: clamp(0.75 - a, 0.05, 0.95), y2: 0.5 };
    case 'right': return { x1: 0.25, y1: 0.5, x2: clamp(0.25 + a, 0.05, 0.95), y2: 0.5 };
    default: return null;
  }
}

async function callTool(userId, name, args = {}, ctx = {}) {
  const { deviceId } = args;
  const offline = () => textResult('Device is offline.', true);

  switch (name) {
    case 'list_devices': {
      const devices = await db.listDevices(userId);
      return textResult(devices.map((d) => {
        const online = signaling.presence.isOnline(userId, d.id);
        const size = online ? signaling.getDeviceScreenSize(userId, d.id) : null;
        return {
          deviceId: d.id, name: d.name, model: d.model, online,
          screenWidth: size?.screenW ?? null, screenHeight: size?.screenH ?? null,
          lastSeen: d.last_seen ? new Date(d.last_seen).toISOString() : null,
        };
      }));
    }

    case 'get_location': {
      const loc = signaling.getLastLocation(userId, deviceId);
      if (!loc) return textResult('No location has been reported for this device yet.', true);
      return textResult({ lat: loc.lat, lng: loc.lng, accuracy: loc.accuracy, altitude: loc.altitude, at: new Date(loc.timestamp).toISOString() });
    }

    case 'take_screenshot': {
      try {
        const jpeg = await signaling.captureScreenshot(userId, deviceId);
        return imageResult(jpeg);
      } catch (e) {
        return textResult(e.message, true);
      }
    }

    case 'tap': {
      if (!signaling.sendToPhone(userId, deviceId, { type: 'control', action: 'tap', x: args.x, y: args.y })) return offline();
      return maybeScreenshot(userId, deviceId, textResult(`Tapped (${args.x}, ${args.y}).`), args.screenshot);
    }

    case 'long_press': {
      const ms = clamp(args.ms ?? 700, 400, 3000);
      // A hold-in-place gesture: tiny 2px move over a long duration reads as a long press.
      const ok = signaling.sendToPhone(userId, deviceId, {
        type: 'control', action: 'swipe',
        x1: args.x, y1: args.y, x2: clamp(args.x + 0.002, 0, 1), y2: clamp(args.y + 0.002, 0, 1), ms,
      });
      if (!ok) return offline();
      return maybeScreenshot(userId, deviceId, textResult(`Long-pressed (${args.x}, ${args.y}) for ${ms}ms.`), args.screenshot);
    }

    case 'swipe': {
      const ok = signaling.sendToPhone(userId, deviceId, {
        type: 'control', action: 'swipe',
        x1: args.x1, y1: args.y1, x2: args.x2, y2: args.y2, ms: args.ms,
      });
      if (!ok) return offline();
      return maybeScreenshot(userId, deviceId, textResult('Swipe sent.'), args.screenshot);
    }

    case 'scroll': {
      const g = scrollGesture(args.direction, args.amount);
      if (!g) return textResult('direction must be up, down, left, or right.', true);
      const ok = signaling.sendToPhone(userId, deviceId, { type: 'control', action: 'swipe', ...g, ms: 260 });
      if (!ok) return offline();
      return maybeScreenshot(userId, deviceId, textResult(`Scrolled ${args.direction}.`), args.screenshot);
    }

    case 'type_text': {
      if (!signaling.sendToPhone(userId, deviceId, { type: 'control', action: 'text', value: args.text })) return offline();
      if (args.submit) {
        await sleep(150);
        signaling.sendToPhone(userId, deviceId, { type: 'control', action: 'keyevent', keycode: 'KEYCODE_ENTER' });
      }
      return maybeScreenshot(userId, deviceId, textResult(args.submit ? 'Text typed and submitted.' : 'Text typed.'), args.screenshot);
    }

    case 'press_key': {
      const keycode = KEY_MAP[args.key];
      if (!keycode) return textResult(`key must be one of: ${KEY_NAMES.join(', ')}.`, true);
      if (!signaling.sendToPhone(userId, deviceId, { type: 'control', action: 'keyevent', keycode })) return offline();
      return maybeScreenshot(userId, deviceId, textResult(`Pressed ${args.key}.`), args.screenshot);
    }

    case 'open_app': {
      if (!args.name && !args.package) return textResult('Provide an app name or package.', true);
      if (!signaling.presence.isOnline(userId, deviceId)) return offline();
      try {
        const reply = await signaling.requestFromPhone(userId, deviceId, (id) => ({
          type: 'open_app', id, query: args.name || '', package: args.package || '',
        }));
        if (!reply.ok) return textResult(reply.error || 'Could not open the app.', true);
        const base = textResult(`Opened ${reply.launched} (${reply.package}).`);
        return maybeScreenshot(userId, deviceId, base, args.screenshot !== false);
      } catch (e) {
        return textResult(e.message, true);
      }
    }

    case 'open_app_drawer': {
      // Home first so the swipe reliably targets the launcher, then swipe up
      // from the very bottom to open the app drawer (where app search lives).
      if (!signaling.sendToPhone(userId, deviceId, { type: 'control', action: 'keyevent', keycode: 'KEYCODE_HOME' })) return offline();
      await sleep(400);
      signaling.sendToPhone(userId, deviceId, { type: 'control', action: 'swipe', x1: 0.5, y1: 0.92, x2: 0.5, y2: 0.25, ms: 250 });
      const want = args.screenshot !== false; // defaults to true for this one
      return maybeScreenshot(userId, deviceId, textResult('Opened the app drawer. Tap the search bar and type an app name to find it.'), want);
    }

    case 'wait': {
      if (!signaling.presence.isOnline(userId, deviceId)) return offline();
      const secs = clamp(args.seconds ?? 1.5, 0.2, 15);
      await sleep(secs * 1000);
      return maybeScreenshot(userId, deviceId, textResult(`Waited ${secs}s.`), args.screenshot);
    }

    case 'ring':
      if (!signaling.sendToPhone(userId, deviceId, { type: 'ring' })) return offline();
      return textResult('Ringing device.');

    case 'flash_light':
      if (!signaling.sendToPhone(userId, deviceId, { type: 'flash', count: args.count ?? 3 })) return offline();
      return textResult('Flashing light.');

    case 'list_files': {
      try {
        const safePath = confineToBase(args.path);
        const reply = await signaling.requestFromPhone(userId, deviceId, (id) => ({
          type: 'pf_list', id, path: safePath,
        }));
        return textResult(reply.entries.map((e) => ({ name: e.name, type: e.type, size: e.size, path: e.path })));
      } catch (e) {
        return textResult(e.message, true);
      }
    }

    case 'send_local_file': {
      const fileName = String(args.name || '').replace(/[/\\]/g, '').trim();
      if (!fileName) return textResult('name must be a plain file name (no slashes).', true);
      if (!signaling.presence.isOnline(userId, deviceId)) return offline();
      const destFolder = confineToBase(
        args.folder
          ? (String(args.folder).startsWith('/') ? args.folder : `${PHONE_BASE}/${args.folder}`)
          : `${PHONE_BASE}/Download`
      );
      pruneUploads();
      const token = crypto.randomBytes(24).toString('base64url');
      const dest = `${destFolder}/${fileName}`;
      pendingUploads.set(token, { userId, deviceId, dest, expiresAt: Date.now() + UPLOAD_TTL_MS });
      const uploadUrl = `${ctx.baseUrl}/mcp/upload/${token}`;
      return textResult({
        upload_url: uploadUrl,
        saves_to: dest,
        expires_in_seconds: UPLOAD_TTL_MS / 1000,
        next_step: `POST the raw file bytes to upload_url, e.g.: curl -sS -X POST -H "Content-Type: application/octet-stream" --data-binary @"<local-file-path>" "${uploadUrl}" — the JSON response confirms the save on the phone.`,
      });
    }

    case 'send_file': {
      const name = String(args.name || '').replace(/[/\\]/g, '').trim();
      if (!name) return textResult('name must be a plain file name (no slashes).', true);
      let bytes;
      try {
        bytes = Buffer.from(args.data_base64, 'base64');
      } catch {
        return textResult('data_base64 is not valid base64.', true);
      }
      if (bytes.length === 0) return textResult('Decoded file is empty — check data_base64.', true);
      if (bytes.length > MAX_SEND_FILE_BYTES) {
        return textResult(`File is ${(bytes.length / 1048576).toFixed(1)} MB — max is ${MAX_SEND_FILE_BYTES / 1048576} MB.`, true);
      }
      const folder = confineToBase(
        args.folder
          ? (String(args.folder).startsWith('/') ? args.folder : `${PHONE_BASE}/${args.folder}`)
          : `${PHONE_BASE}/Download`
      );
      try {
        const dest = await signaling.uploadToPhone(userId, deviceId, `${folder}/${name}`, bytes);
        return textResult(`Saved ${name} (${bytes.length} bytes) to ${dest} on the phone.`);
      } catch (e) {
        return textResult(e.message, true);
      }
    }

    case 'send_url': {
      if (!signaling.presence.isOnline(userId, deviceId)) return offline();
      if (!args.url || !/^https?:\/\//i.test(String(args.url))) return textResult('Provide a valid http(s) URL.', true);
      let fetched;
      try {
        fetched = await downloadUrl(String(args.url), MAX_SEND_FILE_BYTES);
      } catch (e) {
        return textResult(`Couldn't fetch that URL: ${e.message}`, true);
      }
      if (!fetched.buffer.length) return textResult('The downloaded file is empty.', true);
      const name = String(args.name || fetched.urlName || 'file').replace(/[/\\]/g, '').trim() || 'file';
      const folder = confineToBase(
        args.folder
          ? (String(args.folder).startsWith('/') ? args.folder : `${PHONE_BASE}/${args.folder}`)
          : `${PHONE_BASE}/Download`
      );
      try {
        const dest = await signaling.uploadToPhone(userId, deviceId, `${folder}/${name}`, fetched.buffer);
        return textResult(`Downloaded ${fetched.buffer.length} bytes and saved to ${dest} on the phone.`);
      } catch (e) {
        return textResult(e.message, true);
      }
    }

    default:
      return null; // unknown tool — caller returns a protocol-level error
  }
}

function setupMcpRoutes(app) {
  // One-time upload target for send_local_file. Raw bytes in, no auth header —
  // the unguessable single-use token (24 random bytes, 10-min TTL) is the
  // credential, so a plain `curl --data-binary` works from any shell.
  app.post('/mcp/upload/:token', express.raw({ type: () => true, limit: '20mb' }), async (req, res) => {
    const upload = pendingUploads.get(req.params.token);
    if (upload) pendingUploads.delete(req.params.token); // single use, even on failure
    if (!upload || upload.expiresAt < Date.now()) {
      return res.status(410).json({ ok: false, error: 'Upload link is invalid or expired — call the send_local_file tool again for a fresh one.' });
    }
    const bytes = req.body;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      return res.status(400).json({ ok: false, error: 'No file bytes received — send the raw file with Content-Type: application/octet-stream.' });
    }
    if (bytes.length > MAX_SEND_FILE_BYTES) {
      return res.status(413).json({ ok: false, error: `File is ${(bytes.length / 1048576).toFixed(1)} MB — max is ${MAX_SEND_FILE_BYTES / 1048576} MB.` });
    }
    try {
      const dest = await signaling.uploadToPhone(upload.userId, upload.deviceId, upload.dest, bytes);
      res.json({ ok: true, saved: dest, bytes: bytes.length });
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message });
    }
  });

  app.post('/mcp', async (req, res) => {
    const token = req.headers.authorization?.replace(/^Bearer /, '');
    const payload = token && verifyToken(token);
    const baseUrl = `${process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`}`.replace(/\/$/, '');
    if (!payload) {
      res.set('WWW-Authenticate', `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`);
      return res.status(401).json({ error: 'unauthorized' });
    }
    const userId = payload.uid;

    const msg = req.body;
    // Notifications carry no `id` and expect no response body.
    if (msg.id === undefined) return res.status(202).end();

    const reply = (result) => res.json({ jsonrpc: '2.0', id: msg.id, result });
    const replyError = (code, message) => res.json({ jsonrpc: '2.0', id: msg.id, error: { code, message } });

    try {
      switch (msg.method) {
        case 'initialize':
          return reply({
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'phone-remote', version: SERVER_VERSION },
          });

        case 'tools/list':
          return reply({ tools: TOOLS });

        case 'tools/call': {
          const { name, arguments: args } = msg.params || {};
          if (!TOOLS.some((t) => t.name === name)) return replyError(-32602, `Unknown tool: ${name}`);
          const result = await callTool(userId, name, args || {}, { baseUrl });
          return reply(result);
        }

        default:
          return replyError(-32601, `Method not found: ${msg.method}`);
      }
    } catch (e) {
      console.error('MCP request failed:', e);
      return replyError(-32603, 'Internal error');
    }
  });
}

module.exports = { setupMcpRoutes };
