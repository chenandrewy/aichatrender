'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  detectProvider,
  firstWords,
  parseTranscript,
  renderMarkdown,
  spansToMarkdown,
} = require('../export');

const fixture = (name) =>
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8');

test('provider detection recognizes Claude and Codex fixtures', () => {
  assert.equal(detectProvider(fixture('session.jsonl').trimEnd().split('\n')), 'claude');
  assert.equal(
    detectProvider(fixture('rollout.jsonl').trimEnd().split('\n'), '/tmp/renamed.jsonl'),
    'codex',
  );
});

test('Claude export reuses display filtering and restores math Markdown', () => {
  const parsed = parseTranscript(fixture('session.jsonl'), {
    provider: 'auto',
    inputPath: '/private/session.jsonl',
  });
  assert.equal(parsed.provider, 'claude');
  assert.equal(parsed.turns, 1);
  assert.deepEqual(
    parsed.messages.map((message) => message.role),
    ['user', 'assistant', 'assistant', 'assistant'],
  );
  const markdown = renderMarkdown(parsed, { inputPath: '/private/session.jsonl' });
  assert.match(markdown, /^# U01 - derive the relativistic energy relation$/m);
  assert.match(markdown, /^# A01$/m);
  assert.match(markdown, /\$p_1=p_2\$/);
  assert.match(markdown, /\$\$\nE\^2=\(mc\^2\)\^2\+\(pc\)\^2\n\$\$/);
  assert.doesNotMatch(markdown, /secret/);
});

test('Codex export removes duplicate records and retains session metadata', () => {
  const parsed = parseTranscript(fixture('rollout.jsonl'), {
    provider: 'auto',
    inputPath: '/private/rollout.jsonl',
  });
  assert.equal(parsed.provider, 'codex');
  assert.equal(parsed.turns, 1);
  assert.equal(parsed.cwd, '/workspace/example');
  assert.deepEqual(
    parsed.messages.map((message) => message.role),
    ['user', 'assistant'],
  );
  const markdown = renderMarkdown(parsed);
  assert.match(markdown, /Commutativity gives/);
  assert.equal((markdown.match(/Commutativity gives/g) || []).length, 1);
});

test('span export handles inline, display, malformed, and plain spans', () => {
  assert.equal(
    spansToMarkdown([
      { t: 'text', s: 'a ' },
      { t: 'math', m: 'inline', s: 'x' },
      { t: 'text', s: ' then' },
      { t: 'math', m: 'display', s: 'y=z' },
      null,
    ]),
    'a $x$ then\n\n$$\ny=z\n$$',
  );
});

test('turn labels use five words, preserve math, and leave chat headings nested', () => {
  assert.equal(
    firstWords([
      { t: 'text', s: '  Show why\n' },
      { t: 'math', m: 'inline', s: 'x+y=y+x' },
      { t: 'text', s: ' before explaining the details' },
    ]),
    'Show why $x+y=y+x$ before explaining',
  );
  const markdown = renderMarkdown({
    provider: 'codex',
    sessionId: 'example',
    turns: 1,
    unexpectedRecords: 0,
    oversizedLines: 0,
    messages: [
      { role: 'user', ts: '', spans: [{ t: 'text', s: 'one two three four five six' }] },
      { role: 'assistant', ts: '', spans: [{ t: 'text', s: '## Existing chat heading' }] },
    ],
  });
  assert.match(markdown, /^# U01 - one two three four five$/m);
  assert.match(markdown, /^# A01$/m);
  assert.match(markdown, /^## Existing chat heading$/m);
});
