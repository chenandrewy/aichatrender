'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CODEX_TOOL_LIMITS,
  decodeCodexOutput,
  extractExecDescriptors,
  unifiedDiffToStructuredPatch,
} = require('../codex-tools');
const { diffLines, patchCounts } = require('../tool-presentation');

test('static extraction accepts literals, templates, arrays, objects, and const bindings', () => {
  const source = [
    "const command = `npm test`;",
    "const patch = '*** Begin Patch\\n*** End Patch';",
    "tools.exec_command({cmd: command, flags: ['a', 2, true, null]});",
    'tools.apply_patch(patch);',
  ].join('\n');
  const parsed = extractExecDescriptors(source);
  assert.equal(parsed.unexpected, false);
  assert.deepEqual(
    parsed.descriptors.map((descriptor) => ({
      rawName: descriptor.rawName,
      input: descriptor.input,
      eventBacked: descriptor.eventBacked,
    })),
    [
      {
        rawName: 'exec_command',
        input: { cmd: 'npm test', flags: ['a', 2, true, null] },
        eventBacked: false,
      },
      {
        rawName: 'apply_patch',
        input: { patch: '*** Begin Patch\n*** End Patch' },
        eventBacked: true,
      },
    ],
  );
});

test('static extraction preserves lexical order through Promise.all', () => {
  const parsed = extractExecDescriptors(
    'await Promise.all([tools.wait({cell_id: "a"}), tools.exec_command({cmd: "b"})]);',
  );
  assert.deepEqual(parsed.descriptors.map((descriptor) => descriptor.rawName), [
    'wait', 'exec_command',
  ]);
});

test('static extraction rejects executable and prototype-sensitive arguments without running them', () => {
  delete globalThis.__aichatrenderSentinel;
  const source = [
    'globalThis.__aichatrenderSentinel = true;',
    'const dynamic = makeArguments();',
    'tools.exec_command(dynamic);',
    'tools.future({["computed"]: 1});',
    'tools.future({__proto__: {polluted: true}});',
    'const mutable = {cmd: "before"}; mutable.cmd = "after"; tools.exec_command(mutable);',
  ].join('\n');
  const parsed = extractExecDescriptors(source);
  assert.equal(globalThis.__aichatrenderSentinel, undefined);
  assert.equal(parsed.unexpected, true);
  assert.equal(parsed.descriptors.length, 4);
  assert.deepEqual(parsed.descriptors.map((descriptor) => descriptor.input), [{}, {}, {}, {}]);
  assert.equal({}.polluted, undefined);
});

test('static extraction fails soft on malformed, oversized, and excessive source', () => {
  assert.equal(extractExecDescriptors('tools.exec_command({').unexpected, true);
  assert.equal(
    extractExecDescriptors('x'.repeat(CODEX_TOOL_LIMITS.MAX_EXEC_SOURCE + 1)).truncated,
    true,
  );
  const many = Array.from(
    { length: CODEX_TOOL_LIMITS.MAX_CALLS_PER_EXEC + 2 },
    (_, index) => `tools.wait({cell_id: "${index}"});`,
  ).join('');
  const parsed = extractExecDescriptors(many);
  assert.equal(parsed.descriptors.length, CODEX_TOOL_LIMITS.MAX_CALLS_PER_EXEC);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.unexpected, true);
});

test('output decoding strips wrapper metadata and never retains image bytes', () => {
  const decoded = decodeCodexOutput(
    [
      { type: 'input_text', text: 'Script completed\nWall time: 1 second\nOutput:\n' },
      { type: 'input_text', text: 'visible' },
      { type: 'input_image', image_url: 'data:image/png;base64,SECRET' },
      { type: 'future_block', payload: 'opaque' },
    ],
    { wrapper: true },
  );
  assert.equal(decoded.text, 'visible\n[image]\n[future_block]');
  assert.equal(decoded.unexpected, true);
  assert.doesNotMatch(decoded.text, /SECRET|data:image/);
  assert.equal(
    decodeCodexOutput('before data:image/png;base64,PRIVATE after').text,
    'before [image] after',
  );
});

test('unified diff conversion supports multiple hunks and numbered rendering', () => {
  const patch = unifiedDiffToStructuredPatch([
    '--- a/file.js',
    '+++ b/file.js',
    '@@ -2,3 +2,3 @@',
    ' context',
    '-old',
    '+new',
    '@@ -10 +10,2 @@',
    '-gone',
    '+one',
    '+two',
    '\\ No newline at end of file',
  ].join('\n'));
  assert.deepEqual(patchCounts(patch), { added: 3, removed: 2 });
  assert.deepEqual(diffLines(patch).lines, [
    { k: ' ', n: 2, s: 'context' },
    { k: '-', n: 3, s: 'old' },
    { k: '+', n: 3, s: 'new' },
    { gap: true },
    { k: '-', n: 10, s: 'gone' },
    { k: '+', n: 10, s: 'one' },
    { k: '+', n: 11, s: 'two' },
  ]);
  assert.equal(unifiedDiffToStructuredPatch('not a unified diff'), undefined);
});
