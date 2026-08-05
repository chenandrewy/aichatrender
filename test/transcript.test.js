'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  LIMITS,
  mungePath,
  pathWithin,
  LineBuffer,
  segment,
  blockToSpans,
  turnPreview,
  toolSummary,
  clipResult,
  patchCounts,
  diffLines,
  writtenLines,
  presentResult,
  markStalePending,
  applyToolResults,
  trimToTurns,
  parseLine,
} = require('../transcript');

test('panel history limits retain long chats within a bounded rebuild tail', () => {
  assert.equal(LIMITS.MAX_TURNS, 100);
  assert.equal(LIMITS.MAX_MESSAGES, 3000);
  assert.equal(LIMITS.MAX_REBUILD_BYTES, 10 * 1024 * 1024);
});

const OPTS = { includeUser: true };

function asstLine(blocks, extra) {
  return JSON.stringify(
    Object.assign(
      { type: 'assistant', version: '2.1.218', timestamp: '2026-07-23T18:00:00.000Z',
        message: { role: 'assistant', content: blocks } },
      extra || {},
    ),
  );
}

function userLine(content, extra) {
  return JSON.stringify(
    Object.assign(
      { type: 'user', version: '2.1.218', timestamp: '2026-07-23T18:00:01.000Z',
        message: { role: 'user', content } },
      extra || {},
    ),
  );
}

// ---------------------------------------------------------------- munge rule

test('munge: per-char non-alnum to dash, no run-collapsing', () => {
  assert.equal(mungePath('/workspace/example,project'), '-workspace-example-project');
  assert.equal(mungePath('/tmp/pdf2md__logotr_'), '-tmp-pdf2md--logotr-');
  assert.equal(mungePath('/a.b/c d'), '-a-b-c-d');
  assert.equal(mungePath('/workspace'), '-workspace');
});

// ------------------------------------------------------- workspace containment

test('pathWithin: the folder itself and anything beneath it', () => {
  assert.equal(pathWithin('/workspace/1-SANDBOX', '/workspace/1-SANDBOX'), true);
  assert.equal(pathWithin('/workspace/1-SANDBOX', '/workspace/1-SANDBOX/'), true);
  assert.equal(
    pathWithin('/workspace/1-SANDBOX', '/workspace/1-SANDBOX/Live,AIChatRender'),
    true,
  );
  assert.equal(pathWithin('/workspace/1-SANDBOX', '/workspace/1-SANDBOX/a/b/c'), true);
});

test('pathWithin: rejects parents, siblings, and prefix look-alikes', () => {
  assert.equal(pathWithin('/workspace/1-SANDBOX', '/workspace'), false);
  assert.equal(pathWithin('/workspace/1-SANDBOX', '/workspace/2-OTHER'), false);
  // A sibling whose name merely starts with the workspace name is not inside it.
  assert.equal(pathWithin('/workspace/1-SANDBOX', '/workspace/1-SANDBOX-old'), false);
  assert.equal(pathWithin('/workspace/1-SANDBOX', '/'), false);
});

test('pathWithin: empty or non-string operands are not a match', () => {
  assert.equal(pathWithin('/workspace', ''), false);
  assert.equal(pathWithin('', '/workspace'), false);
  assert.equal(pathWithin('/workspace', undefined), false);
  assert.equal(pathWithin(undefined, '/workspace'), false);
  assert.equal(pathWithin('/workspace', 42), false);
});

// ---------------------------------------------------------------- filtering

test('assistant: keeps text and tool_use blocks in order, skips thinking', () => {
  const r = parseLine(
    asstLine([
      { type: 'thinking', thinking: 'secret \\(a+b\\)' },
      { type: 'text', text: 'Result: \\(E=mc^2\\)' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
    ]),
    OPTS,
  );
  assert.equal(r.unexpected, false);
  assert.equal(r.messages.length, 2);
  assert.equal(r.messages[0].role, 'assistant');
  assert.deepEqual(r.messages[0].spans, [
    { t: 'text', s: 'Result: ' },
    { t: 'math', m: 'inline', s: 'E=mc^2' },
  ]);
  assert.equal(r.messages[1].role, 'tool');
  assert.deepEqual(r.messages[1].tool, { id: 't1', name: 'Bash', summary: 'ls' });
  assert.equal(r.messages[1].result, undefined);
  // Thinking stays out: it is not something the terminal shows by default.
  assert.equal(r.messages.some((m) => /secret/.test(JSON.stringify(m))), false);
});

test('assistant: whitespace-only and non-string text blocks skipped', () => {
  const r = parseLine(asstLine([{ type: 'text', text: '  \n' }, { type: 'text', text: 42 }]), OPTS);
  assert.equal(r.messages.length, 0);
  assert.equal(r.unexpected, false);
});

test('user: real prompt kept, tool results and bookkeeping skipped', () => {
  assert.equal(parseLine(userLine('what is \\(x^2\\)?'), OPTS).messages.length, 1);
  assert.equal(parseLine(userLine('what is x?'), OPTS).messages[0].role, 'user');
  // array content (tool results)
  assert.equal(parseLine(userLine([{ type: 'tool_result', content: 'x' }]), OPTS).messages.length, 0);
  // toolUseResult marker
  assert.equal(parseLine(userLine('x', { toolUseResult: {} }), OPTS).messages.length, 0);
  // meta / sidechain
  assert.equal(parseLine(userLine('x', { isMeta: true }), OPTS).messages.length, 0);
  assert.equal(parseLine(userLine('x', { isSidechain: true }), OPTS).messages.length, 0);
  // command-invocation and reminder records
  assert.equal(parseLine(userLine('<command-name>/clear</command-name>'), OPTS).messages.length, 0);
  assert.equal(parseLine(userLine('<local-command-stdout></local-command-stdout>'), OPTS).messages.length, 0);
  assert.equal(parseLine(userLine('<system-reminder>x</system-reminder>'), OPTS).messages.length, 0);
  assert.equal(parseLine(userLine('<task-notification>x</task-notification>'), OPTS).messages.length, 0);
});

test('user: excluded entirely when includeUser is off', () => {
  assert.equal(parseLine(userLine('hello'), { includeUser: false }).messages.length, 0);
});

test('sidechain assistant records skipped', () => {
  const r = parseLine(asstLine([{ type: 'text', text: 'hi' }], { isSidechain: true }), OPTS);
  assert.equal(r.messages.length, 0);
});

test('fail-soft: bookkeeping types, malformed JSON, unexpected shapes', () => {
  assert.equal(parseLine('{"type":"file-history-snapshot","version":"2.1.218"}', OPTS).messages.length, 0);
  assert.equal(parseLine('{"type":"queue-operation"}', OPTS).messages.length, 0);
  const bad = parseLine('{"type":"assistant","message":{"con', OPTS);
  assert.equal(bad.messages.length, 0);
  assert.equal(bad.unexpected, false);
  // assistant with non-array content: flagged so the panel can show its notice
  const odd = parseLine('{"type":"assistant","message":{"content":"str"}}', OPTS);
  assert.equal(odd.messages.length, 0);
  assert.equal(odd.unexpected, true);
  assert.equal(parseLine('123', OPTS).unexpected, true);
});

// ---------------------------------------------------------------- segmentation

test('segment: display, inline, and plain text in order', () => {
  const spans = segment('By \\(E=mc^2\\), so:\n$$E^2=(mc^2)^2+(pc)^2$$\ndone \\[x=1\\]');
  assert.deepEqual(spans, [
    { t: 'text', s: 'By ' },
    { t: 'math', m: 'inline', s: 'E=mc^2' },
    { t: 'text', s: ', so:\n' },
    { t: 'math', m: 'display', s: 'E^2=(mc^2)^2+(pc)^2' },
    { t: 'text', s: '\ndone ' },
    { t: 'math', m: 'display', s: 'x=1' },
  ]);
});

test('segment: fenced code kept as text, never math-scanned', () => {
  const spans = segment('run\n```sh\necho $$x$$ \\(y\\)\n```\nafter');
  assert.deepEqual(spans, [{ t: 'text', s: 'run\n```sh\necho $$x$$ \\(y\\)\n```\nafter' }]);
});

test('segment: inline code protects math, closes on same line only', () => {
  assert.deepEqual(segment('use `$$a$$` here'), [{ t: 'text', s: 'use `$$a$$` here' }]);
  // lone backtick does not swallow a later line's math
  const spans = segment('a ` b\n\\(x\\)');
  assert.deepEqual(spans, [
    { t: 'text', s: 'a ` b\n' },
    { t: 'math', m: 'inline', s: 'x' },
  ]);
});

test('segment: unclosed delimiters are literal text', () => {
  assert.deepEqual(segment('cost is $$5 total'), [{ t: 'text', s: 'cost is $$5 total' }]);
  assert.deepEqual(segment('open \\(x'), [{ t: 'text', s: 'open \\(x' }]);
  // unterminated fence: rest of message is code text
  assert.deepEqual(segment('x\n```\n$$y$$'), [{ t: 'text', s: 'x\n```\n$$y$$' }]);
});

test('segment: empty math dropped', () => {
  assert.deepEqual(segment('a $$$$ b'), [{ t: 'text', s: 'a ' }, { t: 'text', s: ' b' }]);
});

test('segment: single-$ inline math', () => {
  assert.deepEqual(segment('a $x$ b'), [
    { t: 'text', s: 'a ' },
    { t: 'math', m: 'inline', s: 'x' },
    { t: 'text', s: ' b' },
  ]);
  assert.deepEqual(segment('$E=mc^2$'), [{ t: 'math', m: 'inline', s: 'E=mc^2' }]);
  assert.deepEqual(segment('$a$ and $b_i$'), [
    { t: 'math', m: 'inline', s: 'a' },
    { t: 'text', s: ' and ' },
    { t: 'math', m: 'inline', s: 'b_i' },
  ]);
  // $$ keeps priority over single-$
  assert.deepEqual(segment('$$x$$ and $y$'), [
    { t: 'math', m: 'display', s: 'x' },
    { t: 'text', s: ' and ' },
    { t: 'math', m: 'inline', s: 'y' },
  ]);
});

test('segment: single-$ currency and shell-var guards', () => {
  // space before would-be closer
  assert.deepEqual(segment('between $20,000 and $30,000'), [
    { t: 'text', s: 'between $20,000 and $30,000' },
  ]);
  // digit right after would-be closer
  assert.deepEqual(segment('$5-$6 range'), [{ t: 'text', s: '$5-$6 range' }]);
  // no closer at all
  assert.deepEqual(segment('costs $5.'), [{ t: 'text', s: 'costs $5.' }]);
  assert.deepEqual(segment('price $5 and $VAR'), [{ t: 'text', s: 'price $5 and $VAR' }]);
  // whitespace immediately inside the delimiters
  assert.deepEqual(segment('a $ x$ b'), [{ t: 'text', s: 'a $ x$ b' }]);
  assert.deepEqual(segment('a $x $ b'), [{ t: 'text', s: 'a $x $ b' }]);
  // escaped \$ never opens or closes
  assert.deepEqual(segment('pay \\$5 or \\$6'), [{ t: 'text', s: 'pay \\$5 or \\$6' }]);
  // both delimiters must sit on the same line
  assert.deepEqual(segment('a $x\ny$ b'), [{ t: 'text', s: 'a $x\ny$ b' }]);
  // inline code still protects dollar math
  assert.deepEqual(segment('use `$PATH$` here'), [{ t: 'text', s: 'use `$PATH$` here' }]);
});

// ---------------------------------------------------------------- limits

test('limits: prose truncated with visible marker', () => {
  const spans = blockToSpans('a'.repeat(LIMITS.MAX_TEXT + 100));
  const last = spans[spans.length - 1];
  assert.equal(last.s, '\n[message truncated: size limit]');
  assert.equal(spans[0].s.length, LIMITS.MAX_TEXT);
});

test('limits: oversize math dropped, never rendered truncated', () => {
  const spans = blockToSpans('\\(' + 'x'.repeat(LIMITS.MAX_MATH_SPAN + 1) + '\\)');
  assert.deepEqual(spans, [{ t: 'text', s: '[formula omitted: size limit exceeded]' }]);
});

test('limits: math spans beyond per-message cap become inert text', () => {
  const src = Array.from({ length: LIMITS.MAX_MATH_PER_MSG + 2 }, (_, i) => `\\(x_{${i}}\\)`).join(' ');
  const spans = blockToSpans(src);
  const math = spans.filter((s) => s.t === 'math');
  assert.equal(math.length, LIMITS.MAX_MATH_PER_MSG);
  const inert = spans.filter((s) => s.t === 'text' && /^x_\{\d+\}$/.test(s.s));
  assert.equal(inert.length, 2);
});

// ---------------------------------------------------------------- line buffer

test('LineBuffer: partial lines held until their newline arrives', () => {
  const lb = new LineBuffer();
  assert.deepEqual(lb.push(Buffer.from('{"a":1}\n{"b"')), ['{"a":1}']);
  assert.deepEqual(lb.push(Buffer.from(':2}\n')), ['{"b":2}']);
});

test('LineBuffer: multi-byte UTF-8 split across pushes survives', () => {
  const bytes = Buffer.from('α=β\n', 'utf8');
  const lb = new LineBuffer();
  assert.deepEqual(lb.push(bytes.subarray(0, 1)), []); // split inside 'α'
  assert.deepEqual(lb.push(bytes.subarray(1)), ['α=β']);
});

test('LineBuffer: oversized line skipped without parsing', () => {
  const lb = new LineBuffer();
  const big = 'x'.repeat(LIMITS.MAX_LINE + 1);
  assert.deepEqual(lb.push(Buffer.from(big + '\nok\n')), ['ok']);
});

test('LineBuffer: over-cap partial discarded, resync at next newline', () => {
  const lb = new LineBuffer();
  assert.deepEqual(lb.push(Buffer.from('y'.repeat(LIMITS.MAX_PARTIAL + 1))), []);
  // tail of the discarded line must not surface as a "line"
  assert.deepEqual(lb.push(Buffer.from('tail\nnext\n')), ['next']);
});

test('LineBuffer: startMidLine drops through the first newline', () => {
  const lb = new LineBuffer();
  lb.startMidLine();
  assert.deepEqual(lb.push(Buffer.from('nt"}\n{"a":1}\n')), ['{"a":1}']);
});

// ---------------------------------------------------------------- fixture

test('fixture: synthetic session parses to the expected conversation', () => {
  const raw = fs.readFileSync(path.join(__dirname, 'fixtures', 'session.jsonl'));
  const lb = new LineBuffer();
  const messages = [];
  let unexpected = false;
  for (const line of lb.push(raw)) {
    const r = parseLine(line, OPTS);
    if (r.unexpected) unexpected = true;
    messages.push(...r.messages);
    applyToolResults(messages, r.results);
  }
  assert.equal(unexpected, false);
  assert.deepEqual(
    messages.map((m) => m.role),
    ['user', 'assistant', 'tool', 'assistant', 'assistant'],
  );
  assert.deepEqual(messages[1].spans, [
    { t: 'text', s: 'By conservation, ' },
    { t: 'math', m: 'inline', s: 'p_1=p_2' },
    { t: 'text', s: '. Then:\n' },
    { t: 'math', m: 'display', s: 'E^2=(mc^2)^2+(pc)^2' },
  ]);
  // The call renders where it was made, with the result that arrived two
  // records later joined onto it.
  assert.deepEqual(messages[2].tool, {
    id: 'toolu_synthetic',
    name: 'Bash',
    summary: 'echo ok',
  });
  assert.deepEqual(messages[2].result, { text: 'ok', more: 0, isError: false });
  assert.equal(messages[3].spans.length, 1);
  assert.equal(messages[3].spans[0].t, 'text');
  assert.deepEqual(messages[4].spans, [
    { t: 'text', s: 'Thus ' },
    { t: 'math', m: 'inline', s: 'p_1=p_2' },
    { t: 'text', s: ' costs $5 to check.' },
  ]);
});

// ---------------------------------------------------------------- tool calls

test('toolSummary: named tools show their primary argument', () => {
  assert.equal(toolSummary('Bash', { command: 'ls -l', description: 'list' }), 'ls -l');
  assert.equal(toolSummary('Read', { file_path: '/workspace/a.js', offset: 10 }), '/workspace/a.js');
  assert.equal(toolSummary('Grep', { pattern: 'foo', path: '/x' }), 'foo');
  // description would read better, but the terminal shows the command; match it.
  assert.equal(toolSummary('Bash', { description: 'list', command: 'ls' }), 'ls');
});

test('toolSummary: paths under the session cwd are shown relative to it', () => {
  const cwd = '/workspace/proj';
  assert.equal(toolSummary('Read', { file_path: '/workspace/proj/a/b.js' }, cwd), 'a/b.js');
  // Outside the cwd, and a sibling directory sharing the prefix, stay absolute.
  assert.equal(toolSummary('Read', { file_path: '/etc/hosts' }, cwd), '/etc/hosts');
  assert.equal(
    toolSummary('Read', { file_path: '/workspace/project2/a.js' }, cwd),
    '/workspace/project2/a.js',
  );
  assert.equal(toolSummary('Read', { file_path: '/workspace/proj/a.js' }, ''), '/workspace/proj/a.js');
});

test('toolSummary: multi-line arguments collapse to one line', () => {
  assert.equal(toolSummary('Bash', { command: 'a <<EOF\n  b\n\tc\nEOF' }), 'a <<EOF b c EOF');
});

test('toolSummary: unknown tool falls back to its first short string', () => {
  // MCP and future tools are not knowable in advance.
  assert.equal(toolSummary('mcp__x__query', { sql: 'select 1' }), 'select 1');
  // A long string is a payload, not a label, so it is passed over.
  assert.equal(toolSummary('Unknown', { body: 'x'.repeat(1000), tag: 'note' }), 'note');
  assert.equal(toolSummary('TodoWrite', { todos: [] }), '');
  assert.equal(toolSummary('Bash', undefined), '');
  assert.equal(toolSummary('Bash', 'not-an-object'), '');
});

test('toolSummary: over-long argument is cut without splitting a surrogate pair', () => {
  const summary = toolSummary('Bash', { command: `${'a'.repeat(159)}😀 tail` });
  assert.equal(summary.endsWith('…'), true);
  assert.equal(summary.includes('�'), false);
  assert.equal([...summary].every((ch) => ch === 'a' || ch === '…'), true);
});

test('clipResult: keeps the first lines and counts the rest', () => {
  const clipped = clipResult(Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n'));
  assert.equal(clipped.text.split('\n').length, LIMITS.TOOL_RESULT_LINES);
  assert.equal(clipped.text.startsWith('line 0'), true);
  assert.equal(clipped.more, 12);
});

test('clipResult: short output is shown whole, blank output is empty', () => {
  assert.deepEqual(clipResult('ok\n'), { text: 'ok', more: 0 });
  assert.deepEqual(clipResult('   \n\n'), { text: '', more: 0 });
  // Trailing blank lines must not spend the line budget or inflate the count.
  assert.deepEqual(clipResult('a\nb\n\n\n'), { text: 'a\nb', more: 0 });
});

test('clipResult: the char cap counts only the lines it removed outright', () => {
  const clipped = clipResult(`${'x'.repeat(5000)}\nsecond\nthird`);
  assert.equal(clipped.text.length, LIMITS.TOOL_RESULT_CHARS);
  assert.equal(clipped.more, 2); // the cut line is still shown, partially
});

test('tool_result records join onto the call by id, marking errors', () => {
  const call = parseLine(
    asstLine([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'false' } }]),
    OPTS,
  );
  const messages = [...call.messages];
  const res = parseLine(
    userLine([{ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true }]),
    OPTS,
  );
  assert.equal(res.messages.length, 0); // a result is not a message of its own
  applyToolResults(messages, res.results);
  assert.deepEqual(messages[0].result, { text: 'boom', more: 0, isError: true });
});

test('tool results are collected even when user prompts are hidden', () => {
  const res = parseLine(
    userLine([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
    { includeUser: false },
  );
  assert.equal(res.results.length, 1);
});

test('tool_result content blocks are joined, non-text parts named', () => {
  const res = parseLine(
    userLine([
      {
        type: 'tool_result',
        tool_use_id: 't1',
        content: [{ type: 'text', text: 'here:' }, { type: 'image', source: {} }],
      },
    ]),
    OPTS,
  );
  assert.deepEqual(res.results[0], { id: 't1', text: 'here:\n[image]', more: 0, isError: false });
});

test('applyToolResults: unmatched or already-answered results are dropped', () => {
  const messages = [
    { role: 'tool', tool: { id: 't1' }, result: { text: 'first', more: 0, isError: false } },
  ];
  applyToolResults(messages, [{ id: 't1', text: 'second', more: 0, isError: false }]);
  assert.equal(messages[0].result.text, 'first'); // a call is answered once
  applyToolResults(messages, [{ id: 'gone', text: 'x', more: 0, isError: false }]);
  assert.equal(messages.length, 1); // a trimmed-away call simply finds nothing
  applyToolResults(messages, undefined);
});

test('tool_use with no usable name is skipped rather than shown blank', () => {
  const r = parseLine(asstLine([{ type: 'tool_use', id: 't1', input: {} }]), OPTS);
  assert.equal(r.messages.length, 0);
});

test('subagent tool calls stay out of the panel', () => {
  const r = parseLine(
    asstLine([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }], {
      isSidechain: true,
    }),
    OPTS,
  );
  assert.equal(r.messages.length, 0);
});

// ------------------------------------------------- resilience to format drift

test('toolSummary: a known tool whose input key was renamed still reads', () => {
  // The whole point of the fallback: drift must not render a blank argument.
  assert.equal(toolSummary('Bash', { cmd: 'ls -l', description: 'list files' }), 'ls -l');
  assert.equal(toolSummary('Read', { path: '/w/a.js' }), '/w/a.js');
  // An empty mapping means "no argument worth showing" and must not fall through.
  assert.equal(toolSummary('TodoWrite', { todos: 'x' }), '');
});

test('an unknown assistant block type is reported, not silently dropped', () => {
  const r = parseLine(
    asstLine([
      { type: 'text', text: 'hi' },
      { type: 'server_tool_use', id: 't1', name: 'WebSearch', input: { query: 'x' } },
    ]),
    OPTS,
  );
  assert.equal(r.messages.length, 1); // the text still renders
  assert.equal(r.unexpected, true); // and the panel says the format moved
});

test('known-but-skipped blocks stay quiet', () => {
  assert.equal(parseLine(asstLine([{ type: 'thinking', thinking: 'x' }]), OPTS).unexpected, false);
  // Pasted attachments and interrupt markers ride in as user array content.
  const r = parseLine(userLine([{ type: 'image', source: {} }, { type: 'text', text: 'x' }]), OPTS);
  assert.equal(r.unexpected, false);
});

test('an unknown result block type is reported', () => {
  const r = parseLine(userLine([{ type: 'web_search_tool_result', tool_use_id: 't1' }]), OPTS);
  assert.equal(r.results.length, 0);
  assert.equal(r.unexpected, true);
});

test('markStalePending: a call outlived by a later prompt stops saying "running"', () => {
  const messages = [
    { role: 'user' },
    { role: 'tool', tool: { id: 'a' }, result: undefined },
    { role: 'user' },
    { role: 'tool', tool: { id: 'b' }, result: undefined },
  ];
  markStalePending(messages);
  assert.equal(messages[1].stale, true);
  assert.equal(messages[3].stale, undefined); // still the live turn
  // result stays undefined, so a late result can still bind to it
  applyToolResults(messages, [{ id: 'a', text: 'late', more: 0, isError: false }]);
  assert.equal(messages[1].result.text, 'late');
});

// ------------------------------------------------------ per-tool presentation

test('patchCounts: counts added and removed lines across hunks', () => {
  assert.deepEqual(
    patchCounts([
      { lines: [' ctx', '-old', '+new', '+extra'] },
      { lines: ['-gone', ' ctx'] },
    ]),
    { added: 2, removed: 2 },
  );
  assert.equal(patchCounts([]), undefined);
  assert.equal(patchCounts(undefined), undefined);
  assert.equal(patchCounts([{ lines: [' ctx'] }]), undefined); // no change to report
  assert.equal(patchCounts([{ nope: 1 }]), undefined); // shape drift: fail soft
});

test('an edit reports its line counts instead of the confirmation sentence', () => {
  const call = parseLine(
    asstLine([{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/w/a.js' } }]),
    OPTS,
  );
  const messages = [...call.messages];
  const res = parseLine(
    userLine([{ type: 'tool_result', tool_use_id: 't1', content: 'The file … has been updated.' }], {
      toolUseResult: { filePath: '/w/a.js', structuredPatch: [{ lines: ['-a', '+b', '+c'] }] },
    }),
    OPTS,
  );
  applyToolResults(messages, res.results);
  assert.equal(messages[0].result.summary, 'Added 2 lines, removed 1 line');
  assert.equal(messages[0].result.text, '');
});

test('an edit with no usable patch falls back to the documented channel', () => {
  const call = parseLine(
    asstLine([{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/w/a.js' } }]),
    OPTS,
  );
  const messages = [...call.messages];
  // structuredPatch renamed or gone: the confirmation text is still shown.
  const res = parseLine(
    userLine([{ type: 'tool_result', tool_use_id: 't1', content: 'File updated.' }], {
      toolUseResult: { filePath: '/w/a.js', patch: [{ lines: ['+b'] }] },
    }),
    OPTS,
  );
  applyToolResults(messages, res.results);
  assert.equal(messages[0].result.summary, undefined);
  assert.equal(messages[0].result.text, 'File updated.');
});

test('a patch is not attributed to the wrong call when a record holds several', () => {
  const res = parseLine(
    userLine(
      [
        { type: 'tool_result', tool_use_id: 't1', content: 'a' },
        { type: 'tool_result', tool_use_id: 't2', content: 'b' },
      ],
      { toolUseResult: { structuredPatch: [{ lines: ['+x'] }] } },
    ),
    OPTS,
  );
  assert.equal(res.results.length, 2);
  assert.equal(res.results.every((r) => r.patch === undefined), true);
});

test('a read collapses to its size rather than dumping the file', () => {
  const call = parseLine(
    asstLine([{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/w/a.js' } }]),
    OPTS,
  );
  const messages = [...call.messages];
  const body = Array.from({ length: 40 }, (_, i) => `${i + 1}\tline`).join('\n');
  applyToolResults(
    messages,
    parseLine(userLine([{ type: 'tool_result', tool_use_id: 't1', content: body }]), OPTS).results,
  );
  // 40 lines, though only the first 8 survived clipping: the count is the file's.
  assert.equal(messages[0].result.summary, '40 lines');
  assert.equal(messages[0].result.text, '');
});

test('a failed read still shows why it failed', () => {
  const call = parseLine(
    asstLine([{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/w/a.js' } }]),
    OPTS,
  );
  const messages = [...call.messages];
  applyToolResults(
    messages,
    parseLine(
      userLine([
        { type: 'tool_result', tool_use_id: 't1', content: 'ENOENT: no such file', is_error: true },
      ]),
      OPTS,
    ).results,
  );
  assert.equal(messages[0].result.summary, undefined);
  assert.equal(messages[0].result.text, 'ENOENT: no such file');
});

test('bash output is left alone — there the documented channel is stdout', () => {
  assert.deepEqual(
    presentResult('Bash', { text: 'a\nb', more: 3, isError: false }),
    { text: 'a\nb', more: 3, isError: false },
  );
});

// ---------------------------------------------------------------- retention

function turnFixture(turns, perTurn) {
  const messages = [];
  for (let t = 0; t < turns; t += 1) {
    messages.push({ role: 'user', n: t });
    for (let i = 0; i < perTurn; i += 1) messages.push({ role: 'tool', n: t });
  }
  return messages;
}

test('trimToTurns: keeps the most recent turns, cutting at a turn boundary', () => {
  const trimmed = trimToTurns(turnFixture(10, 3), 4);
  assert.equal(trimmed.filter((m) => m.role === 'user').length, 4);
  assert.equal(trimmed[0].role, 'user'); // opens on a prompt, never mid-exchange
  assert.equal(trimmed[0].n, 6);
});

test('trimToTurns: a chat under the cap is untouched, preamble included', () => {
  const messages = [{ role: 'assistant' }, ...turnFixture(3, 1)];
  assert.equal(trimToTurns(messages, 100).length, messages.length);
});

test('trimToTurns: the message backstop bounds a single runaway turn', () => {
  // One turn can hold thousands of calls, so turns alone cannot bound memory.
  const trimmed = trimToTurns(turnFixture(1, 5000), 100, 500);
  assert.equal(trimmed.length, 500);
  assert.equal(trimmed.filter((m) => m.role === 'user').length, 0);
});

test('turnPreview: collapses whitespace and keeps math source', () => {
  assert.equal(
    turnPreview([
      { t: 'text', s: '  check that\n\n' },
      { t: 'math', m: 'inline', s: 'x^2' },
      { t: 'text', s: '\tis right  ' },
    ]),
    'check that $x^2$ is right',
  );
});

test('turnPreview: caps at the limit with an ellipsis', () => {
  const preview = turnPreview([{ t: 'text', s: 'a'.repeat(500) }]);
  assert.equal(preview.length, LIMITS.TURN_PREVIEW + 1);
  assert.equal(preview.slice(-1), '…');
  assert.equal(turnPreview([{ t: 'text', s: 'ab cd' }], 4), 'ab c…');
  assert.equal(turnPreview([{ t: 'text', s: 'ab cd' }], 3), 'ab…'); // trailing space trimmed
  assert.equal(turnPreview([{ t: 'text', s: 'ab cd' }], 5), 'ab cd'); // exactly at the cap
});

test('turnPreview: survives blank and malformed spans', () => {
  assert.equal(turnPreview([{ t: 'text', s: '   \n ' }]), '');
  assert.equal(turnPreview([]), '');
  assert.equal(turnPreview(undefined), '');
  assert.equal(turnPreview([null, { t: 'text' }, { t: 'text', s: 'ok' }]), 'ok');
});

test('turnPreview: content behind a long run of blank lines survives', () => {
  // The whitespace collapses to nothing, so a cap measured on raw length would
  // stop scanning before reaching the math and report an empty prompt.
  assert.equal(
    turnPreview([
      { t: 'text', s: ' \n'.repeat(81) },
      { t: 'math', m: 'inline', s: 'x^2' },
    ]),
    '$x^2$',
  );
});

test('turnPreview: truncation never splits a surrogate pair', () => {
  const preview = turnPreview([{ t: 'text', s: `${'a'.repeat(79)}😀 tail` }]);
  assert.equal(preview, `${'a'.repeat(79)}…`);
  assert.ok(!/[\uD800-\uDFFF]/.test(preview));
  // A pair that fits entirely is kept intact.
  assert.equal(turnPreview([{ t: 'text', s: '😀😀😀' }], 4), '😀😀…');
});

test('turnPreview: content past a trailing separator still marks truncation', () => {
  // The cap is crossed by whitespace that trim() removes, so the result fits
  // under it — but the math and the words after it were never read.
  const preview = turnPreview([
    { t: 'text', s: `${'a'.repeat(80)} ` },
    { t: 'math', m: 'inline', s: 'x' },
    { t: 'text', s: ' continues' },
  ]);
  assert.equal(preview, `${'a'.repeat(80)}…`);
  // Trailing blank spans are not content: no ellipsis for them.
  assert.equal(
    turnPreview([{ t: 'text', s: `${'a'.repeat(80)} ` }, { t: 'text', s: '  \n ' }]),
    'a'.repeat(80),
  );
});

test('a new file reports what was written, not the path it already shows', () => {
  const call = parseLine(
    asstLine([{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/w/new.js' } }]),
    OPTS,
  );
  const messages = [...call.messages];
  applyToolResults(
    messages,
    parseLine(
      userLine([{ type: 'tool_result', tool_use_id: 't1', content: 'File created successfully at: /w/new.js' }], {
        // A new file has nothing to diff against, so its patch comes back empty.
        toolUseResult: { type: 'create', filePath: '/w/new.js', structuredPatch: [], content: 'a\nb\nc\n' },
      }),
      OPTS,
    ).results,
  );
  assert.equal(messages[0].result.summary, 'Wrote 3 lines');
});

test('writtenLines: blank or non-string content reports nothing', () => {
  assert.equal(writtenLines(''), undefined);
  assert.equal(writtenLines('  \n\n'), undefined);
  assert.equal(writtenLines(undefined), undefined);
  assert.equal(writtenLines('one line'), 1);
});

// ------------------------------------------------------------------- diffs

const PATCH = [
  {
    oldStart: 124, oldLines: 4, newStart: 124, newLines: 6,
    lines: ['     labelpad=6)', ' ', '-def build(a, b):', '+def build(a, b, c):', '+    # added', '     rows = 1'],
  },
  { oldStart: 200, oldLines: 2, newStart: 202, newLines: 1, lines: ['-    old_call()', ' ok'] },
];

test('diffLines: numbers removals from the old file, the rest from the new', () => {
  const d = diffLines(PATCH);
  assert.equal(d.more, 0);
  assert.deepEqual(
    d.lines.map((l) => (l.gap ? '---' : `${l.n}${l.k}${l.s.trim()}`)),
    [
      '124 labelpad=6)',
      '125 ',
      '126-def build(a, b):',
      '126+def build(a, b, c):',
      '127+# added',
      '128 rows = 1',
      '---',
      '200-old_call()',
      '202 ok',
    ],
  );
});

test('diffLines: hunks are separated, and a gap never leads or trails', () => {
  const d = diffLines(PATCH);
  assert.equal(d.lines[0].gap, undefined);
  assert.equal(d.lines[d.lines.length - 1].gap, undefined);
  assert.equal(d.lines.filter((l) => l.gap).length, 1);
});

test('diffLines: the budget counts visible lines and reports the remainder', () => {
  const d = diffLines(PATCH, 3);
  assert.equal(d.lines.filter((l) => !l.gap).length, 3);
  assert.equal(d.more, 5); // 8 diff lines total
  assert.equal(d.lines[d.lines.length - 1].gap, undefined); // no dangling gap
});

test('diffLines: a budget landing exactly on the end reports nothing more', () => {
  const d = diffLines(PATCH, 8);
  assert.equal(d.more, 0);
  assert.equal(d.lines.filter((l) => !l.gap).length, 8);
});

test('diffLines: an over-wide line is cut, and empty patches yield nothing', () => {
  const wide = diffLines([{ oldStart: 1, newStart: 1, lines: [`+${'x'.repeat(5000)}`] }]);
  assert.equal(wide.lines[0].s.length, LIMITS.TOOL_DIFF_COLS + 1); // + the ellipsis
  assert.equal(wide.lines[0].s.endsWith('…'), true);
  assert.equal(diffLines([]), undefined);
  assert.equal(diffLines(undefined), undefined);
  assert.equal(diffLines([{ oldStart: 1, newStart: 1, lines: [] }]), undefined);
});

test('diffLines: a hunk missing its start numbers still renders', () => {
  const d = diffLines([{ lines: ['+one'] }]);
  assert.equal(d.lines[0].n, 0); // fail soft: no number rather than no diff
  assert.equal(d.lines[0].s, 'one');
});

test('an edit carries its diff alongside the counts', () => {
  const call = parseLine(
    asstLine([{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/w/a.py' } }]),
    OPTS,
  );
  const messages = [...call.messages];
  applyToolResults(
    messages,
    parseLine(
      userLine([{ type: 'tool_result', tool_use_id: 't1', content: 'updated' }], {
        toolUseResult: { filePath: '/w/a.py', structuredPatch: PATCH },
      }),
      OPTS,
    ).results,
  );
  assert.equal(messages[0].result.summary, 'Added 2 lines, removed 2 lines');
  assert.equal(messages[0].result.diff.lines.length, 9); // 8 lines + 1 gap
});

test('a new file has no diff to carry', () => {
  const call = parseLine(
    asstLine([{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/w/n.js' } }]),
    OPTS,
  );
  const messages = [...call.messages];
  applyToolResults(
    messages,
    parseLine(
      userLine([{ type: 'tool_result', tool_use_id: 't1', content: 'created' }], {
        toolUseResult: { type: 'create', filePath: '/w/n.js', structuredPatch: [], content: 'a\nb' },
      }),
      OPTS,
    ).results,
  );
  assert.equal(messages[0].result.summary, 'Wrote 2 lines');
  assert.equal(messages[0].result.diff, undefined);
});
