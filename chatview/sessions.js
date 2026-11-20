// Run: loaded by server.js.
// Inputs: local Claude and Codex session roots and their JSONL transcripts.
// Outputs: session listings and parsed history for live viewing.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCodexParser, sessionMetaFromLine } = require('../codex');
const { claudeTitle, codexThreadId, codexIndexPaths, codexThreadNames } = require('./session-titles');
const {
  LIMITS, LineBuffer, applyToolResults, markStalePending, trimToTurns, parseLine,
} = require('../transcript');

const TIMESTAMP = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});
const READ_CHUNK = 64 * 1024;
const OPEN_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

function dirEntries(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function* transcriptFiles(directory, depth, namePattern) {
  for (const entry of dirEntries(directory)) {
    const filename = path.join(directory, entry.name);
    if (depth > 0 && entry.isDirectory()) {
      yield* transcriptFiles(filename, depth - 1, namePattern);
    } else if (depth === 0 && entry.isFile() && namePattern.test(entry.name)) {
      yield filename;
    }
  }
}

function discoverSessions() {
  const claude = path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  const codex = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
  const sessions = [];
  for (const [provider, root, depth, pattern] of [
    ['claude', claude, 1, /\.jsonl$/],
    ['codex', codex, 3, /^rollout-.*\.jsonl$/],
  ]) {
    for (const file of transcriptFiles(root, depth, pattern)) {
      const stat = fs.lstatSync(file, { throwIfNoEntry: false });
      if (!stat?.isFile() || stat.size === 0) continue;
      const relative = path.relative(root, file);
      const id = provider === 'codex' ? codexThreadId(file) : path.basename(file, '.jsonl');
      sessions.push({ key: provider + ':' + relative, provider, file, id, modified: stat.mtimeMs });
    }
  }
  sessions.sort((a, b) => b.modified - a.modified || a.key.localeCompare(b.key));
  return { sessions, codex };
}

function listSessions({ sessions, codex }) {
  const names = codexThreadNames(codexIndexPaths([codex]));
  return sessions.map(({ key, provider, file, id, modified }, index) => {
    const title = provider === 'codex' ? names.get(id) : index < 100 && claudeTitle(file);
    return { key, provider, id, modified, title: title || id || path.basename(file, '.jsonl') };
  });
}

function withTranscript(file, callback) {
  const fd = fs.openSync(file, OPEN_FLAGS);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('Transcript is not a regular file.');
    return callback(fd, stat);
  } finally {
    fs.closeSync(fd);
  }
}

function codexMetadata(fd) {
  const chunk = Buffer.alloc(LIMITS.MAX_LINE + 1);
  const size = fs.readSync(fd, chunk, 0, chunk.length, 0);
  const newline = chunk.subarray(0, size).indexOf(10);
  if (newline < 0) return size === chunk.length ? {} : undefined;
  const line = chunk.toString('utf8', 0, newline);
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return {};
  }
  return {
    ...sessionMetaFromLine(line),
    base: record?.type === 'session_meta' ? record.payload?.history_base : undefined,
  };
}

function ancestry(sessions, session, base, seen = new Set([session.key])) {
  if (!base) return [];
  const id = typeof base.thread_id === 'string' ? base.thread_id.toLowerCase() : '';
  const matches = sessions.filter((entry) => entry.provider === 'codex' && entry.id === id);
  const offset = base.end_byte_offset;
  if (!id || matches.length !== 1 || !Number.isSafeInteger(offset) || offset <= 0) {
    throw new Error('Could not resolve this Codex session’s fork history.');
  }
  const parent = matches[0];
  if (seen.has(parent.key)) throw new Error('Codex fork history contains a cycle.');
  seen.add(parent.key);
  return withTranscript(parent.file, (fd, stat) => {
    if (offset > stat.size) throw new Error('A Codex parent transcript is shorter than its fork offset.');
    const metadata = codexMetadata(fd);
    return [...ancestry(sessions, parent, metadata?.base, seen), { file: parent.file, end: offset, metadata }];
  });
}

class History {
  constructor(provider) {
    this.codex = provider === 'codex' ? createCodexParser() : undefined;
    this.lines = new LineBuffer();
    this.messages = [];
    this.nextKey = 1;
    this.unexpected = false;
    this.trimmed = false;
  }

  feed(lines, metadata) {
    for (const line of lines) {
      const options = { includeUser: true, sessionTimestamp: metadata.timestamp, cwd: metadata.cwd };
      const parsed = this.codex ? this.codex.parseLine(line, options) : parseLine(line, options);
      this.unexpected ||= parsed.unexpected === true;
      for (const message of parsed.messages) {
        message.key = this.nextKey++;
        this.messages.push(message);
      }
      applyToolResults(this.messages, parsed.results);
    }
    const kept = trimToTurns(this.messages);
    this.trimmed ||= kept.length < this.messages.length;
    this.messages = kept;
  }

  read(fd, start, end, metadata = {}) {
    const chunk = Buffer.alloc(Math.min(READ_CHUNK, end - start));
    let offset = start;
    while (offset < end) {
      const length = fs.readSync(fd, chunk, 0, Math.min(chunk.length, end - offset), offset);
      if (!length) break;
      this.feed(this.lines.push(chunk.subarray(0, length)), metadata);
      offset += length;
    }
    return offset;
  }

  snapshot() {
    markStalePending(this.messages);
    return {
      type: 'replaceHistory',
      status: this.messages.length ? '' : 'Waiting for transcript messages…',
      notice: [
        this.trimmed && 'Showing the recent part of this transcript.',
        this.unexpected && 'Some records could not be read by the transcript parser.',
      ].filter(Boolean).join(' '),
      entries: this.messages.map((message) => {
        if (message.role === 'tool') {
          const { key, role, tool, result, stale } = message;
          return { key, role, tool, result, stale: stale === true };
        }
        const date = new Date(message.ts);
        return {
          key: message.key,
          role: message.role,
          spans: message.spans,
          tsDisplay: Number.isNaN(date.getTime()) ? '' : TIMESTAMP.format(date),
        };
      }),
    };
  }
}

function loadHistory(sessions, session, fd, size) {
  const history = new History(session.provider);
  const metadata = session.provider === 'codex' ? codexMetadata(fd) : {};
  const parents = ancestry(sessions, session, metadata?.base);
  const total = size + parents.reduce((sum, part) => sum + part.end, 0);
  let skip = Math.max(0, total - LIMITS.MAX_REBUILD_BYTES);
  history.trimmed = skip > 0;
  for (const part of parents) {
    const start = Math.min(skip, part.end);
    skip -= start;
    if (start === part.end) continue;
    if (start > 0) history.lines.startMidLine();
    withTranscript(part.file, (parentFd) => {
      if (history.read(parentFd, start, part.end, part.metadata) !== part.end) {
        throw new Error('A Codex parent transcript changed while it was being read.');
      }
    });
    history.lines.reset();
  }
  if (skip > 0) history.lines.startMidLine();
  const offset = history.read(fd, skip, size, metadata);
  return { history, metadata, offset };
}

function followSession(sessions, session) {
  let current;
  return () => withTranscript(session.file, (fd, stat) => {
    const { ino, dev, size, mtimeMs } = stat;
    if (!current || current.ino !== ino || current.dev !== dev || size < current.offset
        || (!current.metadata && size > current.offset)
        || size - current.offset > LIMITS.MAX_REBUILD_BYTES
        || (current.size === size && current.mtimeMs !== mtimeMs)) {
      current = { ...loadHistory(sessions, session, fd, size), ino, dev, size, mtimeMs };
    } else if (size > current.offset) {
      try {
        current.offset = current.history.read(fd, current.offset, size, current.metadata);
      } catch (error) {
        current = undefined;
        throw error;
      }
      Object.assign(current, { size, mtimeMs });
    } else {
      return undefined;
    }
    return current.history.snapshot();
  });
}

module.exports = { discoverSessions, listSessions, followSession };
