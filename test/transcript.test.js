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
  parseLine,
} = require('../transcript');

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

test('assistant: keeps text blocks, skips thinking and tool_use', () => {
  const r = parseLine(
    asstLine([
      { type: 'thinking', thinking: 'secret \\(a+b\\)' },
      { type: 'text', text: 'Result: \\(E=mc^2\\)' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
    ]),
    OPTS,
  );
  assert.equal(r.unexpected, false);
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].role, 'assistant');
  assert.deepEqual(r.messages[0].spans, [
    { t: 'text', s: 'Result: ' },
    { t: 'math', m: 'inline', s: 'E=mc^2' },
  ]);
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
  const raw = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'session.jsonl'));
  const lb = new LineBuffer();
  const messages = [];
  let unexpected = false;
  for (const line of lb.push(raw)) {
    const r = parseLine(line, OPTS);
    if (r.unexpected) unexpected = true;
    messages.push(...r.messages);
  }
  assert.equal(unexpected, false);
  assert.deepEqual(
    messages.map((m) => m.role),
    ['user', 'assistant', 'assistant', 'assistant'],
  );
  assert.deepEqual(messages[1].spans, [
    { t: 'text', s: 'By conservation, ' },
    { t: 'math', m: 'inline', s: 'p_1=p_2' },
    { t: 'text', s: '. Then:\n' },
    { t: 'math', m: 'display', s: 'E^2=(mc^2)^2+(pc)^2' },
  ]);
  assert.equal(messages[2].spans.length, 1);
  assert.equal(messages[2].spans[0].t, 'text');
  assert.deepEqual(messages[3].spans, [
    { t: 'text', s: 'Thus ' },
    { t: 'math', m: 'inline', s: 'p_1=p_2' },
    { t: 'text', s: ' costs $5 to check.' },
  ]);
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
