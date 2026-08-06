// Run: node --test test/chat-example.test.js
// Input: the checked-in chat examples and temporary session-store directories.
// Output: assertions for fixture selectors, UUID isolation, and native staging.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  commandFor,
  fixtures,
  parseArgs,
  selectFixture,
  sessionMetadata,
  stageFixture,
} = require('../scripts/chat-example.js');

test('chat examples expose stable provider-number selectors', () => {
  const items = fixtures();
  assert.deepEqual(
    items.map((item) => item.key),
    ['claude1', 'claude2', 'claude3', 'codex1', 'codex2'],
  );
  assert.equal(selectFixture(items, 'tables').key, 'claude2');
  assert.equal(selectFixture(items, 'codex1').description, 'disc-sfs-branch');
});

test('an unqualified selector defaults to disposable resume', () => {
  assert.equal(parseArgs(['claude2']).mode, 'resume');
  assert.equal(parseArgs(['fork', 'claude2']).mode, 'fork');
});

test('Claude fixture stages under the current project with a fresh UUID', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aichatrender-chat-example-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const item = selectFixture(fixtures(), 'claude2');
  const original = fs.readFileSync(item.file, 'utf8');
  const originalId = sessionMetadata(original, 'claude').id;
  const staged = stageFixture(item, '/workspace/Live,AIChatRender', false, {
    claudeRoot: temp,
  });
  const copied = fs.readFileSync(staged.destination, 'utf8');

  assert.notEqual(staged.id, originalId);
  assert.equal(copied.includes(originalId), false);
  assert.equal(sessionMetadata(copied, 'claude').id, staged.id);
  assert.match(staged.destination, /projects\/-workspace-Live-AIChatRender\//);
});

test('Codex fixture stages today with normalized cwd and a fresh UUID', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aichatrender-chat-example-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const item = selectFixture(fixtures(), 'codex1');
  const original = fs.readFileSync(item.file, 'utf8');
  const originalId = sessionMetadata(original, 'codex').id;
  const staged = stageFixture(item, '/workspace/Live,AIChatRender', false, {
    codexHome: temp,
  });
  const copied = fs.readFileSync(staged.destination, 'utf8');
  const first = JSON.parse(copied.slice(0, copied.indexOf('\n')));

  assert.notEqual(staged.id, originalId);
  assert.equal(copied.includes(originalId), false);
  assert.equal(first.payload.id, staged.id);
  assert.equal(first.payload.cwd, '/workspace/Live,AIChatRender');
  assert.match(staged.destination, /sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-/);
});

test('commands map fork and resume to each provider CLI', () => {
  const items = fixtures();
  const claude = selectFixture(items, 'claude1');
  const codex = selectFixture(items, 'codex1');
  assert.deepEqual(commandFor(claude, 'fork', 'id', '/repo', []), {
    bin: 'claude',
    args: ['--resume', 'id', '--fork-session'],
  });
  assert.deepEqual(commandFor(codex, 'resume', 'id', '/repo', ['-m', 'model']), {
    bin: 'codex',
    args: ['resume', '-C', '/repo', 'id', '-m', 'model'],
  });
});
