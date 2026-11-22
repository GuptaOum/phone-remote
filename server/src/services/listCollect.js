'use strict';

// Pure logic behind the collect_list tool: turn a series of get_ui_tree
// snapshots taken while scrolling into one clean, ordered list.
//
// An Android list only draws the rows on screen, so the only way to read a
// long one is to scroll and read again. Consecutive snapshots overlap, so each
// one is stitched onto the end of what we have by matching the tail of the
// list against the head of the new snapshot.

const LINE_GAP = 0.012;    // labels this close vertically sit on one line
const ROW_GAP = 0.04;      // a bigger vertical gap starts a new row
const SAME_POS = 0.004;    // tolerance when comparing positions between snapshots
const REPEAT_MIN = 8;      // a label must repeat at least this often ...
const REPEAT_SHARE = 0.25; // ... and make up this share of all labels to be dropped

// Visible text of a snapshot, top to bottom, left to right on each line.
function screenLabels(nodes, { descriptions = false } = {}) {
  const raw = [];
  for (const n of nodes || []) {
    let t = String(n.text || '').trim();
    if (!t && descriptions) t = String(n.desc || '').trim();
    if (t) raw.push({ t, x: n.x, y: n.y });
  }
  raw.sort((a, b) => a.y - b.y);
  const lines = [];
  for (const l of raw) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(l.y - last.y) <= LINE_GAP) last.items.push(l);
    else lines.push({ y: l.y, items: [l] });
  }
  const out = [];
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    out.push(...line.items);
  }
  return out;
}

function sameScreen(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].t !== b[i].t || Math.abs(a[i].y - b[i].y) > SAME_POS) return false;
  }
  return true;
}

const samePlace = (a, b) =>
  a.t === b.t && Math.abs(a.x - b.x) <= SAME_POS && Math.abs(a.y - b.y) <= SAME_POS;

// Labels that sit in the same place on most snapshots are not list content:
// a title bar, a bottom navigation bar, a mini player. List rows move on every
// scroll, so they never stay put. "Most" rather than "every", because some
// bars only show up after the first scroll (a collapsing title bar that
// appears once the big header has scrolled away). Returns the labels with
// their positions, so a row that happens to share a bar's text is kept.
function staticSet(screens) {
  const found = [];
  if (screens.length < 2) return found;
  const need = Math.max(2, Math.ceil(screens.length / 2));
  for (const s of screens) {
    for (const l of s) {
      if (found.some((f) => samePlace(f, l))) continue;
      const count = screens.filter((o) => o.some((m) => samePlace(m, l))).length;
      if (count >= need) found.push({ t: l.t, x: l.x, y: l.y });
    }
  }
  return found;
}

// Mark where each row starts (a big vertical gap from the previous label).
function withBreaks(labels) {
  return labels.map((l, i) => ({
    t: l.t,
    br: i === 0 || Math.abs(l.y - labels[i - 1].y) > ROW_GAP,
  }));
}

// Longest k such that the last k labels of `acc` equal the first k of `next`.
function overlap(acc, next) {
  const max = Math.min(acc.length, next.length);
  for (let k = max; k >= 1; k--) {
    let ok = true;
    for (let j = 0; j < k; j++) {
      if (acc[acc.length - k + j].t !== next[j].t) { ok = false; break; }
    }
    if (ok) return k;
  }
  return 0;
}

// screens: array of screenLabels() results, in scroll order.
function mergeScreens(screens) {
  const skip = staticSet(screens);
  const acc = [];
  let gaps = 0;
  screens.forEach((s, idx) => {
    const flagged = withBreaks(s.filter((l) => !skip.some((f) => samePlace(f, l))));
    if (!flagged.length) return;
    if (idx === 0 || !acc.length) { acc.push(...flagged); return; }
    const k = overlap(acc, flagged);
    if (k === 0) {
      gaps++;
      flagged[0].br = true;
    }
    acc.push(...flagged.slice(k));
  });
  return { labels: acc, gaps, dropped: [...new Set(skip.map((f) => f.t))] };
}

// Labels like "0" or "Play" that every row repeats are row furniture, not
// content. Reported back so the caller knows what was removed.
function dropRepeated(labels) {
  const counts = new Map();
  for (const l of labels) counts.set(l.t, (counts.get(l.t) || 0) + 1);
  const drop = new Set();
  for (const [t, c] of counts) {
    if (c >= REPEAT_MIN && c >= labels.length * REPEAT_SHARE) drop.add(t);
  }
  if (!drop.size) return { labels, dropped: [] };
  const out = [];
  let carry = false;
  for (const l of labels) {
    if (drop.has(l.t)) { carry = carry || l.br; continue; }
    out.push({ t: l.t, br: l.br || carry });
    carry = false;
  }
  return { labels: out, dropped: [...drop].map((t) => ({ text: t, count: counts.get(t) })) };
}

// One string per row: the labels of a row joined with " | ".
function toRows(labels) {
  const rows = [];
  for (const l of labels) {
    if (l.br || !rows.length) rows.push([l.t]);
    else rows[rows.length - 1].push(l.t);
  }
  return rows.map((r) => r.join(' | '));
}

module.exports = {
  screenLabels, sameScreen, staticSet, mergeScreens, dropRepeated, toRows, overlap,
};
