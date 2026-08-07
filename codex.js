// Pure Codex CLI transcript helpers for AIChatRender. No vscode or filesystem
// imports. Discovery uses sessionMetaFromLine() on the first JSONL line; the
// follower sends all later lines through one createCodexParser() instance.
'use strict';

const path = require('node:path');
const { blockToSpans } = require('./transcript');
const {
  clipResult,
  diffLines,
  patchCounts,
  toolSummary,
  writtenLines,
} = require('./tool-presentation');
const {
  CODEX_TOOL_LIMITS,
  decodeCodexOutput,
  displayNameForTool,
  extractExecDescriptors,
  firstWebQuery,
  normalizedInput,
  redactImageData,
  unifiedDiffToStructuredPatch,
} = require('./codex-tools');

const NONE = { messages: [], unexpected: false };
const NO_SESSION_META = Symbol('no-session-meta');
const dateFmtCache = new Map();
function dateFmt(timeZone) {
  let fmt = dateFmtCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone, // undefined = host zone, the same clock Codex wrote the dirs by
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dateFmtCache.set(timeZone, fmt);
  }
  return fmt;
}

// Codex names its YYYY/MM/DD session directories after the *local* calendar
// date of the machine that wrote them, not UTC — verified against 111 observed
// rollouts, 11 of which sit in a directory that disagrees with their own UTC
// timestamp. So anchor the scan to the host zone; `timeZone` overrides it for
// tests only. Include tomorrow as a forward guard for ai-sesh stores written by
// a machine in a zone ahead of this one. Do the subtraction as calendar
// arithmetic, not fixed 24-hour jumps across DST. `days` is the number of dates
// through today, so the returned window has days + 1 entries after tomorrow.
function recentSessionDateParts(nowMs, days, timeZone) {
  const parts = Object.fromEntries(
    dateFmt(timeZone)
      .formatToParts(new Date(nowMs))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
  const out = [];
  for (let i = -1; i < days; i += 1) {
    const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day - i, 12));
    out.push([
      String(date.getUTCFullYear()).padStart(4, '0'),
      String(date.getUTCMonth() + 1).padStart(2, '0'),
      String(date.getUTCDate()).padStart(2, '0'),
    ]);
  }
  return out;
}

function timestampOf(rec, opts) {
  if (typeof rec.timestamp === 'string') return rec.timestamp;
  return opts && typeof opts.sessionTimestamp === 'string' ? opts.sessionTimestamp : '';
}

function makeMessage(rec, opts, role, text) {
  return {
    ts: timestampOf(rec, opts),
    role,
    spans: blockToSpans(text),
  };
}

// The session_meta record is the first line in observed Codex rollouts. Return
// only the immutable fields discovery needs; malformed or changed records are
// ignored rather than made fatal.
function sessionMetaFromLine(line) {
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    return undefined;
  }
  const payload = rec && rec.payload;
  if (
    !rec ||
    typeof rec !== 'object' ||
    Array.isArray(rec) ||
    rec.type !== 'session_meta' ||
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    typeof payload.cwd !== 'string' ||
    payload.cwd === ''
  ) {
    return undefined;
  }
  return {
    cwd: payload.cwd,
    timestamp:
      typeof payload.timestamp === 'string'
        ? payload.timestamp
        : typeof rec.timestamp === 'string'
          ? rec.timestamp
          : '',
  };
}

// Cached by (logical path, inode), one entry per file either way. Positive
// metadata is immutable, so a hit is final. A negative entry carries the size it
// failed at and is overwritten in place on each retry: an incomplete file — one
// still syncing in, say — is reread only after it grows, and a permanently
// unparseable one is not reopened every discovery tick. Keeping the size in the
// value rather than the key is what bounds the cache; keying by size would mint
// a new entry for every append to a file that never parses.
function cachedSessionMeta(cache, filePath, inode, size, readFirstLine) {
  const fileKey = `${filePath}\0${inode}`;
  const cached = cache.get(fileKey);
  if (cached !== undefined) {
    if (cached.kind !== NO_SESSION_META) return cached;
    if (cached.size === size) return undefined;
  }

  const line = readFirstLine();
  const meta = typeof line === 'string' ? sessionMetaFromLine(line) : undefined;
  cache.set(fileKey, meta || { kind: NO_SESSION_META, size });
  return meta;
}

function relativeSessionPath(filePath, cwd) {
  if (typeof filePath !== 'string') return '';
  if (typeof cwd !== 'string' || cwd === '' || !path.isAbsolute(filePath)) {
    return redactImageData(filePath);
  }
  const relative = path.relative(cwd, filePath);
  if (relative === '') return path.basename(filePath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return redactImageData(filePath);
  }
  return relative;
}

function codexToolSummary(name, input, cwd) {
  const safeInput = {};
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    for (const [key, value] of Object.entries(input)) {
      safeInput[key] = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
    }
  }
  return redactImageData(toolSummary(name, safeInput, cwd));
}

function toolMessage(rec, opts, id, name, input, summary) {
  const rawSummary = summary === undefined
    ? codexToolSummary(name, input, opts && opts.cwd)
    : redactImageData(summary);
  return {
    ts: timestampOf(rec, opts),
    role: 'tool',
    tool: {
      id,
      name,
      summary: rawSummary,
    },
    result: undefined,
  };
}

function toolResult(id, text, isError, extras) {
  const clipped = clipResult(redactImageData(typeof text === 'string' ? text : ''));
  const safeExtras = extras ? { ...extras } : {};
  if (typeof safeExtras.summary === 'string') {
    safeExtras.summary = redactImageData(safeExtras.summary);
  }
  return Object.assign(
    { id, text: clipped.text, more: clipped.more, isError: isError === true },
    safeExtras,
  );
}

function failureStatus(payload) {
  if (payload && payload.success === false) return true;
  const status = payload && typeof payload.status === 'string' ? payload.status.toLowerCase() : '';
  return status === 'failed' || status === 'failure' || status === 'error';
}

function safeResultText(value) {
  if (typeof value === 'string') return redactImageData(value);
  if (Array.isArray(value)) return decodeCodexOutput(value).text;
  if (!value || typeof value !== 'object') return value == null ? '' : String(value);
  if (typeof value.error === 'string') return redactImageData(value.error);
  if (typeof value.message === 'string') return redactImageData(value.message);
  if (value.content !== undefined) return decodeCodexOutput(value.content).text;
  try {
    return JSON.stringify(value, (key, item) => {
      if (/^(?:image_url|data|base64)$/i.test(key)) return '[omitted]';
      if (typeof item === 'string' && /^data:image\//i.test(item)) return '[image]';
      return item;
    });
  } catch {
    return '';
  }
}

function descriptorForDirect(rawName, input, outerId) {
  return {
    outerId,
    ordinal: 0,
    id: outerId,
    rawName,
    displayName: displayNameForTool(rawName, input),
    input,
    eventBacked:
      rawName === 'apply_patch' ||
      rawName.startsWith('mcp__') ||
      /^(?:image_gen|image_generation)(?:__|$)/.test(rawName),
  };
}

function pendingMatch(state, callId, predicate) {
  if (typeof callId === 'string' && state.pendingOuter.has(callId)) {
    const exact = state.pendingOuter.get(callId);
    const descriptor = exact.descriptors.find(predicate);
    if (descriptor) return { pending: exact, descriptor };
  }
  const entries = [...state.pendingOuter.values()].reverse();
  for (const pending of entries) {
    const descriptor = pending.descriptors.find(
      (candidate) => !pending.accounted.has(candidate.ordinal) && predicate(candidate),
    );
    if (descriptor) return { pending, descriptor };
  }
  return undefined;
}

function accountPending(state, match) {
  if (!match) return;
  match.pending.accounted.add(match.descriptor.ordinal);
  if (match.pending.mode === 'single') state.pendingOuter.delete(match.pending.outerId);
}

function setPending(state, callId, pending) {
  let unexpected = false;
  if (state.pendingOuter.has(callId)) {
    state.pendingOuter.delete(callId);
    unexpected = true;
  }
  if (state.pendingOuter.size >= CODEX_TOOL_LIMITS.MAX_PENDING) {
    state.pendingOuter.delete(state.pendingOuter.keys().next().value);
    unexpected = true;
  }
  state.pendingOuter.set(callId, pending);
  return unexpected;
}

function parseJsonArguments(argumentsText, rawName) {
  if (typeof argumentsText !== 'string') return { input: {}, unexpected: true };
  try {
    const value = JSON.parse(argumentsText);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return { input: value, unexpected: false };
    }
    return { input: normalizedInput(rawName, [value]), unexpected: true };
  } catch {
    return { input: {}, unexpected: true };
  }
}

function parseDirectCall(rec, payload, opts, state) {
  if (
    typeof payload.name !== 'string' || payload.name === '' ||
    typeof payload.call_id !== 'string' || payload.call_id === ''
  ) {
    return { messages: [], unexpected: true };
  }
  const parsed = parseJsonArguments(payload.arguments, payload.name);
  parsed.input = normalizedInput(payload.name, [parsed.input]);
  const descriptor = descriptorForDirect(payload.name, parsed.input, payload.call_id);
  descriptor.summary = codexToolSummary(
    descriptor.displayName,
    descriptor.input,
    opts && opts.cwd,
  );
  const messages = descriptor.eventBacked
    ? []
    : [toolMessage(rec, opts, payload.call_id, descriptor.displayName, {}, descriptor.summary)];
  descriptor.input = {};
  const pending = {
    outerId: payload.call_id,
    descriptors: [descriptor],
    renderedIds: messages.length ? [payload.call_id] : [],
    accounted: new Set(),
    mode: 'single',
    wrapper: false,
    rec,
  };
  const evicted = setPending(state, payload.call_id, pending);
  return { messages, unexpected: parsed.unexpected || evicted };
}

function parseCustomCall(rec, payload, opts, state) {
  if (
    typeof payload.name !== 'string' || payload.name === '' ||
    typeof payload.call_id !== 'string' || payload.call_id === ''
  ) {
    return { messages: [], unexpected: true };
  }
  if (payload.name !== 'exec') {
    const input = typeof payload.input === 'string' ? { input: payload.input } : {};
    const descriptor = descriptorForDirect(payload.name, input, payload.call_id);
    descriptor.summary = codexToolSummary(descriptor.displayName, input, opts && opts.cwd);
    descriptor.input = {};
    const messages = descriptor.eventBacked
      ? []
      : [
          toolMessage(
            rec,
            opts,
            payload.call_id,
            descriptor.displayName,
            {},
            descriptor.summary,
          ),
        ];
    const evicted = setPending(state, payload.call_id, {
      outerId: payload.call_id,
      descriptors: [descriptor],
      renderedIds: messages.map((message) => message.tool.id),
      accounted: new Set(),
      mode: 'single',
      wrapper: false,
      rec,
    });
    return { messages, unexpected: evicted || typeof payload.input !== 'string' };
  }

  const extracted = extractExecDescriptors(payload.input);
  const descriptors = extracted.descriptors.map((descriptor) => ({
    ...descriptor,
    outerId: payload.call_id,
    id: payload.call_id,
    summary: codexToolSummary(descriptor.displayName, descriptor.input, opts && opts.cwd),
    input: {},
  }));
  let mode = 'single';
  let messages = [];
  if (descriptors.length === 1) {
    const descriptor = descriptors[0];
    if (!descriptor.eventBacked) {
      messages.push(
        toolMessage(rec, opts, payload.call_id, descriptor.displayName, {}, descriptor.summary),
      );
    }
  } else {
    mode = 'aggregate';
    const count = descriptors.length || 1;
    const suffix = extracted.truncated ? '+' : '';
    messages = [toolMessage(rec, opts, payload.call_id, 'Exec', {}, `batch: ${count}${suffix} tools`)];
  }
  const evicted = setPending(state, payload.call_id, {
    outerId: payload.call_id,
    descriptors,
    renderedIds: messages.map((message) => message.tool.id),
    accounted: new Set(),
    mode,
    wrapper: true,
    rec,
  });
  return {
    messages,
    unexpected: extracted.unexpected || evicted || descriptors.length !== 1,
  };
}

function parsePairedOutput(rec, payload, opts, state) {
  if (typeof payload.call_id !== 'string' || payload.call_id === '') {
    return { messages: [], unexpected: true };
  }
  const pending = state.pendingOuter.get(payload.call_id);
  if (!pending) return NONE;
  state.pendingOuter.delete(payload.call_id);
  const descriptor = pending.descriptors[0];
  const decoded = decodeCodexOutput(payload.output, {
    wrapper: pending.wrapper,
    command:
      !pending.wrapper &&
      pending.mode === 'single' &&
      descriptor &&
      (descriptor.rawName === 'exec_command' || descriptor.rawName === 'write_stdin'),
  });
  const resultText = decoded.text || safeResultText(payload.error);
  const result = toolResult(
    payload.call_id,
    resultText,
    decoded.isError || payload.is_error === true || payload.isError === true || failureStatus(payload),
  );
  if (pending.mode === 'aggregate') {
    return { messages: [], results: [result], unexpected: true };
  }
  if (!descriptor || pending.accounted.has(descriptor.ordinal)) {
    return { messages: [], unexpected: decoded.unexpected };
  }
  if (pending.renderedIds.includes(payload.call_id)) {
    return { messages: [], results: [result], unexpected: decoded.unexpected };
  }
  // A known event-backed call whose richer event never arrived still gets a
  // complete generic card when its paired output appears.
  return {
    messages: [
      toolMessage(
        pending.rec || rec,
        opts,
        payload.call_id,
        descriptor.displayName,
        {},
        descriptor.summary,
      ),
    ],
    results: [result],
    unexpected: true,
  };
}

function patchEvent(rec, payload, opts, state) {
  const callId = typeof payload.call_id === 'string' && payload.call_id !== ''
    ? payload.call_id
    : `patch:${state.eventSequence++}`;
  const match = pendingMatch(state, payload.call_id, (descriptor) => descriptor.rawName === 'apply_patch');
  accountPending(state, match);
  const failed = failureStatus(payload);
  if (failed) {
    const reason =
      (typeof payload.stderr === 'string' && payload.stderr) ||
      (typeof payload.stdout === 'string' && payload.stdout) ||
      'Patch failed.';
    const id = `${callId}:0`;
    return {
      messages: [toolMessage(rec, opts, id, 'Edit', {}, 'patch')],
      results: [toolResult(id, reason, true)],
      unexpected: typeof payload.call_id !== 'string',
    };
  }

  if (!payload.changes || typeof payload.changes !== 'object' || Array.isArray(payload.changes)) {
    return { messages: [], unexpected: true };
  }
  const messages = [];
  const results = [];
  let unexpected = false;
  const changes = Object.entries(payload.changes).slice(0, CODEX_TOOL_LIMITS.MAX_CALLS_PER_EXEC);
  if (Object.keys(payload.changes).length > changes.length) unexpected = true;
  changes.forEach(([filePath, change], index) => {
    if (!change || typeof change !== 'object' || Array.isArray(change)) {
      unexpected = true;
      return;
    }
    const kind = typeof change.type === 'string' ? change.type : 'update';
    const name = kind === 'add' ? 'Write' : kind === 'delete' ? 'Delete' : 'Edit';
    const from = relativeSessionPath(filePath, opts && opts.cwd);
    const moved = relativeSessionPath(change.move_path, opts && opts.cwd);
    const summary = moved ? `${from} → ${moved}` : from;
    const id = `${callId}:${index}`;
    messages.push(toolMessage(rec, opts, id, name, { path: filePath }, summary));

    const structured = unifiedDiffToStructuredPatch(change.unified_diff);
    const counts = patchCounts(structured);
    const fallback =
      (typeof payload.stderr === 'string' && payload.stderr) ||
      (typeof payload.stdout === 'string' && payload.stdout) ||
      (typeof change.content === 'string' ? change.content : 'Patch applied.');
    if (kind === 'add') {
      const wrote = typeof change.content === 'string'
        ? writtenLines(change.content) || 0
        : counts && counts.added;
      if (wrote !== undefined) results.push(toolResult(id, '', false, { wrote }));
      else {
        results.push(toolResult(id, fallback, false));
        unexpected = true;
      }
    } else if (counts) {
      const extras = { patch: counts, diff: diffLines(structured) };
      if (moved) extras.summary = `Moved to ${moved}`;
      results.push(toolResult(id, '', false, extras));
    } else {
      results.push(toolResult(id, fallback, false));
      unexpected = true;
    }
  });
  if (messages.length === 0) unexpected = true;
  return { messages, results, unexpected };
}

function webEvent(rec, payload, opts, state) {
  const query =
    (typeof payload.query === 'string' && payload.query) ||
    firstWebQuery(payload.action) ||
    firstWebQuery(payload);
  const action = typeof payload.action === 'string' ? payload.action : '';
  const name = query ? 'WebSearch' : 'Web';
  const input = query ? { query } : { action };
  const match = pendingMatch(
    state,
    payload.call_id,
    (descriptor) => descriptor.rawName === 'web__run' || /web.*search/i.test(descriptor.rawName),
  );
  accountPending(state, match);
  const ownId = typeof payload.call_id === 'string' && payload.call_id !== ''
    ? payload.call_id
    : `web:${state.eventSequence++}`;
  const id = match && match.pending.mode === 'single' && match.pending.renderedIds.length
    ? match.pending.outerId
    : ownId;
  const messages = id === ownId ? [toolMessage(rec, opts, id, name, input)] : [];
  const failed = failureStatus(payload);
  const resultList = Array.isArray(payload.results)
    ? payload.results
    : payload.result && Array.isArray(payload.result.results)
      ? payload.result.results
      : undefined;
  const text =
    (typeof payload.error === 'string' && payload.error) ||
    safeResultText(payload.result) ||
    (typeof payload.stderr === 'string' ? payload.stderr : '');
  const extras = !failed && resultList ? { summary: `${resultList.length} results` } : undefined;
  return {
    messages,
    results: [toolResult(id, text, failed, extras)],
    unexpected: typeof payload.call_id !== 'string',
  };
}

function mcpEvent(rec, payload, opts, state) {
  const invocation = payload.invocation;
  if (!invocation || typeof invocation !== 'object' || Array.isArray(invocation)) {
    return { messages: [], unexpected: true };
  }
  const server = typeof invocation.server === 'string' ? invocation.server : 'mcp';
  const tool = typeof invocation.tool === 'string' ? invocation.tool : 'tool';
  const name = `${server}.${tool}`;
  let input = invocation.arguments;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    if (typeof input === 'string') {
      try {
        input = JSON.parse(input);
      } catch {
        input = { value: input };
      }
    } else input = {};
  }
  const match = pendingMatch(state, payload.call_id, (descriptor) => descriptor.rawName.startsWith('mcp__'));
  accountPending(state, match);
  const id = typeof payload.call_id === 'string' && payload.call_id !== ''
    ? payload.call_id
    : `mcp:${state.eventSequence++}`;
  const failed = failureStatus(payload) || Boolean(payload.result && payload.result.isError === true);
  const text =
    (typeof payload.error === 'string' && payload.error) ||
    safeResultText(payload.result) ||
    (failed ? 'MCP tool call failed.' : '');
  return {
    messages: [toolMessage(rec, opts, id, name, input)],
    results: [toolResult(id, text, failed)],
    unexpected: typeof payload.call_id !== 'string',
  };
}

function imageEvent(rec, payload, opts, state) {
  const match = pendingMatch(
    state,
    payload.call_id,
    (descriptor) => /^(?:image_gen|image_generation)(?:__|$)/.test(descriptor.rawName),
  );
  accountPending(state, match);
  const id = typeof payload.call_id === 'string' && payload.call_id !== ''
    ? payload.call_id
    : `image:${state.eventSequence++}`;
  const savedPath =
    (typeof payload.saved_path === 'string' && payload.saved_path) ||
    (typeof payload.path === 'string' && payload.path) ||
    '';
  const shownPath = relativeSessionPath(savedPath, opts && opts.cwd);
  const failed = failureStatus(payload);
  const reason = failed
    ? (typeof payload.error === 'string' && payload.error) || safeResultText(payload.result) || 'Image generation failed.'
    : '';
  return {
    messages: [toolMessage(rec, opts, id, 'ImageGeneration', { path: savedPath })],
    results: [
      toolResult(id, reason, failed, !failed && shownPath ? { summary: `Saved ${shownPath}` } : undefined),
    ],
    unexpected: typeof payload.call_id !== 'string',
  };
}

// Assistant text is present twice in current rollouts. response_item/message is
// canonical; event_msg/agent_message is skipped. Older Codex versions emit real
// user prompts as event_msg/user_message. Newer versions put both injected
// context and real prompts in response_item/message, then identify only the real
// prompt with event_msg/item_completed/UserMessage; consume that completion so
// AGENTS.md and environment context never appear as something the user typed.
function parseRecord(rec, opts, state) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
    return { messages: [], unexpected: true };
  }
  const payload = rec.payload;

  if (rec.type === 'response_item' && payload && payload.type === 'message') {
    if (payload.role !== 'assistant') return NONE;
    if (!Array.isArray(payload.content)) {
      return { messages: [], unexpected: true };
    }
    const messages = [];
    let changedShape = false;
    for (const item of payload.content) {
      if (!item || typeof item !== 'object' || item.type !== 'output_text') {
        changedShape = true;
        continue;
      }
      if (typeof item.text !== 'string') {
        changedShape = true;
        continue;
      }
      if (item.text.trim() !== '') {
        messages.push(makeMessage(rec, opts, 'assistant', item.text));
      }
    }
    return { messages, unexpected: changedShape };
  }

  if (rec.type === 'response_item' && payload && payload.type === 'function_call') {
    return parseDirectCall(rec, payload, opts, state);
  }

  if (rec.type === 'response_item' && payload && payload.type === 'custom_tool_call') {
    return parseCustomCall(rec, payload, opts, state);
  }

  if (
    rec.type === 'response_item' &&
    payload &&
    (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output')
  ) {
    return parsePairedOutput(rec, payload, opts, state);
  }

  // This is a less-informative duplicate of web_search_end.
  if (rec.type === 'response_item' && payload && payload.type === 'web_search_call') return NONE;

  if (
    rec.type === 'event_msg' &&
    payload &&
    payload.type === 'user_message' &&
    opts &&
    opts.includeUser
  ) {
    if (typeof payload.message !== 'string') {
      return { messages: [], unexpected: true };
    }
    if (payload.message.trim() === '') return NONE;
    return {
      messages: [makeMessage(rec, opts, 'user', payload.message)],
      unexpected: false,
    };
  }

  if (
    rec.type === 'event_msg' &&
    payload &&
    payload.type === 'item_completed' &&
    payload.item &&
    payload.item.type === 'UserMessage' &&
    opts &&
    opts.includeUser
  ) {
    if (!Array.isArray(payload.item.content)) {
      return { messages: [], unexpected: true };
    }
    const texts = [];
    let changedShape = false;
    for (const item of payload.item.content) {
      if (!item || typeof item !== 'object' || item.type !== 'text') {
        changedShape = true;
        continue;
      }
      if (typeof item.text !== 'string') {
        changedShape = true;
        continue;
      }
      if (item.text !== '') texts.push(item.text);
    }
    const text = texts.join('\n');
    return {
      messages: text.trim() === '' ? [] : [makeMessage(rec, opts, 'user', text)],
      unexpected: changedShape,
    };
  }

  if (rec.type === 'event_msg' && payload && payload.type === 'patch_apply_end') {
    return patchEvent(rec, payload, opts, state);
  }
  if (rec.type === 'event_msg' && payload && payload.type === 'web_search_end') {
    return webEvent(rec, payload, opts, state);
  }
  if (rec.type === 'event_msg' && payload && payload.type === 'mcp_tool_call_end') {
    return mcpEvent(rec, payload, opts, state);
  }
  if (rec.type === 'event_msg' && payload && payload.type === 'image_generation_end') {
    return imageEvent(rec, payload, opts, state);
  }

  if (
    rec.type === 'event_msg' &&
    payload &&
    typeof payload.type === 'string' &&
    payload.type.endsWith('_end') &&
    typeof payload.call_id === 'string' &&
    (payload.result !== undefined || payload.output !== undefined || payload.stderr !== undefined)
  ) {
    return { messages: [], unexpected: true };
  }

  // event_msg/agent_message is the duplicate assistant copy. Reasoning, turn
  // context, world state, token counts, and unrelated types are bookkeeping.
  return NONE;
}

function createCodexParser() {
  const state = {
    pendingOuter: new Map(),
    eventSequence: 1,
  };
  return {
    parseLine(line, opts) {
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        return NONE;
      }
      return parseRecord(rec, opts, state);
    },
    reset() {
      state.pendingOuter.clear();
      state.eventSequence = 1;
    },
  };
}

// Stateless convenience for callers that parse isolated records. Sequential
// transcript consumers should own one createCodexParser() instance.
function parseLine(line, opts) {
  return createCodexParser().parseLine(line, opts);
}

module.exports = {
  recentSessionDateParts,
  sessionMetaFromLine,
  cachedSessionMeta,
  createCodexParser,
  parseLine,
};
