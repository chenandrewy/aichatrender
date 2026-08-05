// Pure transcript-parsing module for AIChatRender. No vscode imports — unit-testable
// under node:test. Converts Claude Code session JSONL lines into renderable
// messages of ordered text/math spans. Fail-soft throughout: anything with an
// unexpected shape is skipped, never fatal.
'use strict';

const path = require('path');

const LIMITS = {
  MAX_TEXT: 128 * 1024, // chars kept per message (truncate beyond, with marker)
  MAX_MATH_SPAN: 8192, // chars in a single math span (drop beyond, with notice)
  MAX_MATH_PER_MSG: 64, // math spans per message (extras rendered as plain text)
  MAX_LINE: 256 * 1024, // bytes; longer JSONL lines skipped before JSON.parse
  MAX_PARTIAL: 512 * 1024, // bytes; partial-line buffer cap (discard + resync)
  MAX_TURNS: 100, // user turns retained in the panel — the retention policy
  MAX_MESSAGES: 3000, // redraw ceiling under MAX_TURNS (see trimToTurns)
  MAX_REBUILD_BYTES: 10 * 1024 * 1024, // tail read on whole-file rebuild
  TURN_PREVIEW: 80, // UTF-16 units of a user prompt shown in the turn picker
  TOOL_SUMMARY: 160, // UTF-16 units of a tool call's primary argument
  TOOL_RESULT_LINES: 8, // result lines shown before the "+N lines" marker
  TOOL_RESULT_CHARS: 2048, // chars kept of a result, however few lines that is
  TOOL_DIFF_LINES: 40, // diff lines rendered before the "+N lines" marker
  TOOL_DIFF_COLS: 400, // chars kept of a single diff line
};

// Claude Code's project-directory munge: every non-alphanumeric character of the
// session cwd becomes '-', per character, with no run-collapsing
// ('/tmp/pdf2md__logotr_' -> '-tmp-pdf2md--logotr-').
function mungePath(p) {
  let out = '';
  for (const ch of p) out += /[A-Za-z0-9]/.test(ch) ? ch : '-';
  return out;
}

// Is `child` the directory `parent`, or anything beneath it? Both vendors record
// the cwd a session was launched in, and a session in a subdirectory of the
// workspace folder is still this workspace's session. Purely lexical: callers
// resolve symlinks first, since only they know which paths are real.
function pathWithin(parent, child) {
  if (typeof parent !== 'string' || typeof child !== 'string') return false;
  if (parent === '' || child === '') return false;
  const rel = path.relative(parent, child);
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  );
}

// Splits incoming byte chunks into complete UTF-8 lines. Buffers the trailing
// partial line as bytes (never decodes a split UTF-8 sequence). Oversized lines
// are skipped without decoding; an over-cap partial buffer is discarded and the
// reader resyncs at the next newline.
class LineBuffer {
  constructor() {
    this.partial = Buffer.alloc(0);
    this.discarding = false;
  }

  reset() {
    this.partial = Buffer.alloc(0);
    this.discarding = false;
  }

  // Call when the next pushed bytes start mid-line (tail rebuild): everything up
  // to and including the first newline is dropped.
  startMidLine() {
    this.partial = Buffer.alloc(0);
    this.discarding = true;
  }

  push(buf) {
    const data = this.partial.length ? Buffer.concat([this.partial, buf]) : buf;
    const lines = [];
    let start = 0;
    for (;;) {
      const nl = data.indexOf(0x0a, start);
      if (nl === -1) break;
      if (this.discarding) {
        this.discarding = false; // dropped through the resync newline
      } else {
        const len = nl - start;
        if (len > 0 && len <= LIMITS.MAX_LINE) {
          lines.push(data.toString('utf8', start, nl));
        }
      }
      start = nl + 1;
    }
    if (this.discarding) {
      this.partial = Buffer.alloc(0); // still inside a discarded line
    } else {
      this.partial = Buffer.from(data.subarray(start));
      if (this.partial.length > LIMITS.MAX_PARTIAL) {
        this.partial = Buffer.alloc(0);
        this.discarding = true;
      }
    }
    return lines;
  }
}

// Delimiters scanned in priority order; at equal positions the earlier entry
// wins (``` before `). Code is kept as literal text and never math-scanned.
const DELIMS = [
  { open: '```', close: '```', kind: 'code', sameLine: false },
  { open: '`', close: '`', kind: 'code', sameLine: true },
  { open: '$$', close: '$$', kind: 'math', mode: 'display', sameLine: false },
  { open: '\\[', close: '\\]', kind: 'math', mode: 'display', sameLine: false },
  { open: '\\(', close: '\\)', kind: 'math', mode: 'inline', sameLine: false },
  { open: '$', close: '$', kind: 'math', mode: 'inline', singleDollar: true },
];

// Pandoc-style closer search for single-$ inline math: same line, closing $
// not escaped, not preceded by whitespace, not immediately followed by a digit
// (kills "between $20,000 and $30,000"). Returns -1 if no valid closer.
function findDollarClose(text, from) {
  const nl = text.indexOf('\n', from);
  const limit = nl === -1 ? text.length : nl;
  for (let j = text.indexOf('$', from); j !== -1 && j < limit; j = text.indexOf('$', j + 1)) {
    const before = text[j - 1];
    const after = j + 1 < text.length ? text[j + 1] : '';
    if (before === '\\' || /\s/.test(before)) continue;
    if (after >= '0' && after <= '9') continue;
    return j;
  }
  return -1;
}

// Segments one text block into ordered spans: {t:'text',s} | {t:'math',m,s}.
// Concatenating text spans plus delimited math reconstructs the input.
function segment(text) {
  const spans = [];
  let textBuf = '';
  const flush = () => {
    if (textBuf) {
      spans.push({ t: 'text', s: textBuf });
      textBuf = '';
    }
  };
  let i = 0;
  while (i < text.length) {
    let best = null;
    for (const d of DELIMS) {
      const idx = text.indexOf(d.open, i);
      if (idx !== -1 && (best === null || idx < best.idx)) best = { d, idx };
    }
    if (!best) {
      textBuf += text.slice(i);
      break;
    }
    const { d, idx } = best;
    textBuf += text.slice(i, idx);
    const bodyStart = idx + d.open.length;
    if (d.singleDollar) {
      // Opener must not be escaped and must have a non-space right after it.
      const prev = idx > 0 ? text[idx - 1] : '';
      const next = text[bodyStart];
      const closeIdx =
        prev !== '\\' && next && !/\s/.test(next) ? findDollarClose(text, bodyStart) : -1;
      if (closeIdx === -1) {
        textBuf += d.open; // currency, $VAR, lone $: literal text
        i = bodyStart;
        continue;
      }
      flush();
      spans.push({ t: 'math', m: 'inline', s: text.slice(bodyStart, closeIdx).trim() });
      i = closeIdx + 1;
      continue;
    }
    let closeIdx = text.indexOf(d.close, bodyStart);
    if (closeIdx !== -1 && d.sameLine) {
      const nl = text.indexOf('\n', bodyStart);
      if (nl !== -1 && closeIdx > nl) closeIdx = -1;
    }
    if (closeIdx === -1) {
      if (d.kind === 'code' && !d.sameLine) {
        textBuf += text.slice(idx); // unterminated fence: rest is code
        break;
      }
      textBuf += d.open; // unclosed delimiter is literal text
      i = bodyStart;
      continue;
    }
    const end = closeIdx + d.close.length;
    if (d.kind === 'code') {
      textBuf += text.slice(idx, end); // code shown verbatim, delimiters included
    } else {
      flush();
      const body = text.slice(bodyStart, closeIdx).trim();
      if (body) spans.push({ t: 'math', m: d.mode, s: body });
    }
    i = end;
  }
  flush();
  return spans;
}

// segment() plus the resource limits: message truncation (visible marker),
// over-size math dropped (never rendered truncated), over-count math inert.
function blockToSpans(text) {
  let truncated = false;
  if (text.length > LIMITS.MAX_TEXT) {
    text = text.slice(0, LIMITS.MAX_TEXT);
    truncated = true;
  }
  const out = [];
  let mathCount = 0;
  for (const sp of segment(text)) {
    if (sp.t === 'math') {
      if (sp.s.length > LIMITS.MAX_MATH_SPAN) {
        out.push({ t: 'text', s: '[formula omitted: size limit exceeded]' });
        continue;
      }
      mathCount += 1;
      if (mathCount > LIMITS.MAX_MATH_PER_MSG) {
        out.push({ t: 'text', s: sp.s });
        continue;
      }
    }
    out.push(sp);
  }
  if (truncated) out.push({ t: 'text', s: '\n[message truncated: size limit]' });
  return out;
}

// Cuts to at most `maxUnits` UTF-16 units. slice() counts UTF-16 units: cutting
// between an astral character's surrogates would render the half as U+FFFD, so
// drop a trailing lone high surrogate. (Multi-codepoint clusters — ZWJ emoji,
// flags — can still split, which loses a glyph rather than showing a
// replacement character.)
function cutUnits(s, maxUnits) {
  if (s.length <= maxUnits) return s;
  const cut = s.slice(0, maxUnits);
  const lastUnit = cut.charCodeAt(cut.length - 1);
  return lastUnit >= 0xd800 && lastUnit <= 0xdbff ? cut.slice(0, -1) : cut;
}

// One-line preview of a message, for the turn picker. Math spans keep their
// source (delimiters restored, so `$x$` reads as math rather than a bare x),
// runs of whitespace collapse to single spaces, and the result is capped with
// an ellipsis. Returns '' for a message with nothing but blank text.
//
// The cap counts UTF-16 units, not code points: it exists to bound how wide the
// label renders, and wide characters (emoji, CJK) occupy roughly two units and
// about two columns, so units track rendered width better than code points do.
// Hence `maxUnits`, and "about 80 characters" in the docs.
function turnPreview(spans, maxUnits = LIMITS.TURN_PREVIEW) {
  const list = Array.isArray(spans) ? spans : [];
  let out = '';
  let more = false;
  for (let i = 0; i < list.length; i += 1) {
    const sp = list[i];
    if (!sp || typeof sp.s !== 'string') continue;
    // Collapse as we accumulate, so the cap is measured against what will
    // actually be shown. Stopping on raw length instead would discard a whole
    // prompt sitting behind a long run of blank lines.
    out = (out + (sp.t === 'math' ? `$${sp.s}$` : sp.s)).replace(/\s+/g, ' ');
    if (out.length > maxUnits) {
      // The cap can be crossed by trailing whitespace that trim() then removes,
      // leaving a string back under it. Record whether anything visible is left
      // unread, so a truncated prompt is never presented as a complete one.
      more = list
        .slice(i + 1)
        .some((rest) => rest && typeof rest.s === 'string' && rest.s.trim() !== '');
      break;
    }
  }
  out = out.trim();
  if (out.length <= maxUnits) return more ? `${out}…` : out;
  return `${cutUnits(out, maxUnits).trimEnd()}…`;
}

// Content-block types we know about, so an unfamiliar one can drive the
// "format may have changed" notice rather than disappearing quietly. These are
// the Messages API's own block names, which is the documented, versioned side
// of the transcript. `thinking` is known and deliberately skipped; the user-side
// attachment blocks are known and skipped because the panel shows prompts as
// text. Observed across 6,700 tool calls: nothing else appears today.
const ASSISTANT_BLOCKS = new Set(['text', 'thinking', 'tool_use']);
const USER_BLOCKS = new Set(['tool_result', 'text', 'image', 'document']);

// ------------------------------------------------------------------ tool calls

// The input field each tool is identified by in the CLI's own transcript, so a
// call reads the way the terminal shows it: Bash by its command, Read by its
// path. First key present wins. A tool absent here (or an MCP tool, whose names
// are not knowable in advance) falls back to the first short string in its
// input, which is usually the interesting one; failing that, the call shows its
// name alone rather than nothing.
const TOOL_PRIMARY = {
  Agent: ['description'],
  Bash: ['command'],
  BashOutput: ['bash_id'],
  Edit: ['file_path'],
  Glob: ['pattern'],
  Grep: ['pattern'],
  KillShell: ['shell_id'],
  NotebookEdit: ['notebook_path'],
  Read: ['file_path'],
  Skill: ['skill'],
  SlashCommand: ['command'],
  Task: ['description'],
  TodoWrite: [],
  ToolSearch: ['query'],
  WebFetch: ['url'],
  WebSearch: ['query'],
  Write: ['file_path'],
};

// One-line rendering of a call's arguments. Whitespace collapses so a heredoc
// or a multi-line command stays one line, as it does in the terminal. Paths
// under the session's own cwd are shown relative to it, again as the terminal
// does — the absolute prefix is the same on every line and only costs width.
function toolSummary(name, input, cwd) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
  const keys = TOOL_PRIMARY[name];
  let raw = '';
  if (keys) {
    for (const k of keys) {
      if (typeof input[k] === 'string' && input[k].trim() !== '') {
        raw = input[k];
        break;
      }
    }
  }
  // Fall through to the generic scan when a mapped key finds nothing: a known
  // tool whose input schema was renamed under us would otherwise render with a
  // blank argument, which reads as a bug rather than as drift. An empty mapping
  // (TodoWrite) means "no argument worth showing" and is left alone.
  if (raw === '' && (!keys || keys.length > 0)) {
    for (const v of Object.values(input)) {
      // A long string is a payload (file contents, a patch), not a label.
      if (typeof v === 'string' && v.trim() !== '' && v.length <= LIMITS.TOOL_SUMMARY * 4) {
        raw = v;
        break;
      }
    }
  }
  if (typeof cwd === 'string' && cwd !== '' && raw.startsWith(`${cwd}/`)) {
    raw = raw.slice(cwd.length + 1);
  }
  const flat = raw.replace(/\s+/g, ' ').trim();
  if (flat.length <= LIMITS.TOOL_SUMMARY) return flat;
  return `${cutUnits(flat, LIMITS.TOOL_SUMMARY).trimEnd()}…`;
}

// A tool_result's content is a string in most records and a content-block array
// in the rest (Read of an image, tools that return mixed parts). Non-text parts
// are named rather than dropped, so a result never renders as blank when
// something was in fact returned.
function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    else if (typeof b.type === 'string') parts.push(`[${b.type}]`);
  }
  return parts.join('\n');
}

// Clips a result to the terminal's shape: a few lines, then a count of what was
// left unread. Trailing blank lines are dropped first so they don't spend the
// line budget or inflate the marker.
function clipResult(text) {
  const trimmed = text.replace(/\s+$/, '');
  if (trimmed === '') return { text: '', more: 0 };
  const lines = trimmed.split('\n');
  const kept = lines.slice(0, LIMITS.TOOL_RESULT_LINES);
  let more = lines.length - kept.length;
  let out = kept.join('\n');
  if (out.length > LIMITS.TOOL_RESULT_CHARS) {
    out = cutUnits(out, LIMITS.TOOL_RESULT_CHARS);
    // The char cap can cut mid-line; that partial line is still shown, so count
    // only the lines it removed outright.
    more = lines.length - out.split('\n').length;
  }
  return { text: out, more: more > 0 ? more : 0 };
}

// Counts the changed lines in a structuredPatch — the one field this module
// takes from `toolUseResult`, the CLI's internal sidecar. Over 34 observed CLI
// versions that record only ever gained keys, and `structuredPatch` was present
// in every variant; even so, anything unrecognized returns undefined and the
// caller falls back to the tool_result text, which is the documented channel.
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

// Flattens a structuredPatch into rendered diff lines, numbered as the CLI
// numbers them: a removed line carries its number in the old file, an added or
// unchanged line its number in the new one. Hunks are separated by a gap marker
// rather than a @@ header, matching what the terminal draws.
//
// Two passes, because the budget has to be spent on visible lines: build
// everything, then cut. Real patches are small enough for that to be free —
// median 12 lines over 1291 observed patches, p99 248.
function diffLines(structuredPatch, budget = LIMITS.TOOL_DIFF_LINES) {
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
      if (s.length > LIMITS.TOOL_DIFF_COLS) s = `${cutUnits(s, LIMITS.TOOL_DIFF_COLS)}…`;
      if (k === '-') {
        all.push({ k, n: oldNo, s });
        oldNo += 1;
      } else if (k === '+') {
        all.push({ k, n: newNo, s });
        newNo += 1;
      } else {
        all.push({ k, n: newNo, s }); // unchanged: numbered in the new file
        oldNo += 1;
        newNo += 1;
      }
    }
  }
  if (!all.some((l) => !l.gap)) return undefined;
  let shown = 0;
  for (let i = 0; i < all.length; i += 1) {
    if (all[i].gap) continue;
    shown += 1;
    if (shown === budget) {
      const rest = all.slice(i + 1);
      const more = rest.filter((l) => !l.gap).length;
      if (!more) break; // the budget landed exactly on the end
      const lines = all.slice(0, i + 1);
      return { lines, more };
    }
  }
  return { lines: all, more: 0 };
}

// A new file has nothing to diff against, so its patch comes back empty and the
// size has to come from the written content instead. `content` is Write's own
// always-present field and is absent from Edit's record, so its presence is
// also what distinguishes the two. Same sidecar, same fail-soft rule.
function writtenLines(content) {
  if (typeof content !== 'string') return undefined;
  const trimmed = content.replace(/\s+$/, '');
  return trimmed === '' ? undefined : trimmed.split('\n').length;
}

function plural(n, noun) {
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}

// Tools whose output is a file the reader is not reading right now. The panel
// reports that the call happened and how much came back; the terminal hides
// these behind an expand key for the same reason. Derived from the tool_result
// block itself, so the collapse costs no dependency on the sidecar.
const COLLAPSED_TOOLS = new Set(['Read']);

// Final shape of a result, once its call is known. A file edit becomes its line
// counts, a file read becomes its size, and everything else keeps the clipped
// output — which for Bash is already exactly what the terminal shows, since
// there the documented channel *is* stdout.
function presentResult(name, res) {
  const base = { text: res.text, more: res.more, isError: res.isError };
  if (res.patch) {
    const { added, removed } = res.patch;
    const parts = [];
    if (added) parts.push(`Added ${plural(added, 'line')}`);
    if (removed) parts.push(`${added ? 'removed' : 'Removed'} ${plural(removed, 'line')}`);
    return {
      text: '',
      more: 0,
      isError: res.isError,
      summary: parts.join(', '),
      diff: res.diff,
    };
  }
  if (res.wrote) {
    // Otherwise a new file reports "File created successfully at: <path>",
    // which only repeats the path already on the call line.
    return { text: '', more: 0, isError: res.isError, summary: `Wrote ${plural(res.wrote, 'line')}` };
  }
  // An error carries the reason in its text; never collapse that away.
  if (!COLLAPSED_TOOLS.has(name) || res.isError) return base;
  if (res.text === '[image]') return { text: '', more: 0, isError: false, summary: 'image' };
  const lines = res.text ? res.text.split('\n').length + res.more : 0;
  if (!lines) return base;
  return { text: '', more: 0, isError: false, summary: plural(lines, 'line') };
}

// Marks calls that will never be answered. A call is pending until its result
// arrives, but once the user has spoken again the exchange has moved on, so a
// perpetual "running…" would be indistinguishable from the panel having lost
// track of the format. `result` is left undefined so a late result still binds.
function markStalePending(messages) {
  let laterUserTurn = false;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role === 'user') laterUserTurn = true;
    else if (m.role === 'tool' && m.result === undefined && laterUserTurn) m.stale = true;
  }
}

// Attaches results to the calls they belong to, by tool_use_id. A result whose
// call has already been trimmed out of the retained window simply finds nothing.
// Scans backwards: a call is answered within a turn or two of being made.
function applyToolResults(messages, results) {
  if (!Array.isArray(results) || results.length === 0) return;
  for (const res of results) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m.role === 'tool' && m.tool.id === res.id && m.result === undefined) {
        m.result = presentResult(m.tool.name, res);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- retention

// Keeps the most recent MAX_TURNS user turns, cutting at a turn boundary so the
// panel always opens on a prompt rather than mid-exchange. Turns are the unit
// people actually think in.
//
// MAX_MESSAGES stays on underneath because turns alone cannot bound the redraw:
// the webview rebuilds every entry on each append, so entry count sets the cost
// of a frame, and one turn can hold hundreds of tool calls. Across 151 observed
// sessions the widest turn held 246 entries and no whole session exceeded 388,
// so this never fires in ordinary use — it exists for the unattended run that
// tools its way through a single prompt for hours.
function trimToTurns(messages, maxTurns = LIMITS.MAX_TURNS, maxMessages = LIMITS.MAX_MESSAGES) {
  let out = messages;
  let turns = 0;
  for (let i = out.length - 1; i >= 0; i -= 1) {
    if (out[i].role !== 'user') continue;
    turns += 1;
    if (turns === maxTurns) {
      out = out.slice(i); // cut on the prompt that opens the oldest kept turn
      break;
    }
  }
  return out.length > maxMessages ? out.slice(-maxMessages) : out;
}

function makeMessage(rec, role, text) {
  return {
    ts: typeof rec.timestamp === 'string' ? rec.timestamp : '',
    role,
    spans: blockToSpans(text),
  };
}

// One JSONL line -> { messages: [...], results: [...], unexpected: bool }.
// `unexpected` marks a record we should consume but whose shape we don't
// recognize (drives the "format may have changed" notice); records we
// deliberately skip don't set it. `results` carries tool results, which arrive
// in a later record than the call they answer and so are joined by the caller
// rather than here — parseLine stays a pure function of its one line.
function parseLine(line, opts) {
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    return { messages: [], unexpected: false };
  }
  const none = { messages: [], unexpected: false };
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
    return { messages: [], unexpected: true };
  }
  if (rec.isSidechain === true) return none; // subagent traffic
  if (rec.type === 'assistant') {
    const content = rec.message && rec.message.content;
    if (!Array.isArray(content)) return { messages: [], unexpected: true };
    const messages = [];
    let changedShape = false;
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      // A tool call arriving under a name we don't know would otherwise vanish
      // from the panel in silence; say so instead.
      if (!ASSISTANT_BLOCKS.has(b.type)) {
        changedShape = true;
        continue;
      }
      if (b.type === 'tool_use') {
        if (typeof b.name !== 'string' || b.name === '') continue;
        messages.push({
          ts: typeof rec.timestamp === 'string' ? rec.timestamp : '',
          role: 'tool',
          tool: {
            id: typeof b.id === 'string' ? b.id : '',
            name: b.name,
            summary: toolSummary(b.name, b.input, rec.cwd),
          },
          result: undefined, // filled in when its tool_result record arrives
        });
        continue;
      }
      if (b.type !== 'text') continue; // thinking stays skipped
      if (typeof b.text !== 'string' || b.text.trim() === '') continue;
      messages.push(makeMessage(rec, 'assistant', b.text));
    }
    return { messages, unexpected: changedShape };
  }
  if (rec.type === 'user') {
    const content = rec.message && rec.message.content;
    // Tool results ride in on a user record; they are not a prompt, and are
    // collected whether or not user prompts are being shown.
    if (Array.isArray(content)) {
      const results = [];
      let changedShape = false;
      for (const b of content) {
        if (!b || typeof b !== 'object') continue;
        if (!USER_BLOCKS.has(b.type)) {
          changedShape = true; // a result under an unknown name would go silent
          continue;
        }
        if (b.type !== 'tool_result') continue; // pasted attachments, interrupts
        if (typeof b.tool_use_id !== 'string' || b.tool_use_id === '') continue;
        const clipped = clipResult(toolResultText(b.content));
        results.push({
          id: b.tool_use_id,
          text: clipped.text,
          more: clipped.more,
          isError: b.is_error === true,
        });
      }
      // The sidecar describes the record's single tool result. Only take it when
      // there is exactly one, so a patch can never be attributed to the wrong
      // call if a record ever carries several.
      if (results.length === 1 && rec.toolUseResult && typeof rec.toolUseResult === 'object') {
        const patch = patchCounts(rec.toolUseResult.structuredPatch);
        if (patch) {
          results[0].patch = patch;
          results[0].diff = diffLines(rec.toolUseResult.structuredPatch);
        } else {
          const wrote = writtenLines(rec.toolUseResult.content);
          if (wrote) results[0].wrote = wrote;
        }
      }
      return { messages: [], results, unexpected: changedShape };
    }
    if (!opts || !opts.includeUser) return none;
    if (rec.isMeta === true) return none;
    if (rec.toolUseResult !== undefined) return none; // tool result, not a prompt
    if (typeof content !== 'string') return none;
    const s = content.trimStart();
    if (
      !s ||
      s.startsWith('<command-') ||
      s.startsWith('<local-command') ||
      s.startsWith('<system-reminder>') ||
      s.startsWith('<task-notification>')
    ) {
      return none; // harness bookkeeping, not something the user typed
    }
    return { messages: [makeMessage(rec, 'user', content)], unexpected: false };
  }
  return none; // other record types are bookkeeping
}

module.exports = {
  LIMITS,
  mungePath,
  pathWithin,
  LineBuffer,
  segment,
  blockToSpans,
  turnPreview,
  toolSummary,
  toolResultText,
  clipResult,
  patchCounts,
  diffLines,
  writtenLines,
  presentResult,
  markStalePending,
  applyToolResults,
  trimToTurns,
  parseLine,
};
