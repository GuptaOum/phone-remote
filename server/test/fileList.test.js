'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  formatLength, isMedia, selectPage, wantDetails, mediaNames, tzLabel, formatFileList, MAX_PROBE,
} = require('../src/services/fileList');

// 2026-11-22T23:48:00Z is 05:18 on 2026-11-23 in India (UTC+05:30).
const T = Date.UTC(2026, 10, 22, 23, 48);
const IST = 330;

const entries = [
  { name: 'Private', type: 'dir', size: 0, modified: T - 3 * 86400000 },
  { name: 'VID-20261123-WA0000.mp4', type: 'file', size: 4227212, modified: T },
  { name: 'VID-20261123-WA0001.mp4', type: 'file', size: 9475364, modified: T - 60000 },
  { name: 'notes.txt', type: 'file', size: 2048, modified: T - 120000 },
  { name: 'VN-1.opus', type: 'file', size: 30000, modified: T - 180000 },
];

function run(opts = {}, o = {}) {
  const sel = selectPage(entries, opts);
  const details = wantDetails(opts.details, sel.page.length);
  return formatFileList('/d', sel, { ...opts, details, ...o });
}

test('formatLength', () => {
  assert.strictEqual(formatLength(28), '0:28');
  assert.strictEqual(formatLength(93), '1:33');
  assert.strictEqual(formatLength(3725), '1:02:05');
  assert.strictEqual(formatLength(0), '');
  assert.strictEqual(formatLength(undefined), '');
});

test('isMedia only matches files with a media extension', () => {
  assert.ok(isMedia(entries[1]));
  assert.ok(isMedia(entries[4]));
  assert.ok(!isMedia(entries[3]));
  assert.ok(!isMedia(entries[0]));
  assert.ok(!isMedia({ name: 'mp4', type: 'file' }));
});

test('wantDetails: explicit wins, otherwise small pages only', () => {
  assert.strictEqual(wantDetails(undefined, 10), true);
  assert.strictEqual(wantDetails(undefined, 11), false);
  assert.strictEqual(wantDetails(false, 3), false);
  assert.strictEqual(wantDetails(true, 60), true);
});

test('small page shows local time and length', () => {
  const out = run({ sort: 'newest', limit: 3 }, {
    tzOffsetMin: IST,
    lengths: new Map([['VID-20261123-WA0000.mp4', 28], ['VID-20261123-WA0001.mp4', 21]]),
  });
  assert.match(out, /Rows: name \| size \| modified \(UTC\+05:30\) \| length\./);
  assert.match(out, /VID-20261123-WA0000\.mp4 \| 4\.0 MB \| 2026-11-23 05:18 \| 0:28/);
  assert.match(out, /VID-20261123-WA0001\.mp4 \| 9\.0 MB \| 2026-11-23 05:17 \| 0:21/);
});

test('no phone timezone falls back to UTC and says so', () => {
  const out = run({ sort: 'newest', limit: 1 }, { lengths: new Map() });
  assert.match(out, /\(UTC\)/);
  assert.match(out, /2026-11-22 23:48/);
});

test('non-media rows and folders get no length column', () => {
  const out = run({}, { tzOffsetMin: IST, lengths: new Map() });
  assert.match(out, /notes\.txt \| 2 KB \| 2026-11-23 05:16$/m);
  assert.match(out, /Private\/ \| \| 2026-11-20 05:18$/m);
});

test('large page keeps the old plain format (no token increase)', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ name: `f${i}.mp4`, type: 'file', size: 1000, modified: T }));
  const sel = selectPage(many, {});
  const details = wantDetails(undefined, sel.page.length);
  assert.strictEqual(details, false);
  const out = formatFileList('/d', sel, { details, tzOffsetMin: IST });
  assert.match(out, /Rows: name \| size \| modified\./);
  // Local date of the phone (05:18 IST on the 23rd), no time of day.
  assert.match(out, /f0\.mp4 \| 1000 B \| 2026-11-23$/m);
  assert.ok(!/UTC/.test(out));
});

test('mediaNames is capped and media-only', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ name: `v${i}.mp4`, type: 'file' }));
  assert.strictEqual(mediaNames(many).length, MAX_PROBE);
  assert.deepStrictEqual(mediaNames(entries), ['VID-20261123-WA0000.mp4', 'VID-20261123-WA0001.mp4', 'VN-1.opus']);
});

test('missing lengths adds one short note', () => {
  const out = run({ limit: 3 }, { tzOffsetMin: IST, lengths: null, lengthsMissing: true });
  assert.match(out, /lengths unavailable/);
});

test('tzLabel', () => {
  assert.strictEqual(tzLabel(330), 'UTC+05:30');
  assert.strictEqual(tzLabel(-240), 'UTC-04:00');
  assert.strictEqual(tzLabel(0), 'UTC');
  assert.strictEqual(tzLabel(undefined), 'UTC');
});

test('paging footer and empty folder', () => {
  const out = run({ limit: 2 }, { tzOffsetMin: IST });
  assert.match(out, /\(3 more: call again with offset:2\)/);
  const empty = formatFileList('/e', selectPage([], {}), { details: true });
  assert.strictEqual(empty, '/e: 0 entries (0 folders, 0 files).');
});
