'use strict';

// Shrinks the get_ui_tree result before it reaches the agent, without losing
// anything it needs to read the screen or tap. Every step is lossless:
//
//  1. desc identical to text is dropped (the same words twice).
//  2. cls "TextView" is dropped: it is the most common class and documented
//     as the default.
//  3. An unlabeled, clickable-only wrapper (a list row) is folded into the
//     label right after it on the same row: that label gets the "c" flag and
//     tapping it hits the same row.
//  4. Two neighbours with the same label on the same row, one clickable and
//     one not (a Button and its own caption), become one clickable node.
//
// Steps 3 and 4 compare a node with its neighbour, so they only run on the
// full tree: with a filter, neighbours are already gone. The caller skips
// all of this when the agent asked for all:true (the raw tree).
//
// Text is never shortened: chat messages and notifications can be the very
// thing the user asked about.

const SAME_ROW = 0.03;      // max |dy| between a wrapper and its label
const SAME_LINE = 0.02;     // max |dy| for duplicate labels

const label = (n) => n.text || n.desc || '';
const isClickable = (n) => (n.f || '').includes('c');

function addFlag(f, ch) {
  return (f || '').includes(ch) ? f : `${f || ''}${ch}`;
}

function unionFlags(a, b) {
  let f = a || '';
  for (const ch of b || '') f = addFlag(f, ch);
  return f || undefined;
}

function tidy(n) {
  const o = { ...n };
  if (o.text && o.desc && o.text.trim() === o.desc.trim()) delete o.desc;
  if (o.cls === 'TextView') delete o.cls;
  if (!o.f) delete o.f;
  return o;
}

function compactNodes(nodes, { neighbours = true } = {}) {
  let list = (nodes || []).map(tidy);

  if (neighbours) {
    // 3. Fold unlabeled clickable wrappers into the label that follows.
    const folded = [];
    for (let k = 0; k < list.length; k++) {
      const n = list[k];
      const next = list[k + 1];
      const bareWrapper = !n.text && !n.desc && !n.id && n.f === 'c';
      if (bareWrapper && next && label(next) && !isClickable(next)
          && Math.abs(next.y - n.y) <= SAME_ROW) {
        list[k + 1] = { ...next, f: addFlag(next.f, 'c') };
        continue;
      }
      folded.push(n);
    }
    list = folded;

    // 4. Merge a clickable node with its own caption on the same line.
    const merged = [];
    for (const n of list) {
      const prev = merged[merged.length - 1];
      if (prev && label(prev) && label(prev) === label(n)
          && Math.abs(prev.y - n.y) <= SAME_LINE
          && isClickable(prev) !== isClickable(n)) {
        const keep = isClickable(prev) ? prev : n;
        const other = keep === prev ? n : prev;
        const m = { ...keep, f: unionFlags(keep.f, other.f) };
        if (!m.text && other.text) m.text = other.text;
        if (m.desc && m.desc === m.text) delete m.desc;
        if (!m.id && other.id) m.id = other.id;
        if (!m.f) delete m.f;
        merged[merged.length - 1] = m;
        continue;
      }
      merged.push(n);
    }
    list = merged;
  }

  // Keep i as a plain 0..n-1 index, first key, like the phone sends it.
  return list.map((n, i) => {
    const { i: _old, ...rest } = n;
    return { i, ...rest };
  });
}

// One node per line instead of pretty-printed JSON: still easy to read, but
// without the indentation and line breaks that cost more than the data.
function formatTree(out) {
  const { nodes, ...head } = out;
  const headJson = JSON.stringify(head);
  const body = nodes.map((n) => JSON.stringify(n)).join(',\n');
  return `${headJson.slice(0, -1)}${headJson.length > 2 ? ',' : ''}"nodes":[\n${body}\n]}`;
}

module.exports = { compactNodes, formatTree };
