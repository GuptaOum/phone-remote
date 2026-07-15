const express = require('express');
const crypto = require('crypto');
const sharp = require('sharp');
const mime = require('mime-types');
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
const SERVER_VERSION = '1.9.0';

// send_file: JSON body limit is 25 MB (index.js) and base64 inflates ~4/3,
// so cap the decoded payload safely below that.
const MAX_SEND_FILE_BYTES = 18 * 1024 * 1024;

// Raw-bytes paths (upload URL, send_url, get_file) never touch the model's
// context or the JSON body limit — the phone streams chunks to/from disk, so
// they can afford a much higher ceiling.
const MAX_TRANSFER_BYTES = 100 * 1024 * 1024;

// send_local_file: one-time upload URLs. The tool call reserves a token, the
// MCP client then POSTs the raw file bytes to /mcp/upload/<token> — the file
// never has to be base64'd through the model's context window.
const UPLOAD_TTL_MS = 10 * 60 * 1000;
const pendingUploads = new Map(); // token → { userId, deviceId, dest, expiresAt }
function pruneUploads() {
  const now = Date.now();
  for (const [token, u] of pendingUploads) if (u.expiresAt < now) pendingUploads.delete(token);
}

// get_file: the mirror image — the server pulls the file off the phone and
// holds it briefly under a one-time token; the MCP client GETs the raw bytes
// from /mcp/download/<token>, again bypassing the model's context window.
const DOWNLOAD_TTL_MS = 10 * 60 * 1000;
const MAX_GET_FILE_BYTES = MAX_TRANSFER_BYTES;
const pendingDownloads = new Map(); // token → { buffer, name, expiresAt }
function pruneDownloads() {
  const now = Date.now();
  for (const [token, d] of pendingDownloads) if (d.expiresAt < now) pendingDownloads.delete(token);
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

// The phone captures at full native resolution (JPEG q90) — far bigger than
// the model can use, and each image lingers in the conversation, so a long
// automation session fills the context until older screenshots get evicted.
// Shrink server-side before returning: explicit take_screenshot keeps the
// API's max useful long edge; act-and-see confirmation shots go leaner still.
const SCREENSHOT_MAX_EDGE = 1568;
const SCREENSHOT_ACT_MAX_EDGE = 1092;
const SCREENSHOT_JPEG_QUALITY = 70;

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
    name: 'get_device_status',
    description: 'Check a device\'s health before acting on it: battery level, whether the screen is on, whether the Accessibility Service (which performs all taps and typing) is enabled, the current foreground app, and network type. Call this first when a tap or type seems to do nothing, or at the start of a session — it catches "accessibility is off" up front instead of after several silent no-ops.',
    inputSchema: {
      type: 'object',
      properties: { deviceId: { type: 'string', description: 'Device id from list_devices' } },
      required: ['deviceId'],
    },
  },
  {
    name: 'get_foreground_app',
    description: 'Get the package name of the app currently on screen (e.g. com.whatsapp). A cheap way to confirm you are still in the right app after an action, without the cost of a full screenshot.',
    inputSchema: {
      type: 'object',
      properties: { deviceId: { type: 'string', description: 'Device id from list_devices' } },
      required: ['deviceId'],
    },
  },
  {
    name: 'get_ui_tree',
    description: 'Read the screen as structured data instead of an image: every visible text, button and input field, with the normalized x/y you can pass straight to tap. PREFER THIS OVER take_screenshot for finding and acting on things — it is far cheaper, has no capture throttle, and gives exact coordinates instead of estimates from pixels. Use take_screenshot only when you need to see something genuinely visual (an image, a layout problem, a CAPTCHA). Each node has: i (index), text, desc (accessibility label), id (resource id), cls (widget class), x/y (normalized centre — pass to tap), f (flags: c=clickable, e=editable/text field, s=scrollable, k=checkable, K=checked, f=focused, d=disabled).',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'Device id from list_devices' },
        all: { type: 'boolean', description: 'Include layout containers with no text or action (default false). Leave false unless the tree looks incomplete — it adds a lot of noise.' },
      },
      required: ['deviceId'],
    },
  },
  {
    name: 'wait_for',
    description: 'Wait until something appears on screen, then return. Polls the UI tree, so it returns the moment the condition is met instead of guessing a sleep duration like wait does. Use after any action that triggers loading, navigation or an animation. Give exactly one of text, id, or app.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'Device id from list_devices' },
        text: { type: 'string', description: 'Wait until this text (or accessibility label) appears — case-insensitive substring match' },
        id: { type: 'string', description: 'Wait until a view with this resource id appears, e.g. "send_button"' },
        app: { type: 'string', description: 'Wait until this package is in the foreground, e.g. "com.whatsapp"' },
        gone: { type: 'boolean', description: 'Invert: wait until the thing DISAPPEARS instead (e.g. a loading spinner). Default false.' },
        timeout: { type: 'number', description: 'Seconds to wait before giving up (default 10, max 60)' },
        screenshot: { type: 'boolean', description: 'If true, return a screenshot once the condition is met (default false)' },
      },
      required: ['deviceId'],
    },
  },
  {
    name: 'list_apps',
    description: 'List every app installed on the phone, with display name and package name. Use this when you are unsure what an app is called or whether it is installed, rather than guessing a package name at open_app.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'Device id from list_devices' },
        filter: { type: 'string', description: 'Optional case-insensitive substring to match against the name or package' },
      },
      required: ['deviceId'],
    },
  },
  {
    name: 'open_url',
    description: 'Open a URL or app deep link on the phone (https://…, tel:, mailto:, geo:, or an app scheme like whatsapp://). Often the most reliable way to get somewhere: a deep link jumps straight to the target screen instead of tapping through several, so it cannot mis-tap. Prefer it over open_app + navigation when a link for the destination exists.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'Device id from list_devices' },
        url: { type: 'string', description: 'The URL or deep link to open' },
        screenshot: { type: 'boolean', description: 'If true, return a screenshot after opening (default true)' },
      },
      required: ['deviceId', 'url'],
    },
  },
  {
    name: 'read_notifications',
    description: 'Read the phone\'s notifications — currently showing ones plus a short history of recent ones. This is how you get an OTP / 2FA code, a delivery confirmation, or an incoming message. Requires a separate one-time user grant on the phone (Settings → Notifications → Device & app notifications → Phone Remote), which is NOT the same as the Accessibility grant.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'Device id from list_devices' },
        filter: { type: 'string', description: 'Optional case-insensitive substring to match against the package, title or body — e.g. "whatsapp" or "code"' },
        limit: { type: 'number', description: 'Max notifications to return (default 20)' },
      },
      required: ['deviceId'],
    },
  },
  {
    name: 'take_screenshot',
    description: 'Capture and return the current screen of a device as a JPEG image. Requires the phone\'s Accessibility Service to be enabled. Call this first to see the screen before tapping. In long multi-step sessions, don\'t screenshot after every action — act with screenshot:false on intermediate steps and take one screenshot when you need to check state.',
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
        screenshot: { type: 'boolean', description: 'If true, return a fresh screenshot of the screen after tapping (default false). In long sessions keep this false on intermediate steps and check state occasionally.' },
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
    description: 'Type text into the currently focused input field (tap the field first). Set submit:true to press Enter after typing — use this to run a search once the query is typed. IF TYPING REPORTS SUCCESS BUT THE TEXT DOES NOT APPEAR (WhatsApp and some other apps ignore the standard method), retry with method:"paste".',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string' },
        text: { type: 'string' },
        method: {
          type: 'string',
          enum: ['set', 'paste'],
          description: 'How to enter the text. "set" (default) writes it directly. "paste" puts it on the phone\'s clipboard and pastes it — slower and it overwrites the clipboard, but it works in apps that ignore the direct method. Use "paste" as the fallback when "set" appears to do nothing.',
        },
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
    name: 'get_file',
    description: 'Fetch a file FROM the phone. Step 1: call this tool with the file\'s absolute path (find it with list_files); the server pulls the file off the phone and returns a one-time download_url. Step 2: with a shell, `curl -sS -o "<local-path>" "<download_url>"`; without a shell (claude.ai chat), give the user the download_url to click — the browser saves the file. The URL works once, within 10 minutes. Max 100 MB.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string' },
        path: { type: 'string', description: 'Absolute file path on the phone under /storage/emulated/0, e.g. /storage/emulated/0/Download/report.pdf (see list_files)' },
      },
      required: ['deviceId', 'path'],
    },
  },
  {
    name: 'send_local_file',
    description: 'Send a file from the user\'s computer to the phone — the right tool for files on disk, no base64 needed. Step 1: call this tool with the destination file name (and optional folder); it returns a one-time upload_url. Step 2: with a shell, POST the raw bytes: `curl -sS -X POST -H "Content-Type: application/octet-stream" --data-binary @"/path/to/file" "<upload_url>"`; without a shell (claude.ai chat), give the user the upload_url to open — it shows a file-picker page that uploads straight to the phone. Saves to /storage/emulated/0/<folder>/<name>. The URL works once, within 10 minutes. Max 100 MB.',
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
    description: 'Download a file from a public http(s) URL and save it to the phone. The server fetches the bytes itself — they never pass through this conversation — so this is the cheapest way to put an online image or file on the phone (no base64, no tokens for the content). Saves to /storage/emulated/0/<folder>/<name>. Max 100 MB.',
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

async function shrinkScreenshot(jpeg, maxEdge = SCREENSHOT_MAX_EDGE) {
  try {
    return await sharp(jpeg)
      .resize(maxEdge, maxEdge, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: SCREENSHOT_JPEG_QUALITY, mozjpeg: true })
      .toBuffer();
  } catch {
    return jpeg; // never fail a capture because of resizing
  }
}

// Android throttles AccessibilityService.takeScreenshot to ~1/sec; a chain of
// act-and-see calls can trip that intermittently, so retry once after a beat.
async function captureScreenshotWithRetry(userId, deviceId) {
  try {
    return await signaling.captureScreenshot(userId, deviceId);
  } catch (e) {
    if (!/capture_failed/i.test(e.message)) throw e;
    await sleep(700);
    return signaling.captureScreenshot(userId, deviceId);
  }
}

// A capture taken mid-animation (shade opening/closing), on a locked/off
// screen, or over protected content comes back as a near-uniform frame the
// model reads as "blank". Real UI always has texture, so a tiny per-channel
// standard deviation is a reliable blank detector.
async function looksBlank(jpeg) {
  try {
    const st = await sharp(jpeg).stats();
    return st.channels.every((c) => c.stdev < 4);
  } catch {
    return false;
  }
}

const BLANK_NOTE = '(warning: this screenshot appears blank/uniform. The screen may be off or locked, mid-animation, or showing content the device refuses to capture. Try press_key "home", or wait ~2s and take_screenshot again.)';

// Capture and only accept a screenshot with real content on it: on a blank
// frame, wait out the animation (and Android's 1-shot/sec throttle) and try
// again, up to 3 attempts. If it's still blank, return it anyway with a note
// telling the model what a blank frame means — never leave it guessing.
async function captureVerifiedScreenshot(userId, deviceId) {
  let jpeg;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(1200);
    jpeg = await captureScreenshotWithRetry(userId, deviceId);
    if (!(await looksBlank(jpeg))) return { jpeg };
  }
  return { jpeg, note: BLANK_NOTE };
}

// Append a fresh screenshot to a result when the caller asked for act-and-see.
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
    return { content: [...baseResult.content, { type: 'text', text: `(action succeeded, but the confirmation screenshot failed: ${e.message}. Call take_screenshot to see the current screen.)` }], isError: false };
  }
}

// Why a command didn't run, in terms the model can act on. The phone reports a
// short code; each maps to the actual next step rather than a bare failure.
const CONTROL_ERRORS = {
  accessibility_not_enabled:
    "Nothing happened: the phone's Accessibility Service is off, which is what performs taps and typing. Turn it on at Settings → Accessibility → Phone Remote. Until then every touch command will no-op.",
  no_focused_text_field:
    'Nothing was typed: no text field is focused. Tap the field first (tap with screenshot:true to confirm the cursor is in it), then type_text again.',
  gesture_rejected_by_system:
    'Android refused the gesture. The screen is likely off or locked, or a system dialog is capturing input. Take a screenshot to see the current screen; press_key "home" often clears it.',
  screen_size_unknown:
    'The phone has not reported its screen size yet, so the coordinates could not be resolved. Wait a second and retry.',
  key_not_accepted: 'The phone did not accept that key press.',
  paste_rejected:
    'The focused field refused the paste. Make sure a text field is focused (tap it first). If it is, the app may block pasting — try type_text without method:"paste".',
  unknown_action: 'The phone did not recognise that command — its app build is likely older than this server.',
};

// Appended when the phone is an older build with no ack support: the command
// was sent, but claiming it "worked" would be the exact false success we're
// trying to eliminate.
const UNCONFIRMED_NOTE =
  ' (Sent, but this phone build cannot confirm whether it actually ran — update the app for confirmed actions.)';

/**
 * Send a control command and hold the tool call until the phone confirms it
 * executed. Replaces bare sendToPhone for anything a user would notice failing:
 * sendToPhone only proved the bytes left the server, so a tap that never landed
 * still reported "Tapped".
 *
 * @returns {Promise<{err: object|null, note: string}>} err is a ready-to-return
 *   error result; when null the command genuinely ran.
 */
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
        true,
      ),
      note: '',
    };
  }
  if (!verdict.ok) {
    return {
      err: textResult(
        CONTROL_ERRORS[verdict.error] || `The phone could not run the command (${verdict.error || 'unknown reason'}).`,
        true,
      ),
      note: '',
    };
  }
  return { err: null, note: verdict.confirmed ? '' : UNCONFIRMED_NOTE };
}

// How often wait_for re-reads the tree. A tree read is cheap (text, no capture
// throttle), so this can be far tighter than a screenshot poll would allow.
const WAIT_POLL_MS = 600;

/** Read the phone's accessibility tree. Shared by get_ui_tree and wait_for. */
function fetchUiTree(userId, deviceId, all = false, timeoutMs = 10000) {
  return signaling.requestFromPhone(userId, deviceId, (id) => ({ type: 'ui_tree', id, all: !!all }), timeoutMs);
}

/** Does this tree satisfy the caller's condition? Exactly one of text/id/app. */
function treeMatches(tree, { text, id, app }) {
  if (app) return String(tree.package || '').toLowerCase().includes(app.toLowerCase());
  const nodes = tree.nodes || [];
  if (id) return nodes.some((n) => String(n.id || '').toLowerCase().includes(id.toLowerCase()));
  const needle = String(text).toLowerCase();
  // Match the accessibility label too — plenty of buttons are icon-only and
  // carry their name in contentDescription rather than text.
  return nodes.some((n) => `${n.text || ''} ${n.desc || ''}`.toLowerCase().includes(needle));
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

    case 'get_ui_tree': {
      if (!signaling.presence.isOnline(userId, deviceId)) return offline();
      if (!signaling.deviceSupports(userId, deviceId, 'ui_tree')) {
        return textResult('This phone build cannot read the UI tree — update the app.', true);
      }
      try {
        const t = await fetchUiTree(userId, deviceId, args.all);
        if (t.error) return textResult(CONTROL_ERRORS[t.error] || t.error, true);
        const nodes = t.nodes || [];
        if (!nodes.length) {
          return textResult('The screen reported no readable elements. It is probably off or locked, or showing content that blocks accessibility. Try press_key "home", or take_screenshot to look.', true);
        }
        const out = { app: t.package, nodes };
        if (t.truncated) out.note = `Truncated: only the first ${nodes.length} elements are listed. Scroll or narrow the screen to see the rest.`;
        return textResult(out);
      } catch (e) {
        return textResult(e.message, true);
      }
    }

    case 'wait_for': {
      const given = ['text', 'id', 'app'].filter((k) => args[k]);
      if (given.length !== 1) return textResult('Give exactly one of text, id, or app.', true);
      if (!signaling.presence.isOnline(userId, deviceId)) return offline();
      if (!signaling.deviceSupports(userId, deviceId, 'ui_tree')) {
        return textResult('This phone build cannot wait on screen state — update the app. (The dumb wait tool still works.)', true);
      }
      const timeoutMs = clamp(args.timeout ?? 10, 1, 60) * 1000;
      const want = !args.gone; // false => wait for it to disappear
      const what = args.text ? `"${args.text}"` : args.id ? `id "${args.id}"` : `app ${args.app}`;
      const started = Date.now();
      let last = null;
      while (Date.now() - started < timeoutMs) {
        try {
          const t = await fetchUiTree(userId, deviceId, false, 8000);
          // A hard error (accessibility off) will never resolve itself — fail
          // now rather than burning the whole timeout on it.
          if (t.error) return textResult(CONTROL_ERRORS[t.error] || t.error, true);
          last = t;
          if (treeMatches(t, args) === want) {
            const secs = ((Date.now() - started) / 1000).toFixed(1);
            return maybeScreenshot(
              userId, deviceId,
              textResult(`${what} ${want ? 'appeared' : 'disappeared'} after ${secs}s.`),
              args.screenshot,
            );
          }
        } catch (_) {
          // Transient: the phone can miss a poll mid-transition. Keep trying
          // until the deadline rather than failing the whole wait.
        }
        await sleep(WAIT_POLL_MS);
      }
      // Say what IS on screen — a bare timeout leaves the model guessing.
      const seen = (last?.nodes || []).map((n) => n.text || n.desc).filter(Boolean).slice(0, 8);
      const hint = last
        ? ` Currently in ${last.package || 'an unknown app'}; visible: ${seen.length ? seen.join(' | ') : '(nothing readable)'}.`
        : ' The phone never returned a readable screen.';
      return textResult(`Timed out after ${timeoutMs / 1000}s waiting for ${what} to ${want ? 'appear' : 'disappear'}.${hint}`, true);
    }

    case 'list_apps': {
      if (!signaling.presence.isOnline(userId, deviceId)) return offline();
      if (!signaling.deviceSupports(userId, deviceId, 'list_apps')) {
        return textResult('This phone build cannot list apps — update the app.', true);
      }
      try {
        const r = await signaling.requestFromPhone(userId, deviceId, (id) => ({ type: 'list_apps', id }), 15000);
        if (r.error) return textResult(`The phone could not list apps: ${r.error}`, true);
        let apps = r.apps || [];
        if (args.filter) {
          const f = String(args.filter).toLowerCase();
          apps = apps.filter((a) => `${a.name} ${a.package}`.toLowerCase().includes(f));
          if (!apps.length) return textResult(`No installed app matches "${args.filter}".`, true);
        }
        return textResult(apps);
      } catch (e) {
        return textResult(e.message, true);
      }
    }

    case 'open_url': {
      if (!args.url) return textResult('A url is required.', true);
      if (!signaling.presence.isOnline(userId, deviceId)) return offline();
      if (!signaling.deviceSupports(userId, deviceId, 'open_url')) {
        return textResult('This phone build cannot open URLs — update the app.', true);
      }
      try {
        const r = await signaling.requestFromPhone(userId, deviceId, (id) => ({ type: 'open_url', id, url: args.url }), 12000);
        if (!r.ok) return textResult(r.error || 'Could not open the URL.', true);
        return maybeScreenshot(userId, deviceId, textResult(`Opened ${args.url}`), args.screenshot !== false);
      } catch (e) {
        return textResult(e.message, true);
      }
    }

    case 'read_notifications': {
      if (!signaling.presence.isOnline(userId, deviceId)) return offline();
      if (!signaling.deviceSupports(userId, deviceId, 'notifications')) {
        return textResult('This phone build cannot read notifications — update the app.', true);
      }
      try {
        const r = await signaling.requestFromPhone(userId, deviceId, (id) => ({ type: 'notifications', id }), 12000);
        if (r.error === 'notification_access_not_granted') {
          return textResult('Notification access has not been granted on the phone. Grant it at Settings → Notifications → Device & app notifications → Phone Remote → Allow notification access. This is a separate permission from the Accessibility Service.', true);
        }
        if (r.error) return textResult(`The phone could not read notifications: ${r.error}`, true);
        // Merge active + recent, newest first, de-duped: an active notification
        // is usually also in history, and the model shouldn't see it twice.
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
        if (args.filter) {
          const f = String(args.filter).toLowerCase();
          list = list.filter((n) => `${n.package} ${n.title || ''} ${n.text || ''}`.toLowerCase().includes(f));
        }
        list = list.slice(0, clamp(args.limit ?? 20, 1, 50));
        if (!list.length) {
          return textResult(args.filter
            ? `No notifications match "${args.filter}". (${all.length} total seen.)`
            : 'No notifications. Note that history only covers what arrived while the app was running.');
        }
        return textResult(list.map((n) => ({
          app: n.package,
          title: n.title,
          text: n.text,
          at: n.postedAt ? new Date(n.postedAt).toISOString() : undefined,
          showing: !!n.active,
        })));
      } catch (e) {
        return textResult(e.message, true);
      }
    }

    case 'take_screenshot': {
      try {
        const { jpeg, note } = await captureVerifiedScreenshot(userId, deviceId);
        const result = imageResult(await shrinkScreenshot(jpeg));
        if (note) result.content.push({ type: 'text', text: note });
        return result;
      } catch (e) {
        return textResult(e.message, true);
      }
    }

    case 'tap': {
      const r = await runControl(userId, deviceId, { type: 'control', action: 'tap', x: args.x, y: args.y });
      if (r.err) return r.err;
      return maybeScreenshot(userId, deviceId, textResult(`Tapped (${args.x}, ${args.y}).${r.note}`), args.screenshot);
    }

    case 'long_press': {
      const ms = clamp(args.ms ?? 700, 400, 3000);
      // A hold-in-place gesture: tiny 2px move over a long duration reads as a long press.
      const r = await runControl(userId, deviceId, {
        type: 'control', action: 'swipe',
        x1: args.x, y1: args.y, x2: clamp(args.x + 0.002, 0, 1), y2: clamp(args.y + 0.002, 0, 1), ms,
      }, ms + 5000); // the phone only acks once the hold finishes
      if (r.err) return r.err;
      return maybeScreenshot(userId, deviceId, textResult(`Long-pressed (${args.x}, ${args.y}) for ${ms}ms.${r.note}`), args.screenshot);
    }

    case 'swipe': {
      const r = await runControl(userId, deviceId, {
        type: 'control', action: 'swipe',
        x1: args.x1, y1: args.y1, x2: args.x2, y2: args.y2, ms: args.ms,
      }, (args.ms || 300) + 5000);
      if (r.err) return r.err;
      return maybeScreenshot(userId, deviceId, textResult(`Swiped (${args.x1}, ${args.y1}) → (${args.x2}, ${args.y2}).${r.note}`), args.screenshot);
    }

    case 'scroll': {
      const g = scrollGesture(args.direction, args.amount);
      if (!g) return textResult('direction must be up, down, left, or right.', true);
      const r = await runControl(userId, deviceId, { type: 'control', action: 'swipe', ...g, ms: 260 });
      if (r.err) return r.err;
      return maybeScreenshot(userId, deviceId, textResult(`Scrolled ${args.direction}.${r.note}`), args.screenshot);
    }

    case 'type_text': {
      const paste = args.method === 'paste';
      if (paste && !signaling.deviceSupports(userId, deviceId, 'paste')) {
        return textResult('This phone build does not support paste-typing — update the app, or call type_text without method:"paste".', true);
      }
      const r = await runControl(userId, deviceId, {
        type: 'control', action: paste ? 'paste' : 'text', value: args.text,
      });
      if (r.err) return r.err;
      let submitted = '';
      if (args.submit) {
        await sleep(150);
        const enter = await runControl(userId, deviceId, { type: 'control', action: 'keyevent', keycode: 'KEYCODE_ENTER' });
        // The text landed even if Enter didn't — report the partial truth
        // rather than failing the whole call.
        submitted = enter.err ? ' (but Enter was not accepted — the text is typed but not submitted)' : ' and submitted';
      }
      return maybeScreenshot(userId, deviceId, textResult(`Text ${paste ? 'pasted' : 'typed'}${submitted}.${r.note}`), args.screenshot);
    }

    case 'press_key': {
      const keycode = KEY_MAP[args.key];
      if (!keycode) return textResult(`key must be one of: ${KEY_NAMES.join(', ')}.`, true);
      const r = await runControl(userId, deviceId, { type: 'control', action: 'keyevent', keycode });
      if (r.err) return r.err;
      return maybeScreenshot(userId, deviceId, textResult(`Pressed ${args.key}.${r.note}`), args.screenshot);
    }

    case 'get_device_status': {
      if (!signaling.presence.isOnline(userId, deviceId)) return offline();
      if (!signaling.deviceSupports(userId, deviceId, 'device_status')) {
        return textResult('This phone build is too old to report status — update the app.', true);
      }
      try {
        const s = await signaling.requestFromPhone(userId, deviceId, (id) => ({ type: 'device_status', id }), 8000);
        if (s.error) return textResult(`The phone could not read its status: ${s.error}`, true);
        const status = {
          battery: `${s.battery}%${s.charging ? ' (charging)' : ''}`,
          screenOn: s.screenOn,
          accessibilityEnabled: s.accessibilityEnabled,
          notificationAccess: s.notificationAccess,
          foregroundApp: s.foregroundApp ?? 'unknown',
          network: s.network,
          screen: `${s.screenW}×${s.screenH}`,
          model: s.model,
          androidSdk: s.androidSdk,
          batteryOptimized: s.batteryOptimized,
        };
        const warnings = [];
        if (!s.accessibilityEnabled) warnings.push('Accessibility Service is OFF — taps, swipes and typing will silently do nothing until it is enabled at Settings → Accessibility → Phone Remote.');
        if (!s.screenOn) warnings.push('The screen is off — screenshots will look blank. press_key "home" wakes it.');
        if (s.batteryOptimized) warnings.push('Battery optimization is ON for this app — Android may throttle or kill the connection in the background. Exempt it in the app for a stable link.');
        const result = textResult(status);
        if (warnings.length) result.content.push({ type: 'text', text: warnings.join('\n') });
        return result;
      } catch (e) {
        return textResult(e.message, true);
      }
    }

    case 'get_foreground_app': {
      if (!signaling.presence.isOnline(userId, deviceId)) return offline();
      if (!signaling.deviceSupports(userId, deviceId, 'device_status')) {
        return textResult('This phone build is too old to report the foreground app — update the app.', true);
      }
      try {
        const s = await signaling.requestFromPhone(userId, deviceId, (id) => ({ type: 'device_status', id }), 8000);
        if (!s.accessibilityEnabled) return textResult("Cannot tell: the phone's Accessibility Service is off. Enable it at Settings → Accessibility → Phone Remote.", true);
        if (!s.foregroundApp) return textResult('No foreground app reported — the screen may be off or locked.', true);
        return textResult(s.foregroundApp);
      } catch (e) {
        return textResult(e.message, true);
      }
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
      const home = await runControl(userId, deviceId, { type: 'control', action: 'keyevent', keycode: 'KEYCODE_HOME' });
      if (home.err) return home.err;
      await sleep(400);
      const up = await runControl(userId, deviceId, { type: 'control', action: 'swipe', x1: 0.5, y1: 0.92, x2: 0.5, y2: 0.25, ms: 250 });
      if (up.err) return up.err;
      const want = args.screenshot !== false; // defaults to true for this one
      return maybeScreenshot(userId, deviceId, textResult(`Opened the app drawer. Tap the search bar and type an app name to find it.${up.note}`), want);
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

    case 'get_file': {
      if (!signaling.presence.isOnline(userId, deviceId)) return offline();
      const path = confineToBase(args.path);
      try {
        let buffer;
        try {
          buffer = await signaling.downloadFromPhone(userId, deviceId, path, { maxBytes: MAX_GET_FILE_BYTES });
        } catch (e) {
          // "No data at all" usually means the request landed on a socket
          // that had just died and the heartbeat hadn't cleared it yet.
          // Wait out the zombie window (~30s from death) and try once more
          // on whatever socket is primary by then.
          if (!/no data from the phone|lost in transit/i.test(e.message)) throw e;
          await sleep(10000);
          if (!signaling.presence.isOnline(userId, deviceId)) return offline();
          buffer = await signaling.downloadFromPhone(userId, deviceId, path, { maxBytes: MAX_GET_FILE_BYTES });
        }
        if (!buffer.length) return textResult(`${path} is empty (0 bytes) — nothing to download.`, true);
        pruneDownloads();
        const token = crypto.randomBytes(24).toString('base64url');
        const name = path.split('/').pop() || 'file';
        pendingDownloads.set(token, { buffer, name, expiresAt: Date.now() + DOWNLOAD_TTL_MS });
        const downloadUrl = `${ctx.baseUrl}/mcp/download/${token}`;
        return textResult({
          download_url: downloadUrl,
          file: path,
          bytes: buffer.length,
          expires_in_seconds: DOWNLOAD_TTL_MS / 1000,
          next_step: `With a shell: curl -sS -o "${name}" "${downloadUrl}". WITHOUT a shell (e.g. claude.ai chat): give the user the download_url to click — the browser saves the file. Either way the URL works once.`,
        });
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
        next_step: `With a shell: curl -sS -X POST -H "Content-Type: application/octet-stream" --data-binary @"<local-file-path>" "${uploadUrl}" — the JSON response confirms the save. WITHOUT a shell (e.g. claude.ai chat): give the user the upload_url to open in their browser — it shows a file picker that uploads straight to the phone.`,
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
        fetched = await downloadUrl(String(args.url), MAX_TRANSFER_BYTES);
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
  app.post('/mcp/upload/:token', express.raw({ type: () => true, limit: '110mb' }), async (req, res) => {
    const upload = pendingUploads.get(req.params.token);
    if (upload) pendingUploads.delete(req.params.token); // single use, even on failure
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

  // Browser dashboard upload — the web app POSTs the whole file here in one
  // request, and the server streams it to the phone with uploadToPhone (the
  // same battle-tested per-chunk-ack + retry path MCP uses). This replaces
  // the old browser→server→phone WS chunk relay, which doubled the round
  // trips over the internet and died whenever the phone reconnected
  // mid-transfer. Auth via ?token= (browsers can't set Authorization on a
  // streamed fetch as easily; the JWT is the same one the WS uses).
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

  // Browser face of the same upload token — for MCP clients with no shell
  // (claude.ai chat): opening the link shows a file picker that POSTs the
  // bytes to this same URL. GET does NOT consume the token; only POST does.
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

  // One-time download source for get_file — mirror of /mcp/upload above:
  // the unguessable single-use token is the credential.
  app.get('/mcp/download/:token', (req, res) => {
    const d = pendingDownloads.get(req.params.token);
    if (d) pendingDownloads.delete(req.params.token); // single use, even on failure
    if (!d || d.expiresAt < Date.now()) {
      return res.status(410).json({ ok: false, error: 'Download link is invalid or expired — call the get_file tool again for a fresh one.' });
    }
    res.setHeader('Content-Type', mime.lookup(d.name) || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${d.name.replace(/"/g, '')}"`);
    res.send(d.buffer);
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
