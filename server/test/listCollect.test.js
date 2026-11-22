'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  screenLabels, sameScreen, mergeScreens, dropRepeated, toRows, overlap,
} = require('../src/services/listCollect');

const TOP = 0.11;
const BOTTOM = 0.88;
const SPACING = 0.0985;
const FIRST_ROW_Y = 0.15;

// A fake list like YT Music's: each row is a title, an artist line below it,
// a text "0" counter and desc-only buttons, with a title bar and a bottom bar
// that never move.
function makeRows(n, titles = {}) {
  return Array.from({ length: n }, (_, i) => ({
    title: titles[i] || `Song ${i + 1}`,
    artist: `Artist ${i + 1} • 3:${String(10 + i).padStart(2, '0')}`,
  }));
}

function snapshot(rows, offset) {
  const nodes = [
    { text: 'mixed', x: 0.37, y: 0.08 },
    { desc: 'Back', x: 0.08, y: 0.08, f: 'c' },
    { text: 'Home', x: 0.17, y: 0.931 },
    { text: 'Library', x: 0.83, y: 0.931 },
  ];
  rows.forEach((r, i) => {
    const y = FIRST_ROW_Y + i * SPACING - offset;
    const show = (yy) => yy >= TOP && yy <= BOTTOM;
    if (show(y)) nodes.push({ text: r.title, x: 0.56, y });
    if (show(y + 0.022)) nodes.push({ text: r.artist, x: 0.42, y: y + 0.022 });
    if (show(y + 0.05)) nodes.push({ desc: 'Upvote', x: 0.31, y: y + 0.05, f: 'c' });
    if (show(y + 0.05)) nodes.push({ text: '0', x: 0.38, y: y + 0.05 });
  });
  return nodes;
}

// What the tool does: read, scroll, read, until the screen stops changing.
function scrollAndRead(rows, shift, opts = {}) {
  const screens = [];
  let offset = 0;
  const maxOffset = Math.max(0, FIRST_ROW_Y + rows.length * SPACING - BOTTOM); // end of list
  let cur = screenLabels(snapshot(rows, offset), opts);
  for (let step = 0; step < 200; step++) {
    screens.push(cur);
    offset = Math.min(offset + shift, maxOffset);
    const next = screenLabels(snapshot(rows, offset), opts);
    if (sameScreen(cur, next)) break;
    cur = next;
  }
  return screens;
}

function collect(rows, shift) {
  const screens = scrollAndRead(rows, shift);
  const merged = mergeScreens(screens);
  const cleaned = dropRepeated(merged.labels);
  return { merged, rows: toRows(cleaned.labels), cleaned, screens };
}

test('rebuilds a long list with no gaps and no repeats', () => {
  const data = makeRows(60);
  const { rows, merged } = collect(data, 0.6);
  assert.strictEqual(merged.gaps, 0);
  assert.strictEqual(rows.length, 60);
  data.forEach((r, i) => assert.strictEqual(rows[i], `${r.title} | ${r.artist}`));
});

test('works for several scroll sizes', () => {
  for (const shift of [0.3, 0.45, 0.55, 0.65]) {
    const data = makeRows(45);
    const { rows, merged } = collect(data, shift);
    assert.strictEqual(merged.gaps, 0, `gaps at shift ${shift}`);
    assert.strictEqual(rows.length, 45, `rows at shift ${shift}`);
  }
});

test('keeps genuine duplicates that are far apart', () => {
  const data = makeRows(40, { 4: 'Same Title', 30: 'Same Title' });
  data[30].artist = data[4].artist; // identical row twice
  const { rows } = collect(data, 0.6);
  assert.strictEqual(rows.length, 40);
  assert.strictEqual(rows.filter((r) => r.startsWith('Same Title')).length, 2);
});

test('drops the title bar and bottom bar', () => {
  const { merged, rows } = collect(makeRows(30), 0.6);
  assert.ok(merged.dropped.includes('mixed'));
  assert.ok(merged.dropped.includes('Home'));
  assert.ok(!rows.join('\n').includes('Library'));
});

test('drops row furniture that every row repeats, and says so', () => {
  const { cleaned, rows } = collect(makeRows(50), 0.6);
  assert.deepStrictEqual(cleaned.dropped, [{ text: '0', count: 50 }]);
  assert.ok(!rows.some((r) => r.includes('| 0')));
});

test('a list that fits on one screen comes back whole (bars cannot be told apart from rows)', () => {
  const data = makeRows(5);
  const { rows, screens } = collect(data, 0.6);
  assert.strictEqual(screens.length, 1);
  data.forEach((r) => assert.ok(rows.some((row) => row.startsWith(`${r.title} | ${r.artist}`))));
});

test('reports a gap when snapshots do not overlap', () => {
  const data = makeRows(40);
  const a = screenLabels(snapshot(data, 0));
  const b = screenLabels(snapshot(data, 2.0)); // far past the first screen
  const merged = mergeScreens([a, b]);
  assert.strictEqual(merged.gaps, 1);
});

test('overlap finds the longest match', () => {
  const mk = (...t) => t.map((x) => ({ t: x }));
  assert.strictEqual(overlap(mk('a', 'b', 'c'), mk('b', 'c', 'd')), 2);
  assert.strictEqual(overlap(mk('a', 'b'), mk('x', 'y')), 0);
});

test('descriptions option reads desc-only labels', () => {
  const nodes = [{ desc: 'Mom', x: 0.5, y: 0.3 }, { text: 'Hello', x: 0.5, y: 0.5 }];
  assert.deepStrictEqual(screenLabels(nodes).map((l) => l.t), ['Hello']);
  assert.deepStrictEqual(screenLabels(nodes, { descriptions: true }).map((l) => l.t), ['Mom', 'Hello']);
});
