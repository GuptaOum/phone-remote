'use strict';

// Run: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const { compactNodes, formatTree } = require('../src/services/uiTreeCompact');

// Real trees from a realme phone (YouTube and YT Music), trimmed to the
// shapes that matter.
const youtubeSettings = [
  { i: 0, desc: 'Navigate up', cls: 'ImageButton', x: 0.078, y: 0.08, f: 'c' },
  { i: 1, text: 'Settings', cls: 'TextView', x: 0.306, y: 0.079 },
  { i: 2, cls: 'RecyclerView', x: 0.5, y: 0.527, f: 's' },
  { i: 3, text: 'Account', cls: 'TextView', x: 0.11, y: 0.142 },
  { i: 4, cls: 'LinearLayout', x: 0.5, y: 0.208, f: 'c' },
  { i: 5, text: 'General', cls: 'TextView', x: 0.583, y: 0.208 },
  { i: 6, cls: 'LinearLayout', x: 0.5, y: 0.275, f: 'c' },
  { i: 7, text: 'Switch or manage account', cls: 'TextView', x: 0.583, y: 0.275 },
  { i: 8, cls: 'LinearLayout', x: 0.5, y: 0.342, f: 'c' },
  { i: 9, text: 'Family Centre', cls: 'TextView', x: 0.583, y: 0.342 },
  { i: 10, cls: 'LinearLayout', x: 0.5, y: 0.409, f: 'c' },
  { i: 11, text: 'Languages', cls: 'TextView', x: 0.583, y: 0.409 },
  { i: 12, cls: 'LinearLayout', x: 0.5, y: 0.476, f: 'c' },
  { i: 13, text: 'Time management', cls: 'TextView', x: 0.583, y: 0.476 },
  { i: 14, cls: 'LinearLayout', x: 0.5, y: 0.812, f: 'c' },
  { i: 15, text: 'Manage all history', cls: 'TextView', x: 0.583, y: 0.812 },
];

const youtubeYouTab = [
  { i: 0, desc: 'Sanjay Gupta', cls: 'ViewGroup', x: 0.622, y: 0.159, f: 'c' },
  { i: 1, cls: 'Button', x: 0.611, y: 0.189, f: 'c' },
  { i: 2, text: '@SanjayGupta-dz4zn', desc: '@SanjayGupta-dz4zn', cls: 'ViewGroup', x: 0.434, y: 0.189 },
  { i: 3, desc: 'View channel', cls: 'Button', x: 0.267, y: 0.256, f: 'c' },
  { i: 4, text: 'View channel', desc: 'View channel', cls: 'ViewGroup', x: 0.267, y: 0.256 },
  { i: 5, desc: 'Accounts', cls: 'Button', x: 0.199, y: 0.08, f: 'c' },
  { i: 6, text: 'Accounts', desc: 'Accounts', cls: 'ViewGroup', x: 0.157, y: 0.079 },
  { i: 7, desc: 'Settings', cls: 'ImageView', x: 0.933, y: 0.08, f: 'c' },
  { i: 8, desc: 'History', cls: 'Button', x: 0.5, y: 0.328, f: 'c' },
  { i: 9, text: 'History', desc: 'History', cls: 'ViewGroup', x: 0.12, y: 0.328 },
  { i: 10, desc: '8 minutes, 37 seconds', cls: 'ViewGroup', x: 0.382, y: 0.445 },
  { i: 11, text: '8:37', desc: '8:37', cls: 'ViewGroup', x: 0.382, y: 0.445 },
  { i: 12, desc: 'Action menu', cls: 'Button', x: 0.433, y: 0.486, f: 'c' },
  { i: 13, desc: 'Action menu', cls: 'Button', x: 0.878, y: 0.486, f: 'c' },
  { i: 14, desc: 'Home', cls: 'Button', x: 0.125, y: 0.915, f: 'c' },
  { i: 15, desc: 'You', cls: 'Button', x: 0.875, y: 0.915, f: 'c' },
];

// The account list: the email sits ABOVE its own row, and one row is an
// account that must never be tapped by mistake.
const accountList = [
  { i: 0, text: 'Accounts', cls: 'TextView', x: 0.458, y: 0.109 },
  { i: 1, desc: 'Add account', cls: 'ImageView', x: 0.817, y: 0.109, f: 'c' },
  { i: 2, cls: 'ListView', x: 0.5, y: 0.532, f: 's' },
  { i: 3, text: 'a@example.com', desc: 'a@example.com', cls: 'TextView', x: 0.5, y: 0.504 },
  { i: 4, cls: 'RelativeLayout', x: 0.5, y: 0.567, f: 'c' },
  { i: 5, text: 'Account action required', cls: 'TextView', x: 0.489, y: 0.556 },
  { i: 6, text: 'Tap to sign in', cls: 'TextView', x: 0.404, y: 0.578 },
  { i: 7, text: 'b@example.com', desc: 'b@example.com', cls: 'TextView', x: 0.5, y: 0.833 },
  { i: 8, cls: 'RelativeLayout', x: 0.5, y: 0.883, f: 'c' },
  { i: 9, text: 'Sanjay Gupta', cls: 'TextView', x: 0.413, y: 0.883 },
];

const size = (nodes) => JSON.stringify({ app: 'x', nodes }, null, 2).length;
const sizeNew = (nodes) => formatTree({ app: 'x', nodes }).length;

test('folds bare row wrappers into their label, keeping the tap target', () => {
  const out = compactNodes(youtubeSettings);
  const general = out.find((n) => n.text === 'General');
  assert.ok(general.f.includes('c'), 'label becomes clickable');
  assert.strictEqual(general.y, 0.208);
  assert.ok(!out.some((n) => n.cls === 'LinearLayout'), 'wrappers are gone');
  // Every label survives.
  for (const n of youtubeSettings) if (n.text) assert.ok(out.some((o) => o.text === n.text), n.text);
  // Scrollable containers stay: they tell the agent where to swipe.
  assert.ok(out.some((n) => n.cls === 'RecyclerView' && n.f === 's'));
});

test('merges a button with its own caption, never two separate buttons', () => {
  const out = compactNodes(youtubeYouTab);
  const history = out.filter((n) => n.text === 'History' || n.desc === 'History');
  assert.strictEqual(history.length, 1);
  assert.strictEqual(history[0].x, 0.5, 'keeps the clickable one');
  assert.ok(history[0].f.includes('c'));
  assert.strictEqual(out.filter((n) => n.desc === 'Action menu').length, 2, 'two real buttons stay two');
  // A description that differs from the text is kept.
  assert.ok(out.some((n) => n.desc === '8 minutes, 37 seconds'));
  assert.ok(out.some((n) => n.text === '8:37' && !n.desc));
  // The bare button next to the @handle is folded into it.
  assert.ok(out.some((n) => n.text === '@SanjayGupta-dz4zn' && n.f === 'c'));
});

test('account rows keep their order and the warning row stays separate', () => {
  const out = compactNodes(accountList);
  const labels = out.map(label);
  assert.ok(labels.indexOf('a@example.com') < labels.indexOf('Account action required'));
  assert.ok(labels.indexOf('Account action required') < labels.indexOf('b@example.com'));
  assert.ok(labels.indexOf('b@example.com') < labels.indexOf('Sanjay Gupta'));
  const sanjay = out.find((n) => n.text === 'Sanjay Gupta');
  assert.ok(sanjay.f.includes('c'));
  assert.ok(Math.abs(sanjay.y - 0.883) < 0.01);
  assert.ok(out.some((n) => n.cls === 'ListView'));
});

test('indices run 0..n-1 and i comes first', () => {
  const out = compactNodes(youtubeSettings);
  out.forEach((n, k) => {
    assert.strictEqual(n.i, k);
    assert.strictEqual(Object.keys(n)[0], 'i');
  });
});

test('filtered results only get the per-node tidy-up', () => {
  const out = compactNodes(youtubeSettings.slice(4, 6), { neighbours: false });
  assert.strictEqual(out.length, 2);
  assert.ok(!out[1].cls);
});

test('formatTree is valid JSON with one node per line', () => {
  const nodes = compactNodes(youtubeSettings);
  const s = formatTree({ app: 'com.google.android.youtube', nodes, note: 'Truncated' });
  const back = JSON.parse(s);
  assert.deepStrictEqual(back.nodes, nodes);
  assert.strictEqual(back.note, 'Truncated');
  assert.strictEqual(s.split('\n').length, nodes.length + 2);
});

test('size report', () => {
  for (const [name, nodes] of Object.entries({ youtubeSettings, youtubeYouTab, accountList })) {
    const before = size(nodes);
    const after = sizeNew(compactNodes(nodes));
    const pct = Math.round((1 - after / before) * 100);
    console.log(`${name}: ${nodes.length} -> ${compactNodes(nodes).length} nodes, ${before} -> ${after} chars (-${pct}%)`);
    assert.ok(after < before * 0.6);
  }
});

function label(n) { return n.text || n.desc || ''; }
