const express = require('express');
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
 */

const PROTOCOL_VERSION = '2025-06-18';

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
    description: 'Capture and return the current screen of a device as a JPEG image. Requires the phone\'s Accessibility Service to be enabled.',
    inputSchema: {
      type: 'object',
      properties: { deviceId: { type: 'string', description: 'Device id from list_devices' } },
      required: ['deviceId'],
    },
  },
  {
    name: 'tap',
    description: 'Tap the screen at a point. Coordinates are normalized 0.0-1.0 (fraction of screen width/height), not pixels — e.g. x=0.5, y=0.5 is the center of the screen. Use take_screenshot first to see where to tap.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string' },
        x: { type: 'number', minimum: 0, maximum: 1, description: 'Horizontal position, 0 = left edge, 1 = right edge' },
        y: { type: 'number', minimum: 0, maximum: 1, description: 'Vertical position, 0 = top edge, 1 = bottom edge' },
      },
      required: ['deviceId', 'x', 'y'],
    },
  },
  {
    name: 'swipe',
    description: 'Swipe from one point to another. Coordinates are normalized 0.0-1.0.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string' },
        x1: { type: 'number', minimum: 0, maximum: 1 },
        y1: { type: 'number', minimum: 0, maximum: 1 },
        x2: { type: 'number', minimum: 0, maximum: 1 },
        y2: { type: 'number', minimum: 0, maximum: 1 },
        ms: { type: 'integer', minimum: 50, maximum: 5000, description: 'Swipe duration in milliseconds (default 300)' },
      },
      required: ['deviceId', 'x1', 'y1', 'x2', 'y2'],
    },
  },
  {
    name: 'type_text',
    description: 'Type text into the currently focused input field on the device.',
    inputSchema: {
      type: 'object',
      properties: { deviceId: { type: 'string' }, text: { type: 'string' } },
      required: ['deviceId', 'text'],
    },
  },
  {
    name: 'press_key',
    description: 'Press a system navigation key.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string' },
        key: { type: 'string', enum: ['back', 'home', 'recents'] },
      },
      required: ['deviceId', 'key'],
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
    description: 'List files and folders in a directory on the device\'s storage.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string' },
        path: { type: 'string', description: 'Absolute path, defaults to /storage/emulated/0' },
      },
      required: ['deviceId'],
    },
  },
];

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text: typeof text === 'string' ? text : JSON.stringify(text, null, 2) }], isError };
}

async function callTool(userId, name, args = {}) {
  const { deviceId } = args;

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
        return { content: [{ type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg' }] };
      } catch (e) {
        return textResult(e.message, true);
      }
    }

    case 'tap':
      if (!signaling.sendToPhone(userId, deviceId, { type: 'control', action: 'tap', x: args.x, y: args.y })) {
        return textResult('Device is offline.', true);
      }
      return textResult(`Tapped (${args.x}, ${args.y}).`);

    case 'swipe':
      if (!signaling.sendToPhone(userId, deviceId, { type: 'control', action: 'swipe', x1: args.x1, y1: args.y1, x2: args.x2, y2: args.y2, ms: args.ms })) {
        return textResult('Device is offline.', true);
      }
      return textResult('Swipe sent.');

    case 'type_text':
      if (!signaling.sendToPhone(userId, deviceId, { type: 'control', action: 'text', value: args.text })) {
        return textResult('Device is offline.', true);
      }
      return textResult('Text sent.');

    case 'press_key':
      if (!['back', 'home', 'recents'].includes(args.key)) return textResult('key must be back, home, or recents.', true);
      if (!signaling.sendToPhone(userId, deviceId, { type: 'control', action: args.key })) {
        return textResult('Device is offline.', true);
      }
      return textResult(`Pressed ${args.key}.`);

    case 'ring':
      if (!signaling.sendToPhone(userId, deviceId, { type: 'ring' })) return textResult('Device is offline.', true);
      return textResult('Ringing device.');

    case 'flash_light':
      if (!signaling.sendToPhone(userId, deviceId, { type: 'flash', count: args.count ?? 3 })) return textResult('Device is offline.', true);
      return textResult('Flashing light.');

    case 'list_files': {
      try {
        const reply = await signaling.requestFromPhone(userId, deviceId, (id) => ({
          type: 'pf_list', id, path: args.path || '',
        }));
        return textResult(reply.entries.map((e) => ({ name: e.name, type: e.type, size: e.size, path: e.path })));
      } catch (e) {
        return textResult(e.message, true);
      }
    }

    default:
      return null; // unknown tool — caller returns a protocol-level error
  }
}

function setupMcpRoutes(app) {
  app.post('/mcp', async (req, res) => {
    const token = req.headers.authorization?.replace(/^Bearer /, '');
    const payload = token && verifyToken(token);
    if (!payload) {
      const base = `${process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`}`.replace(/\/$/, '');
      res.set('WWW-Authenticate', `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`);
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
            serverInfo: { name: 'phone-remote', version: '1.0.0' },
          });

        case 'tools/list':
          return reply({ tools: TOOLS });

        case 'tools/call': {
          const { name, arguments: args } = msg.params || {};
          if (!TOOLS.some((t) => t.name === name)) return replyError(-32602, `Unknown tool: ${name}`);
          const result = await callTool(userId, name, args || {});
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
