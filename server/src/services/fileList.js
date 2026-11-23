'use strict';

// list_files formatting. Kept apart from the MCP route so it can be unit
// tested and so token cost is easy to reason about.
//
// Token budget: the plain listing is `name | size | date` (~10 tokens a row).
// "Details" adds the exact local time and, for video/audio, the length
// (~8 more tokens a row). Details switch on by themselves only for small pages
// (<= AUTO_DETAIL_ROWS), so the worst automatic increase is ~80 tokens, and a
// big folder listing costs exactly what it did before unless asked.

const AUTO_DETAIL_ROWS = 10;
// Files whose length is read on the phone per call (each is a metadata read).
const MAX_PROBE = 30;
const MEDIA_EXT = new Set([
  'mp4', 'mkv', 'mov', 'avi', 'webm', '3gp', 'm4v',
  'mp3', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'flac', 'amr',
]);

function humanSize(b) {
  if (b == null) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 28 -> "0:28", 93 -> "1:33", 3725 -> "1:02:05". Unknown (<=0) -> "". */
function formatLength(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function isMedia(entry) {
  if (!entry || entry.type !== 'file') return false;
  const dot = String(entry.name).lastIndexOf('.');
  return dot > 0 && MEDIA_EXT.has(String(entry.name).slice(dot + 1).toLowerCase());
}

/** Apply filter / sort / paging. Returns the pieces the formatter and the route both need. */
function selectPage(entries, { filter, sort, limit, offset } = {}) {
  let list = entries;
  if (filter) {
    const f = String(filter).toLowerCase();
    list = list.filter((e) => String(e.name).toLowerCase().includes(f));
  }
  if (sort === 'newest') list = [...list].sort((a, b) => (b.modified || 0) - (a.modified || 0));
  else if (sort === 'largest') list = [...list].sort((a, b) => (b.type === 'file' ? b.size : -1) - (a.type === 'file' ? a.size : -1));
  const from = offset || 0;
  const n = limit || 60;
  return { list, page: list.slice(from, from + n), from };
}

/** Explicit true/false wins; otherwise details are on for small pages only. */
function wantDetails(details, pageLength) {
  return typeof details === 'boolean' ? details : pageLength <= AUTO_DETAIL_ROWS;
}

/** Names on this page whose length is worth reading (media files only, capped). */
function mediaNames(page) {
  return page.filter(isMedia).slice(0, MAX_PROBE).map((e) => e.name);
}

function tzLabel(min) {
  if (!Number.isFinite(min) || min === 0) return 'UTC';
  const sign = min < 0 ? '-' : '+';
  const a = Math.abs(min);
  return `UTC${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

/**
 * @param {string} dir
 * @param {{list: object[], page: object[], from: number}} sel   from selectPage
 * @param {object} opts
 * @param {string} [opts.filter]
 * @param {string} [opts.sort]
 * @param {boolean} [opts.details]      exact time + length column
 * @param {number} [opts.tzOffsetMin]   phone's UTC offset; absent => UTC
 * @param {Map<string, number>|null} [opts.lengths]  file name -> seconds
 * @param {boolean} [opts.lengthsMissing]  media files present but could not be measured
 */
function formatFileList(dir, sel, { filter, sort, details, tzOffsetMin, lengths, lengthsMissing } = {}) {
  const { list, page, from } = sel;
  const dirs = list.filter((e) => e.type === 'dir').length;
  const tz = Number.isFinite(tzOffsetMin) ? tzOffsetMin : 0;
  const stamp = (ms) => {
    if (!ms) return '';
    const shifted = new Date(ms + tz * 60000).toISOString();
    return details ? `${shifted.slice(0, 10)} ${shifted.slice(11, 16)}` : shifted.slice(0, 10);
  };
  const rows = page.map((e) => {
    if (e.type === 'dir') return `${e.name}/ | | ${stamp(e.modified)}`;
    const len = details && lengths ? formatLength(lengths.get(e.name)) : '';
    return `${e.name} | ${humanSize(e.size)} | ${stamp(e.modified)}${len ? ` | ${len}` : ''}`;
  });
  let head = `${dir}: ${list.length} entries (${dirs} folders, ${list.length - dirs} files)`;
  if (filter) head += ` matching "${filter}"`;
  if (list.length) head += `, showing ${from + 1}-${from + page.length}` + (sort && sort !== 'name' ? `, ${sort} first` : '');
  if (!rows.length) head += '.';
  else if (details) head += `. Rows: name | size | modified (${tzLabel(tz)}) | length.`;
  else head += '. Rows: name | size | modified.';
  const left = list.length - from - page.length;
  const more = left > 0 ? `\n(${left} more: call again with offset:${from + page.length})` : '';
  const note = lengthsMissing ? '\n(video/audio lengths unavailable: phone app needs an update)' : '';
  return [head, ...rows].join('\n') + more + note;
}

module.exports = {
  AUTO_DETAIL_ROWS, MAX_PROBE, MEDIA_EXT,
  humanSize, formatLength, isMedia, selectPage, wantDetails, mediaNames, tzLabel, formatFileList,
};
