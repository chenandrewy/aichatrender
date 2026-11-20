// Run: loaded by sessions.js for the session picker.
// Inputs: Claude transcript paths, Codex rollout paths and Codex
// session_index.jsonl files. Read-only; every read is bounded.
// Outputs: a short display title, or '' when the chat has none.
//
// Claude Code appends `custom-title` (set by /rename) and `ai-title` records to
// the transcript and re-appends them as the file grows, so the tail usually has
// the current one. Codex keeps thread names outside the rollout, in an
// append-only `session_index.jsonl` beside its `sessions` directory; a later
// line for the same id is a rename.
'use strict';

const fs = require('fs');
const path = require('path');

const TITLE_SCAN = 256 * 1024; // bytes read from each end of a Claude transcript
const MAX_INDEX = 8 * 1024 * 1024; // larger Codex indexes are skipped
const MAX_TITLE = 80; // UTF-16 units shown in the picker

function cleanTitle(value) {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, ' ').trim();
  return flat.length > MAX_TITLE ? `${flat.slice(0, MAX_TITLE - 1)}…` : flat;
}

function readRange(p, start, length) {
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, start);
    return buf.toString('utf8', 0, n);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

// Last custom title in the text, else last AI title. Partial lines at the cut
// edges fail to parse and are skipped.
function claudeTitleFromText(text) {
  let custom = '';
  let ai = '';
  for (const line of text.split('\n')) {
    if (!line.includes('-title"')) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== 'object') continue;
    if (rec.type === 'custom-title') custom = cleanTitle(rec.customTitle) || custom;
    else if (rec.type === 'ai-title') ai = cleanTitle(rec.aiTitle) || ai;
  }
  return custom || ai;
}

function claudeTitle(p) {
  let size;
  try {
    size = fs.statSync(p).size;
  } catch {
    return '';
  }
  if (!(size > 0)) return '';
  if (size <= 2 * TITLE_SCAN) return claudeTitleFromText(readRange(p, 0, size));
  return (
    claudeTitleFromText(readRange(p, size - TITLE_SCAN, TITLE_SCAN)) ||
    claudeTitleFromText(readRange(p, 0, TITLE_SCAN))
  );
}

// Codex rollout names end in the thread id: rollout-<time>-<uuid>.jsonl.
function codexThreadId(p) {
  const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(
    path.basename(p),
  );
  return m ? m[1].toLowerCase() : '';
}

// Index candidates for each sessions root: its parent (the Codex home), with
// the root as spelled and as resolved, since the default root may be a symlink.
function codexIndexPaths(roots) {
  const dirs = new Set();
  for (const root of roots) {
    dirs.add(path.dirname(root));
    try {
      dirs.add(path.dirname(fs.realpathSync(root)));
    } catch {}
  }
  return [...dirs].map((dir) => path.join(dir, 'session_index.jsonl'));
}

function codexThreadNames(indexPaths) {
  const names = new Map();
  for (const p of indexPaths) {
    let text;
    try {
      const st = fs.statSync(p);
      if (!st.isFile() || st.size > MAX_INDEX) continue;
      text = fs.readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (!rec || typeof rec.id !== 'string') continue;
      const name = cleanTitle(rec.thread_name);
      if (name) names.set(rec.id.toLowerCase(), name);
    }
  }
  return names;
}

module.exports = {
  cleanTitle,
  claudeTitleFromText,
  claudeTitle,
  codexThreadId,
  codexIndexPaths,
  codexThreadNames,
};
