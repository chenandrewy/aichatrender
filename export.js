// Pure JSONL-to-Markdown export helpers for AIChatRender. No vscode or
// filesystem imports, so the formatter can be reused by scripts and tests.
'use strict';

const path = require('node:path');
const { LIMITS, parseLine: parseClaudeLine } = require('./transcript');
const { parseLine: parseCodexLine, sessionMetaFromLine } = require('./codex');

const PROVIDERS = new Set(['auto', 'claude', 'codex']);
const CODEX_RECORD_TYPES = new Set([
  'event_msg',
  'response_item',
  'session_meta',
  'turn_context',
  'world_state',
]);
const CLAUDE_RECORD_TYPES = new Set([
  'assistant',
  'file-history-snapshot',
  'mode',
  'permission-mode',
  'queue-operation',
  'user',
]);

function jsonLines(raw) {
  return raw.split(/\r?\n/).filter((line) => line !== '');
}

function recordFromLine(line) {
  try {
    const rec = JSON.parse(line);
    return rec && typeof rec === 'object' && !Array.isArray(rec) ? rec : undefined;
  } catch {
    return undefined;
  }
}

function detectProvider(lines, inputPath = '') {
  if (/^rollout-.*\.jsonl$/i.test(path.basename(inputPath))) return 'codex';
  for (const line of lines) {
    const rec = recordFromLine(line);
    if (!rec) continue;
    if (CODEX_RECORD_TYPES.has(rec.type)) return 'codex';
    if (CLAUDE_RECORD_TYPES.has(rec.type)) return 'claude';
  }
  throw new Error('Could not detect transcript provider; pass --provider claude or --provider codex.');
}

function transcriptMetadata(lines, provider) {
  let sessionId = '';
  let cwd = '';
  let sessionTimestamp = '';
  for (const line of lines) {
    const rec = recordFromLine(line);
    if (!rec) continue;
    if (provider === 'codex') {
      const meta = sessionMetaFromLine(line);
      if (meta) {
        cwd = meta.cwd;
        sessionTimestamp = meta.timestamp;
      }
      const payload = rec.payload;
      if (rec.type === 'session_meta' && payload && typeof payload.id === 'string') {
        sessionId = payload.id;
      }
    } else {
      if (!sessionId && typeof rec.sessionId === 'string') sessionId = rec.sessionId;
      if (!cwd && typeof rec.cwd === 'string') cwd = rec.cwd;
    }
    if (sessionId && cwd && (provider === 'claude' || sessionTimestamp)) break;
  }
  return { sessionId, cwd, sessionTimestamp };
}

function parseTranscript(raw, options = {}) {
  if (typeof raw !== 'string') throw new TypeError('Transcript input must be a string.');
  const requested = options.provider || 'auto';
  if (!PROVIDERS.has(requested)) {
    throw new Error(`Unknown provider: ${requested}. Expected auto, claude, or codex.`);
  }
  const lines = jsonLines(raw);
  const provider = requested === 'auto' ? detectProvider(lines, options.inputPath) : requested;
  const metadata = transcriptMetadata(lines, provider);
  const messages = [];
  let unexpectedRecords = 0;
  let oversizedLines = 0;
  for (const line of lines) {
    if (Buffer.byteLength(line, 'utf8') > LIMITS.MAX_LINE) {
      oversizedLines += 1;
      continue;
    }
    const opts = {
      includeUser: true,
      sessionTimestamp: metadata.sessionTimestamp,
    };
    const parsed =
      provider === 'codex' ? parseCodexLine(line, opts) : parseClaudeLine(line, opts);
    if (parsed.unexpected) unexpectedRecords += 1;
    // Tool calls are a panel feature: the export is prose meant to be pasted
    // into a document, so it stays the transcript's conversation alone.
    messages.push(...parsed.messages.filter((message) => message.role !== 'tool'));
  }
  return {
    provider,
    messages,
    turns: messages.filter((message) => message.role === 'user').length,
    unexpectedRecords,
    oversizedLines,
    ...metadata,
  };
}

function spansToMarkdown(spans) {
  let out = '';
  for (const span of Array.isArray(spans) ? spans : []) {
    if (!span || typeof span.s !== 'string') continue;
    if (span.t !== 'math') {
      out += span.s;
    } else if (span.m === 'display') {
      out += `\n\n$$\n${span.s}\n$$\n\n`;
    } else {
      out += `$${span.s}$`;
    }
  }
  return out.trim();
}

function messageGroups(messages) {
  const groups = [];
  let turn = 0;
  for (const message of messages) {
    if (message.role === 'user') turn += 1;
    const previous = groups[groups.length - 1];
    if (message.role === 'assistant' && previous && previous.role === 'assistant') {
      previous.messages.push(message);
      continue;
    }
    groups.push({ role: message.role, turn, messages: [message] });
  }
  return groups;
}

function firstWords(spans, count = 5) {
  const text = (Array.isArray(spans) ? spans : [])
    .map((span) => {
      if (!span || typeof span.s !== 'string') return '';
      return span.t === 'math' ? `$${span.s}$` : span.s;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return text.split(' ').filter(Boolean).slice(0, count).join(' ');
}

function renderMarkdown(transcript, options = {}) {
  const providerLabel = transcript.provider === 'codex' ? 'Codex CLI' : 'Claude Code';
  const id = transcript.sessionId || path.basename(options.inputPath || '', '.jsonl');
  const title = id ? `${providerLabel} transcript — ${id}` : `${providerLabel} transcript`;
  const lines = [
    `**${title}**`,
    '',
    '> Private development export generated from a local JSONL transcript.',
    '',
    `- Provider: ${providerLabel}`,
    `- Turns: ${transcript.turns}`,
    `- Displayable messages: ${transcript.messages.length}`,
  ];
  if (transcript.cwd) lines.push(`- Working directory: \`${transcript.cwd}\``);
  if (options.inputPath) lines.push(`- Source: \`${path.resolve(options.inputPath)}\``);
  if (transcript.unexpectedRecords) {
    lines.push(`- Unexpected records skipped: ${transcript.unexpectedRecords}`);
  }
  if (transcript.oversizedLines) lines.push(`- Oversized lines skipped: ${transcript.oversizedLines}`);

  for (const group of messageGroups(transcript.messages)) {
    const number = String(group.turn).padStart(2, '0');
    const summary =
      group.role === 'user' ? firstWords(group.messages[0] && group.messages[0].spans) : '';
    const turnLabel =
      group.role === 'user' ? `U${number}${summary ? ` - ${summary}` : ''}` : `A${number}`;
    lines.push('', `# ${turnLabel}`);
    const timestamp = group.messages.find((message) => message.ts)?.ts;
    if (timestamp) lines.push('', `*${timestamp}*`);
    const bodies = group.messages.map((message) => spansToMarkdown(message.spans)).filter(Boolean);
    if (bodies.length) lines.push('', bodies.join('\n\n'));
  }
  lines.push('');
  return lines.join('\n');
}

module.exports = {
  detectProvider,
  firstWords,
  parseTranscript,
  renderMarkdown,
  spansToMarkdown,
};
