const express = require('express');
const crypto = require('crypto');
const sharp = require('sharp');
const mime = require('mime-types');
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');

const db = require('../services/db');
const { verifyToken } = require('../middleware/auth');
const signaling = require('../services/signaling');
const { compactNodes, formatTree } = require('../services/uiTreeCompact');
const {
  screenLabels, sameScreen, mergeScreens, dropRepeated, toRows,
} = require('../services/listCollect');

/**
 * MCP server — Powered by Anthropic's official @modelcontextprotocol/sdk and zod.
 * Streamable HTTP transport (single-JSON-response mode via enableJsonResponse: true).
 * Auth: Multi-tenant JWT scoping passed via req.auth -> extra.authInfo.
 */

const SERVER_VERSION = '2.1.0';

// send_file caps
const MAX_SEND_FILE_BYTES = 18 * 1024 * 1024;
const MAX_TRANSFER_BYTES = 100 * 1024 * 1024;
const MAX_GET_FILE_BYTES = MAX_TRANSFER_BYTES;

// send_local_file: one-time upload URLs
const UPLOAD_TTL_MS = 10 * 60 * 1000;
const pendingUploads = new Map(); // token -> { userId, deviceId, dest, expiresAt }
function pruneUploads() {
  const now = Date.now();
  for (const [token, u] of pendingUploads) if (u.expiresAt < now) pendingUploads.delete(token);
}

// get_file: one-time download URLs
const DOWNLOAD_TTL_MS = 10 * 60 * 1000;
const pendingDownloads = new Map(); // token -> { buffer, name, expiresAt }
function pruneDownloads() {
  const now = Date.now();
  for (const [token, d] of pendingDownloads) if (d.expiresAt < now) pendingDownloads.delete(token);
}

// Named keys -> KEYCODE_* strings
const KEY_MAP = {
  back: 'KEYCODE_BACK',
  home: 'KEYCODE_HOME',
  recents: 'KEYCODE_APP_SWITCH',
  enter: 'KEYCODE_ENTER',
  delete: 'KEYCODE_DEL',
  notifications: 'KEYCODE_NOTIFICATION',
  quick_settings: 'KEYCODE_QUICK_SETTINGS',
  lock: 'KEYCODE_POWER',
  volume_up: 'KEYCODE_VOLUME_UP',
  volume_down: 'KEYCODE_VOLUME_DOWN',
};
const KEY_NAMES = Object.keys(KEY_MAP);

// Screenshot constants
const SCREENSHOT_SETTLE_MS = 850;
// 1092 px tall (~700 image tokens) is enough to understand a screen; hd:true
// gives 1568 px (~1,470 tokens) for small print.
const SCREENSHOT_MAX_EDGE = 1092;
const SCREENSHOT_HD_MAX_EDGE = 1568;
const SCREENSHOT_ACT_MAX_EDGE = 1092;
const SCREENSHOT_JPEG_QUALITY = 70;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Token economy: replies are read by a model, so no pretty-printing. A list
// comes back as one compact JSON object per line (like get_ui_tree); anything
// else as one compact line. Indented JSON cost ~2x the tokens for list_apps.
function compactJson(value) {
  if (Array.isArray(value)) return `[${value.map((v) => `
${JSON.stringify(v)}`).join(',')}
]`;
  return JSON.stringify(value);
}

// list_files used to repeat the full path and a meaningless folder size on
// every row (~25 tokens/entry; ~9,500 for a 245-entry Download folder).
function humanSize(b) {
  if (b == null) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatFileList(dir, entries, { filter, sort, limit, offset } = {}) {
  let list = entries;
  if (filter) {
    const f = String(filter).toLowerCase();
    list = list.filter((e) => String(e.name).toLowerCase().includes(f));
  }
  const dirs = list.filter((e) => e.type === 'dir').length;
  if (sort === 'newest') list = [...list].sort((a, b) => (b.modified || 0) - (a.modified || 0));
  else if (sort === 'largest') list = [...list].sort((a, b) => (b.type === 'file' ? b.size : -1) - (a.type === 'file' ? a.size : -1));
  const from = offset || 0;
  const n = limit || 60;
  const page = list.slice(from, from + n);
  const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '');
  const rows = page.map((e) => (e.type === 'dir'
    ? `${e.name}/ | | ${day(e.modified)}`
    : `${e.name} | ${humanSize(e.size)} | ${day(e.modified)}`));
  let head = `${dir}: ${list.length} entries (${dirs} folders, ${list.length - dirs} files)`;
  if (filter) head += ` matching "${filter}"`;
  if (list.length) head += `, showing ${from + 1}-${from + page.length}` + (sort && sort !== 'name' ? `, ${sort} first` : '');
  head += rows.length ? '. Rows: name | size | modified.' : '.';
  const left = list.length - from - page.length;
  const more = left > 0 ? `\n(${left} more: call again with offset:${from + page.length})` : '';
  return [head, ...rows].join('\n') + more;
}

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text: typeof text === 'string' ? text : compactJson(text) }], isError };
}

function imageResult(jpeg) {
  return { content: [{ type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg' }] };
}

async function shrinkScreenshot(jpeg, maxEdge = SCREENSHOT_MAX_EDGE) {
  try {
    return await sharp(jpeg)
      .resize(maxEdge, maxEdge, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: SCREENSHOT_JPEG_QUALITY, mozjpeg: true })
      .toBuffer();
  } catch {
    return jpeg;
  }
}

async function captureScreenshotWithRetry(userId, deviceId) {
  try {
    return await signaling.captureScreenshot(userId, deviceId);
  } catch (e) {
    if (!/capture_failed/i.test(e.message)) throw e;
    await sleep(700);
    return signaling.captureScreenshot(userId, deviceId);
  }
}

async function looksBlank(jpeg) {
  try {
    const st = await sharp(jpeg).stats();
    return st.channels.every((c) => c.stdev < 4);
  } catch {
    return false;
  }
}

const BLANK_NOTE = '(warning: this screenshot appears blank/uniform. The screen may be off or locked, mid-animation, or showing content the device refuses to capture. Try press_key "home", or wait ~2s and take_screenshot again.)';

async function captureVerifiedScreenshot(userId, deviceId) {
  let jpeg;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(1200);
    jpeg = await captureScreenshotWithRetry(userId, deviceId);
    if (!(await looksBlank(jpeg))) return { jpeg };
  }
  return { jpeg, note: BLANK_NOTE };
}

async function maybeScreenshot(userId, deviceId, baseResult, want) {
  if (!want || baseResult.isError) return baseResult;
  await sleep(SCREENSHOT_SETTLE_MS);
  try {
    const { jpeg: raw, note } = await captureVerifiedScreenshot(userId, deviceId);
    const jpeg = await shrinkScreenshot(raw, SCREENSHOT_ACT_MAX_EDGE);
    const content = [...baseResult.content, { type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg' }];
    if (note) content.push({ type: 'text', text: note });
    return { content, isError: false };
  } catch (e) {
    return {
      content: [...baseResult.content, { type: 'text', text: `(action succeeded, but the confirmation screenshot failed: ${e.message}. Call take_screenshot to see the current screen.)` }],
      isError: false,
    };
  }
}

const CONTROL_ERRORS = {
  accessibility_not_enabled: "Nothing happened: the phone's Accessibility Service is off, which is what performs taps and typing. Turn it on at Settings → Accessibility → Phone Remote. Until then every touch command will no-op.",
  no_focused_text_field: 'Nothing was typed: no text field is focused. Tap the field first (tap with screenshot:true to confirm the cursor is in it), then type_text again.',
  gesture_rejected_by_system: 'Android refused the gesture. The screen is likely off or locked, or a system dialog is capturing input. Take a screenshot to see the current screen; press_key "home" often clears it.',
  screen_size_unknown: 'The phone has not reported its screen size yet, so the coordinates could not be resolved. Wait a second and retry.',
  key_not_accepted: 'The phone did not accept that key press.',
  paste_rejected: 'The focused field refused the paste. Make sure a text field is focused (tap it first). If it is, the app may block pasting — try type_text without method:"paste".',
  unknown_action: 'The phone did not recognise that command — its app build is likely older than this server.',
};

const UNCONFIRMED_NOTE = ' (Sent, but this phone build cannot confirm whether it actually ran — update the app for confirmed actions.)';

async function runControl(userId, deviceId, msg, timeoutMs) {
  let verdict;
  try {
    verdict = await signaling.controlPhone(userId, deviceId, msg, timeoutMs);
  } catch (e) {
    const offlineNow = /offline/i.test(e.message);
    return {
      err: textResult(
        offlineNow
          ? 'Device is offline.'
          : `The phone never confirmed the command (${e.message}). It may have dropped offline mid-command — the action may or may not have run. Take a screenshot to check before retrying.`,
        true
      ),
      note: '',
    };
  }
  if (!verdict.ok) {
    return {
      err: textResult(CONTROL_ERRORS[verdict.error] || `The phone could not run the command (${verdict.error || 'unknown reason'}).`, true),
      note: '',
    };
  }
  return { err: null, note: verdict.confirmed ? '' : UNCONFIRMED_NOTE };
}

const WAIT_POLL_MS = 600;

// collect_list: pause after each scroll so the list stops flinging, and the
// most rows it will return.
const COLLECT_SETTLE_MS = 250;
const COLLECT_MAX_ROWS = 1500;
// MCP clients give up on a tool call after about 60 s (the server keeps going,
// but the agent never sees the result), so stop and return what we have first.
const COLLECT_BUDGET_MS = 45000;

function fetchUiTree(userId, deviceId, all = false, timeoutMs = 10000, filter = null) {
  return signaling.requestFromPhone(
    userId, deviceId,
    (id) => ({ type: 'ui_tree', id, all: !!all, ...(filter ? { filter } : {}) }),
    timeoutMs, 'ui_tree'
  );
}

function fetchDeviceStatus(userId, deviceId, timeoutMs = 8000) {
  return signaling.requestFromPhone(
    userId, deviceId, (id) => ({ type: 'device_status', id }), timeoutMs, 'device_status'
  );
}

function treeMatches(tree, { text, id, app }) {
  if (app) return String(tree.package || '').toLowerCase().includes(app.toLowerCase());
  const nodes = tree.nodes || [];
  if (id) return nodes.some((n) => String(n.id || '').toLowerCase().includes(id.toLowerCase()));
  const needle = String(text).toLowerCase();
  return nodes.some((n) => `${n.text || ''} ${n.desc || ''}`.toLowerCase().includes(needle));
}

const PHONE_BASE = '/storage/emulated/0';
function confineToBase(path) {
  let raw = (path || PHONE_BASE).replace(/\\/g, '/').replace(/\/+/g, '/').trim();
  if (!raw.startsWith('/')) raw = '/' + raw;
  if (!raw.startsWith(PHONE_BASE)) raw = PHONE_BASE + raw;
  const parts = [];
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  const abs = '/' + parts.join('/');
  return (abs === PHONE_BASE || abs.startsWith(PHONE_BASE + '/')) ? abs : PHONE_BASE;
}

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
    if (l.startsWith('fe80') || l.startsWith('fc') || l.startsWith('fd')) return true;
    const m = l.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isBlockedIp(m[1]);
    return false;
  }
  return true;
}

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

// Guidance every MCP client receives on connect (the `instructions` field).
const SERVER_INSTRUCTIONS = [
  'Phone Remote operates real Android phones linked to the signed-in account.',
  'Start with list_devices to get a deviceId; most tools need it and the phone must be online.',
  'Then call get_device_status once at the start of the session and pass on any warnings to the user (Accessibility off, phone locked, phone not in English).',
  'Coordinates are normalized 0.0-1.0 fractions of the screen, never pixels.',
  'Prefer get_ui_tree (exact tappable coordinates, cheap) over take_screenshot; use wait_for instead of fixed waits.',
  'If taps do nothing, call get_device_status: the phone may be locked or Accessibility may be off.',
  'uninstall_app and clear_app_storage (data) permanently delete user data: only use them when the user explicitly asked for that specific app.',
].join(' ');

// Tool annotations (MCP spec): let clients auto-approve read-only tools and
// ask before destructive ones. Unlisted tools act on the phone (not read-only)
// but are not destructive.
const READ_ONLY_TOOLS = new Set([
  'list_devices', 'get_location', 'get_device_status', 'get_foreground_app', 'get_ui_tree', 'wait_for',
  'list_apps', 'find_unused_apps', 'read_notifications', 'take_screenshot', 'wait', 'list_files', 'get_file',
  'get_clipboard',
]);
const DESTRUCTIVE_TOOLS = new Set(['uninstall_app', 'clear_app_storage', 'delete_file']);
// Reach outside this server and the phone (arbitrary URLs).
const OPEN_WORLD_TOOLS = new Set(['open_url', 'send_url']);
const TOOL_TITLES = {
  list_devices: 'List devices', get_location: 'Get location', get_device_status: 'Get device status',
  get_foreground_app: 'Get foreground app', get_ui_tree: 'Read screen (UI tree)', wait_for: 'Wait for screen element',
  list_apps: 'List installed apps', find_unused_apps: 'Find unused apps', open_url: 'Open URL or deep link',
  uninstall_app: 'Uninstall app', clear_app_storage: 'Clear app cache / data', read_notifications: 'Read notifications',
  take_screenshot: 'Take screenshot', tap: 'Tap', long_press: 'Long press', swipe: 'Swipe', scroll: 'Scroll',
  collect_list: 'Read a whole scrolling list',
  type_text: 'Type text', press_key: 'Press key', open_app: 'Open app', open_app_drawer: 'Open app drawer',
  wait: 'Wait', ring: 'Ring phone', flash_light: 'Flash light', list_files: 'List phone files',
  get_file: 'Download file from phone', delete_file: 'Delete a file on the phone', send_local_file: 'Send local file to phone', send_file: 'Send file to phone',
  send_url: 'Send URL download to phone', open_settings: 'Open a Settings page',
  open_file: 'Open a file or folder', get_clipboard: 'Read phone clipboard',
  set_clipboard: 'Copy text to phone clipboard',
};

// Pages open_settings can reach; mirrors the phone's fixed list
// (ConnectionForegroundService.settingsPages). Only the "app" ones take a package.
const SETTINGS_PAGES = {
  settings: 'main Settings screen',
  apps: 'Apps menu',
  all_apps: 'list of every app, system apps included',
  installed_apps: 'list of installed apps',
  app_info: 'one app\'s App info page (app)',
  app_notifications: 'one app\'s notification settings (app)',
  overlay: 'one app\'s "Display over other apps" permission (app)',
  install_unknown_apps: 'one app\'s "Install unknown apps" permission (app)',
  modify_system_settings: 'one app\'s "Modify system settings" permission (app)',
  all_files_access: 'one app\'s "All files access" permission (app)',
  alarms_reminders: 'one app\'s "Alarms & reminders" permission (app)',
  open_by_default: 'one app\'s "Open by default" links page (app)',
  app_language: 'one app\'s language (app)',
  default_apps: 'Default apps (browser, phone, SMS...)',
  home_app: 'default Home app',
  battery: 'Battery, with battery usage by app',
  battery_saver: 'Battery saver',
  battery_optimization: 'battery optimisation list',
  notifications: 'notification settings',
  do_not_disturb: 'Do Not Disturb',
  notification_access: 'Notification access list',
  usage_access: 'Usage access list',
  accessibility: 'Accessibility',
  security: 'Security / screen lock',
  privacy: 'Privacy',
  location: 'Location',
  accounts: 'Accounts & sync',
  wifi: 'Wi-Fi', bluetooth: 'Bluetooth', mobile_data: 'mobile network',
  data_usage: 'Data usage', network_operator: 'network operator / SIM',
  airplane_mode: 'Airplane mode', hotspot: 'Hotspot & tethering', vpn: 'VPN', nfc: 'NFC',
  cast: 'Cast / screen mirroring', connected_devices: 'connections & sharing',
  display: 'Display', dark_mode: 'Dark mode', night_light: 'Night light / eye comfort',
  sound: 'Sound', storage: 'Storage', date_time: 'Date & time',
  language: 'Language', keyboard: 'Keyboards & input', captions: 'Captions', print: 'Printing',
  developer: 'Developer options', about_phone: 'About phone',
};
const SETTINGS_APP_PAGES = new Set([
  'app_info', 'app_notifications', 'overlay', 'install_unknown_apps', 'modify_system_settings',
  'all_files_access', 'alarms_reminders', 'open_by_default', 'app_language',
]);

/**
 * Creates an McpServer instance with all phone-remote tools registered
 * (registerTool with titles and annotations; input schemas in Zod).
 */
function createPhoneRemoteServer() {
  const server = new McpServer(
    { name: 'phone-remote', title: 'Phone Remote', version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS }
  );
  const offline = () => textResult('Device is offline.', true);
  const tool = (name, description, inputSchema, handler) => server.registerTool(name, {
    title: TOOL_TITLES[name] || name,
    description,
    inputSchema,
    annotations: {
      title: TOOL_TITLES[name] || name,
      readOnlyHint: READ_ONLY_TOOLS.has(name),
      destructiveHint: DESTRUCTIVE_TOOLS.has(name),
      idempotentHint: READ_ONLY_TOOLS.has(name),
      openWorldHint: OPEN_WORLD_TOOLS.has(name),
    },
  }, handler);

  // 1. list_devices
  tool(
    'list_devices',
    'List the Android phones linked to this account, with online/offline status and (when online) live screen resolution.',
    {},
    async (_args, { authInfo }) => {
      const devices = await db.listDevices(authInfo.userId);
      return textResult(devices.map((d) => {
        const online = signaling.presence.isOnline(authInfo.userId, d.id);
        const size = online ? signaling.getDeviceScreenSize(authInfo.userId, d.id) : null;
        return {
          deviceId: d.id, name: d.name, model: d.model, online,
          screenWidth: size?.screenW ?? null, screenHeight: size?.screenH ?? null,
          lastSeen: d.last_seen ? new Date(d.last_seen).toISOString() : null,
        };
      }));
    }
  );

  // 2. get_location
  tool(
    'get_location',
    'Get the most recent known GPS location of a device. Returns the cached last fix — may be a few minutes old.',
    { deviceId: z.string().describe('Device id from list_devices') },
    async ({ deviceId }, { authInfo }) => {
      const loc = signaling.getLastLocation(authInfo.userId, deviceId);
      if (!loc) return textResult('No location has been reported for this device yet.', true);
      return textResult({ lat: loc.lat, lng: loc.lng, accuracy: loc.accuracy, altitude: loc.altitude, at: new Date(loc.timestamp).toISOString() });
    }
  );

  // 3. get_device_status
  tool(
    'get_device_status',
    'Check a device\'s health before acting on it: battery level, whether the screen is on, whether the Accessibility Service (which performs all taps and typing) is enabled, the current foreground app, network type, and the phone\'s UI language (warns when it is not English, since on-screen labels then will not match English filters). Call this first when a tap or type seems to do nothing, or at the start of a session — it catches "accessibility is off" up front instead of after several silent no-ops.',
    { deviceId: z.string().describe('Device id from list_devices') },
    async ({ deviceId }, { authInfo }) => {
      if (!signaling.presence.isOnline(authInfo.userId, deviceId)) return offline();
      if (!signaling.deviceSupports(authInfo.userId, deviceId, 'device_status')) {
        return textResult('This phone build is too old to report status — update the app.', true);
      }
      try {
        const s = await fetchDeviceStatus(authInfo.userId, deviceId);
        if (s.error) return textResult(`The phone could not read its status: ${s.error}`, true);
        const status = {
          battery: `${s.battery}%${s.charging ? ' (charging)' : ''}`,
          screenOn: s.screenOn,
          ...(s.locked != null ? { locked: s.locked } : {}),
          accessibilityEnabled: s.accessibilityEnabled,
          notificationAccess: s.notificationAccess,
          foregroundApp: s.foregroundApp ?? 'unknown',
          network: s.network,
          screen: `${s.screenW}×${s.screenH}`,
          model: s.model,
          androidSdk: s.androidSdk,
          batteryOptimized: s.batteryOptimized,
          ...(s.language ? { language: s.language } : {}),
        };
        const warnings = [];
        if (!s.accessibilityEnabled) warnings.push('Accessibility Service is OFF — taps, swipes and typing will silently do nothing until it is enabled at Settings → Accessibility → Phone Remote.');
        if (s.locked) warnings.push('The phone is locked: taps cannot reach apps until the user unlocks it.');
        if (!s.screenOn) warnings.push('The screen is off — screenshots will look blank. press_key "home" wakes it.');
        if (s.language && !/^en\b/i.test(s.language)) warnings.push(`The phone's language is ${s.language}, not English. Button and menu labels are in that language, so filters like "send" or "wallpaper" in get_ui_tree / wait_for will miss. Ask the user to switch the phone to English (open_settings page "language" opens the page; they can switch back afterwards), then stop and wait until they have. Do not change the language yourself.`);
        if (s.batteryOptimized) warnings.push('Battery optimization is ON for this app — Android may throttle or kill the connection in the background. Exempt it in the app for a stable link.');
        const result = textResult(status);
        if (warnings.length) result.content.push({ type: 'text', text: warnings.join('\n') });
        return result;
      } catch (e) {
        return textResult(e.message, true);
      }
    }
  );

  // 4. get_foreground_app
  tool(
    'get_foreground_app',
    'Get the package name of the app currently on screen (e.g. com.whatsapp). A cheap way to confirm you are still in the right app after an action, without the cost of a full screenshot.',
    { deviceId: z.string().describe('Device id from list_devices') },
    async ({ deviceId }, { authInfo }) => {
      if (!signaling.presence.isOnline(authInfo.userId, deviceId)) return offline();
      if (!signaling.deviceSupports(authInfo.userId, deviceId, 'device_status')) {
        return textResult('This phone build is too old to report the foreground app — update the app.', true);
      }
      try {
        const s = await fetchDeviceStatus(authInfo.userId, deviceId);
        if (!s.accessibilityEnabled) return textResult("Cannot tell: the phone's Accessibility Service is off. Enable it at Settings → Accessibility → Phone Remote.", true);
        if (!s.foregroundApp) return textResult('No foreground app reported — the screen may be off or locked.', true);
        return textResult(s.foregroundApp);
      } catch (e) {
        return textResult(e.message, true);
      }
    }
  );

  // 5. get_ui_tree
  tool(
    'get_ui_tree',
    'Read the screen as data: visible texts, buttons and fields with x/y to pass to tap. Prefer it over take_screenshot (far cheaper, exact coordinates). Node keys: i index, text, desc (accessibility label, omitted if same as text), id (resource id), cls (widget class, omitted for TextView), x/y (normalized centre), f flags (c clickable, e editable, s scrollable, k checkable, K checked, f focused, d disabled). A c label can stand for its whole list row.',
    {
      deviceId: z.string().describe('Device id from list_devices'),
      all: z.boolean().optional().describe('Also include empty layout containers (default false; only if the tree looks incomplete).'),
      filter: z.string().optional().describe('Only elements whose text, label, id or class contains this (case-insensitive). Set it whenever you know what you are looking for (e.g. "send"): an unfiltered chat or feed returns every message.'),
    },
    async ({ deviceId, all, filter }, { authInfo }) => {
      if (!signaling.presence.isOnline(authInfo.userId, deviceId)) return offline();
      if (!signaling.deviceSupports(authInfo.userId, deviceId, 'ui_tree')) {
        return textResult('This phone build cannot read the UI tree — update the app.', true);
      }
      try {
        const t = await fetchUiTree(authInfo.userId, deviceId, all, 10000, filter);
        if (t.error) return textResult(CONTROL_ERRORS[t.error] || t.error, true);
        const nodes = t.nodes || [];
        if (!nodes.length) {
          return textResult(filter
            ? `No elements matched "${filter}". Try a different substring, or call get_ui_tree without filter to see everything currently on screen.`
            : 'The screen reported no readable elements. It is probably off or locked, or showing content that blocks accessibility. Try press_key "home", or take_screenshot to look.', true);
        }
        // all:true is the raw tree, untouched. Otherwise drop the repeats
        // (see uiTreeCompact.js); neighbour merging needs the full tree.
        const shown = all ? nodes : compactNodes(nodes, { neighbours: !filter });
        const out = { app: t.package, nodes: shown };
        if (t.truncated) out.note = `Truncated: only the first ${nodes.length} elements are listed. Scroll, or add filter to narrow the search.`;
        return textResult(formatTree(out));
      } catch (e) {
        return textResult(e.message, true);
      }
    }
  );

  // 6. wait_for
  tool(
    'wait_for',
    'Wait until something appears on screen, then return. Polls the UI tree, so it returns the moment the condition is met instead of guessing a sleep duration like wait does. Use after any action that triggers loading, navigation or an animation. Give exactly one of text, id, or app.',
    {
      deviceId: z.string().describe('Device id from list_devices'),
      text: z.string().optional().describe('Wait until this text (or accessibility label) appears — case-insensitive substring match'),
      id: z.string().optional().describe('Wait until a view with this resource id appears, e.g. "send_button"'),
      app: z.string().optional().describe('Wait until this package is in the foreground, e.g. "com.whatsapp"'),
      gone: z.boolean().optional().describe('Invert: wait until the thing DISAPPEARS instead (e.g. a loading spinner). Default false.'),
      timeout: z.number().optional().describe('Seconds to wait before giving up (default 10, max 60)'),
      screenshot: z.boolean().optional().describe('If true, return a screenshot once the condition is met (default false)'),
    },
    async (args, { authInfo }) => {
      const { deviceId } = args;
      const given = ['text', 'id', 'app'].filter((k) => args[k]);
      if (given.length !== 1) return textResult('Give exactly one of text, id, or app.', true);
      if (!signaling.presence.isOnline(authInfo.userId, deviceId)) return offline();
      if (!signaling.deviceSupports(authInfo.userId, deviceId, 'ui_tree')) {
        return textResult('This phone build cannot wait on screen state — update the app. (The dumb wait tool still works.)', true);
      }
      const timeoutMs = clamp(args.timeout ?? 10, 1, 60) * 1000;
      const want = !args.gone;
      const what = args.text ? `"${args.text}"` : args.id ? `id "${args.id}"` : `app ${args.app}`;
      const started = Date.now();
      let last = null;
      while (Date.now() - started < timeoutMs) {
        try {
          const t = await fetchUiTree(authInfo.userId, deviceId, false, 8000);
          if (t.error) return textResult(CONTROL_ERRORS[t.error] || t.error, true);
          last = t;
          if (treeMatches(t, args) === want) {
            const secs = ((Date.now() - started) / 1000).toFixed(1);
            return maybeScreenshot(
              authInfo.userId, deviceId,
              textResult(`${what} ${want ? 'appeared' : 'disappeared'} after ${secs}s.`),
              args.screenshot
            );
          }
        } catch (_) {}
        await sleep(WAIT_POLL_MS);
      }
      const seen = (last?.nodes || []).map((n) => n.text || n.desc).filter(Boolean).slice(0, 8);
      const hint = last
        ? ` Currently in ${last.package || 'an unknown app'}; visible: ${seen.length ? seen.join(' | ') : '(nothing readable)'}.`
        : ' The phone never returned a readable screen.';
      return textResult(`Timed out after ${timeoutMs / 1000}s waiting for ${what} to ${want ? 'appear' : 'disappear'}.${hint}`, true);
    }
  );

  // 7. list_apps
  tool(
    'list_apps',
    'List installed apps (name, package), e.g. to find the exact package for open_app. system:true = preinstalled (updated:true if updated since), false = user-installed; pass system to list one kind. sizes:true adds storage in MB (app, data, cache, total), largest first; minSizeMB keeps apps at least that big. Sizes need the one-time Usage access grant.',
    {
      deviceId: z.string().describe('Device id from list_devices'),
      filter: z.string().optional().describe('Optional case-insensitive substring to match against the name or package'),
      // preprocess: clients with a cached older tool list send these as strings.
      sizes: z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean().optional())
        .describe('Include storage used per app, sorted largest first (default false)'),
      minSizeMB: z.coerce.number().optional().describe('With sizes: only apps using at least this many MB in total (1 GB = 1024 MB)'),
      system: z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean().optional())
        .describe('true = only preinstalled system apps; false = only apps the user installed; omit for all'),
      limit: z.coerce.number().int().min(1).optional().describe('With sizes: how many of the largest apps to show (default 30)'),
    },
    async ({ deviceId, filter, sizes, minSizeMB, system, limit }, { authInfo }) => {
      if (!signaling.presence.isOnline(authInfo.userId, deviceId)) return offline();
      if (!signaling.deviceSupports(authInfo.userId, deviceId, 'list_apps')) {
        return textResult('This phone build cannot list apps — update the app.', true);
      }
      const wantSizes = !!sizes || minSizeMB != null;
      if (wantSizes && !signaling.deviceSupports(authInfo.userId, deviceId, 'app_sizes')) {
        return textResult('This phone build cannot report app sizes — update the app.', true);
      }
      try {
        const r = await signaling.requestFromPhone(authInfo.userId, deviceId, (id) => ({ type: 'list_apps', id, sizes: wantSizes }), 30000, 'list_apps');
        if (r.error) return textResult(`The phone could not list apps: ${r.error}`, true);
        if (wantSizes && r.sizes_error) {
          return textResult(r.sizes_error === 'usage_access_not_granted'
            ? 'App sizes need "Usage access": on the phone open Phone Remote → Permissions → Safety 7 (or Settings → Usage access → plusU) and turn it on.'
            : `The phone cannot report app sizes (${r.sizes_error}).`, true);
        }
        let apps = r.apps || [];
        if (filter) {
          const f = String(filter).toLowerCase();
          apps = apps.filter((a) => `${a.name} ${a.package}`.toLowerCase().includes(f));
          if (!apps.length) return textResult(`No installed app matches "${filter}".`, true);
        }
        if (system != null) {
          if (apps.length && !apps.some((a) => typeof a.system === 'boolean')) {
            return textResult('This phone build does not report which apps are system apps — update the app.', true);
          }
          apps = apps.filter((a) => a.system === system);
          if (!apps.length) return textResult(`No ${system ? 'system' : 'user-installed'} app found${filter ? ` matching "${filter}"` : ''}.`);
        }
        // Compact rows instead of one JSON object per app (sizes:true repeated
        // 7 keys on every app, ~3,100 tokens for 75 apps).
        const sysTag = (a) => (system == null && a.system === true ? ' | sys' : '');
        if (!wantSizes) {
          const head = `${apps.length} apps. Rows: name | package` + (system == null ? ' (| sys = preinstalled)' : '');
          return textResult([head, ...apps.map((a) => `${a.name} | ${a.package}${sysTag(a)}`)].join('\n'));
        }
        const MB = 1024 * 1024;
        const mb = (b) => Math.round((b || 0) / MB);
        let rows = apps
          .map((a) => ({ a, total: mb((a.appBytes || 0) + (a.dataBytes || 0)) }))
          .sort((x, y) => y.total - x.total);
        if (minSizeMB != null) {
          rows = rows.filter((r) => r.total >= minSizeMB);
          if (!rows.length) return textResult(`No app uses ${minSizeMB} MB or more.`);
        }
        const cap = limit || (minSizeMB != null ? rows.length : 30);
        const shown = rows.slice(0, cap);
        let head = `${rows.length} apps, largest first`;
        if (shown.length < rows.length) head += `, top ${shown.length} shown (pass limit for more)`;
        head += '. Rows: name | package | total | app | data | cache (MB)' + (system == null ? ' (| sys = preinstalled)' : '');
        return textResult([head, ...shown.map(({ a, total }) => `${a.name} | ${a.package} | ${total} | ${mb(a.appBytes)} | ${mb(a.dataBytes)} | ${mb(a.cacheBytes)}${sysTag(a)}`)].join('\n'));
      } catch (e) {
        return textResult(e.message, true);
      }
    }
  );

  // 7b. open_settings
  tool(
    'open_settings',
    `Jump straight to an Android Settings page instead of tapping through Settings. Uses standard Android settings pages, so it works on any vendor (realme, Samsung, Xiaomi…); a page the phone lacks opens the main Settings screen instead. The page names say what they open. These need package (exact package name from list_apps): ${[...SETTINGS_APP_PAGES].join(', ')}. It only opens the page; read it with get_ui_tree and tap from there.`,
    {
      deviceId: z.string().describe('Device id from list_devices'),
      page: z.enum(Object.keys(SETTINGS_PAGES)).describe('Which Settings page to open'),
      package: z.string().optional().describe('Exact package name; required for the per-app pages'),
    },
    async ({ deviceId, page, package: pkg }, { authInfo }) => {
      const userId = authInfo.userId;
      if (SETTINGS_APP_PAGES.has(page) && !pkg) return textResult(`Page "${page}" needs a package (see list_apps).`, true);
      if (!signaling.presence.isOnline(userId, deviceId)) return offline();
      if (!signaling.deviceSupports(userId, deviceId, 'open_settings')) {
        return textResult('This phone build cannot open Settings pages directly — update the app.', true);
      }
      let r;
      try {
        r = await signaling.requestFromPhone(userId, deviceId,
          (id) => ({ type: 'open_settings', id, page, ...(SETTINGS_APP_PAGES.has(page) ? { package: pkg } : {}) }),
          12000, 'open_settings');
      } catch (e) {
        return textResult(e.message, true);
      }
      if (!r.ok) return textResult(r.error || 'Could not open that Settings page.', true);
      await sleep(800);
      const what = SETTINGS_PAGES[page] + (r.name ? ` for ${r.name} (${r.package})` : '');
      return textResult(r.fallback
        ? `This phone has no direct "${page}" page, so the main Settings screen opened instead. Navigate from there (get_ui_tree).`
        : `Opened ${what}.`);
    }
  );

  // 7c. open_file
  tool(
    'open_file',
    'Open a file or folder on the phone directly, the file-system twin of open_settings. A file (image, video, PDF, document, APK…) opens in the app that normally handles its type, or in `package` when given. Pass the phone maker\'s own gallery to get its menu with "Set as wallpaper"; the package differs by brand, so look it up with list_apps (filter "gallery"), e.g. com.coloros.gallery3d (realme/OPPO/OnePlus), com.sec.android.gallery3d (Samsung), com.miui.gallery (Xiaomi), com.vivo.gallery (Vivo). A folder opens in the system Files app at that folder. Paths are under /storage/emulated/0; a relative path like "DCIM/photo.png" is resolved from there. Find paths with list_files. It only opens the file; read the screen with get_ui_tree and act from there.',
    {
      deviceId: z.string().describe('Device id from list_devices'),
      path: z.string().describe('File or folder path, e.g. "DCIM/photo.png" or "/storage/emulated/0/Download"'),
      package: z.string().optional().describe('Optional: exact package name of the app to open a file with (from list_apps)'),
    },
    async ({ deviceId, path, package: pkg }, { authInfo }) => {
      const userId = authInfo.userId;
      if (!path || !String(path).trim()) return textResult('A path is required (see list_files).', true);
      if (!signaling.presence.isOnline(userId, deviceId)) return offline();
      if (!signaling.deviceSupports(userId, deviceId, 'open_file')) {
        return textResult('This phone build cannot open files directly — update the app.', true);
      }
      const target = confineToBase(String(path).trim());
      let r;
      try {
        r = await signaling.requestFromPhone(userId, deviceId,
          (id) => ({ type: 'open_file', id, path: target, ...(pkg ? { package: String(pkg).trim() } : {}) }),
          15000, 'open_file');
      } catch (e) {
        return textResult(e.message, true);
      }
      if (!r.ok) return textResult(r.error || 'Could not open that path.', true);
      await sleep(800);
      return textResult(r.kind === 'folder'
        ? `Opened folder ${r.path} in ${r.app || 'the Files app'}.`
        : `Opened ${r.path} (${r.mime}) in ${r.app || 'its default app'}.`);
    }
  );

  // 8. open_url
  tool(
    'open_url',
    'Open a URL or app deep link on the phone (https://…, tel:, mailto:, geo:, or an app scheme like whatsapp://). Often the most reliable way to get somewhere: a deep link jumps straight to the target screen instead of tapping through several, so it cannot mis-tap. Prefer it over open_app + navigation when a link for the destination exists.',
    {
      deviceId: z.string().describe('Device id from list_devices'),
      url: z.string().describe('The URL or deep link to open'),
      screenshot: z.boolean().optional().describe('If true, return a screenshot after opening (default true)'),
    },
    async ({ deviceId, url, screenshot }, { authInfo }) => {
      if (!url) return textResult('A url is required.', true);
      if (!signaling.presence.isOnline(authInfo.userId, deviceId)) return offline();
      if (!signaling.deviceSupports(authInfo.userId, deviceId, 'open_url')) {
        return textResult('This phone build cannot open URLs — update the app.', true);
      }
      try {
        const r = await signaling.requestFromPhone(authInfo.userId, deviceId, (id) => ({ type: 'open_url', id, url }), 12000, 'open_url');
        if (!r.ok) return textResult(r.error || 'Could not open the URL.', true);
        return maybeScreenshot(authInfo.userId, deviceId, textResult(`Opened ${url}`), screenshot !== false);
      } catch (e) {
        return textResult(e.message, true);
      }
    }
  );

  // 7b. find_unused_apps
  tool(
    'find_unused_apps',
    'Find apps the user has not opened for a while, biggest first: the best candidates for freeing storage. Each result has its size (MB), the date it was last used (or "not in the last year"), and how many days ago that was. Apps installed more recently than `days` are skipped (they have not had the chance to be used). Read-only: follow up with uninstall_app or clear_app_storage only for apps the user picks. Needs the one-time "Usage access" grant on the phone.',
    {
      deviceId: z.string().describe('Device id from list_devices'),
      days: z.coerce.number().min(1).max(365).optional().describe('Unused for at least this many days (default 30)'),
      minSizeMB: z.coerce.number().min(0).optional().describe('Only apps using at least this many MB (default 0)'),
    },
    async ({ deviceId, days, minSizeMB }, { authInfo }) => {
      const userId = authInfo.userId;
      if (!signaling.presence.isOnline(userId, deviceId)) return offline();
      if (!signaling.deviceSupports(userId, deviceId, 'app_usage')) {
        return textResult('This phone build cannot report when apps were last used — update the app.', true);
      }
      const minDays = days ?? 30;
      const minMB = minSizeMB ?? 0;
      let r;
      try {
        r = await signaling.requestFromPhone(userId, deviceId, (id) => ({ type: 'list_apps', id, sizes: true, usage: true }), 30000, 'list_apps');
      } catch (e) {
        return textResult(e.message, true);
      }
      if (r.error) return textResult(`The phone could not list apps: ${r.error}`, true);
      if (r.usage_error || r.sizes_error) {
        return textResult('This needs "Usage access": on the phone open Phone Remote → Permissions → Safety 7 (or Settings → Usage access → plusU) and turn it on.', true);
      }
      const now = Date.now();
      const DAY = 24 * 3600 * 1000;
      const mb = (b) => Math.round(((b || 0) / (1024 * 1024)) * 10) / 10;
      const unused = (r.apps || [])
        .filter((a) => a.package !== 'com.phoneremote')
        .filter((a) => !a.installedMs || now - a.installedMs >= minDays * DAY)
        .filter((a) => !a.lastUsedMs || now - a.lastUsedMs >= minDays * DAY)
        .map((a) => ({
          name: a.name,
          package: a.package,
          totalMB: mb((a.appBytes || 0) + (a.dataBytes || 0)),
          lastUsed: a.lastUsedMs ? new Date(a.lastUsedMs).toISOString().slice(0, 10) : 'not in the last year',
          daysUnused: a.lastUsedMs ? Math.floor((now - a.lastUsedMs) / DAY) : null,
        }))
        .filter((a) => a.totalMB >= minMB)
        .sort((x, y) => y.totalMB - x.totalMB);
      if (!unused.length) return textResult(`No app has gone unused for ${minDays}+ days${minMB ? ` while using ${minMB}+ MB` : ''}.`);
      const totalMB = Math.round(unused.reduce((s, a) => s + a.totalMB, 0));
      const result = textResult(unused);
      result.content.push({ type: 'text', text: `${unused.length} app(s) unused for ${minDays}+ days, ${totalMB} MB in total.` });
      return result;
    }
  );

  // 8b. uninstall_app
  tool(
    'uninstall_app',
    'Uninstall an app from the phone by exact package name (get it from list_apps). PERMANENT: removes the app and all its data, and cannot be undone. Only use it when the user explicitly asked to remove that specific app; if there is any doubt which app is meant, ask first. Opens Android\'s own "uninstall this app?" prompt; with confirm (default true) the tool taps OK in that prompt and checks the app is gone. With confirm:false the prompt is left open for the person holding the phone. The phone must be unlocked. System apps and Phone Remote itself are refused.',
    {
      deviceId: z.string().describe('Device id from list_devices'),
      package: z.string().describe('Exact package name, e.g. com.example.app (from list_apps)'),
      confirm: z.boolean().optional().describe('Tap OK in Android\'s uninstall prompt (default true). false = only open the prompt.'),
    },
    async ({ deviceId, package: pkg, confirm }, { authInfo }) => {
      const userId = authInfo.userId;
      if (!pkg) return textResult('A package name is required (see list_apps).', true);
      if (!signaling.presence.isOnline(userId, deviceId)) return offline();
      if (!signaling.deviceSupports(userId, deviceId, 'uninstall_app')) {
        return textResult('This phone build cannot uninstall apps — update the app.', true);
      }
      let r;
      try {
        r = await signaling.requestFromPhone(userId, deviceId, (id) => ({ type: 'uninstall_app', id, package: pkg }), 12000, 'uninstall_app');
      } catch (e) {
        return textResult(e.message, true);
      }
      if (!r.ok) return textResult(r.error || 'Could not start the uninstall.', true);
      const label = `${r.name || pkg} (${pkg})`;
      if (confirm === false) {
        return textResult(`Android's uninstall prompt for ${label} is open on the phone. Tap OK there to remove it.`);
      }

      // Find the OK / Uninstall button in the system package installer's prompt.
      const deadline = Date.now() + 8000;
      let button = null;
      let lastPkg = '';
      while (Date.now() < deadline && !button) {
        await sleep(WAIT_POLL_MS);
        try {
          const t = await fetchUiTree(userId, deviceId, false, 5000);
          lastPkg = t.package || '';
          if (!/packageinstaller|permissioncontroller/i.test(lastPkg)) continue;
          // android:id/button1 is the dialog's confirm button in every
          // language; the English labels cover installers that lack the id.
          button = (t.nodes || []).find((n) =>
            /c/.test(n.f || '') && (n.id === 'button1' || /^(ok|uninstall)$/i.test(String(n.text || n.desc || '').trim())));
        } catch { /* keep polling */ }
      }
      if (!button) {
        return textResult(`Opened the uninstall prompt for ${label}, but could not find its OK button${lastPkg ? ` (foreground: ${lastPkg})` : ''}. The phone may be locked. Take a screenshot to check.`, true);
      }
      const tap = await runControl(userId, deviceId, { type: 'control', action: 'tap', x: button.x, y: button.y });
      if (tap.err) return tap.err;

      // Confirm it is really gone.
      const goneBy = Date.now() + 15000;
      while (Date.now() < goneBy) {
        await sleep(1000);
        try {
          const l = await signaling.requestFromPhone(userId, deviceId, (id) => ({ type: 'list_apps', id }), 10000, 'list_apps');
          if (!(l.apps || []).some((a) => a.package === pkg)) return textResult(`Uninstalled ${label}.`);
        } catch { /* keep checking */ }
      }
      return textResult(`Tapped OK to uninstall ${label}, but it still shows as installed after 15s. Take a screenshot to check.`, true);
    }
  );

  // 8c. clear_app_storage
  //
  // Android has no way for a normal app to clear another app's cache or data
  // (CLEAR_APP_USER_DATA is system-only), so this runs the fixed, minimal UI
  // path: App info (opened directly by the phone) → Storage → Clear cache /
  // Clear data → confirm. Button names vary by vendor and language: the
  // English lists below are the fallback, and newer phone builds also send
  // the Settings app's own labels in the phone's language (r.labels), which
  // withLabels() adds. Dialog confirm buttons are also found by their
  // language-free id, android:id/button1.
  const SETTINGS_STORAGE = /^(storage|storage usage|storage & cache|storage and cache|storage & memory|storage & data|app storage|storage used)$/i;
  const SETTINGS_CLEAR_CACHE = /^(clear cache|delete cache|clear cache data|clear caches)$/i;
  const SETTINGS_CLEAR_DATA = /^(clear data|clear storage|clear all data|delete data|clear user data|delete all data|clear app data)$/i;
  const SETTINGS_CONFIRM = /^(ok|delete|clear|confirm|delete data|clear data|yes)$/i;
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // English regex + exact labels from the phone, as one case-insensitive full match.
  function withLabels(re, labels) {
    const extra = (Array.isArray(labels) ? labels : [])
      .map((l) => String(l || '').trim()).filter(Boolean).map(escapeRe);
    if (!extra.length) return re;
    return new RegExp(`^(?:${re.source.slice(1, -1)}|${extra.join('|')})$`, 'i');
  }
  const PROTECTED_PACKAGES = new Set([
    'com.phoneremote', 'com.google.android.gms', 'com.google.android.gsf',
    'com.android.vending', 'com.android.systemui', 'com.android.settings', 'com.android.phone',
  ]);

  const nodeLabel = (x) => String(x.text || x.desc || '').trim();

  // Poll the UI tree until a node's text/label fully matches re. Returns the node or null.
  //
  // Some phones pop up their own windows at random over Settings (ColorOS
  // "clean up" suggestions, vendor phone-manager offers…), and not every phone
  // has them. So while waiting:
  //  - if `home` (the Settings package) is known and another app is in front,
  //    press back once to close that popup;
  //  - if `retap` (the row tapped to get here) is still on screen after a
  //    moment, the tap was swallowed by a popup: tap it again;
  //  - `alsoOk` ends the wait early: return { other: node } when it shows,
  //    e.g. "Clear data" visible but no "Clear cache" (cache already empty).
  //  - `minY` skips nodes above it (the title bar, which can repeat a row's
  //    words: the Storage page is titled "Storage usage").
  //  - `require` only accepts a screen that also shows a node matching it
  //    (the app's name), so a Settings page left open for ANOTHER app is
  //    never acted on.
  async function findOnScreen(userId, deviceId, re, timeoutMs = 6000, opts = {}) {
    const { home, retap, alsoOk, minY, require: mustShow } = opts;
    const start = Date.now();
    const end = start + timeoutMs;
    let backs = 0;
    let retaps = 0;
    let otherSeenAt = 0;
    while (Date.now() < end) {
      try {
        const t = await fetchUiTree(userId, deviceId, false, 5000);
        const nodes = t.nodes || [];
        const fg = t.package || t.app || '';
        if (home && fg && fg !== home && backs < 2) {
          backs++;
          await runControl(userId, deviceId, { type: 'control', action: 'keyevent', keycode: KEY_MAP.back });
          await sleep(700);
          continue;
        }
        if (mustShow && !nodes.some((x) => mustShow.test(nodeLabel(x)))) {
          await sleep(WAIT_POLL_MS);
          continue;
        }
        const n = nodes.find((x) => (minY == null || x.y > minY) && re.test(nodeLabel(x)));
        if (n) return n;
        if (alsoOk) {
          const o = nodes.find((x) => alsoOk.test(nodeLabel(x)));
          // Give the target a moment to render before settling for the other one.
          if (o && !otherSeenAt) otherSeenAt = Date.now();
          if (o && Date.now() - otherSeenAt > 1500) return { other: o };
        }
        if (retap && retaps < 2 && Date.now() - start > 2000) {
          // y > 0.15 skips the next page's title bar, which can carry the same words ("Storage usage").
          const again = nodes.find((x) => x.y > 0.15 && retap.test(nodeLabel(x)));
          if (again) {
            retaps++;
            await runControl(userId, deviceId, { type: 'control', action: 'tap', x: again.x, y: again.y });
            await sleep(800);
            continue;
          }
        }
      } catch { /* keep polling */ }
      await sleep(WAIT_POLL_MS);
    }
    return null;
  }

  async function appSizeMB(userId, deviceId, pkg) {
    if (!signaling.deviceSupports(userId, deviceId, 'app_sizes')) return null;
    try {
      const r = await signaling.requestFromPhone(userId, deviceId, (id) => ({ type: 'list_apps', id, sizes: true }), 30000, 'list_apps');
      const a = (r.apps || []).find((x) => x.package === pkg);
      if (!a || r.sizes_error || a.dataBytes == null) return null;
      const mb = (b) => Math.round(((b || 0) / (1024 * 1024)) * 10) / 10;
      return { totalMB: mb((a.appBytes || 0) + (a.dataBytes || 0)), dataMB: mb(a.dataBytes), cacheMB: mb(a.cacheBytes) };
    } catch {
      return null;
    }
  }

  tool(
    'clear_app_storage',
    'Clear an app\'s cache and/or data on the phone by exact package name (get it from list_apps). Android does not let apps do this directly, so the tool runs the minimal Settings path itself: App info → Storage → Clear cache / Clear data → confirm, then reports the size before and after. Clearing CACHE is harmless (temporary files). Clearing DATA is PERMANENT: it deletes the app\'s downloads, settings and login (the user must sign in again); only do it when the user explicitly asked for that app\'s data to be cleared. The phone must be unlocked. Refuses Phone Remote itself and core system packages.',
    {
      deviceId: z.string().describe('Device id from list_devices'),
      package: z.string().describe('Exact package name, e.g. com.google.android.apps.youtube.music'),
      what: z.enum(['cache', 'data', 'both']).optional().describe('cache = temporary files only; data = everything (includes cache); both = clear cache then data. Default cache.'),
    },
    async ({ deviceId, package: pkg, what }, { authInfo }) => {
      const userId = authInfo.userId;
      const mode = what || 'cache';
      if (!pkg) return textResult('A package name is required (see list_apps).', true);
      if (PROTECTED_PACKAGES.has(pkg) || pkg.startsWith('com.android.providers.')) {
        return textResult(`Refusing to clear ${pkg}: it is a core system package or Phone Remote itself.`, true);
      }
      if (!signaling.presence.isOnline(userId, deviceId)) return offline();
      if (!signaling.deviceSupports(userId, deviceId, 'app_settings')) {
        return textResult('This phone build cannot open App info pages — update the app.', true);
      }
      try {
        const st = await fetchDeviceStatus(userId, deviceId);
        if (st.locked) return textResult('The phone is locked. Ask the user to unlock it, then try again.', true);
      } catch { /* older build: carry on, the steps below fail clearly if locked */ }

      const before = await appSizeMB(userId, deviceId, pkg);
      // Close any Settings pages left open first. If Settings still shows
      // another app's page (say a previous run's Storage page), some phones
      // (realme) bring that old page back instead of opening the new App
      // info, even after Home. Backing out of Settings clears them.
      try {
        for (let i = 0; i < 5; i++) {
          const t = await fetchUiTree(userId, deviceId, false, 5000);
          if ((t.package || t.app) !== 'com.android.settings') break;
          await runControl(userId, deviceId, { type: 'control', action: 'keyevent', keycode: KEY_MAP.back });
          await sleep(500);
        }
        await runControl(userId, deviceId, { type: 'control', action: 'keyevent', keycode: KEY_MAP.home });
        await sleep(600);
      } catch { /* not fatal: the name check below still guards */ }
      let r;
      try {
        r = await signaling.requestFromPhone(userId, deviceId, (id) => ({ type: 'open_app_settings', id, package: pkg }), 12000, 'app_settings');
      } catch (e) {
        return textResult(e.message, true);
      }
      if (!r.ok) return textResult(r.error || 'Could not open the App info page.', true);
      const label = `${r.name || pkg} (${pkg})`;
      const tapNode = async (n) => {
        const t = await runControl(userId, deviceId, { type: 'control', action: 'tap', x: n.x, y: n.y });
        return t.err;
      };
      const L = r.labels || {};
      const reStorage = withLabels(SETTINGS_STORAGE, L.storage);
      const reCache = withLabels(SETTINGS_CLEAR_CACHE, L.clearCache);
      const reData = withLabels(SETTINGS_CLEAR_DATA, L.clearData);
      const reConfirm = withLabels(SETTINGS_CONFIRM, L.ok);
      const stuck = (step) => textResult(`Opened App info for ${label} but could not find "${step}". Take a screenshot to see the screen and finish by hand (tap, get_ui_tree).`, true);
      // Both App info and its Storage page show the app's name. Requiring it
      // (exact, so "WhatsApp" never matches "WhatsApp Business") makes sure
      // every tap below lands on THIS app's page.
      const appName = r.name && r.name !== pkg ? r.name.trim() : null;
      const nameRe = appName ? new RegExp(`^${escapeRe(appName)}$`, 'i') : null;

      const storage = await findOnScreen(userId, deviceId, reStorage, 8000, { minY: 0.15, require: nameRe });
      if (!storage) return stuck(`Storage (on the App info page of ${appName || pkg})`);
      // Remember which package Settings is, so a popup from any other app
      // can be recognised and closed on the next steps.
      let home = null;
      try { home = (await fetchUiTree(userId, deviceId, false, 5000)).package || null; } catch { /* no popup handling */ }
      let err = await tapNode(storage);
      if (err) return err;
      const step = { home, retap: reStorage, require: nameRe };

      const done = [];
      if (mode === 'cache' || mode === 'both') {
        const btn = await findOnScreen(userId, deviceId, reCache, 8000, { ...step, alsoOk: reData });
        if (!btn) return stuck('Clear cache');
        if (btn.other) {
          // On the Storage page but no "Clear cache" button: some phones hide it when the cache is empty.
          done.push('cache was already empty');
        } else if (btn.f && btn.f.includes('d')) {
          done.push('cache was already empty');
        } else {
          err = await tapNode(btn);
          if (err) return err;
          done.push('cleared cache');
          await sleep(800);
        }
      }
      if (mode === 'data' || mode === 'both') {
        const btn = await findOnScreen(userId, deviceId, reData, 8000, step);
        if (!btn) return stuck('Clear data');
        if (btn.f && btn.f.includes('d')) {
          done.push('data was already empty');
          const after = await appSizeMB(userId, deviceId, pkg);
          return textResult(`${label}: ${done.join(', ')}.${after ? ` Size now ${after.totalMB} MB.` : ''}`);
        }
        err = await tapNode(btn);
        if (err) return err;
        // Confirmation dialog: look for its button, but not the "Clear data"
        // button we just tapped (it can still be on screen behind the dialog).
        await sleep(600);
        const end = Date.now() + 6000;
        let confirm = null;
        while (Date.now() < end && !confirm) {
          try {
            const t = await fetchUiTree(userId, deviceId, false, 5000);
            confirm = (t.nodes || []).find((x) => {
              const s = String(x.text || x.desc || '').trim();
              if (x.x === btn.x && x.y === btn.y) return false;
              return x.id === 'button1' || reConfirm.test(s);
            });
          } catch { /* keep polling */ }
          if (!confirm) await sleep(WAIT_POLL_MS);
        }
        if (!confirm) return stuck('the OK button in the "clear data?" popup');
        err = await tapNode(confirm);
        if (err) return err;
        done.push('cleared data');
        await sleep(1500);
      }

      const after = await appSizeMB(userId, deviceId, pkg);
      const sizes = before && after
        ? ` Size: ${before.totalMB} MB → ${after.totalMB} MB (data ${before.dataMB} → ${after.dataMB} MB, cache ${before.cacheMB} → ${after.cacheMB} MB).`
        : '';
      return textResult(`${label}: ${done.join(', ')}.${sizes}${mode !== 'cache' ? ' The app is reset: the user will need to sign in to it again.' : ''}`);
    }
  );

  // 9. read_notifications
  tool(
    'read_notifications',
    'Read the phone\'s notifications — currently showing ones plus a short history of recent ones. This is how you get an OTP / 2FA code, a delivery confirmation, or an incoming message. Requires a separate one-time user grant on the phone (Settings → Notifications → Device & app notifications → Phone Remote), which is NOT the same as the Accessibility grant.',
    {
      deviceId: z.string().describe('Device id from list_devices'),
      filter: z.string().optional().describe('Optional case-insensitive substring to match against the package, title or body — e.g. "whatsapp" or "code"'),
      limit: z.number().optional().describe('Max notifications to return (default 20)'),
    },
    async ({ deviceId, filter, limit }, { authInfo }) => {
      if (!signaling.presence.isOnline(authInfo.userId, deviceId)) return offline();
      if (!signaling.deviceSupports(authInfo.userId, deviceId, 'notifications')) {
        return textResult('This phone build cannot read notifications — update the app.', true);
      }
      try {
        const r = await signaling.requestFromPhone(authInfo.userId, deviceId, (id) => ({ type: 'notifications', id }), 12000, 'notifications');
        if (r.error === 'notification_access_not_granted') {
          return textResult('Notification access has not been granted on the phone. Grant it at Settings → Notifications → Device & app notifications → Phone Remote → Allow notification access. This is a separate permission from the Accessibility Service.', true);
        }
        if (r.error) return textResult(`The phone could not read notifications: ${r.error}`, true);
        const seen = new Set();
        const all = [...(r.active || []).map((n) => ({ ...n, active: true })), ...(r.recent || [])]
          .sort((a, b) => (b.postedAt || 0) - (a.postedAt || 0))
          .filter((n) => {
            const k = `${n.package}|${n.title}|${n.text}|${n.postedAt}`;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          });
        let list = all;
        if (filter) {
          const f = String(filter).toLowerCase();
          list = list.filter((n) => `${n.package} ${n.title || ''} ${n.text || ''}`.toLowerCase().includes(f));
        }
        list = list.slice(0, clamp(limit ?? 20, 1, 50));
        if (!list.length) {
          return textResult(filter
            ? `No notifications match "${filter}". (${all.length} total seen.)`
            : 'No notifications. Note that history only covers what arrived while the app was running.');
        }
        return textResult(list.map((n) => ({
          app: n.package,
          title: n.title,
          text: n.text,
          at: n.postedAt ? new Date(n.postedAt).toISOString().slice(0, 16) + 'Z' : undefined,
          ...(n.active ? { showing: true } : {}),
        })));
      } catch (e) {
        return textResult(e.message, true);
      }
    }
  );

  // 9b. get_clipboard
  tool(
    'get_clipboard',
    'Read what the user last copied on the phone (a link, an address, a message). Use it when the user says they copied something ("I copied a link, open it", "read what I copied"). Android only lets the app in front read the clipboard, so the phone briefly brings an invisible Phone Remote screen forward and Android may show a "Phone Remote pasted from your clipboard" note; the user\'s current app is not changed. The phone must be unlocked. The clipboard can hold passwords or codes: read it only when the user asks, and don\'t repeat a secret back unless they want it.',
    {
      deviceId: z.string().describe('Device id from list_devices'),
    },
    async ({ deviceId }, { authInfo }) => {
      if (!signaling.presence.isOnline(authInfo.userId, deviceId)) return offline();
      if (!signaling.deviceSupports(authInfo.userId, deviceId, 'clipboard')) {
        return textResult('This phone build cannot read the clipboard — update the Phone Remote app on the phone.', true);
      }
      try {
        const r = await signaling.requestFromPhone(authInfo.userId, deviceId, (id) => ({ type: 'clipboard', id }), 8000, 'clipboard');
        if (!r.ok) return textResult(r.error || 'The phone could not read the clipboard.', true);
        if (r.kind === 'empty' || !r.text) return textResult('The clipboard is empty.');
        const out = { kind: r.kind, text: r.text };
        if (r.label && r.label !== 'text/plain') out.label = r.label;
        if (r.truncated) out.note = 'Long clip: only the first 20000 characters are shown.';
        return textResult(out);
      } catch (e) {
        return textResult(e.message, true);
      }
    }
  );

  // 9c. set_clipboard
  tool(
    'set_clipboard',
    'Put text on the phone\'s clipboard so the user can paste it anywhere on the phone (a message, an address, a link, a code from the PC). Works in the background: no text box, no change on screen; Android 13+ shows a small "copied" preview. It replaces whatever was on the clipboard. To type into a specific field instead, use type_text.',
    {
      deviceId: z.string().describe('Device id from list_devices'),
      text: z.string().min(1).max(20000).describe('The text to put on the clipboard (up to 20000 characters)'),
    },
    async ({ deviceId, text }, { authInfo }) => {
      if (!signaling.presence.isOnline(authInfo.userId, deviceId)) return offline();
      if (!signaling.deviceSupports(authInfo.userId, deviceId, 'set_clipboard')) {
        return textResult('This phone build cannot set the clipboard — update the Phone Remote app on the phone. Until then, tap a text box and use type_text with method "paste", which also puts the text on the clipboard.', true);
      }
      try {
        const r = await signaling.requestFromPhone(authInfo.userId, deviceId, (id) => ({ type: 'set_clipboard', id, text }), 8000, 'set_clipboard');
        if (!r.ok) return textResult(r.error || 'The phone could not set the clipboard.', true);
        return textResult(`Copied to the phone's clipboard (${r.length ?? text.length} characters). The user can paste it anywhere.`);
      } catch (e) {
        return textResult(e.message, true);
      }
    }
  );

  // 10. take_screenshot
  tool(
    'take_screenshot',
    'Return the current screen as a JPEG image (~700 tokens; get_ui_tree is ~50-300). Use it only when get_ui_tree does not explain the screen: a tap did nothing, something covers the target, or the content is visual (image, video, game). Pass hd:true only to read small print (~1,500 tokens).',
    {
      deviceId: z.string().describe('Device id from list_devices'),
      hd: z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean().optional()).describe('Higher resolution for small text (about twice the tokens). Default false.'),
    },
    async ({ deviceId, hd }, { authInfo }) => {
      try {
        const { jpeg, note } = await captureVerifiedScreenshot(authInfo.userId, deviceId);
        const result = imageResult(await shrinkScreenshot(jpeg, hd ? SCREENSHOT_HD_MAX_EDGE : SCREENSHOT_MAX_EDGE));
        if (note) result.content.push({ type: 'text', text: note });
        return result;
      } catch (e) {
        return textResult(e.message, true);
      }
    }
  );

  // 11. tap
  tool(
    'tap',
    'Tap the screen at a point. Coordinates are normalized 0.0-1.0 (fraction of screen width/height), not pixels — e.g. x=0.5, y=0.5 is the center. Set screenshot:true to get a fresh screenshot back after the tap so you can see the result in one call.',
    {
      deviceId: z.string(),
      x: z.number().min(0).max(1).describe('Horizontal position, 0 = left edge, 1 = right edge'),
      y: z.number().min(0).max(1).describe('Vertical position, 0 = top edge, 1 = bottom edge'),
      screenshot: z.boolean().optional().describe('If true, return a fresh screenshot of the screen after tapping (default false).'),
    },
    async ({ deviceId, x, y, screenshot }, { authInfo }) => {
      const r = await runControl(authInfo.userId, deviceId, { type: 'control', action: 'tap', x, y });
      if (r.err) return r.err;
      return maybeScreenshot(authInfo.userId, deviceId, textResult(`Tapped (${x}, ${y}).${r.note}`), screenshot);
    }
  );

  // 12. long_press
  tool(
    'long_press',
    'Press and hold at a point — opens context menus, enters selection/edit mode, moves icons. Coordinates are normalized 0.0-1.0.',
    {
      deviceId: z.string(),
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      ms: z.number().int().min(400).max(3000).optional().describe('Hold duration in ms (default 700)'),
      screenshot: z.boolean().optional().describe('Return a fresh screenshot afterwards (default false)'),
    },
    async ({ deviceId, x, y, ms, screenshot }, { authInfo }) => {
      const holdMs = clamp(ms ?? 700, 400, 3000);
      const r = await runControl(authInfo.userId, deviceId, {
        type: 'control', action: 'swipe',
        x1: x, y1: y, x2: clamp(x + 0.002, 0, 1), y2: clamp(y + 0.002, 0, 1), ms: holdMs,
      }, holdMs + 5000);
      if (r.err) return r.err;
      return maybeScreenshot(authInfo.userId, deviceId, textResult(`Long-pressed (${x}, ${y}) for ${holdMs}ms.${r.note}`), screenshot);
    }
  );

  // 13. swipe
  tool(
    'swipe',
    'Swipe from one point to another with precise coordinates (normalized 0.0-1.0). For simple list/page navigation prefer the `scroll` tool instead.',
    {
      deviceId: z.string(),
      x1: z.number().min(0).max(1),
      y1: z.number().min(0).max(1),
      x2: z.number().min(0).max(1),
      y2: z.number().min(0).max(1),
      ms: z.number().int().min(50).max(5000).optional().describe('Swipe duration in milliseconds (default 300)'),
      screenshot: z.boolean().optional().describe('Return a fresh screenshot afterwards (default false)'),
    },
    async ({ deviceId, x1, y1, x2, y2, ms, screenshot }, { authInfo }) => {
      const durationMs = ms || 300;
      const r = await runControl(authInfo.userId, deviceId, {
        type: 'control', action: 'swipe', x1, y1, x2, y2, ms: durationMs,
      }, durationMs + 5000);
      if (r.err) return r.err;
      return maybeScreenshot(authInfo.userId, deviceId, textResult(`Swiped (${x1}, ${y1}) → (${x2}, ${y2}).${r.note}`), screenshot);
    }
  );

  // 14. scroll
  tool(
    'scroll',
    'Scroll the screen in a direction — the easy way to move through lists, feeds, and home-screen pages. direction is where the CONTENT moves: "down" reveals content further down the page, "up" goes back up, "left"/"right" flip pages.',
    {
      deviceId: z.string(),
      direction: z.enum(['up', 'down', 'left', 'right']),
      amount: z.number().min(0.1).max(0.9).optional().describe('Fraction of the screen to travel (default 0.6). Larger = scrolls further.'),
      screenshot: z.boolean().optional().describe('Return a fresh screenshot afterwards (default false)'),
    },
    async ({ deviceId, direction, amount, screenshot }, { authInfo }) => {
      const g = scrollGesture(direction, amount);
      if (!g) return textResult('direction must be up, down, left, or right.', true);
      const r = await runControl(authInfo.userId, deviceId, { type: 'control', action: 'swipe', ...g, ms: 260 });
      if (r.err) return r.err;
      return maybeScreenshot(authInfo.userId, deviceId, textResult(`Scrolled ${direction}.${r.note}`), screenshot);
    }
  );

  // 14b. collect_list
  tool(
    'collect_list',
    'Read a whole scrolling list in one call (playlist, contacts, chats, results, settings) instead of scroll + get_ui_tree loops. Scrolls to the top, then to the end, and returns one numbered row per item (texts joined with " | "); fixed bars and labels every row repeats are removed. Text only: use get_ui_tree to get coordinates. Main vertical list only, not carousels. On feeds that refresh when pulled down, pass fromTop:false. A few rows may repeat; drop them yourself. Stops after ~45 s: if the end was not reached, call again with fromTop:false.',
    {
      deviceId: z.string().describe('Device id from list_devices'),
      fromTop: z.boolean().optional().describe('Start at the top (default true); false = from here down.'),
      maxScrolls: z.coerce.number().int().min(1).max(150).optional().describe('Max scroll steps (default 60).'),
      amount: z.coerce.number().min(0.2).max(0.6).optional().describe('Step size (default 0.4). Smaller = slower but never skips rows.'),
      descriptions: z.boolean().optional().describe('Include labels of icon-only rows (default false).'),
      keepRepeated: z.boolean().optional().describe('Keep labels repeated on every row (default false).'),
    },
    async ({ deviceId, fromTop, maxScrolls, amount, descriptions, keepRepeated }, extra) => {
      const { userId } = extra.authInfo;
      const deadline = Date.now() + COLLECT_BUDGET_MS;
      const outOfTime = () => Date.now() >= deadline;
      // Progress notifications let clients that support it keep waiting.
      const progressToken = extra._meta && extra._meta.progressToken;
      let progress = 0;
      const tick = async (message) => {
        progress++;
        if (progressToken === undefined || !extra.sendNotification) return;
        try {
          await extra.sendNotification({ method: 'notifications/progress', params: { progressToken, progress, message } });
        } catch { /* progress is best effort */ }
      };
      if (!signaling.presence.isOnline(userId, deviceId)) return offline();
      if (!signaling.deviceSupports(userId, deviceId, 'ui_tree')) {
        return textResult('This phone build cannot read the UI tree — update the app.', true);
      }
      const limit = maxScrolls || 60;
      const step = amount || 0.4;
      const read = async () => {
        const t = await fetchUiTree(userId, deviceId, false, 8000);
        if (t.error) throw new Error(CONTROL_ERRORS[t.error] || t.error);
        return { pkg: t.package || null, labels: screenLabels(t.nodes || [], { descriptions: !!descriptions }) };
      };
      const scrollBy = async (direction, amt) => {
        const g = scrollGesture(direction, amt);
        const r = await runControl(userId, deviceId, { type: 'control', action: 'swipe', ...g, ms: 260 });
        if (r.err) throw Object.assign(new Error('scroll failed'), { result: r.err });
        await sleep(COLLECT_SETTLE_MS);
      };
      try {
        let cur = await read();
        if (!cur.labels.length) {
          return textResult('The screen has no readable text. It is probably off or locked, or the list is drawn in a way that blocks accessibility. Try take_screenshot to look.', true);
        }
        const app = cur.pkg;
        const notes = [];

        let scrollsUp = 0;
        if (fromTop !== false) {
          while (scrollsUp < 60) {
            if (outOfTime()) {
              return textResult(`Still scrolling up to the top of the list after ${scrollsUp} scrolls when the ${COLLECT_BUDGET_MS / 1000} s time limit ran out, so nothing was collected yet. Call collect_list again: it carries on from here, closer to the top.`, true);
            }
            await scrollBy('up', 0.9);
            scrollsUp++;
            await tick(`Scrolling to the top (${scrollsUp})`);
            const next = await read();
            if (next.pkg !== app) { notes.push('The app changed while scrolling to the top, so the result may start mid-list.'); break; }
            if (sameScreen(cur.labels, next.labels)) break;
            cur = next;
          }
          if (scrollsUp >= 60) notes.push('Did not reach the top after 60 scrolls; the list starts at the position where scrolling stopped.');
        }

        const screens = [];
        let scrolls = 0;
        let reachedEnd = false;
        let timedOut = false;
        for (;;) {
          screens.push(cur.labels);
          if (scrolls >= limit) break;
          if (outOfTime()) { timedOut = true; break; }
          await scrollBy('down', step);
          scrolls++;
          await tick(`Reading the list (${screens.length} screens)`);
          const next = await read();
          if (next.pkg !== app) { notes.push('The app changed while scrolling down, so the list may be cut short.'); break; }
          if (sameScreen(cur.labels, next.labels)) { reachedEnd = true; break; }
          cur = next;
        }

        const merged = mergeScreens(screens);
        const cleaned = keepRepeated ? { labels: merged.labels, dropped: [] } : dropRepeated(merged.labels);
        let rows = toRows(cleaned.labels);
        if (rows.length > COLLECT_MAX_ROWS) {
          notes.push(`Only the first ${COLLECT_MAX_ROWS} rows are shown.`);
          rows = rows.slice(0, COLLECT_MAX_ROWS);
        }

        const head = [`Collected ${rows.length} rows from ${app || 'the foreground app'} (${screens.length} screens, ${scrolls} scrolls down${scrollsUp ? `, ${scrollsUp} up to reach the top` : ''}).`];
        if (reachedEnd) head.push('Reached the end of the list.');
        else if (timedOut) head.push(`The end of the list was NOT reached: stopped at the ${COLLECT_BUDGET_MS / 1000} s time limit. Call again with fromTop:false to read the rest; its first few rows repeat the last few here.`);
        else head.push(`The end of the list was NOT reached (stopped at maxScrolls=${limit}). Call again with a higher maxScrolls, or fromTop:false to continue from here.`);
        if (screens.length === 1) head.push('The whole list fit on one screen, so title and bottom bars could not be told apart from rows and may be included.');
        if (merged.gaps) head.push(`${merged.gaps} step(s) did not line up with the previous screen, so a few rows there may repeat; drop repeats yourself. Only if rows look missing, call again with a smaller amount (for example 0.35).`);
        if (merged.dropped.length) head.push(`Removed fixed bars: ${merged.dropped.map((t) => `"${t}"`).join(', ')}.`);
        if (cleaned.dropped.length) head.push(`Removed labels repeated on every row: ${cleaned.dropped.map((d) => `"${d.text}" (x${d.count})`).join(', ')}. Pass keepRepeated:true to keep them.`);
        head.push(...notes);
        return textResult(`${head.join('\n')}\n\n${rows.map((r, i) => `${i + 1}. ${r}`).join('\n')}`);
      } catch (e) {
        if (e.result) return e.result;
        return textResult(e.message, true);
      }
    }
  );

  // 15. type_text
  tool(
    'type_text',
    'Type into the focused field (tap it first). Inserted at the cursor; replace:true overwrites everything in the box (number, word or sentence). If it reports success but nothing appears (WhatsApp etc.), retry with method:"paste". submit:true presses Enter (searches; tap Send for chats).',
    {
      deviceId: z.string(),
      text: z.string(),
      method: z.enum(['set', 'paste']).optional().describe('"set" (default) writes directly; "paste" goes through the clipboard.'),
      // Clients with a tool list cached from before this option existed send it as "true"/"false".
      replace: z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean().optional()).describe('Overwrite the whole box instead of inserting (default false).'),
      submit: z.boolean().optional().describe('Press Enter after typing, e.g. to execute a search (default false)'),
      screenshot: z.boolean().optional().describe('Return a fresh screenshot afterwards (default false)'),
    },
    async ({ deviceId, text, method, replace, submit, screenshot }, { authInfo }) => {
      const paste = method === 'paste';
      if (paste && !signaling.deviceSupports(authInfo.userId, deviceId, 'paste')) {
        return textResult('This phone build does not support paste-typing — update the app, or call type_text without method:"paste".', true);
      }
      if (replace && !signaling.deviceSupports(authInfo.userId, deviceId, 'replace_text')) {
        return textResult('This phone build cannot replace text — update the app. Meanwhile, long_press the text to select it (for a sentence, then tap "Select all"), and type_text with method:"paste" without replace.', true);
      }
      const r = await runControl(authInfo.userId, deviceId, {
        type: 'control', action: paste ? 'paste' : 'text', value: text, ...(replace ? { replace: true } : {}),
      });
      if (r.err) return r.err;
      let submitted = '';
      if (submit) {
        await sleep(150);
        const enter = await runControl(authInfo.userId, deviceId, { type: 'control', action: 'keyevent', keycode: 'KEYCODE_ENTER' });
        submitted = enter.err ? ' (but Enter was not accepted — the text is typed but not submitted)' : ' and submitted';
      }
      return maybeScreenshot(authInfo.userId, deviceId, textResult(`Text ${replace ? 'replaced' : paste ? 'pasted' : 'typed'}${submitted}.${r.note}`), screenshot);
    }
  );

  // 16. press_key
  tool(
    'press_key',
    'Press a system key or button. back/home/recents navigate; enter submits and delete backspaces in a focused text field; notifications/quick_settings open those shades; lock locks the screen; volume_up/volume_down change media volume.',
    {
      deviceId: z.string(),
      key: z.enum(['back', 'home', 'recents', 'enter', 'delete', 'notifications', 'quick_settings', 'lock', 'volume_up', 'volume_down']),
      screenshot: z.boolean().optional().describe('Return a fresh screenshot afterwards (default false)'),
    },
    async ({ deviceId, key, screenshot }, { authInfo }) => {
      const keycode = KEY_MAP[key];
      if (!keycode) return textResult(`key must be one of: ${KEY_NAMES.join(', ')}.`, true);
      const r = await runControl(authInfo.userId, deviceId, { type: 'control', action: 'keyevent', keycode });
      if (r.err) return r.err;
      return maybeScreenshot(authInfo.userId, deviceId, textResult(`Pressed ${key}.${r.note}`), screenshot);
    }
  );

  // 17. open_app
  tool(
    'open_app',
    'Open an app on the device by name (e.g. "YouTube", "Settings", "WhatsApp") — matched against installed apps by label — or by exact package name. This is the fastest way to launch an app; prefer it over hunting through the app drawer.',
    {
      deviceId: z.string(),
      name: z.string().optional().describe('App name to search for, e.g. "YouTube". Case-insensitive, matches partial names.'),
      package: z.string().optional().describe('Exact package name (e.g. com.google.android.youtube), if you know it — overrides name.'),
      screenshot: z.boolean().optional().describe('Return a screenshot after launching (default true)'),
    },
    async ({ deviceId, name, package: pkg, screenshot }, { authInfo }) => {
      if (!name && !pkg) return textResult('Provide an app name or package.', true);
      if (!signaling.presence.isOnline(authInfo.userId, deviceId)) return offline();
      try {
        const reply = await signaling.requestFromPhone(authInfo.userId, deviceId, (id) => ({
          type: 'open_app', id, query: name || '', package: pkg || '',
        }));
        if (!reply.ok) return textResult(reply.error || 'Could not open the app.', true);
        const base = textResult(`Opened ${reply.launched} (${reply.package}).`);
        return maybeScreenshot(authInfo.userId, deviceId, base, screenshot !== false);
      } catch (e) {
        return textResult(e.message, true);
      }
    }
  );

  // 18. open_app_drawer
  tool(
    'open_app_drawer',
    'Go to the home screen and open the app drawer (swipe up from the bottom), where the app search bar lives. Follow with take_screenshot, then tap the search bar and type an app name to find and open any app.',
    {
      deviceId: z.string(),
      screenshot: z.boolean().optional().describe('Return a fresh screenshot afterwards (default true)'),
    },
    async ({ deviceId, screenshot }, { authInfo }) => {
      const home = await runControl(authInfo.userId, deviceId, { type: 'control', action: 'keyevent', keycode: 'KEYCODE_HOME' });
      if (home.err) return home.err;
      await sleep(400);
      const up = await runControl(authInfo.userId, deviceId, { type: 'control', action: 'swipe', x1: 0.5, y1: 0.92, x2: 0.5, y2: 0.25, ms: 250 });
      if (up.err) return up.err;
      return maybeScreenshot(authInfo.userId, deviceId, textResult(`Opened the app drawer. Tap the search bar and type an app name to find it.${up.note}`), screenshot !== false);
    }
  );

  // 19. wait
  tool(
    'wait',
    'Pause for a few seconds to let the screen finish loading or animating before the next action.',
    {
      deviceId: z.string(),
      seconds: z.number().min(0.2).max(15).optional().describe('How long to wait (default 1.5)'),
      screenshot: z.boolean().optional().describe('Return a screenshot after waiting (default false)'),
    },
    async ({ deviceId, seconds, screenshot }, { authInfo }) => {
      if (!signaling.presence.isOnline(authInfo.userId, deviceId)) return offline();
      const secs = clamp(seconds ?? 1.5, 0.2, 15);
      await sleep(secs * 1000);
      return maybeScreenshot(authInfo.userId, deviceId, textResult(`Waited ${secs}s.`), screenshot);
    }
  );

  // 20. ring
  tool(
    'ring',
    'Play a ringtone on the device at full volume, even in silent mode — useful for locating a lost phone.',
    { deviceId: z.string() },
    async ({ deviceId }, { authInfo }) => {
      if (!signaling.sendToPhone(authInfo.userId, deviceId, { type: 'ring' })) return offline();
      return textResult('Ringing device.');
    }
  );

  // 21. flash_light
  tool(
    'flash_light',
    'Blink the device\'s camera flash a few times.',
    {
      deviceId: z.string(),
      count: z.number().int().min(1).max(10).optional().describe('Number of blinks (default 3)'),
    },
    async ({ deviceId, count }, { authInfo }) => {
      if (!signaling.sendToPhone(authInfo.userId, deviceId, { type: 'flash', count: count ?? 3 })) return offline();
      return textResult('Flashing light.');
    }
  );

  // 22. list_files
  tool(
    'list_files',
    'List a folder on the phone (under /storage/emulated/0; outside paths are clamped to it). Compact: one header with the folder path, then one row per entry: name (folders end with /) | size | modified date. A file\'s full path is the folder path + "/" + name. Shows 60 entries by default; use filter, sort and offset for big folders.',
    {
      deviceId: z.string(),
      path: z.string().optional().describe('Folder path under /storage/emulated/0 (default: the root)'),
      filter: z.string().optional().describe('Only names containing this (case-insensitive)'),
      sort: z.enum(['name', 'newest', 'largest']).optional().describe('name (default; folders first), newest, or largest'),
      limit: z.coerce.number().int().min(1).max(500).optional().describe('Max entries to show (default 60)'),
      offset: z.coerce.number().int().min(0).optional().describe('Skip this many entries, to page through a big folder'),
    },
    async ({ deviceId, path, filter, sort, limit, offset }, { authInfo }) => {
      try {
        const safePath = confineToBase(path);
        const reply = await signaling.requestFromPhone(authInfo.userId, deviceId, (id) => ({
          type: 'pf_list', id, path: safePath,
        }));
        return textResult(formatFileList(reply.path || safePath, reply.entries || [], { filter, sort, limit, offset }));
      } catch (e) {
        return textResult(e.message, true);
      }
    }
  );

  // 23. get_file
  tool(
    'get_file',
    'Fetch a file FROM the phone. Step 1: call this tool with the file\'s absolute path (find it with list_files); the server pulls the file off the phone and returns a one-time download_url. Step 2: with a shell, curl -sS -o "<local-path>" "<download_url>"; without a shell, give the user the download_url to click. Max 100 MB.',
    {
      deviceId: z.string(),
      path: z.string().describe('Absolute file path on the phone under /storage/emulated/0'),
    },
    async ({ deviceId, path }, { authInfo }) => {
      if (!signaling.presence.isOnline(authInfo.userId, deviceId)) return offline();
      const safePath = confineToBase(path);
      try {
        let buffer;
        try {
          buffer = await signaling.downloadFromPhone(authInfo.userId, deviceId, safePath, { maxBytes: MAX_GET_FILE_BYTES });
        } catch (e) {
          if (!/no data from the phone|lost in transit/i.test(e.message)) throw e;
          await sleep(10000);
          if (!signaling.presence.isOnline(authInfo.userId, deviceId)) return offline();
          buffer = await signaling.downloadFromPhone(authInfo.userId, deviceId, safePath, { maxBytes: MAX_GET_FILE_BYTES });
        }
        if (!buffer.length) return textResult(`${safePath} is empty (0 bytes) — nothing to download.`, true);
        pruneDownloads();
        const token = crypto.randomBytes(24).toString('base64url');
        const name = safePath.split('/').pop() || 'file';
        pendingDownloads.set(token, { buffer, name, expiresAt: Date.now() + DOWNLOAD_TTL_MS });
        const downloadUrl = `${authInfo.baseUrl}/mcp/download/${token}`;
        return textResult({
          download_url: downloadUrl,
          file: safePath,
          bytes: buffer.length,
          expires_in_seconds: DOWNLOAD_TTL_MS / 1000,
          next_step: `With a shell: curl -sS -o "${name}" "${downloadUrl}". WITHOUT a shell: give the user the download_url to click.`,
        });
      } catch (e) {
        return textResult(e.message, true);
      }
    }
  );

  // delete_file
  tool(
    'delete_file',
    'PERMANENTLY delete one file on the phone, by its full path (find it with list_files). No recycle bin, no undo. Only a single file: folders are refused, and nothing outside /storage/emulated/0. Only after the user asked to delete that specific file, and after any copy they wanted (get_file) has reached the PC. Checks the file is gone and says so.',
    {
      deviceId: z.string(),
      path: z.string().describe('Full path of the file, e.g. /storage/emulated/0/Download/report.pdf'),
    },
    async ({ deviceId, path }, { authInfo }) => {
      if (!signaling.presence.isOnline(authInfo.userId, deviceId)) return offline();
      const safePath = confineToBase(path);
      const slash = safePath.lastIndexOf('/');
      const parent = safePath.slice(0, slash) || PHONE_BASE;
      const name = safePath.slice(slash + 1);
      if (safePath === PHONE_BASE || !name) return textResult('Pass the path of a single file, not the storage root.', true);
      try {
        const listParent = async () => {
          const reply = await signaling.requestFromPhone(authInfo.userId, deviceId, (id) => ({ type: 'pf_list', id, path: parent }));
          return (reply.entries || []).find((e) => e.name === name);
        };
        const entry = await listParent();
        if (!entry) return textResult(`${safePath} does not exist (nothing deleted). Check the path with list_files.`, true);
        if (entry.type === 'dir') return textResult(`${safePath} is a folder. delete_file only deletes single files; nothing deleted.`, true);
        await signaling.requestFromPhone(authInfo.userId, deviceId, (id) => ({ type: 'pf_delete', id, path: safePath }));
        // The phone answers "ok" even when the file could not be removed, so look again.
        if (await listParent()) return textResult(`The phone did not remove ${safePath} (it may be in use or protected). Nothing else was changed.`, true);
        return textResult(`Deleted ${safePath}${entry.size != null ? ` (${humanSize(entry.size)})` : ''}. Verified gone.`);
      } catch (e) {
        return textResult(e.message, true);
      }
    }
  );

  // 24. send_local_file
  tool(
    'send_local_file',
    'Send a file from the user\'s computer to the phone — the right tool for files on disk, no base64 needed. Step 1: call this tool with the destination file name (and optional folder); it returns a one-time upload_url. Step 2: POST the raw bytes to the upload_url. Saves to /storage/emulated/0/<folder>/<name>. Max 100 MB.',
    {
      deviceId: z.string(),
      name: z.string().describe('File name to save as on the phone, e.g. "photo.png"'),
      folder: z.string().optional().describe('Destination folder under /storage/emulated/0 (default "Download")'),
    },
    async ({ deviceId, name, folder }, { authInfo }) => {
      const fileName = String(name || '').replace(/[/\\]/g, '').trim();
      if (!fileName) return textResult('name must be a plain file name (no slashes).', true);
      if (!signaling.presence.isOnline(authInfo.userId, deviceId)) return offline();
      const destFolder = confineToBase(
        folder
          ? (String(folder).startsWith('/') ? folder : `${PHONE_BASE}/${folder}`)
          : `${PHONE_BASE}/Download`
      );
      pruneUploads();
      const token = crypto.randomBytes(24).toString('base64url');
      const dest = `${destFolder}/${fileName}`;
      pendingUploads.set(token, { userId: authInfo.userId, deviceId, dest, expiresAt: Date.now() + UPLOAD_TTL_MS });
      const uploadUrl = `${authInfo.baseUrl}/mcp/upload/${token}`;
      return textResult({
        upload_url: uploadUrl,
        saves_to: dest,
        expires_in_seconds: UPLOAD_TTL_MS / 1000,
        next_step: `With a shell: curl -sS -X POST -H "Content-Type: application/octet-stream" --data-binary @"<local-file-path>" "${uploadUrl}". WITHOUT a shell: open the upload_url in a browser.`,
      });
    }
  );

  // 25. send_file
  tool(
    'send_file',
    'Send a small file to the device\'s shared storage with the content passed inline as base64. Saves to /storage/emulated/0/<folder>/<name> (folder defaults to Download). Max 18 MB.',
    {
      deviceId: z.string(),
      name: z.string().describe('File name to save as, e.g. "photo.png"'),
      data_base64: z.string().describe('File content, base64-encoded'),
      folder: z.string().optional().describe('Destination folder under /storage/emulated/0 (default "Download")'),
    },
    async ({ deviceId, name, data_base64, folder }, { authInfo }) => {
      const fileName = String(name || '').replace(/[/\\]/g, '').trim();
      if (!fileName) return textResult('name must be a plain file name (no slashes).', true);
      let bytes;
      try {
        bytes = Buffer.from(data_base64, 'base64');
      } catch {
        return textResult('data_base64 is not valid base64.', true);
      }
      if (bytes.length === 0) return textResult('Decoded file is empty — check data_base64.', true);
      if (bytes.length > MAX_SEND_FILE_BYTES) {
        return textResult(`File is ${(bytes.length / 1048576).toFixed(1)} MB — max is ${MAX_SEND_FILE_BYTES / 1048576} MB.`, true);
      }
      const destFolder = confineToBase(
        folder
          ? (String(folder).startsWith('/') ? folder : `${PHONE_BASE}/${folder}`)
          : `${PHONE_BASE}/Download`
      );
      try {
        const dest = await signaling.uploadToPhone(authInfo.userId, deviceId, `${destFolder}/${fileName}`, bytes);
        return textResult(`Saved ${fileName} (${bytes.length} bytes) to ${dest} on the phone.`);
      } catch (e) {
        return textResult(e.message, true);
      }
    }
  );

  // 26. send_url
  tool(
    'send_url',
    'Download a file from a public http(s) URL and save it to the phone. The server fetches the bytes itself — saves to /storage/emulated/0/<folder>/<name>. Max 100 MB.',
    {
      deviceId: z.string(),
      url: z.string().describe('Public http(s) URL of the file to download'),
      name: z.string().optional().describe('File name to save as on the phone (defaults to the name from the URL)'),
      folder: z.string().optional().describe('Destination folder under /storage/emulated/0 (default "Download")'),
    },
    async ({ deviceId, url, name, folder }, { authInfo }) => {
      if (!signaling.presence.isOnline(authInfo.userId, deviceId)) return offline();
      if (!url || !/^https?:\/\//i.test(String(url))) return textResult('Provide a valid http(s) URL.', true);
      let fetched;
      try {
        fetched = await downloadUrl(String(url), MAX_TRANSFER_BYTES);
      } catch (e) {
        return textResult(`Couldn't fetch that URL: ${e.message}`, true);
      }
      if (!fetched.buffer.length) return textResult('The downloaded file is empty.', true);
      const fileName = String(name || fetched.urlName || 'file').replace(/[/\\]/g, '').trim() || 'file';
      const destFolder = confineToBase(
        folder
          ? (String(folder).startsWith('/') ? folder : `${PHONE_BASE}/${folder}`)
          : `${PHONE_BASE}/Download`
      );
      try {
        const dest = await signaling.uploadToPhone(authInfo.userId, deviceId, `${destFolder}/${fileName}`, fetched.buffer);
        return textResult(`Downloaded ${fetched.buffer.length} bytes and saved to ${dest} on the phone.`);
      } catch (e) {
        return textResult(e.message, true);
      }
    }
  );

  return server;
}

function setupMcpRoutes(app) {
  // One-time upload target for send_local_file
  app.post('/mcp/upload/:token', express.raw({ type: () => true, limit: '110mb' }), async (req, res) => {
    const upload = pendingUploads.get(req.params.token);
    if (upload) pendingUploads.delete(req.params.token);
    if (!upload || upload.expiresAt < Date.now()) {
      return res.status(410).json({ ok: false, error: 'Upload link is invalid or expired — call the send_local_file tool again for a fresh one.' });
    }
    const bytes = req.body;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      return res.status(400).json({ ok: false, error: 'No file bytes received — send the raw file with Content-Type: application/octet-stream.' });
    }
    if (bytes.length > MAX_TRANSFER_BYTES) {
      return res.status(413).json({ ok: false, error: `File is ${(bytes.length / 1048576).toFixed(1)} MB — max is ${MAX_TRANSFER_BYTES / 1048576} MB.` });
    }
    try {
      const dest = await signaling.uploadToPhone(upload.userId, upload.deviceId, upload.dest, bytes);
      res.json({ ok: true, saved: dest, bytes: bytes.length });
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message });
    }
  });

  // Browser dashboard upload
  app.post('/api/phone-files/upload', express.raw({ type: () => true, limit: '110mb' }), async (req, res) => {
    const token = req.headers.authorization?.replace(/^Bearer /, '') || req.query.token;
    const payload = token && verifyToken(token);
    if (!payload) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    const deviceId = String(req.query.deviceId || '');
    const dest = confineToBase(String(req.query.path || ''));
    if (!deviceId) return res.status(400).json({ ok: false, error: 'deviceId required' });
    if (!signaling.presence.isOnline(payload.uid, deviceId)) {
      return res.status(503).json({ ok: false, error: 'Phone not connected' });
    }
    const bytes = req.body;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      return res.status(400).json({ ok: false, error: 'No file bytes received.' });
    }
    if (bytes.length > MAX_TRANSFER_BYTES) {
      return res.status(413).json({ ok: false, error: `File is ${(bytes.length / 1048576).toFixed(1)} MB — max is ${MAX_TRANSFER_BYTES / 1048576} MB.` });
    }
    try {
      const saved = await signaling.uploadToPhone(payload.uid, deviceId, dest, bytes);
      res.json({ ok: true, saved, bytes: bytes.length });
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message });
    }
  });

  // Browser HTML face of upload token
  app.get('/mcp/upload/:token', (req, res) => {
    const upload = pendingUploads.get(req.params.token);
    if (!upload || upload.expiresAt < Date.now()) {
      return res.status(410).send('<h3>This upload link is invalid or already used.</h3><p>Ask for a fresh one (call send_local_file again).</p>');
    }
    const mins = Math.max(1, Math.round((upload.expiresAt - Date.now()) / 60000));
    res.send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Send file to phone</title>
<body style="font-family:system-ui;max-width:480px;margin:48px auto;padding:0 16px;text-align:center;">
<h2>📱 Send a file to your phone</h2>
<p>Saves to <code>${upload.dest.replace(/</g, '&lt;')}</code><br><small>Link works once, expires in ~${mins} min. Max ${MAX_TRANSFER_BYTES / 1048576} MB.</small></p>
<input type="file" id="f" style="margin:16px 0;">
<br><button id="go" style="padding:10px 28px;font-size:16px;cursor:pointer;">Upload</button>
<p id="out"></p>
<script>
document.getElementById('go').onclick = async () => {
  const file = document.getElementById('f').files[0];
  const out = document.getElementById('out');
  if (!file) { out.textContent = 'Pick a file first.'; return; }
  out.textContent = 'Uploading ' + file.name + '…';
  try {
    const r = await fetch(location.href, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
    const j = await r.json();
    out.textContent = j.ok ? '✅ Saved to ' + j.saved + ' (' + j.bytes + ' bytes)' : '❌ ' + j.error;
  } catch (e) { out.textContent = '❌ ' + e.message; }
};
</script></body>`);
  });

  // One-time download source for get_file
  app.get('/mcp/download/:token', (req, res) => {
    const d = pendingDownloads.get(req.params.token);
    if (d) pendingDownloads.delete(req.params.token);
    if (!d || d.expiresAt < Date.now()) {
      return res.status(410).json({ ok: false, error: 'Download link is invalid or expired — call the get_file tool again for a fresh one.' });
    }
    res.setHeader('Content-Type', mime.lookup(d.name) || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${d.name.replace(/"/g, '')}"`);
    res.send(d.buffer);
  });

  // Cursor/Claude compatibility probes
  const notAllowedSse = (_req, res) => {
    res.set('Allow', 'POST').status(405).json({
      jsonrpc: '2.0', error: { code: -32000, message: 'Method Not Allowed: this server does not support server-initiated SSE.' },
    });
  };
  const notAllowedDelete = (_req, res) => {
    res.set('Allow', 'POST').status(405).json({
      jsonrpc: '2.0', error: { code: -32000, message: 'Method Not Allowed: this server has no session to delete (single-request mode).' },
    });
  };

  app.get('/mcp', notAllowedSse);
  app.delete('/mcp', notAllowedDelete);

  // Main MCP JSON-RPC handler powered by Anthropic's official SDK
  app.post('/mcp', async (req, res) => {
    const token = req.headers.authorization?.replace(/^Bearer /, '');
    const payload = token && verifyToken(token);
    const baseUrl = `${process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`}`.replace(/\/$/, '');
    if (!payload) {
      res.set('WWW-Authenticate', `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`);
      return res.status(401).json({ error: 'unauthorized' });
    }

    // Notifications carry no `id` and expect no response body
    if (req.body && req.body.id === undefined && req.body.method?.startsWith('notifications/')) {
      return res.status(202).end();
    }

    // Ensure Accept header includes text/event-stream so SDK's HTTP transport validation passes
    if (!req.headers.accept?.includes('application/json')) {
      req.headers.accept = 'application/json, text/event-stream';
    } else if (!req.headers.accept.includes('text/event-stream')) {
      req.headers.accept = req.headers.accept + ', text/event-stream';
    }

    // Attach authInfo to req so the SDK transport attaches it to extra.authInfo in tool handlers
    req.auth = {
      userId: payload.uid,
      email: payload.email,
      baseUrl,
    };

    try {
      // Create stateless Streamable HTTP transport with JSON response mode
      const transport = new StreamableHTTPServerTransport({
        enableJsonResponse: true,
        sessionIdGenerator: undefined,
      });

      const server = createPhoneRemoteServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('MCP SDK request failed:', e);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', id: req.body?.id || null, error: { code: -32603, message: 'Internal error' } });
      }
    }
  });
}

module.exports = { setupMcpRoutes, createPhoneRemoteServer };
