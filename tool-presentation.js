// Provider-neutral tool-call presentation for AIChatRender. Parsers normalize
// vendor records into these helpers' small call/result contract; this module
// clips untrusted output and prepares the renderer's plain-text/diff shapes.
'use strict';

const TOOL_LIMITS = {
  TOOL_SUMMARY: 160, // UTF-16 units of a tool call's primary argument
  TOOL_RESULT_LINES: 8, // result lines shown before the "+N lines" marker
  TOOL_RESULT_COLS: 160, // chars kept from each result line before a visible ellipsis
  TOOL_RESULT_CHARS: 2048, // chars kept of a result, however few lines that is
  TOOL_DIFF_LINES: 40, // diff lines rendered before the "+N lines" marker
  TOOL_DIFF_COLS: 400, // chars kept of a single diff line
};

// Cuts to at most `maxUnits` UTF-16 units without leaving a lone surrogate.
function cutUnits(s, maxUnits) {
  if (s.length <= maxUnits) return s;
  const cut = s.slice(0, maxUnits);
  const lastUnit = cut.charCodeAt(cut.length - 1);
  return lastUnit >= 0xd800 && lastUnit <= 0xdbff ? cut.slice(0, -1) : cut;
}

// The input field each normalized tool is identified by. First key present
// wins; unknown tools fall back to their first short scalar string.
const TOOL_PRIMARY = {
  Agent: ['description'],
  Bash: ['command', 'cmd'],
  BashOutput: ['bash_id', 'session_id'],
  Delete: ['file_path', 'path'],
  Edit: ['file_path', 'path'],
  Glob: ['pattern'],
  Grep: ['pattern'],
  ImageGeneration: ['path', 'saved_path'],
  KillShell: ['shell_id'],
  NotebookEdit: ['notebook_path'],
  Read: ['file_path'],
  Skill: ['skill'],
  SlashCommand: ['command'],
  Task: ['description'],
  TodoWrite: [],
  ToolSearch: ['query'],
  UpdatePlan: [],
  ViewImage: ['path'],
  Wait: ['cell_id'],
  Web: ['query', 'action'],
  WebFetch: ['url'],
  WebSearch: ['query'],
  Write: ['file_path', 'path'],
};

function shortScalar(value) {
  return typeof value === 'string' ? value : '';
}

// One-line rendering of a call's arguments. Whitespace collapses so a heredoc
// or multi-line command stays one line. Paths below the session cwd are shown
// relative to the directory where that session actually started.
function toolSummary(name, input, cwd) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
  const keys = TOOL_PRIMARY[name];
  let raw = '';
  if (keys) {
    for (const k of keys) {
      const candidate = shortScalar(input[k]);
      if (candidate.trim() !== '') {
        raw = candidate;
        break;
      }
    }
  }
  if (raw === '' && (!keys || keys.length > 0)) {
    for (const value of Object.values(input)) {
      const candidate = shortScalar(value);
      if (
        candidate.trim() !== '' &&
        candidate.length <= TOOL_LIMITS.TOOL_SUMMARY * 4
      ) {
        raw = candidate;
        break;
      }
    }
  }
  if (typeof cwd === 'string' && cwd !== '' && raw.startsWith(`${cwd}/`)) {
    raw = raw.slice(cwd.length + 1);
  }
  const flat = raw.replace(/\s+/g, ' ').trim();
  if (flat.length <= TOOL_LIMITS.TOOL_SUMMARY) return flat;
  return `${cutUnits(flat, TOOL_LIMITS.TOOL_SUMMARY).trimEnd()}…`;
}

// A result can be a string or a content-block array. Non-text parts are named
// rather than dropped, and image bytes are never copied into retained history.
function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (typeof block.type === 'string') parts.push(`[${block.type}]`);
  }
  return parts.join('\n');
}

function clipResult(text) {
  const safe = typeof text === 'string' ? text : '';
  const trimmed = safe.replace(/\s+$/, '');
  if (trimmed === '') return { text: '', more: 0 };
  const lines = trimmed.split('\n');
  const kept = lines.slice(0, TOOL_LIMITS.TOOL_RESULT_LINES).map((line) =>
    line.length > TOOL_LIMITS.TOOL_RESULT_COLS
      ? `${cutUnits(line, TOOL_LIMITS.TOOL_RESULT_COLS)}…`
      : line,
  );
  const more = lines.length - kept.length;
  let out = kept.join('\n');
  // The line and column limits currently make this unreachable, but retain a
  // visible hard backstop if those limits ever change independently.
  if (out.length > TOOL_LIMITS.TOOL_RESULT_CHARS) {
    out = `${cutUnits(out, TOOL_LIMITS.TOOL_RESULT_CHARS - 1)}…`;
  }
  return { text: out, more: more > 0 ? more : 0 };
}

function patchCounts(structuredPatch) {
  if (!Array.isArray(structuredPatch) || structuredPatch.length === 0) return undefined;
  let added = 0;
  let removed = 0;
  for (const hunk of structuredPatch) {
    if (!hunk || !Array.isArray(hunk.lines)) continue;
    for (const line of hunk.lines) {
      if (typeof line !== 'string') continue;
      if (line.startsWith('+')) added += 1;
      else if (line.startsWith('-')) removed += 1;
    }
  }
  return added || removed ? { added, removed } : undefined;
}

function diffLines(structuredPatch, budget = TOOL_LIMITS.TOOL_DIFF_LINES) {
  if (!Array.isArray(structuredPatch) || structuredPatch.length === 0) return undefined;
  const all = [];
  for (const hunk of structuredPatch) {
    if (!hunk || !Array.isArray(hunk.lines) || hunk.lines.length === 0) continue;
    let oldNo = Number.isFinite(hunk.oldStart) ? hunk.oldStart : 0;
    let newNo = Number.isFinite(hunk.newStart) ? hunk.newStart : 0;
    if (all.length) all.push({ gap: true });
    for (const raw of hunk.lines) {
      if (typeof raw !== 'string') continue;
      const k = raw[0] === '+' || raw[0] === '-' ? raw[0] : ' ';
      let s = raw.slice(1);
      if (s.length > TOOL_LIMITS.TOOL_DIFF_COLS) {
        s = `${cutUnits(s, TOOL_LIMITS.TOOL_DIFF_COLS)}…`;
      }
      if (k === '-') {
        all.push({ k, n: oldNo, s });
        oldNo += 1;
      } else if (k === '+') {
        all.push({ k, n: newNo, s });
        newNo += 1;
      } else {
        all.push({ k, n: newNo, s });
        oldNo += 1;
        newNo += 1;
      }
    }
  }
  if (!all.some((line) => !line.gap)) return undefined;
  let shown = 0;
  for (let i = 0; i < all.length; i += 1) {
    if (all[i].gap) continue;
    shown += 1;
    if (shown === budget) {
      const more = all.slice(i + 1).filter((line) => !line.gap).length;
      if (!more) break;
      return { lines: all.slice(0, i + 1), more };
    }
  }
  return { lines: all, more: 0 };
}

function writtenLines(content) {
  if (typeof content !== 'string') return undefined;
  const trimmed = content.replace(/\s+$/, '');
  return trimmed === '' ? undefined : trimmed.split('\n').length;
}

function plural(n, noun) {
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}

const COLLAPSED_TOOLS = new Set(['Read', 'ViewImage']);

function presentResult(name, res) {
  const base = { text: res.text, more: res.more, isError: res.isError };
  if (res.patch) {
    const { added, removed } = res.patch;
    const parts = [];
    if (added) parts.push(`Added ${plural(added, 'line')}`);
    if (removed) parts.push(`${added ? 'removed' : 'Removed'} ${plural(removed, 'line')}`);
    const counts = parts.join(', ');
    return {
      text: '',
      more: 0,
      isError: res.isError,
      summary: res.summary ? [counts, res.summary].filter(Boolean).join('; ') : counts,
      diff: res.diff,
    };
  }
  if (Number.isFinite(res.wrote) && res.wrote >= 0) {
    return {
      text: '',
      more: 0,
      isError: res.isError,
      summary: res.summary || `Wrote ${plural(res.wrote, 'line')}`,
    };
  }
  if (typeof res.summary === 'string' && res.summary !== '') {
    return { text: '', more: 0, isError: res.isError, summary: res.summary, diff: res.diff };
  }
  if (!COLLAPSED_TOOLS.has(name) || res.isError) return base;
  if (res.text === '[image]') return { text: '', more: 0, isError: false, summary: 'image' };
  const lines = res.text ? res.text.split('\n').length + res.more : 0;
  if (!lines) return base;
  return { text: '', more: 0, isError: false, summary: plural(lines, 'line') };
}

function markStalePending(messages) {
  let laterUserTurn = false;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === 'user') laterUserTurn = true;
    else if (
      message.role === 'tool' &&
      message.result === undefined &&
      laterUserTurn
    ) {
      message.stale = true;
    }
  }
}

function applyToolResults(messages, results) {
  if (!Array.isArray(results) || results.length === 0) return;
  for (const res of results) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (
        message.role === 'tool' &&
        message.tool.id === res.id &&
        message.result === undefined
      ) {
        message.result = presentResult(message.tool.name, res);
        break;
      }
    }
  }
}

module.exports = {
  TOOL_LIMITS,
  toolSummary,
  toolResultText,
  clipResult,
  patchCounts,
  diffLines,
  writtenLines,
  presentResult,
  markStalePending,
  applyToolResults,
};
